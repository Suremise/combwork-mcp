// The test accounts' profiles provisioned at build (MC-1516), through helper.js against the stub Hyper-V: hvadmin then
// hvuser logged on once each, their first-logon work waited out on observed quiet (consecutive good, idle samples; a
// failed or busy sample starts over; a lost logon is retried once), and a verified undo after each and before a retry,
// so every logon sees Windows' own Userinit and the intended UAC state, and the clean checkpoint keeps none of it.
const test = require('node:test')
const assert = require('assert')
const { T, scratch, startHelper, approve, seedImage, waitFor } = require('./helpers')

const vms = sc => Object.values(sc.stub().vms)
const status = async c => (await c.request('status')).text

/** A one-VM create with the stub set as given; resolves the plan and the job's line. */
// Builds whose provisioning waits run out on purpose: timing.json's narrow values (MC-1558).
// planArgs(sc): more pool_plan arguments (MC-1577: guestScript); beforeApply(sc, plan): between the plan and its apply.
async function build(t, name, stub = {}, { planArgs = () => ({}), beforeApply = () => {} } = {}) {
  const sc = scratch(name, { stub, timing: 'narrow' })
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  t.after(() => h.stop())
  const admin = h.conn(1)
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, ...planArgs(sc) })
  approve(sc, plan.data.planId)
  await beforeApply(sc, plan)
  await admin.request('pool_create', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: create (finished|FAILED)/.test(await status(admin)), T.waitForMs, 'the pool job')
  const line = (await status(admin)).split('\n').find(l => l.startsWith('Last pool job'))
  return { sc, plan, line }
}

/** The build's profile calls, in order, with repeated probes folded into one. */
const sequence = sc => sc.stub().calls.map(c => c.op).filter(op => ['guest-logon', 'guest-provisioned', 'guest-logon-undo', 'make-clean'].includes(op)).filter((op, i, a) => op !== 'guest-provisioned' || a[i - 1] !== op)

test('a build logs hvadmin then hvuser on once each, waits out their first-logon work, undoes each logon (verified), then takes the checkpoint', async t => {
  const { sc, plan, line } = await build(t, 'prov-ok', { provisionBusy: 3 })
  assert.match(plan.text, /- provisioning: each new VM logs hvadmin and hvuser on interactively once \(offline\), waits for Windows' first-logon setup to finish, then turns autologon off and resets UAC and the watcher's start before its clean checkpoint/)
  assert.match(line, /create finished/)
  assert.deepStrictEqual(sequence(sc), ['guest-logon', 'guest-provisioned', 'guest-logon-undo', 'guest-logon', 'guest-provisioned', 'guest-logon-undo', 'make-clean'])
  const vm = vms(sc)[0]
  assert.deepStrictEqual(vm.logons, [{ user: 'hvadmin', elevated: true, lua: 0 }, { user: 'hvuser', elevated: false, lua: 1 }], 'hvuser logged on with UAC on, after the undo')
  assert.strictEqual(vm.undos, 2)
  assert.deepStrictEqual(vm.checkpoints[0].userinit, 'C:\\Windows\\system32\\userinit.exe,', 'the checkpoint has Windows\' own Userinit')
  assert.strictEqual(vm.checkpoints[0].enableLUA, 1, 'and UAC on')
  const ready = sc.journal().find(r => r.t === 'ready')
  assert.deepStrictEqual(Object.keys(ready.profiles), ['hvadmin', 'hvuser'])
  assert.strictEqual(ready.profiles.hvadmin.packages, 42)
  assert.strictEqual(ready.profiles.hvadmin.inventory, 'cafe')
  assert.ok(vm.provisioned.filter(a => a === 'hvadmin').length > 3, 'busy samples, then quiet ones')
})

test('quiet is consecutive good, idle samples: a failed probe and a busy one late in the window start it over; it still settles', async t => {
  const { sc, line } = await build(t, 'prov-reset', { provisionFailAt: 2, provisionBusyAt: 3 })
  assert.match(line, /create finished/)
  // Sample 1 starts quiet, 2 fails and 3 is busy (each starts it over), so quiet needs samples 4 and 5 at least.
  for (const who of ['hvadmin', 'hvuser']) assert.ok(vms(sc)[0].provisioned.filter(a => a === who).length >= 5, who)
})

test('provisioning that never settles fails the build (rolled back), rather than checkpointing a half-provisioned profile', async t => {
  const { sc, line } = await build(t, 'prov-never', { provisionNever: true })
  assert.match(line, /FAILED: VM 1 of 1 \(hvmcp-[0-9a-f]+\): hvadmin's first-logon provisioning didn't settle within 15 s/)
  assert.deepStrictEqual(vms(sc), [])
})

test('a lost logon is retried once, after a verified undo (so the retry sees Windows\' Userinit); twice fails the build', async t => {
  const once = await build(t, 'prov-lost-once', { provisionLoseOnce: 2 })
  assert.match(once.line, /create finished/)
  assert.deepStrictEqual(sequence(once.sc), ['guest-logon', 'guest-provisioned', 'guest-logon-undo', 'guest-logon', 'guest-provisioned', 'guest-logon-undo', 'guest-logon', 'guest-provisioned', 'guest-logon-undo', 'make-clean'])
  assert.deepStrictEqual(vms(once.sc)[0].logons.map(l => [l.user, l.lua]), [['hvadmin', 0], ['hvadmin', 0], ['hvuser', 1]])
  const twice = await build(t, 'prov-lost-twice', { logonThenLogoff: 2 })
  assert.match(twice.line, /FAILED: .*provisioning hvadmin's profile failed twice: hvadmin logged on, then Windows logged the session off/)
  assert.deepStrictEqual(vms(twice.sc), [])
})

test('a first logon Windows drops before any check (MC-1524): retried at once after the undo, noted as expected; dropped twice fails in full', async t => {
  const once = await build(t, 'prov-dropped-once', { logonDroppedUnseen: 1 })
  assert.match(once.line, /create finished/)
  assert.match(once.line, /hvadmin's first logon was dropped by Windows \(attempt 1\), retried/)
  assert.doesNotMatch(once.line, /attempt 1 failed/)
  // The dropped attempt: one session check, then its diagnosis and undo, then the retry (no quiet wait in between).
  const seq = once.sc.stub().calls.map(c => c.op).filter(op => ['guest-logon', 'guest-session', 'guest-provisioned', 'guest-logon-diag', 'guest-logon-undo'].includes(op))
  assert.deepStrictEqual(seq.slice(0, 5),['guest-logon', 'guest-session', 'guest-logon-diag', 'guest-logon-undo', 'guest-logon'])
  const ready = once.sc.journal().find(r => r.t === 'ready')
  assert.strictEqual(ready.profiles.hvadmin.attempts[0].dropped, true)
  const twice = await build(t, 'prov-dropped-twice', { logonDroppedUnseen: 2 })
  assert.match(twice.line, /FAILED: .*provisioning hvadmin's profile failed twice: Windows logged hvadmin's logon off before it was seen/)
  assert.deepStrictEqual(vms(twice.sc), [])
})

test('a first logon that never begins (MC-1526): retried after the sign window, noted as expected; twice fails in full', async t => {
  const once = await build(t, 'prov-silent-once', { logonSilent: 1 })
  assert.match(once.line, /create finished/)
  assert.match(once.line, /hvadmin's first logon didn't begin \(attempt 1\), retried/)
  assert.doesNotMatch(once.line, /attempt 1 failed/)
  const ready = once.sc.journal().find(r => r.t === 'ready')
  assert.strictEqual(ready.profiles.hvadmin.attempts[0].silent, true)
  assert.strictEqual(ready.profiles.hvadmin.attempts.length, 2)
  const twice = await build(t, 'prov-silent-twice', { logonSilent: 2 })
  assert.match(twice.line, /FAILED: .*provisioning hvadmin's profile failed twice: no logon of hvadmin began within 1 s of its new boot being seen/)
  assert.deepStrictEqual(vms(twice.sc), [])
})

test('the build waits for App Readiness to finish each account (MC-1528): the checkpoint takes the post-wave counts, its state recorded allowlisted', async t => {
  // App Readiness finishes (and the wave lands) only at each logon's 8th probe; quiet alone (40 ms) would hold before it.
  const { sc, line } = await build(t, 'prov-readiness', { readinessDoneAt: 8 })
  assert.match(line, /create finished/)
  const ready = sc.journal().find(r => r.t === 'ready')
  for (const who of ['hvadmin', 'hvuser']) {
    assert.strictEqual(ready.profiles[who].mappings, 99, `${who}: the post-wave count`)
    assert.strictEqual(ready.profiles[who].packagesDirs, 64)
    assert.deepStrictEqual(ready.profiles[who].appReadiness, { done: true, tasks: 0, completedAt: '2026-11-16T02:01:55.000Z', completionId: 7, suspendedAt: null, suspendedUntil: '2026-11-16T02:00:55.499Z', resumedAt: '2026-11-16T02:00:55.600Z' }, 'allowlisted: no other field (no suspendedAt from this probe)')
  }
  assert.match(line, /hvadmin settled with 99 AppContainer mappings and 64 Packages folders after \d+ s \(App Readiness finished\)/)
})

test('App Readiness never finishing, or unreadable (MC-1528), fails the build late with its state, never accepted on quiet alone', async t => {
  const never = await build(t, 'prov-readiness-never', { readinessNever: true })
  assert.match(never.line, /FAILED: .*hvadmin's first-logon provisioning didn't settle within 15 s \(App Readiness: not finished, 39 tasks left, suspended until 2026-11-16T02:00:55\.499Z\)/)
  assert.deepStrictEqual(vms(never.sc), [], 'rolled back')
  assert.ok(!never.sc.journal().some(r => r.t === 'ready'), 'no ready record, no checkpoint kept')
  const unknown = await build(t, 'prov-readiness-unknown', { readinessUnknown: true })
  assert.match(unknown.line, /FAILED: .*didn't settle within 15 s \(App Readiness: unknown \(its logs unreadable or no answer\)\)/)
})

test('an undo that doesn\'t verify fails the build: a leftover explicit ACE on C:\\hvmcp, or UAC still off', async t => {
  const ace = await build(t, 'prov-undo-ace', { undoOverride: { hvmcpExplicitAces: 1 } })
  assert.match(ace.line, /undoing a build logon didn't verify: C:\\hvmcp has explicit or protected ACLs/)
  const lua = await build(t, 'prov-undo-lua', { undoOverride: { enableLUA: 0, userinit: 'x' } })
  assert.match(lua.line, /didn't verify: EnableLUA is 0, not 1; Userinit is x/)
  assert.deepStrictEqual(vms(lua.sc), [])
})

// MC-1577: no guest tweaks of the build's own (MC-1519's Defender exclusions, MC-1522's registry policy); the user's
// own guest setup script, named in the plan, instead.
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
/** The user's script file (the stub runs its text as a command: "write <path> <text>", "exit <n>", "sleep"). */
const userScript = (sc, text, name = 'guest.ps1') => { const f = path.join(sc.dir, 'user', name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
const scriptRuns = sc => sc.stub().calls.filter(c => c.op === 'guest-run-start')

test('a plain build adds no guest tweaks: no Defender step, no registry policy, no script; the plan says so', async t => {
  const { sc, plan, line } = await build(t, 'gs-plain')
  assert.match(line, /create finished/)
  assert.match(plan.text, /- guest setup script: none \(nothing is added to the guest beyond the build's own accounts and folders\)/)
  assert.doesNotMatch(plan.text, /Defender|DisableForceUnload|trial-session/)
  const ops = sc.stub().calls.map(c => c.op)
  for (const op of ['guest-defender', 'guest-run-start', 'guest-run-clear']) assert.ok(!ops.includes(op), `no ${op}`)
  assert.strictEqual(sc.journal().find(r => r.t === 'ready').guestScript, null)
  assert.ok(!Object.keys(vms(sc)[0].checkpoints[0].disk).some(p => /trial-session/i.test(p)))
})

test('a named guest setup script: shown in the plan by path, size and SHA-256; run once as the admin after the build\'s steps, its run cleared, before the checkpoint', async t => {
  const text = 'write C:\\gs-ran.txt from the user script'
  let file
  const { sc, plan, line } = await build(t, 'gs-ok', {}, { planArgs: sc => ({ guestScript: (file = userScript(sc, text)) }) })
  assert.match(line, /create finished/, line)
  const sha = crypto.createHash('sha256').update(text).digest('hex')
  assert.ok(plan.text.includes(`- guest setup script: ${file} (${text.length} bytes, SHA-256 ${sha}), run once in each new VM as its admin, offline, before its clean checkpoint; a non-zero exit fails that VM's build`), plan.text)
  const runs = scriptRuns(sc)
  assert.strictEqual(runs.length, 1)
  assert.strictEqual(runs[0].command, `﻿${text}`, 'the script\'s own text, marked UTF-8 for Windows PowerShell')
  const ops = sc.stub().calls.map(c => c.op)
  const at = ops.indexOf('guest-run-start')
  assert.ok(ops.lastIndexOf('guest-logon-undo') < at && at < ops.indexOf('guest-run-clear') && ops.indexOf('guest-run-clear') < ops.indexOf('make-clean'), 'after the profiles, cleared, then the checkpoint')
  const vm = vms(sc)[0]
  assert.ok(vm.checkpoints[0].disk['C:\\gs-ran.txt'], 'what it did is in the clean checkpoint')
  assert.ok(sc.stub().cleared.every(n => n >= 800_000_000), 'its run number is the helper\'s own')
  assert.deepStrictEqual(sc.journal().find(r => r.t === 'ready').guestScript, { sha256: sha, name: 'guest.ps1' })
  assert.ok(fs.existsSync(path.join(sc.stateDir, 'scripts', `${sha}.ps1`)), 'the helper\'s copy')
})

test('MC-1588: a guest setup script over the old 1 MB reaches a Windows guest in pieces of 1 MB (as base64), no call carrying more, and runs whole', async t => {
  const text = `write C:\\gs-big.txt ${'b'.repeat(2.5 * 1024 * 1024)}`
  const { sc, line } = await build(t, 'gs-big', {}, { planArgs: sc => ({ guestScript: userScript(sc, text) }) })
  assert.match(line, /create finished/, line)
  const st = sc.stub()
  assert.deepStrictEqual(st.stageCalls.map(c => c.part), [0, 1, 2])
  assert.ok(st.stageCalls.every(c => c.chars <= Math.ceil(1024 * 1024 / 3) * 4 && c.as === 'admin'), 'each piece at most 1 MB as base64, as the admin')
  assert.deepStrictEqual(st.stagedRuns, [{ n: st.stagedRuns[0].n, bytes: Buffer.byteLength(`\uFEFF${text}`), interactive: false }])
  assert.ok(st.stagedRuns[0].n >= 800_000_000, 'the helper\'s own run number')
  assert.strictEqual(scriptRuns(sc)[0].command, undefined, 'the start carries no command')
  assert.strictEqual(Buffer.from(vms(sc)[0].checkpoints[0].disk['C:\\gs-big.txt'], 'base64').length, 2.5 * 1024 * 1024, 'it ran whole')
})

test('the guest setup script runs from the helper\'s copy: a later change to the user\'s file changes nothing; a changed copy refuses the plan', async t => {
  let file
  const same = await build(t, 'gs-user-changed', {}, {
    planArgs: sc => ({ guestScript: (file = userScript(sc, 'write C:\\approved.txt yes')) }),
    beforeApply: () => fs.writeFileSync(file, 'write C:\\swapped.txt no')
  })
  assert.match(same.line, /create finished/)
  assert.strictEqual(scriptRuns(same.sc)[0].command, '\uFEFFwrite C:\\approved.txt yes', 'the approved bytes ran')
  let tsc
  await assert.rejects(build(t, 'gs-copy-changed', {}, {
    planArgs: sc => ({ guestScript: userScript(sc, 'write C:\\approved.txt yes') }),
    beforeApply: sc => { tsc = sc; const d = path.join(sc.stateDir, 'scripts'); for (const f of fs.readdirSync(d)) fs.writeFileSync(path.join(d, f), 'exit 0') }
  }), /Plan p-[0-9a-f]{16}'s guest setup script \(its helper copy\) is missing or changed: make a new plan\./)
  assert.ok(!tsc.stub().calls.some(c => c.op === 'create-vm' || c.op === 'guest-run-start'), 'nothing was created or run')
})

test('a guest setup script that exits non-zero, or never exits in time, fails the build with its output, before any checkpoint, and rolls back', async t => {
  for (const [name, text, why] of [
    ['gs-exit', 'exit 3', /FAILED: .*the guest setup script guest\.ps1 exited 3/],
    ['gs-slow', 'sleep', /FAILED: .*the guest setup script guest\.ps1 didn't finish within 0 min \(the guestScriptMinutes timing\)\. Its output ends:/]
  ]) {
    const { sc, line } = await build(t, name, { runJobs: true }, { planArgs: sc => ({ guestScript: userScript(sc, text) }) })
    assert.match(line, why, `${name}: ${line}`)
    assert.ok(!sc.stub().calls.some(c => c.op === 'make-clean'), `${name}: never reached the checkpoint`)
    assert.ok(!sc.journal().some(r => r.t === 'ready'), `${name}: no ready record`)
    assert.ok(sc.journal().some(r => r.t === 'rolledBack'), `${name}: rolled back`)
    if (name === 'gs-slow') assert.ok(sc.stub().kills?.length, 'the run was killed')
  }
})

test('a guest setup script is refused at plan time: a relative or missing path, the wrong kind for the guests, an empty file; a large one is taken (MC-1588)', async t => {
  const sc = scratch('gs-refused', { timing: 'narrow' })
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  t.after(() => h.stop())
  const admin = h.conn(1)
  const plan = guestScript => admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, guestScript })
  await assert.rejects(plan('guest.ps1'), /guestScript must be an absolute local path/)
  await assert.rejects(plan(path.join(sc.dir, 'nope.ps1')), /can't be read: no such file/)
  await assert.rejects(plan(userScript(sc, 'echo hi', 'guest.sh')), /guestScript must be a \.ps1, \.cmd, \.bat file for Windows guests/)
  // MC-1588: the cap is the most Node can hold as text (formerly 1 MB, with no reason that held).
  const { GUEST_SCRIPT_MAX } = require('../helper/core')
  assert.strictEqual(GUEST_SCRIPT_MAX, require('buffer').constants.MAX_STRING_LENGTH - 1)
  await assert.rejects(plan(userScript(sc, '', 'empty.ps1')), new RegExp(`must hold 1 byte to ${GUEST_SCRIPT_MAX} bytes \\(the helper reads it as text`))
  assert.match((await plan(userScript(sc, 'x'.repeat(1024 * 1024 + 1), 'big.ps1'))).text, /- guest setup script: .*big\.ps1 \(1048577 bytes/)
  for (const ok of ['a.ps1', 'b.cmd', 'c.BAT']) assert.match((await plan(userScript(sc, 'echo hi', ok))).text, /- guest setup script: /, ok)
})

// MC-1520: a failed build logon is diagnosed before its undo, and the attempt recorded where anyone can see it.
test('a failed build logon (MC-1520): diagnosed before its undo; the attempt, its reason and the allowlisted snapshot recorded, also in the job note', async t => {
  const { sc, line } = await build(t, 'diag-retry', { provisionLoseOnce: 2 })
  assert.match(line, /create finished: created hvmcp-[0-9a-f]+ \(hvadmin settled with \d+ AppContainer mappings and \d+ Packages folders after \d+ s \(App Readiness finished\); hvadmin's logon attempt 1 failed: hvadmin's session was lost while its first-logon work ran; up 600s, logon \+400s, shell \+402s, user-initiated logoff \+460s, no watcher, autologon cleared, busy: OneDriveSetup, unavailable: shellCore, cloudExperienceHost; hvuser settled/)
  const ops = sc.stub().calls.map(c => c.op)
  assert.ok(ops.indexOf('guest-logon-diag') < ops.indexOf('guest-logon-undo'), 'diagnosed before the undo')
  const p = sc.journal().find(r => r.t === 'ready').profiles.hvadmin
  assert.strictEqual(p.attempts.length, 2)
  assert.match(p.attempts[0].why, /session was lost/)
  assert.deepStrictEqual(p.attempts[0].diag.logs.lsm, [{ id: 21, s: 400 }, { id: 22, s: 402 }])
  assert.strictEqual(p.attempts[0].diag.logs.shellCore, 'unavailable')
  assert.deepStrictEqual(p.attempts[0].diag.logs.winlogon, [], 'an empty log stays empty, not unavailable')
  assert.deepStrictEqual(p.attempts[0].diag.processes, [{ name: 'explorer', s: 403 }, { name: 'OneDriveSetup', s: 410 }])
  assert.strictEqual(p.attempts[1].why, null)
  const all = JSON.stringify(sc.journal()) + line
  for (const bad of ['raw event text', 'hunter2', 'SECRET', 'commandLine', 'message', 'password']) assert.ok(!all.includes(bad), `dropped: ${bad}`)
})

test('a failed build logon whose diagnosis fails (MC-1520): recorded as unavailable, and the retry goes on', async t => {
  const { sc, line } = await build(t, 'diag-unavail', { provisionLoseOnce: 2, fail: { 'guest-logon-diag': 1 } })
  assert.match(line, /create finished: .*hvadmin's logon attempt 1 failed: .*diagnostics unavailable; hvuser settled/)
  assert.deepStrictEqual(sc.journal().find(r => r.t === 'ready').profiles.hvadmin.attempts[0].diag, { unavailable: true })
})

// MC-1520 part 4: the account's AppContainer profiles in the quiet test, and the named per-account budget.
test('quiet waits for the account\'s AppContainer counts to stop changing (MC-1520); they\'re recorded; the plan names the budget', async t => {
  const { sc, plan, line } = await build(t, 'prov-counts', { profileGrow: 4 })
  assert.match(line, /create finished/)
  assert.match(plan.text, /each account within \d+ min \(a logon attempt up to \d+ min once it has begun, one with no sign of a logon \d+ min after its new boot is seen retried at once, then accepted once Windows' App Readiness reports the account's first-logon app setup finished and \d+ min of observed quiet follow, one retry if needed; the time Windows itself suspends that setup isn't counted, up to \d+ min more\)/)
  for (const who of ['hvadmin', 'hvuser']) assert.ok(vms(sc)[0].provisioned.filter(a => a === who).length >= 6, `${who}: 4 changing samples, then quiet`)
  const p = sc.journal().find(r => r.t === 'ready').profiles
  assert.deepStrictEqual([p.hvadmin.mappings, p.hvadmin.packagesDirs, p.hvuser.mappings, p.hvuser.packagesDirs], [64, 29, 64, 29])
  // The settled counts are visible to any agent, in the job's note (pool_status).
  assert.match(line, /hvadmin settled with 64 AppContainer mappings and 29 Packages folders after \d+ s \(App Readiness finished, then the quiet restarted on AppContainer mappings changed 3×, Packages folders changed 3×\); hvuser settled with 64 AppContainer mappings and 29 Packages folders after \d+ s \(App Readiness finished, then the quiet restarted on AppContainer mappings changed 3×, Packages folders changed 3×\)/)
})

test('an unknown AppContainer count (MC-1520) is never quiet: it starts the window over, and the build still settles', async t => {
  const { sc, line } = await build(t, 'prov-counts-unknown', { profileUnknownAt: 2 })
  assert.match(line, /create finished/)
  assert.ok(vms(sc)[0].provisioned.filter(a => a === 'hvadmin').length >= 4)
})

// MC-1522: the guest image doesn't forcibly unload a user's registry at logoff; guest-setup reads it back.
test('no registry policy of the build\'s own (MC-1577 removed MC-1522\'s): a guest-setup read-back without one builds', async t => {
  const ok = await build(t, 'dfu-none', { setupOverride: { disableForceUnload: null } })
  assert.match(ok.line, /create finished/)
  assert.doesNotMatch(ok.plan.text, /- registry:/)
})

// MC-1577 round 1: a .ps1 saved by Windows PowerShell's Out-File is UTF-16 with its BOM. The script's text is decoded
// from its encoding (the hash stays the file's own bytes), and goes to the guest marked UTF-8 for Windows PowerShell.
const { decodeScript } = require('../helper/core')
const UNICODE = "$p = Join-Path $env:HVMCP_TEST_OUT 'said.txt'\r\n[IO.File]::WriteAllText($p, 'caf\u00e9 \u2713 \u00fcber', (New-Object Text.UTF8Encoding $false))\r\nexit 0\r\n"
const encodings = {
  utf8: Buffer.from(UNICODE, 'utf8'),
  utf8bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(UNICODE, 'utf8')]),
  utf16le: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(UNICODE, 'utf16le')]),
  utf16be: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(UNICODE, 'utf16le').swap16()])
}

test('a guest setup script\'s text: UTF-8 (with or without BOM) and BOM-marked UTF-16 LE and BE decode alike; a .ps1 goes marked UTF-8; anything else is refused', () => {
  for (const [name, bytes] of Object.entries(encodings)) {
    assert.strictEqual(decodeScript(bytes, 'powershell'), `\uFEFF${UNICODE}`, name)
    assert.strictEqual(decodeScript(bytes, 'bash'), UNICODE, `${name}: a .sh has no BOM (it would break a #! line)`)
  }
  for (const [name, bytes] of [['bad UTF-8', Buffer.from([0x63, 0xc3, 0x28])], ['UTF-16 without its BOM', Buffer.from('exit 0', 'utf16le')], ['a BOM alone', Buffer.from([0xff, 0xfe])], ['a NUL', Buffer.from('a\0b')]]) {
    assert.throws(() => decodeScript(bytes, 'powershell'), /guestScript must be a text file: UTF-8, or UTF-16 with its byte order mark/, name)
  }
})

test('a UTF-16 .ps1 (as Out-File writes it) is planned by its own bytes\' hash and runs as its decoded text', async t => {
  let file
  const { sc, plan, line } = await build(t, 'gs-utf16', {}, { planArgs: sc => { file = path.join(sc.dir, 'user', 'guest.ps1'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('write C:/u.txt caf\u00e9', 'utf16le')])); return { guestScript: file } } })
  assert.match(line, /create finished/, line)
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  assert.ok(plan.text.includes(`(${fs.statSync(file).size} bytes, SHA-256 ${sha})`), plan.text)
  assert.strictEqual(scriptRuns(sc)[0].command, '\uFEFFwrite C:/u.txt caf\u00e9')
  assert.ok(vms(sc)[0].checkpoints[0].disk['C:/u.txt'])
})

// The guest side for real: hv.ps1's own $RunFiles writes the decoded script as a guest run does, and Windows PowerShell
// 5.1 (a Windows guest's) runs it through the wrapper: the non-ASCII text arrives intact from each encoding.
const HV_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'helper', 'hv.ps1'), 'utf8')
const RUN_FILES = (() => { const s = HV_SOURCE.indexOf('\n$RunFiles = {'); const e = s < 0 ? -1 : HV_SOURCE.indexOf('\n}\n', s + 1); return e < 0 ? null : HV_SOURCE.slice(s + 1, e + 3) })()

test('each encoding of the same .ps1, decoded, written by hv.ps1\'s $RunFiles and run by Windows PowerShell 5.1: its non-ASCII text intact', { skip: process.platform !== 'win32' || !RUN_FILES }, () => {
  const { spawnSync } = require('child_process')
  const { ps51Env } = require('../helper/hv')
  for (const [name, bytes] of Object.entries(encodings)) {
    const sc = scratch(`gs-real-${name}`)
    const out = path.join(sc.dir, 'out')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(sc.dir, 'j.json'), JSON.stringify({ n: 800000001, command: decodeScript(bytes, 'powershell'), shell: 'powershell', cwd: sc.dir, out }), 'utf8')
    const harness = path.join(sc.dir, 'harness.ps1')
    fs.writeFileSync(harness, `$ErrorActionPreference = 'Stop'\n${RUN_FILES}\n$j = [IO.File]::ReadAllText('${path.join(sc.dir, 'j.json').replace(/'/g, "''")}', [Text.Encoding]::UTF8) | ConvertFrom-Json\n& $RunFiles $j '${path.join(sc.dir, 'hvmcp').replace(/'/g, "''")}'\n`)
    const w = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', env: ps51Env(), timeout: T.spawnMs })
    const wrapper = w.stdout.trim().split(/\r?\n/).pop()
    assert.ok(wrapper && fs.existsSync(wrapper), `${name}: $RunFiles gave its wrapper: ${w.stdout}${w.stderr}`)
    const r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', wrapper], { encoding: 'utf8', env: { ...ps51Env(), HVMCP_TEST_OUT: out }, timeout: T.spawnMs })
    assert.strictEqual(r.status, 0, `${name}: ${r.stdout}${r.stderr}`)
    assert.strictEqual(fs.readFileSync(path.join(out, '.run-800000001.exit'), 'utf8').trim(), '0', `${name}: ${fs.existsSync(path.join(out, '.run-800000001.stderr.txt')) && fs.readFileSync(path.join(out, '.run-800000001.stderr.txt'), 'utf8')}`)
    assert.strictEqual(fs.readFileSync(path.join(out, 'said.txt'), 'utf8'), 'caf\u00e9 \u2713 \u00fcber', `${name}: the script's text reached Windows PowerShell intact`)
  }
})
