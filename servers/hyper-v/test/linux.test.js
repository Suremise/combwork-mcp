// Linux guests (MC-1501; design: docs/linux-guests.md), against the stub Hyper-V and the stub guest (stub-guest.js, in
// place of ssh.exe and the dispatcher):
// - the build: the seed (keys made by the helper, only their public parts anywhere but its secrets folder), the first
//   boot with its serial diagnostics (allowlisted), readiness by the authenticated round trip, the checks, cloud-init
//   turned off, the seed and COM port gone, the clean checkpoint; a build that never answers diagnosed (conclusive or
//   inconclusive) and rolled back, never retried over another transport; failed checks;
// - a mixed pool through server.js: a Windows and a Linux lease at once, the same tools (bash by default, /build and
//   /out, as root or hvuser), a sync, a reset, the refusals (cmd on Linux, interactive), and release restoring both;
// - a run timing out (its unit killed), a lease checkpoint taken Off and restored, the helper killed mid-run and the
//   Linux VM restored by the next one's recovery; the feature gate.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { scratch, startHelper, withPool, approve, waitFor } = require('./helpers')
const { server } = require('../client')

const D = 'de'.repeat(32) // a Debian image, recorded as linux-images.prepare records one
const vmOf = (sc, name) => Object.values(sc.stub().vms).find(v => v.name === name)
const linuxVm = sc => Object.values(sc.stub().vms).find(v => v.os === 'linux')
const statusText = async c => (await c.request('status')).text

/** Adds a verified Debian image to a stopped helper's journal (its base VHDX a small file, with its hash). */
function addDebian(sc) {
  const dir = path.join(sc.disks, 'images')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${D}.vhdx`)
  fs.writeFileSync(file, 'base-vhdx')
  const vhdxSha256 = crypto.createHash('sha256').update('base-vhdx').digest('hex')
  fs.appendFileSync(path.join(sc.stateDir, 'journal.jsonl'), JSON.stringify({
    t: 'image', sha256: D, size: 9, file, vhdxSha256, source: 'download', os: 'linux', pinned: true, pin: 'debian-13-t', distro: 'debian', release: '13',
    codename: 'trixie', serial: 't', name: 'Debian 13 test', checksums: 'SHA512SUMS, unsigned', seq: 3000, at: new Date().toISOString()
  }) + '\n')
}

/** Plans, approves and runs a pool change; resolves the finished job's line (or throws with a failed one's). */
async function change(sc, admin, args, { expectFail = false } = {}) {
  const plan = await admin.request('pool_plan', args)
  assert.ok(plan.data?.planId, plan.text)
  approve(sc, plan.data.planId)
  await admin.request(`pool_${args.action}`, { planId: plan.data.planId })
  let line = null
  await waitFor(async () => {
    const st = await statusText(admin)
    line = /Last pool job: \w+ (finished|FAILED): .*/.exec(st)?.[0]
    return !/Pool job in progress/.test(st) && line && line.includes(plan.data.planId.slice(0, 0))
  }, 30_000, 'the pool job')
  if (!expectFail && /FAILED/.test(line)) throw new Error(line)
  return { plan, line }
}

/** A pool of one Windows VM, then one Debian VM built through the Linux driver. */
async function mixedPool(name, stub = {}) {
  const sc = scratch(name, { policy: { maxVms: 4, maxMemoryMBTotal: 65536 }, stub })
  const { h } = await withPool(sc, 1)
  await h.stop()
  addDebian(sc)
  const helper = await startHelper(sc, { HYPERV_MCP_KEEP_MS: '60000' })
  const admin = helper.conn(99)
  const built = await change(sc, admin, { action: 'resize', image: D, vms: 1 })
  return { sc, h: helper, admin, built, linux: linuxVm(sc) }
}

test('a Linux build: seed and keys, first boot with its diagnostics, readiness, checks, cloud-init off, seed and COM gone, clean checkpoint', async () => {
  const { sc, h, admin, built, linux } = await mixedPool('lx-build')
  assert.match(built.line, /created hvmcp-[0-9a-f]+ \(debian 13, kernel 6\.12\.117\+deb13-cloud-amd64; SSH over the Hyper-V socket \(hv_sock present\)\)/)
  assert.match(built.plan.text, /- image: Debian 13 test, build t, SHA-256 dededededede, pinned; checksums: SHA512SUMS, unsigned/)
  assert.match(built.plan.text, /- Linux build: each new VM is a copy of the image's verified base VHDX with a cloud-init seed/)
  assert.doesNotMatch(built.plan.text, /Defender|activation|provisioning|product key/, 'none of the Windows steps')
  // The journal's ready record.
  const ready = sc.journal().find(r => r.t === 'ready' && r.vmId === linux.id)
  assert.deepStrictEqual(ready.licence, { kind: 'linux' })
  assert.strictEqual(ready.transport, 'hvsocket')
  assert.deepStrictEqual(ready.guest, { id: 'debian', versionId: '13', serial: null, kernel: '6.12.117+deb13-cloud-amd64' })
  assert.deepStrictEqual(ready.diag, { stage: 'socket-up', vmbus: 'present', hv_sock_driver: 'present', hv_sock_modinfo: 'present', vsock_listen: 'active', sshd_config_ok: 'yes', kernel: '6.12.117+deb13-cloud-amd64' }, 'only the allowlisted keys (secret dropped)')
  // The steps, in order, and what they leave.
  const calls = sc.stub().calls.map(c => c.op)
  for (const op of ['create-vm', 'com-attach', 'start-vm', 'guest-shutdown', 'com-detach', 'make-clean', 'restore']) assert.ok(calls.includes(op), op)
  assert.deepStrictEqual([...new Set(sc.stub().sshCalls.map(c => c.op))], ['ready', 'verify', 'finish'])
  const vm = vmOf(sc, linux.name)
  assert.strictEqual(vm.com, null, 'no COM port on the VM')
  assert.strictEqual(vm.dvd, null, 'no seed DVD')
  assert.ok(vm.checkpoints[0].disk['/etc/cloud/cloud-init.disabled'] !== undefined, 'the clean checkpoint has cloud-init off')
  const folder = path.dirname(vm.location)
  assert.ok(!fs.existsSync(path.join(folder, 'seed.iso')) && !fs.existsSync(path.join(folder, 'seed')), 'the seed is gone')
  // The keys: in the helper's secrets folder only; the host key's public half pinned in known_hosts and in the seed.
  const keys = path.join(sc.stateDir, 'secrets', 'ssh', linux.name)
  assert.match(fs.readFileSync(path.join(keys, 'client'), 'utf8'), /^-----BEGIN OPENSSH PRIVATE KEY-----/)
  assert.strictEqual(fs.readFileSync(path.join(keys, 'known_hosts'), 'utf8').trim(), `hvmcp ${vm.seed.hostKey}`)
  assert.match(vm.seed.authorized[0], /^restrict,command="sudo -n \/usr\/local\/libexec\/hvmcp\/dispatch" ssh-ed25519 /)
  for (const f of [sc.stubState, path.join(sc.stateDir, 'journal.jsonl'), ...fs.readdirSync(path.join(sc.stateDir, 'plans')).map(p => path.join(sc.stateDir, 'plans', p))]) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /PRIVATE KEY/, `no private key in ${path.basename(f)}`)
  }
  assert.doesNotMatch(h.stderr(), /PRIVATE KEY/)
  // Status: its OS and distro, no licence to track.
  const st = await statusText(admin)
  assert.match(st, new RegExp(`- ${linux.name}: linux \\(Debian 13 test, build t\\), image dededededede;.*free; Linux, no licence to track`))
  await h.stop()
})

test('a Linux build that never answers: diagnosed from its serial lines (conclusive, or inconclusive), rolled back, never retried over another transport', async () => {
  const cases = [
    [{ linuxNeverReady: true, diagLines: ['HVMCP-DIAG stage=socket-up vmbus=present hv_sock_driver=absent hv_sock_modinfo=absent vsock_listen=failed sshd_config_ok=yes kernel=6.12.1-cloud'] }, /the guest kernel has no hv_sock driver \(kernel 6\.12\.1-cloud\): this image can't use the Hyper-V socket transport\. Moving to the internal-switch transport is the user's decision/],
    [{ linuxNeverReady: true, diagLines: [] }, /the guest never answered over SSH, and the diagnostics don't say why \(inconclusive\): unavailable=no lines\. The build stops here: the transport is the user's decision/],
    [{ linuxNeverReady: true, comReadFails: true }, /inconclusive\): unavailable=unreadable/],
    [{ verifyOverride: { addresses: ['eth0 10.0.0.5'], listeners: ['tcp 0.0.0.0:22'] } }, /the guest's checks failed: it has addresses: eth0 10\.0\.0\.5; something listens beyond loopback: tcp 0\.0\.0\.0:22/],
    [{ cloudInitStatus: 'error' }, /cloud-init finished with status error/],
    [{ linuxGuest: { id: 'ubuntu', versionId: '26.04' } }, /the guest says it is ubuntu, the image debian/],
    [{ verifyOverride: { hostKey: 'ssh-ed25519 AAAAother' } }, /its host key is not the one made for it/]
  ]
  for (const [stub, re] of cases) {
    const sc = scratch('lx-notready', { policy: { maxVms: 4, maxMemoryMBTotal: 65536 } })
    const { h } = await withPool(sc, 1)
    await h.stop()
    addDebian(sc)
    sc.patchStub(s => Object.assign(s, stub))
    const helper = await startHelper(sc)
    const admin = helper.conn(99)
    const { line } = await change(sc, admin, { action: 'resize', image: D, vms: 1 }, { expectFail: true })
    assert.match(line, /FAILED/, JSON.stringify(stub))
    assert.match(line, re, JSON.stringify(stub))
    assert.strictEqual(linuxVm(sc), undefined, 'rolled back: the VM is gone')
    assert.deepStrictEqual(fs.readdirSync(path.join(sc.stateDir, 'secrets', 'ssh')), [], 'and its keys')
    assert.ok(!sc.stub().calls.some(c => /switch/.test(c.op)), 'no other transport tried')
    await helper.stop()
  }
})

test('a mixed pool: a Windows and a Linux lease at once, through one helper, both running at the same time', async () => {
  const { sc, h, linux } = await mixedPool('lx-both')
  const [w, l] = [h.conn(1), h.conn(2)]
  // One call at a time (the stub's state is one file), while both leases are held and both VMs run.
  const wa = await w.request('acquire', { minutes: 30 })
  const la = await l.request('acquire', { minutes: 30, distro: 'debian' })
  assert.match(wa.text, /^Leased hvmcp-/)
  assert.match(la.text, new RegExp(`^Leased ${linux.name}`))
  assert.strictEqual(la.data.os, 'linux')
  await w.request('start', {})
  await l.request('start', {})
  const wr = await w.request('run', { command: 'echo from-windows' })
  const lr = await l.request('run', { command: 'echo from-linux' })
  assert.match(wr.text, /Exit code 0\.\n--- stdout ---\nfrom-windows/)
  assert.match(lr.text, /Exit code 0\.\n--- stdout ---\nfrom-linux/)
  assert.ok(Object.values(sc.stub().vms).every(v => v.state === 'Running'), 'both running at once')
  await assert.rejects(w.request('run', { command: 'ls', shell: 'bash' }), /bash and sh are for Linux guests/)
  await w.request('release')
  await l.request('release')
  for (const v of Object.values(sc.stub().vms)) {
    assert.strictEqual(v.state, 'Off')
    assert.strictEqual(v.parent, v.checkpoints.find(c => c.name === 'clean').id, `${v.name} at its clean checkpoint`)
  }
  await h.stop()
})

test('a Linux lease through server.js: a build copied in, bash in /build as root or hvuser, /out read back, a sync, a reset, the refusals, release', async t => {
  const { sc, h, linux } = await mixedPool('lx-server')
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home') }
  const app = path.join(sc.builds, 'app')
  fs.writeFileSync(path.join(app, 'run.sh'), '#!/bin/sh\necho ok\n')
  const lin = server(env, { roots: [sc.builds] })
  t.after(() => lin.close())
  assert.match((await lin.call('vm_acquire', { minutes: 30, distro: 'debian' })).text, new RegExp(`^Leased ${linux.name}`))
  assert.match((await lin.call('vm_start', { build: app })).text, /build copied in to \/build \(3 files.*\/out is empty/)
  const disk = () => vmOf(sc, linux.name).disk
  assert.strictEqual(Buffer.from(disk()['/build/sub/data.txt'], 'base64').toString(), 'hello build')
  assert.deepStrictEqual(sc.stub().syncs.filter(x => x.linux).at(-1).files.sort(), ['run.sh', 'setup.exe', 'sub/data.txt'], 'forward slashes in the guest')
  // Runs: bash by default, /build, root or hvuser.
  assert.match((await lin.call('vm_run', { command: 'echo from-linux' })).text, /Exit code 0\.\n--- stdout ---\nfrom-linux/)
  assert.match((await lin.call('vm_run', { command: 'pwd' })).text, /\/build/)
  assert.match((await lin.call('vm_run', { command: 'whoami', as: 'user' })).text, /hvuser/)
  assert.match((await lin.call('vm_run', { command: 'whoami', shell: 'sh' })).text, /root/)
  assert.match((await lin.call('vm_run', { command: 'exit 3' })).text, /Exit code 3\./)
  // Refusals: Windows shells, the interactive session, a Windows cwd.
  assert.match((await lin.call('vm_run', { command: 'dir', shell: 'cmd' })).text, /shell must be bash or sh in a Linux guest/)
  assert.match((await lin.call('vm_run', { command: 'x', session: 'interactive' })).text, /Linux guests have no desktop session/)
  assert.match((await lin.call('vm_run', { command: 'pwd', cwd: 'C:\\build' })).text, /cwd must be an absolute guest folder such as \/build/)
  // Read-out from /out.
  await lin.call('vm_run', { command: 'write result.txt linux-result' })
  assert.match((await lin.call('vm_read_out')).text, /result\.txt {2}12 bytes/)
  assert.match((await lin.call('vm_read_out', { paths: ['result.txt'] })).content.map(c => c.text).join(), /linux-result/)
  // A sync: only the changed file, in the running guest, no restore.
  const restores = () => vmOf(sc, linux.name).restores
  const r0 = restores()
  fs.writeFileSync(path.join(app, 'sub', 'data.txt'), 'changed')
  assert.match((await lin.call('vm_sync')).text, /Synced into .*'s \/build without a restore: 1 file\(s\) copied .*\/out and everything else/)
  assert.strictEqual(Buffer.from(disk()['/build/sub/data.txt'], 'base64').toString(), 'changed')
  assert.ok(disk()['/out/result.txt'], '/out kept')
  assert.strictEqual(restores(), r0)
  // A reset: clean again, the build copied in again.
  assert.match((await lin.call('vm_reset')).text, /Started .* from its clean checkpoint.*build copied in to \/build/)
  assert.strictEqual(restores(), r0 + 1)
  assert.strictEqual(disk()['/out/result.txt'], undefined, 'the run\'s state is gone')
  // Interactive is Windows-only.
  assert.match((await lin.call('vm_start', { interactive: 'user' })).text, /Linux guests have no desktop session: interactive is for Windows guests/)
  assert.match((await lin.call('vm_status')).text, new RegExp(`${linux.name}: linux \\(Debian 13 test, build t\\).*leased, running.*\\(yours\\)`))
  await lin.call('vm_release')
  const v = vmOf(sc, linux.name)
  assert.strictEqual(v.state, 'Off')
  assert.strictEqual(v.parent, v.checkpoints.find(c => c.name === 'clean').id)
})

test('a Linux run that times out is killed with its unit; a lease checkpoint is taken Off, restored, and removed at release', async () => {
  const { sc, h, linux } = await mixedPool('lx-runs')
  const c = h.conn(7)
  await c.request('acquire', { minutes: 30, os: 'linux' })
  await c.request('start', {})
  const t = await c.request('run', { command: 'sleep', timeoutSec: 1 })
  assert.match(t.text, /Timed out after 1 s: killed inside the guest with everything it started \(its systemd unit's cgroup\)\./)
  assert.match(t.text, /partial/)
  assert.deepStrictEqual(sc.stub().kills.at(-1), { n: 1, boot: `boot-${vmOf(sc, linux.name).boot}` })
  // A checkpoint: the guest shut down, taken Off, started again.
  await c.request('run', { command: 'write /build/state.txt before' })
  const calls0 = sc.stub().calls.length
  const cp = await c.request('checkpoint', { name: 'a' })
  assert.match(cp.text, /Checkpoint "a" taken of .* with the guest shut down \(Linux: files, installed software and configuration; not running programs\)\. The guest was started again from it\./)
  const ops = sc.stub().calls.slice(calls0).map(x => x.op)
  assert.ok(ops.indexOf('guest-shutdown') < ops.indexOf('pool-take') && ops.indexOf('pool-take') < ops.indexOf('configure-start'), ops.join(', '))
  assert.ok(!ops.includes('lease-checkpoint') && !ops.includes('checkpoint-type'), 'no production checkpoint, no type change')
  const take = sc.journal().find(r => r.t === 'lcp-take' && r.name === 'a')
  assert.strictEqual(take.origType, null)
  assert.match(take.snapName, /^hvmcp-lease-[0-9a-f]{12}$/)
  assert.strictEqual(vmOf(sc, linux.name).state, 'Running')
  // Change, then restore: the file follows the checkpoint.
  await c.request('run', { command: 'write /build/state.txt after' })
  const back = await c.request('restore-checkpoint', { name: 'a' })
  assert.match(back.text, /Restored .* to its checkpoint "a"/)
  assert.match((await c.request('run', { command: 'cat /build/state.txt' })).text, /before/)
  // Released: back to clean, the lease's checkpoint removed.
  await c.request('release')
  const vm = vmOf(sc, linux.name)
  assert.deepStrictEqual(vm.checkpoints.map(x => x.name), ['clean'])
  assert.ok(vm.removedSnaps.includes(take.snapName))
  await h.stop()
})

test('the helper killed mid-run: the next one\'s recovery restores the Linux VM and voids the lease', async () => {
  const { sc, h, linux } = await mixedPool('lx-crash')
  const c = h.conn(7)
  await c.request('acquire', { minutes: 30, os: 'linux' })
  await c.request('start', {})
  await c.request('run', { command: 'write /build/sentinel.txt x' })
  // Left pending: a killed helper answers nothing more.
  c.request('run', { command: 'sleep', timeoutSec: 60 }).catch(() => null)
  await waitFor(() => (sc.stub().sshCalls || []).some(x => x.op === 'run-poll' && x.vmId === linux.id), 10_000, 'the run polling')
  const r0 = vmOf(sc, linux.name).restores
  await h.kill()
  const h2 = await startHelper(sc)
  const vm = vmOf(sc, linux.name)
  assert.ok(vm.restores > r0, 'restored at recovery')
  assert.strictEqual(vm.state, 'Off')
  assert.strictEqual(vm.disk['/build/sentinel.txt'], undefined, 'the run\'s file is gone')
  assert.match(await statusText(h2.conn(1)), new RegExp(`${linux.name}: linux .*free`))
  await h2.stop()
})

test('refusals: distro with another os, an unknown distro, activate for a Linux image; server.js asks no Linux acquire of a helper without the linux feature', async t => {
  const { sc, h, admin } = await mixedPool('lx-refuse')
  const c = h.conn(7)
  await assert.rejects(c.request('acquire', { distro: 'debian', os: 'windows' }), /distro is for Linux VMs/)
  await assert.rejects(c.request('acquire', { distro: 'fedora' }), /distro must be debian or ubuntu/)
  assert.match((await c.request('acquire', { distro: 'ubuntu' }).then(r => r.text, e => e.message)), /the pool has no free linux VM|No VM is free/)
  await assert.rejects(admin.request('pool_plan', { action: 'resize', image: D, vms: 2, activate: true }), /activate is for Windows images/)
  await h.stop()
  const shim = path.join(sc.dir, 'older-core.js')
  const count = path.join(sc.dir, 'acquires.txt')
  fs.writeFileSync(shim, `const fs = require('fs')
const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') return { text: 'hyperv-mcp/3', data: { protocol: 'hyperv-mcp/3', features: ['projects', 'images', 'named'], buildRoots: [] } }
  if (op === 'acquire') fs.appendFileSync(${JSON.stringify(count)}, JSON.stringify(args) + '\\n')
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  assert.match((await s.call('vm_acquire', { os: 'linux' })).text, /has no 'linux' feature, which asking for a Linux VM needs: run setup again/)
  assert.match((await s.call('vm_acquire', { distro: 'debian' })).text, /has no 'linux' feature, which asking for a debian VM needs/)
  assert.ok(!fs.existsSync(count), 'no acquire reached the helper')
})

test('pool checkpoints and refresh-clean on a Linux VM: published from a lease (no logon to undo), started from by another; refreshed by its guest checks', async () => {
  const { sc, h, admin, linux } = await mixedPool('lx-pcp')
  const a = h.conn(7)
  await a.request('acquire', { minutes: 30, vm: linux.name })
  await a.request('start', {})
  await a.request('run', { command: 'write /opt/tool.txt v1' })
  const calls0 = sc.stub().calls.length
  const p = await a.request('pool_plan', { action: 'checkpoint', name: 'tools', targets: [linux.name] })
  assert.match(p.text, /publish the pool checkpoint "tools" of hvmcp-\w+ \(owner other, linux/)
  approve(sc, p.data.planId)
  assert.match((await a.request('pool_checkpoint', { planId: p.data.planId })).text, /published/)
  const ops = sc.stub().calls.slice(calls0).map(x => x.op)
  assert.ok(!ops.includes('guest-logon-undo'), 'no Windows logon undo on a Linux guest')
  assert.ok(ops.includes('net-disconnect') && ops.includes('guest-shutdown') && ops.includes('pool-take'), ops.join(', '))
  await a.request('release')
  const b = h.conn(8)
  assert.match((await b.request('acquire', { minutes: 30, checkpoint: 'tools', os: 'linux' })).text, new RegExp(`^Leased ${linux.name}`))
  await b.request('start', {})
  assert.match((await b.request('run', { command: 'cat /opt/tool.txt' })).text, /v1/)
  await b.request('release')
  // refresh-clean: the guest's checks run again; no Windows steps; the pool checkpoint kept.
  const verifies = () => sc.stub().sshCalls.filter(x => x.op === 'verify' && x.vmId === linux.id).length
  const v0 = verifies()
  const rp = await admin.request('pool_plan', { action: 'refresh-clean', targets: [linux.name] })
  approve(sc, rp.data.planId)
  const c1 = sc.stub().calls.length
  await admin.request('pool_refresh', { planId: rp.data.planId })
  await waitFor(async () => /Last pool job: refresh (finished|FAILED)/.test(await statusText(admin)), 30_000, 'the refresh job')
  assert.match(await statusText(admin), /Last pool job: refresh finished: hvmcp-\w+: refreshed \(Linux, no licence; profiles kept as built; its pool checkpoints kept\)/)
  assert.strictEqual(verifies(), v0 + 1)
  const rops = sc.stub().calls.slice(c1).map(x => x.op)
  for (const op of ['guest-setup', 'guest-defender', 'guest-licence']) assert.ok(!rops.includes(op), `no ${op}`)
  assert.ok(vmOf(sc, linux.name).checkpoints.some(x => x.name.startsWith('hvmcp-pool-')), 'the pool checkpoint is kept')
  await h.stop()
})
