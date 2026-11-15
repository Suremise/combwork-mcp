// The build's provisioning budget (MC-1516), on a fake clock: each account has one PROVISION_WAIT_MS deadline, and a
// lost-session retry gets no new allowance; each probe's call is bounded by the time left, and nothing it returns after
// the deadline is accepted. The methods are core.js's own, run on a bare object with a fake transport and clock.
process.env.HYPERV_MCP_PROVISION_WAIT_MS = '100'
process.env.HYPERV_MCP_PROVISION_QUIET_MS = '20'
process.env.HYPERV_MCP_PROVISION_POLL_MS = '1'
const test = require('node:test')
const assert = require('assert')
const { Helper } = require('../helper/core')

const vm = { vmId: 'v', vmName: 'hvmcp-test', folder: 'X:\\pool\\i-0' }
const creds = { admin: { user: 'hvadmin', password: 'a' }, user: { user: 'hvuser', password: 'u' } }

/** A helper whose clock moves only by its calls: a logon 10 ms, a probe 5 ms, an undo 5 ms. probe(account, logonNo, t). */
function fake(probe) {
  const h = Object.create(Helper.prototype)
  let t = 0
  let logons = 0
  const timeouts = []
  h.now = () => t
  h.logon = async () => { logons++; t += 10; return { ms: 10, boot: `b${logons}` } }
  h.undoLogon = async () => { t += 5 }
  h.hv = async (op, a, opts) => {
    assert.strictEqual(op, 'guest-provisioned')
    timeouts.push({ at: t, timeoutMs: opts.timeoutMs })
    t += 5
    return { boot: `b${logons}`, user: true, inventory: 'x', lastEvent: null, busy: [], count: 1, ...probe(a.account, logons, t) }
  }
  return { h, timeouts, logons: () => logons, now: () => t }
}

test('a session lost near the deadline: the retry gets no new allowance, and the build fails at the account\'s one deadline', async () => {
  // hvadmin is busy until t 90, then its session is lost; a retry would be quiet at once.
  const f = fake((account, n, t) => n === 1 ? (t >= 90 ? { user: false } : { busy: ['OneDriveSetup'] }) : {})
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /hvadmin's first-logon provisioning didn't settle within 0 s/)
  assert.ok(f.now() <= 110, `stopped at the deadline, not 100 ms later (${f.now()})`)
  for (const c of f.timeouts) assert.ok(c.timeoutMs <= 100 - c.at && c.timeoutMs >= 1, `a probe's call bounded by the time left: ${JSON.stringify(c)}`)
})

test('a session lost early: the retry runs within the same deadline and the account is provisioned', async () => {
  const f = fake((account, n, t) => account === 'hvadmin' && n === 1 && t >= 30 ? { user: false } : {})
  const out = await f.h.provisionProfiles(vm, creds, () => {})
  assert.deepStrictEqual(Object.keys(out), ['hvadmin', 'hvuser'])
  assert.strictEqual(f.logons(), 3, 'hvadmin twice, hvuser once')
})

test('quiet is never accepted from a probe that returns after the deadline', async () => {
  // Busy until the very end; the last probe starts before the deadline and returns after it, quiet.
  const f = fake((account, n, t) => (t >= 100 ? {} : { busy: ['OneDriveSetup'] }))
  await assert.rejects(f.h.provisionProfiles(vm, creds, () => {}), /hvadmin's first-logon provisioning didn't settle/)
})
