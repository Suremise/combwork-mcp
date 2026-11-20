// Pool changes: plan → the user's elevated approval → change. An approval counts only for that exact plan (its digest),
// its operation and pool epoch, unexpired, once, from a folder only Administrators and SYSTEM can write; and every change
// stays within policy.json, whatever its plan or approval says. Pool jobs are admitted one at a time, under one lock.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { T, scratch, startHelper, approve, seedImage, waitFor, withPool } = require('./helpers')

async function fresh(name, opts) {
  const sc = scratch(name, opts)
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  return { sc, h, admin: h.conn(1) }
}
const plan = (c, args = {}) => c.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, ...args })

test('a plan changes nothing and names the elevated approve line; unapproved, it is refused', async t => {
  const { sc, h, admin } = await fresh('unapproved')
  t.after(() => h.stop())
  const p = await plan(admin)
  assert.match(p.text, /Plan p-[0-9a-f]{16} \(create\)[\s\S]*approve\.cmd" -Plan p-[0-9a-f]{16}[\s\S]*never|Don't approve it for the user/)
  // MC-1575: one line for any terminal (cmd, Windows PowerShell or PowerShell 7), with no shell caveat.
  assert.match(p.text, /as one line in an admin terminal \(cmd or PowerShell\):\r?\ncmd \/c call "C:\\Program Files\\hyperv-mcp\\approve\.cmd" -Plan p-[0-9a-f]{16}/)
  assert.doesNotMatch(p.text, /powershell -NoProfile|Windows PowerShell|5\.1|pwsh/)
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [])
  await assert.rejects(admin.request('pool_create', { planId: p.data.planId }), /is not approved\. The user approves it in an admin terminal \(cmd or PowerShell\) with:\ncmd \/c call "C:\\Program Files\\hyperv-mcp\\approve\.cmd" -Plan p-/)
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [])
})

test('forged or stale approvals are refused, and change nothing', async t => {
  const { sc, h, admin } = await fresh('forged')
  t.after(() => h.stop())
  const cases = [
    ['another digest', p => approve(sc, p, { digest: 'f'.repeat(64) }), /digest is not this plan's/],
    ['another op', p => approve(sc, p, { op: 'remove' }), /operation differs/],
    ['expired', p => approve(sc, p, { expires: new Date(Date.now() - 1000).toISOString() }), /expired/],
    ['another epoch', p => approve(sc, p, { epoch: 'e'.repeat(32) }), /earlier pool state/],
    ['a malformed nonce', p => approve(sc, p, { nonce: 'x' }), /nonce is malformed/],
    ['another plan\'s id', p => approve(sc, p, { planId: 'p-0000000000000000' }), /names another plan/],
    ['a writable folder', p => { approve(sc, p); sc.patchStub(s => { s.aclBad = 'Users can write approvals' }) }, /Users can write approvals/]
  ]
  for (const [what, forge, why] of cases) {
    const p = (await plan(admin)).data.planId
    forge(p)
    await assert.rejects(admin.request('pool_create', { planId: p }), why, what)
    sc.patchStub(s => { delete s.aclBad })
  }
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [])
  assert.ok(!sc.journal().some(r => r.t === 'job'), 'no job was journalled')
})

test('a plan changed after approval no longer matches its digest', async t => {
  const { sc, h, admin } = await fresh('tampered')
  t.after(() => h.stop())
  const p = (await plan(admin)).data.planId
  approve(sc, p)
  const file = path.join(sc.stateDir, 'plans', `${p}.json`)
  const doc = JSON.parse(fs.readFileSync(file))
  doc.add[0].cores = 4
  fs.writeFileSync(file, JSON.stringify(doc))
  await assert.rejects(admin.request('pool_create', { planId: p }), /digest is not this plan's/)
})

test('an approval is used once: its nonce is journalled before any side effect', async t => {
  const { sc, h, admin } = await fresh('single-use', { policy: { approvePoolChanges: 'each' } }) // MC-1576: every plan approved, so the nonce is the guard
  t.after(() => h.stop())
  const p1 = (await plan(admin)).data.planId
  const a = approve(sc, p1)
  await admin.request('pool_create', { planId: p1 })
  await waitFor(async () => /Last pool job/.test((await admin.request('status')).text))
  const job = sc.journal().find(r => r.t === 'job')
  assert.strictEqual(job.nonce, a.nonce)
  assert.ok(sc.journal().indexOf(job) < sc.journal().findIndex(r => r.t === 'intent'))
  const p2 = (await admin.request('pool_plan', { action: 'resize', vms: 2 })).data.planId
  approve(sc, p2, { nonce: a.nonce })
  await assert.rejects(admin.request('pool_resize', { planId: p2 }), /already been used/)
  await assert.rejects(admin.request('pool_create', { planId: p1 }), /was already applied/) // MC-1576: before its approval is even read
})

test('plan ids are opaque: anything else is refused before a file is touched', async t => {
  const { h, admin } = await fresh('plan-ids')
  t.after(() => h.stop())
  for (const bad of ['../policy', 'p-123', 'p-0123456789ABCDEF', 'p-0123456789abcdef\\..\\x', 42, null]) {
    await assert.rejects(admin.request('pool_create', { planId: bad }), /planId must be a plan id/, String(bad))
  }
  await assert.rejects(admin.request('pool_create', { planId: 'p-0123456789abcdef' }), /No plan/)
})

test('the policy is the hard limit: a plan beyond it is refused, and so is a forged plan with a valid approval', async t => {
  const { sc, h, admin } = await fresh('policy')
  t.after(() => h.stop())
  await assert.rejects(plan(admin, { vms: 4 }), /vms must be 1-3/)
  await assert.rejects(plan(admin, { cores: 5 }), /cores for one VM is outside the policy's 1-4/)
  await assert.rejects(plan(admin, { vms: 3, memoryGB: 10 }), /memory in all is more than the policy's 24576 MB/)
  await assert.rejects(plan(admin, { location: sc.dir }), /location must be one of the policy's disk folders/)
  // A plan file written by someone other than the helper, approved: still checked against the policy.
  const p = (await plan(admin)).data.planId
  const file = path.join(sc.stateDir, 'plans', `${p}.json`)
  const doc = JSON.parse(fs.readFileSync(file))
  doc.add = Array.from({ length: 5 }, (_, i) => ({ ...doc.add[0], intentId: `i-${'0'.repeat(15)}${i}`, name: `hvmcp-0000000${i}` }))
  doc.add.push({ ...doc.add[0], intentId: 'i-1111111111111111', folder: 'C:\\Windows\\pool\\i-1111111111111111' })
  fs.writeFileSync(file, JSON.stringify(doc))
  approve(sc, p)
  await assert.rejects(admin.request('pool_create', { planId: p }), /outside the policy now: 6 VMs is more than the policy's 3.*not under one of the policy's disk folders/)
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [])
})

test('one pool job at a time; a second is refused and changes nothing', async t => {
  const { sc, h, admin } = await fresh('one-job', {})
  t.after(() => h.stop())
  sc.patchStub(s => { s.installNeverReady = true }) // the install waits (3 s in the tests), then fails
  const p1 = (await plan(admin)).data.planId
  approve(sc, p1)
  const p2 = (await plan(admin)).data.planId
  approve(sc, p2)
  await admin.request('pool_create', { planId: p1 })
  await assert.rejects(admin.request('pool_create', { planId: p2 }), /A pool job is already running/)
  await waitFor(async () => /Last pool job: create FAILED/.test((await admin.request('status')).text), T.waitForMs)
  assert.match((await admin.request('status')).text, /didn't finish within/)
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [], 'the failed VM was rolled back')
  assert.ok(sc.journal().some(r => r.t === 'rolledBack'))
})

test('remove refuses while a target VM is leased (nothing changed); after release it removes only the pool\'s VMs', async t => {
  const sc = scratch('remove')
  const { h, admin } = await withPool(sc, 2)
  t.after(() => h.stop())
  sc.patchStub(s => { s.vms.foreign = { id: 'foreign', name: 'hvmcp-ffffffff', location: 'C:\\elsewhere\\hvmcp-ffffffff', state: 'Off', checkpoints: [], parent: null, disk: {} } })
  const a = h.conn(10)
  await a.request('acquire')
  const p = (await admin.request('pool_plan', { action: 'remove' })).data.planId
  approve(sc, p)
  await assert.rejects(admin.request('pool_remove', { planId: p }), /is leased .*Nothing was changed/)
  assert.strictEqual(Object.keys(sc.stub().vms).length, 3)
  await a.request('release')
  await admin.request('pool_remove', { planId: p })
  await waitFor(async () => /Last pool job: remove finished/.test((await admin.request('status')).text))
  assert.deepStrictEqual(Object.keys(sc.stub().vms), ['foreign'])
  assert.deepStrictEqual(fs.readdirSync(path.join(sc.disks, 'pool')), [], 'the VMs\' folders are gone')
  await assert.rejects(a.request('acquire'), /no VMs yet/)
})

test('acquire racing remove: whichever takes the pool lock first wins; the other is refused cleanly', async t => {
  const sc = scratch('race')
  const { h, admin } = await withPool(sc, 1)
  t.after(() => h.stop())
  const p = (await admin.request('pool_plan', { action: 'remove' })).data.planId
  approve(sc, p)
  const a = h.conn(10)
  const [acq, rem] = await Promise.allSettled([a.request('acquire'), admin.request('pool_remove', { planId: p })])
  if (acq.status === 'fulfilled') assert.match(rem.reason.message, /is leased/)
  else assert.match(acq.reason.message, /No VM is free|no VMs yet/)
})

test('quiesce needs its own admin-written approval; then no new leases and every lease ended', async t => {
  const sc = scratch('quiesce')
  const { h, admin } = await withPool(sc, 2)
  t.after(() => h.stop())
  const a = h.conn(10)
  await a.request('acquire')
  await a.request('start')
  await a.request('stop', { keep: true })
  await assert.rejects(admin.request('quiesce'), /for uninstall\.ps1 only/)
  quiesceApproval(sc, { purpose: undefined })
  await assert.rejects(admin.request('quiesce'), /names no purpose/)
  quiesceApproval(sc, { purpose: 'keep-pool' })
  assert.match((await admin.request('quiesce')).text, /Quiesced: no leases, every VM restored \(2\)/)
  await assert.rejects(h.conn(11).request('acquire'), /being uninstalled/)
  await assert.rejects(admin.request('quiesce'), /expired, used or from another state/, 'its nonce is used')
  // keep-pool allows no pool change at all, an approved remove included.
  const p = (await admin.request('pool_plan', { action: 'remove' })).data.planId
  approve(sc, p)
  await assert.rejects(admin.request('pool_remove', { planId: p }), /being uninstalled: no pool changes/)
  assert.strictEqual(Object.keys(sc.stub().vms).length, 2)
})

/** Writes approvals\quiesce.json as uninstall.ps1 does. */
function quiesceApproval(sc, over = {}) {
  const a = { nonce: crypto.randomBytes(16).toString('hex'), epoch: sc.journal()[0].epoch, expires: new Date(Date.now() + 60_000).toISOString(), purpose: 'remove-pool', ...over }
  fs.writeFileSync(path.join(sc.stateDir, 'approvals', 'quiesce.json'), JSON.stringify(a))
}

test('uninstall -RemovePool end to end: quiesce (remove-pool) → plan → approve → remove; only that remove is allowed', async t => {
  const sc = scratch('uninstall-remove')
  const { h, admin } = await withPool(sc, 2, { network: 'host' })
  t.after(() => h.stop())
  const a = h.conn(10)
  await a.request('acquire')
  quiesceApproval(sc)
  assert.match((await admin.request('quiesce')).text, /Quiesced/)
  await assert.rejects(h.conn(11).request('acquire'), /being uninstalled/)
  const grow = (await admin.request('pool_plan', { action: 'resize', vms: 3 })).data
  if (grow?.planId) { approve(sc, grow.planId); await assert.rejects(admin.request('pool_resize', { planId: grow.planId }), /no pool changes/) }
  const p = (await admin.request('pool_plan', { action: 'remove' })).data.planId
  approve(sc, p)
  await admin.request('pool_remove', { planId: p })
  await waitFor(async () => /Last pool job: remove finished/.test((await admin.request('status')).text))
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [])
  assert.deepStrictEqual(Object.keys(sc.stub().switches), ['hvmcp-host'], 'setup\'s switch is setup\'s: uninstall.ps1 removes it, not a pool remove')
  assert.match((await admin.request('status')).text, /Pool: no VMs; network none/)
})

test('uninstall -RemovePool interrupted mid-remove, then run again: recovery finishes it, and a new quiesce works', async t => {
  const sc = scratch('uninstall-interrupted')
  let { h, admin } = await withPool(sc, 2)
  quiesceApproval(sc)
  await admin.request('quiesce')
  const p = (await admin.request('pool_plan', { action: 'remove' })).data.planId
  approve(sc, p)
  await h.stop()
  // The same helper state, quiesced again by a fresh helper that crashes after removing the first VM.
  h = await startHelper(sc, { HYPERV_MCP_CRASH_AT: 'after:remove-vm' })
  admin = h.conn(1)
  quiesceApproval(sc)
  await admin.request('quiesce')
  admin.request('pool_remove', { planId: p }).catch(() => {})
  assert.strictEqual(await h.exited, 99)
  h = await startHelper(sc) // uninstall run again: the restarted helper recovers first
  t.after(() => h.stop())
  admin = h.conn(1)
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [], 'the interrupted remove was completed by recovery')
  quiesceApproval(sc)
  assert.match((await admin.request('quiesce')).text, /Quiesced: no leases, every VM restored \(0\)/)
  assert.match((await admin.request('status')).text, /Pool: no VMs/)
})

test('MC-1576 round 1: within the caps (the default), uninstall\'s quiesce still admits only its own approved removal: an unapproved one is refused; keep-pool refuses every change', async t => {
  const sc = scratch('uninstall-withincaps')
  const { h, admin } = await withPool(sc, 2)
  t.after(() => h.stop())
  quiesceApproval(sc)
  assert.match((await admin.request('quiesce')).text, /Quiesced/)
  const p = await admin.request('pool_plan', { action: 'remove' })
  assert.match(p.text, /It needs the user's approval: the helper is being uninstalled: only the uninstaller's own approved removal of the pool\./)
  await assert.rejects(admin.request('pool_remove', { planId: p.data.planId }), /is not approved/)
  assert.strictEqual(Object.keys(sc.stub().vms).length, 2, 'nothing removed')
  assert.ok(!sc.journal().some(r => r.t === 'job' && r.approval === 'caps'), 'no job within the caps')
  approve(sc, p.data.planId)
  await admin.request('pool_remove', { planId: p.data.planId })
  await waitFor(async () => /Last pool job: remove finished/.test((await admin.request('status')).text))
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [])

  const sc2 = scratch('uninstall-withincaps-keep')
  const w = await withPool(sc2, 1)
  t.after(() => w.h.stop())
  quiesceApproval(sc2, { purpose: 'keep-pool' })
  await w.admin.request('quiesce')
  for (const args of [{ action: 'remove' }, { action: 'resize', vms: 2 }]) {
    const q = await w.admin.request('pool_plan', args).catch(e => ({ text: e.message }))
    if (q.data?.planId) await assert.rejects(w.admin.request(`pool_${args.action}`, { planId: q.data.planId }), /being uninstalled: no pool changes/)
  }
  assert.strictEqual(Object.keys(sc2.stub().vms).length, 1)
})
