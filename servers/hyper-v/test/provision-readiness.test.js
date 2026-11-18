// The build's wait for App Readiness (MC-1528), on a fake clock: no acceptance while Windows' App Readiness hasn't
// finished the account's per-user queue, even when everything else is quiet; the quiet backstop still runs after it
// finishes; unknown (null) is never accepted; a queue that never finishes fails late with its state; every call bounded
// by the time left. core.js's own provisionProfiles, logon and waitProvisioned on a bare object, with a clock that moves
// only by its calls: guest-logon 10, guest-session 5, guest-provisioned 5, the undo 5.
Object.assign(process.env, require('./helpers').T.profile('provisionReadiness')) // test/timing.json (MC-1558): read before core.js loads
const test = require('node:test')
const assert = require('assert')
const { Helper } = require('../helper/core')

const vm = { vmId: 'v', vmName: 'hvmcp-test', folder: 'X:\\pool\\i-0' }
const creds = { admin: { user: 'hvadmin', password: 'a' }, user: { user: 'hvuser', password: 'u' } }
const DONE = { done: true, tasks: 0, completedAt: '2026-11-16T02:01:55.000Z', completionId: 101, suspendedUntil: null, resumedAt: '2026-11-16T02:00:55.600Z' }
const PENDING = { done: false, tasks: 39, completedAt: null, completionId: null, suspendedUntil: '2026-11-16T02:00:55.499Z', resumedAt: null }

/** A helper on the fake clock. readiness(account, logonNo, sinceReady): App Readiness's state on that probe. */
function fake(readiness, extra = null) {
  const h = Object.create(Helper.prototype)
  let t = 0
  let logons = 0
  let ready = null
  const calls = []
  h.now = () => t
  h.undoLogon = async () => { t += 5 }
  h.log = () => {}
  h.hv = async (op, a, opts) => {
    calls.push({ op, at: t, timeoutMs: opts?.timeoutMs, account: a.account || a.logon?.user, logon: logons })
    if (op === 'guest-logon') { const before = `b${logons}`; logons++; ready = null; t += 10; return { boot: before } }
    if (op === 'guest-session') { t += 5; return { boot: `b${logons}`, sessions: [1], user: true, armed: true, logons: 1, logoffs: 0 } }
    if (op === 'guest-provisioned') {
      if (ready === null) ready = t
      t += 5
      const ar = readiness(a.account, logons, t - ready)
      // The wave lands when App Readiness finishes: 61/26 before, 100/65 after.
      return { boot: `b${logons}`, user: true, inventory: 'x', lastEvent: null, busy: [], count: 99, mappings: ar?.done ? 100 : 61, packagesDirs: ar?.done ? 65 : 26, appReadiness: ar, ...(extra ? extra(a.account, t - ready) : {}) }
    }
    if (op === 'guest-logon-diag') { t += 5; return { uptime: 1, logs: {}, processes: [], autoAdminLogon: '1', watcher: false } }
    throw new Error(`unexpected ${op}`)
  }
  return { h, calls, now: () => t }
}

function bounded(calls, account, deadline) {
  for (const c of calls.filter(x => x.account === account)) {
    assert.ok(c.at < deadline, `no call started at or after the deadline: ${JSON.stringify(c)}`)
    assert.ok(c.timeoutMs >= 1 && c.timeoutMs <= deadline - c.at, `bounded by the time left: ${JSON.stringify(c)}`)
  }
}

test('no acceptance until App Readiness finishes; then the quiet backstop; the post-wave counts and its state recorded', async () => {
  // Pending for the first 60 of each account's wait, then finished.
  const f = fake((acc, n, since) => since >= 60 ? DONE : PENDING)
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  for (const who of ['hvadmin', 'hvuser']) {
    assert.ok(out[who].quietMs >= 60 + 20, `${who}: quiet counted after App Readiness finished (${out[who].quietMs})`)
    assert.ok(out[who].quietMs < 60 + 20 + 15, `${who}: and accepted promptly then (${out[who].quietMs})`)
    assert.strictEqual(out[who].mappings, 100)
    assert.strictEqual(out[who].packagesDirs, 65)
    assert.deepStrictEqual(out[who].appReadiness, DONE)
  }
  bounded(f.calls, 'hvadmin', 200)
})

test('quiet before App Readiness finishes is never enough: unchanged counts while pending don\'t count toward quiet', async () => {
  // Everything is unchanged for 100 while pending (well past the 20 of quiet), then it finishes.
  const f = fake((acc, n, since) => since >= 100 ? DONE : PENDING)
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.ok(out.hvadmin.quietMs >= 120, `not accepted on the pending quiet (${out.hvadmin.quietMs})`)
})

test('App Readiness unknown (its logs unreadable) is never accepted: the account fails late, saying so', async () => {
  const f = fake(() => ({ done: null, tasks: null, completedAt: null, suspendedUntil: null, resumedAt: null }))
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /hvadmin's first-logon provisioning didn't settle within 0 s \(App Readiness: unknown \(its logs unreadable or no answer\)\)/)
  bounded(f.calls, 'hvadmin', 200)
})

test('App Readiness never finishing fails late with its state (tasks left, the suspension), inside the deadline', async () => {
  const f = fake(() => PENDING)
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /didn't settle within 0 s \(App Readiness: not finished, 39 tasks left, suspended until 2026-11-16T02:00:55\.499Z\)/)
  bounded(f.calls, 'hvadmin', 200)
})

test('a missing appReadiness (an older probe) is treated as unknown, never as finished', async () => {
  const f = fake(() => undefined)
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /App Readiness: unknown/)
})

test('done → new work → done: the quiet starts over after the second completion (a new completion time)', async () => {
  const LATER = { ...DONE, completedAt: '2026-11-16T02:03:00.000Z' }
  // Done at 20, more work at 30 (pending), done again (a new 211) from 50.
  const f = fake((acc, n, since) => since >= 50 ? LATER : since >= 30 ? PENDING : since >= 20 ? DONE : PENDING)
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.ok(out.hvadmin.quietMs >= 50 + 20, `quiet counted from the second completion (${out.hvadmin.quietMs})`)
  assert.strictEqual(out.hvadmin.appReadiness.completedAt, LATER.completedAt)
})

test('done → unknown → done: an unreadable sample breaks the quiet; it starts over once done is read again', async () => {
  const UNKNOWN = { done: null, tasks: null, completedAt: null, suspendedUntil: null, resumedAt: null }
  const f = fake((acc, n, since) => since >= 40 ? DONE : since >= 30 ? UNKNOWN : since >= 10 ? DONE : PENDING)
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.ok(out.hvadmin.quietMs >= 40 + 20, `quiet counted after the unknown sample (${out.hvadmin.quietMs})`)
})

test('a later completion with the same done state still starts the quiet over (the completion generation changed)', async () => {
  const f = fake((acc, n, since) => since >= 25 ? { ...DONE, completedAt: '2026-11-16T02:09:00.000Z' } : DONE)
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.ok(out.hvadmin.quietMs >= 25 + 20, `quiet restarted at the new completion (${out.hvadmin.quietMs})`)
})

test('two completions in the same second (MR1): a new completion record id starts the quiet over though completedAt is equal', async () => {
  // Done (record 101) from 0; at 20 more work came and finished in the same second: record 140, same completedAt.
  const f = fake((acc, n, since) => since >= 20 ? { ...DONE, completionId: 140 } : DONE)
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.ok(out.hvadmin.quietMs >= 20 + 20, `a full fresh quiet after the second completion (${out.hvadmin.quietMs})`)
  assert.strictEqual(out.hvadmin.appReadiness.completionId, 140)
})

test('MC-1562: a late failure after App Readiness finished names what kept breaking the quiet; busy before it isn\'t tallied', async () => {
  // App Readiness finishes at 30; a WebView2 process keeps (re)starting and an AppX deployment event lands every sample.
  let n = 0
  const f = fake((acc, k, since) => since >= 30 ? DONE : PENDING, () => ({ busy: ['msedgewebview2'], lastEvent: `e${n++}` }))
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), e => {
    assert.match(e.message, /didn't settle within 0 s \(App Readiness: finished at 2026-11-16T02:01:55\.000Z; after it finished, the quiet was broken by process msedgewebview2 \d+×, new AppX deployment event \d+×, last at \d+ s by process msedgewebview2, new AppX deployment event\)/)
    assert.doesNotMatch(e.message, /App Readiness not finished \d+×/, 'the pending samples before it finished aren\'t counted')
    return true
  })
  bounded(f.calls, 'hvadmin', 200)
})

test('MC-1562: a settled account records what restarted its quiet after App Readiness, and a guest name that isn\'t plain is "other"', async () => {
  // Finished from the start; one odd-named busy process at 10, then quiet.
  const f = fake(() => DONE, (acc, since) => (since >= 10 && since < 15 ? { busy: ['bad name; rm -rf'] } : {}))
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.deepStrictEqual(out.hvadmin.quietResets, { 'process other': 1 })
  assert.deepStrictEqual(out.hvuser.quietResets, { 'process other': 1 })
  const quiet = fake(() => DONE)
  assert.deepStrictEqual((await quiet.h.provisionProfiles(vm, creds, () => {})).hvadmin.quietResets, {})
})
