/**
 * The Windows image a pool is built from, and what authenticates it.
 *
 * - **Authenticity comes from the bytes' origin, and only that:** a SHA-256 in PINNED (a known Microsoft download), or
 *   a download the helper made itself over HTTPS from a Microsoft host (TLS authenticates the server; the hash is then
 *   recorded, trust on first use). A local file that isn't pinned is refused unless policy.allowUnpinnedIso, and its
 *   plan then says "not authenticated".
 * - The ISO is copied into the helper's own folder **while it is hashed**, and only that copy is used, so it can't be
 *   swapped after the check.
 * - **Before anything runs it**, iso.js reads the copy (no mounting): setup.exe and sources\setup.exe must carry valid
 *   Microsoft Authenticode signatures (hv.ps1 'signatures': chain to a pinned Microsoft root), and install.wim's metadata
 *   must name the expected edition and build. These are consistency checks: install.wim has no signature of its own,
 *   so they don't authenticate its contents. The hash and origin do.
 * - The guest's own report after the install is a sanity check only (guestReportProblem), never verification.
 */
const fs = require('fs')
const https = require('https')
const crypto = require('crypto')
const { join, win32 } = require('path')
const iso = require('./iso')

/** Known images: SHA-256 (upper-case hex) → what it is. */
const PINNED = {
  A61ADEAB895EF5A4DB436E0A7011C92A2FF17BB0357F58B13BBC4062E535E7B9: {
    size: 7_092_807_680, edition: 'EnterpriseEval', build: '26200.6584',
    name: 'Windows 11 Enterprise Evaluation 25H2 (26200.6584.250915-1905), en-us, x64'
  }
}
const EDITIONS = ['EnterpriseEval']
// HYPERV_MCP_MIN_ISO_BYTES: test-only, so the tests can use small fixture images.
const minSize = () => Number(process.env.HYPERV_MCP_MIN_ISO_BYTES || 1024 ** 3)
const MAX_SIZE = 16 * 1024 ** 3

/** Whether a download URL is allowed: https, on a Microsoft host. */
function allowedUrl(u) {
  let url
  try { url = new URL(u) } catch { return false }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && /(^|\.)microsoft\.com$/i.test(url.hostname)
}

/** Copies a stream into `file` while hashing it; resolves { sha256, size }. Caps the size. */
function copyHashing(input, file, progress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const out = fs.createWriteStream(file, { flags: 'wx' })
    let size = 0
    let last = 0
    input.on('data', d => {
      size += d.length
      if (size > MAX_SIZE) { input.destroy(new Error('the image is larger than 16 GB')); return }
      hash.update(d)
      if (size - last > 256 * 1024 * 1024) { last = size; progress?.(`copied and hashed ${(size / 1024 ** 3).toFixed(1)} GB`) }
    })
    input.on('error', e => { out.destroy(); reject(e) })
    out.on('error', reject)
    input.pipe(out)
    out.on('finish', () => resolve({ sha256: hash.digest('hex').toUpperCase(), size }))
  })
}

/** GET over HTTPS, following redirects only to allowed URLs. Resolves the response stream. */
function download(u, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (!allowedUrl(u)) return reject(new Error(`refusing to download from ${u}: only https on a microsoft.com host`))
    https.get(u, { timeout: 60_000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (!redirects) return reject(new Error('too many redirects'))
        return resolve(download(new URL(res.headers.location, u).href, redirects - 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`the download answered HTTP ${res.statusCode}: the URL may have moved. Download the ISO by hand from Microsoft's Evaluation Center, then pass image { iso: "<path>" }.`)) }
      resolve(res)
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('the download timed out')) })
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
  if (st.size < minSize() || st.size > MAX_SIZE) throw new Error('image.iso is not the size of a Windows install ISO')
  return real
}

/**
 * Copies, hashes and checks an image into dir. want: { iso: path } or { download: url }. known: Map of verified images
 * (sha256 lower-case → record). Resolves { sha256 (lower), size, file, source, edition, build, pinned } or with
 * existing: true when that image is already verified.
 */
async function prepare({ want, dir, hv, policy, known, ownDirs = [], progress = () => {} }) {
  if (!want || typeof want !== 'object' || (!want.iso === !want.download)) throw new Error('image must be { iso: "<path>" } or { download: "<https URL on microsoft.com>" }')
  fs.mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `incoming-${crypto.randomBytes(6).toString('hex')}.iso`)
  const source = want.iso ? 'local' : 'download'
  try {
    progress(want.iso ? 'copying the ISO into the helper\'s folder while hashing it' : 'downloading the ISO over HTTPS while hashing it')
    const input = want.iso ? fs.createReadStream(localIso(want.iso, [...ownDirs, dir])) : await download(want.download)
    const { sha256, size } = await copyHashing(input, tmp, progress)
    const lower = sha256.toLowerCase()
    if (known?.has(lower) && fs.existsSync(known.get(lower).file)) { fs.rmSync(tmp, { force: true }); return { ...known.get(lower), existing: true } }
    const pin = PINNED[sha256]
    if (pin && pin.size !== size) throw new Error('the image matches a pinned hash but not its size')
    if (!pin && source === 'local' && !policy.allowUnpinnedIso) {
      throw new Error(`this ISO (SHA-256 ${sha256}) is not a known Microsoft image, and the policy doesn't allow unpinned local images. Use the pinned image, have the helper download one from Microsoft (image { download: "<URL>" }), or allow unpinned images at setup.`)
    }
    progress('reading the ISO\'s files (no mounting) and checking their signatures')
    const look = iso.inspect(tmp, join(dir, `check-${lower.slice(0, 12)}`))
    const sig = await hv('signatures', { files: look.files })
    fs.rmSync(join(dir, `check-${lower.slice(0, 12)}`), { recursive: true, force: true })
    const badSig = (sig.files || []).filter(f => !f.ok)
    if (!sig.files?.length || badSig.length) throw new Error(`the ISO's setup files are not validly signed by Microsoft: ${badSig.map(f => `${f.file}: ${f.why}`).join('; ') || 'no answer'}`)
    const imgs = look.images.filter(i => EDITIONS.includes(i.editionId) && i.arch === 9)
    if (imgs.length !== 1) throw new Error(`the ISO should hold one x64 ${EDITIONS.join('/')} image; it holds ${look.images.map(i => `${i.editionId} (arch ${i.arch})`).join(', ')}`)
    const img = imgs[0]
    const build = `${img.build}.${img.spBuild}`
    if (pin && (pin.edition !== img.editionId || pin.build !== build)) throw new Error(`the pinned image should be ${pin.edition} ${pin.build}, but its metadata says ${img.editionId} ${build}`)
    const file = join(dir, `${lower}.iso`)
    fs.renameSync(tmp, file)
    return { sha256: lower, size, file, source, edition: img.editionId, build, imageIndex: img.index, pinned: !!pin }
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/** The guest's report after the install, compared with the image: a sanity check, never authentication. */
function guestReportProblem(g, img) {
  if (!g || typeof g !== 'object') return 'no report'
  if (g.editionId !== img.edition) return `the guest says edition ${g.editionId}, the image ${img.edition}`
  if (String(g.build) !== String(img.build).split('.')[0]) return `the guest says build ${g.build}, the image ${img.build}`
  return null
}

module.exports = { prepare, guestReportProblem, allowedUrl, localIso, PINNED }
