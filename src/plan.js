/**
 * Pure transformation for the bwrap enforcement half.
 *
 * Kept free of DSH imports so it can be tested directly; the wrapping module
 * stays a thin adapter around it.
 */

/**
 * Insert one `--bind <dir> <dir>` pair per extra directory into a bwrap
 * invocation, placing them with the profile (before the `--` separator) so the
 * confined children see the directories writable exactly like the write/edit
 * tools do.
 *
 * @param {readonly string[]} argv - the bwrap invocation produced by the stock provider.
 * @param {readonly string[]} extra - the canonical extra directories to bind.
 * @returns {string[]} a new argv; the input is left untouched.
 */
export function withExtraBinds(argv, extra) {
  const separator = argv.indexOf('--')
  const at = separator === -1 ? argv.length : separator
  const binds = []
  for (const dir of extra) binds.push('--bind', dir, dir)
  return [...argv.slice(0, at), ...binds, ...argv.slice(at)]
}

/**
 * Insert one `--dev-bind <path> <path>` pair per configured device path.
 *
 * The stock profile mounts an empty `--dev /dev` over whatever `--ro-bind /`
 * exposed, so every device node the host has is absent inside the sandbox. A
 * device path is added back as a dev-bind rather than a bind because only the
 * dev-bind keeps the nodes usable: it mounts them without nodev, so the
 * confined child can open `/dev/dri/renderD128` and reach the GPU.
 *
 * These pairs are placed after the directory binds so a device path that also
 * lies under a writable directory keeps the device semantics of the later
 * mount.
 *
 * @param {readonly string[]} argv - the bwrap invocation produced by the stock provider.
 * @param {readonly string[]} devices - the configured device paths to expose.
 * @returns {string[]} a new argv; the input is left untouched.
 */
export function withDeviceBinds(argv, devices) {
  const separator = argv.indexOf('--')
  const at = separator === -1 ? argv.length : separator
  const binds = []
  for (const path of devices) binds.push('--dev-bind', path, path)
  return [...argv.slice(0, at), ...binds, ...argv.slice(at)]
}
