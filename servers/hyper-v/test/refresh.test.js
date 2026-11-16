// Refreshing a VM's clean checkpoint in place (MC-1531): an approved pool job restores the clean checkpoint, reruns the
// build's guest steps offline, takes a new clean checkpoint of the Off VM, makes it current (the commit), then removes
// the old one, its children (pool checkpoints) merged and kept; failures before the commit abandon (old clean kept,
// the provisional snapshot reconciled); a failed removal after it keeps the VM quarantined until it's done; crashes at
// each boundary recover; the evaluation end never moves and nothing is activated. Through helper.js against the stub's
// snapshot tree.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { scratch, startHelper, withPool, approve, waitFor } = require('./helpers')

async function pool(name, n = 2) {
  const sc = scratch(name, { policy: { maxVms: 4 } })
  const { h } = await withPool(sc, n)
  await h.stop()
  const helper = await startHelper(sc, { HYPERV_MCP_WAIT_MS: '400', HYPERV_MCP_KEEP_MS: '60000' })
  return { sc, h: helper, admin: helper.conn(99) }
}
const req = (c, op, args) => c.request(op, args).then(r => r, e => ({ error: e.message, text: e.message }))
const vmNames = async c => [...(await c.request('status')).text.matchAll(/^- (hvmcp-[0-9a-f]+):/gm)].map(m => m[1])
const stubVm = (sc, name) => Object.values(sc.stub().vms).find(v => v.name === name)
const status = async c => (await c.request('status')).text
const jobLine = async c => (await status(c)).split('\n').find(l => l.startsWith('Last pool job')) || ''

/** Plans, approves and runs a refresh of these VMs; waits for its job; returns the job's line. */
async function refresh(env, targets) {
  const p = await req(env.admin, 'pool_plan', { action: 'refresh-clean', targets })
  assert.ok(p.data?.planId, p.text)
  approve(env.sc, p.data.planId)
  const r = await req(env.admin, 'pool_refresh', { planId: p.data.planId })
  assert.match(r.text, /pool job j-\w+ \(refresh\) is running/, r.text)
  await waitFor(async () => /Last pool job: refresh (finished|FAILED)/.test(await status(env.admin)), 30_000, 'the refresh job')
  return jobLine(env.admin)
}
/** Publishes a pool checkpoint "tools" of v (a lease writes C:\tools\v1.txt first). */
async function tools(env, v) {
  const a = env.h.conn(1)
  await a.request('acquire', { minutes: 30, vm: v })
  await a.request('start', {})
  await a.request('run', { command: 'write C:\\tools\\v1.txt one' })
  const p = await a.request('pool_plan', { action: 'checkpoint', name: 'tools', targets: [v] })
  approve(env.sc, p.data.planId)
  await a.request('pool_checkpoint', { planId: p.data.planId })
  await a.request('release')
}

test('a refresh with a pool checkpoint present: the new clean has the fix, the old one is removed, the pool checkpoint is kept and still starts; the evaluation end doesn\'t move; nothing goes online', async () => {
  const env = await pool('rcl-basic')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  await tools(env, v1)
  const days = async () => /Windows evaluation, (\d+) days left \(until (\S+)\)/.exec((await status(admin)).split('\n').find(l => l.includes(v1))).slice(1)
  const before = await days()
  const online = stubVm(sc, v1).onlineCount || 0
  const oldClean = stubVm(sc, v1).checkpoints.find(c => c.name === 'clean').id
  sc.patchStub(st => { st.setupMarker = 'fix-1' })
  const line = await refresh(env, [v1])
  assert.match(line, new RegExp(`${v1}: refreshed \\(licence status 1; .*its pool checkpoints kept\\)`))
  const v = stubVm(sc, v1)
  assert.ok(!v.checkpoints.some(c => c.id === oldClean), 'the old clean removed')
  const sel = sc.journal().find(r => r.t === 'rcl-begin')
  const newId = sc.journal().find(r => r.t === 'rcl-taken' && r.opId === sel.opId).checkpointId
  assert.ok(v.checkpoints.some(c => c.id === newId))
  const pub = v.checkpoints.find(c => c.name.startsWith('hvmcp-pool-'))
  assert.ok(pub && pub.disk['C:\\tools\\v1.txt'] !== undefined, 'the pool checkpoint kept, with its contents')
  assert.deepStrictEqual(await days(), before, 'the evaluation end unchanged')
  assert.strictEqual(v.onlineCount || 0, online, 'never online (guest-activate never ran)')
  const c = h.conn(2)
  await c.request('acquire', { minutes: 30, vm: v1 })
  assert.match((await c.request('start', {})).text, /from its clean checkpoint/)
  assert.ok(stubVm(sc, v1).disk['C:\\marker.txt'] !== undefined, 'a lease now starts from the new clean, with the fix')
  assert.match((await c.request('start', { checkpoint: 'tools' })).text, /from its pool checkpoint "tools"/)
  assert.ok(stubVm(sc, v1).disk['C:\\tools\\v1.txt'] !== undefined)
  await c.request('release')
  await h.stop()
})

test('a repeat refresh keeps the sibling pool checkpoint and retires only its own prior clean', async () => {
  const env = await pool('rcl-repeat')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  await tools(env, v1)
  await refresh(env, [v1])
  const pub = stubVm(sc, v1).checkpoints.find(c => c.name.startsWith('hvmcp-pool-'))
  const firstNew = sc.journal().filter(r => r.t === 'rcl-taken')[0].checkpointId
  const line = await refresh(env, [v1])
  assert.match(line, /refreshed/)
  const v = stubVm(sc, v1)
  assert.ok(!v.checkpoints.some(c => c.id === firstNew), 'the first refresh\'s clean retired')
  assert.ok(v.checkpoints.some(c => c.id === pub.id && c.disk['C:\\tools\\v1.txt'] !== undefined), 'the pool checkpoint kept, same id and contents')
  await h.stop()
})

test('failures before the commit abandon: the old clean is kept, the provisional snapshot reconciled and removed, the VM free', async () => {
  const env = await pool('rcl-abandon')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const oldClean = stubVm(sc, v1).checkpoints.find(c => c.name === 'clean').id
  sc.patchStub(st => { st.setupThrows = true })
  assert.match(await refresh(env, [v1]), /FAILED \((guest-setup: )?injected: the guest setup failed\); its old clean checkpoint is kept, unchanged/)
  sc.patchStub(st => { st.setupThrows = false; st.poolTakeFail = true })
  assert.match(await refresh(env, [v1]), /FAILED \(Hyper-V couldn't take the new clean checkpoint/)
  sc.patchStub(st => { st.poolTakeFail = false; st.poolTakeFailButMade = true })
  assert.match(await refresh(env, [v1]), /FAILED \(the take's outcome is unknown .*\); its old clean checkpoint is kept/)
  sc.patchStub(st => { st.poolTakeFailButMade = false })
  const v = stubVm(sc, v1)
  assert.deepStrictEqual(v.checkpoints.map(c => c.id), [oldClean], 'only the old clean, every provisional snapshot removed')
  assert.strictEqual(sc.journal().filter(r => r.t === 'rcl-abandoned').length, 3)
  assert.match(await status(admin), new RegExp(`${v1}: .*; free`))
  await h.stop()
})

test('a removal of the old clean that fails after the commit keeps the VM quarantined until a retry removes it', async () => {
  const env = await pool('rcl-retire-fail')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const oldClean = stubVm(sc, v1).checkpoints.find(c => c.name === 'clean').id
  sc.patchStub(st => { st.snapRemoveFail = 1 })
  assert.match(await refresh(env, [v1]), /refreshed .*but old clean removal pending: .*it stays quarantined/)
  assert.match(await status(admin), new RegExp(`${v1}: .*QUARANTINED \\(old clean removal pending`))
  await h.stop()
  const h2 = await startHelper(sc) // the start-up restore retries the removal
  assert.match(await status(h2.conn(1)), new RegExp(`${v1}: .*; free`))
  assert.ok(!stubVm(sc, v1).checkpoints.some(c => c.id === oldClean))
  await h2.stop()
})

test('crashes: a refresh begun (nothing taken) is abandoned at recovery; one selected but not retired is retired at recovery', async () => {
  const env = await pool('rcl-crash')
  const { sc, h, admin } = env
  const [v1, v2] = await vmNames(admin)
  await h.stop()
  const j = path.join(sc.stateDir, 'journal.jsonl')
  const vm1 = stubVm(sc, v1); const vm2 = stubVm(sc, v2)
  const c1 = vm1.checkpoints.find(c => c.name === 'clean').id
  const c2 = vm2.checkpoints.find(c => c.name === 'clean').id
  // v1: begun only. v2: taken and selected, with its new snapshot a child of the old clean, the old one not removed.
  sc.patchStub(st => { const v = Object.values(st.vms).find(x => x.name === v2); v.checkpoints.push({ id: 'new-clean-2', name: 'hvmcp-clean-bbbbbbbbbbbb', parentId: c2, disk: { ...v.disk } }) })
  fs.appendFileSync(j, [
    { t: 'rcl-begin', opId: 'aaaaaaaaaaaa', vmId: vm1.id, oldClean: c1, oldName: 'clean', snapName: 'hvmcp-clean-aaaaaaaaaaaa' },
    { t: 'rcl-begin', opId: 'bbbbbbbbbbbb', vmId: vm2.id, oldClean: c2, oldName: 'clean', snapName: 'hvmcp-clean-bbbbbbbbbbbb' },
    { t: 'rcl-taken', opId: 'bbbbbbbbbbbb', checkpointId: 'new-clean-2' },
    { t: 'rcl-select', opId: 'bbbbbbbbbbbb' }
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  const h2 = await startHelper(sc)
  const st = await status(h2.conn(1))
  assert.match(st, new RegExp(`${v1}: .*; free`))
  assert.match(st, new RegExp(`${v2}: .*; free`))
  assert.deepStrictEqual(stubVm(sc, v1).checkpoints.map(c => c.id), [c1], 'v1: the old clean kept')
  assert.deepStrictEqual(stubVm(sc, v2).checkpoints.map(c => c.id), ['new-clean-2'], 'v2: the old clean retired, the new one kept')
  assert.ok(sc.journal().some(r => r.t === 'rcl-abandoned' && r.opId === 'aaaaaaaaaaaa'))
  assert.ok(sc.journal().some(r => r.t === 'rcl-retired' && r.opId === 'bbbbbbbbbbbb'))
  await h2.stop()
})

test('a leased VM is skipped; while one VM is being refreshed it is never leased, and another VM is', async () => {
  const env = await pool('rcl-hold', 2)
  const { sc, h, admin } = env
  const [v1, v2] = await vmNames(admin)
  const a = h.conn(1)
  await a.request('acquire', { minutes: 30, vm: v1 })
  assert.match(await refresh(env, [v1]), /skipped \(leased, quarantined or busy/)
  await a.request('release')
  const entered = path.join(sc.dir, 'setup-entered'); const gate = path.join(sc.dir, 'setup-gate')
  sc.patchStub(st => { st.setupEntered = entered; st.setupGate = gate })
  const p = await req(admin, 'pool_plan', { action: 'refresh-clean', targets: [v1] })
  approve(sc, p.data.planId)
  await req(admin, 'pool_refresh', { planId: p.data.planId })
  await waitFor(async () => fs.existsSync(entered), 15_000, 'the refresh is in its guest steps')
  assert.match((await req(h.conn(2), 'acquire', { minutes: 30, vm: v1 })).text, /No VM for you now/, 'the refreshing VM is not leased')
  assert.match((await req(h.conn(3), 'acquire', { minutes: 30, vm: v2 })).text, new RegExp(`^Leased ${v2} `), 'another VM is')
  sc.patchStub(st => { st.setupGate = null; st.setupEntered = null })
  fs.writeFileSync(gate, 'open')
  await waitFor(async () => /Last pool job: refresh finished/.test(await status(admin)), 30_000, 'the job')
  assert.match(await jobLine(admin), /refreshed/)
  await h.stop()
})

test('an aged but eligible evaluation (30 days left) refreshes; a guest report claiming more days changes nothing; a second refresh is refused while one is unresolved', async () => {
  const sc = scratch('rcl-aged', { policy: { maxVms: 4 } })
  const { h } = await withPool(sc, 1)
  await h.stop()
  // The host's record: 30 days left.
  const j = path.join(sc.stateDir, 'journal.jsonl')
  const lines = fs.readFileSync(j, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const end = new Date(Date.now() + 30 * 86_400_000).toISOString()
  for (const r of lines) if (r.t === 'ready' && r.licence) r.licence.expiresAt = end
  fs.writeFileSync(j, lines.map(r => JSON.stringify(r)).join('\n') + '\n')
  const helper = await startHelper(sc)
  const env = { sc, h: helper, admin: helper.conn(99) }
  const [v1] = await vmNames(env.admin)
  // The guest claims far more time than the host recorded.
  sc.patchStub(st => { st.licence = { status: 1, graceMinutes: 200 * 1440 }; st.snapRemoveFail = 1 })
  const line = await refresh(env, [v1])
  assert.match(line, /refreshed .*but old clean removal pending/)
  assert.match(await status(env.admin), new RegExp(`${v1}: .*Windows evaluation, (29|30) days left \\(until ${end.slice(0, 10)}`), 'the host\'s end, unchanged')
  // Unresolved (its old clean not yet removed): a new refresh is refused at the plan.
  assert.match((await req(env.admin, 'pool_plan', { action: 'refresh-clean', targets: [v1] })).text, /has an unfinished refresh/)
  await helper.stop()
})

test('server.js: refresh-clean and pool_refresh are refused, before anything is sent, by a helper without the feature', async t => {
  const { server } = require('../client')
  const sc = scratch('rcl-feature', { policy: { maxVms: 3 } })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const shim = path.join(sc.dir, 'older-core.js')
  fs.writeFileSync(shim, `const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') return { text: 'hyperv-mcp/3', data: { protocol: 'hyperv-mcp/3', features: ['projects', 'images', 'named', 'checkpoints', 'pool-checkpoints'], buildRoots: [] } }
  if (op === 'pool_refresh' || (op === 'pool_plan' && args?.action === 'refresh-clean')) throw new Error('should not be sent')
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  assert.match((await s.call('pool_plan', { action: 'refresh-clean', targets: ['hvmcp-1'] })).text, /has no 'refresh-clean' feature/)
  assert.match((await s.call('pool_refresh', { planId: 'p-0123456789abcdef' })).text, /has no 'refresh-clean' feature/)
})
