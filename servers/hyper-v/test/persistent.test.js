// MC-1582: a persistent VM, for research (the user's choice in a plan; disposable stays the default). Through helper.js
// against the stub Hyper-V: the plan and its journal bind it; plain acquires never get it, a named one does; it is never
// restored by a release, a stop, a disconnect, a helper restart, a quarantine retry, a plain start or a failed start's
// cleanup (it is parked: shut down, disconnected, no reserve, its disk kept), and only an explicit clean start, a pool
// checkpoint or vm_reset restores it; its leases have no work-session cap but keep maxLeaseMinutes; interactive starts
// and refresh are refused on it; and server.js refuses persistent for a helper without the feature, and sends reset
// only from vm_reset.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { T, scratch, startHelper, withPool, approve, waitFor } = require('./helpers')
const { server } = require('../client')

const vmsOf = sc => Object.values(sc.stub().vms)
const restores = (sc, vm) => (sc.stub().restores || []).filter(r => !vm || r.vmId === vm.id).length
const parks = sc => (sc.stub().parks || []).length
const KEEP = 'C:\\research.txt'

/** A pool of one disposable VM, then one persistent VM added by an approved resize. */
async function pool(name, { policy = {}, env = {} } = {}) {
  const sc = scratch(name, { policy: { maxVms: 4, maxMemoryMBTotal: 65536, ...policy } })
  let { h, admin } = await withPool(sc, 1)
  const plan = await admin.request('pool_plan', { action: 'resize', vms: 2, persistent: true })
  approve(sc, plan.data.planId)
  await admin.request('pool_resize', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: resize finished/.test((await admin.request('status')).text), T.poolJobMs, 'the resize')
  if (Object.keys(env).length) { await h.stop(); h = await startHelper(sc, env); admin = h.conn(1) }
  const ready = sc.journal().filter(r => r.t === 'ready')
  const persistent = vmsOf(sc).find(v => v.id === ready.find(r => r.persistent).vmId)
  const disposable = vmsOf(sc).find(v => v.id !== persistent.id)
  return { sc, h, admin, plan, persistent, disposable }
}
/** Leases the persistent VM by name, starts it (plain) and writes the research file. */
async function leaseAndWrite(c, name) {
  await c.request('acquire', { vm: name, minutes: 30 })
  await c.request('start')
  await c.request('run', { command: `write ${KEEP} kept` })
}

test('MC-1582: the plan says what a persistent VM gives up; the journal binds it to the VMs it builds, never the others; status shows it', async t => {
  const { sc, h, admin, plan, persistent, disposable } = await pool('pers-plan')
  t.after(() => h.stop())
  assert.match(plan.text, /- create hvmcp-[0-9a-f]+: .*network adapter disconnected; PERSISTENT/)
  assert.match(plan.text, /- PERSISTENT \(MC-1582\): each VM this plan builds is never restored to clean at release, .*keeps whatever its runs left .*Plain acquires never get it; vm_acquire\(\{ vm \}\) does\. Its leases have no work-session cap \(each acquire and renew stays within maxLeaseMinutes\)\. .*vm_reset restores it and discards what it kept/)
  const file = JSON.parse(fs.readFileSync(path.join(sc.stateDir, 'plans', `${plan.data.planId}.json`), 'utf8'))
  assert.strictEqual(file.persistent, true, 'in the plan record the approval\'s digest covers')
  assert.ok(file.add.every(a => a.persistent === true))
  const ready = sc.journal().filter(r => r.t === 'ready')
  assert.deepStrictEqual(ready.map(r => !!r.persistent), [false, true])
  const st = (await admin.request('status')).text
  assert.match(st, new RegExp(`- ${persistent.name}: .*PERSISTENT \\(never restored at release; leased only by name\\)`))
  assert.doesNotMatch(st, new RegExp(`- ${disposable.name}: [^\\n]*PERSISTENT`))
  // The option's own refusals; and a shrinking resize removes the disposable VM before the persistent one.
  await assert.rejects(admin.request('pool_plan', { action: 'resize', vms: 2, persistent: 'yes' }), /persistent must be true, or left out/)
  await assert.rejects(admin.request('pool_plan', { action: 'resize', vms: 1, persistent: true }), /persistent is for a plan that builds VMs/)
  const shrink = await admin.request('pool_plan', { action: 'resize', vms: 1 })
  assert.match(shrink.text, new RegExp(`- remove ${disposable.name} and its folder`))
  assert.doesNotMatch(shrink.text, new RegExp(`- remove ${persistent.name}`))
  const all = await admin.request('pool_plan', { action: 'remove' })
  assert.match(all.text, new RegExp(`- remove ${persistent.name} and its folder .* \\(a persistent VM: what it kept is lost, its kept checkpoints with it\\)`))
})

test('MC-1582: plain acquires never get a persistent VM; a named one does, with no work-session cap', async t => {
  const { sc, h, persistent, disposable } = await pool('pers-acquire', { policy: { maxLeaseMinutes: 30, maxSessionMinutes: 30 } })
  t.after(() => h.stop())
  const a = h.conn(10); const b = h.conn(11); const c = h.conn(12)
  const plain = await a.request('acquire', { minutes: 30 })
  assert.strictEqual(plain.data.vm, disposable.name)
  assert.strictEqual(plain.data.persistent, undefined)
  await assert.rejects(b.request('acquire', { minutes: 30 }), /No VM is free|none is free/, 'the persistent VM is free, but not for a plain acquire')
  const named = await c.request('acquire', { vm: persistent.name, minutes: 30 })
  assert.strictEqual(named.data.persistent, true)
  assert.match(named.text, /PERSISTENT: it is never restored at release or at a plain vm_start/)
  // No work-session cap: only the stub image's Windows evaluation ends it (about 90 days away), as it would any lease.
  assert.match(named.text, /\((a persistent VM: no work-session cap|its Windows evaluation's end)\)/)
  assert.ok(named.data.sessionEnd > Date.now() + 24 * 60 * 60_000, 'far past the policy\'s 30-minute session')
  assert.ok(plain.data.sessionEnd <= Date.now() + 30 * 60_000, 'the disposable lease keeps the policy\'s cap')
  // Renewals past where the session cap would have ended it: each within maxLeaseMinutes, again and again.
  for (let i = 0; i < 3; i++) assert.match((await c.request('renew', { minutes: 30 })).text, /^Renewed:/)
  await assert.rejects(a.request('renew', { minutes: 30 }), /past this work session's end/, 'the disposable one can\'t')
  await assert.rejects(c.request('renew', { minutes: 31 }), /minutes must be 1-30 \(the policy's maxLeaseMinutes\)/)
  void sc
})

test('MC-1582: its state survives stop, a plain start, release and the next named lease: parked each time, never restored', async t => {
  const { sc, h, persistent } = await pool('pers-keep')
  t.after(() => h.stop())
  const c = h.conn(10)
  const r0 = restores(sc, persistent)
  const p0 = parks(sc)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  const started = await c.request('start')
  assert.match(started.text, /Started hvmcp-[0-9a-f]+ from its disk as it was \(persistent: not restored; vm_start\(\{ checkpoint: 'clean' \}\) or vm_reset for clean\): shut down and parked/)
  assert.match(started.text, /C:\\out keeps what earlier runs left/)
  assert.deepStrictEqual([started.data.persistent, started.data.restored], [true, false])
  await c.request('run', { command: `write ${KEEP} kept` })
  const stopped = await c.request('stop')
  assert.match(stopped.text, /^Stopped: hvmcp-[0-9a-f]+ parked \(persistent: shut down, network disconnected, no CPU reserve; not restored, so its disk keeps what the lease left\)\./)
  await c.request('start')
  assert.match((await c.request('run', { command: `cat ${KEEP}` })).text, /kept/, 'after a stop and a plain start')
  const rel = await c.request('release')
  assert.match(rel.text, /^Released\. hvmcp-[0-9a-f]+ parked \(persistent/)
  const vm = vmsOf(sc).find(v => v.id === persistent.id)
  assert.deepStrictEqual([vm.state, vm.switchName, vm.reserve], ['Off', null, 0], 'parked: off, disconnected, no reserve')
  assert.ok(vm.disk[KEEP], 'its disk kept the file')
  const d = h.conn(11)
  await d.request('acquire', { vm: persistent.name, minutes: 30 })
  await d.request('start')
  assert.match((await d.request('run', { command: `cat ${KEEP}` })).text, /kept/, 'the next lease sees it')
  assert.strictEqual(restores(sc, persistent), r0, 'no restore of it, ever')
  assert.ok(parks(sc) >= p0 + 4, 'a park at each start, stop and release')
})

test('MC-1582: only an explicit clean start, a pool checkpoint name or vm_reset restores it', async t => {
  const { sc, h, persistent } = await pool('pers-explicit')
  t.after(() => h.stop())
  const c = h.conn(10)
  await leaseAndWrite(c, persistent.name)
  const r0 = restores(sc, persistent)
  const clean = await c.request('start', { checkpoint: 'clean' })
  assert.match(clean.text, /Started hvmcp-[0-9a-f]+ from its clean checkpoint/)
  assert.strictEqual(restores(sc, persistent), r0 + 1)
  assert.match((await c.request('run', { command: `check ${KEEP}` })).text, /^Exit code 1\./, 'the explicit clean start discarded it')
  await c.request('run', { command: `write ${KEEP} again` })
  const reset = await c.request('start', { reset: true })
  assert.match(reset.text, /from its clean checkpoint/)
  assert.strictEqual(restores(sc, persistent), r0 + 2)
  assert.match((await c.request('run', { command: `check ${KEEP}` })).text, /^Exit code 1\./, 'vm_reset discarded it')
})

test('MC-1582: a disconnect, a helper restart, a failed start\'s cleanup and a quarantine retry park it, never restore it', async t => {
  const { sc, h, persistent } = await pool('pers-cleanup', { env: T.profile('retryQuick') })
  let helper = h
  t.after(() => helper.stop())
  const r0 = restores(sc, persistent)
  // A disconnect ends the lease: parked.
  const c = helper.conn(10)
  await leaseAndWrite(c, persistent.name)
  await c.close()
  await waitFor(() => vmsOf(sc).find(v => v.id === persistent.id).state === 'Off', T.waitForMs, 'the park after the disconnect')
  // A failed start's cleanup.
  const d = helper.conn(11)
  await waitFor(async () => d.request('acquire', { vm: persistent.name, minutes: 30 }).then(() => true, () => false), T.waitForMs, 'the VM free again')
  sc.patchStub(s => { s.fail['configure-start'] = 1 })
  await assert.rejects(d.request('start'), /injected failure of configure-start\. hvmcp-[0-9a-f]+ parked \(persistent: .*not restored, so its disk keeps what the lease left\)\.$/)
  await d.request('start')
  await d.request('run', { command: `write ${KEEP} kept` })
  // A Windows run whose timeout kill through its job can't be confirmed: the VM is shut down to end it, not restored.
  sc.patchStub(s => { s.runJobs = true; s.jobKillFails = true })
  const timedOut = await d.request('run', { command: 'sleep', timeoutSec: 1 })
  assert.match(timedOut.text, /its job's kill couldn't be confirmed .*The VM was shut down to end everything the run started: hvmcp-[0-9a-f]+ parked \(persistent: .*\)\. Its output above was read first; vm_start \(its disk as it is\) or vm_reset \(clean\) to go on\./)
  assert.doesNotMatch(timedOut.text, /restored to its clean checkpoint/)
  sc.patchStub(s => { s.runJobs = false; s.jobKillFails = false })
  await d.request('start')
  // A helper restart voids the lease: parked, reported so.
  await helper.kill()
  helper = await startHelper(sc, T.profile('retryQuick'))
  assert.match((await helper.conn(1).request('status')).text, new RegExp(`${persistent.name}: parked \\(persistent: not restored\\)\\.`))
  assert.ok(vmsOf(sc).find(v => v.id === persistent.id).disk[KEEP], 'kept through the restart')
  // A park that doesn't verify quarantines it; the retry parks it again.
  const e = helper.conn(12)
  await e.request('acquire', { vm: persistent.name, minutes: 30 })
  await e.request('start')
  sc.patchStub(s => { s.parkFails = 1 })
  const rel = await e.request('release')
  assert.match(rel.text, /CLEANUP FAILED: hvmcp-[0-9a-f]+ \(persistent\) could not be confirmed parked \(state is Running, not Off\)\. It is quarantined .*Its disk was not restored\./)
  await waitFor(async () => !/QUARANTINED/.test((await helper.conn(1).request('status')).text), T.waitForMs, 'the retry\'s park')
  assert.ok(vmsOf(sc).find(v => v.id === persistent.id).disk[KEEP], 'kept through the quarantine and its retry')
  assert.strictEqual(restores(sc, persistent), r0, 'none of these restored it')
})

test('MC-1582: a clean-checkpoint refresh is refused on a persistent VM (MC-1590: an interactive start is offered)', async t => {
  const { h, admin, persistent, disposable } = await pool('pers-refuse')
  t.after(() => h.stop())
  const c = h.conn(10)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  await assert.rejects(admin.request('pool_plan', { action: 'refresh-clean', targets: [persistent.name] }), /is persistent: a clean-checkpoint refresh restores it first/)
  assert.ok((await admin.request('pool_plan', { action: 'refresh-clean', targets: [disposable.name] })).data.planId, 'a disposable one still can be')
})

test('MC-1582 through server.js: vm_reset sends reset (vm_start never does); an older helper without the feature gets no persistent plan', async t => {
  const sc = scratch('pers-server')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const log = path.join(sc.dir, 'requests.txt')
  const shim = (features) => {
    const f = path.join(sc.dir, `shim-${features ? 'old' : 'new'}.js`)
    fs.writeFileSync(f, `const fs = require('fs')
const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  ${features ? `if (op === 'version') { const v = await request.call(this, connId, op, args); return { ...v, data: { ...v.data, features: v.data.features.filter(x => x !== 'persistent') } } }` : ''}
  if (op === 'start' || op === 'pool_plan') fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ op, args }) + '\\n')
  return request.call(this, connId, op, args)
}
`)
    return f
  }
  const env = f => ({ ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(f)}` })
  const lines = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  // An older helper: refused before anything is sent.
  const old = server(env(shim(true)), { roots: [sc.builds] })
  const refused = await old.call('pool_plan', { action: 'resize', vms: 2, persistent: true })
  assert.match(refused.text, /has no 'persistent' feature, which a persistent VM \(persistent\) needs: run setup again to update it/)
  assert.ok(!lines().some(l => l.op === 'pool_plan'), 'no pool_plan reached the helper')
  assert.ok(!fs.readdirSync(path.join(sc.stateDir, 'plans')).some(f => fs.readFileSync(path.join(sc.stateDir, 'plans', f), 'utf8').includes('persistent')), 'nothing recorded')
  await old.call('vm_acquire')
  await old.call('vm_start')
  await old.call('vm_reset')
  assert.ok(lines().filter(l => l.op === 'start').every(l => l.args.reset === undefined), 'an older helper is never sent reset')
  await old.close()
  fs.rmSync(log)
  // This helper: vm_reset says reset; vm_start never does.
  const s = server(env(shim(false)), { roots: [sc.builds] })
  t.after(() => s.close())
  await s.call('vm_acquire')
  await s.call('vm_start')
  await s.call('vm_reset')
  assert.deepStrictEqual(lines().filter(l => l.op === 'start').map(l => l.args.reset ?? null), [null, true])
})

// hv.ps1's own $Park, run in Windows PowerShell 5.1 with the Hyper-V cmdlets it calls shadowed by script functions (a
// function wins over a cmdlet of the same name): a guest that never finishes shutting down (Stop-VM -Force's job never
// ends) is turned off once shutdownMs is up, the call returns within it, and the shutdown job is stopped and removed.
test('MC-1582: hv.ps1\'s $Park for real: the shutdown bounded by shutdownMs, the turn-off reached, the job removed; a quick shutdown, a saved and a paused VM', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('child_process')
  const { ps51Env } = require('../helper/hv')
  const HV = fs.readFileSync(path.join(__dirname, '..', 'helper', 'hv.ps1'), 'utf8')
  const s = HV.indexOf('\n$Park = {')
  const block = HV.slice(s + 1, HV.indexOf('\n}\n', s + 1) + 3)
  assert.ok(block.startsWith('$Park = {'), 'found $Park')
  const sc = scratch('pers-park-ps')
  const harness = path.join(sc.dir, 'park.ps1')
  fs.writeFileSync(harness, `$ErrorActionPreference = 'Stop'
$script:st = 'Running'; $script:offAt = $null; $script:log = @()
function Get-VM { param($Id) if ($script:offAt -and (Get-Date) -ge $script:offAt) { $script:st = 'Off' }; [pscustomobject]@{ State = $script:st } }
function Stop-VM { [CmdletBinding()] param($VM, [switch]$Force, [switch]$AsJob, [switch]$TurnOff)
  if ($TurnOff) { $script:st = 'Off'; $script:log += 'turnoff'; return }
  $script:log += 'shutdown'
  if ($script:mode -eq 'quick') { $script:offAt = (Get-Date).AddMilliseconds(600) }
  Start-Job -ScriptBlock { Start-Sleep 120 } }
function Remove-VMSavedState { param($VM) $script:st = 'Off'; $script:log += 'drop-saved' }
function Get-VMNetworkAdapter { param($VM) 'nic' }
function Disconnect-VMNetworkAdapter { process { $script:log += 'disconnect' } }
function Clear-Acls { param($vm) $script:log += 'acls' }
function Set-VMProcessor { [CmdletBinding()] param($VM, $Reserve) $script:log += "reserve $Reserve" }
function Facts { param($vm) @{ state = $script:st } }
${block}
$vm = [pscustomobject]@{ Id = [guid]::NewGuid() }
$out = @{}
foreach ($case in @(@('hung', 'Running', 2000), @('quick', 'Running', 20000), @('saved', 'Saved', 20000), @('paused', 'Paused', 20000))) {
  $script:mode = $case[0]; $script:st = $case[1]; $script:offAt = $null; $script:log = @()
  $t = [Diagnostics.Stopwatch]::StartNew()
  $f = & $Park $vm $case[2]
  $out[$case[0]] = @{ ms = $t.ElapsedMilliseconds; forced = $f.park.forced; state = $f.state; log = @($script:log); jobs = @(Get-Job).Count }
}
'RESULT:' + (ConvertTo-Json -InputObject $out -Depth 5 -Compress)
`)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', env: ps51Env(), timeout: T.spawnMs, windowsHide: true })
  const m = /RESULT:(.*)/.exec(r.stdout || '')
  assert.ok(m, `no result: ${r.stdout}${r.stderr}`)
  const res = JSON.parse(m[1])
  const tail = ['disconnect', 'acls', 'reserve 0']
  // A guest that never shuts down: turned off once its 2 s are up, not after Stop-VM's own wait (minutes).
  assert.deepStrictEqual(res.hung.log, ['shutdown', 'turnoff', ...tail])
  assert.deepStrictEqual([res.hung.forced, res.hung.state, res.hung.jobs], [true, 'Off', 0], 'turned off; the shutdown job stopped and removed')
  assert.ok(res.hung.ms >= 1900 && res.hung.ms < 8000, `bounded by shutdownMs: ${res.hung.ms} ms`)
  // A guest that shuts down in time: no turn-off, and no wait past it.
  assert.deepStrictEqual(res.quick.log, ['shutdown', ...tail])
  assert.deepStrictEqual([res.quick.forced, res.quick.state, res.quick.jobs], [false, 'Off', 0])
  assert.ok(res.quick.ms < 8000, `${res.quick.ms} ms`)
  // A saved state is discarded (no shutdown to ask for); a paused VM is turned off at once.
  assert.deepStrictEqual([res.saved.log, res.saved.forced], [['drop-saved', ...tail], false])
  assert.deepStrictEqual([res.paused.log, res.paused.forced], [['turnoff', ...tail], true])
  assert.ok(res.paused.ms < 3000, `no wait for a paused VM: ${res.paused.ms} ms`)
})

// MC-1589: a persistent VM's lease checkpoints are the VM's: kept with it at the lease's end (lcp-keep), through a
// helper restart, listed in vm_status for everyone, restorable by a later lease that names it, removed only on request
// (vm_checkpoint's remove) or with the VM; within maxCheckpointsPerVm. A disposable VM's go with the lease, as before.
const snapOf = (sc, name) => sc.journal().find(r => r.t === 'lcp-take' && r.name === name).snapName
const stubOf = (sc, vm) => vmsOf(sc).find(v => v.id === vm.id)

test('MC-1589: a checkpoint taken in one lease of a persistent VM survives release and a helper restart; a later named lease restores it, and removes it on request', async t => {
  const { sc, h, persistent } = await pool('pers-cp-keep')
  let helper = h
  t.after(() => helper.stop())
  const c = helper.conn(10)
  await leaseAndWrite(c, persistent.name)
  const taken = await c.request('checkpoint', { name: 'tools' })
  assert.match(taken.text, /^Checkpoint "tools" taken .*it's kept with hvmcp-[0-9a-f]+ after this lease \(persistent\): a later lease that names the VM can vm_restore it, until vm_checkpoint\(\{ name, remove: true \}\) removes it or the VM is removed\./)
  assert.match((await c.request('status')).text, /your checkpoints \(kept with it after your lease\): "tools" \(taken /)
  await c.request('run', { command: 'write C:\\after.txt later' })
  assert.match((await c.request('release')).text, /^Released\. hvmcp-[0-9a-f]+ parked/)
  const snap = snapOf(sc, 'tools')
  assert.ok(stubOf(sc, persistent).checkpoints.some(x => x.name === snap), 'still in Hyper-V after the release')
  assert.ok(sc.journal().some(r => r.t === 'lcp-keep' && r.checkpointId), 'journalled as kept with the VM, by its id')
  assert.ok(!sc.journal().some(r => r.t === 'lcp-drop' || r.t === 'lcp-dropped'), 'never removed')
  // A helper restart: replayed from the journal, still listed (for any caller, the VM free).
  await helper.stop()
  helper = await startHelper(sc)
  const keptLine = new RegExp(`- ${persistent.name}: [^\\n]*; checkpoints it keeps \\(vm_restore by name in a lease of it\\): "tools" \\(taken `)
  const st = (await helper.conn(1).request('status')).text
  assert.match(st, keptLine)
  assert.match(st, new RegExp(`- ${persistent.name}: [^\\n]*free`))
  // A later lease, another session, by name: restores it (the file written before it is back, the one after is gone).
  const d = helper.conn(11)
  await d.request('acquire', { vm: persistent.name, minutes: 30 })
  await d.request('start')
  assert.match((await d.request('status')).text, keptLine, 'the holder sees it among the VM\'s')
  await assert.rejects(d.request('checkpoint', { name: 'tools' }), /already keeps a checkpoint "tools" from an earlier lease: vm_restore it, or remove it first/)
  assert.match((await d.request('restore-checkpoint', { name: 'tools' })).text, /^Restored hvmcp-[0-9a-f]+ to its checkpoint "tools" and started it/)
  assert.match((await d.request('run', { command: `cat ${KEEP}` })).text, /kept/)
  assert.match((await d.request('run', { command: 'check C:\\after.txt' })).text, /^Exit code 1\./, 'the change after the checkpoint is gone')
  // Removed on request (the VM needn't be running), and only then.
  await d.request('stop')
  const removed = await d.request('checkpoint', { name: 'tools', remove: true })
  assert.match(removed.text, /^Checkpoint "tools" removed from hvmcp-[0-9a-f]+\.$/)
  assert.ok(!stubOf(sc, persistent).checkpoints.some(x => x.name === snap), 'gone from Hyper-V')
  assert.deepStrictEqual(sc.journal().filter(r => r.t === 'lcp-drop' || r.t === 'lcp-dropped').map(r => r.t), ['lcp-drop', 'lcp-dropped'])
  assert.doesNotMatch((await d.request('status')).text, /checkpoints it keeps/)
  await assert.rejects(d.request('restore-checkpoint', { name: 'tools' }), /hvmcp-[0-9a-f]+ has no checkpoint "tools"\./)
  await assert.rejects(d.request('checkpoint', { name: 'tools', remove: true }), /has no checkpoint "tools"/)
  await assert.rejects(d.request('checkpoint', { name: 'tools', remove: 'yes' }), /remove must be true, or left out/)
})

test('MC-1589: a take that Hyper-V completes after its call failed is kept with the persistent VM once the release finds it', async t => {
  const { sc, h, persistent } = await pool('pers-cp-delayed')
  t.after(() => h.stop())
  const c = h.conn(10)
  await leaseAndWrite(c, persistent.name)
  sc.patchStub(st => { st.productionFailDelayed = true })
  await assert.rejects(c.request('checkpoint', { name: 'late' }), /couldn't be taken .*settled when this lease ends/)
  sc.patchStub(st => { st.productionFailDelayed = false })
  await c.request('release')
  const snap = snapOf(sc, 'late')
  const found = stubOf(sc, persistent).checkpoints.find(x => x.name === snap)
  assert.ok(found, 'it appeared later, and was kept, not removed')
  assert.ok(sc.journal().some(r => r.t === 'lcp-keep' && r.checkpointId === found.id), 'kept by the id it was found with')
  const d = h.conn(11)
  await d.request('acquire', { vm: persistent.name, minutes: 30 })
  assert.match((await d.request('restore-checkpoint', { name: 'late' })).text, /^Restored hvmcp-[0-9a-f]+ to its checkpoint "late"/)
})

test('MC-1589: a persistent VM\'s checkpoints count against maxCheckpointsPerVm across leases; maxLeaseCheckpoints counts one lease\'s takes', async t => {
  const { h, persistent } = await pool('pers-cp-caps', { policy: { maxLeaseCheckpoints: 1, maxCheckpointsPerVm: 2 } })
  t.after(() => h.stop())
  const lease = async n => { const c = h.conn(n); await c.request('acquire', { vm: persistent.name, minutes: 30 }); await c.request('start'); return c }
  const c = await lease(10)
  await c.request('checkpoint', { name: 'a' })
  await c.request('release')
  const d = await lease(11)
  assert.match((await d.request('checkpoint', { name: 'b' })).text, /^Checkpoint "b" taken/, 'the kept "a" isn\'t this lease\'s take')
  await assert.rejects(d.request('checkpoint', { name: 'c' }), /This lease holds 1 checkpoints, the policy's maxLeaseCheckpoints \(1\)/)
  await d.request('release')
  const e = await lease(12)
  await assert.rejects(e.request('checkpoint', { name: 'c' }), /hvmcp-[0-9a-f]+ \(persistent\) holds 2 checkpoints of its own, the policy's maxCheckpointsPerVm \(2\) in all: remove one first/)
  await e.request('checkpoint', { name: 'a', remove: true })
  assert.match((await e.request('checkpoint', { name: 'c' })).text, /^Checkpoint "c" taken/)
})

test('MC-1589: a disposable VM keeps today\'s behaviour: its checkpoints go with the lease (and remove works on it too)', async t => {
  const { sc, h, disposable } = await pool('pers-cp-disposable')
  t.after(() => h.stop())
  const c = h.conn(10)
  assert.strictEqual((await c.request('acquire', { minutes: 30 })).data.vm, disposable.name)
  await c.request('start')
  assert.match((await c.request('checkpoint', { name: 'a' })).text, /it's removed when this lease ends\.$/)
  await c.request('checkpoint', { name: 'b' })
  assert.match((await c.request('checkpoint', { name: 'b', remove: true })).text, /^Checkpoint "b" removed from /)
  assert.match((await c.request('status')).text, /your checkpoints: "a" \(taken [^)]+\)(;|\n|$)/)
  await c.request('release')
  assert.deepStrictEqual(stubOf(sc, disposable).checkpoints.map(x => x.name), ['clean'], 'removed with the lease')
  assert.ok(!sc.journal().some(r => r.t === 'lcp-keep'), 'nothing kept')
  const d = h.conn(11)
  await d.request('acquire', { minutes: 30 })
  await assert.rejects(d.request('restore-checkpoint', { name: 'a' }), /This lease has no checkpoint "a"\./)
  assert.doesNotMatch((await d.request('status')).text, /checkpoints it keeps/)
})

test('MC-1589 round 1: a removal that fails holds its checkpoint slot until it is confirmed, then is retried (a lease\'s own at its end; a kept one at the VM\'s next cleanup)', async t => {
  const { sc, h, disposable, persistent } = await pool('pers-cp-remove-fails', { policy: { maxLeaseCheckpoints: 1, maxCheckpointsPerVm: 1 } })
  t.after(() => h.stop())
  // A disposable lease's own take: the slot stays taken, and the release removes it.
  const c = h.conn(10)
  assert.strictEqual((await c.request('acquire', { minutes: 30 })).data.vm, disposable.name)
  await c.request('start')
  await c.request('checkpoint', { name: 'a' })
  const snapA = snapOf(sc, 'a')
  sc.patchStub(st => { st.fail['snapshot-remove'] = 1 })
  await assert.rejects(c.request('checkpoint', { name: 'a', remove: true }), /Removing the checkpoint "a" failed \(.*injected failure of snapshot-remove\); it is retried when this lease ends, and holds its checkpoint slot until then\./)
  assert.ok(stubOf(sc, disposable).checkpoints.some(x => x.name === snapA), 'still there')
  await assert.rejects(c.request('checkpoint', { name: 'b' }), /This lease holds 1 checkpoints \(1 whose removal didn't finish: retried when this lease ends\), the policy's maxLeaseCheckpoints \(1\)/)
  await c.request('start', { reset: true })
  await assert.rejects(c.request('checkpoint', { name: 'b' }), /This lease holds 1 checkpoints/, 'a reset within the lease keeps the slot held')
  assert.match((await c.request('release')).text, /^Released/)
  assert.deepStrictEqual(stubOf(sc, disposable).checkpoints.map(x => x.name), ['clean'], 'removed at the lease\'s end')
  // A persistent VM's kept one: counts against maxCheckpointsPerVm while its removal is unconfirmed; the next park retries it.
  const d = h.conn(11)
  await d.request('acquire', { vm: persistent.name, minutes: 30 })
  await d.request('start')
  await d.request('checkpoint', { name: 'k' })
  await d.request('release')
  const e = h.conn(12)
  await e.request('acquire', { vm: persistent.name, minutes: 30 })
  sc.patchStub(st => { st.fail['snapshot-remove'] = 1 })
  await assert.rejects(e.request('checkpoint', { name: 'k', remove: true }), /it is retried at the VM's next cleanup \(a stop, start or release\)\./)
  const snapK = snapOf(sc, 'k')
  assert.ok(stubOf(sc, persistent).checkpoints.some(x => x.name === snapK), 'still there')
  await e.request('start') // the park before it retries the removal
  assert.ok(!stubOf(sc, persistent).checkpoints.some(x => x.name === snapK), 'removed by the retry')
  assert.match((await e.request('checkpoint', { name: 'k2' })).text, /^Checkpoint "k2" taken/, 'the slot is free once the removal is confirmed')
})

test('MC-1589 round 1: an interrupted take on a persistent VM that made nothing still gets its checkpoint type put back at release', async t => {
  const { sc, h, persistent } = await pool('pers-cp-type', { env: T.profile('retryQuick') })
  t.after(() => h.stop())
  const c = h.conn(10)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  await c.request('start')
  sc.patchStub(st => { st.productionCallDies = true; st.typeRestoreFails = true })
  await assert.rejects(c.request('checkpoint', { name: 'a' }), /the take call died\)\. Whether Hyper-V made one is settled when this lease ends/)
  sc.patchStub(st => { st.productionCallDies = false; st.typeRestoreFails = false })
  assert.strictEqual(stubOf(sc, persistent).checkpointType, 'ProductionOnly', 'the interrupted take left it')
  // Its put-back failing first keeps the intent (the VM quarantined); the retry puts it back and forgets the take.
  sc.patchStub(st => { st.typeSetFails = true })
  assert.match((await c.request('release')).text, /CLEANUP FAILED: .*the checkpoint type is ProductionOnly, not Production/)
  const opId = sc.journal().find(r => r.t === 'lcp-take' && r.name === 'a').opId
  assert.ok(!sc.journal().some(r => r.opId === opId && (r.t === 'lcp-dropped' || r.t === 'lcp-keep')), 'not forgotten while the type is wrong')
  sc.patchStub(st => { st.typeSetFails = false })
  const d = h.conn(11)
  await waitFor(async () => d.request('acquire', { vm: persistent.name, minutes: 30 }).then(() => true, () => false), T.waitForMs, 'the retry\'s park')
  assert.strictEqual(stubOf(sc, persistent).checkpointType, 'Production', 'put back')
  assert.ok(sc.journal().some(r => r.opId === opId && r.t === 'lcp-dropped'), 'then settled as never made')
  assert.ok(!sc.journal().some(r => r.t === 'lcp-keep'), 'nothing kept')
})

// MC-1591: an existing VM switched by a persistence plan (pool_plan action persistence, applied by pool_persistence),
// journalled; made disposable, it is restored to clean and verified first (its kept checkpoints removed); leased, it is
// refused at the plan and skipped by the job.
async function switchVm(admin, sc, targets, persistent) {
  const plan = await admin.request('pool_plan', { action: 'persistence', targets, persistent })
  approve(sc, plan.data.planId)
  const applied = await admin.request('pool_persistence', { planId: plan.data.planId })
  let st = ''
  await waitFor(async () => /Last pool job: persistence (finished|FAILED)/.test(st = (await admin.request('status')).text), T.poolJobMs, 'the persistence job')
  return { plan, applied, note: /Last pool job: persistence [^\n]*/.exec(st)[0] }
}

test('MC-1591: a disposable VM made persistent by a plan: journalled, leased only by name from then on, its state kept at release', async t => {
  const { sc, h, admin, disposable } = await pool('pers-switch-on')
  let helper = h
  t.after(() => helper.stop())
  const { plan, note } = await switchVm(admin, sc, [disposable.name], true)
  assert.match(plan.text, new RegExp(`^Plan p-[0-9a-f]+ \\(persistence\\)`))
  assert.match(plan.text, new RegExp(`- make ${disposable.name} persistent: from now on it is never restored to clean at release, .*plain acquires stop getting it, vm_acquire\\(\\{ vm \\}\\) does; .*It starts from its clean checkpoint, as it is now\\.`))
  const file = JSON.parse(fs.readFileSync(path.join(sc.stateDir, 'plans', `${plan.data.planId}.json`), 'utf8'))
  assert.deepStrictEqual(file.persistence.map(e => [e.vmId, e.persistent]), [[disposable.id, true]], 'bound in the plan record')
  assert.match(note, new RegExp(`finished: .*${disposable.name}: persistent now`))
  assert.ok(sc.journal().some(r => r.t === 'persistence' && r.vmId === disposable.id && r.persistent === true), 'journalled')
  assert.match((await admin.request('status')).text, new RegExp(`- ${disposable.name}: [^\\n]*PERSISTENT`))
  // Both VMs persistent now: a plain acquire gets neither; a named one does, and the VM keeps what it left.
  await assert.rejects(h.conn(10).request('acquire', { minutes: 30 }), /No VM is free|none is free/)
  const r0 = restores(sc, disposable)
  const c = h.conn(11)
  await leaseAndWrite(c, disposable.name)
  await c.request('release')
  assert.ok(stubOf(sc, disposable).disk[KEEP], 'kept at release')
  assert.strictEqual(restores(sc, disposable), r0, 'parked, not restored')
  // A helper restart keeps it persistent (the journal).
  await helper.stop()
  helper = await startHelper(sc)
  assert.match((await helper.conn(1).request('status')).text, new RegExp(`- ${disposable.name}: [^\\n]*PERSISTENT`))
})

test('MC-1591: a persistent VM made disposable again: restored to clean and verified first, its kept checkpoints removed, then plain acquires get it', async t => {
  const { sc, h, admin, persistent } = await pool('pers-switch-off')
  t.after(() => h.stop())
  const c = h.conn(10)
  await leaseAndWrite(c, persistent.name)
  await c.request('checkpoint', { name: 'kept' })
  await c.request('release')
  const r0 = restores(sc, persistent)
  const { plan, note } = await switchVm(admin, sc, [persistent.name], false)
  assert.match(plan.text, new RegExp(`- make ${persistent.name} disposable again: its clean checkpoint is restored first and verified \\(Off, at the checkpoint, network disconnected, no CPU reserve\\), which DISCARDS what it kept \\(installed software, files, settings, C:\\\\out, anything a run did\\) and removes the checkpoints it kept \\("kept"\\); its pool checkpoints stay\\.`))
  assert.match(note, new RegExp(`${persistent.name}: disposable again, restored to clean \\(verified\\); the checkpoints it kept are removed`))
  const jr = sc.journal()
  const flip = jr.findIndex(r => r.t === 'persistence' && r.vmId === persistent.id && r.persistent === false)
  assert.ok(flip >= 0, 'journalled')
  assert.strictEqual(restores(sc, persistent), r0 + 1, 'restored once, by the job')
  const vm = stubOf(sc, persistent)
  assert.ok(!vm.disk[KEEP], 'what it kept is discarded')
  assert.deepStrictEqual(vm.checkpoints.map(x => x.name), ['clean'], 'its kept checkpoint removed')
  assert.deepStrictEqual([vm.state, vm.switchName, vm.reserve, vm.parent], ['Off', null, 0, vm.checkpoints[0].id], 'verified clean')
  const st = (await admin.request('status')).text
  assert.doesNotMatch(st, new RegExp(`- ${persistent.name}: [^\\n]*PERSISTENT`))
  assert.doesNotMatch(st, /checkpoints it keeps/)
  // Plain acquires get it now (two disposable VMs, two plain leases).
  const got = [(await h.conn(11).request('acquire', { minutes: 30 })).data.vm, (await h.conn(12).request('acquire', { minutes: 30 })).data.vm]
  assert.ok(got.includes(persistent.name), `a plain acquire got it: ${got}`)
})

test('MC-1591: refusals: a leased VM (at the plan, and skipped by the job if leased since), the state it already has, bad arguments', async t => {
  const { sc, h, admin, persistent, disposable } = await pool('pers-switch-refuse')
  t.after(() => h.stop())
  const c = h.conn(10)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  await assert.rejects(admin.request('pool_plan', { action: 'persistence', targets: [persistent.name], persistent: false }), new RegExp(`${persistent.name} is leased: its lease must end before it can be switched\\. Nothing was planned\\.`))
  await assert.rejects(admin.request('pool_plan', { action: 'persistence', targets: [disposable.name], persistent: false }), /is already disposable/)
  await assert.rejects(admin.request('pool_plan', { action: 'persistence', targets: [disposable.name] }), /persistent must be true .* or false/)
  await assert.rejects(admin.request('pool_plan', { action: 'persistence', targets: [], persistent: true }), /targets must list at least one VM name/)
  await assert.rejects(admin.request('pool_plan', { action: 'persistence', targets: ['nope'], persistent: true }), /No ready VM named nope/)
  // Planned while free, leased before it applies: skipped, not switched.
  const plan = await admin.request('pool_plan', { action: 'persistence', targets: [disposable.name], persistent: true })
  approve(sc, plan.data.planId)
  assert.strictEqual((await h.conn(11).request('acquire', { minutes: 30 })).data.vm, disposable.name)
  await admin.request('pool_persistence', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: persistence finished: [^\n]*skipped \(leased/.test((await admin.request('status')).text), T.poolJobMs, 'the job, skipping it')
  assert.ok(!sc.journal().some(r => r.t === 'persistence'), 'nothing switched')
  await assert.rejects(admin.request('pool_persistence', { planId: plan.data.planId }), /already applied/)
})

test('MC-1591: a switch to disposable whose restore fails quarantines the VM (no lease gets it) until a retry restores it', async t => {
  const { sc, h, admin, persistent } = await pool('pers-switch-fail', { env: T.profile('retryQuick') })
  t.after(() => h.stop())
  const c = h.conn(10)
  await leaseAndWrite(c, persistent.name)
  await c.request('release')
  sc.patchStub(s => { s.fail.restore = 1 })
  const { note } = await switchVm(admin, sc, [persistent.name], false)
  assert.match(note, new RegExp(`${persistent.name}: disposable now, but its restore didn't verify .*quarantined until a restore confirms it`))
  await waitFor(async () => !/QUARANTINED/.test((await admin.request('status')).text), T.waitForMs, 'the retry\'s restore')
  assert.ok(!stubOf(sc, persistent).disk[KEEP], 'restored by the retry (not parked)')
})

// approve.ps1's own summary (the lines the administrator reads before typing the digest), run in Windows PowerShell
// 5.1 on synthetic persistence plans: both directions say what the switch does, by name.
test('MC-1591 round 1: approve.ps1\'s summary explains a persistence plan in both directions (what is discarded, the kept checkpoints named)', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('child_process')
  const { ps51Env } = require('../helper/hv')
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'helper', 'approve.ps1'), 'utf8')
  const s = SRC.indexOf('Write-Host "Plan ${Plan}')
  const e = SRC.indexOf('\nif (-not $Confirmed) {', s)
  assert.ok(s > 0 && e > s, 'found the summary block')
  const block = SRC.slice(s, e)
  const sc = scratch('pers-approve-ps')
  const plan = { id: 'p-0123456789abcdef', op: 'persistence', persistence: [{ vmId: 'a', name: 'hvmcp-research', persistent: false, kept: ['tools', 'before upgrade'] }, { vmId: 'b', name: 'hvmcp-other', persistent: true }, { vmId: 'c', name: 'hvmcp-plain', persistent: false }] }
  const planFile = path.join(sc.dir, 'plan.json')
  fs.writeFileSync(planFile, JSON.stringify(plan))
  const harness = path.join(sc.dir, 'summary.ps1')
  fs.writeFileSync(harness, `$ErrorActionPreference = 'Stop'\n$Plan = 'p-0123456789abcdef'\n$p = Get-Content -LiteralPath '${planFile.replace(/'/g, "''")}' -Raw | ConvertFrom-Json\n${block}\n`)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', env: ps51Env(), timeout: T.spawnMs, windowsHide: true })
  assert.strictEqual(r.status, 0, r.stderr)
  const out = r.stdout
  assert.match(out, /Plan p-0123456789abcdef: persistence the hyper-v pool/)
  assert.match(out, /make hvmcp-research disposable again: its clean checkpoint is restored first and verified, which DISCARDS what it kept \(installed software, files, settings, C:\\out, anything a run did\) and removes the checkpoints it kept \("tools", "before upgrade"\); its pool checkpoints stay; then it is restored at every start and release, and plain acquires may get it/)
  assert.match(out, /make hvmcp-other PERSISTENT: from now on it is never restored to clean at release, .*so whatever a run leaves, and its checkpoints, stay for the next lease of any agent that names it; plain acquires stop getting it/)
  assert.match(out, /make hvmcp-plain disposable again: .*anything a run did\); its pool checkpoints stay/, 'no kept checkpoints: none named')
})

// MC-1590: an interactive start on a persistent VM. Its logon (autologon, the watcher's Userinit and files, UAC off for
// the admin) is journalled with the guest's UAC before it, and undone (verified) before every park: stop, a plain start,
// release, deadline, disconnect, recovery and a quarantine retry. An undo that fails quarantines it.
const ops = sc => (sc.stub().calls || []).map(c => c.op)
const guestLogon = vm => ({ armed: !!vm.armed, userinit: vm.userinit ?? null, enableLUA: vm.enableLUA ?? 1 })
const UNDONE = lua => ({ armed: false, userinit: 'C:\\Windows\\system32\\userinit.exe,', enableLUA: lua })

test('MC-1590: an interactive start works on a persistent VM; release undoes the logon (verified) before the park, keeping the disk', async t => {
  const { sc, h, persistent } = await pool('pers-int-release')
  t.after(() => h.stop())
  const c = h.conn(10)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  const started = await c.request('start', { interactive: 'admin' })
  assert.match(started.text, /hvadmin logged on interactively after a guest restart/)
  assert.deepStrictEqual(guestLogon(stubOf(sc, persistent)), { armed: true, userinit: 'watcher', enableLUA: 0 }, 'the logon changed the guest')
  const dirty = sc.journal().find(r => r.t === 'logon-dirty')
  assert.deepStrictEqual([dirty?.vmId, dirty?.enableLUA], [persistent.id, 1], 'journalled before the logon, with UAC as it was')
  assert.ok(ops(sc).lastIndexOf('guest-uac-read') < ops(sc).lastIndexOf('guest-logon') && ops(sc).lastIndexOf('guest-uac-read') >= 0, 'UAC read before the logon')
  await c.request('run', { command: `write ${KEEP} kept`, session: 'interactive', as: 'admin' })
  const r0 = restores(sc, persistent)
  const rel = await c.request('release')
  assert.match(rel.text, /^Released\. hvmcp-[0-9a-f]+ parked/)
  const all = ops(sc)
  assert.ok(all.lastIndexOf('guest-logon-undo') < all.lastIndexOf('park'), 'undone before the park')
  assert.deepStrictEqual(guestLogon(stubOf(sc, persistent)), UNDONE(1), 'no autologon, Windows\' own Userinit, UAC back on')
  assert.ok(sc.journal().some(r => r.t === 'logon-undone' && r.vmId === persistent.id))
  assert.ok(stubOf(sc, persistent).disk[KEEP], 'its disk kept')
  assert.strictEqual(restores(sc, persistent), r0, 'never restored')
  // The next lease's plain start doesn't undo again (nothing to undo).
  const u0 = stubOf(sc, persistent).undos
  const d = h.conn(11)
  await d.request('acquire', { vm: persistent.name, minutes: 30 })
  await d.request('start')
  await d.request('release')
  assert.strictEqual(stubOf(sc, persistent).undos, u0)
})

test('MC-1590: the UAC state put back is the guest\'s own from before the logon (off stays off); a stop and a plain start in the lease undo it too', async t => {
  const { sc, h, persistent } = await pool('pers-int-uac')
  t.after(() => h.stop())
  sc.patchStub(st => { Object.values(st.vms).find(v => v.id === persistent.id).enableLUA = 0 })
  const c = h.conn(10)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  await c.request('start', { interactive: 'admin' })
  assert.strictEqual(sc.journal().find(r => r.t === 'logon-dirty').enableLUA, 0)
  await c.request('stop')
  assert.deepStrictEqual(guestLogon(stubOf(sc, persistent)), UNDONE(0), 'the user\'s own UAC off, as it was')
  // A plain start after an interactive one in the same lease parks first, undoing it.
  await c.request('start', { interactive: 'user' })
  assert.strictEqual(stubOf(sc, persistent).armed, true)
  await c.request('start')
  assert.deepStrictEqual(guestLogon(stubOf(sc, persistent)), { armed: false, userinit: 'C:\\Windows\\system32\\userinit.exe,', enableLUA: 0 })
  assert.strictEqual(sc.journal().filter(r => r.t === 'logon-undone').length, 2)
})

test('MC-1590: an undo that fails quarantines the VM; the retry starts it offline, undoes the logon and parks it', async t => {
  const { sc, h, admin, persistent } = await pool('pers-int-fail', { env: T.profile('retryQuick') })
  t.after(() => h.stop())
  const c = h.conn(10)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  await c.request('start', { interactive: 'user' })
  sc.patchStub(st => { st.fail['guest-logon-undo'] = 1 })
  const rel = await c.request('release')
  assert.match(rel.text, /CLEANUP FAILED: hvmcp-[0-9a-f]+ \(persistent\) could not be confirmed parked \(the interactive logon couldn't be undone \((guest-logon-undo: )?injected failure of guest-logon-undo\)\)\. It is quarantined/)
  assert.ok(!sc.journal().some(r => r.t === 'logon-undone'), 'not undone')
  assert.strictEqual(stubOf(sc, persistent).state, 'Off', 'still parked (shut down, disconnected) meanwhile')
  await waitFor(async () => !/QUARANTINED/.test((await admin.request('status')).text), T.waitForMs, 'the retry')
  assert.deepStrictEqual(guestLogon(stubOf(sc, persistent)), UNDONE(1))
  assert.deepStrictEqual([stubOf(sc, persistent).state, stubOf(sc, persistent).switchName], ['Off', null], 'parked again after the undo')
  const all = ops(sc)
  const undo = all.lastIndexOf('guest-logon-undo')
  assert.ok(all.lastIndexOf('net-off', undo) > 0 && all.lastIndexOf('start-vm', undo) > all.lastIndexOf('net-off', undo), 'disconnected, then started for the undo')
  assert.ok(sc.journal().some(r => r.t === 'logon-undone'))
})

test('MC-1590: a disconnect and a helper restart undo it too; a kept checkpoint taken while logged on makes a later restore one to undo again', async t => {
  const { sc, h, persistent } = await pool('pers-int-recover')
  let helper = h
  t.after(() => helper.stop())
  // A disconnect ends the lease: undone, then parked.
  const c = helper.conn(10)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  await c.request('start', { interactive: 'user' })
  await c.close()
  await waitFor(() => sc.journal().some(r => r.t === 'logon-undone'), T.waitForMs, 'the undo after the disconnect')
  assert.deepStrictEqual(guestLogon(stubOf(sc, persistent)), UNDONE(1))
  // A helper killed while logged on: its start-up recovery undoes it.
  const d = helper.conn(11)
  await waitFor(async () => d.request('acquire', { vm: persistent.name, minutes: 30 }).then(() => true, () => false), T.waitForMs, 'the VM free again')
  await d.request('start', { interactive: 'user' })
  await d.request('checkpoint', { name: 'logged-on' })
  assert.ok(sc.journal().find(r => r.t === 'lcp-take' && r.name === 'logged-on').logon, 'the take records the logon it holds')
  await helper.kill()
  helper = await startHelper(sc)
  assert.match((await helper.conn(1).request('status')).text, new RegExp(`${persistent.name}: parked \\(persistent: not restored\\)\\.`))
  assert.deepStrictEqual(guestLogon(stubOf(sc, persistent)), UNDONE(1), 'undone at recovery')
  assert.strictEqual(sc.journal().filter(r => r.t === 'logon-undone').length, 2)
  // A later lease restores the kept checkpoint, which holds the logon: it is undone again at release.
  const e = helper.conn(12)
  await e.request('acquire', { vm: persistent.name, minutes: 30 })
  await e.request('restore-checkpoint', { name: 'logged-on' })
  assert.strictEqual(sc.journal().filter(r => r.t === 'logon-dirty').length, 3, 'dirty again from the checkpoint')
  await e.request('release')
  assert.strictEqual(sc.journal().filter(r => r.t === 'logon-undone').length, 3)
  assert.deepStrictEqual(guestLogon(stubOf(sc, persistent)), UNDONE(1))
})

test('MC-1590: vm_reset (a clean restore) on a persistent VM counts as the logon undone', async t => {
  const { sc, h, persistent } = await pool('pers-int-reset')
  t.after(() => h.stop())
  const c = h.conn(10)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  await c.request('start', { interactive: 'user' })
  const u0 = stubOf(sc, persistent).undos || 0
  await c.request('start', { reset: true })
  assert.ok(sc.journal().some(r => r.t === 'logon-undone'), 'the verified restore undid it')
  await c.request('release')
  assert.strictEqual(stubOf(sc, persistent).undos || 0, u0, 'no undo needed at the release')
  assert.deepStrictEqual(guestLogon(stubOf(sc, persistent)).armed, false)
})
