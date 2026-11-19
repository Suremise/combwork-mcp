/**
 * The Windows image a pool is built from (MC-1572: the user's choice, never the helper's).
 *
 * - **The user names the ISO** when they provision: pool_plan's image { iso: "<path>" }, any local Windows ISO. There is
 *   no pin table, no download and no override: the plan the user approves names the file, its SHA-256, edition and
 *   build, and that approval is the trust decision.
 * - The ISO is copied into the helper's own folder **while it is hashed**, and only that copy is used; the build hashes
 *   it again before using it (core.js), so the bytes approved are the bytes built.
 * - **Before anything runs it**, iso.js reads the copy (no mounting) for install.wim's editions and build. Whether
 *   setup.exe and sources\setup.exe carry valid Microsoft signatures (hv.ps1 'signatures') is read too, and shown in the
 *   plan as information: it refuses nothing.
 * - **Limits, not gates:** an x64 image (an x64 Hyper-V host runs no ARM guest), and media with sources\install.wim
 *   (the unattended install picks its image by index).
 * - **One edition per ISO** (MC-1513): a multi-edition ISO needs { edition } on its first check; the record keeps that
 *   edition and its index, and a later request for another edition of the same ISO is refused, so a verified image's
 *   identity never changes.
 * - The guest's own report after the install is a sanity check only (guestReportProblem).
 */
const fs = require('fs')
const crypto = require('crypto')
const { join, win32 } = require('path')
const iso = require('./iso')

const EVAL = 'EnterpriseEval'
/** An evaluation edition (EnterpriseEval, ServerStandardEval, ...): it must be activated online once at build. */
const isEvalEdition = e => /Eval$/.test(String(e))
const EDITION_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/
// HYPERV_MCP_MIN_ISO_BYTES: test-only, so the tests can use small fixture images.
const minSize = () => Number(process.env.HYPERV_MCP_MIN_ISO_BYTES || 1024 ** 3)
/** The shapes an image request no longer takes (MC-1572), and what to pass instead. */
const NO_DOWNLOAD = 'The helper doesn\'t download images: download the ISO yourself, then pass image { iso: "<its path>" } (or { file: "<path to a Linux qcow2 cloud image>" }). The plan you approve names it and its hash.'

/** Copies a stream into `file` while hashing it; resolves { sha256, size }. MC-1579: no size cap (formerly 16 GB). */
function copyHashing(input, file, progress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const out = fs.createWriteStream(file, { flags: 'wx' })
    let size = 0
    let last = 0
    input.on('data', d => {
      size += d.length
      hash.update(d)
      if (size - last > 256 * 1024 * 1024) { last = size; progress?.(`copied and hashed ${(size / 1024 ** 3).toFixed(1)} GB`) }
    })
    input.on('error', e => { out.destroy(); reject(e) })
    out.on('error', reject)
    input.pipe(out)
    out.on('finish', () => resolve({ sha256: hash.digest('hex').toUpperCase(), size }))
  })
}

/** Checks a local ISO path before reading it: a plain .iso file of a plausible size, not one of the helper's own. */
function localIso(p, ownDirs) {
  if (typeof p !== 'string' || !win32.isAbsolute(p) || /^\\\\/.test(p)) throw new Error('image.iso must be an absolute local path to an .iso file')
  const real = fs.realpathSync.native(p)
  if (!/\.iso$/i.test(real)) throw new Error('image.iso must be an .iso file')
  for (const d of ownDirs) if (real.toLowerCase().startsWith(d.toLowerCase() + '\\')) throw new Error('image.iso can\'t be in the helper\'s own folders')
  const st = fs.lstatSync(real)
  if (!st.isFile()) throw new Error('image.iso is not a plain file')
  if (st.size < minSize()) throw new Error('image.iso is not the size of a Windows install ISO')
  return real
}

/**
 * Copies, hashes and reads an image into dir. want: { iso: path, edition? }. known: Map of verified images (sha256
 * lower-case → record). Resolves { sha256 (lower), size, file, source: 'local', path, edition, build, imageIndex,
 * evaluation, signature } or, with existing: true, the record of an image already verified.
 */
async function prepare({ want, dir, hv, known, ownDirs = [], progress = () => {} }) {
  if (want && typeof want === 'object' && (want.download !== undefined || want.url !== undefined)) throw new Error(NO_DOWNLOAD)
  if (!want || typeof want !== 'object' || want.iso === undefined) throw new Error('image must be { iso: "<path to a Windows ISO>" }, with edition when the ISO holds several')
  if (want.edition !== undefined && (typeof want.edition !== 'string' || !EDITION_RE.test(want.edition))) throw new Error('image.edition must be an edition ID from the ISO (e.g. Professional, Enterprise, ServerStandard)')
  const real = localIso(want.iso, [...ownDirs, dir])
  fs.mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `incoming-${crypto.randomBytes(6).toString('hex')}.iso`)
  try {
    progress('copying the ISO into the helper\'s folder while hashing it')
    const { sha256, size } = await copyHashing(fs.createReadStream(real), tmp, progress)
    const lower = sha256.toLowerCase()
    if (known?.has(lower) && fs.existsSync(known.get(lower).file)) {
      fs.rmSync(tmp, { force: true })
      const rec = known.get(lower)
      if (want.edition && want.edition !== rec.edition) throw new Error(`this ISO is recorded as ${rec.edition}; another edition from the same ISO isn't supported: use another ISO`)
      return { ...rec, existing: true }
    }
    progress('reading the ISO\'s files (no mounting)')
    const checkDir = join(dir, `check-${lower.slice(0, 12)}`)
    let look
    try { look = iso.inspect(tmp, checkDir) } catch (e) { fs.rmSync(checkDir, { recursive: true, force: true }); throw e }
    let signature
    try {
      progress('reading its setup files\' signatures (shown in the plan; nothing is refused for them)')
      const sig = await hv('signatures', { files: look.files })
      const bad = (sig.files || []).filter(f => !f.ok)
      signature = !sig.files?.length ? { microsoft: false, note: 'no answer' } : bad.length ? { microsoft: false, note: bad.map(f => `${win32.basename(String(f.file)).replace(/^sources-/, 'sources\\')}: ${f.why}`).join('; ') } : { microsoft: true, note: 'setup.exe and sources\\setup.exe validly signed by Microsoft' }
    } catch (e) {
      signature = { microsoft: false, note: `not read: ${e.message}` }
    } finally {
      fs.rmSync(checkDir, { recursive: true, force: true })
    }
    const holds = look.images.map(i => `${i.editionId} (arch ${i.arch})`).join(', ')
    const fits = look.images.filter(i => i.arch === 9)
    const imgs = want.edition ? fits.filter(i => i.editionId === want.edition) : fits
    if (want.edition && imgs.length !== 1) throw new Error(`the ISO should hold one x64 ${want.edition} image; it holds ${holds}`)
    if (!imgs.length) throw new Error(`the ISO holds no x64 image (it holds ${holds}): an x64 Hyper-V host runs x64 guests only`)
    if (imgs.length > 1) throw new Error(`the ISO holds several editions (${imgs.map(i => i.editionId).join(', ')}): pass image { iso, edition: "<one of them>" }`)
    const img = imgs[0]
    const build = `${img.build}.${img.spBuild}`
    const file = join(dir, `${lower}.iso`)
    fs.renameSync(tmp, file)
    return { sha256: lower, size, file, source: 'local', path: real, edition: img.editionId, build, imageIndex: img.index, evaluation: isEvalEdition(img.editionId), signature }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/**
 * MC-1578: a ready-made Windows disk as an image: { vhdx: "<path>", admin } (a disk already installed and set up, not
 * generalized) or { vm: "<name or id>", admin } (one of the user's own VMs outside the pool: off, Generation 2, one
 * disk; hv.ps1 'image-from-vm' reads it and flattens its disk, checkpoints included, into a copy, and never changes,
 * starts or owns the VM). The copy goes into dir while hashed (vhdx) or is hashed after the flattening (vm); only that
 * copy is used, and the build hashes it again first. admin: the local administrator account in it, whose password the
 * user types when approving (approve.ps1). poolVmIds: the pool's own VMs, never a source. Resolves the image record.
 */
const ADMIN_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,19}$/
async function prepareReady({ want, dir, hv, known, ownDirs = [], poolVmIds = [], progress = () => {} }) {
  if (typeof want.admin !== 'string' || !ADMIN_RE.test(want.admin)) throw new Error('image.admin must name a local administrator account in that Windows (1-20 letters, digits, dots, dashes, spaces or underscores): you type its password when you approve the plan')
  if ((want.vhdx !== undefined) === (want.vm !== undefined)) throw new Error('image is { vhdx, admin } or { vm, admin }, not both')
  fs.mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `incoming-${crypto.randomBytes(6).toString('hex')}.vhdx`)
  try {
    let sha256, size, source
    if (want.vhdx !== undefined) {
      const p = want.vhdx
      if (typeof p !== 'string' || !win32.isAbsolute(p) || /^\\\\/.test(p)) throw new Error('image.vhdx must be an absolute local path to a .vhdx file')
      let real
      try { real = fs.realpathSync.native(p) } catch { throw new Error(`image.vhdx ${p} can't be read: no such file`) }
      if (!/\.vhdx$/i.test(real)) throw new Error('image.vhdx must be a .vhdx file')
      for (const d of [...ownDirs, dir]) if (real.toLowerCase().startsWith(d.toLowerCase() + '\\')) throw new Error('image.vhdx can\'t be in the helper\'s own folders')
      if (!fs.lstatSync(real).isFile()) throw new Error('image.vhdx is not a plain file')
      progress('copying the disk into the helper\'s folder while hashing it')
      ;({ sha256, size } = await copyHashing(fs.createReadStream(real), tmp, progress))
      source = { source: 'vhdx', path: real }
    } else {
      if (typeof want.vm !== 'string' || !want.vm.trim() || want.vm.length > 100) throw new Error('image.vm must name one of your Hyper-V VMs (its name or id)')
      progress(`reading the VM ${want.vm}'s disk into the helper's folder (the VM itself is only read)`)
      const r = await hv('image-from-vm', { vm: want.vm, out: tmp, poolVmIds }, { timeoutMs: 6 * 60 * 60_000 })
      progress('hashing the copy')
      sha256 = (await hashFile(tmp)).toUpperCase()
      size = fs.statSync(tmp).size
      source = { source: 'vm', vmName: String(r.name), vmId: String(r.vmId) }
    }
    const lower = sha256.toLowerCase()
    if (known?.has(lower) && fs.existsSync(known.get(lower).file)) {
      const rec = known.get(lower)
      if (!rec.ready) throw new Error('this disk is already a verified image of another kind: use it by its SHA-256')
      if (rec.admin !== want.admin) throw new Error(`this disk is recorded with its admin account ${rec.admin}: name that one, or use another disk`)
      return { ...rec, existing: true }
    }
    const file = join(dir, `${lower}.vhdx`)
    fs.renameSync(tmp, file)
    return { sha256: lower, size, file, ...source, os: 'windows', ready: true, admin: want.admin, imageIndex: 1, evaluation: false }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** SHA-256 (lower-case hex) of a file, streaming: the build's recheck of the copy against the approved hash. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

/** The guest's report after the install, compared with the image: a sanity check, never authentication. */
function guestReportProblem(g, img) {
  if (!g || typeof g !== 'object') return 'no report'
  if (g.editionId !== img.edition) return `the guest says edition ${g.editionId}, the image ${img.edition}`
  if (String(g.build) !== String(img.build).split('.')[0]) return `the guest says build ${g.build}, the image ${img.build}`
  return null
}

module.exports = { prepare, prepareReady, guestReportProblem, localIso, hashFile, isEvalEdition, NO_DOWNLOAD, EVAL }
