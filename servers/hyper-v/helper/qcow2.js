/**
 * A small, bounded qcow2 reader that writes a dynamic VHD (MC-1501). The distros' cloud images come as qcow2 (Debian's
 * genericcloud, Ubuntu's server-cloudimg); Hyper-V takes VHD or VHDX, and hv.ps1 'vhd-convert' (Hyper-V's own
 * Convert-VHD) turns this VHD into the base VHDX. Nothing is installed or run on the host for it: this file is the
 * converter, Node built-ins only.
 *
 * It reads only what it must and checks every offset against the file's size before reading. It refuses:
 * - a version other than 2 or 3, a cluster size outside 512 B-2 MB;
 * - a backing file, encryption, snapshots, any incompatible feature (dirty, corrupt, external data file, a compression
 *   type such as zstd, extended L2 entries);
 * - a virtual size that isn't a whole number of sectors, or is over the caller's cap;
 * - an L1 table too small for the virtual size, or a table or cluster outside the file or unaligned;
 * - a compressed cluster that doesn't inflate to exactly one cluster (zlib's raw deflate, capped at one cluster).
 * Unallocated and all-zero clusters read as zeros; a VHD block that is all zeros stays unallocated.
 *
 * Async throughout (fs.promises): a conversion of a few GB must never block the helper's event loop, whose heartbeat
 * the service host watches.
 */
const fs = require('fs')
const zlib = require('zlib')
const crypto = require('crypto')

const MAGIC = 0x514649fb // 'QFI\xfb'
const SECTOR = 512
const VHD_BLOCK = 2 * 1024 * 1024
const VHD_MAX = 2040 * 1024 ** 3 // VHD's own limit
const OFFSET_MASK = 0x00fffffffffffe00n // bits 9-55: a standard L1 or L2 entry's host offset
const L2_COMPRESSED = 1n << 62n
const L2_ZERO = 1n // v3: the cluster reads as zeros
const MAX_L1_ENTRIES = 32 * 1024 * 1024 // 256 MB of L1: far past any image we take

class Qcow2Error extends Error {}
const bad = m => { throw new Qcow2Error(`not an acceptable qcow2 image: ${m}`) }

async function readAt(fh, size, pos, len) {
  if (pos < 0 || len < 0 || pos + len > size) bad(`a read at ${pos} (+${len}) is past the file's end (${size})`)
  const buf = Buffer.alloc(len)
  let got = 0
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got)
    if (!bytesRead) bad('the file ended early')
    got += bytesRead
  }
  return buf
}

/** Parses and checks the header. Returns the image's geometry; never reads past it. */
async function header(fh, fileSize, { maxVirtualBytes }) {
  if (fileSize < 72) bad('too short for a header')
  const h = await readAt(fh, fileSize, 0, Math.min(fileSize, 112))
  if (h.readUInt32BE(0) !== MAGIC) bad('no qcow2 magic')
  const version = h.readUInt32BE(4)
  if (version !== 2 && version !== 3) bad(`version ${version} (only 2 and 3)`)
  if (h.readBigUInt64BE(8) !== 0n || h.readUInt32BE(16) !== 0) bad('it names a backing file')
  const clusterBits = h.readUInt32BE(20)
  if (clusterBits < 9 || clusterBits > 21) bad(`cluster bits ${clusterBits}`)
  const virtualSize = h.readBigUInt64BE(24)
  if (h.readUInt32BE(32) !== 0) bad('it is encrypted')
  const l1Size = h.readUInt32BE(36)
  const l1Offset = h.readBigUInt64BE(40)
  if (h.readUInt32BE(60) !== 0) bad('it holds internal snapshots')
  if (version === 3) {
    if (h.length < 104) bad('a version 3 header is too short')
    const incompatible = h.readBigUInt64BE(72)
    if (incompatible !== 0n) bad(`it sets incompatible features (0x${incompatible.toString(16)}: dirty, corrupt, an external data file, another compression type or extended L2)`)
    const headerLength = h.readUInt32BE(100)
    if (headerLength < 104 || headerLength > fileSize) bad(`header length ${headerLength}`)
    // Byte 104, when present, is the compression type: only 0 (zlib). Bit 3 of incompatible would be set otherwise,
    // but check it too.
    if (headerLength > 104 && h.length > 104 && h[104] !== 0) bad(`compression type ${h[104]} (only zlib)`)
  }
  const clusterSize = 1 << clusterBits
  if (virtualSize === 0n || virtualSize % BigInt(SECTOR) !== 0n) bad(`virtual size ${virtualSize} is not a whole number of sectors`)
  if (virtualSize > BigInt(Math.min(maxVirtualBytes, VHD_MAX))) bad(`virtual size ${virtualSize} bytes is over the cap of ${Math.min(maxVirtualBytes, VHD_MAX)}`)
  const vsize = Number(virtualSize)
  const l2Entries = clusterSize / 8
  const need = Math.ceil(vsize / (clusterSize * l2Entries))
  if (l1Size < need || l1Size > MAX_L1_ENTRIES) bad(`L1 has ${l1Size} entries; ${need} are needed`)
  const l1Pos = Number(l1Offset)
  if (l1Offset % BigInt(clusterSize) !== 0n || l1Pos + l1Size * 8 > fileSize) bad('its L1 table is outside the file or unaligned')
  return { version, clusterBits, clusterSize, virtualSize: vsize, l1Size, l1Pos, l2Entries }
}

/**
 * Opens a qcow2 image for reading by guest offset. Returns { info, readCluster(index) → Buffer|null (null: zeros),
 * close() }. The L1 table is read once; L2 tables are cached one at a time (a sequential read touches each once).
 */
async function open(file, { maxVirtualBytes = VHD_MAX } = {}) {
  const fh = await fs.promises.open(file, 'r')
  try {
    const fileSize = (await fh.stat()).size
    const g = await header(fh, fileSize, { maxVirtualBytes })
    const l1 = await readAt(fh, fileSize, g.l1Pos, g.l1Size * 8)
    const clusterOk = off => off % g.clusterSize === 0 && off < fileSize
    let l2Cache = { index: -1, table: null }
    const l2For = async l1Index => {
      if (l2Cache.index === l1Index) return l2Cache.table
      const e = l1.readBigUInt64BE(l1Index * 8)
      const off = Number(e & OFFSET_MASK)
      let table = null
      if (off) {
        if (off % g.clusterSize !== 0 || off + g.clusterSize > fileSize) bad(`L1 entry ${l1Index} points outside the file`)
        table = await readAt(fh, fileSize, off, g.clusterSize)
      }
      l2Cache = { index: l1Index, table }
      return table
    }
    const x = 62 - (g.clusterBits - 8) // a compressed descriptor's split between offset and sector count
    const readCluster = async index => {
      const guestOff = index * g.clusterSize
      if (guestOff >= g.virtualSize) bad(`cluster ${index} is past the virtual size`)
      const table = await l2For(Math.floor(index / g.l2Entries))
      if (!table) return null
      const e = table.readBigUInt64BE((index % g.l2Entries) * 8)
      if (e & L2_COMPRESSED) {
        const desc = e & ((1n << 62n) - 1n)
        const hostOff = Number(desc & ((1n << BigInt(x)) - 1n))
        const sectors = Number(desc >> BigInt(x)) + 1
        const len = sectors * SECTOR - (hostOff % SECTOR)
        if (len <= 0 || len > g.clusterSize * 2 + SECTOR) bad(`compressed cluster ${index} has a bad length`)
        // A compressed cluster's sectors may run up to the file's end, where the last sector can be short.
        const avail = Math.min(len, fileSize - hostOff)
        if (hostOff >= fileSize || avail <= 0) bad(`compressed cluster ${index} is outside the file`)
        const raw = await readAt(fh, fileSize, hostOff, avail)
        let out
        try { out = zlib.inflateRawSync(raw, { maxOutputLength: g.clusterSize, finishFlush: zlib.constants.Z_SYNC_FLUSH }) } catch (err) { bad(`compressed cluster ${index} doesn't inflate (${err.message})`) }
        if (out.length !== g.clusterSize) bad(`compressed cluster ${index} inflates to ${out.length} bytes, not ${g.clusterSize}`)
        return out
      }
      if (g.version === 3 && (e & L2_ZERO)) return null
      if (e & (g.version === 3 ? 0x3f00_0000_0000_01fen : 0x3f00_0000_0000_01ffn)) bad(`L2 entry for cluster ${index} sets reserved bits`)
      const off = Number(e & OFFSET_MASK)
      if (!off) return null
      if (!clusterOk(off)) bad(`cluster ${index} is outside the file or unaligned`)
      // The image's last cluster may be short in the file (qemu doesn't pad it): what's missing reads as zeros.
      const len = Math.min(g.clusterSize, fileSize - off)
      const data = await readAt(fh, fileSize, off, len)
      return len === g.clusterSize ? data : Buffer.concat([data, Buffer.alloc(g.clusterSize - len)])
    }
    return { info: { ...g, fileSize }, readCluster, close: () => fh.close() }
  } catch (e) {
    await fh.close().catch(() => {})
    throw e
  }
}

// ---------- VHD (dynamic) ----------

const VHD_EPOCH = Date.UTC(2000, 0, 1) / 1000

/** CHS geometry for a VHD footer, as the VHD specification's algorithm gives it. */
function geometry(size) {
  let total = Math.floor(size / SECTOR)
  if (total > 65535 * 16 * 255) total = 65535 * 16 * 255
  let spt, heads, cth
  if (total >= 65535 * 16 * 63) { spt = 255; heads = 16; cth = Math.floor(total / spt) } else {
    spt = 17
    cth = Math.floor(total / spt)
    heads = Math.floor((cth + 1023) / 1024)
    if (heads < 4) heads = 4
    if (cth >= heads * 1024 || heads > 16) { spt = 31; heads = 16; cth = Math.floor(total / spt) }
    if (cth >= heads * 1024) { spt = 63; heads = 16; cth = Math.floor(total / spt) }
  }
  return { cylinders: Math.floor(cth / heads), heads, spt }
}

const checksum = buf => { let s = 0; for (const b of buf) s += b; return (~s) >>> 0 }

function footer(size, now) {
  const f = Buffer.alloc(512)
  f.write('conectix', 0, 'ascii')
  f.writeUInt32BE(2, 8) // features: reserved bit
  f.writeUInt32BE(0x00010000, 12)
  f.writeBigUInt64BE(512n, 16) // the dynamic header's offset
  f.writeUInt32BE(Math.max(0, Math.floor(now / 1000 - VHD_EPOCH)) >>> 0, 24)
  f.write('hvmc', 28, 'ascii')
  f.writeUInt32BE(0x00010000, 32)
  f.write('Wi2k', 36, 'ascii')
  f.writeBigUInt64BE(BigInt(size), 40)
  f.writeBigUInt64BE(BigInt(size), 48)
  const g = geometry(size)
  f.writeUInt16BE(g.cylinders, 56); f[58] = g.heads; f[59] = g.spt
  f.writeUInt32BE(3, 60) // dynamic
  crypto.randomBytes(16).copy(f, 68)
  f.writeUInt32BE(checksum(f), 64)
  return f
}

function dynamicHeader(tableOffset, entries) {
  const h = Buffer.alloc(1024)
  h.write('cxsparse', 0, 'ascii')
  h.writeBigUInt64BE(0xffffffffffffffffn, 8)
  h.writeBigUInt64BE(BigInt(tableOffset), 16)
  h.writeUInt32BE(0x00010000, 24)
  h.writeUInt32BE(entries, 28)
  h.writeUInt32BE(VHD_BLOCK, 32)
  h.writeUInt32BE(checksum(h), 36)
  return h
}

const isZero = b => { for (let i = 0; i < b.length; i++) if (b[i]) return false; return true }

/**
 * Converts a qcow2 image to a new dynamic VHD at `out` (created with 'wx': never over an existing file). Returns
 * { virtualSize, blocks, written }. progress(text) is told every 256 MB.
 */
async function toVhd(input, out, { maxVirtualBytes = VHD_MAX, progress = () => {}, now = Date.now() } = {}) {
  const q = await open(input, { maxVirtualBytes })
  const { virtualSize, clusterSize } = q.info
  const entries = Math.ceil(virtualSize / VHD_BLOCK)
  const tableOffset = 512 + 1024
  const tableBytes = Math.ceil(entries * 4 / SECTOR) * SECTOR
  const bat = Buffer.alloc(tableBytes, 0xff)
  const fh = await fs.promises.open(out, 'wx')
  let ok = false
  try {
    const foot = footer(virtualSize, now)
    let pos = tableOffset + tableBytes
    const bitmap = Buffer.alloc(SECTOR, 0xff) // 4096 sectors per 2 MB block: 512 bytes of bitmap, every sector present
    let blocks = 0
    let lastNote = 0
    for (let b = 0; b < entries; b++) {
      const start = b * VHD_BLOCK
      const len = Math.min(VHD_BLOCK, virtualSize - start)
      const block = Buffer.alloc(VHD_BLOCK)
      let any = false
      // Block and cluster sizes are both powers of two; a block holds whole clusters or lies inside one.
      for (let off = 0; off < len; off += Math.min(clusterSize, VHD_BLOCK)) {
        const gOff = start + off
        const c = await q.readCluster(Math.floor(gOff / clusterSize))
        if (!c) continue
        const from = gOff % clusterSize
        const n = Math.min(clusterSize - from, VHD_BLOCK - off, len - off)
        const part = c.subarray(from, from + n)
        if (!isZero(part)) { part.copy(block, off); any = true }
      }
      if (any) {
        bat.writeUInt32BE(pos / SECTOR, b * 4)
        await fh.write(bitmap, 0, SECTOR, pos)
        await fh.write(block, 0, VHD_BLOCK, pos + SECTOR)
        pos += SECTOR + VHD_BLOCK
        blocks++
      }
      if (start - lastNote >= 256 * 1024 * 1024) { lastNote = start; progress(`converted ${(start / 1024 ** 3).toFixed(1)} of ${(virtualSize / 1024 ** 3).toFixed(1)} GB`) }
    }
    await fh.write(foot, 0, 512, 0)
    await fh.write(dynamicHeader(tableOffset, entries), 0, 1024, 512)
    await fh.write(bat, 0, tableBytes, tableOffset)
    await fh.write(foot, 0, 512, pos)
    await fh.sync()
    ok = true
    return { virtualSize, blocks, written: pos + 512 }
  } finally {
    await fh.close().catch(() => {})
    await q.close().catch(() => {})
    if (!ok) await fs.promises.rm(out, { force: true }).catch(() => {})
  }
}

module.exports = { open, toVhd, geometry, Qcow2Error, VHD_BLOCK }
