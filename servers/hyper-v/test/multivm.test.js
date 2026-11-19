// MC-1580: more than one VM per session. One connection (one agent's session) holds several leases, each counted
// against the same caps and line; every lease op names its VM with vm, or uses the session's only one; with several and
// no vm, it is refused naming them. A disconnect ends them all; one lease's end leaves the others. server.js resolves a
// tool's VM from the helper's live leases (never from what it remembers), keeps vm_reset's and vm_sync's defaults per
// VM, and never sends a vm selector to a helper without 'multi-vm'.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { T, scratch, startHelper, withPool, waitFor } = require('./helpers')
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
  assert.match((await s.call('vm_start', {})).text, /Started|started/i)
  assert.match((await s.call('vm_run', { command: 'whoami' })).text, /admin/)
  assert.ok(/leased/.test((await s.call('vm_status')).text), 'the one VM still leased')
  assert.match((await s.call('vm_release', {})).text, /^Released/)
})
