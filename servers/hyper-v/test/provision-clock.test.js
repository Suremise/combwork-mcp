// The build's provisioning budget (MC-1516), on a fake clock: each account has one PROVISION_WAIT_MS deadline over its
// logon, its quiet wait and its one retry; a lost-session retry gets no new allowance; every call is bounded by the time
// left, and nothing that returns after the deadline is accepted (a logon's readiness, or a quiet probe). core.js's own
// provisionProfiles, logon and waitProvisioned run on a bare object, with a fake transport and a clock that moves only
// by its calls: guest-logon 10 ms, guest-session 5, guest-provisioned 5, the undo 5.
process.env.HYPERV_MCP_PROVISION_WAIT_MS = '100'
process.env.HYPERV_MCP_PROVISION_QUIET_MS = '20'
process.env.HYPERV_MCP_PROVISION_POLL_MS = '1'
process.env.HYPERV_MCP_POLL_MS = '1'
process.env.HYPERV_MCP_LOGON_STABLE_MS = '10'
process.env.HYPERV_MCP_BUILD_LOGON_WAIT_MS = '60'
process.env.HYPERV_MCP_LOGON_SNAPSHOT_MS = '30'
process.env.HYPERV_MCP_FIRST_LOGON_SIGN_MS = '15'
const test = require('node:test')
const assert = require('assert')
const { Helper } = require('../helper/core')

const vm = { vmId: 'v', vmName: 'hvmcp-test', folder: 'X:\\pool\\i-0' }
const creds = { admin: { user: 'hvadmin', password: 'a' }, user: { user: 'hvuser', password: 'u' } }

/**
 * A helper on the fake clock. watcher(account, logonNo, t): whether the session's watcher is seen; probe(account,
 * logonNo, t): fields over a quiet, logged-on provisioning sample.
 */
function fake({ watcher = () => true, probe = () => ({}), diagFails = false, session = () => ({}) } = {}) {
  const h = Object.create(Helper.prototype)
  let t = 0
  let logons = 0
  let account = null
  const calls = []
  h.now = () => t
  h.undoLogon = async () => { t += 5 }
  h.log = () => {}
  h.hv = async (op, a, opts) => {
    calls.push({ op, at: t, timeoutMs: opts?.timeoutMs, account: a.account || a.logon?.user })
    if (op === 'guest-logon') { const before = `b${logons}`; logons++; account = a.logon.user; t += 10; return { boot: before } }
    if (op === 'guest-session') { t += 5; const w = watcher(account, logons, t); return { boot: `b${logons}`, sessions: w ? [1] : [], user: true, armed: true, logons: 1, logoffs: 0, ...session(account, logons, t) } }
    if (op === 'guest-provisioned') { t += 5; return { boot: `b${logons}`, user: true, inventory: 'x', lastEvent: null, busy: [], count: 1, mappings: 60, packagesDirs: 25, appReadiness: { done: true, tasks: 0 }, ...probe(a.account, logons, t) } }
    if (op === 'guest-logon-diag') { t += 5; if (diagFails) throw new Error('injected: the diagnosis failed'); return { uptime: 42, logs: {}, processes: [], autoAdminLogon: '1', watcher: false, message: 'dropped' } }
    throw new Error(`unexpected ${op}`)
  }
  return { h, calls, logons: () => logons, now: () => t }
}

/** Every call made before the deadline was bounded by the time left; none started after it. */
function bounded(calls, deadline = 100, account = 'hvadmin') {
  for (const c of calls.filter(x => x.account === account)) {
    assert.ok(c.at < deadline, `no call started at or after the deadline: ${JSON.stringify(c)}`)
    assert.ok(c.timeoutMs >= 1 && c.timeoutMs <= deadline - c.at, `bounded by the time left: ${JSON.stringify(c)}`)
  }
}

test('a session lost near the deadline: the retry\'s logon gets no new allowance, and the build fails at the account\'s one deadline', async () => {
  // hvadmin's first logon is ready quickly, then busy until t 85, when its session is lost; a retry would be ready.
  const f = fake({ probe: (acc, n, t) => n === 1 ? (t >= 85 ? { user: false } : { busy: ['OneDriveSetup'] }) : {} })
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /hvadmin's first-logon provisioning didn't settle within 0 s/)
  assert.ok(f.now() <= 110, `it stopped at the deadline, not a logon wait later (${f.now()})`)
  bounded(f.calls)
})

test('a logon whose readiness comes back only after the deadline is not accepted', async () => {
  // The first logon's session is lost at t 55; the retry's watcher is seen only from t 90, so readiness (seen twice,
  // 10 ms apart) would be reached at t 100 or later: past the deadline.
  const f = fake({
    watcher: (acc, n, t) => n === 1 || t >= 90,
    probe: (acc, n, t) => n === 1 ? (t >= 55 ? { user: false } : { busy: ['OneDriveSetup'] }) : {}
  })
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /hvadmin's first-logon provisioning didn't settle/)
  assert.strictEqual(f.calls.filter(c => c.op === 'guest-provisioned' && c.at >= 60).length, 0, 'the retry never got as far as its quiet wait')
  bounded(f.calls)
})

test('a session lost early: the retry runs within the same deadline and the account is provisioned', async () => {
  const f = fake({ probe: (acc, n, t) => acc === 'hvadmin' && n === 1 && t >= 30 ? { user: false } : {} })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.deepStrictEqual(Object.keys(out), ['hvadmin', 'hvuser'])
  assert.strictEqual(f.logons(), 3, 'hvadmin twice, hvuser once')
})

test('quiet is never accepted from a probe that returns after the deadline', async () => {
  const f = fake({ probe: (acc, n, t) => (t >= 100 ? {} : { busy: ['OneDriveSetup'] }) })
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /hvadmin's first-logon provisioning didn't settle/)
  bounded(f.calls)
})

test('a start\'s logon (no deadline) keeps its own wait and timeouts', async () => {
  const f = fake()
  f.h.forLease = (lease, ms) => ({ timeoutMs: ms })
  f.h.stillHeld = () => {}
  const o = await f.h.logon(vm, { leaseId: 'l' }, 'admin', creds)
  assert.ok(o.ms > 0 && !o.late)
  assert.deepStrictEqual(f.calls.filter(c => c.op === 'guest-logon').map(c => c.timeoutMs), [120_000])
  assert.ok(f.calls.filter(c => c.op === 'guest-session').every(c => c.timeoutMs === 60_000))
})

// MC-1520: a build logon still waiting at the snapshot threshold gets one read-only snapshot and goes on waiting, within
// BUILD_LOGON_WAIT_MS and the account's deadline; the snapshot is kept with the attempt; an unavailable one changes
// nothing. (This file's env: snapshot at 30, a build attempt waits up to 60, the account's budget 100.)
test('a slow build logon (MC-1520): a snapshot at the threshold, kept with the attempt that then succeeds', async () => {
  const f = fake({ watcher: (acc, n, t) => acc === 'hvuser' || t >= 45 })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  const a = out.hvadmin.attempts
  assert.strictEqual(a.length, 1)
  assert.strictEqual(a[0].why, null)
  assert.ok(a[0].logonMs >= 30, `slow: ${a[0].logonMs}`)
  assert.strictEqual(a[0].slow.uptime, 42, 'the snapshot kept, allowlisted')
  assert.strictEqual(f.calls.filter(c => c.op === 'guest-logon-diag').length, 1, 'one snapshot only')
  bounded(f.calls)
})

test('a slow build logon whose snapshot is unavailable near the deadline (MC-1520): recorded as unavailable, the outcome unchanged', async () => {
  const f = fake({ watcher: (acc, n, t) => acc === 'hvuser' || t >= 45, diagFails: true })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.deepStrictEqual(out.hvadmin.attempts[0].slow, { unavailable: true })
  assert.strictEqual(out.hvadmin.attempts[0].why, null)
  bounded(f.calls)
})

// MC-1524: a first logon Windows drops before any check: this boot's logon and logoff events, the account gone and
// autologon disarmed. The attempt ends on its first answered check, and the retry plus its full quiet still fit inside
// the account's one deadline. Armed, unreadable (null) or absent evidence never ends it.
const dropped = { sessions: [], user: false, armed: false, logons: 1, logoffs: 1 }

test('a dropped first logon (MC-1524) ends on the first answered check; the retry and its quiet fit in the deadline', async () => {
  const f = fake({ session: (acc, n) => acc === 'hvadmin' && n === 1 ? dropped : {} })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  const a = out.hvadmin.attempts
  assert.deepStrictEqual(a.map(x => [x.attempt, x.dropped, !!x.why]), [[1, true, true], [2, false, false]])
  const first = f.calls.filter(c => c.account === 'hvadmin')
  const i = first.findIndex(c => c.op === 'guest-session')
  assert.deepStrictEqual(first.slice(i, i + 3).map(c => c.op), ['guest-session', 'guest-logon-diag', 'guest-logon'], 'one check, the diagnosis, then the retry')
  assert.strictEqual(f.calls.filter(c => c.op === 'guest-session' && c.at < first[i + 2].at).length, 1)
  assert.ok(out.hvadmin.quietMs >= 20, 'the retry got its full quiet')
  assert.strictEqual(f.logons(), 3)
  bounded(f.calls)
})

for (const [label, over] of [
  ['autologon still armed (a restart pending)', { armed: true }],
  ['the events unreadable', { logons: null, logoffs: null }],
  ['no logoff event', { logoffs: 0 }],
  ['no logon event', { logons: 0 }],
  ['the account still on', { user: true }]
]) {
  test(`not a drop (MC-1524): ${label}: the attempt waits on, to its limit`, async () => {
    const f = fake({ session: (acc, n) => acc === 'hvadmin' && n === 1 ? { ...dropped, ...over } : {} })
    await f.h.provisionProfiles(vm, creds, () => {}).catch(() => {})
    const a1 = f.calls.filter(c => c.op === 'guest-session' && c.account === 'hvadmin')
    assert.ok(a1.length > 3, `${label}: it kept checking (${a1.length})`)
    bounded(f.calls)
  })
}

// MC-1526: a logon that never begins: no logon event for the account on its new boot (an integer 0), the user never
// seen. The host clock starts when the new boot is first seen (an answered probe); FIRST_LOGON_SIGN_MS (15 here) later
// the attempt ends, and the build retries within the same deadline. Any sign of a logon latches the rule off for that
// boot; a later boot starts the clock (and the latch) over; null counts and failed probes are never evidence.
const silent = { sessions: [], user: false, armed: true, logons: 0, logoffs: 0 }

test('a silent first logon (MC-1526) ends FIRST_LOGON_SIGN_MS after its new boot is first seen; the retry and its quiet fit in the deadline', async () => {
  const f = fake({ session: (acc, n) => acc === 'hvadmin' && n === 1 ? silent : {} })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  const a = out.hvadmin.attempts
  assert.deepStrictEqual(a.map(x => [x.attempt, x.silent, !!x.why]), [[1, true, true], [2, false, false]])
  assert.match(a[0].why, /^no logon of hvadmin began within 0 s of its new boot being seen$/)
  const s1 = f.calls.filter(c => c.op === 'guest-session' && c.account === 'hvadmin')
  const firstSeen = s1[0].at + 5 // the first probe answers 5 ms after it starts
  const diagAt = f.calls.find(c => c.op === 'guest-logon-diag' && c.account === 'hvadmin').at
  assert.ok(diagAt >= firstSeen + 15, `not before the sign window (${diagAt})`)
  assert.ok(diagAt < firstSeen + 15 + 10, `on the first probe after it, not at the 60 ms attempt ceiling (${diagAt})`)
  assert.ok(out.hvadmin.quietMs >= 20, 'the retry got its full quiet')
  bounded(f.calls)
})

test('a silent first logon (MC-1526): the old boot\'s probes never start the clock; it starts at the new boot', async () => {
  // The first three probes still answer the old boot (the restart not yet seen), then the new boot, silent.
  let k = 0
  const f = fake({ session: (acc, n) => acc === 'hvadmin' && n === 1 ? (++k <= 3 ? { ...silent, boot: 'b0' } : silent) : {} })
  await f.h.provisionProfiles(vm, creds, () => {}).catch(() => {}) // only the first attempt's timing matters here
  const s1 = f.calls.filter(c => c.op === 'guest-session' && c.account === 'hvadmin')
  const newBootSeen = s1[3].at + 5
  // The attempt's end: the retry's logon (the slow-logon snapshot at 30 is another diag call, so not that).
  const retryAt = f.calls.filter(c => c.op === 'guest-logon' && c.account === 'hvadmin')[1].at
  assert.ok(retryAt >= newBootSeen + 15, `timed from the new boot, not the old one (${retryAt} vs ${newBootSeen})`)
  bounded(f.calls)
})

test('a silent first logon (MC-1526): a boot change (the guest restarting by itself) starts the clock over', async () => {
  // Silent on b1 for two probes, then the guest is on b1x (restarted): the window counts from b1x.
  let k = 0
  const f = fake({ session: (acc, n) => acc === 'hvadmin' && n === 1 ? (++k <= 2 ? silent : { ...silent, boot: 'b1x' }) : {} })
  await f.h.provisionProfiles(vm, creds, () => {}).catch(() => {}) // only the first attempt's timing matters here
  const s1 = f.calls.filter(c => c.op === 'guest-session' && c.account === 'hvadmin')
  const restartSeen = s1[2].at + 5
  const retryAt = f.calls.filter(c => c.op === 'guest-logon' && c.account === 'hvadmin')[1].at
  assert.ok(retryAt >= restartSeen + 15, `timed from the restart (${retryAt} vs ${restartSeen})`)
  bounded(f.calls)
})

test('a silent first logon (MC-1526): a failed probe is no evidence and no reset; the attempt still ends on the window', async () => {
  let k = 0
  const f = fake({ session: (acc, n) => { if (acc === 'hvadmin' && n === 1 && ++k === 2) throw new Error('injected'); return acc === 'hvadmin' && n === 1 ? silent : {} } })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.strictEqual(out.hvadmin.attempts[0].silent, true)
  const s1 = f.calls.filter(c => c.op === 'guest-session' && c.account === 'hvadmin')
  const diagAt = f.calls.find(c => c.op === 'guest-logon-diag' && c.account === 'hvadmin').at
  assert.ok(diagAt < s1[0].at + 5 + 15 + 10, `the window from the first answered probe (${diagAt})`)
  bounded(f.calls)
})

for (const [label, over, waits] of [
  ['the counts unreadable (null)', { logons: null }, true],
  ['a logon event on the boot, the watcher late', { logons: 1 }, true],
  ['the user seen once (then not)', null, true]
]) {
  test(`not silent (MC-1526): ${label}: the attempt waits on`, async () => {
    let k = 0
    const f = fake({ session: (acc, n) => acc !== 'hvadmin' || n !== 1 ? {} : over ? { ...silent, ...over } : (++k === 1 ? { ...silent, user: true } : silent) })
    await f.h.provisionProfiles(vm, creds, () => {}).catch(() => {})
    const s1 = f.calls.filter(c => c.op === 'guest-session' && c.account === 'hvadmin' && c.at < 60)
    const a1 = f.calls.filter(c => c.op === 'guest-logon' && c.account === 'hvadmin')
    assert.ok(s1.length > 6, `${label}: it kept checking past the sign window (${s1.length})`)
    if (waits) assert.ok(a1.length === 1 || a1[1].at >= 60, `${label}: no retry before the attempt's own ceiling (${a1.map(x => x.at)})`)
    bounded(f.calls)
  })
}

test('a silent logon twice (MC-1526): both attempts fail and the build fails in full, inside the deadline', async () => {
  const f = fake({ session: acc => acc === 'hvadmin' ? silent : {} })
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /provisioning hvadmin's profile failed twice: no logon of hvadmin began within 0 s of its new boot being seen/)
  bounded(f.calls)
})
