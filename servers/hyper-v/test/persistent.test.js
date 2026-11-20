// MC-1582: a persistent VM, for research (the user's choice in a plan; disposable stays the default). Through helper.js
// against the stub Hyper-V: the plan and its journal bind it; plain acquires never get it, a named one does; it is never
// restored by a release, a stop, a disconnect, a helper restart, a quarantine retry, a plain start or a failed start's
// cleanup (it is parked: shut down, disconnected, no reserve, its disk kept), and only an explicit clean start, a pool
// checkpoint or vm_reset restores it; its leases have no work-session cap but keep maxLeaseMinutes; interactive starts
// and refresh are refused on it; and server.js refuses persistent for a helper without the feature, and sends reset
// only from vm_reset.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { T, scratch, startHelper, withPool, approve, waitFor } = require('./helpers')
const { server } = require('../client')

const vmsOf = sc => Object.values(sc.stub().vms)
const restores = (sc, vm) => (sc.stub().restores || []).filter(r => !vm || r.vmId === vm.id).length
const parks = sc => (sc.stub().parks || []).length
const KEEP = 'C:\\research.txt'

/** A pool of one disposable VM, then one persistent VM added by an approved resize. */
async function pool(name, { policy = {}, env = {} } = {}) {
  const sc = scratch(name, { policy: { maxVms: 4, maxMemoryMBTotal: 65536, ...policy } })
  let { h, admin } = await withPool(sc, 1)
  const plan = await admin.request('pool_plan', { action: 'resize', vms: 2, persistent: true })
  approve(sc, plan.data.planId)
  await admin.request('pool_resize', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: resize finished/.test((await admin.request('status')).text), T.poolJobMs, 'the resize')
  if (Object.keys(env).length) { await h.stop(); h = await startHelper(sc, env); admin = h.conn(1) }
  const ready = sc.journal().filter(r => r.t === 'ready')
  const persistent = vmsOf(sc).find(v => v.id === ready.find(r => r.persistent).vmId)
  const disposable = vmsOf(sc).find(v => v.id !== persistent.id)
  return { sc, h, admin, plan, persistent, disposable }
}
/** Leases the persistent VM by name, starts it (plain) and writes the research file. */
async function leaseAndWrite(c, name) {
  await c.request('acquire', { vm: name, minutes: 30 })
  await c.request('start')
  await c.request('run', { command: `write ${KEEP} kept` })
}

test('MC-1582: the plan says what a persistent VM gives up; the journal binds it to the VMs it builds, never the others; status shows it', async t => {
  const { sc, h, admin, plan, persistent, disposable } = await pool('pers-plan')
  t.after(() => h.stop())
  assert.match(plan.text, /- create hvmcp-[0-9a-f]+: .*network adapter disconnected; PERSISTENT/)
  assert.match(plan.text, /- PERSISTENT \(MC-1582\): each VM this plan builds is never restored to clean at release, .*keeps whatever its runs left .*Plain acquires never get it; vm_acquire\(\{ vm \}\) does\. Its leases have no work-session cap \(each acquire and renew stays within maxLeaseMinutes\)\. .*vm_reset restores it and discards what it kept/)
  const file = JSON.parse(fs.readFileSync(path.join(sc.stateDir, 'plans', `${plan.data.planId}.json`), 'utf8'))
  assert.strictEqual(file.persistent, true, 'in the plan record the approval\'s digest covers')
  assert.ok(file.add.every(a => a.persistent === true))
  const ready = sc.journal().filter(r => r.t === 'ready')
  assert.deepStrictEqual(ready.map(r => !!r.persistent), [false, true])
  const st = (await admin.request('status')).text
  assert.match(st, new RegExp(`- ${persistent.name}: .*PERSISTENT \\(never restored at release; leased only by name\\)`))
  assert.doesNotMatch(st, new RegExp(`- ${disposable.name}: [^\\n]*PERSISTENT`))
  // The option's own refusals; and a shrinking resize removes the disposable VM before the persistent one.
  await assert.rejects(admin.request('pool_plan', { action: 'resize', vms: 2, persistent: 'yes' }), /persistent must be true, or left out/)
  await assert.rejects(admin.request('pool_plan', { action: 'resize', vms: 1, persistent: true }), /persistent is for a plan that builds VMs/)
  const shrink = await admin.request('pool_plan', { action: 'resize', vms: 1 })
  assert.match(shrink.text, new RegExp(`- remove ${disposable.name} and its folder`))
  assert.doesNotMatch(shrink.text, new RegExp(`- remove ${persistent.name}`))
  const all = await admin.request('pool_plan', { action: 'remove' })
  assert.match(all.text, new RegExp(`- remove ${persistent.name} and its folder .* \\(a persistent VM: what it kept is lost\\)`))
})

test('MC-1582: plain acquires never get a persistent VM; a named one does, with no work-session cap', async t => {
  const { sc, h, persistent, disposable } = await pool('pers-acquire', { policy: { maxLeaseMinutes: 30, maxSessionMinutes: 30 } })
  t.after(() => h.stop())
  const a = h.conn(10); const b = h.conn(11); const c = h.conn(12)
  const plain = await a.request('acquire', { minutes: 30 })
  assert.strictEqual(plain.data.vm, disposable.name)
  assert.strictEqual(plain.data.persistent, undefined)
  await assert.rejects(b.request('acquire', { minutes: 30 }), /No VM is free|none is free/, 'the persistent VM is free, but not for a plain acquire')
  const named = await c.request('acquire', { vm: persistent.name, minutes: 30 })
  assert.strictEqual(named.data.persistent, true)
  assert.match(named.text, /PERSISTENT: it is never restored at release or at a plain vm_start/)
  // No work-session cap: only the stub image's Windows evaluation ends it (about 90 days away), as it would any lease.
  assert.match(named.text, /\((a persistent VM: no work-session cap|its Windows evaluation's end)\)/)
  assert.ok(named.data.sessionEnd > Date.now() + 24 * 60 * 60_000, 'far past the policy\'s 30-minute session')
  assert.ok(plain.data.sessionEnd <= Date.now() + 30 * 60_000, 'the disposable lease keeps the policy\'s cap')
  // Renewals past where the session cap would have ended it: each within maxLeaseMinutes, again and again.
  for (let i = 0; i < 3; i++) assert.match((await c.request('renew', { minutes: 30 })).text, /^Renewed:/)
  await assert.rejects(a.request('renew', { minutes: 30 }), /past this work session's end/, 'the disposable one can\'t')
  await assert.rejects(c.request('renew', { minutes: 31 }), /minutes must be 1-30 \(the policy's maxLeaseMinutes\)/)
  void sc
})

test('MC-1582: its state survives stop, a plain start, release and the next named lease: parked each time, never restored', async t => {
  const { sc, h, persistent } = await pool('pers-keep')
  t.after(() => h.stop())
  const c = h.conn(10)
  const r0 = restores(sc, persistent)
  const p0 = parks(sc)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  const started = await c.request('start')
  assert.match(started.text, /Started hvmcp-[0-9a-f]+ from its disk as it was \(persistent: not restored; vm_start\(\{ checkpoint: 'clean' \}\) or vm_reset for clean\): shut down and parked/)
  assert.match(started.text, /C:\\out keeps what earlier runs left/)
  assert.deepStrictEqual([started.data.persistent, started.data.restored], [true, false])
  await c.request('run', { command: `write ${KEEP} kept` })
  const stopped = await c.request('stop')
  assert.match(stopped.text, /^Stopped: hvmcp-[0-9a-f]+ parked \(persistent: shut down, network disconnected, no CPU reserve; not restored, so its disk keeps what the lease left\)\./)
  await c.request('start')
  assert.match((await c.request('run', { command: `cat ${KEEP}` })).text, /kept/, 'after a stop and a plain start')
  const rel = await c.request('release')
  assert.match(rel.text, /^Released\. hvmcp-[0-9a-f]+ parked \(persistent/)
  const vm = vmsOf(sc).find(v => v.id === persistent.id)
  assert.deepStrictEqual([vm.state, vm.switchName, vm.reserve], ['Off', null, 0], 'parked: off, disconnected, no reserve')
  assert.ok(vm.disk[KEEP], 'its disk kept the file')
  const d = h.conn(11)
  await d.request('acquire', { vm: persistent.name, minutes: 30 })
  await d.request('start')
  assert.match((await d.request('run', { command: `cat ${KEEP}` })).text, /kept/, 'the next lease sees it')
  assert.strictEqual(restores(sc, persistent), r0, 'no restore of it, ever')
  assert.ok(parks(sc) >= p0 + 4, 'a park at each start, stop and release')
})

test('MC-1582: only an explicit clean start, a pool checkpoint name or vm_reset restores it', async t => {
  const { sc, h, persistent } = await pool('pers-explicit')
  t.after(() => h.stop())
  const c = h.conn(10)
  await leaseAndWrite(c, persistent.name)
  const r0 = restores(sc, persistent)
  const clean = await c.request('start', { checkpoint: 'clean' })
  assert.match(clean.text, /Started hvmcp-[0-9a-f]+ from its clean checkpoint/)
  assert.strictEqual(restores(sc, persistent), r0 + 1)
  assert.match((await c.request('run', { command: `check ${KEEP}` })).text, /^Exit code 1\./, 'the explicit clean start discarded it')
  await c.request('run', { command: `write ${KEEP} again` })
  const reset = await c.request('start', { reset: true })
  assert.match(reset.text, /from its clean checkpoint/)
  assert.strictEqual(restores(sc, persistent), r0 + 2)
  assert.match((await c.request('run', { command: `check ${KEEP}` })).text, /^Exit code 1\./, 'vm_reset discarded it')
})

test('MC-1582: a disconnect, a helper restart, a failed start\'s cleanup and a quarantine retry park it, never restore it', async t => {
  const { sc, h, persistent } = await pool('pers-cleanup', { env: T.profile('retryQuick') })
  let helper = h
  t.after(() => helper.stop())
  const r0 = restores(sc, persistent)
  // A disconnect ends the lease: parked.
  const c = helper.conn(10)
  await leaseAndWrite(c, persistent.name)
  await c.close()
  await waitFor(() => vmsOf(sc).find(v => v.id === persistent.id).state === 'Off', T.waitForMs, 'the park after the disconnect')
  // A failed start's cleanup.
  const d = helper.conn(11)
  await waitFor(async () => d.request('acquire', { vm: persistent.name, minutes: 30 }).then(() => true, () => false), T.waitForMs, 'the VM free again')
  sc.patchStub(s => { s.fail['configure-start'] = 1 })
  await assert.rejects(d.request('start'), /injected failure of configure-start/)
  await d.request('start')
  await d.request('run', { command: `write ${KEEP} kept` })
  // A helper restart voids the lease: parked, reported so.
  await helper.kill()
  helper = await startHelper(sc, T.profile('retryQuick'))
  assert.match((await helper.conn(1).request('status')).text, new RegExp(`${persistent.name}: parked \\(persistent: not restored\\)\\.`))
  assert.ok(vmsOf(sc).find(v => v.id === persistent.id).disk[KEEP], 'kept through the restart')
  // A park that doesn't verify quarantines it; the retry parks it again.
  const e = helper.conn(12)
  await e.request('acquire', { vm: persistent.name, minutes: 30 })
  await e.request('start')
  sc.patchStub(s => { s.parkFails = 1 })
  const rel = await e.request('release')
  assert.match(rel.text, /CLEANUP FAILED: hvmcp-[0-9a-f]+ \(persistent\) could not be confirmed parked \(state is Running, not Off\)\. It is quarantined .*Its disk was not restored\./)
  await waitFor(async () => !/QUARANTINED/.test((await helper.conn(1).request('status')).text), T.waitForMs, 'the retry\'s park')
  assert.ok(vmsOf(sc).find(v => v.id === persistent.id).disk[KEEP], 'kept through the quarantine and its retry')
  assert.strictEqual(restores(sc, persistent), r0, 'none of these restored it')
})

test('MC-1582: an interactive start and a clean-checkpoint refresh are refused on a persistent VM', async t => {
  const { h, admin, persistent, disposable } = await pool('pers-refuse')
  t.after(() => h.stop())
  const c = h.conn(10)
  await c.request('acquire', { vm: persistent.name, minutes: 30 })
  await assert.rejects(c.request('start', { interactive: 'user' }), /is persistent: an interactive start isn't offered on it yet/)
  await assert.rejects(admin.request('pool_plan', { action: 'refresh-clean', targets: [persistent.name] }), /is persistent: a clean-checkpoint refresh restores it first/)
  assert.ok((await admin.request('pool_plan', { action: 'refresh-clean', targets: [disposable.name] })).data.planId, 'a disposable one still can be')
})

test('MC-1582 through server.js: vm_reset sends reset (vm_start never does); an older helper without the feature gets no persistent plan', async t => {
  const sc = scratch('pers-server')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const log = path.join(sc.dir, 'requests.txt')
  const shim = (features) => {
    const f = path.join(sc.dir, `shim-${features ? 'old' : 'new'}.js`)
    fs.writeFileSync(f, `const fs = require('fs')
const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  ${features ? `if (op === 'version') { const v = await request.call(this, connId, op, args); return { ...v, data: { ...v.data, features: v.data.features.filter(x => x !== 'persistent') } } }` : ''}
  if (op === 'start' || op === 'pool_plan') fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ op, args }) + '\\n')
  return request.call(this, connId, op, args)
}
`)
    return f
  }
  const env = f => ({ ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(f)}` })
  const lines = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  // An older helper: refused before anything is sent.
  const old = server(env(shim(true)), { roots: [sc.builds] })
  const refused = await old.call('pool_plan', { action: 'resize', vms: 2, persistent: true })
  assert.match(refused.text, /has no 'persistent' feature, which a persistent VM \(persistent\) needs: run setup again to update it/)
  assert.ok(!lines().some(l => l.op === 'pool_plan'), 'no pool_plan reached the helper')
  assert.ok(!fs.readdirSync(path.join(sc.stateDir, 'plans')).some(f => fs.readFileSync(path.join(sc.stateDir, 'plans', f), 'utf8').includes('persistent')), 'nothing recorded')
  await old.call('vm_acquire')
  await old.call('vm_start')
  await old.call('vm_reset')
  assert.ok(lines().filter(l => l.op === 'start').every(l => l.args.reset === undefined), 'an older helper is never sent reset')
  await old.close()
  fs.rmSync(log)
  // This helper: vm_reset says reset; vm_start never does.
  const s = server(env(shim(false)), { roots: [sc.builds] })
  t.after(() => s.close())
  await s.call('vm_acquire')
  await s.call('vm_start')
  await s.call('vm_reset')
  assert.deepStrictEqual(lines().filter(l => l.op === 'start').map(l => l.args.reset ?? null), [null, true])
})
