// Crash recovery: the helper is killed (HYPERV_MCP_CRASH_AT ends the process) before or after each side effect of a pool
// change, then started again. Recovery must finish or undo exactly what the journal says may have been done: an
// unfinished create rolled back (the VM found only by its exact random name in its exact folder, never another), an
// unfinished remove completed, an unfinished switch change finished, open jobs closed, and every VM restored.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { scratch, startHelper, approve, seedImage, waitFor, withPool } = require('./helpers')

async function prepared(name) {
  const sc = scratch(name)
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  return sc
}

/** Plans and approves a create with the helper, then runs it in a helper that crashes at `at`; returns the restarted helper. */
async function crashCreate(sc, at, planArgs = {}) {
  let h = await startHelper(sc)
  const p = (await h.conn(1).request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, ...planArgs })).data.planId
  approve(sc, p)
  await h.stop()
  h = await startHelper(sc, { HYPERV_MCP_CRASH_AT: at })
  h.conn(1).request('pool_create', { planId: p }).catch(() => {}) // a crash early in the job can come before the reply
  assert.strictEqual(await h.exited, 99, `the helper crashed at ${at}`)
  return startHelper(sc)
}

const poolFolders = sc => { try { return fs.readdirSync(path.join(sc.disks, 'pool')) } catch { return [] } }

for (const at of ['after:make-iso', 'before:create-vm', 'after:create-vm', 'before:start-vm', 'after:start-vm', 'before:guest-setup', 'after:guest-setup', 'before:make-clean', 'after:make-clean', 'after:restore']) {
  test(`a crash at ${at} during a create is rolled back at the next start`, async t => {
    const sc = await prepared(`crash-${at.replace(':', '-')}`)
    const h = await crashCreate(sc, at)
    t.after(() => h.stop())
    assert.deepStrictEqual(Object.keys(sc.stub().vms), [], 'no VM left behind')
    assert.deepStrictEqual(poolFolders(sc), [], 'no folder left behind')
    const j = sc.journal()
    const intent = j.find(r => r.t === 'intent')
    assert.ok(j.some(r => r.t === 'rolledBack' && r.intentId === intent.intentId))
    assert.ok(j.some(r => r.t === 'jobEnd' && r.ok === false && /interrupted/.test(r.note)))
    assert.match((await h.conn(1).request('status')).text, /Rolled back the unfinished VM .*Pool job j-[0-9a-f]+ \(create\) was interrupted/)
  })
}

test('recovery never adopts a VM that merely shares the unfinished one\'s name, in another folder', async t => {
  const sc = await prepared('crash-lookalike')
  let h = await startHelper(sc)
  const p = (await h.conn(1).request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })).data.planId
  approve(sc, p)
  await h.stop()
  h = await startHelper(sc, { HYPERV_MCP_CRASH_AT: 'after:create-vm' })
  h.conn(1).request('pool_create', { planId: p }).catch(() => {}) // a crash early in the job can come before the reply
  await h.exited
  const name = sc.journal().find(r => r.t === 'intent').vmName
  sc.patchStub(s => { s.vms.lookalike = { id: 'lookalike', name, location: `C:\\elsewhere\\${name}`, state: 'Off', checkpoints: [], parent: null, disk: {} } })
  h = await startHelper(sc)
  t.after(() => h.stop())
  assert.deepStrictEqual(Object.keys(sc.stub().vms), ['lookalike'], 'only the VM in the intent\'s own folder was removed')
  assert.deepStrictEqual(sc.stub().calls.filter(c => c.vmId === 'lookalike'), [])
})

test('a failure right after New-VM (no id returned) is rolled back by exact name and folder', async t => {
  const sc = await prepared('fail-after-new-vm')
  const h = await startHelper(sc)
  t.after(() => h.stop())
  const admin = h.conn(1)
  sc.patchStub(s => { s.failAfterCreate = true })
  const p = (await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })).data.planId
  approve(sc, p)
  await admin.request('pool_create', { planId: p })
  await waitFor(async () => /Last pool job: create FAILED/.test((await admin.request('status')).text))
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [])
  assert.deepStrictEqual(poolFolders(sc), [])
})

for (const at of ['before:remove-vm', 'after:remove-vm']) {
  test(`a crash at ${at} during a remove is completed at the next start`, async t => {
    const sc = scratch(`crash-remove-${at.replace(':', '-')}`)
    let { h, admin } = await withPool(sc, 2)
    const p = (await admin.request('pool_plan', { action: 'remove' })).data.planId
    approve(sc, p)
    await h.stop()
    h = await startHelper(sc, { HYPERV_MCP_CRASH_AT: at })
    h.conn(1).request('pool_remove', { planId: p }).catch(() => {})
    assert.strictEqual(await h.exited, 99)
    h = await startHelper(sc)
    t.after(() => h.stop())
    assert.deepStrictEqual(Object.keys(sc.stub().vms), [])
    assert.deepStrictEqual(poolFolders(sc), [])
    assert.match((await h.conn(1).request('status')).text, /Pool: no VMs/)
  })
}

for (const at of ['before:new-switch', 'after:new-switch']) {
  test(`a crash at ${at} undoes the switch at the next start`, async t => {
    const sc = await prepared(`crash-switch-${at.replace(':', '-')}`)
    const h = await crashCreate(sc, at, { network: true })
    t.after(() => h.stop())
    assert.deepStrictEqual(sc.stub().switches, {})
    assert.match((await h.conn(1).request('status')).text, /switch: none/)
  })
}

test('a helper restart voids every lease and restores every VM before serving anyone', async t => {
  const sc = scratch('restart-restores')
  let { h } = await withPool(sc, 2)
  const a = h.conn(10); const b = h.conn(11)
  await a.request('acquire'); await b.request('acquire')
  await a.request('start'); await b.request('start')
  await a.request('run', { command: 'write C:\\sentinel.txt x' })
  await a.request('stop', { keep: true })
  await h.kill()
  for (const v of Object.values(sc.stub().vms)) assert.strictEqual(v.state === 'Running' || v.disk['C:\\sentinel.txt'] !== undefined, true)
  h = await startHelper(sc)
  t.after(() => h.stop())
  for (const v of Object.values(sc.stub().vms)) {
    assert.strictEqual(v.state, 'Off')
    assert.strictEqual(v.disk['C:\\sentinel.txt'], undefined)
  }
  assert.match((await h.conn(1).request('status')).text, /restored to clean\..*restored to clean\./)
  const c = h.conn(12)
  await c.request('acquire')
})

test('a quarantined VM that can\'t be restored at start-up stays quarantined and is reported', async t => {
  const sc = scratch('restart-quarantine')
  let { h } = await withPool(sc, 1)
  await h.stop()
  sc.patchStub(s => { s.fail.restore = 1 })
  h = await startHelper(sc)
  t.after(() => h.stop())
  assert.match((await h.conn(1).request('status')).text, /QUARANTINED \(restore: injected failure of restore\)/)
})

// A same-named switch that isn't the pool's (another id, no token of ours in its Notes) is never removed or used.
const FOREIGN = { 'hvmcp-internal': { id: 'foreign-switch-id', type: 'Internal', notes: '' } }

test('a foreign switch with the pool\'s switch name survives a create that fails on it, and the next start', async t => {
  const sc = await prepared('foreign-switch-fail')
  sc.patchStub(s => { s.switches = { ...FOREIGN } })
  let h = await startHelper(sc)
  const admin = h.conn(1)
  const p = (await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, network: true })).data.planId
  approve(sc, p)
  await admin.request('pool_create', { planId: p })
  await waitFor(async () => /Last pool job: create FAILED: creating the switch hvmcp-internal: .*already exists/.test((await admin.request('status')).text))
  assert.deepStrictEqual(sc.stub().switches, FOREIGN, 'untouched by the failed create')
  await h.stop()
  h = await startHelper(sc)
  t.after(() => h.stop())
  assert.deepStrictEqual(sc.stub().switches, FOREIGN, 'untouched by recovery')
  assert.match((await h.conn(1).request('status')).text, /switch: none/)
})

test('a crash before creating the switch, with a foreign one of that name present: recovery leaves it alone', async t => {
  const sc = await prepared('foreign-switch-crash')
  sc.patchStub(s => { s.switches = { ...FOREIGN } })
  const h = await crashCreate(sc, 'before:new-switch', { network: true })
  t.after(() => h.stop())
  assert.deepStrictEqual(sc.stub().switches, FOREIGN)
  assert.match((await h.conn(1).request('status')).text, /exists but isn't the pool's .*left untouched/)
})

test('a switch made but not journalled (a failure after New-VMSwitch) is found by its token and removed', async t => {
  const sc = await prepared('switch-token')
  sc.patchStub(s => { s.failAfterSwitch = true })
  const h = await startHelper(sc)
  t.after(() => h.stop())
  const admin = h.conn(1)
  const p = (await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, network: true })).data.planId
  approve(sc, p)
  await admin.request('pool_create', { planId: p })
  await waitFor(async () => /Last pool job: create FAILED/.test((await admin.request('status')).text))
  assert.deepStrictEqual(sc.stub().switches, {}, 'its own switch, found by token, is gone')
})

test('a start with networking uses the pool\'s switch by id: a same-named replacement is refused', async t => {
  const sc = scratch('switch-replaced')
  const { h } = await withPool(sc, 1, { network: true })
  t.after(() => h.stop())
  sc.patchStub(s => { s.switches['hvmcp-internal'] = { id: 'replacement-id', type: 'Internal', notes: '' } })
  const a = h.conn(10)
  await a.request('acquire')
  await assert.rejects(a.request('start', { network: true }), /switch hvmcp-internal \(id .*\) is missing, renamed or not internal/)
  assert.ok(!Object.values(sc.stub().vms).some(v => v.switchName), 'no adapter was connected')
})
