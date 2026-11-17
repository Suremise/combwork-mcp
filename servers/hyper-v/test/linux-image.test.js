// Linux images (MC-1501): the qcow2 reader and its VHD output, the OpenPGP check of Ubuntu's signed checksums (against
// the real SHA256SUMS and SHA256SUMS.gpg of the pinned release, and crafted signatures), and linux-images.prepare's
// pin, checksum and signature rules with a fake download.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const qcow2 = require('../helper/qcow2')
const openpgp = require('../helper/openpgp')
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

// ---------- OpenPGP ----------

const FIX = path.join(__dirname, 'fixtures', 'ubuntu')
const SUMS = fs.readFileSync(path.join(FIX, 'SHA256SUMS'))
const SIG = fs.readFileSync(path.join(FIX, 'SHA256SUMS.gpg'))

test('the pinned Ubuntu key verifies the real SHA256SUMS.gpg of the pinned release, which names the pinned image\'s hash', () => {
  const r = openpgp.verifyDetached(SUMS, SIG, 'ubuntu-cloud-images', { now: Date.parse('2026-11-17T00:00:00Z') })
  assert.strictEqual(r.fingerprint, 'D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81')
  assert.strictEqual(r.hash, 'sha512')
  const pin = linux.PINNED_LINUX.find(p => p.distro === 'ubuntu')
  assert.strictEqual(linux.sumFor(SUMS.toString(), pin.file, 'sha256'), pin.sha256)
})

test('OpenPGP refusals: a changed file, a changed signature, its armor\'s checksum, a signature from the future, and a key that isn\'t pinned', () => {
  const now = Date.now()
  const changed = Buffer.from(SUMS); changed[100] ^= 1
  assert.throws(() => openpgp.verifyDetached(changed, SIG, 'ubuntu-cloud-images', { now }), /digest does not match/)
  // The signature's MPI changed (its check bytes still match the file): the RSA check fails.
  const raw = openpgp.dearmor(SIG, 'SIGNATURE')
  const evil = Buffer.from(raw); evil[evil.length - 10] ^= 0x40
  assert.throws(() => openpgp.verifyDetached(SUMS, evil, 'ubuntu-cloud-images', { now }), /RSA signature is not valid/)
  // The armor's own CRC-24.
  const text = SIG.toString('latin1').replace(/\n=([A-Za-z0-9+/]{4})/, (_, c) => `\n=${c === 'AAAA' ? 'AAAB' : 'AAAA'}`)
  assert.throws(() => openpgp.verifyDetached(SUMS, Buffer.from(text, 'latin1'), 'ubuntu-cloud-images', { now }), /armor's checksum/)
  // Made "in the future" relative to the clock.
  assert.throws(() => openpgp.verifyDetached(SUMS, SIG, 'ubuntu-cloud-images', { now: Date.parse('2026-11-01T00:00:00Z') }), /in the future/)
  // A valid signature by another key, and the pinned key's slot faked with another packet.
  const k = testKey()
  const sig = signDetached(SUMS, k)
  assert.throws(() => openpgp.verifyDetached(SUMS, sig, 'ubuntu-cloud-images', { now }), /issuer .* is not the pinned key/)
  const saved = openpgp.KEYS['ubuntu-cloud-images'].packet
  try {
    openpgp.KEYS['ubuntu-cloud-images'].packet = k.packet.toString('base64')
    assert.throws(() => openpgp.verifyDetached(SUMS, sig, 'ubuntu-cloud-images', { now }), /doesn't match its fingerprint/)
  } finally { openpgp.KEYS['ubuntu-cloud-images'].packet = saved }
  // Two packets, and a non-signature packet.
  assert.throws(() => openpgp.verifyDetached(SUMS, Buffer.concat([raw, raw]), 'ubuntu-cloud-images', { now }), /exactly one signature packet/)
  assert.throws(() => openpgp.verifyDetached(SUMS, Buffer.from([0xc0 | 13, 1, 0x41]), 'ubuntu-cloud-images', { now }), /exactly one signature packet/)
})

test('OpenPGP: a test key added to the table verifies its own signatures, and refuses expired, text-mode, unknown-critical and SHA-1 ones', () => {
  const k = testKey()
  openpgp.KEYS.test = { fingerprint: k.fingerprint, packet: k.packet.toString('base64') }
  try {
    const now = Date.now()
    assert.strictEqual(openpgp.verifyDetached(SUMS, signDetached(SUMS, k), 'test', { now }).fingerprint, k.fingerprint)
    assert.throws(() => openpgp.verifyDetached(SUMS, signDetached(SUMS, k, { expiresIn: 1, created: now / 1000 - 10 }), 'test', { now }), /expired/)
    assert.throws(() => openpgp.verifyDetached(SUMS, signDetached(SUMS, k, { type: 1 }), 'test', { now }), /not a binary document signature/)
    assert.throws(() => openpgp.verifyDetached(SUMS, signDetached(SUMS, k, { critical: 99 }), 'test', { now }), /unknown critical subpacket/)
    assert.throws(() => openpgp.verifyDetached(SUMS, signDetached(SUMS, k, { hashAlg: 2 }), 'test', { now }), /hash algorithm 2/)
    assert.throws(() => openpgp.verifyDetached(SUMS, signDetached(SUMS, k, { noCreated: true }), 'test', { now }), /no hashed creation time/)
  } finally { delete openpgp.KEYS.test }
})

/** An RSA key as a v4 OpenPGP public-key packet body, with its fingerprint. */
function testKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  const mpiOf = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); const bits = (b.length - 1) * 8 + (32 - Math.clz32(b[0])); const h = Buffer.alloc(2); h.writeUInt16BE(bits); return Buffer.concat([h, b]) }
  const head = Buffer.alloc(6); head[0] = 4; head.writeUInt32BE(1700000000, 1); head[5] = 1
  const packet = Buffer.concat([head, mpiOf(Buffer.from(jwk.n, 'base64url')), mpiOf(Buffer.from(jwk.e, 'base64url'))])
  const pre = Buffer.alloc(3); pre[0] = 0x99; pre.writeUInt16BE(packet.length, 1)
  const fingerprint = crypto.createHash('sha1').update(pre).update(packet).digest('hex').toUpperCase()
  return { privateKey, packet, fingerprint, mpiOf }
}

/** A v4 detached signature packet (binary) by key k, with knobs for the refusals. */
function signDetached(data, k, { type = 0, hashAlg = 10, created = Math.floor(Date.now() / 1000) - 60, expiresIn, critical, noCreated } = {}) {
  const sub = (t, body, crit) => Buffer.concat([Buffer.from([body.length + 1, crit ? 0x80 | t : t]), body])
  const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b }
  const hashedParts = [sub(33, Buffer.concat([Buffer.from([4]), Buffer.from(k.fingerprint, 'hex')]))]
  if (!noCreated) hashedParts.push(sub(2, u32(Math.floor(created))))
  if (expiresIn) hashedParts.push(sub(3, u32(expiresIn)))
  if (critical) hashedParts.push(sub(critical, Buffer.from([1]), true))
  const hashed = Buffer.concat(hashedParts)
  const header = Buffer.concat([Buffer.from([4, type, 1, hashAlg]), Buffer.from([hashed.length >> 8, hashed.length & 0xff]), hashed])
  const trailer = Buffer.concat([Buffer.from([4, 0xff]), u32(header.length)])
  const alg = { 2: 'sha1', 8: 'sha256', 10: 'sha512' }[hashAlg]
  const digest = crypto.createHash(alg).update(data).update(header).update(trailer).digest()
  const sig = crypto.sign(alg, Buffer.concat([data, header, trailer]), { key: k.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING })
  const body = Buffer.concat([header, Buffer.from([0, 0]), digest.subarray(0, 2), k.mpiOf(sig)])
  const len = body.length
  return Buffer.concat([Buffer.from([0xc2, 0xff]), u32(len), body])
}

// ---------- linux-images.prepare ----------

/** A fake download: URL → Buffer; records the calls with their sameHost flag. */
function fakeFetch(map, calls = []) {
  const { Readable } = require('stream')
  return async (u, { sameHost }) => {
    calls.push({ u, sameHost })
    if (map[u] === undefined) throw new Error(`${new URL(u).hostname} answered HTTP 404`)
    return Readable.from([map[u]])
  }
}
const fakeHv = async (op, a) => { assert.strictEqual(op, 'vhd-convert'); fs.copyFileSync(a.vhd, a.vhdx); return { vhdx: a.vhdx } }

function pins(img) {
  const sha256 = crypto.createHash('sha256').update(img).digest('hex')
  const sha512 = crypto.createHash('sha512').update(img).digest('hex')
  return [
    { id: 'debian-13-t', distro: 'debian', release: '13', codename: 'trixie', serial: 't', name: 'Debian 13 test', file: 'd.qcow2', size: img.length, url: 'https://cloud.debian.org/x/d.qcow2', sums: { url: 'https://cloud.debian.org/x/SHA512SUMS', alg: 'sha512', signature: null }, sha512 },
    { id: 'ubuntu-26.04-t', distro: 'ubuntu', release: '26.04', codename: 'resolute', serial: 't', name: 'Ubuntu 26.04 test', file: 'u.img', size: img.length, url: 'https://cloud-images.ubuntu.com/x/u.img', sums: { url: 'https://cloud-images.ubuntu.com/x/SHA256SUMS', alg: 'sha256', signature: { url: 'https://cloud-images.ubuntu.com/x/SHA256SUMS.gpg', key: 'test' } }, sha256 }
  ]
}

test('prepare: a pinned Debian image downloaded, its SHA512SUMS line agreeing, converted to the base VHDX and recorded; the image may be redirected, its sums may not', async () => {
  const d = tmpDir('prep-debian')
  const img = makeQcow2({ virtualSize: 4 * 1024 * 1024, clusters: new Map([[0, { data: fill(65536, 8) }]]) })
  const P = pins(img)
  const calls = []
  const fetch = fakeFetch({ [P[0].url]: img, [P[0].sums.url]: Buffer.from(`${'0'.repeat(128)}  other.qcow2\n${P[0].sha512}  d.qcow2\n`) }, calls)
  const r = await linux.prepare({ want: { distro: 'debian' }, dir: d, hv: fakeHv, pins: P, fetch })
  assert.strictEqual(r.os, 'linux')
  assert.strictEqual(r.distro, 'debian')
  assert.strictEqual(r.pinned, true)
  assert.match(r.checksums, /unsigned/)
  assert.ok(fs.existsSync(r.file) && r.file.endsWith(`${r.sha256}.vhdx`))
  assert.strictEqual(r.vhdxSha256, await linux.hashFile(r.file))
  assert.deepStrictEqual(calls.map(c => c.sameHost), [false, true], 'the image may follow redirects; the checksum file may not')
  assert.deepStrictEqual(fs.readdirSync(d).filter(f => !f.endsWith('.vhdx')), [], 'nothing left behind but the base VHDX')
  // Again: already verified.
  const again = await linux.prepare({ want: { distro: 'debian' }, dir: d, hv: fakeHv, pins: P, fetch, known: new Map([[r.sha256, r]]) })
  assert.strictEqual(again.existing, true)
})

test('prepare: Ubuntu\'s SHA256SUMS must carry a valid signature by the pinned key', async () => {
  const d = tmpDir('prep-ubuntu')
  const img = makeQcow2({ virtualSize: 4 * 1024 * 1024 })
  const P = pins(img)
  const k = testKey()
  const sums = Buffer.from(`${P[1].sha256} *u.img\n`)
  openpgp.KEYS.test = { fingerprint: k.fingerprint, packet: k.packet.toString('base64') }
  try {
    const good = { [P[1].url]: img, [P[1].sums.url]: sums, [P[1].sums.signature.url]: signDetached(sums, k) }
    const r = await linux.prepare({ want: { distro: 'ubuntu' }, dir: d, hv: fakeHv, pins: P, fetch: fakeFetch(good) })
    assert.match(r.checksums, new RegExp(`signed by Ubuntu's image key ${k.fingerprint}`))
    const other = testKey()
    await assert.rejects(linux.prepare({ want: { distro: 'ubuntu' }, dir: tmpDir('prep-ubuntu2'), hv: fakeHv, pins: P, fetch: fakeFetch({ ...good, [P[1].sums.signature.url]: signDetached(sums, other) }) }), /signature doesn't verify: .*not the pinned key/)
    await assert.rejects(linux.prepare({ want: { distro: 'ubuntu' }, dir: tmpDir('prep-ubuntu3'), hv: fakeHv, pins: P, fetch: fakeFetch({ ...good, [P[1].sums.signature.url]: undefined }) }), /404|signature/)
  } finally { delete openpgp.KEYS.test }
})

test('prepare refuses: an unpinned file, a hash or size other than the pin\'s, sums that disagree or name it twice, and an unknown distro', async () => {
  const img = makeQcow2({ virtualSize: 4 * 1024 * 1024 })
  const P = pins(img)
  const sumsOk = Buffer.from(`${P[0].sha512}  d.qcow2\n`)
  const other = makeQcow2({ virtualSize: 8 * 1024 * 1024 })
  await assert.rejects(linux.prepare({ want: { distro: 'debian' }, dir: tmpDir('r1'), hv: fakeHv, pins: P, fetch: fakeFetch({ [P[0].url]: other, [P[0].sums.url]: sumsOk }) }), /doesn't match the pin/)
  await assert.rejects(linux.prepare({ want: { distro: 'debian' }, dir: tmpDir('r2'), hv: fakeHv, pins: P, fetch: fakeFetch({ [P[0].url]: img, [P[0].sums.url]: Buffer.from(`${'1'.repeat(128)}  d.qcow2\n`) }) }), /another hash than the pin/)
  await assert.rejects(linux.prepare({ want: { distro: 'debian' }, dir: tmpDir('r3'), hv: fakeHv, pins: P, fetch: fakeFetch({ [P[0].url]: img, [P[0].sums.url]: Buffer.concat([sumsOk, sumsOk]) }) }), /no single line/)
  const sized = P.map(p => ({ ...p, size: p.size + 1 }))
  await assert.rejects(linux.prepare({ want: { distro: 'debian' }, dir: tmpDir('r4'), hv: fakeHv, pins: sized, fetch: fakeFetch({ [P[0].url]: img, [P[0].sums.url]: sumsOk }) }), /not its size/)
  await assert.rejects(linux.prepare({ want: { distro: 'fedora' }, dir: tmpDir('r5'), hv: fakeHv, pins: P }), /debian or ubuntu/)
  // A local file: accepted only as a pinned image (matched by its hash), refused otherwise.
  const d = tmpDir('r6')
  const local = path.join(d, 'mine.qcow2')
  fs.writeFileSync(local, other)
  await assert.rejects(linux.prepare({ want: { file: local }, dir: path.join(d, 'images'), hv: fakeHv, pins: P, fetch: fakeFetch({}) }), /not a pinned Linux image/)
  fs.writeFileSync(local, img)
  const r = await linux.prepare({ want: { file: local }, dir: path.join(d, 'images'), hv: fakeHv, pins: P, fetch: fakeFetch({ [P[0].sums.url]: sumsOk }) })
  assert.strictEqual(r.source, 'local')
  assert.strictEqual(r.distro, 'debian')
})

test('the pinned table: dated folders on each distro\'s own host, never latest/ or current/', () => {
  for (const p of linux.PINNED_LINUX) {
    const host = p.distro === 'debian' ? 'cloud.debian.org' : 'cloud-images.ubuntu.com'
    for (const u of [p.url, p.sums.url, p.sums.signature?.url].filter(Boolean)) {
      assert.strictEqual(new URL(u).hostname, host, u)
      assert.doesNotMatch(u, /\/(latest|current)\//, u)
      assert.ok(u.includes(p.serial), `${u} is in the build ${p.serial}'s folder`)
    }
    assert.ok(p.size > 100 * 1024 * 1024)
    assert.ok(p.distro === 'debian' ? /^[0-9a-f]{128}$/.test(p.sha512) : /^[0-9a-f]{64}$/.test(p.sha256))
  }
  assert.deepStrictEqual(linux.PINNED_LINUX.map(p => p.distro).sort(), ['debian', 'ubuntu'])
})
