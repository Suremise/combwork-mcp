// Linux images (MC-1501): the qcow2 reader and its VHD output, and linux-images.prepare with the user's own file
// (MC-1572: no pins, no downloads, no checksum or signature fetching).
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const qcow2 = require('../helper/qcow2')
const linux = require('../helper/linux-images')
const { BASE } = require('./helpers')

let n = 0
const tmpDir = name => { const d = path.join(BASE, `${process.pid}-li-${++n}-${name}`); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); return d }

// ---------- a qcow2 writer for the tests ----------

/**
 * Builds a qcow2 image: clusters is a Map of cluster index → { data: Buffer } | { zero: true } | { compressed: Buffer }.
 * Layout: header in cluster 0, L1 in cluster 1, then the L2 tables, then data. over: header fields to override.
 */
function makeQcow2({ virtualSize, clusterBits = 16, version = 3, clusters = new Map(), over = {}, l1Size: l1Force }) {
  const cs = 1 << clusterBits
  const l2Entries = cs / 8
  const l1Size = l1Force ?? Math.ceil(virtualSize / (cs * l2Entries))
  const l1Clusters = Math.max(1, Math.ceil(l1Size * 8 / cs))
  const l1Off = cs
  let next = (1 + l1Clusters) * cs
  const l2Off = new Map()
  for (const idx of clusters.keys()) {
    const l1i = Math.floor(idx / l2Entries)
    if (!l2Off.has(l1i)) { l2Off.set(l1i, next); next += cs }
  }
  const parts = []
  const l1 = Buffer.alloc(l1Clusters * cs)
  for (const [l1i, off] of l2Off) l1.writeBigUInt64BE(BigInt(off) | (1n << 63n), l1i * 8)
  const l2 = new Map([...l2Off.keys()].map(k => [k, Buffer.alloc(cs)]))
  const x = 62 - (clusterBits - 8)
  for (const [idx, c] of clusters) {
    const t = l2.get(Math.floor(idx / l2Entries))
    const at = (idx % l2Entries) * 8
    if (c.zero) { t.writeBigUInt64BE(1n, at); continue }
    if (c.compressed) {
      const z = zlib.deflateRawSync(c.compressed)
      const off = next
      const sectors = Math.ceil(z.length / 512)
      t.writeBigUInt64BE((1n << 62n) | (BigInt(sectors - 1) << BigInt(x)) | BigInt(off), at)
      const padded = Buffer.alloc(Math.ceil(sectors * 512 / cs) * cs)
      z.copy(padded)
      parts.push([off, padded])
      next += padded.length
      continue
    }
    const off = next
    t.writeBigUInt64BE(BigInt(off) | (1n << 63n), at)
    const d = Buffer.alloc(cs)
    c.data.copy(d)
    parts.push([off, d])
    next += cs
  }
  const out = Buffer.alloc(next)
  const h = out
  h.writeUInt32BE(0x514649fb, 0)
  h.writeUInt32BE(version, 4)
  h.writeUInt32BE(clusterBits, 20)
  h.writeBigUInt64BE(BigInt(virtualSize), 24)
  h.writeUInt32BE(l1Size, 36)
  h.writeBigUInt64BE(BigInt(l1Off), 40)
  if (version === 3) { h.writeUInt32BE(4, 96); h.writeUInt32BE(104, 100) }
  for (const [k, v] of Object.entries(over)) {
    const [pos, kind] = { backing: [8, 'u64'], crypt: [32, 'u32'], snapshots: [60, 'u32'], incompatible: [72, 'u64'], magic: [0, 'u32'], version: [4, 'u32'], l1Offset: [40, 'u64'] }[k]
    if (kind === 'u64') h.writeBigUInt64BE(BigInt(v), pos); else h.writeUInt32BE(v, pos)
  }
  l1.copy(out, l1Off)
  for (const [k, off] of l2Off) l2.get(k).copy(out, off)
  for (const [off, d] of parts) d.copy(out, off)
  return out
}

/** Reads a dynamic VHD back to its raw disk (checks the footer, header and their checksums). */
function readVhd(file) {
  const b = fs.readFileSync(file)
  const sum = buf => { let s = 0; for (const x of buf) s += x; return (~s) >>> 0 }
  const foot = b.subarray(b.length - 512)
  assert.strictEqual(foot.toString('ascii', 0, 8), 'conectix')
  assert.ok(foot.equals(b.subarray(0, 512)), 'the footer copy at the start matches the one at the end')
  const f2 = Buffer.from(foot); f2.writeUInt32BE(0, 64)
  assert.strictEqual(foot.readUInt32BE(64), sum(f2), 'footer checksum')
  assert.strictEqual(foot.readUInt32BE(60), 3, 'dynamic')
  const size = Number(foot.readBigUInt64BE(48))
  const dh = b.subarray(512, 1536)
  assert.strictEqual(dh.toString('ascii', 0, 8), 'cxsparse')
  const d2 = Buffer.from(dh); d2.writeUInt32BE(0, 36)
  assert.strictEqual(dh.readUInt32BE(36), sum(d2), 'dynamic header checksum')
  const table = Number(dh.readBigUInt64BE(16))
  const entries = dh.readUInt32BE(28)
  const block = dh.readUInt32BE(32)
  const raw = Buffer.alloc(size)
  let allocated = 0
  for (let i = 0; i < entries; i++) {
    const s = b.readUInt32BE(table + i * 4)
    if (s === 0xffffffff) continue
    allocated++
    const data = b.subarray(s * 512 + 512, s * 512 + 512 + block)
    data.copy(raw, i * block, 0, Math.min(block, size - i * block))
  }
  return { raw, size, allocated, entries }
}

const fill = (len, seed) => { const b = Buffer.alloc(len); for (let i = 0; i < len; i++) b[i] = (i * 31 + seed) & 0xff || 1; return b }

test('qcow2 to VHD: data, compressed, zero and unallocated clusters all read back exactly; empty blocks stay unallocated', async () => {
  const d = tmpDir('convert')
  const cs = 1 << 16
  const virtualSize = 10 * 1024 * 1024 // 5 VHD blocks, 160 clusters
  const clusters = new Map([
    [0, { data: fill(cs, 1) }],
    [1, { compressed: fill(cs, 2) }],
    [2, { zero: true }],
    [40, { data: fill(cs, 3) }], // block 1
    [159, { compressed: Buffer.alloc(cs, 7) }] // the last cluster, in block 4
  ])
  const q = path.join(d, 'a.qcow2')
  fs.writeFileSync(q, makeQcow2({ virtualSize, clusters }))
  const out = path.join(d, 'a.vhd')
  const r = await qcow2.toVhd(q, out)
  assert.strictEqual(r.virtualSize, virtualSize)
  const v = readVhd(out)
  assert.strictEqual(v.size, virtualSize)
  assert.strictEqual(v.entries, 5)
  assert.strictEqual(v.allocated, 3, 'blocks 2 and 3 hold no data and stay unallocated')
  const want = Buffer.alloc(virtualSize)
  fill(cs, 1).copy(want, 0); fill(cs, 2).copy(want, cs); fill(cs, 3).copy(want, 40 * cs); Buffer.alloc(cs, 7).copy(want, 159 * cs)
  assert.ok(v.raw.equals(want), 'the raw disk is the qcow2\'s guest view')
  await assert.rejects(qcow2.toVhd(q, out), /EEXIST/, 'never written over an existing file')
})

test('qcow2: version 2, a 512-byte cluster size, and a virtual size that isn\'t a whole number of VHD blocks', async () => {
  const d = tmpDir('v2')
  const virtualSize = 3 * 1024 * 1024 + 512 * 3
  const cs = 512
  const clusters = new Map([[0, { data: fill(cs, 9) }], [Math.floor((virtualSize - 1) / cs), { data: fill(cs, 4) }]])
  const q = path.join(d, 'b.qcow2')
  fs.writeFileSync(q, makeQcow2({ virtualSize, clusterBits: 9, version: 2, clusters }))
  await qcow2.toVhd(q, path.join(d, 'b.vhd'))
  const v = readVhd(path.join(d, 'b.vhd'))
  assert.strictEqual(v.size, virtualSize)
  assert.ok(v.raw.subarray(0, cs).equals(fill(cs, 9)))
  assert.ok(v.raw.subarray(virtualSize - cs).equals(fill(cs, 4)))
})

test('qcow2 refusals: magic, version, backing file, encryption, snapshots, incompatible features, size, L1 and cluster bounds, bad compression, reserved bits', async () => {
  const d = tmpDir('refuse')
  const vs = 4 * 1024 * 1024
  const one = new Map([[0, { data: fill(65536, 5) }]])
  const cases = [
    ['magic', makeQcow2({ virtualSize: vs, over: { magic: 0x12345678 } }), /no qcow2 magic/],
    ['version 1', makeQcow2({ virtualSize: vs, over: { version: 1 } }), /version 1/],
    ['backing', makeQcow2({ virtualSize: vs, over: { backing: 512 } }), /backing file/],
    ['encrypted', makeQcow2({ virtualSize: vs, over: { crypt: 1 } }), /encrypted/],
    ['snapshots', makeQcow2({ virtualSize: vs, over: { snapshots: 1 } }), /snapshots/],
    ['dirty', makeQcow2({ virtualSize: vs, over: { incompatible: 1 } }), /incompatible features/],
    ['zstd', makeQcow2({ virtualSize: vs, over: { incompatible: 8 } }), /incompatible features/],
    ['extended L2', makeQcow2({ virtualSize: vs, over: { incompatible: 16 } }), /incompatible features/],
    ['odd size', makeQcow2({ virtualSize: vs + 1 }), /whole number of sectors/],
    ['L1 too small', makeQcow2({ virtualSize: 2 * 8192 * 65536, l1Size: 1 }), /L1 has 1 entries; 2 are needed/],
    ['L1 outside', makeQcow2({ virtualSize: vs, over: { l1Offset: 65536 * 99 } }), /L1 table is outside/],
    ['too short', Buffer.alloc(40), /too short/]
  ]
  for (const [name, buf, re] of cases) {
    const f = path.join(d, `${name}.qcow2`)
    fs.writeFileSync(f, buf)
    await assert.rejects(qcow2.toVhd(f, path.join(d, `${name}.vhd`)), re, name)
    assert.ok(!fs.existsSync(path.join(d, `${name}.vhd`)), `${name}: no VHD left behind`)
  }
  // Over the caller's cap.
  const big = path.join(d, 'big.qcow2')
  fs.writeFileSync(big, makeQcow2({ virtualSize: vs, clusters: one }))
  await assert.rejects(qcow2.toVhd(big, path.join(d, 'big.vhd'), { maxVirtualBytes: vs - 512 }), /over the cap/)
  // An L2 entry pointing outside the file; reserved bits; a compressed cluster that doesn't inflate to one cluster.
  const corrupt = (mutate, name, re) => async () => {
    const buf = makeQcow2({ virtualSize: vs, clusters: new Map([[0, { data: fill(65536, 5) }], [1, { compressed: fill(65536, 6) }]]) })
    const l2 = Number(buf.readBigUInt64BE(65536) & 0x00fffffffffffe00n)
    mutate(buf, l2)
    const f = path.join(d, `${name}.qcow2`)
    fs.writeFileSync(f, buf)
    await assert.rejects(qcow2.toVhd(f, path.join(d, `${name}.vhd`)), re, name)
  }
  await corrupt((b, l2) => b.writeBigUInt64BE((1n << 63n) | (1000n * 65536n), l2), 'l2-outside', /outside the file/)()
  await corrupt((b, l2) => b.writeBigUInt64BE(b.readBigUInt64BE(l2) | (1n << 57n), l2), 'reserved', /reserved bits/)()
  await corrupt((b, l2) => { const e = b.readBigUInt64BE(l2 + 8); const off = Number(e & ((1n << 54n) - 1n)); b.fill(0x55, off, off + 64) }, 'not-deflate', /doesn't inflate|inflates to/)()
  // A compressed cluster whose data inflates to less than a cluster.
  const short = makeQcow2({ virtualSize: vs, clusters: new Map([[0, { compressed: Buffer.alloc(1000, 1) }]]) })
  fs.writeFileSync(path.join(d, 'short.qcow2'), short)
  await assert.rejects(qcow2.toVhd(path.join(d, 'short.qcow2'), path.join(d, 'short.vhd')), /inflates to 1000 bytes/)
})

test('VHD geometry follows the specification\'s algorithm', () => {
  assert.deepStrictEqual(qcow2.geometry(10 * 1024 * 1024), { cylinders: 301, heads: 4, spt: 17 })
  assert.deepStrictEqual(qcow2.geometry(2000 * 1024 ** 3), { cylinders: 65535, heads: 16, spt: 255 })
})

// ---------- linux-images.prepare (MC-1572: the user's own qcow2 file; no pins, no downloads) ----------

const fakeHv = async (op, a) => { assert.strictEqual(op, 'vhd-convert'); fs.copyFileSync(a.vhd, a.vhdx); return { vhdx: a.vhdx } }

test('prepare: any qcow2 file the user names is copied while hashed, converted to the base VHDX and recorded with its path; again, it is the same record', async () => {
  const d = tmpDir('prep-own')
  const img = makeQcow2({ virtualSize: 4 * 1024 * 1024, clusters: new Map([[0, { data: fill(65536, 8) }]]) })
  const local = path.join(d, 'fedora-cloud.qcow2')
  fs.writeFileSync(local, img)
  const dir = path.join(d, 'images')
  const r = await linux.prepare({ want: { file: local }, dir, hv: fakeHv })
  assert.deepStrictEqual([r.os, r.source, r.path, r.name, r.size], ['linux', 'local', fs.realpathSync.native(local), 'fedora-cloud.qcow2', img.length])
  assert.strictEqual(r.sha256, crypto.createHash('sha256').update(img).digest('hex'))
  assert.strictEqual(r.distro, undefined, 'no distro is claimed for it: its guest reports one at its build')
  assert.ok(fs.existsSync(r.file) && r.file.endsWith(`${r.sha256}.vhdx`))
  assert.strictEqual(r.vhdxSha256, await linux.hashFile(r.file))
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => !f.endsWith('.vhdx')), [], 'nothing left behind but the base VHDX')
  const again = await linux.prepare({ want: { file: local }, dir, hv: fakeHv, known: new Map([[r.sha256, r]]) })
  assert.strictEqual(again.existing, true)
  assert.match(linux.describe(r), new RegExp(`Linux image fedora-cloud\.qcow2, SHA-256 ${r.sha256.slice(0, 12)}, from .*fedora-cloud\.qcow2`))
})

test('prepare refuses: no file, a relative path, a folder, the helper\'s own folders, and a file that isn\'t an acceptable qcow2 (limits, by name)', async () => {
  const d = tmpDir('prep-refuse')
  const dir = path.join(d, 'images')
  await assert.rejects(linux.prepare({ want: { distro: 'debian' }, dir, hv: fakeHv }), /image must be \{ file/)
  await assert.rejects(linux.prepare({ want: { file: 'rel.qcow2' }, dir, hv: fakeHv }), /absolute local path/)
  await assert.rejects(linux.prepare({ want: { file: d }, dir, hv: fakeHv }), /not a plain file/)
  const own = path.join(d, 'own')
  fs.mkdirSync(own)
  fs.writeFileSync(path.join(own, 'x.qcow2'), makeQcow2({ virtualSize: 4 * 1024 * 1024 }))
  await assert.rejects(linux.prepare({ want: { file: path.join(own, 'x.qcow2') }, dir, hv: fakeHv, ownDirs: [own] }), /helper's own folders/)
  const raw = path.join(d, 'raw.img')
  fs.writeFileSync(raw, Buffer.alloc(1024 * 1024))
  await assert.rejects(linux.prepare({ want: { file: raw }, dir, hv: fakeHv }), /not an acceptable qcow2 image/)
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'a refused file leaves nothing behind')
})

test('the guest\'s report is compared only with an image recorded with a distro (the earlier pinned ones)', () => {
  assert.strictEqual(linux.guestReportProblem({ id: 'fedora', versionId: '43' }, { sha256: 'a' }), null)
  assert.strictEqual(linux.guestReportProblem({ id: 'ubuntu', versionId: '26.04' }, { distro: 'debian', release: '13' }), 'the guest says it is ubuntu, the image debian')
  assert.strictEqual(linux.guestReportProblem(null, {}), 'no report')
  for (const d of ['debian', 'ubuntu', 'fedora', 'opensuse-leap', 'rhel']) assert.ok(linux.DISTRO_RE.test(d), d)
  for (const d of ['', 'Debian', '../x', 'a b', 'x'.repeat(40)]) assert.ok(!linux.DISTRO_RE.test(d), d)
})
