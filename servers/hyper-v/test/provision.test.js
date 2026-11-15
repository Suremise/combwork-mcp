// The test accounts' profiles provisioned at build (MC-1516), through helper.js against the stub Hyper-V: hvadmin then
// hvuser logged on once each, their first-logon work waited out on observed quiet (consecutive good, idle samples; a
// failed or busy sample starts over; a lost logon is retried once), and a verified undo after each and before a retry,
// so every logon sees Windows' own Userinit and the intended UAC state, and the clean checkpoint keeps none of it.
const test = require('node:test')
const assert = require('assert')
const { scratch, startHelper, approve, seedImage, waitFor } = require('./helpers')

const vms = sc => Object.values(sc.stub().vms)
const status = async c => (await c.request('status')).text

/** A one-VM create with the stub set as given; resolves the plan and the job's line. */
async function build(t, name, stub = {}) {
  const sc = scratch(name, { stub })
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  t.after(() => h.stop())
  const admin = h.conn(1)
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  approve(sc, plan.data.planId)
  await admin.request('pool_create', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: create (finished|FAILED)/.test(await status(admin)), 60_000, 'the pool job')
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

test('an undo that doesn\'t verify fails the build: a leftover explicit ACE on C:\\hvmcp, or UAC still off', async t => {
  const ace = await build(t, 'prov-undo-ace', { undoOverride: { hvmcpExplicitAces: 1 } })
  assert.match(ace.line, /undoing a build logon didn't verify: C:\\hvmcp has explicit or protected ACLs/)
  const lua = await build(t, 'prov-undo-lua', { undoOverride: { enableLUA: 0, userinit: 'x' } })
  assert.match(lua.line, /didn't verify: EnableLUA is 0; Userinit is x/)
  assert.deepStrictEqual(vms(lua.sc), [])
})

// MC-1519 (the user's decision): the test work folders excluded from Defender's scanning (real-time and scheduled), in
// the image.
const EXCLUDED = String.raw`C:\build|C:\out|C:\trial-session|C:\hvmcp`.split('|')

test('Defender (MC-1519): the build excludes exactly the test folders, after the profiles and before the checkpoint, read back with real-time on', async t => {
  const { sc, plan, line } = await build(t, 'def-ok')
  assert.match(line, /create finished/)
  assert.ok(plan.text.includes(String.raw`- Defender: the test work folders C:\build, C:\out, C:\trial-session, C:\hvmcp are excluded from Defender's scanning (real-time and scheduled scans) in the guest image; Defender stays on otherwise`), plan.text)
  const ops = sc.stub().calls.map(c => c.op)
  assert.ok(ops.lastIndexOf('guest-logon-undo') < ops.indexOf('guest-defender') && ops.indexOf('guest-defender') < ops.indexOf('make-clean'), 'after the profiles, before the checkpoint')
  assert.deepStrictEqual(vms(sc)[0].exclusions, EXCLUDED)
  assert.deepStrictEqual(sc.journal().find(r => r.t === 'ready').defender, { exclusions: EXCLUDED, realTime: true })
})

test('Defender (MC-1519): a read-back missing a folder, with another exclusion, or with real-time protection off fails the build', async t => {
  const missing = await build(t, 'def-missing', { defenderOverride: { exclusions: String.raw`C:\build|C:\out|C:\hvmcp`.split('|') } })
  assert.ok(missing.line.includes(String.raw`Defender's settings didn't verify: its exclusions are c:\build, c:\hvmcp, c:\out, not exactly`), missing.line)
  const extra = await build(t, 'def-extra', { defenderOverride: { exclusions: [...EXCLUDED, String.raw`C:\Users`] } })
  assert.ok(extra.line.includes(String.raw`c:\users`) && extra.line.includes('not exactly'), extra.line)
  const off = await build(t, 'def-off', { defenderOverride: { realTime: false } })
  assert.match(off.line, /didn't verify: real-time protection is off/)
  assert.deepStrictEqual(vms(off.sc), [])
})

test('Defender (MC-1519): the antivirus service off, or the query failing, fails the build before any checkpoint or ready record, and rolls back', async t => {
  for (const [name, stub, why] of [
    ['def-service', { defenderOverride: { service: false } }, /Defender's settings didn't verify: the antivirus service is off/],
    ['def-query', { fail: { 'guest-defender': 1 } }, /injected failure of guest-defender/]
  ]) {
    const { sc, line } = await build(t, name, stub)
    assert.match(line, why)
    assert.ok(!sc.stub().calls.some(c => c.op === 'make-clean'), `${name}: never reached the checkpoint`)
    assert.ok(!sc.journal().some(r => r.t === 'ready'), `${name}: no ready record`)
    assert.ok(sc.journal().some(r => r.t === 'rolledBack'), `${name}: rolled back`)
    assert.deepStrictEqual(vms(sc), [])
  }
})

// MC-1520: a failed build logon is diagnosed before its undo, and the attempt recorded where anyone can see it.
test('a failed build logon (MC-1520): diagnosed before its undo; the attempt, its reason and the allowlisted snapshot recorded, also in the job note', async t => {
  const { sc, line } = await build(t, 'diag-retry', { provisionLoseOnce: 2 })
  assert.match(line, /create finished: created hvmcp-[0-9a-f]+ \(hvadmin settled with \d+ AppContainer mappings and \d+ Packages folders after \d+ s; hvadmin's logon attempt 1 failed: hvadmin's session was lost while its first-logon work ran; up 600s, logon \+400s, shell \+402s, user-initiated logoff \+460s, no watcher, autologon cleared, busy: OneDriveSetup, unavailable: shellCore, cloudExperienceHost; hvuser settled/)
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
  assert.match(plan.text, /each account within \d+ min \(a logon attempt up to \d+ min, then \d+ min of observed quiet, one retry if needed\)/)
  for (const who of ['hvadmin', 'hvuser']) assert.ok(vms(sc)[0].provisioned.filter(a => a === who).length >= 6, `${who}: 4 changing samples, then quiet`)
  const p = sc.journal().find(r => r.t === 'ready').profiles
  assert.deepStrictEqual([p.hvadmin.mappings, p.hvadmin.packagesDirs, p.hvuser.mappings, p.hvuser.packagesDirs], [64, 29, 64, 29])
  // The settled counts are visible to any agent, in the job's note (pool_status).
  assert.match(line, /hvadmin settled with 64 AppContainer mappings and 29 Packages folders after \d+ s; hvuser settled with 64 AppContainer mappings and 29 Packages folders after \d+ s/)
})

test('an unknown AppContainer count (MC-1520) is never quiet: it starts the window over, and the build still settles', async t => {
  const { sc, line } = await build(t, 'prov-counts-unknown', { profileUnknownAt: 2 })
  assert.match(line, /create finished/)
  assert.ok(vms(sc)[0].provisioned.filter(a => a === 'hvadmin').length >= 4)
})

// MC-1522: the guest image doesn't forcibly unload a user's registry at logoff; guest-setup reads it back.
test('the registry policy (MC-1522): named in the plan, read back from guest-setup; a build without it fails and rolls back', async t => {
  const ok = await build(t, 'dfu-ok')
  assert.match(ok.line, /create finished/)
  assert.match(ok.plan.text, /- registry: a user's registry isn't forcibly unloaded at logoff \(the DisableForceUnload policy\)/)
  const missing = await build(t, 'dfu-missing', { setupOverride: { disableForceUnload: null } })
  assert.match(missing.line, /the guest's sanity check failed: the guest's DisableForceUnload policy reads nothing, not 1/)
  assert.deepStrictEqual(vms(missing.sc), [])
})
