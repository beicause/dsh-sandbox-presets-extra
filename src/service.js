/**
 * `ctx.sandboxPresets` — a registry of configured permission presets.
 *
 * Each entry of the `presets` config becomes one permission preset: a sandbox
 * mode, an approval policy, and a list of directories writable on top of
 * whatever that mode already allows. That covers both shapes the harness can
 * express — a `workspace-write` preset that adds directories beside the session
 * workspace, and a `read-only` preset that opens exactly the directories it
 * lists — and any number of each.
 *
 * The service is the single place that knows which directories a preset grants,
 * and whether the session making a call has that preset selected.
 *
 * It enforces them by wrapping the two live enforcement services in place — the
 * mounted filesystem's containment check (`./fs.js`) and the sandbox
 * provider's `confine` (`./provider.js`). Neither stock service is disabled,
 * replaced, or subclassed, so a failure to load this plugin leaves the harness
 * exactly as shipped instead of stripping it of its filesystem or sandbox.
 *
 * Enablement is per session and read from the permission service's projection
 * (the last recorded permission preset), so it survives restart by session-log
 * replay and never leaks between sessions.
 *
 * The service also publishes the presets themselves. The permission package
 * exposes no contribution API for a preset that is not a composition config
 * entry, and a config entry would be replaced wholesale by any profile that
 * restates `presets` (the shipped Web profile does), so the entries are added
 * to the live table and the client catalog is invalidated.
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyExtraDirsFence } from './fs.js'
import { applyExtraDirsConfine } from './provider.js'
import { isAbsolute } from 'node:path'
import { WORKSPACE_PREFIX, canonicalRootOf, detailOf, workspaceEntryPath } from './roots.js'
import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL,
  DEFAULT_SANDBOX,
  SANDBOX_MODES,
  exceptionClauseFor,
  expandPresetDirs,
  normalizePresets,
  presetSpecOf,
} from './presets.js'

/** @typedef {import('./contracts.js').PresetEntry} PresetEntry */
/** @typedef {import('./contracts.js').PresetSpec} PresetSpec */
/** @typedef {import('./contracts.js').SessionLike} SessionLike */
/** @typedef {import('./contracts.js').SessionHost} SessionHost */
/** @typedef {import('./contracts.js').ResolvedPolicy} ResolvedPolicy */
/** @typedef {import('./contracts.js').SandboxPolicyHost} SandboxPolicyHost */
/** @typedef {import('./contracts.js').PermissionKnobs} PermissionKnobs */
/** @typedef {import('./contracts.js').PermissionTableHost} PermissionTableHost */
/** @typedef {import('./contracts.js').PromptRegistry} PromptRegistry */
/** @typedef {{ entry: PresetEntry, inherited: boolean }} ResolvedPreset */
/** @typedef {import('./contracts.js').ReportableRejection} ReportableRejection */
/** @typedef {import('./contracts.js').SandboxPresetsConfig} SandboxPresetsConfig */

export const name = 'dsh-sandbox-presets-extra'

/** The one sandbox mode that never confines, so extra directories are moot. */
const UNCONFINED_MODE = 'danger-full-access'

/**
 * How many delegation hops a preset selection is inherited through.
 *
 * The harness bounds delegation depth itself, so this only stops a malformed
 * parent chain from looping; a chain longer than this inherits nothing.
 */
const MAX_DELEGATION_DEPTH = 8

/**
 * This plugin's own runtime-context entry, placed directly after the stock
 * sandbox policy note.
 *
 * It is a context of its own rather than an amendment of that note. The loop
 * re-resolves every context from its provider while preparing each request, so
 * a copy of another subsystem's entry that this plugin rewrote in the assembly
 * waterfall is replaced by the provider's own text before the snapshot reaches
 * the model: the note would be present in a direct `assemble()` and absent
 * from every real step. A provider of this plugin's own is re-resolved from the
 * live selection instead, so switching presets shows up in the next snapshot.
 */
const NOTE_CONTEXT = 'sandbox:preset-write-dirs'

/** The registry placement name of the stock sandbox policy note. */
const POLICY_PLACEMENT = 'SANDBOX_POLICY'

/**
 * Read a service by name from the composition context. `Context.get` is not
 * declared on the slice of the typings this package sees, so the call goes
 * through one checked cast here instead of at every use.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the composition context.
 * @param {string} serviceName - the service name to read.
 * @returns {unknown} the mounted service, or `undefined` when there is none.
 */
const serviceOf = (ctx, serviceName) =>
  /** @type {{ get?: (name: string) => unknown }} */ (ctx).get?.(serviceName)

/**
 * @param {unknown} value
 * @returns {value is PermissionTableHost}
 */
const isPermissionTableHost = (value) =>
  typeof value === 'object' && value !== null && typeof /** @type {PermissionTableHost} */ (value).presets === 'object'

/**
 * Whether a name in the permission table still holds the entry written for it,
 * rather than one a third party replaced since.
 *
 * Restoring a shadowed value blindly would roll back that replacement, so the
 * live entry is compared field by field with the one this plugin wrote.
 *
 * @param {Record<string, PresetSpec>} table - the live preset table.
 * @param {string} presetName - one name this plugin published.
 * @param {PresetSpec} written - the entry this plugin wrote.
 * @returns {boolean} true while the name still holds that entry.
 */
const stillHolds = (table, presetName, written) => {
  const current = table[presetName]
  if (typeof current !== 'object' || current === null) return false
  return current.sandbox === written.sandbox && current.approval === written.approval
}

/**
 * Whether a failure is the permission service saying it is not activated yet,
 * which is a state every session passes through rather than a fault.
 *
 * @param {unknown} error - the thrown value.
 * @returns {boolean} true when it only reports that the presets are not ready.
 */
const isNotReady = (error) =>
  /not ready/i.test(String(/** @type {{ message?: unknown } } */ (error)?.message ?? error))

/**
 * The workspace root one resolved policy carries. The enforcing services
 * receive the resolved policy, so its own root is preferred over re-resolving;
 * the session's cwd is the fallback for a partial policy.
 *
 * @param {ResolvedPolicy} policy - the resolved per-call policy.
 * @param {SessionLike | undefined} session - the session the call belongs to, when one was found.
 * @returns {string | undefined} the absolute workspace root, or `undefined` when neither carries one.
 */
const workspaceRootOf = (policy, session) => {
  const own = policy.workspaceRoot
  if (typeof own === 'string' && isAbsolute(own)) return own
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined
}

export class SandboxPresetsExtraService extends Service {
  static Config = z.object({
    /**
     * The permission presets to register, keyed by preset name. Each value
     * names the sandbox mode and approval policy the preset selects, plus the
     * directories it makes writable on top of that mode. Absolute paths; a
     * leading `~` is expanded. Volatile, so the Settings page edits the whole
     * table for this profile and changes apply live.
     */
    presets: z.dict(z.object({
      sandbox: z.union(SANDBOX_MODES).default(DEFAULT_SANDBOX),
      approval: z.union(APPROVAL_POLICIES).default(DEFAULT_APPROVAL),
      writableDirs: z.array(z.string()).default([]),
      /** Optional display label for clients that show one. */
      name: z.string(),
      /** Optional one-line description for clients that show one. */
      description: z.string(),
    })).default({}).volatile(),
  })

  /**
   * The validated plugin config this instance serves.
   *
   * @param {import('@deepseek-ai/cordis').Context} ctx - the composition context.
   * @param {SandboxPresetsConfig} config - the validated plugin config.
   */
  constructor(ctx, config) {
    super(ctx, 'sandboxPresets')
    /** The validated plugin config this instance serves. @type {SandboxPresetsConfig} */
    this.config = config
    /** Normalized configured presets, in configuration order. @type {PresetEntry[]} */
    this._presets = []
    /** Canonical directories per preset name. @type {Map<string, string[]>} */
    this._dirs = new Map()
    /** Workspace subpaths per preset name. @type {Map<string, string[]>} */
    this._workspace = new Map()
    /** Comparison key of the table the current snapshot came from. @type {string | undefined} */
    this._key = undefined
    /** Rejections already logged, so the warning is not repeated per refresh. @type {string | undefined} */
    this._reported = undefined
    /** Workspace subpaths already reported as unusable, so a per-call check warns once. @type {Set<string>} */
    this._reportedRoots = new Set()
    /** Permission-state failures already reported, so a broken owner warns once. @type {Set<unknown>} */
    this._reportedStates = new Set()
    /** Guards the one-time over-deep delegation chain warning. @type {boolean} */
    this._depthReported = false
    /** Guards the one-time unsupported-backend warning. @type {boolean} */
    this._unsupportedReported = false
    /** Enforcement services already reported as missing the expected seam. @type {Set<string>} */
    this._unrecognizedReported = new Set()
    /** Republish hook, installed once the permission service is available. @type {(() => void) | undefined} */
    this._publish = undefined
    /** The in-flight directory expansion, so callers can settle it. @type {Promise<void> | undefined} */
    this._pending = undefined
    this._refresh()
    this._publishPresets()
    this._publishContext()
    this._installEnforcement()
  }

  /**
   * The directories that apply to a call, from the policy the enforcing service
   * received. The policy carries a session id whenever a session made the call;
   * calls without one have no session and therefore selected no preset, so they
   * get none.
   *
   * @param {unknown} [policy] - the resolved per-call policy, or `undefined` for a default call.
   * @returns {readonly string[]} the canonical directories the call may additionally write.
   */
  extraRootsFor(policy = undefined) {
    const resolved = /** @type {ResolvedPolicy | undefined} */ (policy)
    if (resolved === undefined || resolved === null) return []
    if (resolved.mode === UNCONFINED_MODE) return []
    this._refresh()
    const sessionId = resolved.sessionId
    if (sessionId === undefined || sessionId === null) return []
    const session = /** @type {SessionLike | undefined} */ (
      /** @type {{ get?: (id: unknown) => unknown } | undefined} */ (serviceOf(this.ctx, 'sessions'))?.get?.(sessionId)
    )
    const entry = session === undefined ? undefined : this.presetFor(session)
    if (entry === undefined) return []
    return this.resolvedDirsFor(entry.name, workspaceRootOf(resolved, session))
  }

  /**
   * Wrap the live enforcement services in place. Both wrappers are additive:
   * the stock method stays authoritative, and each returns a disposer that
   * restores it exactly when this plugin unloads.
   *
   * A service that is not mounted yet is wrapped when it appears, so this does
   * not depend on composition order. A service whose seam is not where this
   * plugin expects it is reported rather than passed over in silence, so a
   * harness upgrade that moves the seam is visible.
   */
  _installEnforcement() {
    for (const serviceName of /** @type {const} */ (['fs', 'sandbox'])) {
      this.ctx.inject([serviceName], (scope) => {
        const service = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (scope))[serviceName]
        scope.effect(() => {
          /** @param {string} message */
          const report = (message) => this._warn(message)
          const disposer = serviceName === 'fs'
            ? applyExtraDirsFence(service, (policy) => this.extraRootsFor(policy), report)
            : applyExtraDirsConfine(service, {
              extraRootsFor: (policy) => this.extraRootsFor(policy),
              reportUnsupported: (runner) => this._reportUnsupported(runner),
            }, report)
          if (disposer === undefined) {
            this._reportUnrecognized(serviceName)
            return () => {}
          }
          return disposer
        })
      })
    }
  }

  /**
   * Report once that a mounted enforcement service does not expose the seam
   * this plugin extends, so an upgraded harness that moved it is visible
   * instead of leaving the presets quietly narrower than they claim.
   * @param {string} serviceName - the service that could not be wrapped.
   */
  _reportUnrecognized(serviceName) {
    const key = `unrecognized:${serviceName}`
    if (this._unrecognizedReported.has(key)) return
    this._unrecognizedReported.add(key)
    this._warn(
      `the mounted "${serviceName}" service does not expose the interface this plugin extends, `
      + 'so the configured writable directories are not enforced through it; this usually means the '
      + 'installed dsh version moved that interface, and this plugin needs updating for it',
    )
  }

  /**
   * Report once that the selected backend cannot honor the configured
   * directories, so the gap is visible instead of silently narrowing a preset.
   * @param {string} runner - the runner program the stock provider selected.
   */
  _reportUnsupported(runner) {
    if (this._unsupportedReported) return
    this._unsupportedReported = true
    this._warn(
      `the "${runner}" sandbox backend cannot extend its write allow-list from this plugin, `
      + 'so the configured writable directories are not applied to confined commands on this backend '
      + '(prefer bwrap, or use a danger-full-access preset for those commands)',
    )
  }

  /**
   * The configured presets, normalized and in configuration order. The field is
   * volatile, so it is read through its reference; a plain table (an
   * unvalidated config in a unit test) is accepted too.
   * @returns {readonly PresetEntry[]} the current entries.
   */
  presets() {
    this._refresh()
    return this._presets
  }

  /** The configured preset names, in the order the picker offers them. */
  get presetNames() {
    this._refresh()
    return this._presets.map((entry) => entry.name)
  }

  /**
   * The configured preset that applies to a session, if any: the one it
   * recorded itself, or the one it inherited when it was delegated.
   *
   * The selection belongs to the permission service, which folds it into a
   * projection and reads it back for its own `current`; `permissionState` is
   * that read. Reading the session projection directly instead is deprecated
   * and logs a warning per key, so this goes through the owner.
   *
   * @param {unknown} [session] - the calling session, or `undefined` for agentless calls.
   * @returns {PresetEntry | undefined} the applicable configured preset, or `undefined`.
   */
  presetFor(session = undefined) {
    this._refresh()
    return this._selectionFor(session)?.entry
  }

  /**
   * The preset that applies to a session, and whether it was inherited.
   *
   * @param {unknown} [session] - the calling session, or `undefined` for agentless calls.
   * @returns {ResolvedPreset | undefined} the entry and its provenance, or `undefined`.
   */
  _selectionFor(session = undefined) {
    if (session === undefined || session === null) return undefined
    const own = this._recordedEntryFor(session)
    if (own !== undefined) return { entry: own, inherited: false }
    const inherited = this._inheritedEntryFor(session)
    return inherited === undefined ? undefined : { entry: inherited, inherited: true }
  }

  /**
   * The configured preset one session recorded for itself, ignoring any
   * inherited one.
   *
   * @param {unknown} session - the session to read the selection of.
   * @returns {PresetEntry | undefined} the recorded configured preset, or `undefined`.
   */
  _recordedEntryFor(session) {
    const selected = this._permissionStateOf(session)?.preset
    if (typeof selected !== 'string') return undefined
    return this._presets.find((entry) => entry.name === selected)
  }

  /**
   * The configured preset a delegated session inherits from the session that
   * delegated it.
   *
   * The harness hands a delegated session only the `auto` and
   * `danger-full-access` identities as a `permission/preset` event; every other
   * preset reaches a child as a bare `sandbox/mode` plus a `never` approval
   * policy, so the child's own log names no preset at all and its directories
   * would otherwise be empty in both the prompt and the fence. The child's
   * recorded sandbox mode is the part that did come through, so it is required
   * to match the preset's own mode: a caller that pinned a different mode on the
   * delegation did not grant that preset's directories, and then nothing is
   * inherited.
   *
   * A parent that recorded no preset of its own is itself a delegated session,
   * so the chain is followed up to {@link MAX_DELEGATION_DEPTH} hops.
   *
   * @param {unknown} session - the delegated session looking for a preset.
   * @returns {PresetEntry | undefined} the inherited configured preset, or `undefined`.
   */
  _inheritedEntryFor(session) {
    const knobs = this._permissionStateOf(session)
    // A session that recorded a selection keeps it, and a session whose knobs
    // cannot be read yet has no delegation evidence either.
    if (knobs === undefined || knobs.preset != null) return undefined
    const mode = knobs.sandbox
    if (typeof mode !== 'string') return undefined
    const sessions = /** @type {SessionHost | undefined} */ (serviceOf(this.ctx, 'sessions'))
    let current = /** @type {SessionLike | undefined} */ (session)
    for (let hop = 0; hop < MAX_DELEGATION_DEPTH; hop += 1) {
      const parentId = current?.header?.parentSession
      if (typeof parentId !== 'string') return undefined
      const parent = /** @type {SessionLike | undefined} */ (sessions?.get?.(parentId))
      if (parent === undefined || parent === null) return undefined
      const entry = this._recordedEntryFor(parent)
      // The mode the delegated session runs under is inherited from the same
      // session, so a mismatch means the delegation pinned something else.
      if (entry !== undefined) return entry.sandbox === mode ? entry : undefined
      const parentKnobs = this._permissionStateOf(parent)
      if (parentKnobs === undefined || parentKnobs.preset != null) return undefined
      current = parent
    }
    // A chain this long is not a delegation tree the harness would build, so the
    // remaining hops are dropped rather than followed further; saying so once
    // turns a silently narrower grant into something visible in the log.
    if (!this._depthReported) {
      this._depthReported = true
      this._warn(`stopped following a delegation chain after ${MAX_DELEGATION_DEPTH} hops`)
    }
    return undefined
  }

  /**
   * The knobs a session currently has, read from the service that owns them.
   *
   * `permissionState` throws while that service is still activating, which is a
   * state every session passes through, not a fault: until it settles the
   * session has selected nothing either. Any other failure would silently
   * narrow every grant this plugin makes, so it is reported once instead of
   * being folded into the same `undefined`.
   *
   * @param {unknown} session - the session to read the selection of.
   * @returns {PermissionKnobs | undefined} the folded knobs, or `undefined` when none can be read.
   */
  _permissionStateOf(session) {
    const host = /** @type {PermissionTableHost | undefined} */ (serviceOf(this.ctx, 'permissionPresets'))
    try {
      return host?.permissionState?.(session)
    } catch (error) {
      if (!isNotReady(error) && !this._reportedStates.has(error)) {
        this._reportedStates.add(error)
        this._warn(`reading the permission preset of a session failed: ${detailOf(error)}`)
      }
      return undefined
    }
  }

  /**
   * The canonical directories one configured preset grants.
   *
   * @param {string} presetName - one configured preset name.
   * @returns {readonly string[]} the canonical directories of that preset.
   */
  dirsForPreset(presetName) {
    return this._dirs.get(presetName) ?? []
  }

  /**
   * Every directory one configured preset grants, with its workspace-relative
   * entries resolved against a workspace root.
   *
   * A workspace subpath is joined onto the root the caller supplies, which is
   * the root the harness folded for that session — so a preset granting
   * `workspace:notes/` means the same thing for every session, wherever its
   * workspace is, instead of being pinned to whatever the process default was
   * when the plugin loaded.
   *
   * The join alone is not a grant. The workspace is a directory the session can
   * write to, so a subpath below it may be anything the session made it: one
   * that is missing would make bwrap reject the whole confined command, and one
   * that is a symlink points wherever it likes — including outside the
   * workspace, which would widen the preset past the boundary it names. Each
   * candidate is therefore resolved and required to still be a directory inside
   * the workspace; one that is not is left out and reported once, so the note in
   * the prompt lists exactly the directories the fence will grant.
   *
   * The check is synchronous and re-runs per call rather than being folded into
   * the loaded snapshot, because a workspace differs per session and because the
   * prompt contribution that lists these directories is synchronous too: the two
   * must agree call for call.
   *
   * @param {string} presetName - one configured preset name.
   * @param {string | undefined} workspaceRoot - the workspace root of the calling session.
   * @returns {readonly string[]} the canonical directories plus the resolved workspace entries.
   */
  resolvedDirsFor(presetName, workspaceRoot) {
    const fixed = this.dirsForPreset(presetName)
    const subpaths = this._workspace.get(presetName) ?? []
    if (subpaths.length === 0 || workspaceRoot === undefined) return fixed
    /** @type {string[]} */
    const resolved = []
    for (const subpath of subpaths) {
      const root = canonicalRootOf(workspaceEntryPath(subpath, workspaceRoot), workspaceRoot)
      if (root.path === undefined) {
        this._reportRoot(presetName, WORKSPACE_PREFIX + subpath, root.reason)
        continue
      }
      if (fixed.includes(root.path) || resolved.includes(root.path)) continue
      resolved.push(root.path)
    }
    return [...fixed, ...resolved]
  }

  /**
   * Report once that one `workspace:` entry names nothing this session may
   * write, so a typo or a symlink planted in the workspace does not silently
   * narrow the preset on every call.
   *
   * @param {string} presetName - the preset the entry belongs to.
   * @param {string} entry - the configured entry as written.
   * @param {string} reason - why it is not granted.
   */
  _reportRoot(presetName, entry, reason) {
    const key = `${presetName}\u0000${entry}\u0000${reason}`
    if (this._reportedRoots.has(key)) return
    this._reportedRoots.add(key)
    this._warn(
      `not granting ${JSON.stringify(entry)} of preset ${JSON.stringify(presetName)} for this session: ${reason}`,
    )
  }

  /**
   * The canonical directories that apply to one call: the selected preset's
   * directories while a configured preset is selected, otherwise none.
   *
   * @param {unknown} [session] - the calling session, or `undefined` for agentless calls.
   * @returns {readonly string[]} the canonical directories the call may additionally write.
   */
  rootsFor(session = undefined) {
    this._refresh()
    const entry = this.presetFor(session)
    if (entry === undefined) return []
    return this.resolvedDirsFor(entry.name, this.workspaceRootFor(/** @type {SessionLike | undefined} */ (session)))
  }

  /**
   * The workspace root a session writes within, as the harness folds it.
   *
   * Read through the sandbox policy service so this plugin's boundary is the
   * same one the stock `sandbox:policy` note names; a session's own `cwd` is
   * the direct fallback when that service is unavailable.
   *
   * @param {SessionLike | undefined} session - the calling session, or `undefined` for agentless calls.
   * @returns {string | undefined} the absolute workspace root, or `undefined` when none can be found.
   */
  workspaceRootFor(session) {
    if (session === undefined || session === null) return undefined
    const policy = /** @type {SandboxPolicyHost | undefined} */ (serviceOf(this.ctx, 'sandboxPolicy'))
    const resolved = policy?.resolve?.({ session })?.workspaceRoot
    if (typeof resolved === 'string' && isAbsolute(resolved)) return resolved
    const own = session.header?.cwd
    return typeof own === 'string' && isAbsolute(own) ? own : undefined
  }

  /**
   * The canonical directories that apply to a call, identified by the session
   * id a resolved policy carries. Calls without one have no session and
   * therefore selected no preset, so they get none.
   *
   * @param {unknown} [sessionId] - the session id from the resolved policy.
   * @returns {readonly string[]} the canonical directories the call may additionally write.
   */
  rootsForSessionId(sessionId = undefined) {
    this._refresh()
    if (sessionId === undefined || sessionId === null) return []
    const session = /** @type {{ get?: (id: unknown) => unknown } | undefined} */ (
      serviceOf(this.ctx, 'sessions')
    )?.get?.(sessionId)
    return session === undefined ? [] : this.rootsFor(session)
  }

  /**
   * Re-read and re-expand the configured table when it changed. Expansion is
   * asynchronous (it resolves symlinks), so the previous snapshot keeps serving
   * callers until the refresh settles; a directory therefore becomes writable
   * only after its own successful expansion, never before.
   *
   * @returns {Promise<void> | undefined} the in-flight expansion, if any.
   */
  _refresh() {
    const { entries, rejected } = normalizePresets(this.config.presets)
    const key = JSON.stringify(entries)
    if (key === this._key) return this._pending
    this._key = key
    this._presets = entries
    this._publish?.()
    this._pending = expandPresetDirs(entries).then(({ roots, workspaceRoots, unusable }) => {
      // A newer configuration may have arrived while this expansion ran.
      if (this._key !== key) return
      this._dirs = roots
      this._workspace = workspaceRoots
      this._report([...rejected, ...unusable])
    }, (error) => {
      this._warn(`expanding the configured writable directories failed: ${detailOf(error)}`)
    })
    return this._pending
  }

  /**
   * Settle the current expansion. Callers that need the configured directories
   * to be in force already (tests) await this; the enforcement path deliberately
   * does not, it serves the last settled snapshot.
   * @returns {Promise<void>} a promise resolved once the current expansion has settled.
   */
  async ready() {
    await this._refresh()
  }

  /**
   * Hold activation until the first expansion settles, so the snapshot the
   * enforcement services read during activation already names the directories.
   *
   * The constructor only starts the expansion; cordis awaits whatever this hook
   * returns before it publishes the fibre, so a call made while the plugin is
   * activating waits here instead of being served an empty directory list.
   *
   * @returns {Promise<void>} a promise resolved once activation may proceed.
   */
  [Service.init]() {
    return this.ready()
  }

  /** @param {readonly ReportableRejection[]} rejected */
  _report(rejected) {
    if (rejected.length === 0) {
      this._reported = undefined
      return
    }
    const summary = rejected
      .map(({ name, entry, reason }) => `${JSON.stringify(name)}: ${JSON.stringify(entry)} (${reason})`)
      .join(', ')
    if (summary === this._reported) return
    this._reported = summary
    this._warn(`ignoring unusable configured presets: ${summary}`)
  }

  /** @param {string} message */
  _warn(message) {
    try {
      /** @type {{ logger?: { warn?: (message: string) => void } }} */ (/** @type {unknown} */ (this.ctx)).logger?.warn?.(`sandbox-presets-extra: ${message}`)
    } catch {
      // A logger failure must never affect enforcement.
    }
  }

  /**
   * Publish every configured preset in the permission service table and
   * invalidate the client catalog, so the picker offers them and
   * `/permission <name>` accepts them. Runs once the permission service is
   * available; without it no configured preset can be selected and this
   * plugin's enforcement never engages.
   *
   * A name that is already in the table (the shipped profile declares one of
   * them so its `defaultPreset` resolves without this plugin) is shadowed while
   * this plugin is loaded and restored exactly when it unloads.
   */
  _publishPresets() {
    this.ctx.inject(['permissionPresets'], (scope) => {
      const permissions = /** @type {{ permissionPresets?: unknown }} */ (scope).permissionPresets
      scope.effect(() => {
        /** Names this plugin wrote, mapped to what it wrote and what that replaced. */
        /** @type {Map<string, { written: PresetSpec, previous: PresetSpec | undefined }>} */
        const applied = new Map()

        const sync = () => {
          if (!isPermissionTableHost(permissions)) {
            this._warn('the permission service does not expose its preset table; the configured presets stay unpublished')
            return
          }
          const table = permissions.presets
          const wanted = new Map(this._presets.map((entry) => [entry.name, presetSpecOf(entry)]))
          for (const [presetName, { written, previous }] of applied) {
            if (wanted.has(presetName)) continue
            if (!stillHolds(table, presetName, written)) {
              applied.delete(presetName)
              continue
            }
            if (previous === undefined) delete table[presetName]
            else table[presetName] = previous
            applied.delete(presetName)
          }
          for (const [presetName, spec] of wanted) {
            if (!applied.has(presetName)) applied.set(presetName, { written: spec, previous: table[presetName] })
            table[presetName] = spec
          }
          permissions.emitCatalogChanged?.()
        }

        this._publish = sync
        sync()
        return () => {
          this._publish = undefined
          if (!isPermissionTableHost(permissions)) return
          const table = permissions.presets
          for (const [presetName, { written, previous }] of applied) {
            // The name may have been rewritten by someone else since; putting the
            // replaced value back would undo their change rather than this plugin's.
            if (!stillHolds(table, presetName, written)) continue
            if (previous === undefined) delete table[presetName]
            else table[presetName] = previous
          }
          permissions.emitCatalogChanged?.()
        }
      })
    })
  }

  /**
   * Register this plugin's own runtime-context entry, naming the directories
   * the session's selected preset adds.
   *
   * The entry is rendered from the live selection on every assembly, so it
   * follows a preset switch and survives the per-request context refresh that
   * an amended copy of the stock note would not. It renders to an empty string
   * unless a configured, confined preset is selected with at least one usable
   * directory, and empty contexts are dropped from the snapshot, so no note
   * appears where this plugin grants nothing.
   */
  _publishContext() {
    this.ctx.inject(['systemPrompt'], (scope) => {
      const registry = /** @type {{ systemPrompt?: PromptRegistry }} */ (scope).systemPrompt
      if (typeof registry?.context !== 'function') return
      try {
        registry.context({
          name: NOTE_CONTEXT,
          order: this._noteOrder(registry),
          text: (context) => {
            try {
              return this.noteFor(context?.agent?.session)
            } catch (error) {
              // A throwing provider would fail the whole prompt assembly, which
              // is worse than a step rendered without this note.
              this._warn(`rendering the preset note failed: ${detailOf(error)}`)
              return ''
            }
          },
        })
      } catch (error) {
        this._warn(`registering the preset note failed: ${detailOf(error)}`)
      }
    })
  }

  /**
   * The order this plugin's context is registered at: directly after the stock
   * note, which states the boundary the exception is read against.
   *
   * Both numbers come from the registry so a harness that moves the note keeps
   * this entry beside it. A registry that no longer answers for that placement
   * would hand back `undefined`, and adding to it yields `NaN`, which makes the
   * registration itself throw; the entry is then placed at the end instead of
   * disappearing from every prompt.
   *
   * @param {PromptRegistry} registry - the prompt registry service.
   * @returns {number} the finite registration order to use.
   */
  _noteOrder(registry) {
    const placement = registry.getContextOrder?.(POLICY_PLACEMENT)
    if (Number.isFinite(placement)) return /** @type {number} */ (placement) + 1
    this._warn(
      `the prompt registry no longer places ${JSON.stringify(POLICY_PLACEMENT)}, so the preset note goes last instead of beside it`,
    )
    return Number.MAX_SAFE_INTEGER
  }

  /**
   * The model-facing note for one session, or an empty string when it grants
   * nothing beyond what the stock policy note already describes.
   *
   * The stock note is rendered from the sandbox mode alone and reads as a closed
   * boundary in both confined modes, so a plain statement that the plugin
   * "additionally" grants directories is easily read as subordinate to it — the
   * model then treats the session as read-only. This note is therefore an
   * explicit behavioural instruction: it names its own precedence over the stock
   * note, denies the read-only reading outright, lists the directories one per
   * line so a path can be matched against them, and tells the model to attempt
   * the write normally instead of deferring to the policy wording. It mirrors
   * the stock read-only note's own "do not refuse from this policy alone"
   * fallback, which the plugin's earlier declarative sentence lacked.
   *
   * The preset name and the "only while that preset remains selected" expiry are
   * kept deliberately: runtime-context snapshots are appended rather than
   * replaced by the agent loop, so an older snapshot must carry its own
   * invalidation. An explicit rule naming a later snapshot with a different
   * preset as authoritative resolves the case where two snapshots disagree.
   * `danger-full-access` never confines, so it is excluded and no note is
   * contributed.
   *
   * @param {unknown} [session] - the calling session, or `undefined` for agentless calls.
   * @returns {string} the note, or an empty string when no directory applies.
   */
  noteFor(session = undefined) {
    this._refresh()
    const selection = this._selectionFor(session)
    if (selection === undefined || selection.entry.sandbox === UNCONFINED_MODE) return ''
    const entry = selection.entry
    // Workspace entries are named by the real path they resolve to for this
    // session, so the model is told where the directories actually are.
    const roots = this.resolvedDirsFor(entry.name, this.workspaceRootFor(/** @type {SessionLike | undefined} */ (session)))
    if (roots.length === 0) return ''
    // A delegated session never records the preset it inherited: the harness
    // hands a child a bare mode instead of a preset name. Naming a preset that
    // this session's own runtime context does not contain is exactly the claim
    // the note tells the model to trust only while a snapshot names it, so the
    // inherited case says where the grant came from instead.
    const opening = selection.inherited
      ? ` This session was delegated from one running the "${entry.name}" preset, so that preset's grant applies here too: it is NOT read-only for those directories:`
      : ` While the "${entry.name}" preset is selected, this session is NOT read-only for those directories:`
    // The inherited selection is re-read from the delegating session on every
    // call, so it is not frozen at delegation. It does end when that session
    // selects a preset with another sandbox mode: this session was confined
    // under the mode the delegation pinned, and a grant whose mode no longer
    // matches what confines it would describe a boundary the fence refuses.
    const standing = selection.inherited
      ? ` The grant is re-read from that session on every call: while it keeps a preset whose sandbox mode matches the one this session was delegated with, the directories above follow it; a preset with a different mode ends the grant.`
      : ` They apply only while that preset remains selected.`
    // Both cases end with the same two rules: a later selection in this session
    // replaces the grant, and a later snapshot naming a different preset wins
    // over this one. Snapshots are appended rather than replaced, so an older
    // snapshot has to carry its own invalidation.
    return `IMPORTANT — this overrides the "Current DSH file policy" note above for the directories listed below.`
      + opening
      + ` writes to them are allowed${exceptionClauseFor(entry.sandbox)}.`
      + ` The ${name} plugin grants exactly these directories:`
      + '\n' + roots.map((root) => `- "${root}"`).join('\n')
      + `\nA path is writable when it is one of these directories or lies under one of them, even if the stock policy note appears to forbid it.`
      + ` Do not refuse, skip, defer, or request an approval/escalation for a write to such a path because the policy sounds read-only:`
      + ` call the write/edit/bash tool normally and follow any denial and escalation guidance it returns.`
      + ` Only an actual denial returned by the tool means the path is blocked.`
      + standing
      + ` Selecting another preset in this session replaces the grant above.`
      + ` If a later runtime-context snapshot names a different preset, the latest snapshot is authoritative.`
  }
}

export default SandboxPresetsExtraService
