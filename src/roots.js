/**
 * Pure filesystem helpers for the configured writable directories: expanding
 * them to canonical paths and deciding whether a path lies inside one.
 *
 * Kept free of Cordis and DSH imports so it can be unit-tested directly.
 */

import { realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/** @typedef {import('./contracts.js').RejectedEntry} RejectedEntry */
/** @typedef {import('./contracts.js').ExpandedDirs} ExpandedDirs */

/**
 * Prefix marking a configured directory as relative to the session workspace.
 *
 * The workspace is a per-session boundary, not a process-wide constant, so an
 * entry that names one cannot be turned into a real path while the plugin
 * loads. It is kept as a subpath and resolved against the workspace root the
 * enforcement layer reports for each call, which is the same boundary the stock
 * policy folds. The workspace belongs to the session, which the plugin does not
 * know while it loads, so an entry naming one cannot become a real path until a
 * call supplies that session's root.
 *
 * @type {'workspace:'}
 */
export const WORKSPACE_PREFIX = 'workspace:'

/** @type {ReadonlySet<unknown>} */
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR'])

/** Read `error.code` without asserting the caught value's shape. */
/** @param {unknown} error */
const codeOf = (error) =>
  typeof error === 'object' && error !== null ? /** @type {{ code?: unknown }} */ (error).code : undefined

/** @param {unknown} error */
const isMissing = (/** @type {unknown} */ error) => MISSING_CODES.has(codeOf(error))

/**
 * Render `String(error?.message ?? error)` for an unknown caught value.
 *
 * @param {unknown} error
 */
const detailOf = (error) => {
  const message = typeof error === 'object' && error !== null
    ? /** @type {{ message?: unknown }} */ (error).message
    : undefined
  return message === undefined || message === null ? String(error) : String(message)
}

/**
 * Resolve a configured entry to an absolute path, expanding a leading `~`.
 *
 * @param {unknown} entry - one raw configured directory entry.
 * @returns {string | undefined} the absolute path, or `undefined` when the
 *   entry is not one (a relative path, a non-string, or blank).
 */
export function absoluteEntry(entry) {
  if (typeof entry !== 'string') return undefined
  const trimmed = entry.trim()
  if (trimmed === '') return undefined
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : undefined
}

/**
 * Read one configured entry as a workspace subpath.
 *
 * A workspace-relative entry is kept as a subpath: it can only be resolved
 * against the workspace root of the session making a call, which the loader
 * cannot know. The result distinguishes the cases the caller must treat
 * differently — an entry that is not workspace-relative at all, a usable
 * subpath, and a prefixed entry that cannot name a subpath — so a mistake such
 * as `workspace:/etc` is reported as that mistake rather than as a missing
 * leading slash.
 *
 * @param {string} entry - one raw configured directory entry.
 * @returns {{ kind: 'none' } | { kind: 'subpath'; subpath: string } | { kind: 'invalid'; reason: string }}
 *   `kind: 'none'` for an unprefixed entry, `'subpath'` with the normalized
 *   subpath, or `'invalid'` with the reason it cannot be used.
 */
function readWorkspaceEntry(entry) {
  if (!entry.startsWith(WORKSPACE_PREFIX)) return { kind: 'none' }
  const rest = entry.slice(WORKSPACE_PREFIX.length).trim()
  if (rest === '' || rest === '.' || rest === './') return { kind: 'subpath', subpath: '' }
  if (isAbsolute(rest)) {
    return { kind: 'invalid', reason: 'a workspace path must be relative to the workspace' }
  }
  if (rest === '~' || rest.startsWith('~/')) {
    return {
      kind: 'invalid',
      reason: 'a workspace path must be relative to the workspace (a leading ~ does not apply)',
    }
  }
  if (rest.split('/').includes('..')) {
    return { kind: 'invalid', reason: 'a workspace path may not contain ".."' }
  }
  return { kind: 'subpath', subpath: join(rest) }
}

/**
 * Resolve the configured extra directories to the canonical paths the
 * enforcement layers actually compare. Symlinks are resolved because bwrap
 * binds and the fs fence's containment check both match real paths.
 *
 * An entry prefixed with `workspace:` cannot be resolved here: it names a
 * subpath of the session workspace, which differs per session. It is reported
 * as a workspace subpath instead, for the enforcement layer to resolve against
 * the workspace root of the session making the call.
 *
 * A missing or non-directory entry is reported instead of being invented:
 * granting a path the caller never named would be the unsafe direction. The
 * same applies to a `..` inside a workspace subpath, which is refused rather
 * than silently clamped.
 *
 * @param {unknown} entries - raw configured directory entries.
 * @returns {Promise<ExpandedDirs>} the usable canonical directories, the
 *   workspace subpaths, and the rejected entries.
 */
export async function expandExtraDirs(entries) {
  /** @type {string[]} */
  const dirs = []
  /** @type {string[]} */
  const workspaceDirs = []
  /** @type {RejectedEntry[]} */
  const rejected = []
  /** @type {Set<string>} */
  const seen = new Set()

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      rejected.push({ entry, reason: 'blank entry' })
      continue
    }
    const workspace = readWorkspaceEntry(entry.trim())
    if (workspace.kind === 'invalid') {
      rejected.push({ entry, reason: workspace.reason })
      continue
    }
    if (workspace.kind === 'subpath') {
      // Dedupe on the resolved subpath, so two spellings of one directory
      // (`workspace:notes` and `workspace:./notes`) are not both bound.
      const key = WORKSPACE_PREFIX + workspace.subpath
      if (seen.has(key)) continue
      seen.add(key)
      workspaceDirs.push(workspace.subpath)
      continue
    }
    const absolute = absoluteEntry(entry)
    if (absolute === undefined) {
      rejected.push({ entry, reason: 'not an absolute path (a leading ~ is allowed)' })
      continue
    }
    let canonical
    try {
      canonical = await realpath(absolute)
    } catch (error) {
      rejected.push({ entry, reason: isMissing(error) ? 'does not exist' : detailOf(error) })
      continue
    }
    let info
    try {
      info = await stat(canonical)
    } catch (error) {
      rejected.push({ entry, reason: detailOf(error) })
      continue
    }
    if (!info.isDirectory()) {
      rejected.push({ entry, reason: 'not a directory' })
      continue
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)
    dirs.push(canonical)
  }

  return { dirs, workspaceDirs, rejected }
}

/**
 * Join one workspace subpath onto the workspace root of a session.
 *
 * The join is lexical on purpose: the root is already absolute and canonical,
 * and the subpath was normalized when the configuration was read. The result is
 * a candidate only — it must still be checked against the filesystem before it
 * is granted, because a subpath that is missing or that resolves outside the
 * workspace would either break the whole confined command (bwrap fails on a
 * bind whose source is absent) or widen the grant past the workspace.
 *
 * @param {string} subpath - the subpath recorded for a `workspace:` entry, possibly empty.
 * @param {string} workspaceRoot - the session's absolute workspace root.
 * @returns {string} the absolute path the subpath names.
 */
export function workspaceEntryPath(subpath, workspaceRoot) {
  return subpath === '' ? workspaceRoot : join(workspaceRoot, subpath)
}

/** @param {string} path */
const comparable = (path) =>
  process.platform === 'win32' ? path.toLowerCase() : path

/**
 * Whether one canonical path is the other or lies beneath it, by spelling only.
 *
 * @param {string} path - a canonical path.
 * @param {string} base - a canonical base path.
 * @returns {boolean} whether `path` is `base` or a descendant of it.
 */
const isLexicallyWithin = (path, base) => {
  const target = comparable(path)
  const root = comparable(base)
  if (target === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return target.startsWith(prefix)
}

/**
 * @typedef {{ path: string, reason?: undefined } | { path?: undefined, reason: string }} CanonicalRoot
 */

/**
 * Check that one candidate directory is a directory that really exists, and
 * that it still belongs to the workspace it was derived from.
 *
 * A workspace subpath is joined onto a workspace root lexically, so the result
 * may be a symlink that points anywhere the session can read — including out of
 * the workspace entirely. Granting that would widen the preset past the
 * boundary it describes, so the candidate is resolved through the filesystem
 * first and the answer is the resolved path; a resolved path that is no longer
 * inside `within` is refused rather than clamped.
 *
 * This is synchronous on purpose. The note that tells the model which
 * directories are writable is a synchronous prompt contribution, and the whole
 * point of the check is that the note and the fence agree on the same list, so
 * both must run the same check without a promise in between.
 *
 * @param {string} candidate - the absolute path the configuration names.
 * @param {string} [within] - the workspace root the candidate must stay inside.
 * @returns {CanonicalRoot} the resolved directory, or the reason it is not granted.
 */
export function canonicalRootOf(candidate, within = undefined) {
  let canonical
  try {
    canonical = realpathSync(candidate)
  } catch (error) {
    return { reason: isMissing(error) ? 'does not exist' : detailOf(error) }
  }
  let info
  try {
    info = statSync(canonical)
  } catch (error) {
    return { reason: detailOf(error) }
  }
  if (!info.isDirectory()) return { reason: 'not a directory' }
  if (within === undefined) return { path: canonical }

  let base
  try {
    base = realpathSync(within)
  } catch (error) {
    return {
      reason: isMissing(error)
        ? `the session workspace ${JSON.stringify(within)} does not exist`
        : detailOf(error),
    }
  }
  if (!isLexicallyWithin(canonical, base)) {
    return { reason: `it resolves to ${JSON.stringify(canonical)}, outside the session workspace ${JSON.stringify(base)}` }
  }
  return { path: canonical }
}

/**
 * Keep only the roots that are still the directory they were checked as.
 *
 * The directories are resolved once, when the configuration is read, but a
 * confined command is built much later: a granted directory may be removed, or
 * replaced by a symlink, in between. A bind whose source is gone makes bwrap
 * fail outright, which would take the whole command down with it, so the list
 * is re-checked immediately before it is handed to the profile.
 *
 * @param {readonly string[]} roots - canonical directories.
 * @returns {readonly string[]} the entries that are still directories at their own path.
 */
export function existingDirectories(roots) {
  return roots.filter((root) => canonicalRootOf(root).path === root)
}

/** @param {string} path */
async function statIfPresent(path) {
  try {
    return await stat(path, { bigint: true })
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * @param {import('node:fs').BigIntStats} left
 * @param {import('node:fs').BigIntStats} right
 */
const sameIdentity = (left, right) =>
  left.dev === right.dev && left.ino === right.ino

/**
 * Whether `path` is `root` or lies beneath it. The lexical comparison handles
 * normal canonical spellings; when the spellings differ, walking the target's
 * existing ancestors and comparing filesystem identity recognizes aliases such
 * as bind mounts and symlinked prefixes.
 *
 * @param {string} path - canonical target path, which may end in a missing suffix.
 * @param {string} root - canonical writable root.
 * @returns {Promise<boolean>} whether the target is the root or a descendant of it.
 */
export async function isPathUnder(path, root) {
  const target = comparable(path)
  const base = comparable(root)
  if (target === base) return true
  const prefix = base.endsWith(sep) ? base : base + sep
  if (target.startsWith(prefix)) return true

  const rootInfo = await statIfPresent(root)
  if (rootInfo === undefined) return false
  let ancestor = path
  for (;;) {
    const info = await statIfPresent(ancestor)
    if (info !== undefined && sameIdentity(info, rootInfo)) return true
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
}

/**
 * Whether any configured root contains `path`.
 *
 * @param {string} path - canonical target path.
 * @param {unknown} roots - the configured roots, an array of entries.
 * @returns {Promise<boolean>}
 */
export async function isUnderAny(path, roots) {
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string') continue
    if (await isPathUnder(path, root)) return true
  }
  return false
}

export { resolve }
