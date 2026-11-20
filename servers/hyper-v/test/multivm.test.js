// MC-1580: more than one VM per session. One connection (one agent's session) holds several leases, each counted
// against the same caps and line; every lease op names its VM with vm, or uses the session's only one; with several and
// no vm, it is refused naming them. A disconnect ends them all; one lease's end leaves the others. server.js resolves a
// tool's VM from the helper's live leases (never from what it remembers), keeps vm_reset's and vm_sync's defaults per
// VM, and never sends a vm selector to a helper without 'multi-vm'.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { T, scratch, startHelper, withPool, waitFor, STUB } = require('./helpers')
const { server } = require('../client')

const acquire = (c, args) => c.request('acquire', { minutes: 30, ...args }).then(r => r, e => ({ error: e.message }))
const vmOf = (sc, name) => Object.values(sc.stub().vms).find(v => v.name === name)

// ---------- the helper ----------

test('one connection holds two VMs: starts and runs in each by vm, then releases both; vm left out is refused naming them', async t => {
  const sc = scratch('mv-two')
  const { h } = await withPool(sc, 2)
  t.after(() => h.stop())
  const a = h.conn(10)
  const A = (await a.request('acquire', { minutes: 30 })).data.vm
  assert.match((await a.request('run', { command: 'whoami' }).catch(e => ({ text: e.message }))).text, /not running: call vm_start/, 'one VM held: vm may be left out')
  const B = (await a.request('acquire', { minutes: 30 })).data.vm
  assert.notStrictEqual(A, B)
  assert.deepStrictEqual((await a.request('leases')).data.leases.map(l => l.vm).sort(), [A, B].sort())
  for (const op of ['start', 'run', 'stop', 'release', 'renew', 'read_out', 'checkpoint']) {
    await assert.rejects(a.request(op, { command: 'whoami', name: 'x' }), new RegExp(`This session holds 2 VMs \\(.*${A}.*${B}|This session holds 2 VMs \\(.*${B}.*${A}`), op)
  }
  await assert.rejects(a.request('start', { vm: 'hvmcp-00000000' }), /This session holds no VM named hvmcp-00000000 \(it holds /)
  await a.request('start', { vm: A }); await a.request('start', { vm: B })
  assert.strictEqual(vmOf(sc, A).state, 'Running')
  assert.strictEqual(vmOf(sc, B).state, 'Running')
  assert.match((await a.request('run', { vm: A, command: 'whoami' })).text, /admin/)
  assert.match((await a.request('run', { vm: B, command: 'whoami', as: 'user' })).text, /hvuser/)
  assert.strictEqual(((await a.request('status')).text.match(/\(yours\)/g) || []).length, 2)
  assert.match((await a.request('release', { vm: A })).text, /^Released/)
  assert.deepStrictEqual((await a.request('leases')).data.leases.map(l => l.vm), [B], 'the other is untouched')
  assert.match((await a.request('run', { command: 'whoami' })).text, /admin/, 'one left: vm may be left out again')
  assert.match((await a.request('release')).text, /^Released/)
  assert.deepStrictEqual((await a.request('leases')).data.leases, [])
})

test('a second lease counts toward the project cap and waits in line like any other', async t => {
  // A project with a cap of 2 Windows VMs, on a pool of 3.
  const proj = path.join(scratch('mv-cap-dirs').dir, 'proj')
  fs.mkdirSync(proj, { recursive: true })
  const sc = scratch('mv-cap', { policy: { maxVms: 3, projects: [{ name: 'p', folders: [proj], maxVms: 2 }] } })
  const { h } = await withPool(sc, 3)
  t.after(() => h.stop())
  const a = h.conn(10)
  assert.match((await acquire(a, { roots: [proj] })).text, /for project p/)
  assert.match((await acquire(a, { roots: [proj] })).text, /for project p/, 'its second, within the cap')
  assert.match((await acquire(a, { roots: [proj] })).error, /^No VM for you now: project p holds its windows cap of 2/, 'its third: the cap holds')
})

test('a disconnect ends every lease the connection holds; one lease\'s end leaves the other', async t => {
  const sc = scratch('mv-end')
  const { h, admin } = await withPool(sc, 2)
  t.after(() => h.stop())
  const a = h.conn(10)
  const A = (await a.request('acquire', { minutes: 30 })).data.vm
  const B = (await a.request('acquire', { minutes: 30 })).data.vm
  await a.request('start', { vm: A }); await a.request('start', { vm: B })
  a.close()
  await waitFor(async () => ((await admin.request('status')).text.match(/; free/g) || []).length === 2, T.waitForMs, 'both leases ended and both VMs free')
  assert.strictEqual(vmOf(sc, A).state, 'Off')
  assert.strictEqual(vmOf(sc, B).state, 'Off')
})

// ---------- the stubs' state (MC-1594) ----------

// The disconnect test above failed about half the time: the disconnect's two restores ran as two stub processes at
// once, and the later one's save put back the other VM as it had read it (Running), so that VM was quarantined
// ("state is Running, not Off") and never freed. Calls on different VMs at once must each keep their own change, as on
// Hyper-V; every write of the state is made under one ownership-safe lock (stub-state.js).

/**
 * Child processes a test starts (node with args): each ended when the test ends, pass or fail (killed if still
 * running, and waited for). ch.done: { code, out } once it exits.
 */
function kids(t) {
  const all = new Set()
  t.after(async () => {
    await Promise.all([...all].map(ch => ch.exitCode !== null || ch.signalCode !== null ? null : new Promise(r => { ch.on('exit', r); ch.kill() })))
  })
  return (args, opts = {}) => {
    const ch = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, ...opts })
    all.add(ch)
    let out = ''
    ch.stdout.on('data', d => { out += d })
    ch.done = new Promise((resolve, reject) => { ch.on('error', reject); ch.on('exit', code => resolve({ code, out })) })
    ch.done.catch(() => {}) // read where awaited; a test that fails first leaves it to the cleanup
    return ch
  }
}
const STATE_JS = path.join(__dirname, 'stub-state.js')
const NO_STDIN = { stdio: ['ignore', 'pipe', 'inherit'] }
/** node -e: a child that takes the lock, writes held (its pid), and keeps it until gate exists (or it is killed). */
const HOLDER = `const fs = require('fs'); const [js, file, held, gate] = process.argv.slice(1)
require(js).withLock(file, () => { fs.writeFileSync(held, String(process.pid)); while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) })`
/**
 * node -e: a child that takes the lock and writes entered. Its first refusal (the lock found held, not clearable)
 * writes tried: the owner file it was kept out by, read at that moment.
 */
const ENTER = `const fs = require('fs'); const [js, file, tried, entered] = process.argv.slice(1)
const owner = () => { try { return fs.readFileSync(file + '.lock/owner', 'utf8') } catch { return '' } }
require(js).withLock(file, () => fs.writeFileSync(entered, 'entered'), { onRefused: n => { if (n === 1) fs.writeFileSync(tried, owner()) } })`
/** Waits until the lock folder is old enough that only a live holder keeps it from being cleared as stale. */
const lockAged = (lock, STALE_MS) => waitFor(() => Date.now() - fs.statSync(lock).birthtimeMs >= STALE_MS, T.waitForMs, 'the lock folder old enough to look stale')
/** node -e: a child that adds 1 to the counter n times, each a patch under the lock. */
const COUNTER = `const [js, file, n] = process.argv.slice(1)
for (let i = 0; i < Number(n); i++) require(js).patch(file, s => { s.count = (s.count || 0) + 1 })`

test('the stub: two calls on different VMs at once each keep their change (one held mid-call while the other ends)', async t => {
  const sc = scratch('mv-stub-race')
  const { h } = await withPool(sc, 2)
  await h.stop()
  const run = kids(t)
  const [A, B] = Object.values(sc.stub().vms)
  const gate = path.join(sc.dir, 'restore-gate')
  sc.patchStub(s => { for (const v of Object.values(s.vms)) v.state = 'Running'; s.restoreGate = gate })
  const call = (op, vm, args = {}) => {
    const ch = run([STUB], { env: sc.env })
    ch.stdin.end(JSON.stringify({ op, args: { vmId: vm.id, name: vm.name, folder: vm.location, ...args } }))
    return ch.done.then(({ out }) => { const m = /^HVJSON:(.*)$/m.exec(out); if (!m) throw new Error(`no answer from the stub: ${out}`); return JSON.parse(m[1]) })
  }
  const clean = A.checkpoints.find(c => c.name === 'clean').id
  const restoreA = call('restore', A, { checkpointId: clean })
  restoreA.catch(() => {}) // awaited below; if the test fails first, the cleanup ends the call
  // A's restore has read the state (both Running) and waits at the gate; B is turned off meanwhile, and that call ends.
  await waitFor(() => sc.stub().calls.some(c => c.op === 'restore' && c.vmId === A.id), T.waitForMs, 'A\'s restore under way')
  assert.deepStrictEqual((await call('net-off', B)).result, { offline: true })
  assert.strictEqual(sc.stub().vms[B.id].state, 'Off')
  fs.writeFileSync(gate, 'open')
  assert.ok((await restoreA).result, 'A restored')
  const end = sc.stub()
  assert.strictEqual(end.vms[A.id].state, 'Off', 'A\'s restore kept')
  assert.strictEqual(end.vms[A.id].parent, clean)
  assert.strictEqual(end.vms[B.id].state, 'Off', 'B\'s turn-off kept: A\'s save didn\'t put back B as it read it')
  assert.ok(end.calls.some(c => c.op === 'net-off' && c.vmId === B.id), 'both calls logged')
})

test('the stubs\' lock: a live holder\'s lock is never cleared, whatever a contender saw; a contender waits for it', async t => {
  const { withLock, breakStale, STALE_MS } = require('./stub-state')
  const sc = scratch('mv-lock-live')
  const run = kids(t)
  const file = path.join(sc.dir, 'counter.json')
  const lock = `${file}.lock`
  const held = path.join(sc.dir, 'held')
  const gate = path.join(sc.dir, 'gate')
  const holder = run(['-e', HOLDER, STATE_JS, file, held, gate], NO_STDIN)
  await waitFor(() => fs.existsSync(held), T.waitForMs, 'the holder holding the lock')
  // Old enough to be a stale lock's age (its folder's own age, read): only its holder being alive keeps it.
  await lockAged(lock, STALE_MS)
  // The review's interleaving: a contender that saw a dead owner acts after a live one has taken the lock. Its one act
  // is breakStale, which can't move a folder a live process holds: refused, and the holder still owns it.
  assert.strictEqual(breakStale(lock), false, 'a live holder\'s lock is not cleared')
  assert.strictEqual(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), String(holder.pid))
  // A contender in another process tries, and is kept out: its refusal is seen (tried, naming the holder it found)
  // while the holder still holds the gate shut, and it hasn't entered.
  const tried = path.join(sc.dir, 'tried')
  const entered = path.join(sc.dir, 'entered')
  const contender = run(['-e', ENTER, STATE_JS, file, tried, entered], NO_STDIN)
  await waitFor(() => fs.existsSync(tried), T.waitForMs, 'the contender refused the held lock')
  assert.strictEqual(fs.readFileSync(tried, 'utf8'), String(holder.pid), 'kept out by the live holder\'s lock')
  assert.ok(!fs.existsSync(entered), 'refused, it did not enter')
  assert.strictEqual(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), String(holder.pid), 'the holder still holds it')
  assert.strictEqual(holder.exitCode, null, 'the holder is still running, inside the lock')
  // Only now is the holder let go; the contender then gets in.
  fs.writeFileSync(gate, 'open')
  assert.strictEqual((await holder.done).code, 0)
  assert.strictEqual((await contender.done).code, 0)
  assert.ok(fs.existsSync(entered), 'it entered once the holder let go')
  // And in this process, once both are gone.
  assert.strictEqual(withLock(file, () => 'mine'), 'mine')
  assert.ok(!fs.existsSync(lock), 'released: no lock left')
})

test('the stubs\' lock: a killed holder\'s lock (and one made but never entered) is cleared, and writers contending meanwhile lose no update', async t => {
  const { withLock, STALE_MS } = require('./stub-state')
  const sc = scratch('mv-lock-dead')
  const run = kids(t)
  const file = path.join(sc.dir, 'counter.json')
  const lock = `${file}.lock`
  const held = path.join(sc.dir, 'held')
  // A holder killed inside its critical section: its lock folder stays, with its owner file.
  const holder = run(['-e', HOLDER, STATE_JS, file, held, path.join(sc.dir, 'never')], NO_STDIN)
  await waitFor(() => fs.existsSync(held), T.waitForMs, 'the holder holding the lock')
  holder.kill()
  await holder.done
  assert.ok(fs.existsSync(path.join(lock, 'owner')), 'left behind by the killed holder')
  // Four writers contend for it at once, each adding to one counter 25 times: the stale lock is cleared as safely as
  // any other, and every one of the 100 updates is kept.
  const writers = [1, 2, 3, 4].map(() => run(['-e', COUNTER, STATE_JS, file, '25'], NO_STDIN))
  for (const w of writers) assert.strictEqual((await w.done).code, 0)
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).count, 100)
  assert.ok(!fs.existsSync(lock))
  // A lock folder made but never entered (its maker killed between mkdir and chdir): left alone while new, then cleared.
  // Each look reports the age it decided on (however late, on a loaded machine, the first look comes): nobody holds this
  // folder, so every look while it was new left it, and the one look that cleared it saw it old enough.
  fs.mkdirSync(lock)
  const checks = []
  assert.strictEqual(withLock(file, () => 'taken', { onCheck: c => checks.push(c) }), 'taken')
  const cleared = checks.filter(c => c.cleared)
  assert.strictEqual(cleared.length, 1, 'cleared once')
  assert.ok(cleared[0].ageMs >= STALE_MS, `cleared only once old enough (${cleared[0].ageMs} ms)`)
  assert.ok(checks.filter(c => !c.cleared).every(c => c.ageMs < STALE_MS), 'left alone only while new')
  assert.ok(!fs.existsSync(lock), 'then taken and released')
})


test('a staged build is for the VM it was staged for: another VM\'s start refuses it, and copies nothing', async t => {
  const sc = scratch('mv-stage')
  const { h } = await withPool(sc, 2)
  t.after(() => h.stop())
  const a = h.conn(10)
  const A = (await a.request('acquire', { minutes: 30 })).data.vm
  const B = (await a.request('acquire', { minutes: 30 })).data.vm
  await a.request('stage_begin', { vm: A })
  await a.request('stage_file', { path: 'x.txt', size: 1 })
  await a.request('stage_chunk', { data: Buffer.from('x').toString('base64') })
  await a.request('stage_end')
  await assert.rejects(a.request('start', { vm: B }), new RegExp(`The build staged was for another VM of this session, not ${B}`))
  assert.match((await a.request('start', { vm: B })).text, /no build/, 'the staging is gone: B starts with no build')
})

// ---------- server.js ----------

function open(t, sc, extraEnv = {}) {
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), ...extraEnv }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  return s
}
const leasedName = r => /Leased (hvmcp-[0-9a-f]+)/.exec(r.text)?.[1]

test('server.js: vm on every lease tool; the implied VM is the one held, by the helper\'s live leases; defaults kept per VM and dropped with the lease', async t => {
  const sc = scratch('mv-server')
  const { h } = await withPool(sc, 2)
  await h.stop()
  const s = open(t, sc)
  const app = path.join(sc.builds, 'app')
  const A = leasedName(await s.call('vm_acquire', { minutes: 30 }))
  const B = leasedName(await s.call('vm_acquire', { minutes: 30 }))
  assert.ok(A && B && A !== B)
  // Only A started, with a build and a network choice; B is held too, so a tool without vm is ambiguous.
  assert.match((await s.call('vm_start', { vm: A, build: app })).text, /build copied in/)
  for (const [tool, args] of [['vm_reset', {}], ['vm_sync', {}], ['vm_run', { command: 'whoami' }], ['vm_release', {}]]) {
    const r = await s.call(tool, args)
    assert.ok(r.isError, tool)
    assert.match(r.text, /This session holds 2 VMs .*: name one with vm/, tool)
  }
  assert.match((await s.call('vm_run', { vm: A, command: 'whoami' })).text, /admin/)
  // B never started: its own reset has no earlier start, so no build (A's is never borrowed).
  assert.doesNotMatch((await s.call('vm_reset', { vm: B })).text, /build copied in/)
  const sync = await s.call('vm_sync', { vm: B })
  assert.ok(sync.isError)
  assert.match(sync.text, new RegExp(`build is required \\(no earlier vm_start or vm_sync of ${B}`))
  // B released: A is the only one held, so vm may be left out, and it is A's own defaults that apply.
  assert.match((await s.call('vm_release', { vm: B })).text, /^Released/)
  assert.match((await s.call('vm_reset', {})).text, /build copied in/, 'A\'s own build, by the live leases')
  assert.match((await s.call('vm_run', { command: 'whoami' })).text, /admin/)
  // B again (the pool's other VM): a new lease starts with no earlier defaults.
  const B2 = leasedName(await s.call('vm_acquire', { minutes: 30 }))
  assert.strictEqual(B2, B)
  assert.doesNotMatch((await s.call('vm_reset', { vm: B2 })).text, /build copied in/)
  // A released: B is now the only one, and its reset still has no build of A's.
  assert.match((await s.call('vm_release', { vm: A })).text, /^Released/)
  assert.doesNotMatch((await s.call('vm_reset', {})).text, /build copied in/)
  assert.match((await s.call('vm_release', {})).text, /^Released/)
})

test('server.js: a lease ended by its deadline is no longer held: the other becomes the implied VM, with its own defaults', async t => {
  const sc = scratch('mv-expire')
  const { h } = await withPool(sc, 2)
  await h.stop()
  const s = open(t, sc, T.profile('leaseMinuteSlow'))
  const app = path.join(sc.builds, 'app')
  const A = leasedName(await s.call('vm_acquire', { minutes: 240 }))
  assert.match((await s.call('vm_start', { build: app })).text, /build copied in/)
  const B = leasedName(await s.call('vm_acquire', { minutes: 5 }))
  assert.ok(A && B && A !== B)
  assert.match((await s.call('vm_reset', {})).text, /name one with vm/, 'both held: ambiguous')
  await waitFor(async () => (await s.call('vm_status')).text.split('\n').some(l => l.startsWith(`- ${B}:`) && /; free/.test(l)), T.waitForMs, 'B\'s deadline ending it')
  assert.match((await s.call('vm_reset', {})).text, /build copied in/, 'A, the one left, with its own build')
  assert.match((await s.call('vm_release', {})).text, /^Released/)
})

test('server.js: a helper without multi-vm is never sent a vm selector: start, run and release naming one are refused with nothing sent; without vm they work as before', async t => {
  const sc = scratch('mv-older')
  const { h } = await withPool(sc, 2)
  await h.stop()
  const shim = path.join(sc.dir, 'older-core.js')
  const sent = path.join(sc.dir, 'sent.log')
  fs.writeFileSync(shim, `const fs = require('fs')
const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') { const r = await request.call(this, connId, op, args); return { ...r, data: { ...r.data, features: r.data.features.filter(f => f !== 'multi-vm') } } }
  if (op === 'leases') throw new Error('unknown operation leases')
  // As a helper before multi-vm refuses a second lease (its own check, word for word).
  if (op === 'acquire' && this.heldLeases(connId).length) throw new Error(\`This connection already has \${this.heldLeases(connId)[0].vmName}: one VM per connection.\`)
  fs.appendFileSync(${JSON.stringify(sent)}, op + ' ' + JSON.stringify(args || {}) + '\\n')
  return request.call(this, connId, op, args)
}
`)
  const s = open(t, sc, { NODE_OPTIONS: `--require ${JSON.stringify(shim)}` })
  const A = leasedName(await s.call('vm_acquire', { minutes: 30 }))
  assert.ok(A)
  const before = fs.readFileSync(sent, 'utf8')
  for (const [tool, args] of [['vm_start', { vm: 'hvmcp-00000000' }], ['vm_run', { vm: 'hvmcp-00000000', command: 'whoami' }], ['vm_release', { vm: 'hvmcp-00000000' }]]) {
    const r = await s.call(tool, args)
    assert.ok(r.isError, tool)
    assert.match(r.text, /has no 'multi-vm' feature, which naming the VM a tool acts on \(vm\) needs: run setup again/, tool)
  }
  assert.strictEqual(fs.readFileSync(sent, 'utf8'), before, 'nothing sent for any of them')
  // A second acquire: the older helper's own refusal, with what to do about it; still one lease.
  const second = await s.call('vm_acquire', { minutes: 30 })
  assert.ok(second.isError)
  assert.match(second.text, new RegExp(`This connection already has ${A}: one VM per connection\\. More than one VM per session needs a helper with the 'multi-vm' feature: run setup again`))
  assert.strictEqual(((await s.call('vm_status')).text.match(/\(yours\)/g) || []).length, 1)
  assert.match((await s.call('vm_start', {})).text, /Started|started/i)
  assert.match((await s.call('vm_run', { command: 'whoami' })).text, /admin/)
  assert.ok(/leased/.test((await s.call('vm_status')).text), 'the one VM still leased')
  assert.match((await s.call('vm_release', {})).text, /^Released/)
})
