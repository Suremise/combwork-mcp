/**
 * Guest-relative paths: a build's file names (staged by the helper) and the files read back from the guest's C:\out.
 * Checked as text, before anything touches a disk: absolute, drive, UNC and device paths, "..", ":" (streams), device
 * names, wildcards (outside a glob) and names Windows can't hold are refused. The same rules as windows-sandbox's
 * confine.js `segments`, so both servers refuse the same paths.
 */
const DEVICE_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/i

/** Splits a relative path or glob into segments, or throws why it is refused. */
function segments(p, { glob = false } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('empty path')
  if (p.length > 400) throw new Error('path too long')
  if (/[\0-\x1f]/.test(p)) throw new Error('control characters in path')
  if (/^[\\/]/.test(p)) throw new Error('absolute, UNC or device path (paths are relative)')
  if (/^[a-zA-Z]:/.test(p)) throw new Error('drive path (paths are relative)')
  if (p.includes(':')) throw new Error('":" is not allowed (alternate data streams)')
  const parts = p.split(/[\\/]+/).filter(s => s && s !== '.')
  if (!parts.length) throw new Error('empty path')
  if (parts.length > 32) throw new Error('path too deep')
  for (const s of parts) {
    if (s === '..' || /^\.\.+$/.test(s)) throw new Error('".." is not allowed')
    if (DEVICE_RE.test(s.replace(/[. ]+$/, ''))) throw new Error(`device name "${s}" is not allowed`)
    if (/[. ]$/.test(s) && !(glob && /[*?]$/.test(s))) throw new Error(`"${s}" ends with a dot or space`)
    if (/["<>|]/.test(s)) throw new Error(`"${s}" has characters Windows doesn't allow`)
    if (!glob && /[*?]/.test(s)) throw new Error(`"${s}" has wildcards: use glob`)
  }
  return parts
}

/** A matcher for a glob over '/'-joined relative paths: * and ? within a segment, ** across segments. */
function globMatcher(glob) {
  const parts = segments(glob, { glob: true })
  const re = parts
    .map((s, i) => {
      const last = i === parts.length - 1
      if (s === '**') return last ? '.*' : '(?:[^/]+/)*'
      return s.replace(/[.+^${}()[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + (last ? '' : '/')
    })
    .join('')
  const rx = new RegExp(`^${re}$`, 'i')
  return p => rx.test(p)
}

module.exports = { segments, globMatcher }
