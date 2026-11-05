/**
 * A view of the sandbox backend that exposes its private fence seam.
 *
 * `checkedTarget` is the member this plugin wraps, and the published typings
 * declare it private, so a contract test cannot read it through the class
 * type. Everything else — `resolve`, `readText`, `writeText` — is public and
 * comes straight from the package, so this adds that one member and nothing
 * else.
 *
 * The base is `Omit`ted rather than intersected: intersecting a class with a
 * redeclared private member reduces the whole type to `never`.
 */

/**
 * @typedef {Omit<import('@deepseek-ai/dsh-fs-sandbox').SandboxedFileSystem, 'checkedTarget'> & {
 *   checkedTarget(target: import('@deepseek-ai/dsh-fs').FsTarget, sandboxPolicy?: unknown): Promise<import('@deepseek-ai/dsh-fs').FsTarget>
 * }} FsSeam
 */

/**
 * Read the stock filesystem instance through its fence seam.
 *
 * @param {import('@deepseek-ai/dsh-fs-sandbox').SandboxedFileSystem} fs - the instance the wrapper installs on.
 * @returns {FsSeam} the same instance, with the private seam visible.
 */
export const asFsSeam = (fs) => /** @type {FsSeam} */ (/** @type {unknown} */ (fs))
/**
 * A view of the permission service that exposes its private selection accessor.
 *
 * `permissionState` is the member this plugin reads a session's recorded
 * preset through, and the published typings declare it private, so a contract
 * test cannot read it through the class type. `current` is public but derives
 * an effective name rather than returning the recorded one. The base is
 * `Omit`ted for the same reason as above.
 */

/**
 * @typedef {Omit<import('@deepseek-ai/dsh-permission-presets').PermissionPresetService, 'permissionState'> & {
 *   permissionState(session: unknown): { preset?: string | null, sandbox?: string | null, approval?: string | null }
 * }} PermissionSeam
 */

/**
 * Read the stock permission service through its selection accessor.
 *
 * @param {import('@deepseek-ai/dsh-permission-presets').PermissionPresetService} service - the service the plugin reads.
 * @returns {PermissionSeam} the same instance, with the private accessor visible.
 */
export const asPermissionSeam = (service) => /** @type {PermissionSeam} */ (/** @type {unknown} */ (service))
