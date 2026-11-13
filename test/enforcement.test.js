/**
 * Behavioural tests for the two wrapping helpers.
 *
 * Both modules are dependency-free by design: they wrap whatever enforcement
 * service the composition mounted, so a plain stand-in is enough to check the
 * exact widening rule and the exact restore behaviour.
 *
 * Run with `node test/enforcement.test.js`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyExtraDirsFence } from '../src/fs.js';
import { withDeviceBinds, withExtraBinds } from '../src/plan.js';
import { applyExtraDirsConfine } from '../src/provider.js';
/**
 * A stand-in filesystem whose stock check throws `thrown`.
 *
 * @param {unknown} thrown
 * @returns {import('../src/fs.js').FenceService}
 */
const fakeFs = (thrown) => ({
    async checkedTarget(_target, _policy) { throw thrown; },
    async resolve(path) { return { displayPath: path, targetKey: path }; },
});
/**
 * A stand-in provider returning a bwrap profile.
 *
 * @param {string[]} argv
 * @returns {import('../src/provider.js').ConfineService}
 */
const fakeSandbox = (argv) => ({
    async confine(_argv, _policy, _signal) {
        return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] };
    },
});
/**
 * Real directories to grant. The confine wrapper only binds a source it can
 * still stat, so a made-up path would be dropped and the profile would look
 * untouched — the opposite of what these cases check.
 *
 * @param {number} count
 * @returns {Promise<{ dirs: string[], cleanup: () => Promise<void> }>}
 */
const makeExtraDirs = async (count) => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-extra-binds-'));
    const dirs = [];
    for (let index = 0; index < count; index += 1) {
        const dir = join(parent, `extra-${index}`);
        await mkdir(dir);
        dirs.push(dir);
    }
    return { dirs, cleanup: () => rm(parent, { recursive: true, force: true }) };
};
test('withExtraBinds inserts the binds with the profile, before --', () => {
    const argv = ['bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work', '--', 'bash', '-c', 'echo -- hi'];
    assert.deepEqual(withExtraBinds(argv, ['/extra/a', '/extra/b']), [
        'bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work',
        '--bind', '/extra/a', '/extra/a', '--bind', '/extra/b', '/extra/b',
        '--', 'bash', '-c', 'echo -- hi',
    ]);
    // No separator: append at the end rather than corrupting the command.
    assert.deepEqual(withExtraBinds(['bwrap', '--ro-bind', '/', '/'], ['/x']), [
        'bwrap', '--ro-bind', '/', '/', '--bind', '/x', '/x',
    ]);
    // The input is never mutated.
    const original = ['bwrap', '--', 'bash'];
    withExtraBinds(original, ['/x']);
    assert.deepEqual(original, ['bwrap', '--', 'bash']);
});
test('the fence wrapper widens a containment denial in any confined mode', async () => {
    const denial = () => Object.assign(new Error('denied'), { code: 'FS_SANDBOX_DENIED' });
    // The target below resolves to `/outside/file.txt`, so this root contains it.
    const extra = ['/outside'];
    const rootsFor = () => extra;
    // Denied, but the extra directories contain the target: allowed, and the
    // FRESH resolution is returned so the identity checked is the one written.
    const fs = fakeFs(denial());
    const restore = applyExtraDirsFence(fs, rootsFor);
    assert.deepEqual(await fs.checkedTarget({ displayPath: '/outside/file.txt' }, { mode: 'workspace-write' }), { displayPath: '/outside/file.txt', targetKey: '/outside/file.txt' });
    // `read-only` is widened too: the stock fence refuses before it resolves the
    // target, so this is what makes a read-only preset able to grant directories.
    assert.deepEqual(await fs.checkedTarget({ displayPath: '/outside/file.txt' }, { mode: 'read-only' }), { displayPath: '/outside/file.txt', targetKey: '/outside/file.txt' });
    // No extra directories apply: the stock denial stands in either mode.
    const noRoots = fakeFs(denial());
    applyExtraDirsFence(noRoots, () => []);
    await assert.rejects(noRoots.checkedTarget({ displayPath: '/outside/file.txt' }, { mode: 'workspace-write' }), { code: 'FS_SANDBOX_DENIED' });
    await assert.rejects(noRoots.checkedTarget({ displayPath: '/outside/file.txt' }, { mode: 'read-only' }), { code: 'FS_SANDBOX_DENIED' });
    // A target outside every extra root is still denied.
    const outside = { ...fakeFs(denial()), async resolve(/** @type {string} */ path) { return { displayPath: path, targetKey: '/other' }; } };
    applyExtraDirsFence(outside, rootsFor);
    await assert.rejects(outside.checkedTarget({ displayPath: '/other/file.txt' }, { mode: 'workspace-write' }), { code: 'FS_SANDBOX_DENIED' });
    // Unrelated errors pass through untouched.
    const unrelated = new Error('boom');
    const brokenFs = fakeFs(unrelated);
    applyExtraDirsFence(brokenFs, rootsFor);
    await assert.rejects(brokenFs.checkedTarget({ displayPath: '/x' }), (/** @type {unknown} */ error) => error === unrelated);
    // The original check stays authoritative for stock-allowed targets.
    const allowedFs = { async checkedTarget(/** @type {unknown} */ _target, /** @type {unknown} */ _policy) { return 'stock-ok'; } };
    applyExtraDirsFence(allowedFs, rootsFor);
    assert.equal(await allowedFs.checkedTarget({ displayPath: '/work/f' }, undefined), 'stock-ok');
    // Restoring returns the instance to exactly its previous shape, whether the
    // method was inherited or an own property.
    const inherited = Object.create({ async checkedTarget() { throw denial(); } });
    const inheritedBefore = Object.getOwnPropertyDescriptor(inherited, 'checkedTarget');
    applyExtraDirsFence(inherited, rootsFor)?.();
    assert.deepEqual(Object.getOwnPropertyDescriptor(inherited, 'checkedTarget'), inheritedBefore);
    const own = fakeFs(denial());
    const ownBefore = own.checkedTarget;
    const undo = applyExtraDirsFence(own, rootsFor);
    assert.notEqual(own.checkedTarget, ownBefore);
    undo?.();
    assert.equal(own.checkedTarget, ownBefore);
    // A wrapped instance is never wrapped twice, and an instance without the
    // expected seam is left untouched and reported as unwrapped (`undefined`),
    // so the caller can warn instead of degrading in silence.
    const twice = fakeFs(denial());
    const first = applyExtraDirsFence(twice, rootsFor);
    const wrappedOnce = twice.checkedTarget;
    assert.equal(typeof applyExtraDirsFence(twice, rootsFor), 'function');
    assert.equal(twice.checkedTarget, wrappedOnce);
    first?.();
    assert.equal(applyExtraDirsFence({}, rootsFor), undefined);
    assert.equal(applyExtraDirsFence(undefined, rootsFor), undefined);
    assert.equal(applyExtraDirsFence({ checkedTarget: 'not-a-function' }, rootsFor), undefined);
    restore?.();
});
test('the confine wrapper binds the reported directories and reports other backends', async () => {
    const argv = ['bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work', '--', 'bash', '-c', 'true'];
    const { dirs: [extra], cleanup } = await makeExtraDirs(1);
    /** @type {string[]} */
    const unsupported = [];
    const sandbox = fakeSandbox(argv);
    const restore = applyExtraDirsConfine(sandbox, {
        extraRootsFor: (/** @type {unknown} */ policy) => (/** @type {{ extra?: string[] }} */ (policy)?.extra ?? []),
        reportUnsupported: (runner) => unsupported.push(runner),
    });
    // The extra directories join the profile, before the command separator.
    const widened = await sandbox.confine(['bash', '-c', 'true'], { mode: 'workspace-write', extra: [extra] });
    assert.deepEqual(widened.argv, [
        'bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work',
        '--bind', extra, extra, '--', 'bash', '-c', 'true',
    ]);
    assert.deepEqual(unsupported, []);
    // A read-only preset binds its directories the same way; the mode is not the
    // plugin's business, the reported directories are.
    assert.deepEqual((await sandbox.confine([], { mode: 'read-only', extra: [extra] })).argv, ['bwrap', '--ro-bind', '/', '/', '--bind', '/work', '/work', '--bind', extra, extra, '--', 'bash', '-c', 'true']);
    // No extra directories: the stock argv is returned untouched, in any mode.
    assert.deepEqual((await sandbox.confine([], { mode: 'workspace-write' })).argv, argv);
    assert.deepEqual((await sandbox.confine([], { mode: 'read-only' })).argv, argv);
    // A directory that no longer exists is left out. bwrap refuses the whole
    // command on a missing bind source, so binding it blind would cost the
    // session every confined command instead of one refused write.
    await rm(extra, { recursive: true, force: true });
    assert.deepEqual((await sandbox.confine([], { mode: 'workspace-write', extra: [extra] })).argv, argv);
    await cleanup();
    // A non-bwrap rung warns once instead of pretending to widen.
    const other = fakeSandbox(['landlock', '--', 'bash']);
    let reportCount = 0;
    applyExtraDirsConfine(other, {
        extraRootsFor: () => ['/extra/a'],
        reportUnsupported: () => { reportCount += 1; },
    });
    assert.deepEqual((await other.confine([], { mode: 'workspace-write' })).argv, ['landlock', '--', 'bash']);
    await other.confine([], { mode: 'workspace-write' });
    assert.equal(reportCount, 2, 'the wrapper reports per call; the service dedupes');
    // Restoring returns the instance to exactly its previous shape.
    const plain = fakeSandbox(argv);
    const before = plain.confine;
    const undo = applyExtraDirsConfine(plain, { extraRootsFor: () => ['/x'], reportUnsupported: () => { } });
    undo?.();
    assert.equal(plain.confine, before);
    // An instance without the expected seam is reported as unwrapped instead of
    // being passed over in silence.
    const deps = { extraRootsFor: () => ['/x'], reportUnsupported: () => { } };
    assert.equal(applyExtraDirsConfine({}, deps), undefined);
    assert.equal(applyExtraDirsConfine(undefined, deps), undefined);
    assert.equal(applyExtraDirsConfine({ confine: 'not-a-function' }, deps), undefined);
    restore?.();
});
test('withDeviceBinds mounts device paths with --dev-bind, before --', () => {
    const argv = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--', 'bash', '-c', 'true'];
    assert.deepEqual(withDeviceBinds(argv, ['/dev/dri']), [
        'bwrap', '--ro-bind', '/', '/', '--dev', '/dev',
        '--dev-bind', '/dev/dri', '/dev/dri',
        '--', 'bash', '-c', 'true',
    ]);
    // No separator: appended at the end rather than corrupting the command.
    assert.deepEqual(withDeviceBinds(['bwrap', '--dev', '/dev'], ['/dev/kvm']), [
        'bwrap', '--dev', '/dev', '--dev-bind', '/dev/kvm', '/dev/kvm',
    ]);
    // The input is never mutated, so the stock argv stays reusable.
    const original = ['bwrap', '--', 'bash'];
    withDeviceBinds(original, ['/dev/dri']);
    assert.deepEqual(original, ['bwrap', '--', 'bash']);
});
test('the confine wrapper dev-binds the reported device paths after the directory binds', async () => {
    const argv = ['bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--', 'bash', '-c', 'true'];
    const { dirs: [extra], cleanup } = await makeExtraDirs(1);
    // A device path is any existing path: a regular file stands in for a node,
    // which is what makes this test runnable on a machine with no GPU.
    const node = join(extra, 'fake-node');
    await writeFile(node, '');
    const sandbox = fakeSandbox(argv);
    const restore = applyExtraDirsConfine(sandbox, {
        extraRootsFor: (/** @type {unknown} */ policy) => (/** @type {{ extra?: string[] }} */ (policy)?.extra ?? []),
        extraDevicesFor: (/** @type {unknown} */ policy) => (/** @type {{ devices?: string[] }} */ (policy)?.devices ?? []),
        reportUnsupported: () => { },
    });
    // Both lists widen the same profile in one call, directories first so a
    // device nested under one keeps the device semantics of the later mount.
    const widened = await sandbox.confine([], { mode: 'workspace-write', extra: [extra], devices: [node] });
    assert.deepEqual(widened.argv, [
        'bwrap', '--ro-bind', '/', '/', '--dev', '/dev',
        '--bind', extra, extra, '--dev-bind', node, node,
        '--', 'bash', '-c', 'true',
    ]);
    // Devices alone still widen a profile that grants no directory.
    assert.deepEqual((await sandbox.confine([], { mode: 'read-only', devices: [node] })).argv, [
        'bwrap', '--ro-bind', '/', '/', '--dev', '/dev',
        '--dev-bind', node, node, '--', 'bash', '-c', 'true',
    ]);
    // A device that vanished before the command was built is dropped: bwrap
    // fails the whole command on a missing dev-bind source.
    await rm(node);
    assert.deepEqual((await sandbox.confine([], { mode: 'read-only', devices: [node] })).argv, argv);
    // A caller that reports no devices keeps the directory-only behaviour.
    const dirsOnly = fakeSandbox(argv);
    applyExtraDirsConfine(dirsOnly, {
        extraRootsFor: () => [extra],
        reportUnsupported: () => { },
    });
    assert.deepEqual((await dirsOnly.confine([], { mode: 'workspace-write' })).argv, [
        'bwrap', '--ro-bind', '/', '/', '--dev', '/dev',
        '--bind', extra, extra, '--', 'bash', '-c', 'true',
    ]);
    await cleanup();
    restore?.();
});
