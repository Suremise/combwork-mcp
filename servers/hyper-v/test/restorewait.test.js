// A restore's waits (MC-1536, MC-1537). hv.ps1's own $RestoreTo, run for real with mock io on a fake clock: Off polled
// (no restore issued if it never comes), then the restore issued, and the parent never read in that process (its
// Hyper-V objects keep the parent it started with). core's restoreVia, with a fake hv and clock: the new parent read
// from fresh facts-vm calls until it is the target, within a budget that includes each probe's time. And the callers,
// through server.js against the stub (whose restore replies carry the stale parent, as real Hyper-V's do): restores
// verify only through the fresh read, a timed-out phase is refused even when the facts read afterwards match, and a
// restore that never lands is refused, never started.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { scratch, withPool } = require('./helpers')
const { server } = require('../client')
const { ps51Env } = require('../helper/hv')
const { Helper } = require('../helper/core')

const HV_PS = fs.readFileSync(path.join(__dirname, '..', 'helper', 'hv.ps1'), 'utf8')
const BLOCK = (() => { const a = HV_PS.indexOf('\n$RestoreTo = {'); const e = a < 0 ? -1 : HV_PS.indexOf('\n}\n', a + 1); return e < 0 ? null : HV_PS.slice(a + 1, e + 3) })()

// One case: states are the values each successive state probe returns (the last repeats); the clock advances only by
// sleeps; a parent probe is recorded as a call (none is expected). Prints the result and what was called.
function run(t, { states }) {
  const sc = scratch(`restorewait-${t}`)
  const file = path.join(sc.dir, 'case.ps1')
  fs.writeFileSync(file, `${BLOCK}
$script:clock = 0; $script:calls = @(); $script:sleeps = @(); $script:si = 0
$states = @(${states.map(x => `'${x}'`).join(',')})
$io = @{
  state = { $v = $states[[Math]::Min($script:si, $states.Count - 1)]; $script:si++; $v }
  parent = { $script:calls += 'parent'; 'stale' }
  turnOff = { $script:calls += 'turnOff' }
  removeSaved = { $script:calls += 'removeSaved' }
  restore = { $script:calls += 'restore' }
  sleep = { param($ms) $script:sleeps += $ms; $script:clock += $ms }
  now = { $script:clock }
}
$r = & $RestoreTo 'target' $io
'OUT:' + (ConvertTo-Json -InputObject @{ r = $r; calls = @($script:calls); sleeps = @($script:sleeps); clock = $script:clock } -Compress -Depth 4)
`)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', env: ps51Env(), timeout: 60_000 })
  const line = r.stdout.split(/\r?\n/).find(l => l.startsWith('OUT:'))
  assert.ok(line, r.stdout + r.stderr)
  return JSON.parse(line.slice(4))
}

const skip = process.platform !== 'win32' || !BLOCK

test('an Off VM: the restore is issued once and reported restored, with no parent read in that process', { skip }, () => {
  const o = run('off', { states: ['Off'] })
  assert.deepStrictEqual([o.r.ok, o.r.phase, o.r.timedOut], [true, 'restored', false])
  assert.deepStrictEqual(o.calls, ['restore'], 'no parent probe')
  assert.strictEqual(o.sleeps.length, 0)
})

test('Off comes late after a turn-off: waited for, then restored', { skip }, () => {
  const o = run('offlate', { states: ['Running', 'Stopping', 'Stopping', 'Off'] })
  assert.deepStrictEqual([o.r.ok, o.r.phase], [true, 'restored'])
  assert.deepStrictEqual(o.calls, ['turnOff', 'restore'])
})

test('a Saved VM has its saved state removed, not turned off', { skip }, () => {
  const o = run('saved', { states: ['Saved', 'Off'] })
  assert.deepStrictEqual(o.calls, ['removeSaved', 'restore'])
})

test('never Off: phase off timed out, and no restore issued; sleeps capped to the 20 s left, none after', { skip }, () => {
  const o = run('neveroff', { states: ['Running', 'Stopping'] })
  assert.deepStrictEqual([o.r.ok, o.r.phase, o.r.timedOut, o.r.last], [false, 'off', true, 'Stopping'])
  assert.deepStrictEqual(o.calls, ['turnOff'], 'no restore')
  assert.strictEqual(o.clock, 20000, 'exactly the deadline, no sleep beyond it')
  assert.ok(o.sleeps.every(ms => ms <= 500))
})

// core's restoreVia on a bare helper: hv is a fake whose facts-vm replies come from a list (each advancing the fake
// clock by probeMs, as a slow process would), sleeps advance the clock too.
function bare({ op, reads, probeMs = 300 }) {
  const h = Object.create(Helper.prototype)
  let clock = 0
  const calls = []
  h.leases = new Map()
  h.mono = () => clock
  h.sleep = async ms => { calls.push(`sleep ${ms}`); clock += ms }
  h.hv = async (name, args, opts) => {
    calls.push(`${name} ${opts.timeoutMs}`)
    if (name !== 'facts-vm') return op
    clock += probeMs
    const r = reads.length > 1 ? reads.shift() : reads[0]
    if (r instanceof Error) throw r
    return r
  }
  return { h, calls, clock: () => clock }
}
const vm = { vmId: 'v1', vmName: 'hvmcp-1', folder: 'F' }
const restored = { vmId: 'v1', state: 'Off', parentCheckpointId: 'old', restore: { ok: true, phase: 'restored', timedOut: false } }

test('restoreVia: the op\'s own (stale) parent is never trusted; fresh reads are polled until the target', async () => {
  const { h, calls } = bare({ op: restored, reads: [{ vmId: 'v1', state: 'Off', parentCheckpointId: 'old' }, { vmId: 'v1', state: 'Off', parentCheckpointId: 'old' }, { vmId: 'v1', state: 'Off', parentCheckpointId: 'T', switchName: null }] })
  const f = await h.restoreVia(vm, 'restore', { checkpointId: 'T' }, { verifyMs: 45_000 })
  assert.deepStrictEqual([f.parentCheckpointId, f.restore.ok, f.restore.phase], ['T', true, 'verified'])
  assert.strictEqual(f.switchName, null, 'all the fresh facts, for the callers\' checks')
  assert.strictEqual(calls.filter(c => c.startsWith('facts-vm')).length, 3)
})

test('restoreVia: an explicit failed op report is returned before any read (an unissued restore is never verified)', async () => {
  const off = { vmId: 'v1', state: 'Off', parentCheckpointId: 'T', restore: { ok: false, phase: 'off', timedOut: true, last: 'Stopping' } }
  const { h, calls } = bare({ op: off, reads: [{ parentCheckpointId: 'T' }] })
  const f = await h.restoreVia(vm, 'restore', { checkpointId: 'T' })
  assert.strictEqual(f.restore.phase, 'off')
  assert.ok(!calls.some(c => c.startsWith('facts-vm')), 'no fresh read')
})

test('restoreVia: the budget includes probe time; each probe\'s timeout is capped to what\'s left; never-target is refused with the last seen', async () => {
  const { h, calls, clock } = bare({ op: restored, reads: [{ vmId: 'v1', parentCheckpointId: 'old' }], probeMs: 20_000 })
  const f = await h.restoreVia(vm, 'restore', { checkpointId: 'T' }, { verifyMs: 45_000 })
  assert.deepStrictEqual([f.restore.ok, f.restore.phase, f.restore.timedOut], [false, 'parent', true])
  assert.match(f.restore.last, /^old; the last read failed: the last read came after the wait ended$/, 'the last parent seen, and why the last read was not accepted')
  const probes = calls.filter(c => c.startsWith('facts-vm')).map(c => Number(c.split(' ')[1]))
  assert.deepStrictEqual(probes, [45_000, 24_000, 3_000], 'each probe capped to the time left')
  assert.ok(clock() <= 45_000 + 20_000, 'no probe starts after the deadline')
  assert.ok(calls.filter(c => c.startsWith('sleep')).every(c => Number(c.split(' ')[1]) <= 1000))
})

test('restoreVia: a match that arrives after the deadline isn\'t accepted', async () => {
  const { h } = bare({ op: restored, reads: [{ vmId: 'v1', parentCheckpointId: 'T' }], probeMs: 50_000 })
  const f = await h.restoreVia(vm, 'restore', { checkpointId: 'T' }, { verifyMs: 45_000 })
  assert.deepStrictEqual([f.restore.ok, f.restore.phase], [false, 'parent'])
  assert.match(f.restore.last, /after the wait ended/)
})

test('restoreVia: a failing read is retried, and named if it is the last', async () => {
  const { h } = bare({ op: restored, reads: [new Error('facts-vm: boom')], probeMs: 10_000 })
  const f = await h.restoreVia(vm, 'restore', { checkpointId: 'T' }, { verifyMs: 25_000 })
  assert.match(f.restore.last, /^nothing; the last read failed: facts-vm: boom$/)
})

test('restoreVia: a lease that ends during the poll stops it: no further probe', async () => {
  const { h, calls } = bare({ op: restored, reads: [{ vmId: 'v1', parentCheckpointId: 'old' }] })
  const lease = { vmId: 'v1', vmName: 'hvmcp-1', ending: false, children: new Set() }
  h.leases.set('v1', lease)
  h.sleep = async () => { lease.ending = true }
  await assert.rejects(h.restoreVia(vm, 'lease-restore', { checkpointId: 'T' }, { lease, verifyMs: 45_000 }), /lease on hvmcp-1 ended/)
  assert.strictEqual(calls.filter(c => c.startsWith('facts-vm')).length, 1)
})

async function lease(t, name, extra = {}) {
  const sc = scratch(name)
  const { h } = await withPool(sc, 1)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), ...extra }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  const vm = /Leased (hvmcp-[0-9a-f]+)/.exec((await s.call('vm_acquire', { minutes: 30 })).text)[1]
  return { sc, s, vm, stubVm: () => Object.values(sc.stub().vms).find(v => v.name === vm) }
}

test('a lease restore verifies through fresh reads when the restore\'s own reply and the next reads are stale', async t => {
  const { sc, s, stubVm } = await lease(t, 'rw-fresh')
  const when = path.join(sc.dir, 'stale-now')
  sc.patchStub(st => { st.restoreFreshAfter = { n: 2, when }; st.factsCalls = 0 })
  await s.call('vm_start', {})
  await s.call('vm_run', { command: 'write C:\\one.txt 1' })
  await s.call('vm_checkpoint', { name: 'a' })
  await s.call('vm_run', { command: 'write C:\\two.txt 2' })
  await s.call('vm_checkpoint', { name: 'b' }) // the VM now sits on b, so restoring a must move it
  const calls0 = sc.stub().factsCalls
  fs.writeFileSync(when, 'now')
  const r = await s.call('vm_restore', { name: 'a' })
  assert.ok(!r.isError, r.text)
  assert.ok(sc.stub().factsCalls - calls0 >= 3, 'the stale reads were polled past')
  assert.strictEqual(sc.stub().restoreFreshAfter, undefined, 'the knob was used')
  const v = stubVm()
  assert.strictEqual(v.state, 'Running')
  assert.ok(v.disk['C:\\one.txt'] !== undefined && v.disk['C:\\two.txt'] === undefined)
})

test('the caller refuses a timed-out Off even though the facts read afterwards match clean: no restore, no start, quarantined', async t => {
  const { sc, s, stubVm } = await lease(t, 'rw-off')
  await s.call('vm_start', {}) // the VM is now at clean (its parent), running
  await s.call('vm_run', { command: 'write C:\\dirty.txt x' })
  sc.patchStub(st => { st.restoreTimeout = { last: 'Stopping' } })
  const r = await s.call('vm_reset', {})
  assert.match(r.text, /CLEANUP FAILED: .*the restore didn't complete: the VM didn't turn off within the wait \(last seen: Stopping, after 20000 ms\)/)
  const v = stubVm()
  assert.ok(v.disk['C:\\dirty.txt'] !== undefined, 'the dirty disk was never restored, and never passed as clean')
  assert.strictEqual(v.state, 'Off', 'not started')
  assert.match((await s.call('vm_status')).text, /QUARANTINED \(the restore didn't complete/)
})

test('a lease restore that never lands is refused with the last parent seen, and never started', async t => {
  const { sc, s, stubVm } = await lease(t, 'rw-never', { HYPERV_MCP_RESTORE_VERIFY_MS: '1500' })
  const when = path.join(sc.dir, 'never-now')
  sc.patchStub(st => { st.restoreNeverLands = when })
  await s.call('vm_start', {})
  await s.call('vm_checkpoint', { name: 'a' })
  await s.call('vm_checkpoint', { name: 'b' }) // the VM now sits on b
  const was = stubVm().parent
  fs.writeFileSync(when, 'now')
  const r = await s.call('vm_restore', { name: 'a' })
  assert.match(r.text, new RegExp(`Restoring "a" didn't verify: the restore didn't complete: Hyper-V didn't report the checkpoint as its parent within the wait \\(last seen: ${was}, after \\d+ ms\\)`))
  assert.strictEqual(stubVm().state, 'Off', 'never started (no configure-start)')
})
