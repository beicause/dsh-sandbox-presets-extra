/**
 * Contract tests for the stock seams this plugin extends.
 *
 * The plugin does not depend on a dsh version range; it depends on the exact
 * shape of two mounted services. These tests pin that shape against the REAL
 * classes, so a harness upgrade that moves a method, changes its arity, renames
 * a policy field, or turns a return value into something else fails here
 * instead of degrading the preset in production.
 *
 * Every case skips when the DSH packages are not resolvable, which is the case
 * outside an installed profile; run it from a profile to exercise the real
 * classes.
 *
 * Run with `node --test test/contract.test.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyExtraDirsConfine } from '../src/provider.js';
import { applyExtraDirsFence } from '../src/fs.js';
import { optionalImport } from './support/host.js';
import { Context } from '@deepseek-ai/cordis';
import { asFsSeam, asPermissionSeam } from './support/views.js';
/**
 * Import a DSH package, resolving it from the pnpm store that installed the
 * running `dsh` when a bare specifier does not resolve. A linked plugin does
 * not have the DSH packages in its own resolution chain, so the bare import
 * alone skips every contract case — which is exactly the wrong outcome for
 * tests whose purpose is to pin the stock interfaces.
 */
/** @type {typeof optionalImport} */
const dsh = optionalImport;
const [fsSandbox, sandboxLocal, permissionPresets] = (await Promise.all([
    dsh('@deepseek-ai/dsh-fs-sandbox'),
    dsh('@deepseek-ai/dsh-sandbox-local'),
    dsh('@deepseek-ai/dsh-permission-presets'),
]));

/** The seam `src/fs.js` wraps, and the policy fields `src/service.js` reads. */
test('the stock filesystem still offers the seam the fence wrapper needs', {
    skip: fsSandbox === undefined ? 'the DSH filesystem package is not resolvable here' : false,
}, async () => {
    if (fsSandbox === undefined)
        return;
    const proto = asFsSeam(fsSandbox.SandboxedFileSystem.prototype);
    // `applyExtraDirsFence` calls these two, and requires the first to reject
    // containment with this exact code before it retries against extra roots.
    assert.equal(typeof proto.checkedTarget, 'function', 'checkedTarget is the seam the fence wraps');
    assert.equal(typeof proto.resolve, 'function', 'the wrapper re-resolves through this');
    const ctx = new Context();
    /** @type {import('@deepseek-ai/cordis').Context & { sandboxPolicy: { defaultMode: import('@deepseek-ai/dsh-sandbox').SandboxMode } }} */ (ctx).sandboxPolicy = { defaultMode: 'workspace-write' };
    const instance = new fsSandbox.SandboxedFileSystem(ctx, fsSandbox.SandboxedFileSystem.Config({ cwd: process.cwd() }));
    // Inherited, not own: the wrapper records the descriptor so restore is exact.
    assert.equal(Object.hasOwn(instance, 'checkedTarget'), false, 'the seam is inherited, as the wrapper assumes');
    // The wrapper must recognize this instance, i.e. it must be wrappable.
    const dispose = applyExtraDirsFence(instance, () => []);
    assert.equal(typeof dispose, 'function', 'the real filesystem instance is recognized and wrapped');
    dispose?.();
    assert.equal(asFsSeam(instance).checkedTarget, proto.checkedTarget, 'restoring returns the inherited method');
    // A denial carries the code the wrapper keys on. Proven through the real
    // fence rather than a stand-in, so a code rename fails here.
    const outside = await instance.resolve('/');
    await assert.rejects(instance.writeText(outside, 'x', undefined, undefined, { mode: 'read-only', workspaceRoot: process.cwd() }), (/** @type {{ code?: unknown }} */ error) => {
        assert.equal(error.code, 'FS_SANDBOX_DENIED', 'the fence denial code the wrapper matches on');
        return true;
    });
});
/** The seam `src/provider.js` wraps, and the result fields it reads. */
test('the stock sandbox provider still offers the seam the confine wrapper needs', {
    skip: sandboxLocal === undefined ? 'the DSH sandbox package is not resolvable here' : false,
}, async () => {
    if (sandboxLocal === undefined)
        return;
    const proto = sandboxLocal.LocalSandboxProvider.prototype;
    const base = Object.getPrototypeOf(sandboxLocal.LocalSandboxProvider);
    assert.equal(typeof proto.confine, 'function', 'confine is the seam the provider wrapper wraps');
    // The wrapper awaits the stock call, which is why a sync-to-async change is
    // safe for it, but the result must still be an object carrying `argv`.
    assert.equal(proto.confine.constructor.name, 'AsyncFunction', 'the wrapper awaits this call');
    const instance = new sandboxLocal.LocalSandboxProvider(new Context(), 
    // Validate through the real schema so required defaults are present.
    sandboxLocal.LocalSandboxProvider.Config({
        runnerCommand: [],
        runnerFailureSignatures: [],
        probeTimeoutMs: 5_000,
    }));
    assert.equal(Object.hasOwn(instance, 'confine'), false, 'the seam is inherited, as the wrapper assumes');
    const deps = { extraRootsFor: () => [], reportUnsupported: () => { } };
    const dispose = applyExtraDirsConfine(instance, deps);
    assert.equal(typeof dispose, 'function', 'the real provider instance is recognized and wrapped');
    dispose?.();
    assert.equal(instance.confine, proto.confine, 'restoring returns the inherited method');
    // On Linux the real provider selects the bwrap rung, and `confine` resolves
    // to an object whose `argv` the wrapper edits. Every field it touches is
    // pinned here, so a return-shape change fails this contract.
    //
    // This plugin extends bwrap only: on any other rung it reports the backend as
    // unsupported rather than widening it. A host without bwrap therefore does
    // not narrow this assertion, it fails the contract — a silent Landlock
    // fallback would leave every configured preset granting nothing.
    if (process.platform === 'linux') {
        const result = await instance.confine(['true'], { mode: 'workspace-write', workspaceRoot: process.cwd() });
        assert.ok(Array.isArray(result.argv), 'the wrapper inserts into result.argv');
        assert.equal(result.argv[0], 'bwrap', 'the wrapper only extends the bwrap profile');
        assert.equal(typeof result.enforcement, 'string', 'the result shape the wrapper spreads unchanged');
        assert.notEqual(result.argv.indexOf('--'), -1, 'the separator the wrapper inserts before');
    }
    // The base class is where the service name comes from, which is why a
    // subclass cannot coexist with the stock row.
    assert.equal(base.name, 'SandboxProvider', 'the base registers the fixed "sandbox" service name');
});
/** The accessor src/service.js reads a session's selection through. */
test('the stock permission service still reads a selection through permissionState', {
    skip: permissionPresets === undefined ? 'the DSH permission package is not resolvable here' : false,
}, async () => {
    if (permissionPresets === undefined)
        return;
    const proto = asPermissionSeam(permissionPresets.PermissionPresetService.prototype);
    // The session projection accessor the plugin used to call per key is
    // deprecated, so the selection is read from the service that owns it.
    // current() is no substitute: it derives an effective name rather than
    // returning the recorded one, so a session that selected nothing would
    // still appear to have selected whatever bundle matches the defaults.
    assert.equal(typeof proto.permissionState, 'function', 'permissionState is the accessor the plugin reads');
    assert.equal(typeof proto.current, 'function', 'the owner keeps its derived accessor beside it');
    // The accessor answers only once activation has registered the projection,
    // and the plugin turns that refusal into 'nothing selected' instead of
    // letting it escape from the enforcement path.
    const ctx = new Context();
    Object.assign(ctx, {
        shell: { sandboxMode: 'workspace-write' },
        approval: { config: { policy: 'ask' } },
    });
    const instance = asPermissionSeam(new permissionPresets.PermissionPresetService(ctx, permissionPresets.PermissionPresetService.Config({})));
    assert.throws(() => instance.permissionState({ id: 'session-under-test' }), /not ready/, 'an inactive service refuses to answer');
});
