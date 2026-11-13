// vm_run started, then polled (MC-1510): PowerShell Direct ends any single call after 10 minutes, so a run is started
// (or published) in one short call and its exit file polled with short calls against one deadline. Through helper.js
// against the stub Hyper-V: runs spanning many polls, a run that finished before its start could read its identity,
// a timeout killed by PID only while the PID is still the run's, failed polls retried without extending the deadline,
// and nothing sent to the guest once the lease ends. And hv.ps1's own kill, run for real with Windows PowerShell 5.1
// on this machine's processes: the native handle taken first, the creation time compared, a reused or gone PID never
// killed. The 10-minute limit itself is only shown on the pool (the trial).
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { scratch, withPool, waitFor } = require('./helpers')
const { ps51Env } = require('../helper/hv')

const windows = process.platform === 'win32'

async function running(name) {
  const sc = scratch(name)
  const { h } = await withPool(sc, 1)
  const a = h.conn(1)
  await a.request('acquire', { minutes: 30 })
  await a.request('start')
  return { sc, h, a }
}
/** The stub's call log, retried while a stub process is part-way through rewriting its state file. */
const ops = sc => {
  for (let i = 0; ; i++) {
    try { return sc.stub().calls.map(c => c.op) } catch (e) { if (i > 50) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20) }
  }
}

test('a run spanning many polls: started once, polled until its exit file, its exit and output returned', async () => {
  const { sc, h, a } = await running('runs-slow')
  const r = await a.request('run', { command: 'slow 5' })
  assert.match(r.text, /^Exit code 0\.\n--- stdout ---\nslow done/)
  const o = ops(sc)
  assert.strictEqual(o.filter(x => x === 'guest-run-start').length, 1)
  assert.ok(o.filter(x => x === 'guest-run-poll').length >= 5)
  assert.ok(!o.includes('guest-run'), 'no single long run call')
  await h.stop()
})

test('a run that finished before its start could read its creation time is a finished run, not a failed start', async () => {
  const { sc, h, a } = await running('runs-fast')
  const r = await a.request('run', { command: 'fast' })
  assert.match(r.text, /^Exit code 0\.\n--- stdout ---\nfast done/)
  assert.ok(!ops(sc).includes('guest-run-kill'))
  await h.stop()
})

test('a timeout: killed by its PID while it is still the run\'s process; a reused PID is never killed, and the reply says so', async () => {
  const { sc, h, a } = await running('runs-kill')
  const r = await a.request('run', { command: 'sleep', timeoutSec: 1 })
  assert.match(r.text, /^Timed out after 1 s: killed inside the guest by its PID \(taskkill \/T \/F\)\.\n--- stdout ---\npartial/)
  const k = sc.stub().kills.at(-1)
  assert.ok(k.pid && k.started, 'the kill names the PID and the creation time its start recorded')
  sc.patchStub(st => { st.killMismatch = true })
  const r2 = await a.request('run', { command: 'sleep', timeoutSec: 1 })
  assert.match(r2.text, /^Timed out after 1 s: not confirmed killed \(PID \d+ is no longer the run's process \(it exited and the PID was reused\)\); vm_stop is the fallback\./)
  await h.stop()
})

test('failed polls are retried within the run\'s one deadline, never extending it', async () => {
  const { sc, h, a } = await running('runs-retry')
  sc.patchStub(st => { st.fail = { 'guest-run-poll': 3 } })
  assert.match((await a.request('run', { command: 'slow 2' })).text, /^Exit code 0\./, 'three failed polls, then the run\'s result')
  sc.patchStub(st => { st.fail = { 'guest-run-poll': 1000 } })
  const t0 = Date.now()
  const r = await a.request('run', { command: 'sleep', timeoutSec: 2 })
  assert.match(r.text, /^Timed out after 2 s/)
  assert.ok(Date.now() - t0 < 15_000, `every poll failing still ends at the deadline (${Date.now() - t0} ms)`)
  await h.stop()
})

test('a lease that ends mid-run: no guest call is sent after it, and the VM is restored', async () => {
  const { sc, h, a } = await running('runs-lease-end')
  const admin = h.conn(9)
  const run = a.request('run', { command: 'sleep', timeoutSec: 60 }).catch(e => e)
  await waitFor(() => ops(sc).filter(x => x === 'guest-run-poll').length >= 2, 10_000, 'the run being polled')
  a.close()
  await waitFor(async () => /; free/.test((await admin.request('status')).text), 15_000, 'the lease to end')
  const o = ops(sc)
  const restoreAt = o.lastIndexOf('restore')
  await new Promise(r => setTimeout(r, 500)) // a poll that would still come, if one were sent, comes now
  const after = ops(sc).slice(restoreAt + 1)
  assert.ok(!after.some(x => x.startsWith('guest-run')), `guest calls after the lease ended: ${after.join(', ')}`)
  assert.ok((await run) instanceof Error)
  await h.stop()
})

// hv.ps1's own kill scriptblock, run for real on this machine's processes.
const HV = fs.readFileSync(path.join(__dirname, '..', 'helper', 'hv.ps1'), 'utf8')
const KILL = /^\$GuestRunKill = \{\r?\n[\s\S]*?\r?\n\}\r?\n/m.exec(HV)?.[0]

function kill(pid, started) {
  const file = path.join(scratch('runs-killps').dir, 'kill.ps1')
  fs.writeFileSync(file, `param([int]$TargetPid, [string]$Started)\n${KILL}\n$r = & $GuestRunKill @{ pid = $TargetPid; started = $(if ($Started) { $Started } else { $null }) }\nConvertTo-Json -InputObject $r -Compress\n`)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-TargetPid', String(pid), '-Started', started || ''], { encoding: 'utf8', env: ps51Env(), timeout: 60_000 })
  const line = r.stdout.trim().split(/\r?\n/).at(-1)
  try { return JSON.parse(line) } catch { throw new Error(`no answer from the kill: ${r.stdout}${r.stderr}`) }
}
/** A real process to kill: its PID and its creation time, read as $GuestRunStart reads it. */
function sleeper() {
  const c = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep 120'], { windowsHide: true })
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Id ${c.pid}; [void]$p.Handle; $p.StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', env: ps51Env() })
  return { child: c, pid: c.pid, started: r.stdout.trim() }
}
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

test('hv.ps1\'s kill, for real: the run\'s own process (by its creation time) and its tree are killed and confirmed', { skip: !windows || !KILL }, async () => {
  const s = sleeper()
  assert.match(s.started, /^\d{4}-\d\d-\d\dT/)
  const r = kill(s.pid, s.started)
  assert.deepStrictEqual(r, { killed: true })
  await waitFor(() => !alive(s.pid), 10_000, 'the process gone')
})

test('hv.ps1\'s kill, for real: another creation time (a reused PID), or no recorded identity, kills nothing', { skip: !windows || !KILL }, async t => {
  const s = sleeper()
  t.after(() => { try { s.child.kill() } catch { /* gone */ } })
  const wrong = kill(s.pid, '2001-01-01T00:00:00.0000000Z')
  assert.strictEqual(wrong.killed, false)
  assert.match(wrong.why, /is no longer the run's process/)
  const none = kill(s.pid, '')
  assert.strictEqual(none.killed, false)
  assert.match(none.why, /identity was never recorded/)
  assert.ok(alive(s.pid), 'still running: never killed on a mismatch')
})

test('hv.ps1\'s kill, for real: a process already gone is reported gone (the exit file decides), never an error', { skip: !windows || !KILL }, async () => {
  const s = sleeper()
  s.child.kill()
  await waitFor(() => !alive(s.pid), 10_000, 'the process gone')
  assert.deepStrictEqual(kill(s.pid, s.started), { killed: false, gone: true })
})
