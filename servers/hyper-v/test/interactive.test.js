// vm_run in a logged-on interactive session (MC-1503), through server.js (direct mode) and helper.js against the stub
// Hyper-V: vm_start's interactive logon (one guest restart, the disk kept), runs in that session only as its account,
// vm_reset keeping it and a restore logging nobody on, a warm session's sync across it, an interactive run that doesn't
// finish cleanly (a timeout, no launch, a failure) restoring the VM once its output is read, the password never in a
// reply or the journal, and a helper that predates the protocol refused. The session itself (the task in session >= 1,
// and a desktop made there) is the real-VM trial's.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { scratch, withPool, waitFor } = require('./helpers')
const { server } = require('../client')

const vmOf = (sc, name) => Object.values(sc.stub().vms).find(v => v.name === name)

async function session(t, name) {
  const sc = scratch(name)
  const { h } = await withPool(sc, 1)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home') }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  const vm = /Leased (hvmcp-[0-9a-f]+)/.exec((await s.call('vm_acquire', { minutes: 30 })).text)[1]
  return { sc, s, vm, app: path.join(sc.builds, 'app') }
}

test('an interactive start logs the user on after one restart; its runs are in that session, others still in session 0', async t => {
  const { sc, s, vm, app } = await session(t, 'ia-start')
  const started = await s.call('vm_start', { build: app, interactive: 'user' })
  assert.match(started.text, /hvuser logged on interactively after a guest restart .*session: 'interactive', as: 'user'/)
  assert.match(started.text, /build copied in to C:\\build \(2 files/)
  assert.strictEqual(vmOf(sc, vm).loggedOn, 'hvuser')
  assert.match((await s.call('vm_status')).text, /running, the standard user logged on interactively until/)
  const inSession = await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })
  assert.match(inSession.text, /Exit code 0 \(in the interactive session\)\.\n--- stdout ---\nhvuser session 1\n/)
  assert.ok(!inSession.isError)
  // The service session is unchanged beside it.
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user' })).text, /--- stdout ---\nhvuser/)
  assert.match((await s.call('vm_run', { command: 'whoami' })).text, /--- stdout ---\nadmin/)
  assert.match((await s.call('vm_run', { command: 'exit 3', as: 'user', session: 'interactive' })).text, /Exit code 3 \(in the interactive session\)/)
})

test('the admin logon is elevated (UAC\'s Admin Approval Mode off) and the user\'s is not; service runs go on beside both', async t => {
  const { sc, s, vm } = await session(t, 'ia-elevation')
  await s.call('vm_start', { interactive: 'user' })
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /--- stdout ---\nhvuser session 1\n/)
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user' })).text, /--- stdout ---\nhvuser/)
  assert.match((await s.call('vm_run', { command: 'whoami' })).text, /--- stdout ---\nadmin/)
  await s.call('vm_reset', { interactive: 'admin' })
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'admin', session: 'interactive' })).text, /--- stdout ---\nhvadmin session 1 elevated\n/)
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user' })).text, /--- stdout ---\nhvuser/)
  assert.match((await s.call('vm_run', { command: 'whoami' })).text, /--- stdout ---\nadmin/)
  assert.deepStrictEqual(vmOf(sc, vm).logons, [{ user: 'hvuser', elevated: false }, { user: 'hvadmin', elevated: true }])
})

test('the logon waits out the guest\'s own extra restart: the watcher must be seen twice on one boot', async t => {
  const { sc, s, vm } = await session(t, 'ia-extra-restart')
  sc.patchStub(st => { st.extraRestart = true })
  assert.match((await s.call('vm_start', { interactive: 'user' })).text, /hvuser logged on interactively/)
  assert.ok(vmOf(sc, vm).sessionChecks >= 3, 'seen, a restart, then seen twice on the new boot')
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /hvuser session 1/)
})

test('a watcher that has gone: the run is never taken, and the VM is restored', async t => {
  const { sc, s, vm } = await session(t, 'ia-no-watcher')
  await s.call('vm_start', { interactive: 'user' })
  await s.call('vm_run', { command: 'killwatcher', as: 'user', session: 'interactive' })
  const r0 = vmOf(sc, vm).restores
  const r = await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })
  assert.ok(r.isError)
  assert.match(r.text, /didn't finish cleanly \(the session's watcher never took the run .*The VM was restored/)
  assert.strictEqual(vmOf(sc, vm).restores, r0 + 1)
})

test('admin logon: runs elevated in its session, as admin only', async t => {
  const { s } = await session(t, 'ia-admin')
  await s.call('vm_start', { interactive: 'admin' })
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'admin', session: 'interactive' })).text, /hvadmin session 1 elevated/)
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /The interactive session is the admin's: run it with as: 'admin'/)
})

test('refused: an interactive run with nobody logged on, as another account, bad values; a logon that never appears', async t => {
  const { sc, s } = await session(t, 'ia-refuse')
  await s.call('vm_start')
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /No one is logged on interactively .*interactive: 'user' or 'admin' first/)
  assert.match((await s.call('vm_run', { command: 'whoami', session: 'desktop' })).text, /session must be 'service' or 'interactive'/)
  assert.match((await s.call('vm_start', { interactive: 'guest' })).text, /interactive must be false, 'user' or 'admin'/)
  await s.call('vm_start', { interactive: 'user' })
  assert.match((await s.call('vm_run', { command: 'whoami', session: 'interactive' })).text, /The interactive session is the standard user's: run it with as: 'user'/)
  sc.patchStub(st => { st.logonNeverAppears = true })
  const r = await s.call('vm_start', { interactive: 'user' })
  assert.ok(r.isError)
  assert.match(r.text, /restarted to log hvuser on, but no interactive session of it appeared/)
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /No one is logged on interactively/)
})

test('vm_reset keeps interactive (or takes a new value); a stop logs nobody on; a warm sync goes on across the logon', async t => {
  const { sc, s, vm, app } = await session(t, 'ia-reset')
  await s.call('vm_start', { build: app, interactive: 'user' })
  const restores = vmOf(sc, vm).restores
  // The logon restart kept the disk: the sync record still matches C:\build.
  fs.writeFileSync(path.join(app, 'setup.exe'), 'MZ-v2')
  assert.match((await s.call('vm_sync')).text, /1 file\(s\) copied .*0 removed, 1 unchanged/)
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /hvuser session 1/)
  assert.match((await s.call('vm_reset')).text, /hvuser logged on interactively/)
  assert.strictEqual(vmOf(sc, vm).restores, restores + 1)
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /hvuser session 1/)
  assert.doesNotMatch((await s.call('vm_reset', { interactive: false })).text, /logged on/)
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /No one is logged on interactively/)
  await s.call('vm_start', { interactive: 'user' })
  assert.match((await s.call('vm_stop')).text, /Reverted/)
  assert.strictEqual(vmOf(sc, vm).loggedOn, null)
})

test('an interactive run that doesn\'t finish cleanly restores the VM, after its output is read', async t => {
  const { sc, s, vm, app } = await session(t, 'ia-unclean')
  await s.call('vm_start', { build: app, interactive: 'user' })
  const restores = () => vmOf(sc, vm).restores
  // A timeout: the output so far is in the reply, then the VM is restored (Off, nobody logged on).
  let r0 = restores()
  const timedOut = await s.call('vm_run', { command: 'sleep', as: 'user', session: 'interactive', timeoutSec: 1 })
  assert.ok(timedOut.isError)
  assert.match(timedOut.text, /^The interactive run didn't finish cleanly \(no exit within 1 s\)\. The VM was restored to its clean checkpoint, which ends everything the run started .*vm_start or vm_reset to go on\.\n--- stdout ---\npartial/)
  assert.strictEqual(restores(), r0 + 1)
  assert.strictEqual(vmOf(sc, vm).state, 'Off')
  assert.strictEqual(vmOf(sc, vm).loggedOn, null)
  assert.match((await s.call('vm_run', { command: 'whoami' })).text, /The VM is not running: call vm_start first/)
  assert.match((await s.call('vm_sync')).text, /The VM is not running/)
  // vm_reset brings back the logged-on session and the build.
  assert.match((await s.call('vm_reset')).text, /hvuser logged on interactively.*build copied in/)
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /hvuser session 1/)
  // A run that never starts (the account logged off meanwhile), and a failure of the run itself: restored too.
  await s.call('vm_run', { command: 'logoff', as: 'user', session: 'interactive' })
  r0 = restores()
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /didn't finish cleanly \(the session's watcher never took the run \(is the account still logged on\?\)/)
  assert.strictEqual(restores(), r0 + 1)
  await s.call('vm_reset')
  sc.patchStub(st => { st.interactiveThrows = true })
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /didn't finish cleanly \(guest-run: injected failure of the interactive run\)\. The VM was restored/)
  assert.strictEqual(restores(), r0 + 3)
  // A session-0 run's timeout is as before: killed by its PID, no restore.
  await s.call('vm_reset')
  const before = restores()
  assert.match((await s.call('vm_run', { command: 'sleep', timeoutSec: 1 })).text, /Timed out after 1 s: killed inside the guest by its PID/)
  assert.strictEqual(restores(), before)
})

test('a run queued behind an interactive run whose restore fails never reaches the guest', async t => {
  // Overlapping requests on one connection (direct mode doesn't serialise them): an interactive run holds the VM's
  // lock, a service-session run queues behind it, the interactive run times out and its restore fails (quarantined).
  // The queued run must be refused inside the lock, not run in the still-running, unclean VM. In-process, as direct
  // mode runs the helper (helper.js answers one connection's requests in turn, so it can't overlap them).
  const sc = scratch('ia-queued')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const saved = { ...process.env }
  Object.assign(process.env, { HYPERV_MCP_PS_STUB: sc.env.HYPERV_MCP_PS_STUB, HYPERV_MCP_STUB_STATE: sc.env.HYPERV_MCP_STUB_STATE, HYPERV_MCP_POLL_MS: '10', HYPERV_MCP_READY_WAIT_MS: '3000', HYPERV_MCP_LOGON_STABLE_MS: '30' })
  const { Helper } = require('../helper/core')
  const { hv } = require('../helper/hv')
  const helper = new Helper({ stateDir: sc.stateDir, hv, checkApprovalAcl: false })
  await helper.init()
  t.after(() => { helper.close(); process.env = saved })
  helper.connect('a', 1)
  const vmName = /Leased (hvmcp-[0-9a-f]+)/.exec((await helper.request('a', 'acquire', { minutes: 30 })).text)[1]
  await helper.request('a', 'start', { interactive: 'user' })
  const reached = path.join(sc.dir, 'run.reached')
  const gate = path.join(sc.dir, 'run.gate')
  sc.patchStub(st => { st.interactiveGate = gate; st.interactiveReached = reached })
  const first = helper.request('a', 'run', { command: 'sleep', as: 'user', session: 'interactive', timeoutSec: 1 })
  await waitFor(() => fs.existsSync(reached), 15_000, 'the interactive run to hold the lock')
  // Queued behind it: it passes the check before the lock, as the VM is still running now.
  const second = helper.request('a', 'run', { command: 'echo queued' }).then(r => ({ r }), e => ({ e }))
  sc.patchStub(st => { st.fail = { restore: 1 }; delete st.interactiveGate })
  fs.writeFileSync(gate, '')
  const r1 = await first
  assert.match(r1.text, /didn't finish cleanly .*Restoring the VM to end what it started failed: CLEANUP FAILED/)
  const r2 = await second
  assert.ok(r2.e, `the queued run ran: ${r2.r?.text}`)
  assert.match(r2.e.message, /The VM is not running \(it was stopped or restored while this run waited\)/)
  const runs = sc.stub().calls.filter(x => x.op === 'guest-run')
  assert.deepStrictEqual(runs.map(x => x.command), ['sleep'], 'only the interactive run reached the guest')
  assert.match((await helper.request('a', 'status')).text, new RegExp(`${vmName}: .*QUARANTINED`))
  // A read queued the same way is refused too.
  await assert.rejects(helper.request('a', 'read_out', {}), /The VM is not running/)
})

test('the logon password goes to the guest on stdin only: never in a reply, the journal or the stub\'s call log', async t => {
  const { sc, s } = await session(t, 'ia-secret')
  const replies = [await s.call('vm_start', { interactive: 'user' }), await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' }), await s.call('vm_status')]
  const { user } = JSON.parse(fs.readFileSync(path.join(sc.stateDir, 'secrets', 'guest.json'), 'utf8'))
  for (const r of replies) assert.ok(!JSON.stringify(r).includes(user.password))
  assert.ok(!fs.readFileSync(path.join(sc.stateDir, 'journal.jsonl'), 'utf8').includes(user.password))
  assert.ok(!fs.readFileSync(sc.stubState, 'utf8').includes(user.password))
  assert.ok(sc.stub().calls.some(c => c.op === 'guest-logon'))
})

test('a helper that predates the interactive session is refused before anything runs, not silently in session 0', async t => {
  const sc = scratch('ia-old-helper')
  const { h } = await withPool(sc, 1)
  await h.stop()
  // An older helper: the same helper made to answer the previous protocol.
  const shim = path.join(sc.dir, 'old-core.js')
  fs.writeFileSync(shim, `const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') return { text: 'hyperv-mcp/2', data: { protocol: 'hyperv-mcp/2', buildRoots: [] } }
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  await s.call('vm_acquire', { minutes: 30 })
  const r = await s.call('vm_start', { interactive: 'user' })
  assert.ok(r.isError)
  assert.match(r.text, /The helper speaks hyperv-mcp\/2, and the interactive session needs hyperv-mcp\/3: run setup again/)
  assert.ok(!sc.stub().calls.some(c => c.op === 'guest-logon'))
  await s.call('vm_start')
  assert.match((await s.call('vm_run', { command: 'whoami', as: 'user', session: 'interactive' })).text, /needs hyperv-mcp\/3/)
})
