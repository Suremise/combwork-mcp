// The build's per-account budget (MC-1520, the user's scope decision: 30 min), on a fake clock at its proportions
// (budget 300, a logon attempt up to 150, the snapshot at 100, quiet 40): a first attempt that times out still leaves a
// retry its logon and its full quiet window; an AppContainer count change late in the window starts quiet over; counts
// that never settle exhaust the budget. core.js's own provisionProfiles, logon and waitProvisioned run on a bare object
// with a fake transport and a clock that moves only by its calls (guest-logon 10, a probe 5, the undo 5).
process.env.HYPERV_MCP_PROVISION_WAIT_MS = '300'
process.env.HYPERV_MCP_PROVISION_DWELL_MS = '0' // the dwell (MC-1527) has its own file, provision-dwell.test.js
process.env.HYPERV_MCP_PROVISION_QUIET_MS = '40'
process.env.HYPERV_MCP_PROVISION_POLL_MS = '1'
process.env.HYPERV_MCP_POLL_MS = '1'
process.env.HYPERV_MCP_LOGON_STABLE_MS = '10'
process.env.HYPERV_MCP_BUILD_LOGON_WAIT_MS = '150'
process.env.HYPERV_MCP_LOGON_SNAPSHOT_MS = '100'
const test = require('node:test')
const assert = require('assert')
const { Helper } = require('../helper/core')

const vm = { vmId: 'v', vmName: 'hvmcp-test', folder: 'X:\\pool\\i-0' }
const creds = { admin: { user: 'hvadmin', password: 'a' }, user: { user: 'hvuser', password: 'u' } }

function fake({ watcher = () => true, counts = () => ({ mappings: 60, packagesDirs: 25 }) } = {}) {
  const h = Object.create(Helper.prototype)
  let t = 0
  let logons = 0
  let account = null
  const calls = []
  h.now = () => t
  h.log = () => {}
  h.undoLogon = async () => { t += 5 }
  h.hv = async (op, a, opts) => {
    calls.push({ op, at: t, timeoutMs: opts?.timeoutMs, account: a.account || a.logon?.user })
    if (op === 'guest-logon') { const before = `b${logons}`; logons++; account = a.logon.user; t += 10; return { boot: before } }
    if (op === 'guest-session') { t += 5; return { boot: `b${logons}`, sessions: watcher(account, logons, t) ? [1] : [], user: true, armed: true } }
    if (op === 'guest-provisioned') { t += 5; return { boot: `b${logons}`, user: true, inventory: 'x', lastEvent: null, busy: [], count: 1, ...counts(a.account, logons, t) } }
    if (op === 'guest-logon-diag') { t += 5; return { uptime: t, logs: {}, processes: [], autoAdminLogon: '1', watcher: false } }
    throw new Error(`unexpected ${op}`)
  }
  return { h, calls, now: () => t }
}

test('a first attempt that times out still leaves the retry its logon and its full quiet window, within the one budget', async () => {
  // hvadmin's first logon never gets its watcher; the retry's does at once.
  const f = fake({ watcher: (acc, n) => !(acc === 'hvadmin' && n === 1) })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  const a = out.hvadmin.attempts
  assert.strictEqual(a.length, 2)
  assert.match(a[0].why, /hvadmin logged on, but its watcher didn't start/)
  assert.ok(a[0].slow && !a[0].slow.unavailable, 'the attempt was snapshotted at the threshold')
  assert.ok(a[0].diag && !a[0].diag.unavailable, 'and diagnosed before its undo')
  assert.strictEqual(a[1].why, null)
  assert.ok(out.hvadmin.quietMs >= 40, 'the retry had its full quiet window')
  const last = f.calls.filter(c => c.account === 'hvadmin').at(-1)
  assert.ok(last.at < 300, `all of hvadmin's work inside its budget (${last.at})`)
})

test('an AppContainer count that changes late in the quiet window starts quiet over', async () => {
  // Counts hold from the start, then one more mapping appears at t >= 55 (late in the first 40-unit window).
  const f = fake({ counts: (acc, n, t) => ({ mappings: acc === 'hvadmin' && t >= 55 ? 61 : 60, packagesDirs: 25 }) })
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.strictEqual(out.hvadmin.mappings, 61)
  const quietEnd = f.calls.filter(c => c.account === 'hvadmin' && c.op === 'guest-provisioned').at(-1).at
  assert.ok(quietEnd >= 55 + 40, `quiet started over after the change (${quietEnd})`)
})

test('counts that never settle exhaust the account\'s budget: the build fails, and nothing runs past it', async () => {
  const f = fake({ counts: (acc, n, t) => ({ mappings: acc === 'hvadmin' ? t : 60, packagesDirs: 25 }) })
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /hvadmin's first-logon provisioning didn't settle/)
  for (const c of f.calls.filter(x => x.account === 'hvadmin')) assert.ok(c.at < 300 && c.timeoutMs <= 300 - c.at, JSON.stringify(c))
})
