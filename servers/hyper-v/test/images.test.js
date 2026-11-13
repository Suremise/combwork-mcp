// A pool built from more than one image (MC-1502, gap 3; Darren's decision): each VM's image and OS (recorded at create,
// recovered through its approved plan for older VMs, else "legacy", never guessed); groups by image in pool_plan;
// vm_acquire({ os, image }); a project's caps and reservations per OS, and its image allowlist; one VM per session.
// Only Windows exists for real: a "linux" image here is a stub kind, made only in the journal (no Linux guest code).
// Through helper.js (the host protocol) against the stub Hyper-V, and server.js for the compatibility check.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { scratch, startHelper, withPool, approve, waitFor } = require('./helpers')
const { server } = require('../client')

const A = 'ab'.repeat(32) // seeded by withPool: Windows
const B = 'cd'.repeat(32) // a second Windows image
const L = 'ef'.repeat(32) // a stub "linux" image

/** Adds verified images to a stopped helper's journal (as the image check would record them). */
function addImages(sc, list) {
  const dir = path.join(sc.disks, 'images')
  fs.mkdirSync(dir, { recursive: true })
  for (const [sha256, os, seq] of list) {
    const file = path.join(dir, `${sha256}.iso`)
    fs.writeFileSync(file, 'iso')
    fs.appendFileSync(path.join(sc.stateDir, 'journal.jsonl'), JSON.stringify({ t: 'image', sha256, size: 3, file, source: 'local', edition: 'EnterpriseEval', build: '26200.6584', pinned: true, os, seq, at: new Date().toISOString() }) + '\n')
  }
}

/** Plans, approves and runs a pool change; waits for its job. */
async function change(sc, admin, args) {
  const plan = await admin.request('pool_plan', args)
  assert.ok(plan.data?.planId, plan.text)
  approve(sc, plan.data.planId)
  await admin.request(`pool_${args.action}`, { planId: plan.data.planId })
  const before = plan.data.planId
  await waitFor(async () => {
    const st = (await admin.request('status')).text
    if (/Last pool job: \w+ FAILED/.test(st)) throw new Error(`the pool job failed: ${st}`)
    return !/Pool job in progress/.test(st) && /Last pool job: \w+ finished/.test(st)
  }, 15_000, `the pool job of plan ${before}`)
  return plan
}

/** A pool of 2 from A, then B and L verified, a helper on it, and its admin connection. */
async function mixed(name, policy = {}) {
  const sc = scratch(name, { policy: { maxVms: 6, maxMemoryMBTotal: 65536, ...policy } })
  const { h } = await withPool(sc, 2)
  await h.stop()
  addImages(sc, [[B, 'windows', 2000], [L, 'linux', 2001]])
  const helper = await startHelper(sc, { HYPERV_MCP_WAIT_MS: '400', HYPERV_MCP_KEEP_MS: '60000' })
  return { sc, h: helper, admin: helper.conn(99) }
}
const status = async c => (await c.request('status')).text
const acquire = (c, args) => c.request('acquire', { minutes: 30, ...args }).then(r => r, e => ({ error: e.message }))

test('groups by image: a resize with an image adds to, or takes from, that image\'s VMs only; status shows each VM\'s OS and image', async () => {
  const { sc, h, admin } = await mixed('img-groups')
  await change(sc, admin, { action: 'resize', image: B.slice(0, 12), vms: 1 })
  await change(sc, admin, { action: 'resize', image: L, vms: 1 })
  let st = await status(admin)
  assert.strictEqual((st.match(/: windows, image abababababab;/g) || []).length, 2)
  assert.strictEqual((st.match(/: windows, image cdcdcdcdcdcd;/g) || []).length, 1)
  assert.strictEqual((st.match(/: linux, image efefefefefef;/g) || []).length, 1)
  // A's group down to 1: one A VM goes, B's and L's stay.
  const p = await change(sc, admin, { action: 'resize', image: A, vms: 1 })
  assert.match(p.text, /- remove hvmcp-/)
  assert.doesNotMatch(p.text, /- create /)
  st = await status(admin)
  assert.strictEqual((st.match(/image abababababab;/g) || []).length, 1)
  assert.strictEqual((st.match(/image cdcdcdcdcdcd;/g) || []).length, 1)
  assert.strictEqual((st.match(/image efefefefefef;/g) || []).length, 1)
  // An image that isn't verified, or a prefix that is too short, is refused.
  await assert.rejects(admin.request('pool_plan', { action: 'resize', image: '12'.repeat(32), vms: 1 }), /No verified image/)
  await assert.rejects(admin.request('pool_plan', { action: 'resize', image: 'abab', vms: 1 }), /at least its first 12 hex digits/)
  await h.stop()
})

test('vm_acquire by OS and image: only the matching VMs; one VM per session as before', async () => {
  const { sc, h, admin } = await mixed('img-acquire')
  const [c1, c2, c3, c4] = [h.conn(1), h.conn(2), h.conn(3), h.conn(4)]
  assert.match((await acquire(c1, { os: 'linux' })).error, /the pool has no free linux VM/)
  await change(sc, admin, { action: 'resize', image: L, vms: 1 })
  await change(sc, admin, { action: 'resize', image: B, vms: 1 })
  assert.match((await acquire(c1, { os: 'linux' })).text, /^Leased .* \(linux, image efefefefefef\)/)
  assert.match((await acquire(c1, { os: 'windows' })).error, /already has .*: one VM per connection/)
  assert.match((await acquire(c2, { image: B.slice(0, 16) })).text, /\(windows, image cdcdcdcdcdcd\)/)
  assert.match((await acquire(c3, { image: B })).error, /^No VM for you now: none of image cdcdcdcdcdcd is free/)
  assert.match((await acquire(c3, { os: 'linux', image: A })).error, /image abababababab is a windows image, not linux/)
  assert.match((await acquire(c3, {})).text, /^Leased /, 'a plain acquire takes any Windows image')
  assert.match((await c3.request('status')).text, /windows, image abababababab;.*\(yours\)/)
  assert.match((await acquire(c4, { os: 'mac' })).error, /os must be windows or linux/)
  await h.stop()
})

test('a VM made before images were recorded: recovered through its approved plan, or "legacy", never guessed', async () => {
  const { sc, h, admin } = await mixed('img-legacy')
  await change(sc, admin, { action: 'resize', image: B, vms: 1 })
  await h.stop()
  // Older records: no image on the intents (A's from the create, B's from the resize).
  const file = path.join(sc.stateDir, 'journal.jsonl')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  for (const r of lines) if (r.t === 'intent') delete r.image
  fs.writeFileSync(file, lines.map(r => JSON.stringify(r)).join('\n') + '\n')
  let h2 = await startHelper(sc)
  let st = await status(h2.conn(1))
  assert.strictEqual((st.match(/image abababababab;/g) || []).length, 2, 'A\'s recovered through the create plan')
  assert.strictEqual((st.match(/image cdcdcdcdcdcd;/g) || []).length, 1, 'B\'s through the resize plan')
  await h2.stop()
  // Without the create's plan file, A's two VMs can't be proved: legacy (Windows), never A.
  const createJob = lines.find(r => r.t === 'job' && r.op === 'create')
  fs.rmSync(path.join(sc.stateDir, 'plans', `${createJob.planId}.json`))
  h2 = await startHelper(sc)
  const [c1, c2, c3, a2] = [h2.conn(1), h2.conn(2), h2.conn(3), h2.conn(98)]
  st = await status(c1)
  assert.strictEqual((st.match(/windows, image unknown \(made before images were recorded\);/g) || []).length, 2)
  assert.match((await acquire(c1, { image: A })).error, /none of image abababababab is free/, 'a legacy VM never serves an exact image')
  assert.match((await acquire(c1, { image: B })).text, /image cdcdcdcdcdcd/)
  assert.match((await acquire(c2, {})).text, /^Leased /, 'a plain Windows acquire takes a legacy VM')
  // A resize of A's group doesn't count or remove them: A's group is empty, so this adds one from A.
  await change(sc, a2, { action: 'resize', image: A, vms: 1 })
  st = await status(c3)
  assert.strictEqual((st.match(/image unknown/g) || []).length, 2)
  assert.strictEqual((st.match(/image abababababab;/g) || []).length, 1)
  await h2.stop()
})

test('per-OS shares and the image allowlist: a cap per OS, a reservation per OS, images a project may not use', async () => {
  const sc0 = scratch('img-shares-roots')
  const [p1, p2, p3] = ['p1', 'p2', 'p3'].map(n => path.join(sc0.dir, n))
  const projects = [
    { name: 'p1', folders: [p1], maxVms: { windows: 1, linux: 1 } },
    { name: 'p2', folders: [p2], reserveVms: { linux: 1 } },
    { name: 'p3', folders: [p3], images: [B], maxVms: { linux: 0 } }
  ]
  const { sc, h, admin } = await mixed('img-shares', { projects })
  await change(sc, admin, { action: 'resize', image: L, vms: 2 })
  await change(sc, admin, { action: 'resize', image: B, vms: 1 })
  const [a, b, c, d, e] = [1, 2, 3, 4, 5].map(i => h.conn(i))
  assert.match((await acquire(a, { roots: [p1] })).text, /for project p1/)
  assert.match((await acquire(b, { roots: [p1] })).error, /project p1 holds its windows cap of 1/)
  assert.match((await acquire(b, { roots: [p1], os: 'linux' })).text, /for project p1 \(linux/, 'at its Windows cap, p1 still gets a Linux VM')
  // One Linux VM left, and p2 is owed one: "other" can't have it, p2 can.
  assert.match((await acquire(c, { os: 'linux' })).error, /the free linux VM is reserved for p2/)
  assert.match((await acquire(d, { roots: [p2], os: 'linux' })).text, /for project p2 \(linux/)
  // p3 may use image B only, and no Linux: refused at once, never queued.
  assert.match((await acquire(e, { roots: [p3], image: A, wait: true })).error, /^No VM for you: project p3 may not use image abababababab\./)
  assert.match((await acquire(e, { roots: [p3], os: 'linux', wait: true })).error, /project p3 may not use linux VMs/)
  assert.doesNotMatch(await status(admin), /Waiting in line/)
  assert.match((await acquire(e, { roots: [p3] })).text, /for project p3 /)
  assert.match((await e.request('status')).text, /windows, image cdcdcdcdcdcd; [^\n]*\(yours\)/, 'p3 got B, its only image')
  assert.match(await status(admin), /p3 holds 0 linux of its cap of 0, 1 windows \(images cdcdcdcdcdcd only\)/)
  await h.stop()
})

test('a reservation counts every free VM of the OS; the image only narrows which one is taken', async () => {
  const sc0 = scratch('img-reserve-roots')
  const p2 = path.join(sc0.dir, 'p2')
  const { sc, h, admin } = await mixed('img-reserve', { projects: [{ name: 'p2', folders: [p2], reserveVms: { windows: 1 } }] })
  await change(sc, admin, { action: 'resize', image: A, vms: 1 })
  await change(sc, admin, { action: 'resize', image: B, vms: 1 })
  // Free: one A, one B; p2 is owed one Windows VM. Asking for A takes A, and B covers p2.
  assert.match((await acquire(h.conn(1), { image: A })).text, /image abababababab/)
  assert.match((await acquire(h.conn(2), { image: B })).error, /the free windows VM is reserved for p2/)
  assert.match((await acquire(h.conn(3), { roots: [p2] })).text, /for project p2/)
  await h.stop()
})

test('a waiter for one kind is not given a freed VM of another', async () => {
  const { sc, h, admin } = await mixed('img-queue')
  await change(sc, admin, { action: 'resize', image: A, vms: 1 })
  await change(sc, admin, { action: 'resize', image: L, vms: 1 })
  const [w, l, x] = [h.conn(1), h.conn(2), h.conn(3)]
  await acquire(w, {})
  await acquire(l, { os: 'linux' })
  const waitLinux = acquire(x, { os: 'linux', wait: true })
  await waitFor(async () => /Waiting in line: 1\. other \(linux\)/.test(await status(admin)), 5000, 'x in line')
  await w.request('release')
  const r = await waitLinux
  assert.match(r.text, /^Still waiting for a VM \(the pool has no free linux VM\): number 1 of 1/, 'the freed Windows VM wasn\'t given to a Linux waiter')
  assert.match(await status(admin), /windows, image abababababab; .*free/)
  await h.stop()
})

test('server.js: a helper without the images feature gets no acquire at all for an image or a non-Windows OS', async t => {
  const sc = scratch('img-compat', { policy: { maxVms: 3 } })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const shim = path.join(sc.dir, 'older-core.js')
  const count = path.join(sc.dir, 'acquires.txt')
  fs.writeFileSync(shim, `const fs = require('fs')
const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') return { text: 'hyperv-mcp/3', data: { protocol: 'hyperv-mcp/3', features: ['projects'], buildRoots: [] } }
  if (op === 'acquire') fs.appendFileSync(${JSON.stringify(count)}, JSON.stringify(args) + '\\n')
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  assert.match((await s.call('vm_acquire', { image: A })).text, /The helper \(hyperv-mcp\/3\) has no 'images' feature, which asking for an image needs: run setup again/)
  assert.match((await s.call('vm_acquire', { os: 'linux' })).text, /has no 'images' feature, which asking for a linux VM needs/)
  assert.ok(!fs.existsSync(count), 'no acquire reached the helper')
  assert.match((await s.call('vm_acquire', { os: 'windows' })).text, /^Leased /, 'a plain Windows acquire, as before')
  const sent = fs.readFileSync(count, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.strictEqual(sent.length, 1)
  assert.ok(!('os' in sent[0]) && !('image' in sent[0]), 'nothing it can\'t honour was sent')
})
