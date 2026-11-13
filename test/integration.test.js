/**
 * Offline integration test: assemble the plugin's pieces the way the profile
 * does, over a hand-built context, and check that configured presets really
 * widen writes while `/permission` selection decides when.
 *
 * This runs against the real DSH packages (via the scratch link) but without a
 * running Harness, so it exercises the plugin's own wiring: service
 * registration, preset publication, fs containment retry, and bwrap argv.
 *
 * Run with `node --test test/integration.test.js`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { optionalImport } from './support/host.js';
import { Context } from '@deepseek-ai/cordis';

/**
 * Import a DSH package, resolving it from the pnpm store that installed the
 * running `dsh` when a bare specifier does not resolve. A linked plugin does
 * not have the DSH packages in its own resolution chain, so the bare import
 * alone skips every contract case — which is exactly the wrong outcome for
 * tests whose purpose is to pin the stock interfaces.
 */
/** @type {typeof optionalImport} */
const dsh = optionalImport;
const [cordis, fsSandbox, sandboxLocal] = (await Promise.all([
    dsh('@deepseek-ai/cordis'),
    dsh('@deepseek-ai/dsh-fs-sandbox'),
    dsh('@deepseek-ai/dsh-sandbox-local'),
]));
const skip = cordis === undefined ? 'the DSH packages are not resolvable here' : false;
/**
 * Fixture parent. Deliberately NOT the OS temp directory: the stock fence
 * already treats `/tmp` and `tmpdir()` as writable, so a temp-dir fixture
 * could never produce the containment denial under test.
 */
const fixtureParent = join(process.cwd(), '.tmp');
const makeFixture = async () => {
    await mkdir(fixtureParent, { recursive: true });
    return mkdtemp(join(fixtureParent, 'esp-'));
};
/**
 * Validate through the plugin's own schema, the way Cordis does before construction.
 *
 * @param {{ (config: unknown): unknown }} schema - the plugin's Config.
 * @param {unknown} config - the raw config table.
 * @returns {import('../src/contracts.js').SandboxPresetsConfig} the validated config.
 */
const serviceConfig = (schema, config) => /** @type {import('../src/contracts.js').SandboxPresetsConfig} */ (schema(config));
/**
 * A stand-in for the volatile config field, which is read through `.get()`.
 *
 * @param {unknown} value
 * @returns {{ get: () => unknown }}
 */
const volatile = (value) => ({ get: () => value });
/**
 * The stand-in context fields the cases and the plugin read. Deliberately
 * not a real `Context`: the plugin touches a narrow seam, and typing the
 * double against that seam is what keeps these cases honest. The index
 * signature carries whatever service a case mounts.
 *
 * @typedef {{
 *   logger: { warn: (message: string) => void, info: (message: string) => void, debug: (message: string) => void },
 *   reflect: { provide: (name: string, instance: unknown) => void },
 *   registry: Map<string, unknown>,
 *   effect: (run: () => unknown) => () => void,
 *   get: (name: string) => unknown,
 *   on: (name: string, listener: (...args: unknown[]) => unknown) => () => void,
 *   inject: (names: string[], callback: (scope: unknown) => unknown) => void,
 *   disposeEffects: () => void,
 *   fs?: { checkedTarget: (target: unknown, policy?: unknown) => Promise<unknown>, resolve: (path: string) => Promise<{ displayPath: string }>, writeText: (target: unknown, content: string, expected?: unknown, signal?: unknown, policy?: unknown) => Promise<unknown>, readText: (target: unknown) => Promise<string> },
 *   [key: string]: unknown,
 * }} TestContext
 */
/**
 * @typedef {object} FakeContext
 * @property {TestContext} ctx - the stand-in context.
 * @property {(() => void)[]} disposers - disposers the service registered.
 * @property {Map<string, unknown>} registered - services `reflect.provide` received.
 * @property {Map<string, ((...args: unknown[]) => unknown)[]>} listeners - `on` registrations.
 */
/**
 * Build the stand-in context the suites mount the plugin on.
 *
 * @param {Record<string, unknown>} [services] - services the case mounts besides the stand-ins.
 * @returns {FakeContext} the stand-in context and its recorded seams.
 */
function fakeContext(services = {}) {
    /** @type {(() => void)[]} */
    const disposers = [];
    /** @type {Map<string, unknown>} */
    const registered = new Map();
    /** @type {Map<string, ((...args: unknown[]) => unknown)[]>} */
    const listeners = new Map();
    /** @type {TestContext} */
    const ctx = {
        logger: {
            warn: (/** @type {string} */ _message) => { },
            info: (/** @type {string} */ _message) => { },
            debug: (/** @type {string} */ _message) => { },
        },
        reflect: { provide: (/** @type {string} */ name, /** @type {unknown} */ instance) => registered.set(name, instance) },
        registry: new Map(),
        effect: (/** @type {() => unknown} */ run) => {
            const disposer = /** @type {(() => void) | undefined} */ (run());
            if (typeof disposer === 'function')
                disposers.push(disposer);
            return () => { };
        },
        get: (/** @type {string} */ name) => ctx[name],
        on: (/** @type {string} */ name, /** @type {(...args: unknown[]) => unknown} */ listener) => {
            const hooks = listeners.get(name) ?? [];
            hooks.push(listener);
            listeners.set(name, hooks);
            return () => { };
        },
        inject: (/** @type {string[]} */ names, /** @type {(scope: unknown) => unknown} */ callback) => {
            if (names.some((/** @type {string} */ name) => ctx[name] === undefined))
                return;
            callback({
                ...ctx,
                [Symbol.dispose]: undefined,
                effect: (/** @type {() => unknown} */ run) => {
                    const disposer = /** @type {(() => void) | undefined} */ (run());
                    if (typeof disposer === 'function')
                        disposers.push(disposer);
                },
            });
        },
        // Overwritten below; present so the literal satisfies the typedef.
        disposeEffects: () => { },
        ...services,
    };
    ctx.disposeEffects = () => {
        for (const disposer of disposers.splice(0).reverse())
            disposer();
    };
    return { ctx, disposers, registered, listeners };
}
/**
 * The plugin accepts any context it is handed; the stand-in is close enough.
 *
 * @param {unknown} ctx - the stand-in context.
 * @returns {import('@deepseek-ai/cordis').Context}
 */
const asContext = (ctx) => /** @type {import('@deepseek-ai/cordis').Context} */ (ctx);
/** The context orders the real prompt registry assigns, copied from the harness. */
const CONTEXT_ORDERS = {
    WORKING_DIRECTORY: 100,
    SANDBOX_POLICY: 110,
    APPROVAL_POLICY: 115,
    SUBAGENT_DELEGATION: 120,
    TEAM_IDENTITY: 125,
    HARNESS_SOURCE: 200,
    WEB_SURFACE: 210,
};
/** The prompt context this plugin registers. */
const NOTE_CONTEXT = 'sandbox:preset-write-dirs';
/**
 * A stand-in for the prompt registry. It records what the plugin registers and
 * renders the note the way the harness would, so a case reads the model-facing
 * text rather than inspecting a registration call.
 *
 * A registration — not a rewrite of another subsystem's entry — is what the
 * harness keeps: it re-resolves every runtime context from its provider while
 * preparing each request, so only the registered text reaches the model.
 */
const promptRegistry = () => {
    /** @type {{ name: string, order: number, text: (ctx: unknown) => string }[]} */
    const contexts = [];
    return {
        contexts,
        context(/** @type {{ name: string, order: number, text: (ctx: unknown) => string }} */ input) {
            assert.ok(!contexts.some((entry) => entry.name === input.name), `no duplicate context "${input.name}"`);
            contexts.push(input);
        },
        getContextOrder: (/** @type {string} */ name) => CONTEXT_ORDERS[/** @type {keyof typeof CONTEXT_ORDERS} */ (name)] ?? 0,
        /** The note this plugin contributes for one session. */
        render(/** @type {unknown} */ session) {
            return contexts.find((entry) => entry.name === NOTE_CONTEXT)?.text({ agent: { session } }) ?? '';
        },
    };
};
test('every configured preset is published in the permission table and catalog', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const catalogChanged = [];
    /** @type {{ presets: Record<string, unknown>, emitCatalogChanged: () => void }} */
    const permissions = {
        presets: {
            'read-only': { sandbox: 'read-only', approval: 'ask' },
            'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
            // The shipped profile declares this one so its `defaultPreset` resolves
            // without this plugin; the plugin shadows it and restores it on unload.
            'workspace-write-extra': { sandbox: 'workspace-write', approval: 'ask' },
            'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
        },
        emitCatalogChanged: () => { catalogChanged.push(1); },
    };
    const prompt = promptRegistry();
    const { ctx } = fakeContext({
        permissionPresets: permissions,
        systemPrompt: prompt,
    });
    const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
        presets: {
            'workspace-write-extra': { writableDirs: [] },
            rust: { writableDirs: [] },
            scratch: { sandbox: 'read-only', approval: 'never', writableDirs: [] },
        },
    }));
    // Each configured preset is offered, keeping the configured mode/approval.
    assert.deepEqual(service.presetNames, ['workspace-write-extra', 'rust', 'scratch']);
    assert.deepEqual(permissions.presets.rust, { sandbox: 'workspace-write', approval: 'ask' });
    assert.deepEqual(permissions.presets.scratch, { sandbox: 'read-only', approval: 'never' });
    assert.deepEqual(permissions.presets['workspace-write-extra'], { sandbox: 'workspace-write', approval: 'ask' });
    // The shipped entries are left exactly as they were.
    assert.deepEqual(permissions.presets['read-only'], { sandbox: 'read-only', approval: 'ask' });
    assert.equal(catalogChanged.length, 1);
    // The plugin registers a context of its own rather than rewriting the stock
    // note: the harness re-resolves contexts from their providers on every
    // request, so only a registration survives to the rendered prompt.
    assert.equal(prompt.contexts.length, 1, 'exactly one context is registered');
    assert.equal(prompt.contexts[0].name, NOTE_CONTEXT);
    assert.equal(prompt.contexts[0].order, CONTEXT_ORDERS.SANDBOX_POLICY + 1, 'it sits directly after the stock note');
    // No session resolves here, so the context contributes nothing.
    assert.equal(prompt.render(undefined), '', 'no session means no note');
    // A reserved name is refused instead of shadowing the shipped presets.
    const reserved = fakeContext({ permissionPresets: permissions }).ctx;
    const other = new SandboxPresetsExtraService(asContext(reserved), serviceConfig(SandboxPresetsExtraService.Config, {
        presets: { auto: { sandbox: 'workspace-write' }, good: { sandbox: 'read-only' } },
    }));
    assert.deepEqual(other.presetNames, ['good']);
    assert.equal(permissions.presets.auto, undefined);
    // A configured preset carries a label only when the caller gave one.
    const labelled = fakeContext({ permissionPresets: permissions }).ctx;
    new SandboxPresetsExtraService(asContext(labelled), serviceConfig(SandboxPresetsExtraService.Config, {
        presets: { tools: { sandbox: 'read-only', name: 'Tools only', description: 'No workspace write' } },
    }));
    assert.deepEqual(permissions.presets.tools, {
        sandbox: 'read-only',
        approval: 'ask',
        name: 'Tools only',
        description: 'No workspace write',
    });
    // Unloading restores the shadowed entry and removes the added ones.
    ctx.disposeEffects();
    assert.deepEqual(permissions.presets['workspace-write-extra'], { sandbox: 'workspace-write', approval: 'ask' });
    assert.equal(permissions.presets.rust, undefined);
    assert.equal(permissions.presets.scratch, undefined);
});
test('a changed preset table is republished live', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const catalogChanged = [];
    /** @type {{ presets: Record<string, unknown>, emitCatalogChanged: () => void }} */
    const permissions = {
        presets: {},
        emitCatalogChanged: () => { catalogChanged.push(1); },
    };
    const { ctx } = fakeContext({ permissionPresets: permissions });
    /** @type {{ table: Record<string, unknown> }} */
    const holder = { table: { rust: { writableDirs: [] } } };
    // Constructed without schema validation: the point here is the volatile
    // reference the service reads live, not the input shape Cordis validates.
    const service = new SandboxPresetsExtraService(asContext(ctx), {
        presets: { get: () => holder.table },
    });
    assert.deepEqual(service.presetNames, ['rust']);
    holder.table = { rust: { writableDirs: [] }, scratch: { sandbox: 'read-only' } };
    assert.deepEqual(service.presetNames, ['rust', 'scratch']);
    assert.deepEqual(permissions.presets.scratch, { sandbox: 'read-only', approval: 'ask' });
    // A preset that disappears is withdrawn again.
    holder.table = { scratch: { sandbox: 'read-only' } };
    assert.deepEqual(service.presetNames, ['scratch']);
    assert.equal(permissions.presets.rust, undefined);
});
test('a session whose permission service is not ready yet selects nothing', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const extra = join(base, 'extra');
        await mkdir(extra);
        const session = { id: 'session-1' };
        // The stock accessor throws until activation has registered its
        // projection. Enforcement asks on every confined call, so that
        // refusal must read as 'nothing selected' rather than propagating
        // out of the wrapper and failing the call itself.
        const { ctx } = fakeContext({
            permissionPresets: {
                presets: {},
                emitCatalogChanged() { },
                permissionState: () => { throw new Error('permission: presets are not ready'); },
            },
            sessions: { get: (/** @type {string} */ id) => (id === session.id ? session : undefined) },
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { rust: { writableDirs: [extra] } },
        }));
        await service.ready();
        assert.equal(service.presetFor(session), undefined, 'an unreadable selection grants nothing');
        assert.deepEqual(service.rootsFor(session), []);
        assert.deepEqual(service.extraRootsFor({ mode: 'workspace-write', sessionId: 'session-1', workspaceRoot: base }), []);
        // Without the owner mounted at all the same holds, so a profile that
        // does not mount presets still loads this plugin.
        const { ctx: bare } = fakeContext({ sessions: { get: () => session } });
        const other = new SandboxPresetsExtraService(asContext(bare), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { rust: { writableDirs: [extra] } },
        }));
        await other.ready();
        assert.equal(other.presetFor(session), undefined);
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('each preset grants only its own directories, and only to its own session', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const workspaceExtra = join(base, 'workspace-extra');
        const scratch = join(base, 'scratch');
        const unused = join(base, 'unused');
        await mkdir(workspaceExtra);
        await mkdir(scratch);
        await mkdir(unused);
        // The permission projection is the only thing deciding enablement.
        let selected = 'workspace-write';
        const session = { id: 'session-1' };
        const prompt = promptRegistry();
        const { ctx } = fakeContext({
            permissionPresets: { presets: {}, emitCatalogChanged() { }, permissionState: () => ({ preset: selected }) },
            sessions: { get: (/** @type {string} */ id) => (id === session.id ? session : undefined) },
            systemPrompt: prompt,
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: {
                'workspace-write-extra': { writableDirs: [workspaceExtra] },
                scratch: { sandbox: 'read-only', writableDirs: [scratch] },
            },
        }));
        await service.ready();
        // No configured preset selected: nothing applies even though it resolves.
        assert.equal(service.presetFor(session), undefined);
        assert.deepEqual(service.rootsFor(session), []);
        assert.deepEqual(service.rootsForSessionId('session-1'), []);
        // Selecting one grants exactly that one's directories.
        selected = 'workspace-write-extra';
        assert.equal(service.presetFor(session)?.name, 'workspace-write-extra');
        assert.deepEqual(service.rootsFor(session), [workspaceExtra]);
        assert.deepEqual(service.rootsForSessionId('session-1'), [workspaceExtra]);
        // The plugin's own context names the directories the selected preset grants.
        const noteFor = () => prompt.render(session);
        const widened = noteFor();
        assert.match(widened, /overrides the "Current DSH file policy" note above/);
        assert.match(widened, /this session is NOT read-only for those directories/);
        assert.ok(widened.includes('Do not refuse, skip, defer, or request an approval/escalation'), 'the model is told to attempt the write normally');
        assert.ok(widened.includes('If a later runtime-context snapshot names a different preset, the latest snapshot is authoritative.'), 'a newer snapshot wins');
        // The preset that grants the directories is named, so a session with more
        // than one configured preset can tell which one is in force.
        assert.ok(widened.includes('"workspace-write-extra" preset'), 'the granting preset is named');
        assert.ok(widened.includes(`- "${workspaceExtra}"`), 'the granted directory is listed on its own line');
        // The standing policy is workspace-write, where the stock note names the
        // session workspace as the writable area, so the exception is stated
        // against that boundary rather than the read-only one.
        assert.ok(widened.includes(', including those outside the session workspace.'), 'the exception is stated against the workspace boundary');
        assert.doesNotMatch(widened, /even under the read-only policy/);
        selected = 'scratch';
        assert.deepEqual(service.rootsFor(session), [scratch]);
        assert.deepEqual(service.dirsForPreset('workspace-write-extra'), [workspaceExtra]);
        const readOnlyNote = noteFor();
        assert.ok(readOnlyNote.includes(`"${scratch}"`), 'the note follows the selected preset');
        assert.ok(readOnlyNote.includes('"scratch" preset'), 'the newly selected preset is named');
        assert.doesNotMatch(readOnlyNote, /"workspace-write-extra" preset/, 'the previous preset is no longer named');
        // This preset is read-only, so the exception is stated outright.
        assert.match(readOnlyNote, /even under the read-only policy above/);
        // A session that selects nothing contributes no note, so the stock wording
        // is what the model sees.
        selected = 'read-only';
        assert.equal(noteFor(), '');
        // Unknown, absent, and non-configured selections get nothing.
        selected = 'read-only';
        assert.deepEqual(service.rootsFor(session), []);
        assert.deepEqual(service.rootsForSessionId('nope'), []);
        assert.deepEqual(service.rootsForSessionId(undefined), []);
        assert.deepEqual(service.rootsFor(undefined), []);
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('an unconfined preset never amends the stock note', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const anywhere = join(base, 'anywhere');
        await mkdir(anywhere);
        const selected = 'wide';
        const session = { id: 'session-1' };
        const prompt = promptRegistry();
        const { ctx } = fakeContext({
            permissionPresets: { presets: {}, emitCatalogChanged() { }, permissionState: () => ({ preset: selected }) },
            sessions: { get: (/** @type {string} */ id) => (id === session.id ? session : undefined) },
            systemPrompt: prompt,
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { wide: { sandbox: 'danger-full-access', writableDirs: [anywhere] } },
        }));
        await service.ready();
        // The directories are still recorded, so the preset is selectable and its
        // directories are known; nothing confines, so they grant nothing extra.
        assert.equal(service.presetFor(session)?.name, 'wide');
        // `danger-full-access` already allows every path, so a note granting
        // extra directories would be wrong: the plugin must contribute nothing.
        assert.equal(prompt.render(session), '', 'no note is contributed under an unconfined mode');
        // The enforcement policy is unconfined too: `extraRootsFor` stays empty so
        // neither wrapper loosens anything.
        assert.deepEqual(service.extraRootsFor({ mode: 'danger-full-access', sessionId: 'session-1' }), []);
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('a workspace entry resolves against the workspace of each session', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        // Two sessions with different workspaces, as the harness folds them from
        // each session's own cwd. One workspace entry has to name a different real
        // directory in each, which a load-time expression could never do.
        const one = join(base, 'ws-one');
        const two = join(base, 'ws-two');
        const outside = join(base, 'fixed');
        await mkdir(join(one, 'notes'), { recursive: true });
        await mkdir(join(two, 'notes'), { recursive: true });
        await mkdir(outside);
        const first = { id: 'first', header: { cwd: one } };
        const second = { id: 'second', header: { cwd: two } };
        const prompt = promptRegistry();
        const { ctx } = fakeContext({
            permissionPresets: { presets: {}, emitCatalogChanged() { }, permissionState: () => ({ preset: 'plus' }) },
            sessions: { get: (/** @type {string} */ id) => [first, second].find((session) => session.id === id) },
            // The stock policy resolves a session's workspace boundary for the
            // enforcement layers; the plugin reads the same value it reports.
            sandboxPolicy: {
                resolve: (/** @type {{ session?: { header?: { cwd?: string } } }} */ request) => ({
                    mode: 'workspace-write',
                    workspaceRoot: request.session?.header?.cwd,
                }),
            },
            systemPrompt: prompt,
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { plus: { writableDirs: [outside, 'workspace:notes'] } },
        }));
        await service.ready();
        // The fixed directory is shared; the workspace entry is not.
        assert.deepEqual(service.rootsFor(first), [outside, join(one, 'notes')]);
        assert.deepEqual(service.rootsFor(second), [outside, join(two, 'notes')]);
        // The enforcement path resolves the same way, from the per-call policy.
        assert.deepEqual(service.extraRootsFor({ mode: 'workspace-write', sessionId: 'first', workspaceRoot: one }), [outside, join(one, 'notes')]);
        assert.deepEqual(service.extraRootsFor({ mode: 'workspace-write', sessionId: 'second', workspaceRoot: two }), [outside, join(two, 'notes')]);
        // The model is told the real path, so it can name a directory it can use.
        const note = prompt.render(first);
        assert.ok(note.includes(join(one, 'notes')), note);
        assert.ok(!note.includes(join(two, 'notes')), 'the other session\'s path is not named');
        // An unconfined mode still grants nothing, workspace entry or not.
        assert.deepEqual(service.extraRootsFor({ mode: 'danger-full-access', sessionId: 'first', workspaceRoot: one }), []);
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('a workspace entry that escapes the workspace is never granted', { skip: skip || fsSandbox === undefined ? 'the DSH filesystem package is not resolvable here' : false }, async () => {
    if (fsSandbox === undefined)
        return;
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const workspace = join(base, 'workspace');
        const outside = join(base, 'outside');
        await mkdir(join(workspace, 'notes'), { recursive: true });
        await mkdir(outside);
        // The workspace is writable by the session, so a subpath below it is
        // whatever the session put there. A link to a directory outside the
        // workspace would turn one configured subpath into a grant for an
        // arbitrarily wider area.
        await symlink(outside, join(workspace, 'escape'));
        // The real stock filesystem, whose containment check the plugin extends.
        const fsCtx = new Context();
        // A stand-in policy service carrying only the field the stock filesystem
        // reads at construction. Assigning through Object.assign keeps the real
        // service type, which the mounted class is, out of the way of the stub.
        Object.assign(fsCtx, { sandboxPolicy: { defaultMode: 'workspace-write' } });
        const fs = new fsSandbox.SandboxedFileSystem(fsCtx, fsSandbox.SandboxedFileSystem.Config({ cwd: workspace }));
        /** @type {string[]} */ const warnings = [];
        const session = { id: 'inside', header: { cwd: workspace } };
        const prompt = promptRegistry();
        const { ctx } = fakeContext({
            fs,
            sandbox: { async confine() { throw new Error('unused here'); } },
            permissionPresets: { presets: {}, emitCatalogChanged() { }, permissionState: () => ({ preset: 'sneaky' }) },
            sessions: { get: (/** @type {string} */ id) => (id === session.id ? session : undefined) },
            systemPrompt: prompt,
        });
        ctx.logger.warn = (/** @type {string} */ message) => { warnings.push(message); };
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { sneaky: { writableDirs: ['workspace:escape', 'workspace:notes'] } },
        }));
        await service.ready();
        // Only the subpath that really stays inside the workspace is granted.
        assert.deepEqual(service.rootsFor(session), [join(workspace, 'notes')]);
        // The refusal is reported, and reported once rather than per call.
        const refusals = () => warnings.filter((message) => message.includes('not granting')).length;
        assert.equal(refusals(), 1, warnings.join(' | '));
        assert.match(warnings.join(' | '), /outside the session workspace/);
        service.rootsFor(session);
        service.rootsFor(session);
        assert.equal(refusals(), 1, 'the warning is not repeated per call');
        // The note lists the granted directory only, so the prompt never names a
        // path the fence would refuse.
        const note = prompt.render(session);
        assert.ok(note.includes(join(workspace, 'notes')), note);
        assert.ok(!note.includes(join(workspace, 'escape')), note);
        assert.ok(!note.includes(outside), note);
        // The live fence refuses the escaped path, which is the point of the
        // whole check: without it this write would have been widened through.
        const policyFor = /** @type {import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy} */ ({ mode: 'workspace-write', workspaceRoot: workspace, sessionId: 'inside' });
        const escaped = await fs.resolve(join(workspace, 'escape', 'note.txt'));
        await assert.rejects(fs.writeText(escaped, 'x', undefined, undefined, policyFor), { code: 'FS_SANDBOX_DENIED' });
        // A granted subpath is still writable, so the refusal is scoped to the escape.
        const granted = await fs.resolve(join(workspace, 'notes', 'note.txt'));
        await fs.writeText(granted, 'x', undefined, undefined, policyFor);
        assert.equal(await fs.readText(granted), 'x');
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('a workspace subpath that vanished never breaks a confined command', { skip: skip || sandboxLocal === undefined ? 'the DSH sandbox package is not resolvable here' : false }, async () => {
    if (sandboxLocal === undefined)
        return;
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const workspace = join(base, 'workspace');
        const stale = join(workspace, 'stale');
        await mkdir(stale, { recursive: true });
        const session = { id: 'inside', header: { cwd: workspace } };
        const sandbox = new sandboxLocal.LocalSandboxProvider(new Context(), { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5_000 });
        const { ctx } = fakeContext({
            sandbox,
            fs: { async checkedTarget() { return 'unused'; } },
            permissionPresets: { presets: {}, emitCatalogChanged() { }, permissionState: () => ({ preset: 'extra' }) },
            sessions: { get: (/** @type {string} */ id) => (id === session.id ? session : undefined) },
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { extra: { writableDirs: ['workspace:stale', 'workspace:missing'] } },
        }));
        await service.ready();
        const argv = ['bash', '-c', 'true'];
        const policy = /** @type {import('@deepseek-ai/dsh-sandbox').SandboxPolicy} */ ({ mode: 'workspace-write', workspaceRoot: workspace, sessionId: 'inside' });
        /** @type {(confined: { argv: string[] }) => string[]} */
        const bindsOf = (confined) => {
            const at = confined.argv.indexOf('--');
            const binds = [];
            for (let index = 0; index < at; index += 1) {
                if (confined.argv[index] === '--bind')
                    binds.push(confined.argv[index + 1]);
            }
            return binds;
        };
        // The subpath that does not exist is not granted, so the note and the
        // fence agree, and no bind source is invented.
        assert.deepEqual(service.rootsFor(session), [stale]);
        const existing = bindsOf(await sandbox.confine(argv, policy));
        assert.ok(existing.includes(stale), existing.join(','));
        assert.ok(!existing.includes(join(workspace, 'missing')), existing.join(','));
        // A directory that vanishes after it was granted is dropped right before
        // the profile is built. Bwrap refuses a bind source that is not there,
        // which would cost the session every shell command rather than one
        // refused write.
        await rm(stale, { recursive: true, force: true });
        const after = await sandbox.confine(argv, policy);
        assert.equal(after.argv[0], 'bwrap', 'the profile is still a usable bwrap command');
        const binds = bindsOf(after);
        assert.ok(!binds.includes(stale), binds.join(','));
        assert.deepEqual(after.argv.slice(after.argv.indexOf('--') + 1), argv, 'the wrapped command is unchanged');
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('an unusable configured directory is ignored, never granted', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const good = join(base, 'good');
        const file = join(base, 'file.txt');
        await mkdir(good);
        await writeFile(file, 'x');
        /** @type {string[]} */ const warnings = [];
        const session = { id: 's' };
        const { ctx } = fakeContext({
            permissionPresets: { presets: {}, emitCatalogChanged() { }, permissionState: () => ({ preset: 'rust' }) },
            sessions: { get: () => session },
        });
        ctx.logger.warn = (/** @type {string} */ message) => { warnings.push(message); };
        const service = new SandboxPresetsExtraService(asContext(ctx), {
            presets: {
                rust: { writableDirs: [good, file, join(base, 'missing'), 'relative'] },
                nope: { sandbox: 'not-a-mode', writableDirs: [good] },
            },
        });
        await service.ready();
        assert.deepEqual(service.dirsForPreset('rust'), [good]);
        assert.deepEqual(service.rootsFor(session), [good]);
        assert.deepEqual(service.presetNames, ['rust']);
        assert.equal(warnings.length, 1, warnings.join('\n'));
        assert.match(warnings[0], /ignoring unusable configured presets/);
        assert.match(warnings[0], /not a directory/);
        assert.match(warnings[0], /does not exist/);
        assert.match(warnings[0], /unknown sandbox mode "not-a-mode"/);
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('wrapping the live filesystem widens only the selected preset and session', { skip: skip || fsSandbox === undefined ? 'the DSH filesystem package is not resolvable here' : false }, async () => {
    if (fsSandbox === undefined)
        return;
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const workspace = join(base, 'workspace');
        const extra = join(base, 'extra');
        const scratch = join(base, 'scratch');
        await mkdir(workspace);
        await mkdir(extra);
        await mkdir(scratch);
        let selected = 'workspace-write';
        const inside = { id: 'inside' };
        const outside = { id: 'outside' };
        // The REAL stock filesystem, mounted as the composition would.
        const fsCtx = new Context();
        // A stand-in policy service carrying only the field the stock filesystem
        // reads at construction. Assigning through Object.assign keeps the real
        // service type, which the mounted class is, out of the way of the stub.
        Object.assign(fsCtx, { sandboxPolicy: { defaultMode: 'workspace-write' } });
        const fs = new fsSandbox.SandboxedFileSystem(fsCtx, 
        // Validate through the real schema so required defaults are present.
        fsSandbox.SandboxedFileSystem.Config({ cwd: workspace }));
        const { ctx } = fakeContext({
            fs,
            // `ctx.inject(['fs', 'sandbox'])` runs the wrapper install immediately.
            sandbox: { async confine() { throw new Error('unused here'); } },
            permissionPresets: {
                presets: {},
                emitCatalogChanged() { },
                permissionState: (/** @type {unknown} */ session) => ({ preset: session === inside ? selected : 'workspace-write' }),
            },
            sessions: { get: (/** @type {string} */ id) => [inside, outside].find((session) => session.id === id) },
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: {
                'workspace-write-extra': { writableDirs: [extra] },
                scratch: { sandbox: 'read-only', writableDirs: [scratch] },
            },
        }));
        await service.ready();
        const target = await fs.resolve(join(extra, 'note.txt'));
        const scratchTarget = await fs.resolve(join(scratch, 'note.txt'));
        const policyFor = (/** @type {{ id: string }} */ session, /** @type {import('@deepseek-ai/dsh-sandbox').ConfinedSandboxMode} */ mode = 'workspace-write') => ({ mode, workspaceRoot: workspace, sessionId: /** @type {import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy['sessionId']} */ (session.id) });
        // Preset off: the stock fence still refuses, i.e. the wrapper never widens
        // beyond what the session selected.
        await assert.rejects(fs.writeText(target, 'a', undefined, undefined, policyFor(inside)), { code: 'FS_SANDBOX_DENIED' });
        // The workspace itself stays writable, exactly as before wrapping.
        const inWorkspace = await fs.resolve(join(workspace, 'ok.txt'));
        await fs.writeText(inWorkspace, 'a', undefined, undefined, policyFor(outside));
        // Preset on for that session: the same out-of-workspace target is accepted.
        selected = 'workspace-write-extra';
        await fs.writeText(target, 'b', undefined, undefined, policyFor(inside));
        assert.equal(await fs.readText(target), 'b');
        // A session that did not select it is still refused.
        const otherTarget = await fs.resolve(join(extra, 'other.txt'));
        await assert.rejects(fs.writeText(otherTarget, 'c', undefined, undefined, policyFor(outside)), { code: 'FS_SANDBOX_DENIED' });
        // A different preset grants a different directory: the workspace-write one
        // no longer applies, and the read-only one does.
        selected = 'scratch';
        await assert.rejects(fs.writeText(target, 'd', undefined, undefined, policyFor(inside)), { code: 'FS_SANDBOX_DENIED' });
        await fs.writeText(scratchTarget, 'd', undefined, undefined, policyFor(inside, 'read-only'));
        assert.equal(await fs.readText(scratchTarget), 'd');
        // Outside that preset's directory, read-only still refuses.
        await assert.rejects(fs.writeText(otherTarget, 'e', undefined, undefined, policyFor(inside, 'read-only')), { code: 'FS_SANDBOX_DENIED' });
        // Unloading restores the stock fence exactly: the widening is gone.
        ctx.disposeEffects();
        await assert.rejects(fs.writeText(scratchTarget, 'f', undefined, undefined, policyFor(inside, 'read-only')), { code: 'FS_SANDBOX_DENIED' });
        assert.equal(await fs.readText(scratchTarget), 'd');
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('wrapping the live provider binds the selected preset directories per session', { skip: skip || sandboxLocal === undefined ? 'the DSH sandbox package is not resolvable here' : false }, async () => {
    if (sandboxLocal === undefined)
        return;
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const workspace = join(base, 'workspace');
        const extra = join(base, 'extra');
        await mkdir(workspace);
        await mkdir(extra);
        const inside = { id: 'inside' };
        const outside = { id: 'outside' };
        // The REAL stock provider, mounted as the composition would.
        const sandbox = new sandboxLocal.LocalSandboxProvider(new Context(), { runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5_000 });
        const { ctx } = fakeContext({
            sandbox,
            fs: { async checkedTarget(/** @type {unknown} */ _target, /** @type {unknown} */ _policy) { return 'unused'; } },
            permissionPresets: {
                presets: {},
                emitCatalogChanged() { },
                permissionState: (/** @type {unknown} */ session) => ({
                    preset: session === inside ? 'workspace-write-extra' : 'workspace-write',
                }),
            },
            sessions: { get: (/** @type {string} */ id) => [inside, outside].find((session) => session.id === id) },
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { 'workspace-write-extra': { writableDirs: [extra] } },
        }));
        await service.ready();
        const argv = ['bash', '-c', 'true'];
        /** @type {(session: { id: string }) => import('@deepseek-ai/dsh-sandbox').SandboxPolicy} */
        const policy = (session) => ({ mode: 'workspace-write', workspaceRoot: workspace, sessionId: /** @type {import('@deepseek-ai/dsh-sandbox').SandboxExecutionPolicy['sessionId']} */ (session.id) });
        const bindsOf = (/** @type {{ argv: string[] }} */ confined) => {
            const at = confined.argv.indexOf('--');
            const binds = [];
            for (let index = 0; index < at; index += 1) {
                if (confined.argv[index] === '--bind')
                    binds.push(confined.argv[index + 1]);
            }
            return { at, binds, confined };
        };
        // The selected session gets the extra directory bound alongside the workspace.
        const widened = bindsOf(await sandbox.confine(argv, policy(inside)));
        assert.equal(widened.confined.argv[0], 'bwrap', 'the real provider selects the bwrap rung');
        assert.ok(widened.binds.includes(workspace), widened.binds.join(','));
        assert.ok(widened.binds.includes(extra), widened.binds.join(','));
        assert.deepEqual(widened.confined.argv.slice(widened.at + 1), argv);
        // A session that did not select the preset gets the stock profile.
        const stock = bindsOf(await sandbox.confine(argv, policy(outside)));
        assert.ok(stock.binds.includes(workspace), stock.binds.join(','));
        assert.ok(!stock.binds.includes(extra), stock.binds.join(','));
        // Unloading restores the stock profile exactly.
        ctx.disposeEffects();
        const restored = bindsOf(await sandbox.confine(argv, policy(inside)));
        assert.ok(!restored.binds.includes(extra), restored.binds.join(','));
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('a mounted service without the expected seam is reported, not silently ignored', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    /** @type {string[]} */ const warnings = [];
    // Both enforcement services are mounted but neither exposes the interface the
    // plugin extends, which is what a harness upgrade that moved the seam looks
    // like. The plugin must say so rather than leaving the presets quietly narrow.
    const { ctx } = fakeContext({
        fs: { resolve: async (/** @type {string} */ path) => ({ displayPath: path, targetKey: path }) },
        sandbox: { restrict: () => 'not the seam' },
        permissionPresets: { presets: {}, emitCatalogChanged() { } },
        systemPrompt: {},
    });
    ctx.logger.warn = (/** @type {string} */ message) => { warnings.push(message); };
    new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
        presets: { rust: { writableDirs: [] } },
    }));
    assert.equal(warnings.length, 2, warnings.join('\n'));
    assert.match(warnings[0], /"fs" service does not expose the interface/);
    assert.match(warnings[1], /"sandbox" service does not expose the interface/);
    assert.match(warnings[0], /moved that interface/);
    // Reported once per service, not on every refresh.
    warnings.length = 0;
    const again = fakeContext({
        fs: {},
        sandbox: {},
        permissionPresets: { presets: {}, emitCatalogChanged() { } },
        systemPrompt: {},
    });
    again.ctx.logger.warn = (/** @type {string} */ message) => { warnings.push(message); };
    const service = new SandboxPresetsExtraService(asContext(again.ctx), serviceConfig(SandboxPresetsExtraService.Config, {
        presets: { rust: { writableDirs: ['/nonexistent-probe-dir'] } },
    }));
    await service.ready();
    await service.ready();
    const seamWarnings = warnings.filter((message) => message.includes('does not expose the interface'));
    assert.equal(seamWarnings.length, 2, warnings.join('\n'));
});
test('a recognized service is wrapped without any warning', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    /** @type {string[]} */ const warnings = [];
    const { ctx } = fakeContext({
        fs: {
            checkedTarget: async (/** @type {unknown} */ _target, /** @type {unknown} */ _policy) => 'ok',
            resolve: async (/** @type {string} */ path) => ({ displayPath: path, targetKey: path }),
        },
        sandbox: { confine: async (/** @type {string[]} */ argv) => ({ argv }) },
        permissionPresets: { presets: {}, emitCatalogChanged() { } },
        systemPrompt: {},
    });
    ctx.logger.warn = (/** @type {string} */ message) => { warnings.push(message); };
    const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
        presets: {},
    }));
    assert.deepEqual(warnings, [], warnings.join('\n'));
    await service.ready();
    // The wrappers are installed and removal restores the originals.
    const wrapped = /** @type {NonNullable<TestContext['fs']>} */ (ctx.fs);
    assert.notEqual(wrapped.checkedTarget.name, undefined);
    ctx.disposeEffects();
});
test('a delegated session inherits the preset its delegating session selected', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const extra = join(base, 'extra');
        const scratch = join(base, 'scratch');
        await mkdir(extra);
        await mkdir(scratch);
        // The harness hands a delegated session only a bare sandbox mode and a
        // never-approve policy: its own log names no preset, so the selection has
        // to be read back from the session that delegated it.
        const parent = { id: 'parent', header: {} };
        const child = { id: 'child', header: { parentSession: 'parent' } };
        /** @type {Record<string, unknown>} */
        const knobs = {
            parent: { preset: 'workspace-write-extra', sandbox: 'workspace-write', approval: 'ask' },
            child: { preset: null, sandbox: 'workspace-write', approval: 'never' },
        };
        const prompt = promptRegistry();
        const { ctx } = fakeContext({
            permissionPresets: {
                presets: {},
                emitCatalogChanged() { },
                permissionState: (/** @type {unknown} */ session) => (session === undefined ? undefined : knobs[/** @type {{ id: string }} */ (session).id]),
            },
            sessions: { get: (/** @type {string} */ id) => [parent, child].find((session) => session.id === id) },
            systemPrompt: prompt,
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: {
                'workspace-write-extra': { writableDirs: [extra] },
                scratch: { sandbox: 'read-only', writableDirs: [scratch] },
            },
        }));
        await service.ready();
        // The child recorded no preset of its own, so without the inheritance
        // both the fence and the note would be empty — the bug this covers.
        assert.equal(service.presetFor(child)?.name, 'workspace-write-extra');
        assert.deepEqual(service.rootsFor(child), [extra]);
        // The enforcement path resolves the same way, per call.
        assert.deepEqual(service.extraRootsFor({ mode: 'workspace-write', sessionId: 'child' }), [extra]);
        // The parent keeps exactly its own selection.
        assert.equal(service.presetFor(parent)?.name, 'workspace-write-extra');
        // A session that selected nothing and was delegated nothing still gets nothing.
        assert.equal(service.presetFor({ id: 'stranger', header: {} }), undefined);
        // The note names where the grant came from, because this session's own
        // runtime context never names a preset.
        const note = prompt.render(child);
        assert.match(note, /delegated from one running the "workspace-write-extra" preset/);
        assert.match(note, /it is NOT read-only for those directories/);
        assert.ok(note.includes('- "' + extra + '"'), 'the inherited directory is listed');
        assert.doesNotMatch(note, /While the "workspace-write-extra" preset is selected/, 'no claim that this session selected it');
        // The read-only exception is the parent preset's own mode.
        knobs.parent = { preset: 'scratch', sandbox: 'read-only', approval: 'ask' };
        knobs.child = { preset: null, sandbox: 'read-only', approval: 'never' };
        assert.equal(service.presetFor(child)?.name, 'scratch');
        assert.deepEqual(service.extraRootsFor({ mode: 'read-only', sessionId: 'child' }), [scratch]);
        assert.match(prompt.render(child), /even under the read-only policy above/);
        // The inherited grant follows the delegating selection rather than a
        // snapshot taken at delegation.
        knobs.parent = { preset: null, sandbox: 'read-only', approval: 'ask' };
        assert.equal(service.presetFor(child), undefined, 'a parent that selected nothing grants nothing');
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('a delegation only inherits a preset whose mode the child actually runs under', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const extra = join(base, 'extra');
        await mkdir(extra);
        const parent = { id: 'parent', header: {} };
        /** @type {Record<string, unknown>} */
        const knobs = {
            // A shipped preset this plugin does not own: nothing to inherit.
            unowned: { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
        };
        const prompts = promptRegistry();
        const { ctx } = fakeContext({
            permissionPresets: {
                presets: {},
                emitCatalogChanged() { },
                permissionState: (/** @type {unknown} */ session) => {
                    const id = /** @type {{ id?: string }} */ (session ?? {}).id;
                    return id === undefined ? undefined : knobs[id];
                },
            },
            sessions: { get: (/** @type {string} */ id) => (id === parent.id ? parent : undefined) },
            systemPrompt: prompts,
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { plus: { writableDirs: [extra] }, scratch: { sandbox: 'read-only', writableDirs: [extra] } },
        }));
        await service.ready();
        // A parent that selected a preset this plugin does not configure grants
        // nothing: this plugin cannot know what its directories are.
        knobs.parent = knobs.unowned;
        const child = { id: 'child', header: { parentSession: 'parent' } };
        knobs.child = { preset: null, sandbox: 'workspace-write', approval: 'never' };
        assert.equal(service.presetFor(child), undefined);
        assert.deepEqual(service.rootsFor(child), []);
        assert.equal(prompts.render(child), '');
        // A configured preset is inherited only when the delegation pinned the same
        // mode: a child pinned to read-only under a workspace-write parent did not
        // get that preset's write access, so naming the directories would lie.
        knobs.parent = { preset: 'plus', sandbox: 'workspace-write', approval: 'ask' };
        knobs.child = { preset: null, sandbox: 'read-only', approval: 'never' };
        assert.equal(service.presetFor(child), undefined, 'a mode mismatch inherits nothing');
        knobs.child = { preset: null, sandbox: 'workspace-write', approval: 'never' };
        assert.equal(service.presetFor(child)?.name, 'plus', 'the matching mode inherits');
        // A parent with such a selection but no parent link of its own is not a
        // delegated session, and a chain that ends is not followed forever.
        assert.equal(service.presetFor(parent)?.name, 'plus');
        const orphan = { id: 'orphan', header: { parentSession: 'nowhere' } };
        knobs.orphan = { preset: null, sandbox: 'workspace-write', approval: 'never' };
        assert.equal(service.presetFor(orphan), undefined, 'a link to a missing session inherits nothing');
        // A malformed chain that points at itself must terminate.
        const loop = { id: 'loop', header: { parentSession: 'loop' } };
        knobs.loop = { preset: null, sandbox: 'workspace-write', approval: 'never' };
        assert.equal(service.presetFor(loop), undefined, 'a self-referential chain terminates');
        // A session whose own selection is recorded keeps it regardless of the parent.
        knobs.child = { preset: 'scratch', sandbox: 'read-only', approval: 'ask' };
        assert.equal(service.presetFor(child)?.name, 'scratch');
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('a delegated session inside a delegated session follows the chain to a selection', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const extra = join(base, 'extra');
        await mkdir(extra);
        // root selected the preset; middle is itself delegated and selected
        // nothing; leaf is delegated from middle.
        const root = { id: 'root', header: {} };
        const middle = { id: 'middle', header: { parentSession: 'root' } };
        const leaf = { id: 'leaf', header: { parentSession: 'middle' } };
        /** @type {Record<string, unknown>} */
        const knobs = {
            root: { preset: 'plus', sandbox: 'workspace-write', approval: 'ask' },
            middle: { preset: null, sandbox: 'workspace-write', approval: 'never' },
            leaf: { preset: null, sandbox: 'workspace-write', approval: 'never' },
        };
        const { ctx } = fakeContext({
            permissionPresets: {
                presets: {},
                emitCatalogChanged() { },
                permissionState: (/** @type {unknown} */ session) => knobs[/** @type {{ id: string }} */ (session).id],
            },
            sessions: { get: (/** @type {string} */ id) => [root, middle, leaf].find((session) => session.id === id) },
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { plus: { writableDirs: [extra] } },
        }));
        await service.ready();
        assert.equal(service.presetFor(middle)?.name, 'plus');
        assert.equal(service.presetFor(leaf)?.name, 'plus');
        assert.deepEqual(service.extraRootsFor({ mode: 'workspace-write', sessionId: 'leaf' }), [extra]);
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('a delegation is not followed when the session service is absent', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const extra = join(base, 'extra');
        await mkdir(extra);
        const parent = { id: 'parent', header: {} };
        const child = { id: 'child', header: { parentSession: 'parent' } };
        // No `sessions` service at all: the profile that mounts this plugin
        // without one still has to load, and a child with nothing to read from
        // simply inherits nothing.
        const { ctx } = fakeContext({
            permissionPresets: {
                presets: {},
                emitCatalogChanged() { },
                permissionState: (/** @type {unknown} */ session) => ({
                    preset: session === parent ? 'plus' : null,
                    sandbox: 'workspace-write',
                    approval: 'never',
                }),
            },
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { plus: { writableDirs: [extra] } },
        }));
        await service.ready();
        assert.equal(service.presetFor(parent)?.name, 'plus', 'a recorded selection needs no session service');
        assert.equal(service.presetFor(child), undefined, 'without the session service there is no parent to read');
        assert.deepEqual(service.rootsFor(child), []);
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('an unconfined delegating preset is never inherited by a confined child', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const anywhere = join(base, 'anywhere');
        await mkdir(anywhere);
        const parent = { id: 'parent', header: {} };
        const child = { id: 'child', header: { parentSession: 'parent' } };
        /** @type {Record<string, unknown>} */
        const knobs = {
            parent: { preset: 'wide', sandbox: 'danger-full-access', approval: 'never' },
            child: { preset: null, sandbox: 'workspace-write', approval: 'never' },
        };
        const prompt = promptRegistry();
        const { ctx } = fakeContext({
            permissionPresets: {
                presets: {},
                emitCatalogChanged() { },
                permissionState: (/** @type {unknown} */ session) => knobs[/** @type {{ id: string }} */ (session).id],
            },
            sessions: { get: (/** @type {string} */ id) => [parent, child].find((session) => session.id === id) },
            systemPrompt: prompt,
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { wide: { sandbox: 'danger-full-access', writableDirs: [anywhere] } },
        }));
        await service.ready();
        // A child confined to workspace-write must not inherit an unconfined
        // preset: the directories would be meaningless, and naming them would
        // claim a boundary the plugin does not grant.
        assert.equal(service.presetFor(child), undefined);
        assert.deepEqual(service.rootsFor(child), []);
        assert.equal(prompt.render(child), '', 'no note is contributed for the child');
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
test('a delegation stops when an intermediate session selection is unreadable', { skip }, async () => {
    const { SandboxPresetsExtraService } = await import('../src/service.js');
    const base = await makeFixture();
    try {
        const extra = join(base, 'extra');
        await mkdir(extra);
        const root = { id: 'root', header: {} };
        const middle = { id: 'middle', header: { parentSession: 'root' } };
        const leaf = { id: 'leaf', header: { parentSession: 'middle' } };
        const { ctx } = fakeContext({
            permissionPresets: {
                presets: {},
                emitCatalogChanged() { },
                // The permission service is still activating, which it signals by
                // throwing. That is not evidence of a selection, so the chain stops.
                permissionState: (/** @type {unknown} */ session) => {
                    if (/** @type {{ id?: string }} */ (session)?.id === 'middle') throw new Error('permission: presets are not ready');
                    return session === root
                        ? { preset: 'plus', sandbox: 'workspace-write', approval: 'ask' }
                        : { preset: null, sandbox: 'workspace-write', approval: 'never' };
                },
            },
            sessions: { get: (/** @type {string} */ id) => [root, middle, leaf].find((session) => session.id === id) },
        });
        const service = new SandboxPresetsExtraService(asContext(ctx), serviceConfig(SandboxPresetsExtraService.Config, {
            presets: { plus: { writableDirs: [extra] } },
        }));
        await service.ready();
        // The first hop reads the root through the middle session, and an
        // unreadable middle means the claim cannot be made.
        assert.equal(service.presetFor(middle), undefined, 'an unreadable session inherits nothing');
        assert.equal(service.presetFor(leaf), undefined, 'and neither does its own child');
    }
    finally {
        await rm(base, { recursive: true, force: true });
    }
});
