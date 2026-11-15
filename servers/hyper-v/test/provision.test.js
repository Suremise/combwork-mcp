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
  await waitFor(async () => /Last pool job: create (finished|FAILED)/.test(await status(admin)), 15_000, 'the pool job')
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
  assert.match(line, /FAILED: VM 1 of 1 \(hvmcp-[0-9a-f]+\): hvadmin's first-logon provisioning didn't settle within 3 s/)
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
