'use strict'
// MC-1549: the Hyper-V socket bridge (helper/host/HvMcpVsock.cs) with the real in-box ssh.exe and no VM. A test build
// (csc -define:HVMCP_TEST) reads the all-zero VM id as TCP to 127.0.0.1:<port>, where a fake SSH server sends a banner
// and a real KEXINIT and records the client's messages. ssh.exe gives its ProxyCommand overlapped pipes; the old
// bridge's synchronous Console streams passed only ssh's banner, so the fake server saw no client message at all.
// ssh runs inside test/jobrun.exe's kill-on-close Job object (MC-1543): nothing it starts outlives the test.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const net = require('net')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const { scratch } = require('./helpers')

const windows = process.platform === 'win32'
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const SSH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
const SRC = path.join(__dirname, '..', 'helper', 'host', 'HvMcpVsock.cs')
const skip = !windows ? 'Windows only' : !fs.existsSync(CSC) ? 'no .NET Framework compiler' : !fs.existsSync(SSH) ? 'no in-box OpenSSH Client' : false
const ZERO = '00000000-0000-0000-0000-000000000000'

let built = null
/** Compiles the bridge (test build or as setup builds it), test/jobrun.cs, into one scratch folder, once. */
function build() {
  if (built) return built
  const dir = scratch('bridge').dir
  const cc = (out, src, defs = []) => {
    const r = spawnSync(CSC, ['-nologo', '-target:exe', '-optimize', ...defs, `-out:${out}`, src], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) throw new Error(`compiling ${path.basename(src)} failed: ${r.stdout}${r.stderr}`)
    return out
  }
  built = {
    test: cc(path.join(dir, 'HvMcpVsock-test.exe'), SRC, ['-define:HVMCP_TEST']),
    shipped: cc(path.join(dir, 'HvMcpVsock.exe'), SRC),
    jobrun: cc(path.join(dir, 'jobrun.exe'), path.join(__dirname, 'jobrun.cs'))
  }
  return built
}

const str = s => { const b = Buffer.from(s); const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]) }
/** An unencrypted SSH binary packet (RFC 4253 §6): length, padding length, payload, at least 4 bytes of padding. */
function packet(payload) {
  let pad = 8 - ((5 + payload.length) % 8)
  if (pad < 4) pad += 8
  const h = Buffer.alloc(5)
  h.writeUInt32BE(1 + payload.length + pad)
  h[4] = pad
  return Buffer.concat([h, payload, crypto.randomBytes(pad)])
}
const KEXINIT = packet(Buffer.concat([Buffer.from([20]), crypto.randomBytes(16),
  str('curve25519-sha256,kex-strict-s-v00@openssh.com'), str('ssh-ed25519'),
  str('chacha20-poly1305@openssh.com'), str('chacha20-poly1305@openssh.com'), str('hmac-sha2-256'), str('hmac-sha2-256'),
  str('none'), str('none'), str(''), str(''), Buffer.from([0, 0, 0, 0, 0])]))

/**
 * A fake SSH server on 127.0.0.1: its banner, then (after the client's banner, as sshd does) a KEXINIT; it records the
 * client's banner and message types and closes once the client's ECDH init (30) arrives.
 */
function fakeServer() {
  const seen = { connections: 0, banner: null, types: [] }
  const srv = net.createServer(sock => {
    seen.connections++
    let buf = Buffer.alloc(0)
    sock.on('error', () => {})
    sock.write('SSH-2.0-OpenSSH_10.0p2 fake\r\n')
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      if (seen.banner === null) {
        const i = buf.indexOf('\r\n')
        if (i < 0) return
        seen.banner = buf.subarray(0, i).toString()
        buf = buf.subarray(i + 2)
        sock.write(KEXINIT)
      }
      while (buf.length >= 5 && buf.length >= 4 + buf.readUInt32BE(0)) {
        seen.types.push(buf[5])
        buf = buf.subarray(4 + buf.readUInt32BE(0))
      }
      if (seen.types.includes(30)) sock.destroy()
    })
  })
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, seen, close: () => new Promise(r => srv.close(r)) })))
}

/** ssh.exe (no key, no config) with the bridge as its ProxyCommand, inside jobrun's job; ends by itself or at ms. */
function ssh(bridge, vmId, port, ms = 30_000) {
  const b = build()
  const q = a => `"${a.replace(/"/g, '\\"')}"`
  const opts = ['BatchMode=yes', 'StrictHostKeyChecking=no', 'UserKnownHostsFile=NUL', 'GlobalKnownHostsFile=none', 'PubkeyAuthentication=no',
    'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'ConnectTimeout=20', 'LogLevel=DEBUG1']
  const line = [q(SSH), '-F', 'none', '-T', '-x', '-a', ...opts.flatMap(o => ['-o', o]), '-o', q(`ProxyCommand="${bridge}" ${vmId} ${port}`), 'probe@fake', 'true'].join(' ')
  return collect(spawn(b.jobrun, [line], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true }), ms)
}

/**
 * Round 2: a launched child's result once it has exited AND its streams have closed ('close', not 'exit', which can
 * come before the last stderr bytes: the bridge's close line is exactly those). At ms it is killed by its handle
 * (ending jobrun closes its job: ssh and the bridge end with it); if its streams still haven't closed 10 s later, it
 * resolves with streamsOpen, which fails the test. A spawn error rejects.
 */
function collect(p, ms, graceMs = 10_000) {
  return new Promise((resolve, reject) => {
    let err = '', timedOut = false, exitCode
    p.stderr.on('data', d => { err += d })
    p.stdout.resume()
    let grace = null
    const t = setTimeout(() => {
      timedOut = true
      p.kill()
      grace = setTimeout(() => resolve({ code: exitCode ?? null, err, timedOut, streamsOpen: true }), graceMs)
    }, ms)
    const done = () => { clearTimeout(t); clearTimeout(grace) }
    p.on('error', e => { done(); reject(e) })
    p.on('exit', code => { exitCode = code })
    p.on('close', code => { done(); resolve({ code, err, timedOut, streamsOpen: false }) })
  })
}

test('MC-1549: the bridge passes everything ssh.exe writes, not just its banner: the client\'s KEXINIT and ECDH init reach the server, and its byte counts say so', { skip }, async t => {
  const b = build()
  const s = await fakeServer()
  t.after(s.close)
  const r = await ssh(b.test, ZERO, s.port)
  assert.match(s.seen.banner || '', /^SSH-2\.0-OpenSSH_for_Windows/, 'the client\'s banner arrived')
  assert.deepStrictEqual(s.seen.types.slice(0, 2), [20, 30], `the client's KEXINIT and ECDH init arrived (types seen: ${s.seen.types}); ssh said:\n${r.err}`)
  assert.strictEqual(r.timedOut, false, 'ssh ended when the server closed, without being killed')
  assert.strictEqual(r.streamsOpen, false, 'its streams closed, so all it wrote was read')
  const m = /HvMcpVsock: closed after \d+ ms, (\d+) bytes in, (\d+) bytes out/.exec(r.err)
  assert.ok(m, `the bridge's close line: ${r.err}`)
  assert.ok(Number(m[2]) > 1000, `more than the banner went out (${m[2]} bytes: banner, KEXINIT and ECDH init)`)
  assert.ok(Number(m[1]) > KEXINIT.length, `the server's banner and KEXINIT came in (${m[1]} bytes)`)
})

test('MC-1549: the build setup ships has no TCP mode: the all-zero VM id never reaches a local server', { skip }, async t => {
  const b = build()
  const s = await fakeServer()
  t.after(s.close)
  const r = await ssh(b.shipped, ZERO, s.port)
  assert.strictEqual(s.seen.connections, 0, 'nothing connected to 127.0.0.1')
  assert.doesNotMatch(r.err, /HvMcpVsock: connected/)
  assert.match(r.err, /HvMcpVsock: (can't connect|connect timed out)/, `the bridge says why: ${r.err}`)
})

// Round 2: collect() with a mock child, no process: the order Node allows (exit, then the last stderr, then close).
function mockChild() {
  const { EventEmitter } = require('events')
  const { PassThrough } = require('stream')
  const c = new EventEmitter()
  c.stdout = new PassThrough()
  c.stderr = new PassThrough()
  c.killed = 0
  c.kill = () => { c.killed++ }
  return c
}

test('MC-1549 round 2: the result waits for close, so a final stderr line after exit is kept; a spawn error rejects; a hung child is killed, bounded', async () => {
  const c = mockChild()
  const r = collect(c, 5_000)
  c.stderr.write('debug1: expecting SSH2_MSG_KEX_ECDH_REPLY\n')
  c.emit('exit', 255)
  await new Promise(res => setImmediate(res))
  c.stderr.write('HvMcpVsock: closed after 36 ms, 253 bytes in, 1513 bytes out\n')
  await new Promise(res => setImmediate(res))
  c.emit('close', 255)
  const got = await r
  assert.match(got.err, /HvMcpVsock: closed after 36 ms, 253 bytes in, 1513 bytes out/, 'the line written after exit is kept')
  assert.deepStrictEqual([got.code, got.timedOut, got.streamsOpen, c.killed], [255, false, false, 0])

  const e = mockChild()
  const re = collect(e, 5_000)
  e.emit('error', new Error('spawn ENOENT'))
  await assert.rejects(re, /spawn ENOENT/)

  const h = mockChild()
  const got2 = await collect(h, 20, 20)
  assert.deepStrictEqual([got2.timedOut, got2.streamsOpen, h.killed], [true, true, 1], 'killed once at its bound, then reported with its streams open')
})
