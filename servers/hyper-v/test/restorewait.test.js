// A restore's waits (MC-1536): Hyper-V reports a restore's new parent (and an Off after a turn-off) a moment after the
// cmdlet returns. hv.ps1's own $RestoreTo, run for real with mock io on a fake clock: Off polled (no restore issued if
// it never comes), then the target parent polled; deadlines on the injected monotonic clock, sleeps capped to the time
// left, none after the deadline. And the callers: a timed-out phase is refused even when the facts read afterwards
// match (no restore, no start, quarantined), through server.js against the stub.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { scratch, withPool } = require('./helpers')
const { server } = require('../client')
const { ps51Env } = require('../helper/hv')

const HV_PS = fs.readFileSync(path.join(__dirname, '..', 'helper', 'hv.ps1'), 'utf8')
const BLOCK = (() => { const a = HV_PS.indexOf('\n$RestoreTo = {'); const e = a < 0 ? -1 : HV_PS.indexOf('\n}\n', a + 1); return e < 0 ? null : HV_PS.slice(a + 1, e + 3) })()

// One case: states and parents are the values each successive probe returns (the last repeats); the clock advances only
// by sleeps. Prints the result and what was called.
function run(t, { states, parents }) {
  const sc = scratch(`restorewait-${t}`)
  const file = path.join(sc.dir, 'case.ps1')
  fs.writeFileSync(file, `${BLOCK}
$script:clock = 0; $script:calls = @(); $script:sleeps = @(); $script:si = 0; $script:pi = 0
$states = @(${states.map(x => `'${x}'`).join(',')}); $parents = @(${parents.map(x => `'${x}'`).join(',')})
$io = @{
  state = { $v = $states[[Math]::Min($script:si, $states.Count - 1)]; $script:si++; $v }
  parent = { $v = $parents[[Math]::Min($script:pi, $parents.Count - 1)]; $script:pi++; $v }
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

test('the parent changes after a few reads: the restore completes once it\'s the target; restore issued once', { skip }, () => {
  const o = run('lag', { states: ['Off'], parents: ['old', 'old', 'old', 'target'] })
  assert.deepStrictEqual([o.r.ok, o.r.phase, o.r.timedOut, o.r.last], [true, 'done', false, 'target'])
  assert.deepStrictEqual(o.calls, ['restore'])
  assert.strictEqual(o.sleeps.length, 3, 'three polls waited, no fixed sleep')
})

test('Off comes late after a turn-off: waited for, then restored', { skip }, () => {
  const o = run('offlate', { states: ['Running', 'Stopping', 'Stopping', 'Off'], parents: ['target'] })
  assert.strictEqual(o.r.ok, true)
  assert.deepStrictEqual(o.calls, ['turnOff', 'restore'])
})

test('a Saved VM has its saved state removed, not turned off', { skip }, () => {
  const o = run('saved', { states: ['Saved', 'Off'], parents: ['target'] })
  assert.deepStrictEqual(o.calls, ['removeSaved', 'restore'])
})

test('never Off: phase off timed out, and no restore issued; sleeps capped to the 20 s left, none after', { skip }, () => {
  const o = run('neveroff', { states: ['Running', 'Stopping'], parents: ['target'] })
  assert.deepStrictEqual([o.r.ok, o.r.phase, o.r.timedOut, o.r.last], [false, 'off', true, 'Stopping'])
  assert.deepStrictEqual(o.calls, ['turnOff'], 'no restore')
  assert.strictEqual(o.clock, 20000, 'exactly the deadline, no sleep beyond it')
  assert.ok(o.sleeps.every(ms => ms <= 500))
})

test('the parent never becomes the target: phase parent timed out, with the last parent seen', { skip }, () => {
  const o = run('neverparent', { states: ['Off'], parents: ['old'] })
  assert.deepStrictEqual([o.r.ok, o.r.phase, o.r.timedOut, o.r.last], [false, 'parent', true, 'old'])
  assert.deepStrictEqual(o.calls, ['restore'])
  assert.strictEqual(o.clock, 45000)
})

async function lease(t, name) {
  const sc = scratch(name)
  const { h } = await withPool(sc, 1)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home') }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  const vm = /Leased (hvmcp-[0-9a-f]+)/.exec((await s.call('vm_acquire', { minutes: 30 })).text)[1]
  return { sc, s, vm, stubVm: () => Object.values(sc.stub().vms).find(v => v.name === vm) }
}

test('the caller refuses a timed-out Off even though the facts read afterwards match clean: no restore, no start, quarantined', async t => {
  const { sc, s, stubVm } = await lease(t, 'rw-off')
  await s.call('vm_start', {}) // the VM is now at clean (its parent), running
  await s.call('vm_run', { command: 'write C:\\dirty.txt x' })
  sc.patchStub(st => { st.restoreTimeout = { phase: 'off', last: 'Stopping' } })
  const r = await s.call('vm_reset', {})
  assert.match(r.text, /CLEANUP FAILED: .*the restore didn't complete: the VM didn't turn off within the wait \(last seen: Stopping, after 20000 ms\)/)
  const v = stubVm()
  assert.ok(v.disk['C:\\dirty.txt'] !== undefined, 'the dirty disk was never restored, and never passed as clean')
  assert.strictEqual(v.state, 'Off', 'not started')
  assert.match((await s.call('vm_status')).text, /QUARANTINED \(the restore didn't complete/)
})

test('the caller refuses a timed-out parent on a lease restore even though the facts match the checkpoint: no start', async t => {
  const { sc, s, stubVm } = await lease(t, 'rw-parent')
  await s.call('vm_start', {})
  await s.call('vm_checkpoint', { name: 'a' })
  sc.patchStub(st => { st.restoreTimeout = { phase: 'parent', last: 'old-parent' } })
  const r = await s.call('vm_restore', { name: 'a' })
  assert.match(r.text, /Restoring "a" didn't verify: the restore didn't complete: Hyper-V didn't report the checkpoint as its parent within the wait \(last seen: old-parent, after 65000 ms\)/)
  assert.strictEqual(stubVm().state, 'Off', 'never started (no configure-start)')
})
