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
