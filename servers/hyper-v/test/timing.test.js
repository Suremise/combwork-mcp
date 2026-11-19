// MC-1558: timings that suit a slow PC, set from the MCP server's env, and one timing file for the tests.
// - timing.js: the keys' defaults, floors and caps (the policy's cap applies to the default too), the derived call
//   bounds, the env a server sends; policy.json's timingCaps validated, an invalid one refusing the helper's start;
// - set-timing: clamped per connection; a lease takes its connection's values at acquire and keeps them for its cleanup,
//   also after a disconnect; connections never share values, a reconnect changes no existing lease; a pool job keeps the
//   applying connection's; start-up recovery uses the defaults; the queue place is the waiting connection's; vm_status
//   shows them; server.js sends its env's keys;
// - the restore call holds the off-wait and the restore, so a healthy off-wait never gets the call killed;
// - a Windows copy in bounded calls: a file in parts, progress past one call's bound, a stall failing, a killed call
//   resuming without redoing what it finished, a lease ending mid-copy;
// - guest-setup bounded and retried once after a timeout or a transport error, never after any other, at both sites;
// - no literal waits in the test files: each comes from test/timing.json.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const timing = require('../helper/timing')
const policy = require('../helper/policy')
const { Helper } = require('../helper/core')
const { T, scratch, startHelper, withPool, approve, seedImage, waitFor } = require('./helpers')
const { server } = require('../client')

// ---------- the test files ----------

test('no literal waits in the test files: waitFor bounds, spawn timeouts, sleeps and elapsed-time checks come from timing.json', () => {
  const bad = []
  for (const f of fs.readdirSync(__dirname).filter(n => n.endsWith('.test.js'))) {
    fs.readFileSync(path.join(__dirname, f), 'utf8').split('\n').forEach((l, i) => {
      for (const [re, what] of [
        [/waitFor\(.*, \d[\d_]{2,}(?:, ['`"]|\))/, 'a waitFor bound'],
        [/\btimeout: \d/, 'a timeout'],
        [/setTimeout\(r, \d[\d_]{2,}\)/, 'a sleep'],
        [/Date\.now\(\) - t0 < \d/, 'an elapsed-time bound'],
        // Round 1: the helper's and server's timing env, as a number or a string of digits (pure timing.js inputs aside).
        [/HYPERV_MCP_[A-Z_]*_(?:MS|SEC|SECS|MINUTES|SECONDS)\b['"]?\s*[:=]\s*['"]?\d/, 'a timing env value']
      ]) if (re.test(l) && !/timing\.(?:resolve|fromEnv)\(/.test(l)) bad.push(`${f}:${i + 1}: ${what}: ${l.trim().slice(0, 100)}`)
    })
  }
  assert.deepStrictEqual(bad, [])
  // Every name a test uses is in the file.
  const all = fs.readdirSync(__dirname).filter(n => n.endsWith('.js')).map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n')
  for (const m of all.matchAll(/\bT\.bounds\.(\w+)/g)) assert.ok(m[1] in T.bounds, `timing.json bounds has ${m[1]}`)
  for (const m of all.matchAll(/\bT\.(\w+Ms)\b/g)) assert.ok(m[1] in T, `timing.json waits has ${m[1]}`)
  for (const m of all.matchAll(/\bT\.profile\('(\w+)'\)/g)) assert.doesNotThrow(() => T.profile(m[1]), `timing.json profiles has ${m[1]}`)
})

// ---------- timing.js ----------

test('timing.js: defaults, floors and caps (a cap applies to the default too), notes, derived call bounds, the env a server sends', () => {
  const d = timing.resolve({}, null, {})
  assert.deepStrictEqual([d.values.guestReadyMinutes, d.values.restoreMinutes, d.values.offWaitSeconds, d.values.restoreVerifySeconds, d.values.checkpointMinutes, d.values.queueKeepMinutes, d.values.copyIdleMinutes], [10, 10, 120, 180, 10, 10, 5])
  assert.deepStrictEqual(d.notes, [])
  const r = timing.resolve({ guestReadyMinutes: 1, offWaitSeconds: 9999, logonMinutes: 'x', copyIdleMinutes: 20 }, { checkpointMinutes: 4, queueKeepMinutes: 3 }, {})
  assert.deepStrictEqual([r.values.guestReadyMinutes, r.values.offWaitSeconds, r.values.logonMinutes, r.values.copyIdleMinutes], [2, 600, 10, 9], 'floors, maxima')
  assert.deepStrictEqual([r.values.checkpointMinutes, r.values.queueKeepMinutes], [4, 3], 'the policy cap lowers the defaults, no key sent')
  assert.ok(r.notes.some(n => /guestReadyMinutes 1 min is outside 2-60: 2 used/.test(n)))
  assert.ok(r.notes.some(n => /logonMinutes must be a number: ignored/.test(n)))
  // A conflicting choice: the longest off-wait and the shortest restore still fit their call.
  const c = timing.resolve({ offWaitSeconds: 600, restoreMinutes: 2 }, null, {})
  assert.deepStrictEqual(timing.derived(c.ms), { restoreCallMs: 12 * 60_000, shutdownCallMs: 6 * 60_000, makeCleanCallMs: 15 * 60_000 })
  // The test-only bases replace a default (below its floor), a client's value still wins.
  assert.strictEqual(timing.resolve({}, null, { HYPERV_MCP_READY_WAIT_MS: '1234' }).ms.guestReadyMinutes, 1234)
  assert.strictEqual(timing.resolve({ guestReadyMinutes: 3 }, null, { HYPERV_MCP_READY_WAIT_MS: '1234' }).ms.guestReadyMinutes, 180_000)
  assert.deepStrictEqual(timing.fromEnv({ HYPERV_MCP_GUEST_READY_MINUTES: '15', HYPERV_MCP_OFF_WAIT_SECONDS: 'x', HYPERV_MCP_COPY_IDLE_MINUTES: ' ', OTHER: '1' }), { guestReadyMinutes: 15 })
  assert.match(timing.describe(c), /restoreMinutes 2 min, offWaitSeconds 600 s; restore call 720 s/)
  // policy.json's timingCaps: known keys, numbers within each floor and maximum.
  const base = { ...policy.DEFAULTS, diskFolders: ['D:\\hv'] }
  assert.deepStrictEqual(policy.problems({ ...base, timingCaps: { guestReadyMinutes: 30 } }), [])
  assert.match(policy.problems({ ...base, timingCaps: { guestReadyMinutes: 1 } }).join(), /timingCaps\.guestReadyMinutes must be a number from 2 to 60/)
  assert.match(policy.problems({ ...base, timingCaps: { nope: 3 } }).join(), /timingCaps\.nope isn't a known timing/)
  assert.match(policy.problems({ ...base, timingCaps: { copyIdleMinutes: '5' } }).join(), /copyIdleMinutes must be a number/)
  assert.match(policy.problems({ ...base, timingCaps: [] }).join(), /timingCaps must be an object/)
})

test('an invalid timingCaps refuses the helper\'s start (never an impossible range)', async () => {
  const sc = scratch('timing-badcaps', { policy: { timingCaps: { restoreMinutes: 0.5 } } })
  await assert.rejects(startHelper(sc), /timingCaps\.restoreMinutes must be a number from 2 to 30/)
})

// ---------- per connection, lease and job ----------

test('set-timing: clamped per connection, shown in vm_status; a lease keeps its connection\'s values, through its cleanup after a disconnect; no sharing; recovery uses the defaults', async t => {
  const sc = scratch('timing-leases')
  let { h, admin } = await withPool(sc, 2)
  const a = h.conn(10); const b = h.conn(11)
  const set = await a.request('set-timing', { timing: { offWaitSeconds: 300, guestReadyMinutes: 1 } })
  assert.match(set.text, /offWaitSeconds 300 s.*guestReadyMinutes 1 min is outside 2-60: 2 used/)
  await b.request('set-timing', { timing: { offWaitSeconds: 400 } })
  assert.match((await a.request('status')).text, /Timings for this connection: guestReadyMinutes 2 min, .*offWaitSeconds 300 s.*; restore call 900 s/)
  assert.doesNotMatch((await admin.request('status')).text, /offWaitSeconds/, 'another connection\'s values aren\'t this one\'s')
  const restores = () => sc.stub().restores.map(x => x.offWaitMs)
  await a.request('acquire'); await a.request('start')
  await b.request('acquire'); await b.request('start')
  assert.deepStrictEqual(restores().slice(-2), [300_000, 400_000], 'each start with its own connection\'s values')
  // A's connection closes: its cleanup restore runs after it, with A's lease's values.
  a.close()
  await waitFor(async () => /; free/.test((await admin.request('status')).text), T.waitForMs, 'A\'s cleanup restore, and its VM free')
  assert.strictEqual(restores().at(-1), 300_000, 'with A\'s lease\'s values, after A\'s connection closed')
  // A new connection with other values changes nothing for B's live lease.
  const a2 = h.conn(12)
  await a2.request('set-timing', { timing: { offWaitSeconds: 500 } })
  await b.request('stop')
  assert.strictEqual(restores().at(-1), 400_000, 'B keeps its own')
  await a2.request('acquire'); await a2.request('start')
  assert.strictEqual(restores().at(-1), 500_000, 'a new lease takes its connection\'s current values')
  // Start-up recovery, with no client behind it: the defaults.
  await h.stop()
  const n = restores().length
  h = await startHelper(sc)
  t.after(() => h.stop())
  assert.ok(restores().length > n)
  assert.ok(restores().slice(n).every(x => x === 120_000), `recovery restores with the default off-wait (${restores().slice(n)})`)
})

test('the queue place is kept for the waiting connection\'s queueKeepMinutes; setup\'s cap lowers the default with no keys sent', async t => {
  for (const [name, opts, keep, sent] of [['timing-queue', {}, 180, { queueKeepMinutes: 3 }], ['timing-queuecap', { policy: { timingCaps: { queueKeepMinutes: 2 } } }, 120, null]]) {
    const sc = scratch(name, { ...opts, timing: ['HYPERV_MCP_WAIT_MS'] })
    const { h } = await withPool(sc, 1)
    const a = h.conn(10); const b = h.conn(11)
    await a.request('acquire')
    if (sent) await b.request('set-timing', { timing: sent })
    const w = await b.request('acquire', { wait: true })
    assert.match(w.text, new RegExp(`Call vm_acquire with wait: true again within ${keep} s to keep your place`), name)
    await h.stop()
  }
})

test('a pool job keeps the applying connection\'s timings (the build\'s shutdown wait); another connection\'s change doesn\'t reach it', async t => {
  const sc = scratch('timing-job')
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  t.after(() => h.stop())
  const admin = h.conn(1)
  await admin.request('set-timing', { timing: { shutdownMinutes: 7 } })
  await h.conn(2).request('set-timing', { timing: { shutdownMinutes: 9 } })
  const plan = await admin.request('pool_plan', { action: 'create', vms: 2, cores: 2, memoryGB: 4 })
  approve(sc, plan.data.planId)
  await admin.request('pool_create', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: create finished/.test((await admin.request('status')).text), T.poolJobMs, 'the pool job')
  assert.deepStrictEqual(sc.stub().makeCleans, [7 * 60_000, 7 * 60_000])
})

test('the restore call holds the off-wait and the restore: a restore slower than restoreMinutes alone, inside the off-wait, isn\'t killed', async t => {
  const sc = scratch('timing-restorecall', { timing: ['HYPERV_MCP_RESTORE_MS', 'HYPERV_MCP_OFF_WAIT_MS'] })
  const { h } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  await a.request('acquire')
  sc.patchStub(s => { s.restoreSlowMs = T.bounds.slowRestoreMs })
  assert.ok(T.bounds.slowRestoreMs > T.narrow.HYPERV_MCP_RESTORE_MS && T.bounds.slowRestoreMs < T.narrow.HYPERV_MCP_RESTORE_MS + T.narrow.HYPERV_MCP_OFF_WAIT_MS)
  assert.match((await a.request('start')).text, /^Started /)
  assert.strictEqual(sc.stub().restores.at(-1).offWaitMs, T.narrow.HYPERV_MCP_OFF_WAIT_MS)
})

// ---------- a Windows copy in bounded calls ----------

const vmOf = (sc, name) => Object.values(sc.stub().vms).find(v => v.name === name)
const buildOf = (sc, name) => Object.fromEntries(Object.entries(vmOf(sc, name).disk).filter(([k, v]) => /^c:\\build\\/i.test(k) && v !== '').map(([k, v]) => [k.slice(9).replace(/\\/g, '/'), Buffer.from(v, 'base64').toString()]))
async function startWith(c, files) {
  await c.request('stage_begin')
  for (const [p, d] of Object.entries(files)) {
    await c.request('stage_file', { path: p, size: Buffer.byteLength(d) })
    if (d.length) await c.request('stage_chunk', { data: Buffer.from(d).toString('base64') })
  }
  await c.request('stage_end')
  return c.request('start')
}
// Parts of 4 bytes (two to a call), so a few bytes exercise the parts.
async function copySession(name, stub = {}) {
  const sc = scratch(name, { timing: ['HYPERV_MCP_COPY_IDLE_MS'], stub })
  sc.env.HYPERV_MCP_COPY_PART_BYTES = '4'
  const { h } = await withPool(sc, 1)
  const a = h.conn(10)
  const vm = (await a.request('acquire')).data.vm
  return { sc, h, a, vm }
}

test('a Windows copy: a file over the part size goes in parts, appended in order through guest-sync\'s stage, then applied into C:\\build', async t => {
  const { sc, h, a, vm } = await copySession('copy-parts')
  t.after(() => h.stop())
  const r = await startWith(a, { 'big.bin': 'ABCDEFGHIJK', 'dir/small.txt': 'x', 'empty.txt': '' })
  assert.match(r.text, /build copied in to C:\\build \(3 files, 12 bytes/)
  assert.deepStrictEqual(buildOf(sc, vm), { 'big.bin': 'ABCDEFGHIJK', 'dir/small.txt': 'x' })
  const ops = sc.stub().calls.map(c => c.op)
  assert.strictEqual(ops.filter(o => o === 'copy-part').length, 2, 'two bounded calls of at most two parts each')
  assert.strictEqual(sc.stub().copyParts, 5, 'big.bin as three parts (4, 4, 3 bytes), then the two small files')
  assert.ok(ops.indexOf('copy-prepare') < ops.indexOf('copy-part') && ops.lastIndexOf('copy-part') < ops.indexOf('copy-apply'))
  assert.deepStrictEqual(fs.readdirSync(path.join(sc.stateDir, 'runs')).filter(n => n.startsWith('xfer-')), [], 'no part files left')
})

test('a Windows copy: progress continues past one call\'s idle bound (each call moves); a stall fails, naming the bound', async t => {
  const { sc, h, a, vm } = await copySession('copy-slow', { copySlowMs: T.bounds.copyItemMs })
  t.after(() => h.stop())
  const data = 'P'.repeat(40) // ten parts, five calls: longer in all than one call's bound
  assert.ok(5 * 2 * T.bounds.copyItemMs > T.narrow.HYPERV_MCP_COPY_IDLE_MS && 2 * T.bounds.copyItemMs < T.narrow.HYPERV_MCP_COPY_IDLE_MS)
  await startWith(a, { 'slow.bin': data })
  assert.deepStrictEqual(buildOf(sc, vm), { 'slow.bin': data })
  sc.patchStub(s => { delete s.copySlowMs; s.copyStallAll = true })
  await assert.rejects(startWith(a, { 'stuck.bin': 'ABCDEFGH' }), new RegExp(`the copy stalled: no 4-byte part or file finished within ${T.narrow.HYPERV_MCP_COPY_IDLE_MS / 1000} s \\(copyIdleMinutes\\)`))
})

test('a Windows copy: a call killed after finishing an item resumes from the guest\'s lengths, skipping what it has', async t => {
  const { sc, h, a, vm } = await copySession('copy-resume')
  t.after(() => h.stop())
  sc.patchStub(s => { s.copyStallAt = 2 }) // the second item ever blocks once: its call is killed after the first went in
  await startWith(a, { 'r.bin': 'ABCDEFGHIJKL' })
  assert.deepStrictEqual(buildOf(sc, vm), { 'r.bin': 'ABCDEFGHIJKL' }, 'every byte once, in order')
  assert.strictEqual(sc.stub().calls.filter(c => c.op === 'copy-lengths').length, 1)
  // Round 1: the retry carries only what the guest hadn't committed: the finished first part isn't sent again.
  const calls = sc.stub().copyPartCalls
  assert.deepStrictEqual(calls[0], ['r.bin@0', 'r.bin@4'])
  assert.deepStrictEqual(calls[1], ['r.bin@4', 'r.bin@8'], 'the cut-off part again, then the next: never r.bin@0')
})

test('a Windows copy: progress once, then a permanent stall: the retry sends only the stalled item, and fails when it finishes nothing', async t => {
  const { sc, h, a } = await copySession('copy-stall-after')
  t.after(() => h.stop())
  sc.patchStub(s => { s.copyStallRel = 'b.bin' })
  await assert.rejects(startWith(a, { 'a.txt': 'AA', 'b.bin': 'BB' }), /the copy stalled: no 4-byte part or file finished within/)
  assert.deepStrictEqual(sc.stub().copyPartCalls, [['a.txt@0', 'b.bin@0'], ['b.bin@0']], 'a.txt committed once and never resent; b.bin alone, then the stall')
})

test('a Windows copy: the lease ending mid-copy kills it; its part files go', async t => {
  const { sc, h, a } = await copySession('copy-cancel', { copySlowMs: T.bounds.copyItemSlowMs })
  t.after(() => h.stop())
  const admin = h.conn(1)
  const started = startWith(a, { 'c.bin': 'C'.repeat(40) }).catch(e => e)
  await waitFor(() => (sc.stub().copyItems || 0) >= 1, T.waitForMs, 'the copy under way')
  a.close()
  await waitFor(async () => /; free/.test((await admin.request('status')).text), T.waitForMs, 'the lease ended')
  await started
  await waitFor(() => !fs.readdirSync(path.join(sc.stateDir, 'runs')).some(n => n.startsWith('xfer-')), T.waitForMs, 'the part files removed')
})

// ---------- guest-setup ----------

async function build(name, stub, opts = {}) {
  const sc = scratch(name, { stub, ...opts })
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  const admin = h.conn(1)
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  approve(sc, plan.data.planId)
  await admin.request('pool_create', { planId: plan.data.planId })
  let line
  await waitFor(async () => { line = /Last pool job: create (finished|FAILED)[^\n]*/.exec((await admin.request('status')).text)?.[0]; return line }, T.poolJobMs, 'the build')
  await h.stop()
  return { sc, line }
}

test('guest-setup: bounded, retried once after a transport error or a timeout, never after any other error; two failures name both', async () => {
  const transport = await build('gs-transport', { setupTransport: 1 })
  assert.match(transport.line, /create finished/); assert.strictEqual(transport.sc.stub().setupCalls, 2)
  const hang = await build('gs-hang', { setupHang: 1 }, { timing: ['HYPERV_MCP_GUEST_SETUP_MS'] })
  assert.match(hang.line, /create finished/); assert.strictEqual(hang.sc.stub().setupCalls, 2)
  const twice = await build('gs-twice', { setupTransport: 2 })
  assert.match(twice.line, /create FAILED.*the guest setup failed twice: (?:guest-setup: )?the PowerShell Direct connection was lost \(injected\); then: (?:guest-setup: )?the PowerShell Direct connection was lost \(injected\)/)
  assert.strictEqual(twice.sc.stub().setupCalls, 2)
  const permanent = await build('gs-permanent', { setupThrows: true })
  assert.match(permanent.line, /create FAILED.*injected: the guest setup failed/)
  assert.strictEqual(permanent.sc.stub().setupCalls, 1, 'a setup error is never retried')
  const readback = await build('gs-readback', { setupOverride: { buildProtected: false } })
  assert.match(readback.line, /create FAILED.*C:\\build still inheriting permissions/)
})

test('guest-setup at a refresh: a transport error is retried once and the refresh finishes', async t => {
  const sc = scratch('gs-refresh')
  const { h, admin } = await withPool(sc, 1)
  t.after(() => h.stop())
  const vm = Object.values(sc.stub().vms)[0].name
  sc.patchStub(s => { s.setupTransport = 1; s.setupCalls = 0 })
  const p = await admin.request('pool_plan', { action: 'refresh-clean', targets: [vm] })
  approve(sc, p.data.planId)
  await admin.request('pool_refresh', { planId: p.data.planId })
  await waitFor(async () => /Last pool job: refresh (finished|FAILED)/.test((await admin.request('status')).text), T.poolJobMs, 'the refresh')
  assert.match((await admin.request('status')).text, /Last pool job: refresh finished/)
  assert.strictEqual(sc.stub().setupCalls, 2)
})

test('guest-setup: a helper that is closing doesn\'t retry', async () => {
  const h = Object.create(Helper.prototype)
  h.ident = vm => ({ vmId: vm.vmId })
  let calls = 0
  h.hv = async () => { calls++; h.closed = true; throw new Error('Hyper-V operation guest-setup timed out after 480 s') }
  await assert.rejects(h.guestSetup({ vmId: 'v' }, { admin: {}, user: { user: 'hvuser' } }), /timed out after 480 s/)
  assert.strictEqual(calls, 1)
})

// ---------- server.js ----------

test('server.js sends its env\'s timing keys to the helper on connecting (direct mode): vm_status shows them', async t => {
  const sc = scratch('timing-server')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const s = server({ ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', ...T.profile('serverSettings') })
  t.after(() => s.close())
  const st = (await s.call('vm_status')).text
  assert.match(st, /Timings for this connection: .*offWaitSeconds 250 s.*queueKeepMinutes 60 min.*; restore call 850 s/, 'the env\'s keys, clamped (99 min to 60)')
})

// ---------- MC-1566: the guest network's wait ----------

test('MC-1566: networkSeconds is a timing like the others: default, floor, cap, setup\'s cap, the env a server sends, vm_status', () => {
  assert.strictEqual(timing.resolve({}, null, {}).values.networkSeconds, 90)
  const r = timing.resolve({ networkSeconds: 5 }, null, {})
  assert.strictEqual(r.values.networkSeconds, 30, 'its floor')
  assert.ok(r.notes.some(n => /networkSeconds 5 s is outside 30-600: 30 used/.test(n)))
  assert.strictEqual(timing.resolve({ networkSeconds: 9999 }, null, {}).values.networkSeconds, 600, 'its maximum')
  assert.strictEqual(timing.resolve({ networkSeconds: 300 }, { networkSeconds: 120 }, {}).values.networkSeconds, 120, 'setup\'s cap')
  assert.strictEqual(timing.resolve({}, { networkSeconds: 60 }, {}).values.networkSeconds, 60, 'a cap lowers the default too')
  assert.deepStrictEqual(timing.fromEnv({ HYPERV_MCP_NETWORK_SECONDS: '240' }), { networkSeconds: 240 })
  assert.match(timing.describe(timing.resolve({ networkSeconds: 240 }, null, {})), /networkSeconds 240 s/)
  const base = { ...policy.DEFAULTS, diskFolders: ['D:\\hv'] }
  assert.match(policy.problems({ ...base, timingCaps: { networkSeconds: 10 } }).join(), /timingCaps\.networkSeconds must be a number from 30 to 600/)
})

/** A helper whose guestNet runs on a fake clock that moves only by its own sleeps and calls; reads from readAt(t). */
function netHelper(networkMs, readAt) {
  const h = Object.create(Helper.prototype)
  let t = 0
  const reads = []
  h.now = () => t
  h.sleep = async ms => { t += ms }
  h.tm = () => ({ ms: { networkSeconds: networkMs } })
  h.forLease = () => ({ timeoutMs: 1 })
  h.stillHeld = () => {}
  h.ident = vm => ({ vmId: vm.vmId })
  h.creds = () => ({ admin: { user: 'hvadmin', password: 'a' } })
  h.hv = async op => { if (op === 'facts-vm') return { mac: '00155D586D01' }; throw new Error(`unexpected ${op}`) }
  h.guestCall = async (vm, op) => { t += 1; if (op === 'guest-net') return { set: true }; reads.push(t); return readAt(t) }
  return { h, reads, now: () => t }
}
const NET_LEASE = { network: 'internet', net: { subnet: '172.30.160.0/20', gateway: '172.30.160.1' } }
const NET_VM = { vmId: 'v', vmName: 'hvmcp-test' }
const READY = { nics: [{ name: 'Ethernet', mac: '00155D586D01', ipv4: [{ ip: '172.30.161.168', prefix: 20 }] }], routes: [{ dest: '0.0.0.0/0', gateway: '172.30.160.1' }], dns: ['172.30.160.1'], lookup: true }
const APIPA = { nics: [{ name: 'Ethernet', mac: '00155D586D01', ipv4: [{ ip: '169.254.137.170', prefix: 16 }] }], routes: [], dns: [], lookup: false }

test('MC-1566: the guest network waits on its read-back (a condition), bounded only by the lease\'s networkSeconds, named when it runs out', async () => {
  // Ready from the start: accepted once it has held, long before the ceiling.
  const fast = netHelper(600_000, () => READY)
  assert.match(await fast.h.guestNet(NET_VM, NET_LEASE), /internet \(DHCP from Windows' Default Switch; the LAN is blocked\)/)
  assert.ok(fast.now() < 60_000, `accepted on the condition, not at the ceiling (${fast.now()})`)
  // A lease ready only after 150 s: a 120 s wait gives up, saying which setting to raise; 240 s waits for it.
  const late = t => t >= 150_000 ? READY : APIPA
  const short = netHelper(120_000, late)
  await assert.rejects(short.h.guestNet(NET_VM, NET_LEASE), /its network \(internet\) wasn't ready and steady within 120 s \(HYPERV_MCP_NETWORK_SECONDS, up to 600 s, if it needs longer\): no DHCP address from the Default Switch yet \(it has 169\.254\.137\.170\/16\)/)
  assert.ok(short.now() > 120_000 && short.now() < 150_000, `gave up at its own ceiling (${short.now()})`)
  const long = netHelper(240_000, late)
  await long.h.guestNet(NET_VM, NET_LEASE)
  assert.ok(long.now() >= 150_000 && long.now() < 240_000, `accepted when ready, within the longer ceiling (${long.now()})`)
})

test('MC-1566: the network wait is the lease\'s own value (kept from its connection), not the helper\'s defaults', async () => {
  const late = t => t >= 150_000 ? READY : APIPA
  // The real tm(): a lease that took 240 s from its connection waits past the default 90 s.
  const kept = netHelper(0, late)
  delete kept.h.tm
  kept.h.defaultTiming = timing.resolve({}, null, {})
  await kept.h.guestNet(NET_VM, { ...NET_LEASE, timing: timing.resolve({ networkSeconds: 240 }, null, {}) })
  assert.ok(kept.now() >= 150_000 && kept.now() < 240_000, `the lease's 240 s (${kept.now()})`)
  // A lease with no values of its own uses the defaults: 90 s, named.
  const dflt = netHelper(0, late)
  delete dflt.h.tm
  dflt.h.defaultTiming = timing.resolve({}, null, {})
  await assert.rejects(dflt.h.guestNet(NET_VM, NET_LEASE), /within 90 s \(HYPERV_MCP_NETWORK_SECONDS, up to 600 s/)
})
