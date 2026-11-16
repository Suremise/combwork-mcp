// The build's per-account dwell (MC-1527), on a fake clock: no acceptance before PROVISION_DWELL_MS after the attempt's
// readiness, even when quiet from the start; dwell and quiet run together (acceptance at the first sample with both);
// a wave late in the dwell (counts changing) pushes acceptance to the quiet after it, with the post-wave counts kept;
// a dwell that can't end before the account's deadline is late at once (the boundary too); a retry's dwell counts from
// its own readiness; every call bounded by the time left. core.js's own provisionProfiles, logon and waitProvisioned
// on a bare object, with a clock that moves only by its calls: guest-logon 10, guest-session 5, guest-provisioned 5.
process.env.HYPERV_MCP_PROVISION_WAIT_MS = '200'
process.env.HYPERV_MCP_PROVISION_DWELL_MS = '60'
process.env.HYPERV_MCP_PROVISION_QUIET_MS = '20'
process.env.HYPERV_MCP_PROVISION_POLL_MS = '1'
process.env.HYPERV_MCP_POLL_MS = '1'
process.env.HYPERV_MCP_LOGON_STABLE_MS = '10'
process.env.HYPERV_MCP_BUILD_LOGON_WAIT_MS = '100'
process.env.HYPERV_MCP_LOGON_SNAPSHOT_MS = '90'
process.env.HYPERV_MCP_FIRST_LOGON_SIGN_MS = '15'
const test = require('node:test')
const assert = require('assert')
const { Helper } = require('../helper/core')

const vm = { vmId: 'v', vmName: 'hvmcp-test', folder: 'X:\\pool\\i-0' }
const creds = { admin: { user: 'hvadmin', password: 'a' }, user: { user: 'hvuser', password: 'u' } }

/** A helper on the fake clock. probe(account, logonNo, t, sinceReady): fields over a quiet, logged-on sample. */
function fake({ probe = () => ({}), session = () => ({}) } = {}) {
  const h = Object.create(Helper.prototype)
  let t = 0
  let logons = 0
  let account = null
  let ready = null // the first provisioning probe of this logon: just after waitProvisioned's start (its readiness)
  const calls = []
  h.now = () => t
  h.undoLogon = async () => { t += 5 }
  h.log = () => {}
  h.hv = async (op, a, opts) => {
    calls.push({ op, at: t, timeoutMs: opts?.timeoutMs, account: a.account || a.logon?.user, logon: logons })
    if (op === 'guest-logon') { const before = `b${logons}`; logons++; account = a.logon.user; ready = null; t += 10; return { boot: before } }
    if (op === 'guest-session') { t += 5; return { boot: `b${logons}`, sessions: [1], user: true, armed: true, logons: 1, logoffs: 0, ...session(account, logons, t) } }
    if (op === 'guest-provisioned') {
      if (ready === null) ready = t
      t += 5
      return { boot: `b${logons}`, user: true, inventory: 'x', lastEvent: null, busy: [], count: 1, mappings: 62, packagesDirs: 27, ...probe(a.account, logons, t, t - ready) }
    }
    if (op === 'guest-logon-diag') { t += 5; return { uptime: 1, logs: {}, processes: [], autoAdminLogon: '1', watcher: false } }
    throw new Error(`unexpected ${op}`)
  }
  return { h, calls, now: () => t }
}

/** The account's first provisioning probe of attempt n (its readiness), and its last. */
const probes = (calls, account, n = 1) => calls.filter(c => c.op === 'guest-provisioned' && c.account === account && c.logon === n + (account === 'hvuser' ? 1 : 0))

function bounded(calls, account, deadline) {
  for (const c of calls.filter(x => x.account === account)) {
    assert.ok(c.at < deadline, `no call started at or after the deadline: ${JSON.stringify(c)}`)
    assert.ok(c.timeoutMs >= 1 && c.timeoutMs <= deadline - c.at, `bounded by the time left: ${JSON.stringify(c)}`)
  }
}

test('quiet from the start: no acceptance before the dwell; accepted at the first sample with dwell and quiet both held', async () => {
  const f = fake()
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  for (const who of ['hvadmin', 'hvuser']) {
    const p = probes(f.calls, who)
    const readyAt = p[0].at
    assert.ok(out[who].quietMs >= 60, `${who}: not before the dwell (${out[who].quietMs})`)
    assert.ok(out[who].quietMs < 60 + 10, `${who}: on the first sample past it, not a quiet window later (${out[who].quietMs})`)
    assert.strictEqual(out[who].dwellMs, 60)
    assert.ok(p.at(-1).at - readyAt < 70)
  }
  bounded(f.calls, 'hvadmin', 200)
})

test('a wave late in the dwell: the counts change, quiet starts over, and the post-wave counts are the ones accepted', async () => {
  // At 50 into the dwell the account's AppContainer wave lands: 62/27 → 100/66.
  const f = fake({ probe: (acc, n, t, since) => since >= 50 ? { mappings: 100, packagesDirs: 66 } : {} })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.strictEqual(out.hvadmin.mappings, 100)
  assert.strictEqual(out.hvadmin.packagesDirs, 66)
  assert.ok(out.hvadmin.quietMs >= 50 + 20, `a full quiet after the wave (${out.hvadmin.quietMs})`)
  bounded(f.calls, 'hvadmin', 200)
})

test('a retry whose remaining budget can\'t hold the dwell is late at once, with no polling; the boundary (exactly at the deadline) too', async () => {
  // hvadmin's first session is lost at 135 into its budget (busy until then); the retry's readiness then leaves under 60.
  const f = fake({ probe: (acc, n, t) => acc === 'hvadmin' && n === 1 ? (t >= 135 ? { user: false } : { busy: ['OneDriveSetup'] }) : {} })
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /hvadmin's first-logon provisioning didn't settle/)
  assert.strictEqual(probes(f.calls, 'hvadmin', 2).length, 0, 'the retry never polled')
  bounded(f.calls, 'hvadmin', 200)
  // The boundary, on waitProvisioned itself: readiness + dwell exactly at the deadline is late; one tick before isn't.
  const g = fake()
  await assert.rejects(g.h.waitProvisioned(vm, creds, 'hvadmin', 'b0', 60), /didn't settle/)
  assert.strictEqual(g.calls.length, 0, 'no probe at all')
  const k = fake({ probe: () => ({ boot: 'b0' }) })
  // One tick more: it polls, and its sample at 60 holds both dwell and quiet just inside the deadline.
  const r = await k.h.waitProvisioned(vm, creds, 'hvadmin', 'b0', 61)
  assert.strictEqual(r.ms, 60)
  bounded(k.calls, 'hvadmin', 61)
})

test('a retry\'s dwell counts from its own readiness, inside the same deadline', async () => {
  // hvadmin's first session is lost at 30; the retry's readiness comes later and its dwell is counted from there.
  const f = fake({ probe: (acc, n, t) => acc === 'hvadmin' && n === 1 && t >= 30 ? { user: false } : {} })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.strictEqual(out.hvadmin.attempts.length, 2)
  const p2 = probes(f.calls, 'hvadmin', 2)
  assert.ok(p2.at(-1).at + 5 - p2[0].at >= 60, 'the retry waited its own dwell')
  bounded(f.calls, 'hvadmin', 200)
})
