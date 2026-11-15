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
const test = require('node:test')
const assert = require('assert')
const { Helper } = require('../helper/core')

const vm = { vmId: 'v', vmName: 'hvmcp-test', folder: 'X:\\pool\\i-0' }
const creds = { admin: { user: 'hvadmin', password: 'a' }, user: { user: 'hvuser', password: 'u' } }

/**
 * A helper on the fake clock. watcher(account, logonNo, t): whether the session's watcher is seen; probe(account,
 * logonNo, t): fields over a quiet, logged-on provisioning sample.
 */
function fake({ watcher = () => true, probe = () => ({}) } = {}) {
  const h = Object.create(Helper.prototype)
  let t = 0
  let logons = 0
  let account = null
  const calls = []
  h.now = () => t
  h.undoLogon = async () => { t += 5 }
  h.hv = async (op, a, opts) => {
    calls.push({ op, at: t, timeoutMs: opts?.timeoutMs })
    if (op === 'guest-logon') { const before = `b${logons}`; logons++; account = a.logon.user; t += 10; return { boot: before } }
    if (op === 'guest-session') { t += 5; const w = watcher(account, logons, t); return { boot: `b${logons}`, sessions: w ? [1] : [], user: true, armed: true } }
    if (op === 'guest-provisioned') { t += 5; return { boot: `b${logons}`, user: true, inventory: 'x', lastEvent: null, busy: [], count: 1, ...probe(a.account, logons, t) } }
    throw new Error(`unexpected ${op}`)
  }
  return { h, calls, logons: () => logons, now: () => t }
}

/** Every call made before the deadline was bounded by the time left; none started after it. */
function bounded(calls, deadline = 100) {
  for (const c of calls) {
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
  const f = fake({ probe: (acc, n, t) => acc === 'hvadmin' && n === 1 && t >= 40 ? { user: false } : {} })
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
