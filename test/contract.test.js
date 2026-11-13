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
 * Run with `node --test test/contract.test.js`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { applyExtraDirsConfine } from '../src/provider.js';
import { applyExtraDirsFence } from '../src/fs.js';
import { createHost, optionalImport } from './support/host.js';
import { Context } from '@deepseek-ai/cordis';
import { asFsSeam, asPermissionSeam, asPolicySeam } from './support/views.js';
/**
 * Import a DSH package, resolving it from the pnpm store that installed the
 * running `dsh` when a bare specifier does not resolve. A linked plugin does
 * not have the DSH packages in its own resolution chain, so the bare import
 * alone skips every contract case — which is exactly the wrong outcome for
 * tests whose purpose is to pin the stock interfaces.
 */
/** @type {typeof optionalImport} */
const dsh = optionalImport;
const [fsSandbox, sandboxLocal, permissionPresets, sandboxPolicy, sessionStore, systemPrompt] = (await Promise.all([
    dsh('@deepseek-ai/dsh-fs-sandbox'),
    dsh('@deepseek-ai/dsh-sandbox-local'),
    dsh('@deepseek-ai/dsh-permission-presets'),
    dsh('@deepseek-ai/dsh-sandbox-policy'),
    dsh('@deepseek-ai/dsh-session'),
    dsh('@deepseek-ai/dsh-system-prompt'),
]));

/** The policy service class, when the package resolves; the helper below mounts it. */
const policyClass = sandboxPolicy?.SandboxPolicyService;

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
    // A stand-in policy service carrying only the field the stock filesystem
    // reads at construction. Assigning through Object.assign keeps the real
    // service type, which the mounted class is, out of the way of the stub.
    Object.assign(ctx, { sandboxPolicy: { defaultMode: 'workspace-write' } });
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

/**
 * The assembly context the agent loop hands the registry: the calling agent, and
 * through it the session the note is rendered for.
 *
 * The stock `AssembleContext` declares neither field — `agent` is contributed by
 * `dsh-agent` through a module augmentation this package does not install,
 * because the plugin only ever reads the session off the context it is handed.
 *
 * @param {string} sessionId - the session id to assemble for.
 * @returns {import('@deepseek-ai/dsh-system-prompt').AssembleContext} the context, widened.
 */
const assemblyContext = (sessionId) => /** @type {import('@deepseek-ai/dsh-system-prompt').AssembleContext} */ (/** @type {unknown} */ ({ agent: { session: { id: sessionId } } }));
/**
 * The session id one assembly context carries, or an empty string.
 *
 * @param {import('@deepseek-ai/dsh-system-prompt').AssembleContext} context - the context a provider is evaluated with.
 * @returns {string} the session id, as the plugin's own note provider reads it.
 */
const agentSessionId = (context) => /** @type {{ agent?: { session?: { id?: string } } }} */ (context).agent?.session?.id ?? '';
/**
 * Mount the real sandbox policy service in a live application, stubbing only the
 * projection store it registers into.
 *
 * The service registers a session projection while activating, so a bare
 * `new` leaves it unable to answer. Stubbing that one dependency runs the real
 * `[Service.init]` and therefore the real `resolve`, which is what this test
 * pins.
 *
 * @template T
 * @param {(service: import('@deepseek-ai/dsh-sandbox-policy').SandboxPolicyService) => T} run
 *   the case, given the mounted service.
 * @returns {Promise<Awaited<T> | undefined>} whatever the case returns, or
 *   `undefined` when the host or the service could not be mounted.
 */
const withResolvedPolicy = async (run) => {
    const host = await createHost();
    if (host === undefined || policyClass === undefined)
        return undefined;
    try {
        host.ctx.plugin({
            name: 'contract-stubs',
            /** @param {import('@deepseek-ai/cordis').Context} scope - the live child context. */
            apply(scope) {
                scope.provide?.('sessionProjections', { register: async () => ({ stateOf: () => undefined }) });
            },
        });
        await host.settle();
        host.ctx.plugin(policyClass, { mode: 'workspace-write', workspaceRoot: process.cwd() });
        await host.settle();
        const service = /** @type {import('@deepseek-ai/dsh-sandbox-policy').SandboxPolicyService | undefined} */ (host.ctx.get('sandboxPolicy'));
        if (service === undefined)
            return undefined;
        return await run(service);
    }
    finally {
        await host.disposeAll();
    }
};

/**
 * The policy owner src/service.js reads a session's workspace root through, and
 * the result fields it reads off the resolved policy.
 */
test('the stock sandbox policy still resolves the workspace root per session', {
    skip: sandboxPolicy === undefined ? 'the DSH sandbox policy package is not resolvable here' : false,
}, async () => {
    if (sandboxPolicy === undefined)
        return;
    // Captured because the narrowing above does not reach into the callbacks below.
    const policyPackage = sandboxPolicy;
    const proto = policyPackage.SandboxPolicyService.prototype;
    // The plugin hands the calling session to resolve() and reads
    // `workspaceRoot` off the answer, because that is the boundary the stock
    // sandbox:policy note names.
    assert.equal(typeof proto.resolve, 'function', 'resolve is the accessor the plugin reads');
    assert.equal(proto.resolve.constructor.name, 'Function', 'the plugin reads the result synchronously');
    assert.equal(typeof asPolicySeam(proto).sessionWorkspaceRoot, 'function', 'the per-session root the plugin depends on');
    // The stored Session is a full record; resolve() only reads its id and the
    // recorded cwd, which is exactly what the plugin hands it.
    const session = /** @type {import('@deepseek-ai/dsh-session').Session} */ (/** @type {unknown} */ ({ id: 'session-under-test', header: { cwd: process.cwd() } }));
    const resolved = await withResolvedPolicy((service) => service.resolve({ session }));
    assert.ok(resolved !== undefined, 'the real policy service mounts and answers');
    assert.equal(resolved.workspaceRoot, process.cwd(), 'the session cwd is the resolved workspace root');
    assert.equal(resolved.sessionId, 'session-under-test', 'the resolved policy names the session it was resolved for');
    assert.equal(typeof resolved.mode, 'string', 'the resolved mode the wrappers read');
    // The plugin treats a session without a cwd as having no root of its own and
    // falls back, so the fallback has to keep naming the configured root.
    const agentless = await withResolvedPolicy((service) => service.resolve({}));
    assert.ok(agentless !== undefined, 'the real policy service mounts for an agentless call');
    assert.equal(agentless.workspaceRoot, process.cwd(), 'an agentless call resolves to the configured root');
});
/**
 * The service src/service.js walks a delegation chain through.
 */
test('the stock session store still looks a live session up by id', {
    skip: sessionStore === undefined ? 'the DSH session package is not resolvable here' : false,
}, async () => {
    if (sessionStore === undefined)
        return;
    // The plugin reads a delegating session through `sessions.get(id)` when a
    // child inherits the parent's preset. An unknown id has to answer
    // `undefined` rather than throw, because a parent that already ended is a
    // normal case for a child that is still running.
    assert.equal(typeof sessionStore.SessionStore.prototype.get, 'function', 'get is the accessor the plugin reads');
    const store = new sessionStore.SessionStore(new Context());
    assert.equal(Object.hasOwn(store, 'get'), false, 'the seam is inherited, as the plugin assumes');
    assert.equal(store.get('session-that-does-not-exist'), undefined, 'an unknown id reads as no session');
});
/**
 * The prompt registry src/service.js places its own note through.
 */
test('the stock prompt registry still registers ordered context beside the policy note', {
    skip: systemPrompt === undefined ? 'the DSH system prompt package is not resolvable here' : false,
}, async () => {
    if (systemPrompt === undefined)
        return;
    const proto = systemPrompt.SystemPrompt.prototype;
    assert.equal(typeof proto.context, 'function', 'context is how the plugin contributes its note');
    assert.equal(typeof proto.getContextOrder, 'function', 'the placement the plugin anchors on');
    assert.equal(typeof proto.refreshContext, 'function', 'the per-request refresh the note survives');
    const prompt = new systemPrompt.SystemPrompt(new Context(), systemPrompt.SystemPrompt.Config({}));
    // The anchor the note is placed against, and the reason the plugin reads it
    // from the registry rather than hardcoding the number.
    assert.equal(prompt.getContextOrder('SANDBOX_POLICY'), 110, 'the stock policy note is placed at 110');
    // An unknown placement answers `undefined` rather than throwing. Adding one to
    // it yields NaN, which the registry itself refuses below — which is why the
    // plugin falls back instead of letting the registration disappear.
    assert.equal(prompt.getContextOrder(/** @type {import('@deepseek-ai/dsh-system-prompt').PromptContextOrderName} */ ('NOT_A_PLACEMENT')), undefined, 'an unknown placement reads as no order');
    assert.throws(() => prompt.context({ name: 'contract:nan', order: Number.NaN, text: () => '' }), /must be a finite number/, 'the registry refuses a non-finite order');
    // A registered provider is re-resolved per assembly and per refresh, which is
    // what lets the note follow a preset switch instead of freezing at startup.
    prompt.context({ name: 'contract:probe', order: 111, text: (context) => agentSessionId(context) });
    const assembly = await prompt.assemble(assemblyContext('session-a'));
    assert.deepEqual(assembly.contexts, [{ name: 'contract:probe', text: 'session-a' }], 'the provider text reaches the assembly');
    const refreshed = prompt.refreshContext(assembly, assemblyContext('session-b'));
    assert.deepEqual(refreshed.contexts, [{ name: 'contract:probe', text: 'session-b' }], 'a refresh re-reads the provider');
});

