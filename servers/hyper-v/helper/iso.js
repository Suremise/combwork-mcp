/**
 * A small, read-only UDF reader for Windows install ISOs, and the WIM header's XML metadata: enough to check an image's
 * files before anything runs it, without mounting it (mounting needs admin). The ISO is untrusted input, so every
 * structure is bounds-checked and every walk is capped: directory size, entries, depth, extents, and a visited set
 * against loops. A malformed image is refused with a reason, never followed.
 *
 * Supports what Windows ISOs use: UDF 1.02-2.01, one type-1 partition map, File Entries and Extended File Entries,
 * short_ad / long_ad / embedded allocation. Anything else is refused as unsupported.
 */
const fs = require('fs')

const SECTOR = 2048
const MAX_DIR_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 20_000
const MAX_DEPTH = 8
const MAX_EXTENTS = 100_000
const MAX_XML = 8 * 1024 * 1024

class IsoError extends Error {}
const fail = m => { throw new IsoError(m) }

class Udf {
  constructor(file) {
    this.fd = fs.openSync(file, 'r')
    this.size = fs.fstatSync(this.fd).size
    this.visited = new Set()
  }

  close() { try { fs.closeSync(this.fd) } catch { /* closed */ } }

  read(pos, len) {
    if (!Number.isSafeInteger(pos) || pos < 0 || len < 0 || pos + len > this.size) fail(`a structure points outside the image (byte ${pos}, ${len} bytes)`)
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const n = fs.readSync(this.fd, buf, got, len - got, pos + got)
      if (!n) fail('short read')
      got += n
    }
    return buf
  }

  /** Reads a descriptor at a sector and checks its tag: id, checksum and location. */
  tag(sector, want) {
    const b = this.read(sector * SECTOR, SECTOR)
    const id = b.readUInt16LE(0)
    let sum = 0
    for (let i = 0; i < 16; i++) if (i !== 4) sum = (sum + b[i]) & 0xff
    if (sum !== b[4]) fail(`bad descriptor checksum at sector ${sector}`)
    if (b.readUInt32LE(12) !== (sector - (this.partStart ?? 0)) && b.readUInt32LE(12) !== sector) fail(`descriptor at sector ${sector} names another location`)
    if (want !== undefined && !(Array.isArray(want) ? want : [want]).includes(id)) fail(`expected descriptor ${want} at sector ${sector}, found ${id}`)
    return { id, b }
  }

  /** Finds the partition and the root directory. */
  open() {
    if (this.size < 257 * SECTOR) fail('too small to be a UDF image')
    const avdp = this.tag(256, 2).b
    const vdsLen = avdp.readUInt32LE(16)
    const vdsLoc = avdp.readUInt32LE(20)
    let part = null
    let lvd = null
    for (let i = 0; i < Math.min(64, Math.floor(vdsLen / SECTOR)); i++) {
      const { id, b } = this.tag(vdsLoc + i)
      if (id === 5 && !part) part = { number: b.readUInt16LE(22), start: b.readUInt32LE(188), length: b.readUInt32LE(192) }
      else if (id === 6 && !lvd) lvd = b
      else if (id === 8) break
    }
    if (!part || !lvd) fail('no partition or logical volume descriptor')
    if (lvd.readUInt32LE(212) !== SECTOR) fail('unsupported logical block size')
    const maps = lvd.readUInt32LE(268)
    if (maps !== 1 || lvd[440] !== 1) fail('unsupported partition maps (only one type-1 map)')
    if (part.start + part.length > Math.ceil(this.size / SECTOR) + 1) fail('the partition is larger than the image')
    this.partStart = part.start
    this.partLength = part.length
    const fsdLb = lvd.readUInt32LE(248 + 4)
    const fsd = this.tag(this.lb(fsdLb), 256).b
    this.root = fsd.readUInt32LE(400 + 4)
    return this
  }

  lb(n) {
    if (!Number.isInteger(n) || n < 0 || n >= this.partLength) fail(`logical block ${n} is outside the partition`)
    return this.partStart + n
  }

  /** A file entry: { dir, length, extents: [{ pos, len }] } or embedded data. */
  entry(lbn) {
    const { id, b } = this.tag(this.lb(lbn), [261, 266])
    const ext = id === 266
    const icbFlags = b.readUInt16LE(16 + 18)
    const fileType = b[16 + 11]
    const length = Number(b.readBigUInt64LE(56))
    const lEa = b.readUInt32LE(ext ? 208 : 168)
    const lAd = b.readUInt32LE(ext ? 212 : 172)
    const adStart = (ext ? 216 : 176) + lEa
    if (adStart + lAd > SECTOR) fail('allocation descriptors run past their file entry')
    if (!Number.isSafeInteger(length) || length > this.size) fail('a file is larger than the image')
    const type = icbFlags & 7
    const extents = []
    let data = null
    if (type === 3) data = b.subarray(adStart, adStart + Math.min(lAd, length))
    else if (type === 0 || type === 1) {
      const step = type === 0 ? 8 : 16
      for (let at = adStart; at + step <= adStart + lAd; at += step) {
        const raw = b.readUInt32LE(at)
        const len = raw & 0x3fffffff
        const kind = raw >>> 30
        if (!len) break
        if (kind === 3) fail('continued allocation descriptors are not supported')
        const pos = b.readUInt32LE(at + 4)
        if (kind === 0) extents.push({ pos: this.lb(pos) * SECTOR, len })
        else extents.push({ pos: -1, len }) // unrecorded: reads as zeros
        if (extents.length > MAX_EXTENTS) fail('too many extents')
      }
    } else fail('unsupported allocation type')
    const total = data ? data.length : extents.reduce((s, e) => s + e.len, 0)
    if (total < length) fail('a file\'s extents are shorter than its length')
    return { dir: fileType === 4, length, extents, data }
  }

  /** Reads `len` bytes of a file entry from `offset`. */
  readFile(e, offset, len) {
    if (offset < 0 || offset + len > e.length) fail('read past a file\'s end')
    if (e.data) return Buffer.from(e.data.subarray(offset, offset + len))
    const out = Buffer.alloc(len)
    let at = 0
    let base = 0
    for (const x of e.extents) {
      if (at >= len) break
      const from = offset + at
      if (from < base + x.len) {
        const take = Math.min(len - at, base + x.len - from)
        if (x.pos >= 0) this.read(x.pos + (from - base), take).copy(out, at)
        at += take
      }
      base += x.len
    }
    return out
  }

  /** The entries of a directory: [{ name, dir, lbn }]. */
  list(lbn) {
    if (this.visited.has(lbn)) fail('a directory loop')
    this.visited.add(lbn)
    const e = this.entry(lbn)
    if (!e.dir) fail('not a directory')
    if (e.length > MAX_DIR_BYTES) fail('a directory is too large')
    const b = this.readFile(e, 0, e.length)
    const out = []
    for (let at = 0; at + 38 <= b.length;) {
      if (b.readUInt16LE(at) !== 257) fail('bad file identifier descriptor')
      const chars = b[at + 18]
      const lFi = b[at + 19]
      const icb = b.readUInt32LE(at + 20 + 4)
      const lIu = b.readUInt16LE(at + 36)
      const nameAt = at + 38 + lIu
      if (nameAt + lFi > b.length) fail('a file name runs past its directory')
      if (!(chars & 0x0c) && lFi) out.push({ name: dstring(b.subarray(nameAt, nameAt + lFi)), dir: !!(chars & 2), lbn: icb })
      at += (38 + lIu + lFi + 3) & ~3
      if (out.length > MAX_ENTRIES) fail('too many directory entries')
    }
    return out
  }

  /** The file entry at a path such as "sources/setup.exe" (case-insensitive), or null. */
  find(path) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length > MAX_DEPTH) fail('path too deep')
    let lbn = this.root
    for (let i = 0; i < parts.length; i++) {
      this.visited.clear()
      const hit = this.list(lbn).find(x => x.name.toLowerCase() === parts[i].toLowerCase())
      if (!hit) return null
      if (i < parts.length - 1 && !hit.dir) return null
      lbn = hit.lbn
    }
    return this.entry(lbn)
  }
}

/** OSTA compressed unicode: 8 = one byte per character, 16 = UTF-16BE. */
function dstring(b) {
  if (!b.length) return ''
  if (b[0] === 8) return b.subarray(1).toString('latin1')
  if (b[0] === 16) { const s = Buffer.from(b.subarray(1)); s.swap16?.(); return s.toString('utf16le') }
  fail('unsupported name encoding')
}

/**
 * The WIM's images, from its header's XML resource: [{ index, editionId, build, spBuild, name, arch }].
 * read(offset, len) reads the WIM's bytes (here, from inside the ISO).
 */
function wimImages(read, size) {
  if (size < 208) fail('not a WIM file (too small)')
  const h = read(0, 208)
  if (h.toString('latin1', 0, 8) !== 'MSWIM\0\0\0') fail('not a WIM file')
  const xmlSize = Number(h.readBigUInt64LE(72) & 0x00ffffffffffffffn)
  const xmlOffset = Number(h.readBigUInt64LE(80))
  if (!xmlSize || xmlSize > MAX_XML || xmlOffset + xmlSize > size) fail('the WIM\'s XML metadata is missing or out of range')
  let xml = read(xmlOffset, xmlSize).toString('utf16le')
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1)
  const images = []
  for (const m of xml.matchAll(/<IMAGE\s+INDEX="(\d+)">([\s\S]*?)<\/IMAGE>/g)) {
    const get = tag => (m[2].match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1]
    images.push({ index: Number(m[1]), editionId: get('EDITIONID'), build: Number(get('BUILD')), spBuild: Number(get('SPBUILD')), name: get('NAME'), arch: Number(get('ARCH')) })
    if (images.length > 64) break
  }
  if (!images.length) fail('the WIM lists no images')
  return images
}

/**
 * Inspects a Windows install ISO: extracts setup.exe and sources\setup.exe (capped) into outDir for a signature check,
 * and reads the install image's editions and build. Returns { files: [path], images }.
 */
function inspect(iso, outDir, { maxFile = 64 * 1024 * 1024 } = {}) {
  const u = new Udf(iso)
  try {
    u.open()
    const files = []
    fs.mkdirSync(outDir, { recursive: true })
    for (const [path, name] of [['setup.exe', 'setup.exe'], ['sources/setup.exe', 'sources-setup.exe']]) {
      const e = u.find(path)
      if (!e || e.dir) fail(`${path} is missing`)
      if (e.length > maxFile) fail(`${path} is larger than expected`)
      const out = `${outDir}\\${name}`
      fs.writeFileSync(out, u.readFile(e, 0, e.length))
      files.push(out)
    }
    const wim = u.find('sources/install.wim') || u.find('sources/install.esd')
    if (!wim || wim.dir) fail('sources\\install.wim (or .esd) is missing')
    const images = wimImages((o, l) => u.readFile(wim, o, l), wim.length)
    return { files, images }
  } finally {
    u.close()
  }
}

module.exports = { Udf, inspect, wimImages, IsoError, SECTOR }
