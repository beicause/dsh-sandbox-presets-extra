/**
 * Unit tests for the pure path logic behind the extra writable directories.
 *
 * Run with `node test/roots.test.js` from the package directory. Uses only
 * Node built-ins so it can run without the DSH dependency tree.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { absoluteEntry, canonicalRootOf, existingDirectories, expandExtraDirs, isPathUnder, workspaceEntryPath } from '../src/roots.js';
const withTempTree = async (/** @type {(base: string) => Promise<unknown>} */ run) => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-extra-dirs-'));
    try {
        return await run(base);
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
};
test('absoluteEntry expands ~ and requires an absolute path', () => {
    assert.equal(absoluteEntry('/a/b'), '/a/b');
    assert.equal(absoluteEntry('  /a/b  '), '/a/b');
    assert.equal(absoluteEntry(''), undefined);
    assert.equal(absoluteEntry('   '), undefined);
    assert.equal(absoluteEntry('relative/dir'), undefined);
    assert.equal(absoluteEntry(undefined), undefined);
    assert.equal(absoluteEntry(42), undefined);
    const expanded = absoluteEntry('~/x');
    assert.ok(expanded !== undefined);
    assert.match(expanded, /\/x$/);
});
test('expandExtraDirs keeps directories, dedupes, and reports the rest', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const dir = join(base, 'dir');
        const file = join(base, 'file.txt');
        await mkdir(dir);
        await writeFile(file, 'x');
        const { dirs, rejected } = await expandExtraDirs([
            dir,
            dir,
            file,
            join(base, 'missing'),
            'relative',
            '',
        ]);
        assert.deepEqual(dirs, [dir]);
        const reasons = rejected.map(({ reason }) => reason);
        assert.ok(reasons.includes('not a directory'), reasons.join(' | '));
        assert.ok(reasons.includes('does not exist'), reasons.join(' | '));
        assert.ok(reasons.some((reason) => reason.startsWith('not an absolute path')), reasons.join(' | '));
        // The blank entry is rejected with its own reason.
        assert.ok(reasons.includes('blank entry'), reasons.join(' | '));
        assert.equal(rejected.length, 4);
    });
});
test('expandExtraDirs resolves a symlinked directory to its target', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const real = join(base, 'real');
        const link = join(base, 'link');
        await mkdir(real);
        await symlink(real, link);
        const { dirs } = await expandExtraDirs([link]);
        assert.equal(dirs.length, 1);
        assert.ok(!dirs[0].endsWith('/link'), dirs[0]);
    });
});
test('isPathUnder accepts the root itself, descendants, and rejects siblings', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const root = join(base, 'root');
        const nested = join(root, 'a', 'b');
        await mkdir(nested, { recursive: true });
        await writeFile(join(base, 'sibling'), 'x');
        assert.equal(await isPathUnder(root, root), true);
        assert.equal(await isPathUnder(nested, root), true);
        assert.equal(await isPathUnder(join(root, 'a'), root), true);
        assert.equal(await isPathUnder(join(base, 'sibling'), root), false);
        assert.equal(await isPathUnder(base, root), false);
        // A not-yet-existing path below the root is still contained lexically.
        assert.equal(await isPathUnder(join(root, 'a', 'new.txt'), root), true);
    });
});
test('isPathUnder does not treat a name prefix as containment', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const root = join(base, 'root');
        const sibling = join(base, 'root-other');
        await mkdir(root);
        await mkdir(sibling);
        assert.equal(await isPathUnder(sibling, root), false);
    });
});
test('a workspace: entry is kept as a subpath instead of being resolved', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const fixed = join(base, 'fixed');
        await mkdir(fixed);
        const { dirs, workspaceDirs, rejected } = await expandExtraDirs([
            fixed,
            'workspace:notes',
            'workspace:./deep/nested',
            'workspace:',
            'workspace:.',
        ]);
        // Only the absolute entry can be made real at configuration time.
        assert.deepEqual(dirs, [fixed]);
        // The rest stay subpaths, in order, with '.' normalized away.
        assert.deepEqual(workspaceDirs, ['notes', 'deep/nested', '']);
        assert.deepEqual(rejected, [], 'a workspace entry is not a rejection');
    });
});
test('a workspace: entry that cannot be a subpath is reported with its own reason', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const { dirs, workspaceDirs, rejected } = await expandExtraDirs([
            'workspace:/etc',
            'workspace:~/secrets',
            'workspace:../escape',
            'workspace:a/../../escape',
            'workspace:ok',
        ]);
        assert.deepEqual(dirs, []);
        assert.deepEqual(workspaceDirs, ['ok'], 'only the usable subpath survives');
        const reasons = rejected.map(({ reason }) => reason);
        assert.equal(rejected.length, 4);
        assert.ok(reasons.every((reason) => reason.startsWith('a workspace path')), reasons.join(' | '));
        assert.ok(reasons.some((reason) => reason.includes('must be relative to the workspace')), reasons.join(' | '));
        assert.ok(reasons.some((reason) => reason.includes('".."')), reasons.join(' | '));
        assert.ok(reasons.some((reason) => reason.includes('a leading ~ does not apply')), reasons.join(' | '));
    });
});
test('two spellings of one workspace directory are not bound twice', async () => {
    const { workspaceDirs } = await expandExtraDirs([
        'workspace:notes',
        'workspace:./notes',
        'workspace: notes ',
        'workspace:other',
    ]);
    assert.deepEqual(workspaceDirs, ['notes', 'other']);
});
test('workspaceDirs is empty when nothing is workspace-relative', async () => {
    const { workspaceDirs } = await expandExtraDirs([]);
    assert.deepEqual(workspaceDirs, []);
    const nonString = await expandExtraDirs([1, null, 'workspace-like']);
    assert.deepEqual(nonString.workspaceDirs, []);
});
test('canonicalRootOf grants a real directory and reports the rest', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const dir = join(base, 'dir');
        const file = join(base, 'file.txt');
        await mkdir(dir);
        await writeFile(file, 'x');
        assert.equal(canonicalRootOf(dir).path, dir);
        // A symlink is followed to the directory it names, so the path granted is
        // the one the fence will compare, not the link.
        const alias = join(base, 'alias');
        await symlink(dir, alias);
        assert.equal(canonicalRootOf(alias).path, dir);
        assert.equal(canonicalRootOf(join(base, 'missing')).reason, 'does not exist');
        assert.equal(canonicalRootOf(file).reason, 'not a directory');
    });
});
test('canonicalRootOf refuses a directory that escapes the workspace it came from', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const workspace = join(base, 'workspace');
        const outside = join(base, 'outside');
        await mkdir(join(workspace, 'notes'), { recursive: true });
        await mkdir(outside);
        // Inside the workspace: granted, at its real path.
        assert.equal(canonicalRootOf(join(workspace, 'notes'), workspace).path, join(workspace, 'notes'));
        // The workspace itself is inside the workspace.
        assert.equal(canonicalRootOf(workspace, workspace).path, workspace);
        // A sibling is not, and the reason names both paths.
        const sibling = canonicalRootOf(outside, workspace);
        assert.equal(sibling.path, undefined);
        assert.match(/** @type {string} */ (sibling.reason), /outside the session workspace/);
        // The escape that matters: a symlink inside the workspace that points out
        // of it. The lexical join would have granted it.
        await symlink(outside, join(workspace, 'escape'));
        const escaped = canonicalRootOf(join(workspace, 'escape'), workspace);
        assert.equal(escaped.path, undefined);
        assert.match(/** @type {string} */ (escaped.reason), /outside the session workspace/);
        // A workspace root that is itself gone refuses rather than falling back.
        const gone = canonicalRootOf(join(workspace, 'notes'), join(base, 'absent'));
        assert.match(/** @type {string} */ (gone.reason), /does not exist/);
    });
});
test('existingDirectories drops a root that is no longer a directory there', async () => {
    await withTempTree(async (/** @type {string} */ base) => {
        const kept = join(base, 'kept');
        const replaced = join(base, 'replaced');
        const gone = join(base, 'gone');
        await mkdir(kept);
        await mkdir(replaced);
        await mkdir(gone);
        // A directory swapped for a symlink after it was granted is not a bind
        // source: bwrap would refuse the whole command on it.
        await rm(replaced, { recursive: true, force: true });
        await symlink(kept, replaced);
        await rm(gone, { recursive: true, force: true });
        assert.deepEqual(existingDirectories([kept, replaced, gone]), [kept]);
    });
});
test('workspaceEntryPath joins a subpath onto a workspace root', () => {
    assert.equal(workspaceEntryPath('notes', '/ws'), join('/ws', 'notes'));
    assert.equal(workspaceEntryPath('deep/nested', '/ws'), join('/ws', 'deep/nested'));
    // An empty subpath is the workspace root itself, not a stray separator.
    assert.equal(workspaceEntryPath('', '/ws'), '/ws');
    // The root is used as given: already absolute and canonical by contract.
    assert.equal(workspaceEntryPath('notes', '/ws/'), join('/ws/', 'notes'));
});
