// A Linux guest's files (MC-1501): the helper's SSH keys in OpenSSH's formats (checked by Windows' own ssh-keygen when
// it is there), the cloud-init seed (users, the forced command, sudoers, the host key, sshd on the transport's one
// endpoint, the distro's sshd masked, the diagnostics), and the dispatcher run for real under a Linux Python (WSL, or
// HYPERV_TEST_LINUX_PYTHON) against temp trees with real symlinks; skipped, and said, where there's no Linux Python.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const sshkeys = require('../helper/sshkeys')
const seed = require('../helper/seed')
const { BASE } = require('./helpers')

const SSH_KEYGEN = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe')

test('ssh keys: OpenSSH reads the private key the helper writes, and derives its public key and fingerprint', { skip: !fs.existsSync(SSH_KEYGEN) && 'no in-box ssh-keygen' }, () => {
  const dir = path.join(BASE, `${process.pid}-keys`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const k = sshkeys.generate('hvmcp-test')
  const file = path.join(dir, 'k')
  fs.writeFileSync(file, k.private)
  // OpenSSH on Windows refuses a private key others may read: the helper's secrets folder is that strict.
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' })
  const pub = execFileSync(SSH_KEYGEN, ['-y', '-f', file], { encoding: 'utf8' }).trim()
  assert.strictEqual(pub, k.public)
  fs.writeFileSync(`${file}.pub`, k.public + '\n')
  const fp = execFileSync(SSH_KEYGEN, ['-l', '-f', `${file}.pub`], { encoding: 'utf8' })
  assert.ok(fp.includes(sshkeys.fingerprint(k.public)), fp)
  assert.strictEqual(sshkeys.knownHosts('hvmcp', k.public), `hvmcp ${k.public.split(' ').slice(0, 2).join(' ')}\n`)
  fs.rmSync(dir, { recursive: true, force: true })
})

const keys = () => ({ client: sshkeys.generate('hvmcp-client'), host: sshkeys.generate('hvmcp-host') })
const userData = f => JSON.parse(f['user-data'].replace(/^#cloud-config\n/, ''))

test('the seed: locked users, the helper\'s key only behind the forced command, sudo for the dispatcher alone, the pinned host key, no other host keys', () => {
  const k = keys()
  const f = seed.files({ instanceId: 'i-0123456789abcdef', hostname: 'hvmcp-ab12', keys: k, dispatcher: '#!/usr/bin/python3\n' })
  assert.ok(f['user-data'].startsWith('#cloud-config\n'))
  const u = userData(f)
  assert.deepStrictEqual(u.users.map(x => [x.name, x.lock_passwd]), [['hvadmin', true], ['hvuser', true]], 'only our two users (no default user), passwords locked')
  assert.deepStrictEqual(u.users[0].ssh_authorized_keys, [`restrict,command="sudo -n /usr/local/libexec/hvmcp/dispatch" ${k.client.public}`])
  assert.strictEqual(u.users[1].ssh_authorized_keys, undefined, 'hvuser has no key')
  assert.strictEqual(u.ssh_pwauth, false)
  assert.strictEqual(u.disable_root, true)
  assert.deepStrictEqual(u.ssh_genkeytypes, [])
  assert.strictEqual(u.ssh_deletekeys, true)
  assert.deepStrictEqual(u.ssh_keys, { ed25519_private: k.host.private, ed25519_public: k.host.public })
  const file = p => u.write_files.find(w => w.path === p)
  assert.strictEqual(file('/etc/sudoers.d/hvmcp').content, 'hvadmin ALL=(root) NOPASSWD: /usr/local/libexec/hvmcp/dispatch ""\n')
  assert.strictEqual(file('/etc/sudoers.d/hvmcp').permissions, '0440')
  assert.strictEqual(Buffer.from(file('/usr/local/libexec/hvmcp/dispatch').content, 'base64').toString(), '#!/usr/bin/python3\n')
  const sshd = file('/etc/ssh/hvmcp_sshd_config').content
  for (const line of ['AllowUsers hvadmin', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitRootLogin no', 'AllowTcpForwarding no', 'PermitTTY no', 'X11Forwarding no']) assert.ok(sshd.split('\n').includes(line), line)
  assert.doesNotMatch(sshd, /Subsystem/, 'no sftp')
  assert.ok(u.runcmd.some(c => c.join(' ') === 'systemctl mask ssh.service ssh.socket'))
  assert.ok(u.runcmd.some(c => c.join(' ') === 'systemctl enable --now hvmcp-sshd.socket'))
  // cloud-init's order (cloud.cfg): bootcmd in the init stage, before write_files; runcmd's script at the final
  // stage. So bootcmd may use nothing the seed writes, and must not fail (a failing bootcmd fails cloud-init, and the
  // build then waits for "done" in vain).
  const written = u.write_files.map(w => w.path)
  assert.strictEqual(u.bootcmd.length, 1)
  const early = u.bootcmd[0]
  assert.deepStrictEqual(early.slice(0, 2), ['sh', '-c'])
  for (const p of [...written, 'hvmcp/dispatch']) assert.ok(!early[2].includes(p), `bootcmd uses ${p} before write_files`)
  assert.match(early[2], /echo "HVMCP-DIAG stage=seed-read vmbus=\$v hv_sock_driver=\$h kernel=\$k" > \/dev\/ttyS0 2>\/dev\/null; true$/, 'it ends true')
  const sh = spawnSync('sh', ['-n', '-c', early[2]], { encoding: 'utf8' })
  if (!sh.error) assert.strictEqual(sh.status, 0, `the early diagnostic parses: ${sh.stderr}`)
  // runcmd steps that may rightly fail on one distro can't fail cloud-init; the dispatcher's diagnostics run after
  // write_files installed it.
  assert.ok(u.runcmd.some(c => c.join(' ') === 'sh -c systemctl disable --now ssh.service ssh.socket 2>/dev/null || true'))
  assert.ok(u.runcmd.some(c => c.join(' ') === 'sh -c modprobe hv_sock || true'))
  assert.deepStrictEqual(u.runcmd.filter(c => c[0] === '/usr/local/libexec/hvmcp/dispatch').map(c => c[2]), ['units-written', 'socket-up'])
  assert.match(f['meta-data'], /^instance-id: i-0123456789abcdef\nlocal-hostname: hvmcp-ab12\n$/)
})

test('the seed per transport: A listens on vsock only with no addresses and hv_sock loaded; B on the guest\'s one address', () => {
  const a = seed.files({ instanceId: 'i-0123456789abcdef', hostname: 'h', keys: keys(), dispatcher: 'x' })
  const ua = userData(a)
  assert.match(ua.write_files.find(w => w.path === '/etc/systemd/system/hvmcp-sshd.socket').content, /^ListenStream=vsock::22$/m)
  assert.deepStrictEqual(JSON.parse(a['network-config']), { version: 2, ethernets: {} })
  assert.strictEqual(ua.write_files.find(w => w.path === '/etc/modules-load.d/hvmcp.conf').content, 'hv_sock\n')
  const b = seed.files({ instanceId: 'i-0123456789abcdef', hostname: 'h', keys: keys(), dispatcher: 'x', transport: 'internal-switch', address: '10.47.0.11/24' })
  const ub = userData(b)
  const sock = ub.write_files.find(w => w.path === '/etc/systemd/system/hvmcp-sshd.socket').content
  assert.match(sock, /^ListenStream=10\.47\.0\.11:22$/m)
  assert.doesNotMatch(sock, /vsock/)
  assert.deepStrictEqual(JSON.parse(b['network-config']).ethernets.eth0.addresses, ['10.47.0.11/24'])
  assert.strictEqual(ub.write_files.find(w => w.path === '/etc/modules-load.d/hvmcp.conf'), undefined)
  assert.throws(() => seed.files({ instanceId: 'i-0123456789abcdef', hostname: 'h', keys: keys(), dispatcher: 'x', transport: 'internal-switch' }), /needs the guest's address/)
  assert.throws(() => seed.files({ instanceId: 'bad', hostname: 'h', keys: keys(), dispatcher: 'x' }), /instance id/)
})

/** A Linux Python: HYPERV_TEST_LINUX_PYTHON ("wsl -d Debian -e python3", say), or the first WSL distro that has one. */
function linuxPython() {
  if (process.env.HYPERV_TEST_LINUX_PYTHON) return { argv: process.env.HYPERV_TEST_LINUX_PYTHON.split(' '), wsl: /^wsl(\.exe)?$/i.test(process.env.HYPERV_TEST_LINUX_PYTHON.split(' ')[0]) }
  const l = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le', timeout: 15_000 })
  if (l.status !== 0) return null
  for (const d of l.stdout.split(/\r?\n/).map(x => x.replace(/\0/g, '').trim()).filter(Boolean)) {
    const v = spawnSync('wsl.exe', ['-d', d, '-e', 'python3', '-c', 'import sys; print(sys.version_info >= (3, 8))'], { encoding: 'utf8', timeout: 30_000 })
    if (v.status === 0 && v.stdout.trim() === 'True') return { argv: ['wsl.exe', '-d', d, '-e', 'python3'], wsl: true }
  }
  return null
}
const py = process.platform === 'win32' ? linuxPython() : { argv: ['python3'], wsl: false }

test('the dispatcher, run for real under Linux: sync\'s no-follow rules and execute bits, refusals with nothing changed, read-out skipping links', { skip: !py && 'no Linux Python here (WSL with python3, or HYPERV_TEST_LINUX_PYTHON): the real trial covers it' }, () => {
  const wslPath = p => p.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/')
  const conv = py.wsl ? wslPath : p => p
  const r = spawnSync(py.argv[0], [...py.argv.slice(1), conv(path.join(__dirname, 'guest_py_check.py')), conv(path.join(__dirname, '..', 'helper', 'guest.py'))], { encoding: 'utf8', timeout: 120_000 })
  assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`)
  assert.match(r.stdout, /^OK \d+/m)
})
