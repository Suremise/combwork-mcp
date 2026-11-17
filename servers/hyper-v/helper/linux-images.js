/**
 * Linux images (MC-1501; design: docs/linux-guests.md §2). Only the distros' official cloud images, and only pinned
 * ones: Debian's genericcloud and Ubuntu's server-cloudimg, both qcow2.
 *
 * - **Pinned, or refused.** PINNED_LINUX names each accepted image: its distro, release, build serial, file name, size,
 *   hash, URL and the distro's checksum file. An image not in it is refused, local or downloaded; there is no policy
 *   override for Linux (setup's -AllowUnpinnedIso stays Windows-only).
 * - **Downloaded** over HTTPS with certificate checks, from the pin's URL on the distro's own host. The image itself
 *   may be redirected to another https host (Debian's cloud.debian.org sends downloads to its mirrors): its bytes are
 *   authenticated by the pinned hash, not by where they came from. A checksum file and its signature must come from
 *   the distro's own host, with no redirect away from it.
 * - **Or a local copy** of a pinned image (`{ file }`), the same checks after it is copied in.
 * - **The distro's published checksums must agree with the pin**: Debian's SHA512SUMS (unsigned: Debian publishes no
 *   signature for its cloud images, so its trust is the pin plus HTTPS, as the user decided), Ubuntu's SHA256SUMS,
 *   verified first against its detached signature SHA256SUMS.gpg with Ubuntu's pinned image-signing key (openpgp.js).
 * - **Copied while hashed** into the helper's own images folder, and only that copy is converted (qcow2.js, then
 *   hv.ps1 'vhd-convert', Hyper-V's Convert-VHD) to the base VHDX a create copies. Its SHA-256 is recorded, and
 *   rechecked before each copy.
 */
const fs = require('fs')
const https = require('https')
const crypto = require('crypto')
const { join, win32 } = require('path')
const qcow2 = require('./qcow2')
const openpgp = require('./openpgp')

const DEBIAN_HOST = 'cloud.debian.org'
const UBUNTU_HOST = 'cloud-images.ubuntu.com'

/**
 * Accepted images, newest last per distro. Filled from each distro's dated build folder (never latest/ or current/),
 * its checksum file, and the file's size as served. A new serial is a new pin, in a new release of this server.
 */
const PINNED_LINUX = [
  {
    id: 'debian-13-20261116-2664', distro: 'debian', release: '13', codename: 'trixie', serial: '20261116-2664', name: 'Debian 13 (trixie) genericcloud amd64',
    file: 'debian-13-genericcloud-amd64-20261116-2664.qcow2', size: 344260608,
    url: `https://${DEBIAN_HOST}/images/cloud/trixie/20261116-2664/debian-13-genericcloud-amd64-20261116-2664.qcow2`,
    sums: { url: `https://${DEBIAN_HOST}/images/cloud/trixie/20261116-2664/SHA512SUMS`, alg: 'sha512', signature: null },
    sha512: '37cb32b320820417eb04b335afcf489bfb4cecce4a957190d09cb2bffbe02b56a1cadd62d78c6ead92aa7839d5ea65e4260f994bbb4b54490df59fdf11ee1d97'
  },
  {
    id: 'ubuntu-26.04-20261108', distro: 'ubuntu', release: '26.04', codename: 'resolute', serial: '20261108', name: 'Ubuntu 26.04 LTS (resolute) server-cloudimg amd64',
    file: 'ubuntu-26.04-server-cloudimg-amd64.img', size: 861563904,
    url: `https://${UBUNTU_HOST}/releases/resolute/release-20261108/ubuntu-26.04-server-cloudimg-amd64.img`,
    sums: { url: `https://${UBUNTU_HOST}/releases/resolute/release-20261108/SHA256SUMS`, alg: 'sha256', signature: { url: `https://${UBUNTU_HOST}/releases/resolute/release-20261108/SHA256SUMS.gpg`, key: 'ubuntu-cloud-images' } },
    sha256: '7b90593f5532b49b7e3fe3d2743f0d1f0d822e5b07cebcd8e00c0df8069ecab9'
  }
]
const DISTROS = ['debian', 'ubuntu']
const MAX_IMAGE = 4 * 1024 ** 3
const MAX_SUMS = 1024 * 1024

/** The pin a request names: { distro, release? } (the newest of that distro, or that release) or { pin: id }. */
function pinFor(want, pins = PINNED_LINUX) {
  if (want.pin !== undefined) {
    const p = pins.find(x => x.id === want.pin)
    if (!p) throw new Error(`no pinned Linux image ${want.pin} (pinned: ${pins.map(x => x.id).join(', ')})`)
    return p
  }
  if (!DISTROS.includes(want.distro)) throw new Error(`image.distro must be ${DISTROS.join(' or ')}`)
  const of = pins.filter(x => x.distro === want.distro && (want.release === undefined || x.release === String(want.release)))
  if (!of.length) throw new Error(`no pinned ${want.distro}${want.release !== undefined ? ` ${want.release}` : ''} image (pinned: ${pins.map(x => x.id).join(', ')})`)
  return of.at(-1)
}

function officialHost(pin) { return pin.distro === 'debian' ? DEBIAN_HOST : UBUNTU_HOST }

/**
 * GET over HTTPS. sameHost: redirects must stay on the first URL's host (checksums and signatures); otherwise any
 * https host (the image, whose pin authenticates it). Resolves the response stream.
 */
function get(u, { sameHost = true, redirects = 5 } = {}, first = null) {
  return new Promise((resolve, reject) => {
    let url
    try { url = new URL(u) } catch { return reject(new Error(`bad URL ${u}`)) }
    const origin = first || url.hostname
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return reject(new Error(`refusing ${u}: https only, no port or credentials`))
    if (sameHost && url.hostname !== origin) return reject(new Error(`refusing a redirect from ${origin} to ${url.hostname} for a checksum file`))
    https.get(url, { timeout: 60_000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (!redirects) return reject(new Error('too many redirects'))
        return resolve(get(new URL(res.headers.location, url).href, { sameHost, redirects: redirects - 1 }, origin))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url.hostname} answered HTTP ${res.statusCode} for ${url.pathname}: the distro may have pruned this build (a newer server pins a newer one)`)) }
      resolve(res)
    }).on('error', reject).on('timeout', function () { this.destroy(new Error(`the download from ${url.hostname} timed out`)) })
  })
}

async function fetchSmall(u, fetch) {
  const res = await fetch(u, { sameHost: true })
  const parts = []
  let n = 0
  for await (const d of res) { n += d.length; if (n > MAX_SUMS) { res.destroy?.(); throw new Error(`${u} is larger than ${MAX_SUMS} bytes`) } parts.push(d) }
  return Buffer.concat(parts)
}

/** Copies a stream into `file` ('wx') while taking SHA-256 and SHA-512; capped. */
function copyHashing(input, file, cap, progress) {
  return new Promise((resolve, reject) => {
    const h256 = crypto.createHash('sha256')
    const h512 = crypto.createHash('sha512')
    const out = fs.createWriteStream(file, { flags: 'wx' })
    let size = 0
    let last = 0
    input.on('data', d => {
      size += d.length
      if (size > cap) { input.destroy(new Error(`the image is larger than ${cap} bytes`)); return }
      h256.update(d); h512.update(d)
      if (size - last > 128 * 1024 * 1024) { last = size; progress?.(`copied and hashed ${(size / 1024 ** 2).toFixed(0)} MB`) }
    })
    input.on('error', e => { out.destroy(); reject(e) })
    out.on('error', reject)
    input.pipe(out)
    out.on('finish', () => resolve({ sha256: h256.digest('hex'), sha512: h512.digest('hex'), size }))
  })
}

/** The checksum file's line for `name`: "<hex>  <name>" or "<hex> *<name>". Exactly one, or null. */
function sumFor(text, name, alg) {
  const len = alg === 'sha512' ? 128 : 64
  const hits = []
  for (const line of text.split(/\r?\n/)) {
    const m = new RegExp(`^([0-9a-fA-F]{${len}}) [ *](.+)$`).exec(line.trim())
    if (m && m[2] === name) hits.push(m[1].toLowerCase())
  }
  return hits.length === 1 ? hits[0] : null
}

/** Hashes a file (SHA-256), streaming. */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    fs.createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * Checks a local file before copying it in: an absolute local path to a plain file, not in the helper's own folders.
 */
function localImage(p, ownDirs) {
  if (typeof p !== 'string' || !win32.isAbsolute(p) || /^\\\\/.test(p)) throw new Error('image.file must be an absolute local path to a pinned qcow2 image')
  const real = fs.realpathSync.native(p)
  for (const d of ownDirs) if (real.toLowerCase().startsWith(d.toLowerCase() + '\\')) throw new Error('image.file can\'t be in the helper\'s own folders')
  const st = fs.lstatSync(real)
  if (!st.isFile()) throw new Error('image.file is not a plain file')
  return real
}

/**
 * Prepares a Linux image into dir: want { distro, release? } | { pin } (downloaded) or with { file } (a local copy of
 * that pin, or of whichever pin it matches when only { file } is given). known: verified images (sha256 → record).
 * Resolves the image record, or { ...record, existing: true }. Test seams: pins, fetch (get's signature), now.
 */
async function prepare({ want, dir, hv, known, ownDirs = [], progress = () => {}, pins = PINNED_LINUX, fetch = get, now = Date.now(), maxVirtualBytes }) {
  if (!want || typeof want !== 'object') throw new Error('image must be { distro: "debian" | "ubuntu" }, optionally with release, or { file: "<path to a pinned image>" }')
  const pinAsked = want.distro !== undefined || want.pin !== undefined ? pinFor(want, pins) : null
  if (!pinAsked && want.file === undefined) throw new Error('image must name a distro (debian or ubuntu) or a local file of a pinned image')
  fs.mkdirSync(dir, { recursive: true })
  const tag = crypto.randomBytes(6).toString('hex')
  const tmp = join(dir, `incoming-${tag}.qcow2`)
  const vhd = join(dir, `convert-${tag}.vhd`)
  const source = want.file !== undefined ? 'local' : 'download'
  try {
    progress(source === 'local' ? 'copying the image into the helper\'s folder while hashing it' : `downloading ${pinAsked.name} (build ${pinAsked.serial}) over HTTPS while hashing it`)
    const input = source === 'local' ? fs.createReadStream(localImage(want.file, [...ownDirs, dir])) : await fetch(pinAsked.url, { sameHost: false })
    const got = await copyHashing(input, tmp, MAX_IMAGE, progress)
    const pin = pinAsked || pins.find(p => (p.sha256 && p.sha256 === got.sha256) || (p.sha512 && p.sha512 === got.sha512))
    if (!pin) throw new Error(`this file (SHA-256 ${got.sha256}) is not a pinned Linux image: only the pinned Debian and Ubuntu cloud images are accepted (${pins.map(p => p.id).join(', ')})`)
    if ((pin.sha256 && pin.sha256 !== got.sha256) || (pin.sha512 && pin.sha512 !== got.sha512)) throw new Error(`the image's hash doesn't match the pin for ${pin.id}: refused`)
    if (got.size !== pin.size) throw new Error(`the image matches ${pin.id}'s hash but not its size (${got.size}, not ${pin.size})`)
    if (known?.has(got.sha256) && fs.existsSync(known.get(got.sha256).file)) {
      return { ...known.get(got.sha256), existing: true }
    }
    // The distro's own checksums, from its own host, must name exactly the pinned hash.
    progress(`checking ${pin.distro === 'debian' ? 'Debian\'s SHA512SUMS (unsigned)' : 'Ubuntu\'s SHA256SUMS and its signature'}`)
    const sums = await fetchSmall(pin.sums.url, fetch)
    if (new URL(pin.sums.url).hostname !== officialHost(pin)) throw new Error('the pin\'s checksum file is not on the distro\'s own host')
    let signed = null
    if (pin.sums.signature) {
      const sig = await fetchSmall(pin.sums.signature.url, fetch)
      try { signed = openpgp.verifyDetached(sums, sig, pin.sums.signature.key, { now }) } catch (e) { throw new Error(`${pin.distro}'s checksum file's signature doesn't verify: ${e.message}`) }
    }
    const line = sumFor(sums.toString('utf8'), pin.file, pin.sums.alg)
    const want_ = pin.sums.alg === 'sha512' ? got.sha512 : got.sha256
    if (!line) throw new Error(`${pin.distro}'s ${pin.sums.alg.toUpperCase()}SUMS has no single line for ${pin.file}`)
    if (line !== want_) throw new Error(`${pin.distro}'s ${pin.sums.alg.toUpperCase()}SUMS gives ${pin.file} another hash than the pin: refused`)
    // Convert: qcow2 (read-only, bounded) to a dynamic VHD, then Hyper-V's own Convert-VHD to the base VHDX.
    progress('converting the qcow2 image to a VHD (the helper\'s own reader; nothing installed)')
    const conv = await qcow2.toVhd(tmp, vhd, { maxVirtualBytes, progress, now })
    const vhdx = join(dir, `${got.sha256}.vhdx`)
    progress('converting the VHD to VHDX (Hyper-V\'s Convert-VHD)')
    await hv('vhd-convert', { vhd, vhdx }, { timeoutMs: 30 * 60_000 })
    const vhdxSha256 = await hashFile(vhdx)
    fs.rmSync(tmp, { force: true })
    return {
      sha256: got.sha256, sha512: got.sha512, size: got.size, file: vhdx, vhdxSha256, virtualSize: conv.virtualSize, source, os: 'linux', pinned: true,
      pin: pin.id, distro: pin.distro, release: pin.release, codename: pin.codename, serial: pin.serial, name: pin.name,
      checksums: signed ? `SHA256SUMS signed by Ubuntu's image key ${signed.fingerprint} (${signed.created})` : 'SHA512SUMS, unsigned (Debian publishes no signature for cloud images): authenticated by the pinned hash and HTTPS'
    }
  } finally {
    fs.rmSync(tmp, { force: true })
    fs.rmSync(vhd, { force: true })
  }
}

/** A Linux image's line for a plan or status. */
function describe(img) {
  if (!img.distro) return `Linux image ${String(img.sha256).slice(0, 12)}`
  return `${img.name || `${img.distro} ${img.release}`}, build ${img.serial}, SHA-256 ${String(img.sha256).slice(0, 12)}, pinned`
}

/** The guest's own report at its build, compared with the pin: a sanity check, never verification. */
function guestReportProblem(g, img) {
  if (!g || typeof g !== 'object') return 'no report'
  if (!img.distro) return null // an image recorded without its distro (tests' journal-only kind): nothing to compare
  if (g.id !== img.distro) return `the guest says it is ${g.id}, the image ${img.distro}`
  if (String(g.versionId) !== String(img.release)) return `the guest says version ${g.versionId}, the image ${img.release}`
  return null
}

module.exports = { prepare, pinFor, sumFor, describe, guestReportProblem, hashFile, get, PINNED_LINUX, DISTROS }
