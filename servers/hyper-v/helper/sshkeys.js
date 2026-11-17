/**
 * SSH keys for Linux guests (MC-1501; design §3), made by the helper with Node's crypto (ed25519) and written in
 * OpenSSH's own formats by these few lines, so no ssh-keygen runs:
 * - a VM's client key: the helper's key for that VM's hvadmin (its forced command only);
 * - a VM's host key: the guest's sshd host key, made here so the helper's known_hosts entry is pinned before the
 *   guest's first boot (no trust on first use).
 * Private keys go only into the helper's secrets folder and the build's seed (deleted after the build), never into a
 * reply, plan, journal or log.
 */
const crypto = require('crypto')

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b }
const str = b => { const v = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([u32(v.length), v]) }

/** A new ed25519 key: { private (OpenSSH PEM text), public ("ssh-ed25519 AAAA… comment"), blob (the public key blob) }. */
function generate(comment = 'hvmcp') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url')
  return format(seed, pub, comment)
}

function format(seed, pub, comment) {
  if (seed.length !== 32 || pub.length !== 32) throw new Error('an ed25519 key is 32 + 32 bytes')
  const blob = Buffer.concat([str('ssh-ed25519'), str(pub)])
  const check = crypto.randomBytes(4)
  let priv = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str(comment)])
  const pad = []
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i)
  priv = Buffer.concat([priv, Buffer.from(pad)])
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), str('none'), str('none'), str(''), u32(1), str(blob), str(priv)])
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n').replace(/\n$/, '')
  return {
    private: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    public: `ssh-ed25519 ${blob.toString('base64')} ${comment}`,
    blob
  }
}

/** The SHA256 fingerprint OpenSSH prints for a public key line ("SHA256:…"). */
function fingerprint(publicLine) {
  const blob = Buffer.from(String(publicLine).split(/\s+/)[1] || '', 'base64')
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** The known_hosts line for a VM's pinned host key, under the alias the helper connects to. */
function knownHosts(alias, publicLine) {
  const [type, b64] = String(publicLine).split(/\s+/)
  return `${alias} ${type} ${b64}\n`
}

module.exports = { generate, format, fingerprint, knownHosts }
