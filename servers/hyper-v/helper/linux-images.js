/**
 * Linux images (MC-1501; MC-1572: the user's choice, never the helper's). The user names a local qcow2 cloud image when
 * they provision: pool_plan's image { file: "<path>" }. There is no pin table, no download and no checksum or signature
 * fetching: the plan the user approves names the file and its SHA-256, and that approval is the trust decision.
 *
 * - **Copied while hashed** into the helper's own images folder, and only that copy is converted (qcow2.js, then
 *   hv.ps1 'vhd-convert', Hyper-V's Convert-VHD) to the base VHDX a create copies. The VHDX's SHA-256 is recorded and
 *   rechecked before each copy (guests/linux.js).
 * - **Limits, not gates:** a qcow2 file (the format the distros publish cloud images in; qcow2.js refuses a backing
 *   file, encryption and the like), and a guest the build can drive: cloud-init (NoCloud seed),
 *   systemd, OpenSSH and the hv_sock module (guests/linux.js). An image without one of those fails at the build step
 *   that needs it, by name. Run so far on Debian 13 and Ubuntu 26.04.
 * - The guest's own report at its build (/etc/os-release) is recorded on the VM; for an image recorded with a distro
 *   (the earlier pinned ones) it is compared with it, as a sanity check.
 */
const fs = require('fs')
const crypto = require('crypto')
const { join, win32 } = require('path')
const qcow2 = require('./qcow2')

// MC-1579: the image file has no size cap of its own (formerly 4 GB): the disk it holds is bounded by its virtual size,
// which qcow2.toVhd holds to the policy's maxDiskGBPerVm and VHD's own limit.
const MAX_IMAGE = Infinity
/** A distro as vm_acquire's distro names it: the guest's /etc/os-release ID (debian, ubuntu, fedora, ...). */
const DISTRO_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/

/** Copies a stream into `file` ('wx') while taking its SHA-256; capped. */
function copyHashing(input, file, cap, progress) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const out = fs.createWriteStream(file, { flags: 'wx' })
    let size = 0
    let last = 0
    input.on('data', d => {
      size += d.length
      if (size > cap) { input.destroy(new Error(`the image is larger than ${cap} bytes`)); return }
      h.update(d)
      if (size - last > 128 * 1024 * 1024) { last = size; progress?.(`copied and hashed ${(size / 1024 ** 2).toFixed(0)} MB`) }
    })
    input.on('error', e => { out.destroy(); reject(e) })
    out.on('error', reject)
    input.pipe(out)
    out.on('finish', () => resolve({ sha256: h.digest('hex'), size }))
  })
}

/** Hashes a file (SHA-256), streaming. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

/** Checks a local file before copying it in: an absolute local path to a plain file, not in the helper's own folders. */
function localImage(p, ownDirs) {
  if (typeof p !== 'string' || !win32.isAbsolute(p) || /^\\\\/.test(p)) throw new Error('image.file must be an absolute local path to a qcow2 cloud image')
  const real = fs.realpathSync.native(p)
  for (const d of ownDirs) if (real.toLowerCase().startsWith(d.toLowerCase() + '\\')) throw new Error('image.file can\'t be in the helper\'s own folders')
  const st = fs.lstatSync(real)
  if (!st.isFile()) throw new Error('image.file is not a plain file')
  return real
}

/**
 * Prepares a Linux image into dir from want { file }. known: verified images (sha256 → record). Resolves the image
 * record, or { ...record, existing: true }. Test seam: now.
 */
async function prepare({ want, dir, hv, known, ownDirs = [], progress = () => {}, now = Date.now(), maxVirtualBytes }) {
  if (!want || typeof want !== 'object' || want.file === undefined) throw new Error('image must be { file: "<path to a qcow2 cloud image>" }')
  const real = localImage(want.file, [...ownDirs, dir])
  fs.mkdirSync(dir, { recursive: true })
  const tag = crypto.randomBytes(6).toString('hex')
  const tmp = join(dir, `incoming-${tag}.qcow2`)
  const vhd = join(dir, `convert-${tag}.vhd`)
  try {
    progress('copying the image into the helper\'s folder while hashing it')
    const got = await copyHashing(fs.createReadStream(real), tmp, MAX_IMAGE, progress)
    if (known?.has(got.sha256) && fs.existsSync(known.get(got.sha256).file)) return { ...known.get(got.sha256), existing: true }
    // Convert: qcow2 (read-only, bounded) to a dynamic VHD, then Hyper-V's own Convert-VHD to the base VHDX.
    progress('converting the qcow2 image to a VHD (the helper\'s own reader; nothing installed)')
    const conv = await qcow2.toVhd(tmp, vhd, { maxVirtualBytes, progress, now })
    const vhdx = join(dir, `${got.sha256}.vhdx`)
    progress('converting the VHD to VHDX (Hyper-V\'s Convert-VHD)')
    await hv('vhd-convert', { vhd, vhdx }, { timeoutMs: 30 * 60_000 })
    const vhdxSha256 = await hashFile(vhdx)
    fs.rmSync(tmp, { force: true })
    return { sha256: got.sha256, size: got.size, file: vhdx, vhdxSha256, virtualSize: conv.virtualSize, source: 'local', path: real, os: 'linux', name: win32.basename(real) }
  } finally {
    fs.rmSync(tmp, { force: true })
    fs.rmSync(vhd, { force: true })
  }
}

/** What a Linux image is, by name: an earlier pinned one's distro and build, or the user's file name. */
function label(img) {
  return img.distro ? (img.name || `${img.distro} ${img.release}`) + (img.serial ? `, build ${img.serial}` : '') : img.name ? `Linux image ${img.name}` : 'Linux image'
}

/** A Linux image's line for status. */
function describe(img) {
  return `${label(img)}, SHA-256 ${String(img.sha256).slice(0, 12)}${img.path ? `, from ${img.path}` : ''}`
}

/** The guest's own report at its build, compared with an image recorded with its distro: a sanity check only. */
function guestReportProblem(g, img) {
  if (!g || typeof g !== 'object') return 'no report'
  if (!img.distro) return null // the user's own image: nothing recorded to compare with
  if (g.id !== img.distro) return `the guest says it is ${g.id}, the image ${img.distro}`
  if (String(g.versionId) !== String(img.release)) return `the guest says version ${g.versionId}, the image ${img.release}`
  return null
}

module.exports = { prepare, describe, label, guestReportProblem, hashFile, localImage, DISTRO_RE }
