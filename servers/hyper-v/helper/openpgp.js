/**
 * Verifies a detached OpenPGP signature (MC-1501): Ubuntu's SHA256SUMS.gpg over its cloud images' SHA256SUMS, against
 * a key pinned here by its public-key packet and fingerprint. No gpg is run or installed: a small bounded packet parser
 * and Node's own crypto.verify (RSA PKCS#1 v1.5).
 *
 * What it accepts, and nothing more:
 * - the signature ASCII-armored (its CRC-24 checked) or binary, holding exactly one signature packet;
 * - a v4 signature of a binary document (type 0x00), by RSA (algorithm 1), hashed with SHA-256, SHA-384
 *   or SHA-512;
 * - a hashed creation time (subpacket 2), not in the future (5 minutes' grace), and not expired (subpacket 3);
 * - an issuer, hashed or not, that is the pinned key (fingerprint subpacket 33 or key id 16), and no other;
 * - no unknown critical subpacket in the hashed area;
 * - the digest's first two bytes as the packet says, then the RSA signature valid over the document and its trailer.
 * Anything else is refused with a reason.
 */
const crypto = require('crypto')

/**
 * Pinned keys. UEC Image Automatic Signing Key <cdimage@ubuntu.com>, which signs cloud-images.ubuntu.com's SHA256SUMS:
 * RSA 4096, created 2009-09-15, fingerprint D2EB 4462 6FDD C30B 513D 5BB7 1A5D 6C4C 7DB8 7C81 (fetched from
 * keyserver.ubuntu.com, its fingerprint checked, and a release's SHA256SUMS.gpg verified with it by gpg and by this
 * file: test/fixtures/ubuntu).
 */
const KEYS = {
  'ubuntu-cloud-images': {
    fingerprint: 'D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81',
    packet: 'BEqwKTUBEAC8V01JGfeYVVlwlcr0dmwF8n+We/lbxwArjR/gZlH7/MJEZnALQHUrDTpD3SkfbsjQgeNt8eS3Jyzoc2r3t2nos4rXPH4kIzAvtqslz6Ns4ZYjoHVkVC2oV8vYbxER+3/lDjTWVII7omtDVvqH33QlqYZ8+bQbs21lZb2ROJIQCiH0YzaqYR0I2SEykBL873V0ygdyW/mCMwniXTLUyGAUV4/28NOzw/6LGvJElJe4UqwQxl/aXtPIJjPka8LA8+nDi5/u6WEgDWgBhLEHvQG1BNdttm3WCjbu4zS3mNfNBidTamZfOaMJUZVYxhOB5kNQqyR4eYqFK/U+305eLrZ05ocadsmcQWkHQVbgt+g4yyFNl56N5AirkFjVtfArkUJfINGgJ7gkSeyqTJK24f33vsIpPwRQ5eFn7H4PwGc0Piym73YLJnlR94LNEG0ceOJ7u1r+WuaesIj+lKIZsG/rRLf7besaMCCtPcimVgEAmBoIdpTpdP3aa54w/dvfSwW47mGY14G5PBk/0MDy2Y5HOeXat3RXpGZZFh7zbwSQ93RhYH3bNPNd5lMu3ZRkYX19FWxoLCi5lx4K3flYhiolZ5i4KxJCoGRobsKjm74Xv2QlvCXYyAk5BnAQCsu5hKZ1sOhQADCcKz1Zbg8JRc3vmelaJ/VFvHTzs4hJTUvOowARAQAB'
  }
}

const HASHES = { 8: 'sha256', 9: 'sha384', 10: 'sha512' }
const MAX_SIG = 64 * 1024
const GRACE_MS = 5 * 60_000
const KNOWN_HASHED = new Set([2, 3, 4, 7, 9, 11, 16, 20, 21, 22, 23, 25, 27, 28, 30, 33, 34])

class PgpError extends Error {}
const no = m => { throw new PgpError(m) }

function crc24(buf) {
  let crc = 0xb704ce
  for (const b of buf) {
    crc ^= b << 16
    for (let i = 0; i < 8; i++) { crc <<= 1; if (crc & 0x1000000) crc ^= 0x1864cfb }
  }
  return crc & 0xffffff
}

/** One armored block of the given kind ('SIGNATURE', 'PUBLIC KEY BLOCK'), CRC checked; or the input if binary. */
function dearmor(input, kind) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')
  if (buf.length > MAX_SIG * 2) no('the signature file is too large')
  const text = buf.toString('latin1')
  const begin = `-----BEGIN PGP ${kind}-----`
  const at = text.indexOf(begin)
  if (at < 0) {
    if (buf[0] & 0x80) return buf // binary
    no(`no armored PGP ${kind}`)
  }
  const end = text.indexOf(`-----END PGP ${kind}-----`, at)
  if (end < 0) no(`the armored PGP ${kind} has no end line`)
  const lines = text.slice(at + begin.length, end).split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  // Armor headers ("Key: value") end at the first blank line.
  if (lines.slice(i).some(l => l.trim() === '') && /^[A-Za-z][A-Za-z-]*: /.test(lines[i] || '')) { while (i < lines.length && lines[i].trim() !== '') i++ }
  const body = []
  let crc = null
  for (const l of lines.slice(i)) {
    const t = l.trim()
    if (!t) continue
    if (t.startsWith('=') && t.length === 5) { crc = t.slice(1); break }
    if (!/^[A-Za-z0-9+/=]+$/.test(t)) no('the armor holds a line that is not base64')
    body.push(t)
  }
  const data = Buffer.from(body.join(''), 'base64')
  if (crc !== null) {
    const want = Buffer.from(crc, 'base64')
    if (want.length !== 3 || want.readUIntBE(0, 3) !== crc24(data)) no('the armor\'s checksum does not match')
  }
  return data
}

/** Splits a buffer into packets: [{ tag, body }], bounded and complete (no partial lengths). */
function packets(buf) {
  const out = []
  let p = 0
  while (p < buf.length) {
    const t = buf[p]
    if (!(t & 0x80)) no('a malformed packet header')
    let tag, len, hl
    if (t & 0x40) {
      tag = t & 0x3f
      if (p + 1 >= buf.length) no('a truncated packet header')
      const l = buf[p + 1]
      if (l < 192) { len = l; hl = 2 } else if (l < 224) { if (p + 2 >= buf.length) no('a truncated packet header'); len = ((l - 192) << 8) + buf[p + 2] + 192; hl = 3 } else if (l === 255) { if (p + 6 > buf.length) no('a truncated packet header'); len = buf.readUInt32BE(p + 2); hl = 6 } else no('partial-length packets are not accepted')
    } else {
      tag = (t >> 2) & 0x0f
      const lt = t & 3
      if (lt === 3) no('indeterminate-length packets are not accepted')
      hl = [2, 3, 5][lt]
      if (p + hl > buf.length) no('a truncated packet header')
      len = lt === 0 ? buf[p + 1] : lt === 1 ? buf.readUInt16BE(p + 1) : buf.readUInt32BE(p + 1)
    }
    if (p + hl + len > buf.length) no('a packet runs past the end')
    out.push({ tag, body: buf.subarray(p + hl, p + hl + len) })
    p += hl + len
  }
  return out
}

function mpi(buf, p) {
  if (p + 2 > buf.length) no('a truncated MPI')
  const bits = buf.readUInt16BE(p)
  const n = Math.ceil(bits / 8)
  if (p + 2 + n > buf.length) no('a truncated MPI')
  return { value: buf.subarray(p + 2, p + 2 + n), next: p + 2 + n }
}

/** A pinned key: its RSA public key and ids, the fingerprint recomputed from the packet and checked. */
function pinnedKey(name) {
  const k = KEYS[name]
  if (!k) no(`no pinned key ${name}`)
  const body = Buffer.from(k.packet, 'base64')
  const pre = Buffer.alloc(3)
  pre[0] = 0x99
  pre.writeUInt16BE(body.length, 1)
  const fpr = crypto.createHash('sha1').update(pre).update(body).digest('hex').toUpperCase()
  if (fpr !== k.fingerprint) no(`the pinned key ${name}'s packet doesn't match its fingerprint`)
  return keyFromPacket(body, fpr)
}

function keyFromPacket(body, fpr) {
  if (body[0] !== 4 || body[5] !== 1) no('the key is not a v4 RSA key')
  const n = mpi(body, 6)
  const e = mpi(body, n.next)
  const b64u = b => b.toString('base64url')
  const key = crypto.createPublicKey({ key: { kty: 'RSA', n: b64u(n.value), e: b64u(e.value) }, format: 'jwk' })
  return { key, fingerprint: fpr, keyId: fpr.slice(-16) }
}

function subpackets(buf) {
  const out = []
  let p = 0
  while (p < buf.length) {
    let len
    const l = buf[p]
    if (l < 192) { len = l; p += 1 } else if (l < 255) { if (p + 1 >= buf.length) no('a truncated subpacket'); len = ((l - 192) << 8) + buf[p + 1] + 192; p += 2 } else { if (p + 5 > buf.length) no('a truncated subpacket'); len = buf.readUInt32BE(p + 1); p += 5 }
    if (len < 1 || p + len > buf.length) no('a subpacket runs past its area')
    const type = buf[p] & 0x7f
    out.push({ type, critical: !!(buf[p] & 0x80), data: buf.subarray(p + 1, p + len) })
    p += len
  }
  return out
}

/**
 * Verifies `signature` (armored or binary) over `data` with the pinned key `keyName`. Returns { created, fingerprint,
 * hash } or throws PgpError with the reason.
 */
function verifyDetached(data, signature, keyName, { now = Date.now() } = {}) {
  const pin = pinnedKey(keyName)
  const raw = dearmor(signature, 'SIGNATURE')
  if (raw.length > MAX_SIG) no('the signature is too large')
  const ps = packets(raw)
  if (ps.length !== 1 || ps[0].tag !== 2) no(`expected exactly one signature packet, found ${ps.map(x => `tag ${x.tag}`).join(', ') || 'none'}`)
  const s = ps[0].body
  if (s.length < 12 || s[0] !== 4) no('only v4 signatures are accepted')
  const type = s[1]
  // Only binary-document signatures: a text-mode one (0x01) would need canonical line endings, and none of ours is.
  if (type !== 0x00) no(`signature type 0x${type.toString(16)} is not a binary document signature`)
  if (s[2] !== 1) no(`public-key algorithm ${s[2]} is not RSA`)
  const hash = HASHES[s[3]]
  if (!hash) no(`hash algorithm ${s[3]} is not accepted`)
  const hlen = s.readUInt16BE(4)
  if (6 + hlen + 2 > s.length) no('the hashed area runs past the packet')
  const hashedArea = s.subarray(6, 6 + hlen)
  const ulen = s.readUInt16BE(6 + hlen)
  const uStart = 8 + hlen
  if (uStart + ulen + 2 > s.length) no('the unhashed area runs past the packet')
  const unhashed = subpackets(s.subarray(uStart, uStart + ulen))
  const hashed = subpackets(hashedArea)
  const left16 = s.subarray(uStart + ulen, uStart + ulen + 2)
  const sig = mpi(s, uStart + ulen + 2)
  if (sig.next !== s.length) no('trailing bytes after the signature')
  let created = null
  let expires = null
  const issuers = []
  for (const sp of hashed) {
    if (sp.critical && !KNOWN_HASHED.has(sp.type)) no(`an unknown critical subpacket (type ${sp.type})`)
    if (sp.type === 2 && sp.data.length === 4) created = sp.data.readUInt32BE(0) * 1000
    if (sp.type === 3 && sp.data.length === 4) expires = sp.data.readUInt32BE(0) * 1000
  }
  for (const sp of [...hashed, ...unhashed]) {
    if (sp.type === 33 && sp.data.length === 21 && sp.data[0] === 4) issuers.push(sp.data.subarray(1).toString('hex').toUpperCase())
    if (sp.type === 16 && sp.data.length === 8) issuers.push(sp.data.toString('hex').toUpperCase())
  }
  if (created === null) no('the signature has no hashed creation time')
  if (created > now + GRACE_MS) no('the signature was made in the future')
  if (expires && created + expires <= now) no('the signature has expired')
  if (!issuers.length) no('the signature names no issuer')
  for (const i of issuers) if (i !== pin.fingerprint && i !== pin.keyId) no(`the signature's issuer ${i} is not the pinned key ${pin.fingerprint}`)
  const header = s.subarray(0, 6 + hlen)
  const trailer = Buffer.alloc(6)
  trailer[0] = 4; trailer[1] = 0xff
  trailer.writeUInt32BE(header.length, 2)
  const doc = Buffer.isBuffer(data) ? data : Buffer.from(data)
  const digest = crypto.createHash(hash).update(doc).update(header).update(trailer).digest()
  if (!digest.subarray(0, 2).equals(left16)) no('the digest does not match the signature\'s check bytes: the file was changed, or is another file')
  // crypto.verify hashes its input itself: give it exactly what was hashed above.
  const keyBytes = pin.key.asymmetricKeyDetails?.modulusLength ? Math.ceil(pin.key.asymmetricKeyDetails.modulusLength / 8) : sig.value.length
  const sigValue = sig.value.length < keyBytes ? Buffer.concat([Buffer.alloc(keyBytes - sig.value.length), sig.value]) : sig.value
  const ok = crypto.verify(hash, Buffer.concat([doc, header, trailer]), { key: pin.key, padding: crypto.constants.RSA_PKCS1_PADDING }, sigValue)
  if (!ok) no('the RSA signature is not valid for this file and the pinned key')
  return { created: new Date(created).toISOString(), fingerprint: pin.fingerprint, hash }
}

module.exports = { verifyDetached, dearmor, packets, crc24, pinnedKey, keyFromPacket, KEYS, PgpError }
