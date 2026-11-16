// A lease's own checkpoints (MC-1529, slice A): vm_checkpoint and vm_restore within one lease, production checkpoints
// (disk only) taken of a running VM, restored then started like vm_start with the lease's current settings; the lease's
// checkpoints survive its own starts, resets and stops, and are removed (deepest first) when the lease ends; a removal
// that fails keeps the VM quarantined until they're gone, even though clean verified; a take whose id wasn't journalled
// is found by its unique name; unknown snapshots are left alone. Through server.js (direct mode) against the stub's
// snapshot tree.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { scratch, withPool, waitFor } = require('./helpers')
const { server } = require('../client')

async function lease(t, name, { policy, stub } = {}) {
  const sc = scratch(name, { policy, stub })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home') }
  const open = () => { const s = server(env, { roots: [sc.builds] }); t.after(() => s.close()); return s }
  const s = open()
  const vm = /Leased (hvmcp-[0-9a-f]+)/.exec((await s.call('vm_acquire', { minutes: 30 })).text)[1]
  const stubVm = () => Object.values(sc.stub().vms).find(v => v.name === vm)
  const journal = () => sc.journal()
  return { sc, s, vm, stubVm, journal, open }
}
const run = (s, command) => s.call('vm_run', { command })

test('take a, change a file, take b, restore a (the change is gone), restore b (it is back); release removes both, deepest first', async t => {
  const { s, stubVm, journal } = await lease(t, 'cp-roundtrip')
  await s.call('vm_start', {})
  await run(s, 'write C:\\tools\\one.txt first')
  const a = await s.call('vm_checkpoint', { name: 'a' })
  assert.match(a.text, /^Checkpoint "a" taken of hvmcp-\w+ \(files, installed software and the registry; not running programs or a logon session\)/)
  await run(s, 'write C:\\tools\\two.txt second')
  assert.match((await s.call('vm_checkpoint', { name: 'b' })).text, /^Checkpoint "b" taken/)
  const tree = stubVm().checkpoints
  const [ca, cb] = ['a', 'b'].map(n => tree.find(c => c.name === journal().find(r => r.t === 'lcp-take' && r.name === n).snapName))
  assert.strictEqual(cb.parentId, ca.id, 'b is a child of a')
  assert.match((await s.call('vm_status')).text, /your checkpoints: "a" \(taken [^)]+\), "b" \(taken [^)]+\)/)

  const ra = await s.call('vm_restore', { name: 'a' })
  assert.match(ra.text, /^Restored hvmcp-\w+ to its checkpoint "a" and started it .*running programs and any logon session aren't .*run a full vm_sync/)
  assert.strictEqual((await run(s, 'check C:\\tools\\two.txt')).isError || /Exit code 1/.test((await run(s, 'check C:\\tools\\two.txt')).text), true, 'the change after a is gone')
  assert.match((await run(s, 'check C:\\tools\\one.txt')).text, /Exit code 0/)
  // After a restore C:\build is unconfirmed: no take until a full sync or a reset.
  assert.match((await s.call('vm_checkpoint', { name: 'c' })).text, /C:\\build is unconfirmed .*full vm_sync or vm_reset/)

  // A reset (clean) within the lease keeps its checkpoints; b is still there to restore.
  await s.call('vm_reset', {})
  assert.match((await run(s, 'check C:\\tools\\one.txt')).text, /Exit code 1/, 'clean has neither file')
  await s.call('vm_restore', { name: 'b' })
  assert.match((await run(s, 'check C:\\tools\\two.txt')).text, /Exit code 0/, 'b brought it back')

  assert.match((await s.call('vm_release')).text, /^Released/)
  const v = stubVm()
  assert.deepStrictEqual(v.checkpoints.map(c => c.name), ['clean'], 'only clean is left')
  assert.deepStrictEqual(v.removedSnaps, [cb.name, ca.name], 'the child before its parent')
  assert.ok(journal().filter(r => r.t === 'lcp-dropped').length === 2)
})

test('refusals: not running, a reserved or bad name, a duplicate, the cap, the disk floor, an unknown name to restore', async t => {
  const { s } = await lease(t, 'cp-refuse', { policy: { maxLeaseCheckpoints: 1 } })
  assert.match((await s.call('vm_checkpoint', { name: 'a' })).text, /The VM is not running: vm_start it first/)
  await s.call('vm_start', {})
  assert.match((await s.call('vm_checkpoint', { name: 'clean' })).text, /not "clean"/)
  assert.match((await s.call('vm_checkpoint', { name: '../x' })).text, /name must be 1-40/)
  await s.call('vm_checkpoint', { name: 'a' })
  assert.match((await s.call('vm_checkpoint', { name: 'a' })).text, /already has a checkpoint "a"/)
  assert.match((await s.call('vm_checkpoint', { name: 'b' })).text, /holds 1 checkpoints, the policy's maxLeaseCheckpoints \(1\)/)
  assert.match((await s.call('vm_restore', { name: 'zz' })).text, /This lease has no checkpoint "zz" \(it has: a\)/)
  await s.call('vm_release')
  // The disk floor, on a fresh lease.
  const l2 = await lease(t, 'cp-refuse-disk')
  const s2 = l2.s
  await s2.call('vm_start', {})
  l2.sc.patchStub(st => { st.freeGB = 5 }) // after the build, which needs the space itself
  assert.match((await s2.call('vm_checkpoint', { name: 'a' })).text, /has 5 GB free, under the 20 GB a checkpoint must leave/)
})

test('restore reapplies the lease\'s current settings: a checkpoint taken connected restores disconnected on a network-off lease; its reserve gives way to the lease\'s', async t => {
  const { s, sc, vm, stubVm } = await lease(t, 'cp-settings')
  await s.call('vm_start', { reserveCpu: 20 })
  // The snapshot's configuration says connected (as if a switch were attached when it was taken).
  sc.patchStub(st => { Object.values(st.vms).find(v => v.name === vm).switchName = 'some-switch' })
  await s.call('vm_checkpoint', { name: 'a' })
  await s.call('vm_start', { reserveCpu: 0 }) // the lease's settings now: network off, no reserve
  const r = await s.call('vm_restore', { name: 'a' })
  assert.match(r.text, /network off; CPU reserve 0%/)
  assert.strictEqual(stubVm().switchName, null, 'disconnected, not the snapshot\'s adapter')
  assert.strictEqual(stubVm().reserve, 0)
  assert.strictEqual(stubVm().state, 'Running')
})

test('a production checkpoint that can\'t be made fails, with no standard fallback; one made despite a failed call is kept as the lease\'s and removed with it', async t => {
  const { s, sc, stubVm, journal } = await lease(t, 'cp-production')
  await s.call('vm_start', {})
  sc.patchStub(st => { st.productionFail = true })
  const r = await s.call('vm_checkpoint', { name: 'a' })
  assert.match(r.text, /The checkpoint "a" couldn't be taken \((lease-checkpoint: )?injected: a production checkpoint could not be made\)\./)
  assert.deepStrictEqual(stubVm().checkpoints.map(c => c.name), ['clean'])
  assert.match(r.text, /Whether Hyper-V made one is settled when this lease ends/)
  assert.ok(!journal().some(x => x.t === 'lcp-dropped'), 'an absence right after a failed call proves nothing: still journalled')
  assert.match((await s.call('vm_status')).text, /your checkpoints: "a" \(unconfirmed\)/)
  sc.patchStub(st => { st.productionFail = false; st.productionFailButMade = true })
  assert.match((await s.call('vm_checkpoint', { name: 'b' })).text, /couldn't be taken .*One was made all the same: it's kept as this lease's, and removed with it\./)
  assert.match((await s.call('vm_status')).text, /your checkpoints: "a" \(unconfirmed\), "b" \(taken/)
  sc.patchStub(st => { st.productionFailButMade = false })
  await s.call('vm_release')
  assert.deepStrictEqual(stubVm().checkpoints.map(c => c.name), ['clean'], 'removed with the lease')
})

test('a removal that fails at release quarantines the VM; a later clean restore alone doesn\'t clear it; it clears once the checkpoints are gone', async t => {
  const { s, sc, vm, stubVm, open } = await lease(t, 'cp-cleanup', { stub: {} })
  await s.call('vm_start', {})
  await s.call('vm_checkpoint', { name: 'a' })
  sc.patchStub(st => { st.snapRemoveFail = 2 }) // the release's removal, and the next restart's
  const rel = await s.call('vm_release')
  assert.match(rel.text, /CLEANUP FAILED: .*lease checkpoint cleanup pending: removing a failed/)
  await s.close()
  const s2 = open() // a restart: recovery restores clean (verified), but the removal fails again
  assert.match((await s2.call('vm_status')).text, new RegExp(`${vm}: .*QUARANTINED \\(lease checkpoint cleanup pending`))
  await s2.close()
  const s3 = open() // the removal succeeds this time
  const st = (await s3.call('vm_status')).text
  assert.match(st, new RegExp(`${vm}: .*; free`))
  assert.deepStrictEqual(stubVm().checkpoints.map(c => c.name), ['clean'])
})

test('recovery: a take journalled without its id is found by its unique name and removed; an unknown snapshot is left alone and reported', async t => {
  const { s, sc, vm, stubVm, open } = await lease(t, 'cp-recovery')
  await s.call('vm_start', {})
  await s.close()
  // As if the helper died between the take and its lcp-taken: the snapshot exists, the journal has only the intent.
  const v0 = Object.values(sc.stub().vms).find(v => v.name === vm)
  const opId = 'abcdef012345'
  fs.appendFileSync(path.join(sc.stateDir, 'journal.jsonl'), JSON.stringify({ t: 'lcp-take', opId, vmId: v0.id, leaseId: 'l-gone', name: 'x', snapName: `hvmcp-lease-${opId}`, at: new Date().toISOString() }) + '\n')
  sc.patchStub(st => {
    const v = Object.values(st.vms).find(x => x.name === vm)
    v.checkpoints.push({ id: 'snap-orphan', name: `hvmcp-lease-${opId}`, parentId: v.parent, disk: {} })
    v.checkpoints.push({ id: 'snap-user', name: 'someone else\'s', parentId: v.parent, disk: {} })
  })
  const s2 = open()
  const st = (await s2.call('vm_status')).text
  assert.deepStrictEqual(stubVm().checkpoints.map(c => c.name).sort(), ['clean', 'someone else\'s'], 'the orphan removed by name, the unknown one kept')
  assert.match(st, new RegExp(`${vm}: .*unknown checkpoints left alone: someone else's`))
})

/** Starts a call, waits for the stub's "entered" file, then releases; returns both replies. */
async function releaseDuring(s, sc, call, knobs) {
  const entered = path.join(sc.dir, `entered-${Date.now()}`)
  sc.patchStub(st => Object.assign(st, knobs(entered)))
  const p = call()
  await waitFor(async () => fs.existsSync(entered), 10_000, 'the call has entered Hyper-V')
  const rel = await s.call('vm_release')
  return { r: await p, rel }
}

test('a lease released while a take waits before Hyper-V makes the snapshot: no success, nothing left, the intent settled', async t => {
  const { s, sc, stubVm, journal } = await lease(t, 'cp-cancel-before')
  await s.call('vm_start', {})
  const gate = path.join(sc.dir, 'gate-never')
  const { r, rel } = await releaseDuring(s, sc, () => s.call('vm_checkpoint', { name: 'a' }), entered => ({ takeEntered: entered, takeGate: gate }))
  assert.ok(!/^Checkpoint "a" taken/.test(r.text), `no success: ${r.text}`)
  assert.match(rel.text, /^Released/)
  assert.deepStrictEqual(stubVm().checkpoints.map(c => c.name), ['clean'])
  assert.ok(journal().some(x => x.t === 'lcp-dropped'), 'settled after clean was restored')
})

test('a lease released just after Hyper-V made the snapshot but before the call answered: no success; the snapshot is owned and removed', async t => {
  const { s, sc, stubVm } = await lease(t, 'cp-cancel-after')
  await s.call('vm_start', {})
  const gate = path.join(sc.dir, 'gate-after-never')
  const { r, rel } = await releaseDuring(s, sc, () => s.call('vm_checkpoint', { name: 'a' }), entered => ({ takeEntered: entered, takeGateAfter: gate }))
  assert.ok(!/^Checkpoint "a" taken/.test(r.text), `no success: ${r.text}`)
  assert.match(rel.text, /^Released/)
  const v = stubVm()
  assert.deepStrictEqual(v.checkpoints.map(c => c.name), ['clean'])
  assert.strictEqual((v.removedSnaps || []).length, 1, 'the one it made, removed by the release')
  assert.strictEqual(v.checkpointType, 'Production', 'and the checkpoint type put back from the journal')
})

test('a take that Hyper-V completes after its call failed (absent at the first look) is never forgotten: the release finds and removes it', async t => {
  const { s, sc, stubVm } = await lease(t, 'cp-delayed')
  await s.call('vm_start', {})
  sc.patchStub(st => { st.productionFailDelayed = true })
  assert.match((await s.call('vm_checkpoint', { name: 'a' })).text, /couldn't be taken .*settled when this lease ends/)
  sc.patchStub(st => { st.productionFailDelayed = false })
  assert.match((await s.call('vm_release')).text, /^Released/)
  const v = stubVm()
  assert.deepStrictEqual(v.checkpoints.map(c => c.name), ['clean'], 'it appeared later, and was removed')
  assert.strictEqual((v.removedSnaps || []).length, 1)
})

test('a lease released during a restore: no success; the VM ends clean, its checkpoints removed', async t => {
  const { s, sc, stubVm } = await lease(t, 'cp-cancel-restore')
  await s.call('vm_start', {})
  await s.call('vm_checkpoint', { name: 'a' })
  const gate = path.join(sc.dir, 'restore-gate-never')
  const { r, rel } = await releaseDuring(s, sc, () => s.call('vm_restore', { name: 'a' }), entered => ({ restoreEntered: entered, leaseRestoreGate: gate }))
  assert.ok(!/^Restored /.test(r.text), `no success: ${r.text}`)
  assert.match(rel.text, /^Released/)
  assert.deepStrictEqual(stubVm().checkpoints.map(c => c.name), ['clean'])
})

test('identity mismatches: a known id under another name is neither removed nor forgotten (quarantined); a same-named snapshot with another id is unknown, left alone', async t => {
  const renamed = await lease(t, 'cp-mismatch-id')
  await renamed.s.call('vm_start', {})
  await renamed.s.call('vm_checkpoint', { name: 'a' })
  renamed.sc.patchStub(st => { const v = Object.values(st.vms).find(x => x.name === renamed.vm); v.checkpoints.find(c => c.name.startsWith('hvmcp-lease-')).name = 'renamed by someone' })
  const rel = await renamed.s.call('vm_release')
  assert.match(rel.text, /CLEANUP FAILED: .*lease checkpoint cleanup pending: a's id \S+ now has the name "renamed by someone"/)
  assert.ok(renamed.stubVm().checkpoints.some(c => c.name === 'renamed by someone'), 'not removed')
  assert.ok(renamed.journal().filter(x => x.t === 'lcp-take').length === 1 && !renamed.journal().some(x => x.t === 'lcp-dropped'), 'not forgotten')

  const twin = await lease(t, 'cp-mismatch-name')
  await twin.s.call('vm_start', {})
  await twin.s.call('vm_checkpoint', { name: 'a' })
  twin.sc.patchStub(st => { const v = Object.values(st.vms).find(x => x.name === twin.vm); const own = v.checkpoints.find(c => c.name.startsWith('hvmcp-lease-')); v.checkpoints.push({ id: 'snap-twin', name: own.name, parentId: v.parent, disk: {} }) })
  assert.match((await twin.s.call('vm_release')).text, /^Released/)
  const left = twin.stubVm().checkpoints.map(c => c.id)
  assert.ok(left.includes('snap-twin') && left.length === 2, 'only the owned id removed')
  assert.match((await twin.s.call('vm_status')).text, /unknown checkpoints left alone: hvmcp-lease-[0-9a-f]+ \(snap-twin\)/)
})

test('the checkpoint type: put back at once if the take left it changed; if that fails too, said in the reply and put back at the lease\'s end', async t => {
  const one = await lease(t, 'cp-type-fixed')
  await one.s.call('vm_start', {})
  one.sc.patchStub(st => { st.typeRestoreFails = true })
  const r1 = await one.s.call('vm_checkpoint', { name: 'a' })
  assert.doesNotMatch(r1.text, /Note: the VM's checkpoint type/)
  assert.strictEqual(one.stubVm().checkpointType, 'Production')

  const two = await lease(t, 'cp-type-pending')
  await two.s.call('vm_start', {})
  two.sc.patchStub(st => { st.typeRestoreFails = true; st.typeSetFails = true })
  const r2 = await two.s.call('vm_checkpoint', { name: 'a' })
  assert.match(r2.text, /Note: the VM's checkpoint type was left as ProductionOnly \(it was Production\); it's put back when this lease ends\./)
  const rel = await two.s.call('vm_release')
  assert.match(rel.text, /CLEANUP FAILED: .*the checkpoint type is ProductionOnly, not Production/)
  await two.s.close()
  two.sc.patchStub(st => { st.typeSetFails = false; st.typeRestoreFails = false })
  const s3 = two.open()
  assert.match((await s3.call('vm_status')).text, new RegExp(`${two.vm}: .*; free`))
  assert.strictEqual(two.stubVm().checkpointType, 'Production')
})

test('server.js: vm_checkpoint and vm_restore are refused, before anything is sent, by a helper without the checkpoints feature', async t => {
  const sc = scratch('cp-feature', { policy: { maxVms: 3 } })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const shim = path.join(sc.dir, 'older-core.js')
  fs.writeFileSync(shim, `const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') return { text: 'hyperv-mcp/3', data: { protocol: 'hyperv-mcp/3', features: ['projects', 'images', 'named'], buildRoots: [] } }
  if (op === 'checkpoint' || op === 'restore-checkpoint') throw new Error('should not be sent')
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  assert.match((await s.call('vm_checkpoint', { name: 'a' })).text, /has no 'checkpoints' feature, which vm_checkpoint needs: run setup again/)
  assert.match((await s.call('vm_restore', { name: 'a' })).text, /has no 'checkpoints' feature, which vm_restore needs/)
})

test('a take whose outcome can\'t be read stays journalled: it counts against the cap, shows unconfirmed, can\'t be restored, and goes with the lease', async t => {
  const { s, sc, stubVm } = await lease(t, 'cp-pending', { policy: { maxLeaseCheckpoints: 1 } })
  await s.call('vm_start', {})
  sc.patchStub(st => { st.productionFail = true; st.snapshotsFail = true })
  assert.match((await s.call('vm_checkpoint', { name: 'a' })).text, /couldn't be taken/)
  sc.patchStub(st => { st.productionFail = false; st.snapshotsFail = false })
  assert.match((await s.call('vm_status')).text, /your checkpoints: "a" \(unconfirmed\)/)
  assert.match((await s.call('vm_checkpoint', { name: 'b' })).text, /holds 1 checkpoints, the policy's maxLeaseCheckpoints \(1\)/, 'the unsettled take holds its slot')
  assert.match((await s.call('vm_restore', { name: 'a' })).text, /wasn't confirmed when it was taken: it can't be restored/)
  assert.match((await s.call('vm_release')).text, /^Released/)
  assert.deepStrictEqual(stubVm().checkpoints.map(c => c.name), ['clean'])
})

test('a checkpoint\'s take and restore never move the lease\'s deadline or its session end (the host\'s records, not the guest\'s)', async t => {
  const { s } = await lease(t, 'cp-deadline')
  await s.call('vm_start', {})
  const until = async () => /until (\S+Z) \(session ends by (\S+Z)\)/.exec((await s.call('vm_status')).text).slice(1)
  const before = await until()
  await s.call('vm_checkpoint', { name: 'a' })
  await s.call('vm_restore', { name: 'a' })
  assert.deepStrictEqual(await until(), before)
})
