// Pool checkpoints (MC-1532): a state one lease prepared, published by an approved plan (the logon undone and verified,
// the network disconnected, the guest shut down, checkpointed Off), that any project's lease then starts from by name;
// replace (the old one retiring, removed once no lease uses it) and remove, owner-only; acquire by checkpoint (with vm,
// os and image); failures that publish nothing and say what changed; a lease ending during the take; the cap; other
// VMs' leasing going on meanwhile. Through helper.js (the host protocol, several connections) against the stub.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { scratch, startHelper, withPool, approve, waitFor } = require('./helpers')

async function pool(name, n = 2, policy = {}) {
  const sc = scratch(name, { policy: { maxVms: 4, ...policy, projects: [{ name: 'cli', folders: [] }, { name: 'mcp', folders: [] }] } })
  const cli = path.join(sc.dir, 'cli')
  const mcp = path.join(sc.dir, 'mcp')
  fs.mkdirSync(cli, { recursive: true }); fs.mkdirSync(mcp, { recursive: true })
  // The projects' folders, now that the scratch dir exists.
  const pf = path.join(sc.stateDir, 'policy.json')
  const p = JSON.parse(fs.readFileSync(pf, 'utf8'))
  p.projects = [{ name: 'cli', folders: [cli] }, { name: 'mcp', folders: [mcp] }]
  fs.writeFileSync(pf, JSON.stringify(p))
  const { h } = await withPool(sc, n)
  await h.stop()
  const helper = await startHelper(sc, { HYPERV_MCP_WAIT_MS: '400', HYPERV_MCP_KEEP_MS: '60000' })
  return { sc, h: helper, cli, mcp, admin: helper.conn(99) }
}
const req = (c, op, args) => c.request(op, args).then(r => r, e => ({ error: e.message, text: e.message }))
const vmNames = async c => [...(await c.request('status')).text.matchAll(/^- (hvmcp-[0-9a-f]+):/gm)].map(m => m[1])
const stubVm = (sc, name) => Object.values(sc.stub().vms).find(v => v.name === name)
const exists = (sc, name, file) => stubVm(sc, name).disk[file] !== undefined

/** A lease of project cli on vm, started, with a file written. */
async function prepared(env, conn, vm, file = 'C:\\tools\\v1.txt') {
  const a = await req(conn, 'acquire', { minutes: 30, roots: [env.cli], vm })
  assert.match(a.text, new RegExp(`^Leased ${vm} `))
  await conn.request('start', {})
  await conn.request('run', { command: `write ${file} one` })
}
async function publish(env, conn, args) {
  const p = await req(conn, 'pool_plan', { action: 'checkpoint', roots: [env.cli], ...args })
  assert.ok(p.data?.planId, p.text)
  approve(env.sc, p.data.planId)
  return req(conn, 'pool_checkpoint', { planId: p.data.planId })
}

test('publish, then another project starts from it by name: the prepared file is there; clean on demand; release back to clean', async () => {
  const env = await pool('pcp-basic')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  const undosBefore = stubVm(sc, v1).undos || 0
  const r = await publish(env, a, { name: 'tools', targets: [v1] })
  assert.match(r.text, new RegExp(`- ${v1}: published "tools" \\(\\S+\\); the VM is Off at it, and this lease now starts from it`))
  const v = stubVm(sc, v1)
  assert.strictEqual(v.undos, undosBefore + 1, 'the logon undo ran')
  assert.strictEqual(v.switchName, null)
  assert.match((await admin.request('status')).text, new RegExp(`${v1}: .*starts from "tools"; pool checkpoints: "tools" \\(owner cli, windows, image \\w+, taken \\S+ from lease l-\\w+\\)`))
  await a.request('release')
  assert.strictEqual(stubVm(sc, v1).checkpoints.length, 2, 'clean and the published one stay')

  const b = h.conn(2)
  const got = await req(b, 'acquire', { minutes: 30, roots: [env.mcp], checkpoint: 'tools' })
  assert.match(got.text, new RegExp(`^Leased ${v1} .*It starts from the pool checkpoint "tools"`))
  assert.match((await b.request('start', {})).text, /^Started hvmcp-\w+ from its pool checkpoint "tools"/)
  assert.ok(exists(sc, v1, 'C:\\tools\\v1.txt'), 'the prepared file')
  assert.match((await b.request('start', { checkpoint: 'clean' })).text, /from its clean checkpoint/)
  assert.ok(!exists(sc, v1, 'C:\\tools\\v1.txt'), 'clean has no such file')
  await b.request('start', {}) // the lease's start point again
  assert.ok(exists(sc, v1, 'C:\\tools\\v1.txt'))
  await b.request('release')
  const after = stubVm(sc, v1)
  assert.strictEqual(after.parent, after.checkpoints.find(c => c.name === 'clean').id, 'released to clean')
  await h.stop()
})

test('binding and ownership: another project\'s lease can\'t be published; an ended lease publishes nothing; only the owner replaces or removes', async () => {
  const env = await pool('pcp-binding')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  assert.match((await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.mcp], name: 'x', targets: [v1] })).text, /is leased by project cli, not yours \(mcp\)/)
  const p = await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.cli], name: 'x', targets: [v1] })
  approve(sc, p.data.planId)
  await a.request('release')
  const late = await req(admin, 'pool_checkpoint', { planId: p.data.planId })
  assert.match(late.text, /FAILED: the lease the plan was made from has ended or changed: nothing was published/)
  assert.strictEqual(stubVm(sc, v1).checkpoints.length, 1)
  // Publish one as cli, then mcp may neither replace nor remove it.
  await prepared(env, a, v1)
  await publish(env, a, { name: 'x', targets: [v1] })
  await a.request('release')
  assert.match((await req(admin, 'pool_plan', { action: 'checkpoint-remove', roots: [env.mcp], name: 'x', targets: [v1] })).text, /"x" on hvmcp-\w+ belongs to project cli: only its owner removes it/)
  const b = h.conn(2)
  await req(b, 'acquire', { minutes: 30, roots: [env.mcp], checkpoint: 'x' })
  await b.request('start', {})
  assert.match((await req(b, 'pool_plan', { action: 'checkpoint', roots: [env.mcp], name: 'x', targets: [v1], replace: true })).text, /belongs to project cli: only its owner replaces it/)
  await h.stop()
})

test('failures publish nothing and say what changed: an undo that doesn\'t verify; a shutdown that fails (still running); a take that fails (started again, the prepared file kept)', async () => {
  const env = await pool('pcp-failures')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  await a.request('start', { interactive: 'admin' })
  await a.request('run', { command: 'write C:\\tools\\v1.txt one' })
  assert.match((await admin.request('status')).text, /the admin logged on interactively/)
  sc.patchStub(st => { st.undoOverride = { enableLUA: 0 } })
  let r = await publish(env, a, { name: 'x', targets: [v1] })
  assert.match(r.text, /FAILED: undoing a build logon didn't verify: EnableLUA is 0.*Nothing was published; its logon may be partly undone \(no interactive session from now/)
  assert.doesNotMatch((await admin.request('status')).text, /logged on interactively/, 'no interactive run after a partial undo')
  assert.match((await req(a, 'run', { command: 'whoami', session: 'interactive' })).text, /No one is logged on interactively/)
  sc.patchStub(st => { st.undoOverride = null; st.shutdownFails = true })
  r = await publish(env, a, { name: 'x', targets: [v1] })
  assert.match(r.text, /FAILED: the guest didn't shut down \(the VM is Running\)\. Nothing was published; its logon was undone and its network disconnected\. The VM is still running/)
  sc.patchStub(st => { st.shutdownFails = false; st.poolTakeFail = true })
  r = await publish(env, a, { name: 'x', targets: [v1] })
  assert.match(r.text, /FAILED: Hyper-V couldn't take the checkpoint .*Nothing was published; .*started again from its current disk \(no restore\), so what you prepared is still there/)
  assert.strictEqual(stubVm(sc, v1).state, 'Running')
  assert.ok(exists(sc, v1, 'C:\\tools\\v1.txt'), 'the prepared file survived')
  assert.doesNotMatch((await admin.request('status')).text, /pool checkpoints:/)
  await h.stop()
})

test('replace from its own lease: the old one stops being offered at once, stays for that lease, and is removed (merged into the new child) when the lease ends', async () => {
  const env = await pool('pcp-replace')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  await publish(env, a, { name: 'tools', targets: [v1] })
  await a.request('start', {}) // from "tools"
  await a.request('run', { command: 'write C:\\tools\\v2.txt two' })
  const old = Object.values(sc.stub().vms)[0].checkpoints.find(c => c.name.startsWith('hvmcp-pool-'))
  const r = await publish(env, a, { name: 'tools', targets: [v1], replace: true })
  assert.match(r.text, /published "tools" .*the old one is no longer offered and is removed when this lease ends/)
  assert.match((await admin.request('status')).text, /"tools" \(owner cli.*RETIRING: no longer offered\).*"tools" \(owner cli/)
  await a.request('release')
  const v = stubVm(sc, v1)
  assert.ok(!v.checkpoints.some(c => c.id === old.id), 'the old one removed')
  const kept = v.checkpoints.find(c => c.name.startsWith('hvmcp-pool-'))
  assert.ok(kept && kept.disk['C:\\tools\\v2.txt'] !== undefined, 'the new child kept, with v2')
  const b = h.conn(2)
  await req(b, 'acquire', { minutes: 30, roots: [env.mcp], checkpoint: 'tools' })
  await b.request('start', {})
  assert.ok(exists(sc, v1, 'C:\\tools\\v2.txt') && exists(sc, v1, 'C:\\tools\\v1.txt'))
  await h.stop()
})

test('remove: on a free VM it\'s retired and removed at once; on a leased VM the lease keeps using it and it goes when the lease ends; never offered meanwhile', async () => {
  const env = await pool('pcp-remove')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  await publish(env, a, { name: 'x', targets: [v1] })
  await a.request('release')
  // Leased by mcp from it, then cli removes it: retiring, the lease keeps it.
  const b = h.conn(2)
  await req(b, 'acquire', { minutes: 30, roots: [env.mcp], checkpoint: 'x' })
  const p = await req(admin, 'pool_plan', { action: 'checkpoint-remove', roots: [env.cli], name: 'x', targets: [v1] })
  approve(sc, p.data.planId)
  assert.match((await req(admin, 'pool_checkpoint', { planId: p.data.planId })).text, /retired: no longer offered; the lease holding hvmcp-\w+ keeps it until it ends/)
  assert.match((await b.request('start', {})).text, /from its pool checkpoint "x"/, 'pinned: still usable by this lease')
  assert.match((await req(h.conn(3), 'acquire', { minutes: 30, checkpoint: 'x' })).text, /No VM has a pool checkpoint "x"/)
  await b.request('release')
  assert.strictEqual(stubVm(sc, v1).checkpoints.length, 1, 'removed when the lease ended')
  await h.stop()
})

test('acquire by checkpoint: an unknown name, a vm that lacks it, a contradicting image are refused; a waiter for it gets it when it frees', async () => {
  const env = await pool('pcp-acquire', 2)
  const { h, admin } = env
  const [v1, v2] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  await publish(env, a, { name: 'tools', targets: [v1] })
  assert.match((await req(h.conn(2), 'acquire', { minutes: 30, checkpoint: 'nope' })).text, /No VM has a pool checkpoint "nope"/)
  assert.match((await req(h.conn(2), 'acquire', { minutes: 30, checkpoint: 'tools', vm: v2 })).text, new RegExp(`${v2} has no pool checkpoint "tools"`))
  assert.match((await req(h.conn(2), 'acquire', { minutes: 30, checkpoint: 'tools', image: 'cd'.repeat(32) })).text, /No verified image|No VM of image/)
  // v1 is leased: a waiter for "tools" waits (not given v2), then gets v1 when it's released.
  const w = h.conn(3)
  const pw = req(w, 'acquire', { minutes: 30, checkpoint: 'tools', wait: true })
  await waitFor(async () => /Waiting in line: 1\./.test((await admin.request('status')).text), 5000, 'waiting')
  await a.request('release')
  assert.match((await pw).text, new RegExp(`^Leased ${v1} .*starts from the pool checkpoint "tools"`))
  await h.stop()
})

test('a lease that ends during the take publishes nothing, and the take is removed; meanwhile another VM is leased without waiting', async () => {
  const env = await pool('pcp-cancel', 2)
  const { sc, h, admin } = env
  const [v1, v2] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  const p = await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.cli], name: 'x', targets: [v1] })
  approve(sc, p.data.planId)
  const entered = path.join(sc.dir, 'pool-take-entered')
  sc.patchStub(st => { st.poolTakeEntered = entered; st.poolTakeGate = path.join(sc.dir, 'never') })
  const run = req(admin, 'pool_checkpoint', { planId: p.data.planId })
  await waitFor(async () => fs.existsSync(entered), 10_000, 'the take has begun')
  // Another VM is leased meanwhile: the pool lock isn't held across the take.
  assert.match((await req(h.conn(2), 'acquire', { minutes: 30, vm: v2 })).text, new RegExp(`^Leased ${v2} `))
  await a.request('release')
  const r = await run
  assert.match(r.text, /FAILED: .*nothing was published/)
  assert.doesNotMatch((await admin.request('status')).text, /pool checkpoints:/)
  assert.strictEqual(stubVm(sc, v1).checkpoints.length, 1, 'only clean')
  await h.stop()
})

test('the cap: maxCheckpointsPerVm holds; the plan says why', async () => {
  const env = await pool('pcp-cap', 1, { maxCheckpointsPerVm: 1 })
  const { h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  await publish(env, a, { name: 'one', targets: [v1] })
  await a.request('start', { checkpoint: 'clean' })
  assert.match((await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.cli], name: 'two', targets: [v1] })).text, /would hold more than the policy's maxCheckpointsPerVm \(1\)/)
  await h.stop()
})

test('one plan, two VMs: each commits on its own; one whose lease ended fails and the other is published', async () => {
  const env = await pool('pcp-multi', 2)
  const { sc, h, admin } = env
  const [v1, v2] = await vmNames(admin)
  const a = h.conn(1); const b = h.conn(2)
  await prepared(env, a, v1)
  await prepared(env, b, v2)
  const p = await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.cli], name: 'tools', targets: [v1, v2] })
  approve(sc, p.data.planId)
  await b.request('release')
  const r = await req(admin, 'pool_checkpoint', { planId: p.data.planId })
  assert.match(r.text, new RegExp(`- ${v1}: published "tools"`))
  assert.match(r.text, new RegExp(`- ${v2}: FAILED: the lease the plan was made from has ended or changed`))
  await h.stop()
})

test('a lease checkpoint on top of a pool checkpoint: the release removes the lease\'s and keeps the published one; the evaluation end doesn\'t move', async () => {
  const env = await pool('pcp-tree')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  await publish(env, a, { name: 'tools', targets: [v1] })
  await a.request('release')
  const days = async () => /Windows evaluation, (\d+) days left \(until (\S+)\)/.exec((await admin.request('status')).text).slice(1)
  const before = await days()
  const b = h.conn(2)
  await req(b, 'acquire', { minutes: 30, roots: [env.mcp], checkpoint: 'tools' })
  await b.request('start', {})
  await b.request('checkpoint', { name: 'mine' })
  const tree = stubVm(sc, v1).checkpoints
  const pub = tree.find(c => c.name.startsWith('hvmcp-pool-'))
  assert.strictEqual(tree.find(c => c.name.startsWith('hvmcp-lease-')).parentId, pub.id, 'the lease checkpoint is a child of the published one')
  await b.request('release')
  const names = stubVm(sc, v1).checkpoints.map(c => c.name)
  assert.ok(names.includes('clean') && names.includes(pub.name) && !names.some(n => n.startsWith('hvmcp-lease-')))
  assert.deepStrictEqual(await days(), before)
  await h.stop()
})

test('crash boundaries: a take never published is removed at recovery; a published one survives a restart; a retired one is removed at recovery', async () => {
  const env = await pool('pcp-crash')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  await publish(env, a, { name: 'kept', targets: [v1] })
  await a.request('release')
  await h.stop()
  const vmId = stubVm(sc, v1).id
  const j = path.join(sc.stateDir, 'journal.jsonl')
  const keptId = sc.journal().find(r => r.t === 'pcp-select').checkpointId
  // A take journalled as a lease's (never selected), its snapshot made: and a retire of "kept" journalled, not removed.
  const opId = '0123456789ab'
  fs.appendFileSync(j, [{ t: 'lcp-take', opId, vmId, leaseId: 'l-dead', name: 'pool:x', snapName: `hvmcp-pool-${opId}`, at: new Date().toISOString() }, { t: 'lcp-taken', opId, checkpointId: 'snap-unpublished' }].map(r => JSON.stringify(r)).join('\n') + '\n')
  sc.patchStub(st => { const v = Object.values(st.vms).find(x => x.name === v1); v.checkpoints.push({ id: 'snap-unpublished', name: `hvmcp-pool-${opId}`, parentId: v.parent, disk: {} }) })
  let h2 = await startHelper(sc)
  let st = (await h2.conn(1).request('status')).text
  assert.ok(!stubVm(sc, v1).checkpoints.some(c => c.id === 'snap-unpublished'), 'the unpublished take removed')
  assert.match(st, /pool checkpoints: "kept"/, 'the published one survived the restart')
  await h2.stop()
  fs.appendFileSync(j, JSON.stringify({ t: 'pcp-retire', vmId, checkpointId: keptId }) + '\n')
  h2 = await startHelper(sc)
  st = (await h2.conn(1).request('status')).text
  assert.ok(!stubVm(sc, v1).checkpoints.some(c => c.id === keptId), 'the retired one removed at recovery')
  assert.doesNotMatch(st, /pool checkpoints:/)
  assert.ok(sc.journal().some(r => r.t === 'pcp-retired' && r.checkpointId === keptId))
  await h2.stop()
})

test('a name on Windows and Linux VMs: acquire without os is refused; with os it gets that kind', async () => {
  const env = await pool('pcp-mixed', 1, { maxMemoryMBTotal: 65536 })
  const { sc, h, admin } = env
  await h.stop()
  const L = 'ef'.repeat(32)
  const dir = path.join(sc.disks, 'images')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${L}.iso`), 'iso')
  fs.appendFileSync(path.join(sc.stateDir, 'journal.jsonl'), JSON.stringify({ t: 'image', sha256: L, size: 3, file: path.join(dir, `${L}.iso`), source: 'local', edition: 'EnterpriseEval', build: '26200.6584', pinned: true, os: 'linux', seq: 2001, at: new Date().toISOString() }) + '\n')
  const h2 = await startHelper(sc, { HYPERV_MCP_WAIT_MS: '400', HYPERV_MCP_KEEP_MS: '60000' })
  const ad = h2.conn(99)
  const plan = await ad.request('pool_plan', { action: 'resize', image: L, vms: 1 })
  approve(sc, plan.data.planId)
  await ad.request('pool_resize', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: resize finished/.test((await ad.request('status')).text), 15_000, 'the Linux VM')
  const stt = (await ad.request('status')).text
  const win = /^- (hvmcp-[0-9a-f]+): windows/m.exec(stt)[1]
  const lin = /^- (hvmcp-[0-9a-f]+): linux/m.exec(stt)[1]
  const a = h2.conn(1)
  await req(a, 'acquire', { minutes: 30, roots: [env.cli], vm: win })
  await a.request('start', {})
  const b = h2.conn(2)
  await req(b, 'acquire', { minutes: 30, roots: [env.cli], vm: lin })
  await b.request('start', {})
  const p = await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.cli], name: 'tools', targets: [win, lin] })
  approve(sc, p.data.planId)
  assert.doesNotMatch((await req(ad, 'pool_checkpoint', { planId: p.data.planId })).text, /FAILED/)
  await a.request('release'); await b.request('release')
  assert.match((await req(h2.conn(3), 'acquire', { minutes: 30, checkpoint: 'tools' })).text, /The pool checkpoint "tools" is on (windows and linux|linux and windows) VMs: give os to choose/)
  const c4 = h2.conn(4)
  assert.match((await req(c4, 'acquire', { minutes: 30, checkpoint: 'tools', os: 'linux' })).text, new RegExp(`^Leased ${lin} `))
  await c4.request('release')
  // An explicit Linux image with no os: the checkpoint's Linux VM (no premature Windows default); a contradicting os is refused.
  assert.match((await req(h2.conn(6), 'acquire', { minutes: 30, checkpoint: 'tools', image: L })).text, new RegExp(`^Leased ${lin} `))
  assert.match((await req(h2.conn(7), 'acquire', { minutes: 30, checkpoint: 'tools', image: L, os: 'windows' })).text, /is a linux image, not windows|No windows VM has a pool checkpoint/)
  await h2.stop()
  void admin
})

test('server.js: pool checkpoints are refused, before anything is sent, by a helper without the pool-checkpoints feature', async t => {
  const { server } = require('../client')
  const sc = scratch('pcp-feature', { policy: { maxVms: 3 } })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const shim = path.join(sc.dir, 'older-core.js')
  fs.writeFileSync(shim, `const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') return { text: 'hyperv-mcp/3', data: { protocol: 'hyperv-mcp/3', features: ['projects', 'images', 'named', 'checkpoints'], buildRoots: [] } }
  if (op === 'pool_checkpoint' || (op === 'pool_plan' && String(args?.action).startsWith('checkpoint')) || args?.checkpoint !== undefined) throw new Error('should not be sent')
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  assert.match((await s.call('pool_plan', { action: 'checkpoint', name: 'x', targets: ['hvmcp-1'] })).text, /has no 'pool-checkpoints' feature/)
  assert.match((await s.call('pool_checkpoint', { planId: 'p-0123456789abcdef' })).text, /has no 'pool-checkpoints' feature/)
  assert.match((await s.call('vm_acquire', { checkpoint: 'x' })).text, /has no 'pool-checkpoints' feature/)
})

test('stale plans: a second approved publish of the same name fails (nothing published twice); a replace whose target was retired meanwhile publishes nothing', async () => {
  const env = await pool('pcp-stale')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  const p1 = await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.cli], name: 'tools', targets: [v1] })
  const p2 = await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.cli], name: 'tools', targets: [v1] })
  approve(sc, p1.data.planId); approve(sc, p2.data.planId)
  assert.match((await req(admin, 'pool_checkpoint', { planId: p1.data.planId })).text, /published "tools"/)
  await a.request('start', {})
  assert.match((await req(admin, 'pool_checkpoint', { planId: p2.data.planId })).text, /FAILED: it already has a pool checkpoint "tools": nothing was published/)
  assert.strictEqual(sc.journal().filter(r => r.t === 'pcp-select').length, 1)
  // A replace held at its take, while a remove retires the target: nothing is published.
  const rp = await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.cli], name: 'tools', targets: [v1], replace: true })
  const rm = await req(admin, 'pool_plan', { action: 'checkpoint-remove', roots: [env.cli], name: 'tools', targets: [v1] })
  approve(sc, rp.data.planId); approve(sc, rm.data.planId)
  const entered = path.join(sc.dir, 'take-entered'); const gate = path.join(sc.dir, 'take-gate')
  sc.patchStub(st => { st.poolTakeEntered = entered; st.poolTakeGate = gate })
  const run = req(admin, 'pool_checkpoint', { planId: rp.data.planId })
  await waitFor(async () => fs.existsSync(entered), 10_000, 'the replace is at its take')
  assert.match((await req(h.conn(5), 'pool_checkpoint', { planId: rm.data.planId })).text, /retired/)
  fs.writeFileSync(gate, 'open')
  assert.match((await run).text, /FAILED: the checkpoint to replace has changed: nothing was published/)
  assert.strictEqual(sc.journal().filter(r => r.t === 'pcp-select').length, 1, 'no second publish')
  await h.stop()
})

test('the disk floor at execution: a plan made with room, run after the drive filled, changes nothing and takes nothing', async () => {
  const env = await pool('pcp-disk')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  const p = await req(a, 'pool_plan', { action: 'checkpoint', roots: [env.cli], name: 'x', targets: [v1] })
  approve(sc, p.data.planId)
  const undos = stubVm(sc, v1).undos || 0
  sc.patchStub(st => { st.freeGB = 5 })
  const r = await req(admin, 'pool_checkpoint', { planId: p.data.planId })
  assert.match(r.text, /FAILED: the VM folder's drive has 5 GB free, under the 20 GB a checkpoint must leave\. Nothing was published; nothing changed\. The VM is still running/)
  assert.strictEqual(stubVm(sc, v1).undos || 0, undos, 'no undo')
  assert.strictEqual(stubVm(sc, v1).checkpoints.length, 1, 'no take')
  await h.stop()
})

test('a take that fails, then a restart whose guest doesn\'t answer: no runs, and the reply says the VM is Running (never claimed Off)', async () => {
  const env = await pool('pcp-restart')
  const { sc, h, admin } = env
  const [v1] = await vmNames(admin)
  const a = h.conn(1)
  await prepared(env, a, v1)
  sc.patchStub(st => { st.poolTakeFail = true; st.notReady = true })
  const r = await publish(env, a, { name: 'x', targets: [v1] })
  assert.match(r.text, /FAILED: Hyper-V couldn't take the checkpoint .*Starting it again failed \(its guest didn't answer\): the VM is Running; no runs until vm_start or vm_reset/)
  assert.match((await req(a, 'run', { command: 'whoami' })).text, /The VM is not running/)
  await h.stop()
})
