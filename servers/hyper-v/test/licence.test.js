// Windows licences (MC-1513), through helper.js against the stub Hyper-V: an evaluation image is activated online once
// as each VM is built (the plan binds it), through the Default Switch for that step only, disconnected before the
// clean checkpoint, and cleaned up when the step fails (net-off, then the rollback; recovery and the retry when those
// fail); its end is recorded from the guest's figures, kept across restarts, starts and resets, and bounds leases; an
// own copy (a non-evaluation image) builds with its bound edition and the pool's product key, written only into the
// answer file, and is activated only when its plan says so.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { T, scratch, startHelper, approve, seedImage, waitFor, withPool } = require('./helpers')

const KEY = 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY'
const vms = sc => Object.values(sc.stub().vms)
const calls = (sc, op) => sc.stub().calls.filter(c => c.op === op)
const status = async c => (await c.request('status')).text

/** A second verified image: a non-evaluation edition at index 2 of its ISO. */
function seedOwn(sc) {
  const dir = path.join(sc.disks, 'images')
  fs.mkdirSync(dir, { recursive: true })
  const sha256 = 'cd'.repeat(32)
  const file = path.join(dir, `${sha256}.iso`)
  fs.writeFileSync(file, 'iso')
  fs.appendFileSync(path.join(sc.stateDir, 'journal.jsonl'), JSON.stringify({ t: 'image', sha256, size: 3, file, source: 'local', edition: 'Professional', build: '26200.6584', imageIndex: 2, evaluation: false, pinned: false, seq: 1001, at: new Date().toISOString() }) + '\n')
  return sha256
}

/** A helper with a seeded evaluation image (and an own one), not yet a pool. */
async function bare(sc, { own = false, extraEnv } = {}) {
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  const ownSha = own ? seedOwn(sc) : null
  h = await startHelper(sc, extraEnv)
  return { h, admin: h.conn(1), ownSha }
}

/** Plans, approves and runs a create; resolves the job's status line. */
async function create(sc, admin, args) {
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, ...args })
  approve(sc, plan.data.planId)
  await admin.request('pool_create', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: create (finished|FAILED)/.test(await status(admin)), T.waitForMs, 'the pool job')
  return { plan, line: (await status(admin)).split('\n').find(l => l.startsWith('Last pool job')) }
}

test('an evaluation build goes online once (journalled), is disconnected before its checkpoint, and records its end; starts never use that switch', async t => {
  const sc = scratch('lic-eval')
  const { h, admin } = await bare(sc)
  t.after(() => h.stop())
  const { plan, line } = await create(sc, admin, {})
  assert.match(plan.text, /- activation: each new VM goes online once, through Windows' Default Switch, to activate Windows; it is disconnected \(verified\) before its clean checkpoint/)
  assert.doesNotMatch(plan.text, /product key/)
  assert.match(line, /create finished/)
  const j = sc.journal()
  const i = j.findIndex(r => r.t === 'online'); const o = j.findIndex(r => r.t === 'offline'); const r = j.find(x => x.t === 'ready')
  assert.ok(i > 0 && o > i && j.indexOf(r) > o, 'online, offline, then ready')
  assert.strictEqual(r.licence.kind, 'evaluation')
  const left = (Date.parse(r.licence.expiresAt) - Date.now()) / 86_400_000
  assert.ok(left > 89.9 && left <= 90, `about 90 days (${left})`)
  assert.match(await status(admin), /; Windows evaluation, 89 days left \(until \d{4}-\d\d-\d\d\)/)
  // A start (and a reset) never touches the Default Switch, and doesn't change the recorded end.
  const c = h.conn(10)
  await c.request('acquire', { minutes: 30 })
  await c.request('start')
  await c.request('start')
  assert.strictEqual(vms(sc)[0].onlineCount, 1)
  assert.strictEqual(calls(sc, 'guest-activate').length, 1)
  assert.strictEqual(sc.journal().filter(x => x.t === 'ready').length, 1)
  await h.stop()
  const h2 = await startHelper(sc)
  t.after(() => h2.stop())
  const again = sc.journal().find(x => x.t === 'ready')
  assert.strictEqual(again.licence.expiresAt, r.licence.expiresAt, 'kept across a restart')
  assert.match(await status(h2.conn(1)), new RegExp(`until ${r.licence.expiresAt.slice(0, 10)}`))
})

test('activation failing: net-off before the rollback; the VM is never left online; a short period or no disconnection fails too', async t => {
  const sc = scratch('lic-fail', { stub: { activateDies: true } })
  const { h, admin } = await bare(sc)
  t.after(() => h.stop())
  const { line } = await create(sc, admin, {})
  assert.match(line, /FAILED: VM 1 of 1 \(hvmcp-[0-9a-f]+\): activating Windows online failed: .*the activation call died/)
  const order = sc.stub().calls.map(c => c.op).filter(op => ['guest-activate', 'net-off', 'remove-vm'].includes(op))
  assert.deepStrictEqual(order, ['guest-activate', 'net-off', 'remove-vm'])
  assert.deepStrictEqual(vms(sc), [])
  assert.deepStrictEqual(sc.journal().filter(r => ['online', 'offline', 'rolledBack'].includes(r.t)).map(r => r.t), ['online', 'offline', 'rolledBack'])
  // A period under 85 days fails the build; so does an adapter that can't be confirmed disconnected.
  sc.patchStub(s => { s.activateDies = false; s.activation = { graceMinutes: 80 * 1440 } })
  assert.match((await create(sc, admin, {})).line, /the evaluation activated with only 80 day\(s\) left \(at least 85 needed\)/)
  sc.patchStub(s => { s.activation = null; s.activateStaysConnected = true })
  assert.match((await create(sc, admin, {})).line, /could not be confirmed disconnected after activating Windows/)
  assert.deepStrictEqual(vms(sc), [])
  assert.doesNotMatch(await status(admin), /may still be online/)
})

test('activation failing and its cleanup failing: the build stays journalled online, is flagged, and recovery at the next start takes it off and removes it', async t => {
  const sc = scratch('lic-recover', { stub: { activateDies: true, fail: { 'net-off': 1, 'remove-vm': 1 } } })
  const { h, admin } = await bare(sc)
  const { line } = await create(sc, admin, {})
  assert.match(line, /FAILED/)
  assert.strictEqual(vms(sc).length, 1, 'still there')
  assert.match(await status(admin), /WARNING: hvmcp-[0-9a-f]+ may still be online \(its build's activation step didn't finish\)/)
  await h.stop()
  const h2 = await startHelper(sc)
  t.after(() => h2.stop())
  assert.deepStrictEqual(vms(sc), [])
  assert.match(await status(h2.conn(1)), /Rolled back the unfinished VM/)
  assert.doesNotMatch(await status(h2.conn(1)), /may still be online/)
  assert.deepStrictEqual(sc.journal().filter(r => ['online', 'offline', 'rolledBack'].includes(r.t)).map(r => r.t), ['online', 'offline', 'rolledBack'])
})

test('a build left online is also retried every few minutes, without a restart', async t => {
  const sc = scratch('lic-retry', { stub: { activateDies: true, fail: { 'net-off': 1, 'remove-vm': 1 } } })
  const { h, admin } = await bare(sc, { extraEnv: T.profile('retryLicence') })
  t.after(() => h.stop())
  await create(sc, admin, {})
  await waitFor(async () => !vms(sc).length && !/may still be online/.test(await status(admin)), T.waitForMs, 'the retry')
  assert.strictEqual(calls(sc, 'net-off').length, 2, 'net-off tried again')
})

test('no Default Switch: an evaluation create is refused; an own copy builds offline (activate refused without it)', async t => {
  const sc = scratch('lic-noswitch', { stub: { noDefaultSwitch: true, guestEdition: 'Professional' } })
  const { h, admin, ownSha } = await bare(sc, { own: true })
  t.after(() => h.stop())
  await assert.rejects(admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, image: 'ab'.repeat(32) }), /no Default Switch.*an evaluation image needs that/)
  await assert.rejects(admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, image: 'ab'.repeat(32), activate: false }), /must be activated online once/)
  await assert.rejects(admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, image: ownSha, activate: true }), /no Default Switch/)
  const { plan, line } = await create(sc, admin, { image: ownSha })
  assert.match(plan.text, /- image: Professional \(index 2\)/)
  assert.match(plan.text, /- activation: none \(each new VM stays offline; its licence is read and shown\)/)
  assert.match(plan.text, /- product key: none/)
  assert.match(line, /create finished/)
  assert.strictEqual(calls(sc, 'guest-activate').length, 0)
  assert.strictEqual(calls(sc, 'guest-licence').length, 1)
  assert.match(sc.stub().answers.at(-1), /<Key>\/IMAGE\/INDEX<\/Key><Value>2<\/Value>/)
  assert.match(await status(admin), /; own copy of Windows, activated/)
})

test('an own copy with the pool\'s product key: the key only in the answer file; activated online when its plan says so; never in a reply, plan, journal or log', async t => {
  const sc = scratch('lic-key', { stub: { guestEdition: 'Professional', activation: { status: 1, graceMinutes: 0 } } })
  const { h, admin, ownSha } = await bare(sc, { own: true })
  t.after(() => h.stop())
  fs.writeFileSync(path.join(sc.stateDir, 'secrets', 'product-key.json'), JSON.stringify({ key: KEY }))
  assert.match(await status(admin), /Product key for non-evaluation images \(install\.ps1 -ProductKeyFile\): set\./)
  const { plan, line } = await create(sc, admin, { image: ownSha, activate: true })
  assert.match(plan.text, /- product key: the pool's \(set by install\.ps1 -ProductKeyFile\), written only into the answer file/)
  assert.match(plan.text, /- activation: each new VM goes online once/)
  assert.match(line, /create finished/)
  assert.strictEqual(calls(sc, 'guest-activate').length, 1)
  assert.match(sc.stub().answers.at(-1), new RegExp(`<settings pass="specialize">[\\s\\S]*name="Microsoft-Windows-Shell-Setup"[\\s\\S]*<ProductKey>${KEY}</ProductKey>[\\s\\S]*<settings pass="oobeSystem">`))
  assert.match(await status(admin), /; own copy of Windows, activated/)
  // Nowhere else: not in replies, the plans, the journal, the helper's log, or the calls the stub saw.
  const everything = [plan.text, line, await status(admin), JSON.stringify(sc.stub().calls)]
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (e.name === 'secrets' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])
  for (const f of walk(sc.stateDir)) everything.push(fs.readFileSync(f, 'utf8'))
  for (const f of walk(sc.disks)) everything.push(fs.readFileSync(f, 'latin1'))
  for (const x of everything) assert.ok(!x.includes(KEY), 'the key leaked')
  // An evaluation plan never carries the key, even when one is set.
  const evalPlan = await admin.request('pool_plan', { action: 'resize', vms: 2, image: 'ab'.repeat(32) })
  assert.doesNotMatch(evalPlan.text, /product key/)
})

test('a plan that doesn\'t activate its evaluation image (made before activation) is refused at apply', async t => {
  const sc = scratch('lic-oldplan')
  const { h, admin } = await bare(sc)
  t.after(() => h.stop())
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  const file = path.join(sc.stateDir, 'plans', `${plan.data.planId}.json`)
  const p = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete p.activation
  fs.writeFileSync(file, JSON.stringify(p))
  approve(sc, plan.data.planId)
  await assert.rejects(admin.request('pool_create', { planId: plan.data.planId }), /doesn't activate its evaluation image .*make a new plan/)
  assert.deepStrictEqual(vms(sc), [])
})

/** Rewrites the ready record's evaluation end (as if that much time had passed), then restarts the helper. */
async function endsIn(sc, h, ms) {
  await h.stop()
  const file = path.join(sc.stateDir, 'journal.jsonl')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  for (const r of lines) if (r.t === 'ready') r.licence = { kind: 'evaluation', expiresAt: new Date(Date.now() + ms).toISOString() }
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return startHelper(sc)
}

test('an evaluation near its end: leases and renewals are capped at it; within its last hour it is never leased', async t => {
  const sc = scratch('lic-end')
  const { h } = await withPool(sc, 1)
  let h2 = await endsIn(sc, h, 3 * 3600_000)
  const c = h2.conn(10)
  const r = await c.request('acquire', { minutes: 240 })
  const end = Date.parse(sc.journal().find(x => x.t === 'ready').licence.expiresAt)
  assert.ok(r.data.deadline <= end && r.data.sessionEnd === end, 'capped at the evaluation\'s end')
  assert.match(r.text, /vm_renew can extend it up to \S+ \(its Windows evaluation's end\)/)
  await assert.rejects(c.request('renew', { minutes: 240 }), /past this work session's end, .*'s Windows evaluation ends then\): at most \d+ minutes now/)
  await c.request('release')
  h2 = await endsIn(sc, h2, 30 * 60_000)
  t.after(() => h2.stop())
  const d = h2.conn(11)
  await assert.rejects(d.request('acquire'), /No VM is free/)
  assert.match(await status(h2.conn(1)), /evaluation ends \S+: it is no longer leased; the pool needs a rebuild/)
})

test('a VM built before licences were recorded shows its licence as unknown, and is still leased', async t => {
  const sc = scratch('lic-legacy')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const file = path.join(sc.stateDir, 'journal.jsonl')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  for (const r of lines) if (r.t === 'ready') delete r.licence
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  const h2 = await startHelper(sc)
  t.after(() => h2.stop())
  assert.match(await status(h2.conn(1)), /; licence unknown \(built before Windows activation was recorded/)
  assert.ok((await h2.conn(10).request('acquire')).data.vm)
})
