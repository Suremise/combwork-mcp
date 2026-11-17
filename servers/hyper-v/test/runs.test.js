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

async function running(name, env = {}) {
  const sc = scratch(name)
  Object.assign(sc.env, env)
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
  // The run's request settles once its poll loop has stopped (refused by the ended lease), and the VM is free once
  // restored: after both, nothing can still be sent for it, so the log is final.
  assert.ok((await run) instanceof Error)
  await waitFor(async () => /; free/.test((await admin.request('status')).text), 15_000, 'the lease to end')
  const o = ops(sc)
  const after = o.slice(o.lastIndexOf('restore') + 1)
  assert.ok(!after.some(x => x.startsWith('guest-run')), `guest calls after the lease ended: ${after.join(', ')}`)
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

test('the deadline counts from the start\'s reply: a slow start or publish, and a command already finished, is a finished run', async () => {
  const { sc, h, a } = await running('runs-slow-start')
  sc.patchStub(st => { st.startDelayMs = 2500 })
  assert.match((await a.request('run', { command: 'exit 0', timeoutSec: 1 })).text, /^Exit code 0\./, 'a 2.5 s start, a 1 s run: still polled once, and finished')
  sc.patchStub(st => { st.startDelayMs = 0 })
  await a.request('start', { interactive: 'admin' })
  sc.patchStub(st => { st.publishDelayMs = 2500 })
  const r = await a.request('run', { command: 'whoami', as: 'admin', session: 'interactive', timeoutSec: 1 })
  assert.match(r.text, /^Exit code 0 \(in the interactive session\)\./, 'a 2.5 s publish: not restored')
  assert.ok(!r.data.restored)
  await h.stop()
})

test('a poll that hangs is cut off by what is left of the run\'s budget, and the timeout\'s cleanup follows at once', async () => {
  const { sc, h, a } = await running('runs-stuck-poll', { HYPERV_MCP_MIN_POLL_MS: '1000' })
  const pidFile = path.join(sc.dir, 'poll.pid')
  sc.patchStub(st => { st.pollDelayOnceMs = 60_000; st.pollPidFile = pidFile })
  const t0 = Date.now()
  const r = await a.request('run', { command: 'sleep', timeoutSec: 1 })
  const took = Date.now() - t0
  assert.match(r.text, /^Timed out after 1 s: killed inside the guest by its PID/)
  assert.ok(took < 15_000, `the hung poll (60 s) was cut off: the run took ${took} ms`)
  const pollPid = Number(fs.readFileSync(pidFile, 'utf8'))
  await waitFor(() => !alive(pollPid), 10_000, 'the hung poll\'s process ended')
  await h.stop()
})

// hv.ps1's own start and poll, run for real (a test-only output folder, $j.out; the helper never sets it).
/** A scriptblock of hv.ps1's, from its "$<name> = {" line to the next line that is only "}". */
const block = name => {
  const s = HV.indexOf(`\n$${name} = {`)
  const e = s < 0 ? -1 : HV.indexOf('\n}\n', s + 1)
  return e < 0 ? null : HV.slice(s + 1, e + 3)
}
// MC-1547: $RunJob, the run's Job object type (a here-string, compiled in the guest by Add-Type), goes with them.
const RUNJOB = /^\$RunJob = @'\r?\n[\s\S]*?\r?\n'@\r?\n/m.exec(HV)?.[0]
const START = [RUNJOB, block('RunFiles'), block('GuestRunStart'), block('GuestRunPoll')]

function guest(name, script, { job = false } = {}) {
  const sc = scratch(name)
  const dir = path.join(sc.dir, 'hvmcp')
  const out = path.join(sc.dir, 'out')
  fs.mkdirSync(out, { recursive: true })
  const file = path.join(sc.dir, 'run.ps1')
  const [params, ...body] = script.split('\n') // a script's param() must come first
  fs.writeFileSync(file, `${params}\n${START.join('\n')}\n${KILL}\n${body.join('\n')}\n`)
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-Dir', dir, '-Out', out, '-Cwd', sc.dir]
  const run = () => {
    // MC-1543: with job, the harness runs inside jobrun.exe's kill-on-close Job object: whatever it starts ends when the
    // launcher does, however it ends (a timeout here kills the launcher, which closes the job).
    const r = job
      ? spawnSync(jobrun(), ['powershell.exe', ...argv.map(a => (/\s/.test(a) ? `"${a}"` : a))], { encoding: 'utf8', env: ps51Env(), timeout: 120_000, windowsHide: true, windowsVerbatimArguments: true })
      : spawnSync('powershell.exe', argv, { encoding: 'utf8', env: ps51Env(), timeout: 120_000 })
    const lines = r.stdout.trim().split(/\r?\n/).filter(l => l.startsWith('{'))
    if (!lines.length) throw new Error(`no answer: ${r.stdout}${r.stderr}`)
    return lines.map(l => JSON.parse(l))
  }
  return { run, out, dir: sc.dir }
}

/** MC-1543: test/jobrun.cs, compiled once per test file by the in-box C# compiler into scratch. */
let jobrunExe = null
function jobrun() {
  if (jobrunExe) return jobrunExe
  const exe = path.join(scratch('runs-jobrun').dir, 'jobrun.exe')
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const c = spawnSync(csc, ['-nologo', '-target:exe', '-optimize', `-out:${exe}`, path.join(__dirname, 'jobrun.cs')], { encoding: 'utf8', windowsHide: true })
  if (c.status !== 0) throw new Error(`compiling jobrun.cs failed: ${c.stdout}${c.stderr}`)
  jobrunExe = exe
  return exe
}

/**
 * MC-1543: the recorded identities (ids.json: the run's outer cmd, the wrapper's cmd, the ping) still alive as the same
 * process (PID, with its creation time within a second). Read-only: it kills nothing. Its script must report it ran to
 * the end, or this throws, so a failed check can never pass for "nothing left".
 */
function survivors(dir) {
  const file = path.join(dir, 'ids.json')
  if (!fs.existsSync(file)) return []
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$ids = @((Get-Content -Raw -LiteralPath '${file.replace(/'/g, "''")}' | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $_.Value } | Where-Object { $_.pid -and $_.created })
$left = @()
foreach ($i in $ids) {
  $p = Get-Process -Id ([int]$i.pid) -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  $start = $null
  try { $start = $p.StartTime.ToUniversalTime() } catch { continue }
  if ([Math]::Abs(($start - [DateTime]::Parse([string]$i.created).ToUniversalTime()).TotalSeconds) -lt 1) { $left += [int]$i.pid }
}
'SURVIVORS-DONE:' + ($left -join ',')
`], { encoding: 'utf8', env: ps51Env(), windowsHide: true, timeout: 60_000 })
  const m = /SURVIVORS-DONE:(.*)/.exec(r.stdout || '')
  if (r.status !== 0 || !m) throw new Error(`the survivors check failed (exit ${r.status}): ${r.stdout}${r.stderr}`)
  return m[1].trim() ? m[1].trim().split(',').map(Number) : []
}

/**
 * MC-1543: the harness for a run of a long ping through hv.ps1's real start, inside jobrun.exe's kill-on-close job, so
 * nothing it starts outlives it. Each identity goes to ids.json as soon as it's known (the outer cmd at once, then the
 * wrapper's cmd and the ping once the ping runs), for the checks: they're only ever read, never used to kill. A finally
 * still kills the run's tree when the script fails part-way (the job is the backstop). `tail` is what it does once the
 * ping runs (the normal test kills it; the fault test dies abruptly).
 */
function pingRun(name, tail) {
  return guest(name, `param($Dir, $Out, $Cwd)
$idsFile = Join-Path $Cwd 'ids.json'
$ids = @{}
$record = { param($k, $p) $ids[$k] = @{ pid = [int]$p.procId; created = [string]$p.createdAt }; [IO.File]::WriteAllText($idsFile, (ConvertTo-Json -InputObject $ids -Compress)) }
$j = @{ n = 1; command = 'ping -n 120 127.15.43.1 >nul'; shell = 'cmd'; cwd = $Cwd; dir = $Dir; out = $Out }
$s = & $GuestRunStart $j $RunFiles.ToString() $RunJob
& $record 'run' @{ procId = $s.pid; createdAt = $s.started }
$killed = $false
try {
  ConvertTo-Json -InputObject $s -Compress
  $ping = $null
  $t = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 100
    $inner = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($s.pid)" | Where-Object { $_.Name -eq 'cmd.exe' })
    if ($inner.Count) { $ping = @(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $inner.ProcessId -contains $_.ParentProcessId })[0] }
  } until ($ping -or (Get-Date) -gt $t)
  if ($ping) {
    $wrapper = @($inner | Where-Object { $_.ProcessId -eq $ping.ParentProcessId })[0]
    & $record 'wrapper' @{ procId = $wrapper.ProcessId; createdAt = $wrapper.CreationDate.ToUniversalTime().ToString('o') }
    & $record 'ping' @{ procId = $ping.ProcessId; createdAt = $ping.CreationDate.ToUniversalTime().ToString('o') }
  }
  ConvertTo-Json -InputObject @{ pid = $(if ($ping) { [int]$ping.ProcessId } else { $null }); created = $(if ($ping) { $ping.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } -Compress
${tail}
} finally {
  if (-not $killed) { try { [void](& $GuestRunKill @{ pid = $s.pid; started = $s.started; job = $s.job } $RunJob) } catch { } }
}`, { job: true })
}

test('hv.ps1\'s start, for real: a running command\'s PID and creation time (read before its object is disposed), polled, then killed by them, with everything it started', { skip: !windows || START.some(b => !b) || !KILL }, async t => {
  // MC-1543: this test once killed the run's tree while cmd was still starting PING.EXE. The ping lost its console
  // mid-initialisation, failed with 0xc0000142 and showed Windows' error dialog on the desktop, and a ping created just
  // after taskkill's snapshot was left running. Now the harness runs inside a kill-on-close job with error dialogs off
  // (jobrun.exe), kills only once the run's own PING.EXE runs, and the test fails if anything it recorded survives.
  const g = pingRun('runs-startps', `  ConvertTo-Json -InputObject (& $GuestRunPoll @{ n = 1; cap = 1024; out = $Out }) -Compress
  $k = & $GuestRunKill @{ pid = $s.pid; started = $s.started; job = $s.job } $RunJob
  $killed = [bool]$k.killed
  ConvertTo-Json -InputObject $k -Compress
  $gone = $true
  if ($ping) { $t = (Get-Date).AddSeconds(10); do { Start-Sleep -Milliseconds 100; $gone = -not (Get-Process -Id $ping.ProcessId -ErrorAction SilentlyContinue) } until ($gone -or (Get-Date) -gt $t) }
  ConvertTo-Json -InputObject @{ pingGone = $gone } -Compress`)
  t.after(() => assert.deepStrictEqual(survivors(g.dir), [], 'nothing the harness launched survives it'))
  const [started, ping, poll, killed, after] = g.run()
  assert.ok(Number.isInteger(started.pid) && started.pid > 0, `a real PID: ${JSON.stringify(started)}`)
  assert.match(String(started.started), /^\d{4}-\d\d-\d\dT/, 'its creation time')
  assert.match(String(started.job), /^hvmcp-run-1-[0-9a-f]{16}$/, 'its own job (MC-1547), made inside the harness\'s job: nested jobs work here')
  assert.ok(Number.isInteger(ping.pid) && ping.pid > 0, `the run's own PING.EXE was seen running before the kill: ${JSON.stringify(ping)}`)
  assert.strictEqual(poll.done, false)
  assert.deepStrictEqual(killed, { killed: true, via: 'job' }, 'hv.ps1\'s own kill took the run, through its job (MC-1547)')
  assert.deepStrictEqual(after, { pingGone: true }, 'the kill took the whole tree, the ping included')
  await waitFor(() => !alive(started.pid), 10_000, 'the run gone')
})

test('MC-1543: a harness that dies after launching the run (no finally, no usable output) leaves nothing behind: the job it ran in ends everything it started', { skip: !windows || START.some(b => !b) || !KILL }, async t => {
  const g = pingRun('runs-harness-dies', `  [Environment]::Exit(3) # dies at once: no finally runs, no more output`)
  t.after(() => assert.deepStrictEqual(survivors(g.dir), [], 'nothing the harness launched survives it'))
  // It dies part-way: at most its first lines (the start and the ping), never the kill's, or no usable answer at all.
  let lines = []
  try { lines = g.run() } catch { lines = [] }
  assert.ok(lines.length <= 2 && !lines.some(l => 'killed' in l), `the harness died before any kill: ${JSON.stringify(lines)}`)
  const ids = JSON.parse(fs.readFileSync(path.join(g.dir, 'ids.json'), 'utf8'))
  assert.ok(ids.run?.pid && ids.wrapper?.pid && ids.ping?.pid, `every identity was recorded before it died: ${JSON.stringify(ids)}`)
  // Nothing killed them but the job's closing: the run's cmd, the wrapper's cmd and the ping all end with it.
  for (const k of ['run', 'wrapper', 'ping']) await waitFor(() => !alive(ids[k].pid), 10_000, `${k} gone with the job`)
  assert.deepStrictEqual(survivors(g.dir), [])
})

test('MC-1543: the survivors check is identity-exact and fails loudly: a live process recorded with another creation time (a reused PID) and an exited one are not survivors; a check that can\'t run throws', { skip: !windows }, async t => {
  const sc = scratch('runs-survivors')
  const live = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep 60'], { windowsHide: true })
  t.after(() => { try { live.kill() } catch { /* gone */ } })
  const gone = spawn('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true })
  await new Promise(r => gone.on('exit', r))
  const created = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${live.pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', env: ps51Env() }).stdout.trim()
  const write = ids => fs.writeFileSync(path.join(sc.dir, 'ids.json'), JSON.stringify(ids))
  write({ run: { pid: live.pid, created } })
  assert.deepStrictEqual(survivors(sc.dir), [live.pid], 'the same process: a survivor')
  write({ run: { pid: live.pid, created: '2001-01-01T00:00:00.0000000Z' }, ping: { pid: gone.pid, created } })
  assert.deepStrictEqual(survivors(sc.dir), [], 'a reused PID (another creation time) and an exited process are not')
  assert.ok(alive(live.pid), 'and the check killed nothing')
  fs.writeFileSync(path.join(sc.dir, 'ids.json'), '{ not json')
  assert.throws(() => survivors(sc.dir), /the survivors check failed/, 'a check that can\'t run fails, never reads as "nothing left"')
})

test('hv.ps1\'s start, for real: a command that exits at once still gives its PID; the exit file gives its code and output', { skip: !windows || START.some(b => !b) }, async () => {
  const g = guest('runs-fastps', `param($Dir, $Out, $Cwd)
$j = @{ n = 2; command = 'echo quick& exit /b 3'; shell = 'cmd'; cwd = $Cwd; dir = $Dir; out = $Out }
$s = & $GuestRunStart $j $RunFiles.ToString() $RunJob
ConvertTo-Json -InputObject $s -Compress
$t = (Get-Date).AddSeconds(20); do { Start-Sleep -Milliseconds 100; $p = & $GuestRunPoll @{ n = 2; cap = 1024; out = $Out } } until ($p.done -or (Get-Date) -gt $t)
ConvertTo-Json -InputObject $p -Compress
$t = (Get-Date).AddSeconds(10); do { Start-Sleep -Milliseconds 100; $k = & $GuestRunKill @{ pid = $s.pid; started = $s.started; job = $s.job } $RunJob } until ($k.gone -or (Get-Date) -gt $t)
ConvertTo-Json -InputObject $k -Compress`, { job: true })
  const [started, poll, after] = g.run()
  assert.ok(Number.isInteger(started.pid) && started.pid > 0, `a real PID even for a fast exit: ${JSON.stringify(started)}`)
  assert.strictEqual(poll.done, true)
  assert.strictEqual(poll.exitCode, 3)
  assert.match(poll.stdout, /quick/)
  assert.match(String(started.job), /^hvmcp-run-2-[0-9a-f]{16}$/)
  assert.deepStrictEqual(after, { killed: false, gone: true }, 'a finished run\'s job ends with its processes: nothing to kill (MC-1547)')
})

test('MC-1547: a run whose command keeps starting children is killed at its timeout with everything it started, the ones started as the kill came included', { skip: !windows || START.some(b => !b) || !KILL }, async t => {
  // The command keeps starting background pings (30 s each, a target only this test uses) every ~100 ms, so children
  // are being created as the kill comes: taskkill /T's snapshot of parent PIDs would miss some; the run's job doesn't.
  // Inside jobrun.exe's kill-on-close job (MC-1543), with error dialogs off; the check registered before launch.
  const g = guest('runs-spawner', `param($Dir, $Out, $Cwd)
$idsFile = Join-Path $Cwd 'ids.json'
$j = @{ n = 3; command = 'for /l %%i in (1,1,100000) do @(start "" /b ping -n 30 127.15.47.1 >nul & ping -n 1 -w 100 127.15.47.2 >nul)'; shell = 'cmd'; cwd = $Cwd; dir = $Dir; out = $Out }
$s = & $GuestRunStart $j $RunFiles.ToString() $RunJob
[IO.File]::WriteAllText($idsFile, (ConvertTo-Json -InputObject @{ run = @{ pid = [int]$s.pid; created = [string]$s.started } } -Compress))
ConvertTo-Json -InputObject $s -Compress
$pings = { @(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -like '*127.15.47.*' }) }
$t = (Get-Date).AddSeconds(30); do { Start-Sleep -Milliseconds 200 } until ((& $pings).Count -ge 4 -or (Get-Date) -gt $t)
ConvertTo-Json -InputObject @{ before = (& $pings).Count } -Compress
$k = & $GuestRunKill @{ pid = $s.pid; started = $s.started; job = $s.job } $RunJob
ConvertTo-Json -InputObject $k -Compress
# Round 2: a bounded wait on the condition itself (no fixed delay): the run's pings and its cmd gone, within 15 s.
$t = (Get-Date).AddSeconds(15)
do {
  $after = (& $pings).Count
  $runAlive = [bool](Get-Process -Id $s.pid -ErrorAction SilentlyContinue)
  if ($after -eq 0 -and -not $runAlive) { break }
  Start-Sleep -Milliseconds 100
} until ((Get-Date) -gt $t)
ConvertTo-Json -InputObject @{ after = $after; runAlive = $runAlive } -Compress`, { job: true })
  t.after(() => assert.deepStrictEqual(survivors(g.dir), [], 'nothing the harness launched survives it'))
  const [started, before, killed, after] = g.run()
  assert.match(String(started.job), /^hvmcp-run-3-[0-9a-f]{16}$/, 'the run has its job')
  assert.ok(before.before >= 4, `children were being started: ${JSON.stringify(before)}`)
  assert.deepStrictEqual(killed, { killed: true, via: 'job' }, 'the job was terminated and confirmed empty')
  assert.deepStrictEqual(after, { after: 0, runAlive: false }, 'no ping of the run is left, the latest ones included, and the run itself is gone')
})

test('MC-1547 round 2: a run is never started outside its job (fail closed), and a job kill that can\'t be confirmed is reported as such, never retried as a PID-tree kill', { skip: !windows || START.some(b => !b) || !KILL }, async () => {
  const g = guest('runs-jobfail', `param($Dir, $Out, $Cwd)
$out = @{}
$j = @{ n = 4; command = 'echo should-not-run> started.txt'; shell = 'cmd'; cwd = $Cwd; dir = $Dir; out = $Out }
try { [void](& $GuestRunStart $j $RunFiles.ToString() 'this is not C#'); $out.badSource = 'started' } catch { $out.badSource = $_.Exception.Message }
try { [void](& $GuestRunStart $j $RunFiles.ToString() $null); $out.noSource = 'started' } catch { $out.noSource = $_.Exception.Message }
$out.marker = Test-Path (Join-Path $Cwd 'started.txt')
# Before anything has loaded the real job type in this process:
$out.killNoSource = & $GuestRunKill @{ pid = 1; started = '2001-01-01T00:00:00Z'; job = 'hvmcp-run-4-0000000000000001' } 'this is not C#'
$out.unknownJob = & $GuestRunKill @{ pid = 1; started = '2001-01-01T00:00:00Z'; job = 'hvmcp-run-4-0000000000000000' } $RunJob
$out.badName = & $GuestRunKill @{ pid = 1; started = '2001-01-01T00:00:00Z'; job = 'not-a-run-job' } $RunJob
ConvertTo-Json -InputObject $out -Compress -Depth 4`, { job: true })
  const [o] = g.run()
  assert.match(o.badSource, /the run couldn't be put in its own job, so it wasn't started/, 'a job type that won\'t compile: refused')
  assert.match(o.noSource, /a run is only started in its own job/, 'no job type: refused')
  assert.strictEqual(o.marker, false, 'the command never ran')
  assert.deepStrictEqual(o.unknownJob, { killed: false, gone: true }, 'no job by that name: the run has ended')
  assert.deepStrictEqual(o.badName, { killed: false, jobFailed: true, why: 'its job name is malformed' })
  assert.strictEqual(o.killNoSource.jobFailed, true, 'a kill that can\'t even load the job type is a failure, never a PID-tree kill')
  assert.match(o.killNoSource.why, /its job couldn't be opened or terminated/)
})

test('MC-1547 round 2: through the helper, a run in a job is killed through it; a job kill that can\'t be confirmed restores the VM (never a PID-tree kill)', async () => {
  const { sc, h, a } = await running('runs-job-core')
  sc.patchStub(st => { st.runJobs = true })
  const ok = await a.request('run', { command: 'sleep', timeoutSec: 1 })
  assert.match(ok.text, /^Timed out after 1 s: killed inside the guest with everything it started \(its job object, MC-1547\)\./)
  assert.match(sc.stub().kills.at(-1).job, /^hvmcp-run-\d+-0123456789abcdef$/, 'the kill was given the run\'s job')
  const r0 = Object.values(sc.stub().vms)[0].restores || 0
  sc.patchStub(st => { st.jobKillFails = true })
  const bad = await a.request('run', { command: 'sleep', timeoutSec: 1 })
  assert.match(bad.text, /^Timed out after 1 s, and its job's kill couldn't be confirmed \(processes were still in its job 10 s after it was terminated\)\. The VM was restored to its clean checkpoint, which ends everything the run started/)
  assert.strictEqual(bad.data.restored, true)
  assert.strictEqual(bad.isError, true)
  assert.strictEqual((Object.values(sc.stub().vms)[0].restores || 0), r0 + 1, 'restored once')
  await h.stop()
})
