// vm_acquire({ vm }), one VM by name (MC-1523): for trials and censuses on a specific VM. The request becomes that VM's
// own OS and image (an os or image given as well must agree); it keeps MC-1502's caps, allowlists and line: refused at
// once when the project may never have it, refused with that VM's state when it isn't free, and with wait: true it
// stands in line for that VM only, an earlier waiter still served first. Through helper.js against the stub Hyper-V,
// a bare Helper for the states a stub pool can't easily reach, and server.js for the feature gate.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { T, scratch, startHelper, withPool, approve, waitFor } = require('./helpers')
const { server } = require('../client')
Object.assign(process.env, require('./helpers').T.profile('queueBare')) // the in-process (bare) helper's bounded wait; started helpers get their own env
const { Helper } = require('../helper/core')

const A = 'ab'.repeat(32) // seeded by withPool: Windows
const L = 'ef'.repeat(32) // a stub "linux" image
const SLOW = T.profile('queueSlow')

function addImages(sc, list) {
  const dir = path.join(sc.disks, 'images')
  fs.mkdirSync(dir, { recursive: true })
  for (const [sha256, os, seq] of list) {
    const file = path.join(dir, `${sha256}.iso`)
    fs.writeFileSync(file, 'iso')
    fs.appendFileSync(path.join(sc.stateDir, 'journal.jsonl'), JSON.stringify({ t: 'image', sha256, size: 3, file, source: 'local', edition: 'EnterpriseEval', build: '26200.6584', pinned: true, os, seq, at: new Date().toISOString() }) + '\n')
  }
}

async function change(sc, admin, args) {
  const plan = await admin.request('pool_plan', args)
  assert.ok(plan.data?.planId, plan.text)
  approve(sc, plan.data.planId)
  await admin.request(`pool_${args.action}`, { planId: plan.data.planId })
  await waitFor(async () => {
    const st = (await admin.request('status')).text
    if (/Last pool job: \w+ FAILED/.test(st)) throw new Error(`the pool job failed: ${st}`)
    return !/Pool job in progress/.test(st) && /Last pool job: \w+ finished/.test(st)
  }, 15_000, 'the pool job')
}

async function pool(name, n, policy = {}, env = SLOW) {
  const sc = scratch(name, { policy: { maxVms: 6, maxMemoryMBTotal: 65536, ...policy } })
  for (const d of ['cli', 'mcp']) fs.mkdirSync(path.join(sc.dir, d), { recursive: true })
  const { h } = await withPool(sc, n)
  await h.stop()
  const helper = await startHelper(sc, env)
  return { sc, h: helper, admin: helper.conn(99), dir: d => path.join(sc.dir, d) }
}
const status = async c => (await c.request('status')).text
const acquire = (c, args) => c.request('acquire', { minutes: 30, ...args }).then(r => r, e => ({ error: e.message }))
const names = st => [...st.matchAll(/^- (hvmcp-[0-9a-f]+):/gm)].map(m => m[1])

test('named: leases that VM, not the one the pool would pick; an unknown name or a leased one is refused, saying why', async () => {
  const { h, admin } = await pool('nm-basic', 3)
  const [first, , last] = names(await status(admin))
  const [a, b, c] = [h.conn(1), h.conn(2), h.conn(3)]
  const r = await acquire(a, { vm: last })
  assert.match(r.text, new RegExp(`^Leased ${last} \\(lease l-\\w+\\)`))
  assert.strictEqual(r.data.vm, last)
  assert.match((await acquire(b, { vm: 'hvmcp-00000000' })).error, /^No VM named hvmcp-00000000 in the pool \(vm_status lists them\)\./)
  assert.match((await acquire(b, { vm: last })).error, new RegExp(`^No VM for you now: ${last} is leased until \\S+Z \\(3 in the pool\\)\\. .*wait: true to wait in line`))
  assert.match((await acquire(b, { vm: 42 })).error, /vm must be a VM name from vm_status/)
  // Unnamed acquires are unchanged: the pool's own pick.
  assert.match((await acquire(c, {})).text, new RegExp(`^Leased ${first} `))
  assert.match(await status(admin), /vm_acquire's vm names one VM: for trials and censuses on a specific VM, not for normal use/)
  await h.stop()
})

test('named, wait: true: stands in line for that VM only; the release grants it; an earlier unnamed waiter is served first', async () => {
  const { h, admin } = await pool('nm-wait', 2)
  const [v1, v2] = names(await status(admin))
  const [a, b, w, n] = [h.conn(1), h.conn(2), h.conn(3), h.conn(4)]
  await acquire(a, { vm: v1 })
  await acquire(b, { vm: v2 })
  const pw = acquire(w, { wait: true }) // unnamed, first in line
  await waitFor(async () => /Waiting in line: 1\. other/.test(await status(admin)), T.waitForMs, 'w in line')
  const pn = acquire(n, { vm: v1, wait: true })
  await waitFor(async () => new RegExp(`Waiting in line: 1\\. other, .*; 2\\. other \\(for ${v1}\\)`).test(await status(admin)), T.waitForMs, 'n in line')
  await a.request('release') // v1 is free: w was first, so w gets it
  assert.match((await pw).text, new RegExp(`^Leased ${v1} `))
  await w.request('release') // v1 free again: now the named waiter's
  assert.match((await pn).text, new RegExp(`^Leased ${v1} `))
  await h.stop()
})

test('named, wait: true: blocked on its VM, it keeps its place while a later unnamed waiter gets another free VM; it never falls back', async () => {
  const { h, admin } = await pool('nm-pass', 2)
  const [v1, v2] = names(await status(admin))
  const [a, b, n, u] = [h.conn(1), h.conn(2), h.conn(3), h.conn(4)]
  await acquire(a, { vm: v1 })
  await acquire(b, { vm: v2 })
  const pn = acquire(n, { vm: v1, wait: true })
  await waitFor(async () => new RegExp(`1\\. other \\(for ${v1}\\)`).test(await status(admin)), T.waitForMs, 'n in line')
  const pu = acquire(u, { wait: true })
  await waitFor(async () => /2\. other, /.test(await status(admin)), T.waitForMs, 'u in line')
  await b.request('release') // v2 free: not n's; u is served past it
  assert.match((await pu).text, new RegExp(`^Leased ${v2} `))
  const rn = await pn
  assert.match(rn.text, new RegExp(`^Still waiting for a VM \\(${v1} is leased until \\S+\\): number 1 of 1 in line`))
  await h.stop()
})

test('named, with projects: the cap still applies; a legacy VM is refused at once to a project with an image list (wait: true, no queue entry)', async () => {
  const sc0 = scratch('nm-proj-setup')
  const cli = path.join(sc0.dir, 'cli')
  const mcp = path.join(sc0.dir, 'mcp')
  for (const d of [cli, mcp]) fs.mkdirSync(d, { recursive: true })
  const projects = [{ name: 'cli', folders: [cli], maxVms: 1 }, { name: 'mcp', folders: [mcp], images: [A] }]
  const { sc, h, admin } = await pool('nm-proj', 2, { projects })
  const [v1, v2] = names(await status(admin))
  const [c1, c2] = [h.conn(1), h.conn(2)]
  await acquire(c1, { roots: [cli], vm: v1 })
  assert.match((await acquire(c2, { roots: [cli], vm: v2 })).error, /^No VM for you now: project cli holds its windows cap of 1/)
  await h.stop()
  // Make the VMs legacy: no image on the intents, and the create's plan file gone.
  const file = path.join(sc.stateDir, 'journal.jsonl')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  for (const r of lines) if (r.t === 'intent') delete r.image
  fs.writeFileSync(file, lines.map(r => JSON.stringify(r)).join('\n') + '\n')
  fs.rmSync(path.join(sc.stateDir, 'plans', `${lines.find(r => r.t === 'job' && r.op === 'create').planId}.json`))
  const h2 = await startHelper(sc, SLOW)
  const [m1, o1, a2] = [h2.conn(1), h2.conn(2), h2.conn(98)]
  // A queued wait would answer "Still waiting…" (or be superseded), never this refusal; and no entry is left in line.
  const r = await acquire(m1, { roots: [mcp], vm: v2, wait: true })
  assert.match(r.error, new RegExp(`^No VM for you: project mcp may not use ${v2}: its image is unknown \\(made before images were recorded\\)`))
  assert.doesNotMatch(await status(a2), /Waiting in line/)
  // A project with no image list (other) may still name a legacy VM.
  assert.match((await acquire(o1, { vm: v2 })).text, new RegExp(`^Leased ${v2} `))
  await h2.stop()
})

test('named: the VM\'s own OS when os is left out; an explicit os or image that contradicts it is refused; plain acquires stay Windows', async () => {
  const { sc, h, admin } = await pool('nm-os', 1)
  await h.stop()
  addImages(sc, [[L, 'linux', 2001]])
  const h2 = await startHelper(sc, SLOW)
  const a2 = h2.conn(98)
  await change(sc, a2, { action: 'resize', image: L, vms: 1 })
  const st = await status(a2)
  const win = st.match(/^- (hvmcp-[0-9a-f]+): windows/m)[1]
  const lin = st.match(/^- (hvmcp-[0-9a-f]+): linux/m)[1]
  const [c1, c2, c3, c4] = [h2.conn(1), h2.conn(2), h2.conn(3), h2.conn(4)]
  assert.match((await acquire(c1, { vm: lin, os: 'windows' })).error, new RegExp(`^${lin} is a linux VM, not windows\\.`))
  assert.match((await acquire(c1, { vm: lin, image: A })).error, new RegExp(`^${lin} wasn't built from image abababababab \\(its image is efefefefefef\\)\\.`))
  assert.match((await acquire(c1, { vm: win, os: 'linux' })).error, new RegExp(`^${win} is a windows VM, not linux\\.`))
  const r = await acquire(c1, { vm: lin })
  assert.match(r.text, new RegExp(`^Leased ${lin} .*\\(linux, image efefefefefef\\)`))
  assert.strictEqual(r.data.os, 'linux')
  assert.match((await acquire(c2, { vm: win, os: 'windows', image: A.slice(0, 12) })).text, new RegExp(`^Leased ${win} `))
  await c2.request('release')
  const plain = await acquire(c3, {})
  assert.match(plain.text, new RegExp(`^Leased ${win} `), 'no selector: Windows, as before')
  assert.strictEqual(plain.data.os, 'windows')
  assert.match((await acquire(c4, {})).error, /^No VM is free/, 'never the Linux VM for a plain acquire')
  await h2.stop()
  void admin
})

// The named VM's states that a stub pool doesn't reach on demand: blocked() says each one, and never throws, also once
// the VM has left the pool while a request waits for it.
test('named VM states (bare helper): quarantined, being created, being removed, in its evaluation\'s last hour, gone', () => {
  const h = Object.create(Helper.prototype)
  const now = Date.parse('2026-11-15T12:00:00Z')
  const vm = { vmId: 'v1', vmName: 'hvmcp-11111111', intentId: 'i1', ready: true }
  h.now = () => now
  h.policy = { projects: [] }
  h.leases = new Map()
  h.pcpBusy = new Set()
  h.refreshing = new Set()
  h.startFailed = new Map()
  const state = { vms: new Map([['v1', vm]]), quarantined: new Map(), intents: new Map([['i1', { image: A }]]), images: new Map([[A, { sha256: A, os: 'windows' }]]), jobs: new Map(), leaseSnaps: new Map(), poolSnaps: new Map(), refreshes: new Map() }
  h.journal = { state: () => state }
  const want = { os: 'windows', image: A, vm: vm.vmName, vmImage: A }
  assert.strictEqual(h.blocked('other', want), null)
  state.quarantined.set('v1', 'its restore failed')
  assert.strictEqual(h.blocked('other', want), 'hvmcp-11111111 is quarantined (its restore failed)')
  state.quarantined.clear()
  vm.ready = false
  assert.strictEqual(h.blocked('other', want), 'hvmcp-11111111 is being created')
  vm.ready = true; vm.removing = true
  assert.strictEqual(h.blocked('other', want), 'hvmcp-11111111 is being removed')
  vm.removing = false; vm.licence = { kind: 'evaluation', expiresAt: new Date(now + 30 * 60_000).toISOString() }
  assert.strictEqual(h.blocked('other', want), 'hvmcp-11111111 is in its Windows evaluation\'s last hour')
  state.vms.clear()
  assert.strictEqual(h.blocked('other', want), 'hvmcp-11111111 is no longer in the pool')
})

/** A bare helper running core.js's own acquire, queue and drain on one VM, with no ready VM unless set. */
function bare() {
  const h = Object.create(Helper.prototype)
  const vm = { vmId: 'v1', vmName: 'hvmcp-22222222', intentId: 'i1', ready: false, cores: 2, memoryMB: 4096, diskGB: 64 }
  const state = { vms: new Map([['v1', vm]]), quarantined: new Map(), intents: new Map([['i1', { image: A }]]), images: new Map([[A, { sha256: A, os: 'windows' }]]), jobs: new Map(), leaseSnaps: new Map(), poolSnaps: new Map(), refreshes: new Map() }
  h.journal = { state: () => state }
  h.now = () => Date.now()
  h.policy = { projects: [], maxLeaseMinutes: 240, buildRoots: [] }
  Object.assign(h, { leases: new Map(), startFailed: new Map(), conns: new Map([[1, { pid: 1 }], [2, { pid: 2 }]]), queue: [], tokens: 0, timers: new Set(), quiesced: null, pcpBusy: new Set(), refreshing: new Set() })
  h.poolLock = fn => fn()
  h.armDeadline = () => {}
  return { h, vm, state }
}

test('named, acquire path (bare helper): a sole VM still being created is refused with that state, not "no VMs yet"; waited for, then granted', async () => {
  const { h, vm } = bare()
  await assert.rejects(h.acquire(1, { minutes: 30 }), /The pool has no VMs yet/, 'unnamed: the guard stays')
  await assert.rejects(h.acquire(1, { minutes: 30, vm: 'hvmcp-99999999' }), /^Error: No VM named hvmcp-99999999 in the pool/)
  await assert.rejects(h.acquire(1, { minutes: 30, vm: vm.vmName }), /^Error: No VM for you now: hvmcp-22222222 is being created \(1 in the pool\)/)
  const p = h.acquire(1, { minutes: 30, vm: vm.vmName, wait: true })
  await new Promise(r => setImmediate(r))
  assert.strictEqual(h.queue.length, 1, 'in line')
  assert.ok(h.queue[0].pending, 'waiting now')
  assert.strictEqual(h.queue[0].want.vm, vm.vmName)
  vm.ready = true
  h.drain() // the create finished
  const r = await p
  assert.match(r.text, /^Leased hvmcp-22222222 /)
  assert.strictEqual(h.queue.length, 0)
})

test('named, acquire path (bare helper): the waited-for VM leaves the pool: the wait says so, drain never throws, nothing else is leased', async () => {
  const { h, vm, state } = bare()
  const other = { ...vm, vmId: 'v2', vmName: 'hvmcp-33333333', intentId: 'i1', ready: true }
  const p = h.acquire(1, { minutes: 30, vm: vm.vmName, wait: true })
  await new Promise(r => setImmediate(r))
  assert.strictEqual(h.queue.length, 1)
  state.vms.delete('v1')
  state.vms.set('v2', other) // another VM comes free meanwhile
  assert.doesNotThrow(() => h.drain())
  const r = await p // the bounded wait (200 ms here) ends without a VM
  assert.match(r.text, /^Still waiting for a VM \(hvmcp-22222222 is no longer in the pool\): number 1 of 1 in line/)
  assert.strictEqual(h.leases.size, 0, 'never fell back to hvmcp-33333333')
})

test('server.js: vm is refused before anything is sent to a helper without the named feature', async t => {
  const sc = scratch('nm-feature', { policy: { maxVms: 3 } })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const count = path.join(sc.dir, 'acquires.jsonl')
  const shim = path.join(sc.dir, 'older-core.js')
  fs.writeFileSync(shim, `const fs = require('fs')
const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') return { text: 'hyperv-mcp/3', data: { protocol: 'hyperv-mcp/3', features: ['projects', 'images'], buildRoots: [] } }
  if (op === 'acquire') fs.appendFileSync(${JSON.stringify(count)}, JSON.stringify(args) + '\\n')
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  assert.match((await s.call('vm_acquire', { vm: 'hvmcp-12345678' })).text, /The helper \(hyperv-mcp\/3\) has no 'named' feature, which asking for a VM by name \(vm\) needs: run setup again/)
  assert.ok(!fs.existsSync(count), 'no acquire reached the helper')
  assert.match((await s.call('vm_acquire', {})).text, /^Leased /, 'a plain acquire, as before')
  const sent = fs.readFileSync(count, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(!('vm' in sent[0]), 'no vm sent')
})
