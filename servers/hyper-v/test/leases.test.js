// Leases, runs and the clean baseline, through helper.js (as the service host runs it) against the stub Hyper-V:
// several connections never share a VM; a lease ends on release, its deadline or its connection closing; every start
// restores the clean checkpoint by id first, unconditionally; a restore that doesn't verify quarantines the VM; the
// helper acts only on its own VMs; staging, runs and reads are bounded and checked.
const test = require('node:test')
const assert = require('assert')
const { scratch, startHelper, withPool, waitFor, seedImage } = require('./helpers')

const vmOf = (sc, name) => Object.values(sc.stub().vms).find(v => v.name === name)
const leased = async (c, opts) => (await c.request('acquire', opts)).data.vm

test('two connections get two different VMs; a third is refused; one VM per connection', async t => {
  const sc = scratch('two-leases')
  const { h } = await withPool(sc, 2)
  t.after(() => h.stop())
  const a = h.conn(10); const b = h.conn(11); const c = h.conn(12)
  const va = await leased(a)
  const vb = await leased(b)
  assert.notStrictEqual(va, vb)
  await assert.rejects(c.request('acquire'), /No VM is free \(2 in the pool\).*The next lease ends by/)
  await assert.rejects(a.request('acquire'), /already has .*one VM per connection/)
  await a.request('start'); await b.request('start')
  assert.strictEqual(vmOf(sc, va).state, 'Running')
  assert.strictEqual(vmOf(sc, vb).state, 'Running')
})

test('a connection closing (its server killed) ends its lease: the VM is restored and free again', async t => {
  const sc = scratch('conn-close')
  const { h, admin } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  const vm = await leased(a)
  await a.request('start')
  await a.request('run', { command: 'write junk.txt from-run' })
  const before = vmOf(sc, vm).restores
  a.close()
  await waitFor(async () => new RegExp(`${vm}: .*; free`).test((await admin.request('status')).text), 5000, 'the lease to end')
  assert.ok(vmOf(sc, vm).restores > before, 'restored')
  assert.strictEqual(vmOf(sc, vm).disk['C:\\out\\junk.txt'], undefined, 'the run\'s file is gone with the restore')
  const b = h.conn(11)
  assert.strictEqual(await leased(b), vm)
})

test('the deadline ends a lease and restores the VM', async t => {
  const sc = scratch('deadline')
  sc.env.HYPERV_MCP_MINUTE_MS = '300'
  const { h, admin } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  const vm = await leased(a, { minutes: 1 })
  await a.request('start')
  await waitFor(async () => /; free/.test((await admin.request('status')).text), 5000, 'the deadline')
  assert.strictEqual(vmOf(sc, vm).state, 'Off')
  await assert.rejects(a.request('run', { command: 'echo x' }), /no VM: call vm_acquire/)
})

test('every start restores the clean checkpoint first, also after a clean stop', async t => {
  const sc = scratch('restore-every-start')
  const { h } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  const vm = await leased(a)
  const r0 = vmOf(sc, vm).restores
  await a.request('start')
  assert.strictEqual(vmOf(sc, vm).restores, r0 + 1)
  await a.request('stop')
  assert.strictEqual(vmOf(sc, vm).restores, r0 + 2)
  await a.request('start')
  assert.strictEqual(vmOf(sc, vm).restores, r0 + 3, 'a start after a clean stop still restores')
})

test('keep, then the guest shuts itself down, then release and a new start: the sentinel is gone', async t => {
  const sc = scratch('keep-shutdown')
  const { h } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  const vm = await leased(a)
  await a.request('start')
  assert.match((await a.request('run', { command: 'write C:\\sentinel.txt run1' })).text, /Exit code 0/)
  await a.request('run', { command: 'shutdown' })
  assert.match((await a.request('stop', { keep: true })).text, /kept for inspection/)
  const v = vmOf(sc, vm)
  assert.strictEqual(v.state, 'Off')
  assert.strictEqual(v.parent, v.checkpoints[0].id, 'Off at the expected parent: the identity checks alone would pass')
  assert.ok(v.disk['C:\\sentinel.txt'], 'but its disk holds the run\'s change')
  await assert.rejects(a.request('start'), /kept for inspection: vm_release it/)
  await a.request('release')
  await leased(a)
  await a.request('start')
  assert.match((await a.request('run', { command: 'check C:\\sentinel.txt' })).text, /Exit code 1/, 'run 2 finds no sentinel')
})

test('keepOnFailure keeps the VM after a failed run; release restores it', async t => {
  const sc = scratch('keep-on-failure')
  const { h } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  const vm = await leased(a, { keepOnFailure: true })
  await a.request('start')
  await a.request('run', { command: 'exit 3' })
  assert.match((await a.request('stop')).text, /because a run failed/)
  assert.strictEqual(vmOf(sc, vm).state, 'Running', 'left as it is')
  assert.match((await a.request('release')).text, /Released\. .*restored to clean/)
  assert.strictEqual(vmOf(sc, vm).state, 'Off')
})

test('a kept VM is restored at the deadline', async t => {
  const sc = scratch('keep-deadline')
  sc.env.HYPERV_MCP_MINUTE_MS = '300'
  const { h, admin } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  const vm = await leased(a, { minutes: 10 }) // 3 s here
  await a.request('start')
  await a.request('stop', { keep: true })
  a.close() // a kept VM outlives its connection, until its deadline
  // The close is processed once the helper counts one connection (admin's) again: then the lease must still be kept.
  const st = await waitFor(async () => { const s = await admin.request('status'); return s.data.connections === 1 && s }, 5000, 'the helper to process the close')
  assert.match(st.text, /kept for inspection/)
  await waitFor(async () => /; free/.test((await admin.request('status')).text), 5000, 'the deadline')
  assert.strictEqual(vmOf(sc, vm).state, 'Off')
})

test('a restore that leaves the adapter connected or a reserve set is caught: CLEANUP FAILED, quarantined, retried', async t => {
  for (const leaves of [{ switchName: 'hvmcp-internal' }, { reserve: 20 }, { state: 'Running' }]) {
    const sc = scratch('bad-restore')
    sc.env.HYPERV_MCP_RETRY_MS = '200'
    const { h, admin } = await withPool(sc, 1)
    const a = h.conn(10)
    const vm = await leased(a)
    await a.request('start')
    sc.patchStub(s => { s.restoreLeaves = leaves })
    const stop = await a.request('stop')
    assert.match(stop.text, /CLEANUP FAILED/, JSON.stringify(leaves))
    assert.strictEqual(stop.isError, true)
    await a.request('release')
    assert.match((await admin.request('status')).text, new RegExp(`${vm}: .*QUARANTINED`))
    await assert.rejects(h.conn(11).request('acquire'), /No VM is free \(1 in the pool, 1 quarantined\)/)
    sc.patchStub(s => { delete s.restoreLeaves })
    await waitFor(async () => /; free/.test((await admin.request('status')).text), 5000, 'the retry')
    await h.stop()
  }
})

test('a clean checkpoint replaced under the same name is detected by id: quarantined', async t => {
  const sc = scratch('checkpoint-replaced')
  const { h, admin } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  const vm = await leased(a)
  sc.patchStub(s => { const v = Object.values(s.vms).find(x => x.name === vm); v.checkpoints = [{ id: '00000000-0000-0000-0000-000000000001', name: 'clean', disk: {} }] })
  await assert.rejects(a.request('start'), /CLEANUP FAILED: .*checkpoint \(by id\) is missing.*The start was refused/)
  assert.match((await admin.request('status')).text, /QUARANTINED/)
})

test('only its own VMs: a renamed pool VM is refused; a foreign VM with the prefix is never touched', async t => {
  const sc = scratch('ownership')
  const { h, admin } = await withPool(sc, 2)
  t.after(() => h.stop())
  sc.patchStub(s => { s.vms.foreign = { id: 'foreign', name: 'hvmcp-ffffffff', location: 'C:\\elsewhere\\hvmcp-ffffffff', state: 'Running', checkpoints: [], parent: null, disk: {} } })
  const a = h.conn(10)
  const vm = await leased(a)
  sc.patchStub(s => { Object.values(s.vms).find(x => x.name === vm).name = 'renamed' })
  await assert.rejects(a.request('start'), /is named 'renamed', not 'hvmcp-[0-9a-f]+': not the pool's/)
  const b = h.conn(11)
  await leased(b)
  await b.request('start'); await b.request('stop'); await b.request('release')
  const calls = sc.stub().calls.filter(c => c.vmId === 'foreign')
  assert.deepStrictEqual(calls, [], 'no operation named the foreign VM')
  assert.match((await admin.request('status')).text, /QUARANTINED/)
})

test('network: off by default; only the pool\'s internal switch, only when the pool has one; reserve capped', async t => {
  const sc = scratch('network')
  const { h } = await withPool(sc, 1)
  const a = h.conn(10)
  const vm = await leased(a)
  await assert.rejects(a.request('start', { network: true }), /no internal switch/)
  await assert.rejects(a.request('start', { reserveCpu: 51 }), /0-50 \(the policy's cap\)/)
  await assert.rejects(a.request('start', { reserveCpu: 2.5 }), /whole percentage/)
  await a.request('start', { reserveCpu: 50 })
  assert.strictEqual(vmOf(sc, vm).switchName, null)
  assert.strictEqual(vmOf(sc, vm).reserve, 50)
  await a.request('stop')
  assert.strictEqual(vmOf(sc, vm).reserve, 0, 'released at stop')
  await h.stop()

  const sc2 = scratch('network-switch')
  const p = await withPool(sc2, 1, { network: true })
  t.after(() => p.h.stop())
  assert.strictEqual(sc2.stub().switches['hvmcp-internal'].type, 'Internal')
  const b = p.h.conn(10)
  const vm2 = await leased(b)
  assert.match((await b.request('start', { network: true })).text, /network ON \(internal switch hvmcp-internal\)/)
  assert.strictEqual(vmOf(sc2, vm2).switchName, 'hvmcp-internal')
  await b.request('stop')
  assert.strictEqual(vmOf(sc2, vm2).switchName, null)
})

test('a policy without networking refuses it, in plans and in starts', async t => {
  const sc = scratch('no-network', { policy: { allowNetwork: false } })
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  t.after(() => h.stop())
  await assert.rejects(h.conn(1).request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, network: true }), /does not allow networking/)
})

test('staging: names checked, sizes held to, the policy\'s build cap', async t => {
  const sc = scratch('staging', { policy: { maxBuildMB: 1 } })
  const { h } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  await assert.rejects(a.request('stage_begin'), /no VM: call vm_acquire/)
  await leased(a)
  await a.request('stage_begin')
  for (const bad of ['../x', '..\\x', 'C:/x', '\\\\server\\share', 'a:b', 'nul', 'con.txt', 'x/../../y', 'trail. ']) {
    await assert.rejects(a.request('stage_file', { path: bad, size: 1 }), /not allowed|absolute|drive|dot or space|device|":"/, bad)
  }
  await a.request('stage_file', { path: 'ok.txt', size: 3 })
  await assert.rejects(a.request('stage_chunk', { data: Buffer.from('four').toString('base64') }), /more bytes than its size/)
  await a.request('stage_chunk', { data: Buffer.from('ab').toString('base64') })
  await assert.rejects(a.request('stage_end'), /1 bytes short/)
  await a.request('stage_begin')
  await assert.rejects(a.request('stage_file', { path: 'big.bin', size: 2 * 1024 * 1024 }), /over the policy's 1 MB/)
})

test('runs: as admin or user, a timeout kills inside, output capped, and the command never reaches a host command line', async t => {
  const sc = scratch('runs')
  const { h } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  await leased(a)
  await assert.rejects(a.request('run', { command: 'echo x' }), /not running: call vm_start/)
  await a.request('start')
  assert.match((await a.request('run', { command: 'whoami', as: 'user' })).text, /hvuser/)
  assert.match((await a.request('run', { command: 'whoami' })).text, /admin/)
  const to = await a.request('run', { command: 'sleep', timeoutSec: 1 })
  assert.strictEqual(to.isError, true)
  assert.match(to.text, /Timed out after 1 s: killed inside the guest by its PID/)
  assert.match((await a.request('run', { command: 'big' })).text, /stdout \(first 16384 bytes\)/)
  for (const bad of [{ command: '' }, { command: 'x', shell: 'bash' }, { command: 'x', as: 'system' }, { command: 'x', timeoutSec: 0 }, { command: 'x', cwd: 'relative' }, { command: 'x'.repeat(9000) }]) {
    await assert.rejects(a.request('run', bad), Error, JSON.stringify(bad).slice(0, 60))
  }
  const evil = 'echo "; Remove-VM * -Force; $(calc)'
  await a.request('run', { command: evil })
  for (const c of sc.stub().calls) assert.deepStrictEqual(c.argv, [], `${c.op} was started with arguments`)
  assert.ok(sc.stub().calls.some(c => c.command === evil), 'the command reached the stub as data, on stdin')
})

test('read_out: lists, reads by path and glob, caps while reading, refuses paths outside out', async t => {
  const sc = scratch('read-out')
  const { h } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  await leased(a)
  await a.request('start')
  await a.request('run', { command: 'write a.txt alpha' })
  await a.request('run', { command: 'write logs\\b.log beta-beta' })
  assert.match((await a.request('read_out')).text, /a\.txt  5 bytes[\s\S]*logs\/b\.log  9 bytes/)
  const g = await a.request('read_out', { glob: '**/*.log' })
  assert.deepStrictEqual(g.files.map(f => f.path), ['logs/b.log'])
  const capped = await a.request('read_out', { paths: ['logs/b.log', 'missing.txt'], maxBytes: 4 })
  assert.strictEqual(Buffer.from(capped.files[0].data, 'base64').toString(), 'beta')
  assert.strictEqual(capped.files[0].cut, true)
  assert.deepStrictEqual(capped.missing, ['missing.txt'])
  for (const bad of ['../x', 'C:\\Windows\\win.ini', '\\\\.\\pipe\\x', 'a:stream']) await assert.rejects(a.request('read_out', { paths: [bad] }), Error, bad)
  await assert.rejects(a.request('read_out', { maxBytes: 0 }), /maxBytes/)
})

test('the protocol: malformed lines and unknown connections are refused without effect', async t => {
  const sc = scratch('protocol')
  const { h, admin } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(10)
  a.raw('{not json')
  a.raw('[1,2]')
  a.raw('1 "t":"close","c":1}')
  h.send('msg 999 {"id":1,"op":"acquire"}')
  h.send('open x 1')
  // The helper reads its input in order, so admin's reply to this later status line means every line above was handled.
  const st = await admin.request('status')
  assert.match(st.text, /; free/)
  assert.strictEqual(st.data.connections, 2, 'no connection was opened or closed by the junk')
  assert.ok(await leased(a), 'the connection still works')
  await assert.rejects(a.request('nope'), /unknown operation/)
})

test('a lease that is ending refuses its connection at once, and its VM goes to the next client only once restored', async t => {
  const sc = scratch('ending-refuses')
  sc.env.HYPERV_MCP_MINUTE_MS = '400'
  const { h, admin } = await withPool(sc, 1)
  t.after(() => h.stop())
  const gate = require('path').join(sc.dir, 'restore-gate')
  const restores = () => sc.stub().calls.filter(c => c.op === 'restore').length
  const a = h.conn(10)
  const vm = await leased(a, { minutes: 1 }) // its deadline: 400 ms here
  const before = restores()
  sc.patchStub(s => { s.restoreGate = gate })
  await waitFor(() => restores() > before, 10_000, 'the deadline\'s restore to begin (it waits at the gate)')
  await assert.rejects(a.request('start'), /lease on hvmcp-[0-9a-f]+ is ending: call vm_acquire again/)
  const b = h.conn(11)
  await assert.rejects(b.request('acquire'), /No VM is free/, 'not handed on while it is being restored')
  require('fs').writeFileSync(gate, 'open')
  await waitFor(async () => /; free/.test((await admin.request('status')).text), 10_000, 'the restore to finish')
  assert.strictEqual(await leased(b), vm)
  assert.deepStrictEqual(sc.stub().calls.filter(c => c.op === 'configure-start'), [], 'a\'s start never ran')
  assert.strictEqual(vmOf(sc, vm).state, 'Off')
})

test('an operation queued for the VM while its lease ended is refused inside the lock (start and run)', async t => {
  const { Helper } = require('../helper/core')
  const { hv } = require('../helper/hv')
  for (const op of ['start', 'run']) {
    const sc = scratch(`queued-${op}`)
    const { h } = await withPool(sc, 1)
    await h.stop()
    const saved = { ...process.env }
    Object.assign(process.env, { HYPERV_MCP_PS_STUB: sc.env.HYPERV_MCP_PS_STUB, HYPERV_MCP_STUB_STATE: sc.env.HYPERV_MCP_STUB_STATE, HYPERV_MCP_POLL_MS: '10' })
    const helper = new Helper({ stateDir: sc.stateDir, hv, checkApprovalAcl: false })
    try {
      await helper.init()
      helper.connect('a', 1)
      await helper.acquire('a', {})
      const lease = [...helper.leases.values()][0]
      if (op === 'run') await helper.start('a', {})
      const callsBefore = sc.stub().calls.length
      let open
      const hold = new Promise(r => { open = r })
      const held = helper.vmLock(lease.vmId)(() => hold) // something holds the VM's lock
      const queued = op === 'start' ? helper.start('a', {}) : helper.run('a', { command: 'echo late' })
      const ended = helper.endLease(lease, 'test: its deadline') // the lease ends while the operation waits
      open()
      await held
      await assert.rejects(queued, /ended while the request waited/, op)
      assert.strictEqual((await ended).ok, true)
      const later = sc.stub().calls.slice(callsBefore).map(c => c.op)
      assert.ok(!later.includes('configure-start') && !later.includes('guest-run'), `the queued ${op} never acted: ${later}`)
      helper.connect('b', 2)
      assert.match((await helper.acquire('b', {})).text, /Leased/, 'the next client gets it, restored')
      assert.strictEqual(Object.values(sc.stub().vms)[0].state, 'Off')
    } finally {
      helper.close()
      process.env = saved
    }
  }
})
