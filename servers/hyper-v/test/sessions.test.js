// Warm work sessions (MC-1497): one leased VM held across several runs, vm_sync copying only changed files into the
// running guest's C:\build (no restore), vm_reset for a clean VM, vm_renew within the policy's caps; and every safety
// rule kept: release, the deadline and a disconnect still restore; build folders are checked every time; a sync plan is
// bound to its lease and generation and its staging is exact; a failed sync leaves C:\build untrusted.
// Through server.js (direct mode) and helper.js (the host protocol) against the stub Hyper-V, and the helper in-process
// with an injected clock and mocked timers for the renewal boundaries. guest-sync.test.js proves the guest side's path
// checks on real trees.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { T, scratch, startHelper, withPool, waitFor } = require('./helpers')
const { server } = require('../client')
const policy = require('../helper/policy')

const sha = d => crypto.createHash('sha256').update(d).digest('hex')
const vmOf = (sc, name) => Object.values(sc.stub().vms).find(v => v.name === name)
const buildOf = (sc, name) => Object.fromEntries(Object.entries(vmOf(sc, name).disk)
  .filter(([k, v]) => /^c:\\build\\/i.test(k) && v !== '').map(([k, v]) => [k.slice(9).replace(/\\/g, '/'), Buffer.from(v, 'base64').toString()]))
const write = (root, files) => { for (const [rel, d] of Object.entries(files)) { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, d) } }

// ---------- through server.js ----------

test('a work session: one VM across several runs, only changed files synced, a reset on request, restored at release', async t => {
  const sc = scratch('warm-session')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home') }
  const app = path.join(sc.builds, 'app')
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  const vm = /Leased (hvmcp-[0-9a-f]+)/.exec((await s.call('vm_acquire', { minutes: 30 })).text)[1]
  assert.match((await s.call('vm_start', { build: app })).text, /build copied in to C:\\build \(2 files/)
  const restores = () => vmOf(sc, vm).restores
  const r0 = restores()
  assert.deepStrictEqual(buildOf(sc, vm), { 'setup.exe': 'MZ-build', 'sub/data.txt': 'hello build' })

  // Run 1 leaves state in the guest; a sync with nothing changed copies nothing and keeps it.
  await s.call('vm_run', { command: 'write state.txt from-run-1' })
  assert.match((await s.call('vm_sync')).text, /0 file\(s\) copied .*0 removed, 2 unchanged/)
  // Edit one file, add one: only those two go in.
  write(app, { 'sub/data.txt': 'hello again', 'new/added.txt': 'added' })
  const synced = await s.call('vm_sync', { build: app })
  assert.match(synced.text, /Synced into .* 2 file\(s\) copied .*0 removed, 1 unchanged/)
  assert.deepStrictEqual(sc.stub().syncs.at(-1).files.sort(), ['new\\added.txt', 'sub\\data.txt'])
  assert.deepStrictEqual(buildOf(sc, vm), { 'setup.exe': 'MZ-build', 'sub/data.txt': 'hello again', 'new/added.txt': 'added' })
  assert.match((await s.call('vm_run', { command: 'cat C:\\build\\sub\\data.txt' })).text, /hello again/)
  assert.match((await s.call('vm_read_out', { paths: ['state.txt'] })).content.map(c => c.text).join(), /from-run-1/, 'C:\\out kept: no restore')
  assert.strictEqual(restores(), r0, 'no restore across the runs and syncs')
  // A file gone from the folder is removed in the guest.
  fs.rmSync(path.join(app, 'new'), { recursive: true })
  assert.match((await s.call('vm_sync')).text, /0 file\(s\) copied .*1 removed, 2 unchanged/)
  assert.deepStrictEqual(Object.keys(buildOf(sc, vm)).sort(), ['setup.exe', 'sub/data.txt'])

  // The lease is renewed within the caps.
  assert.match((await s.call('vm_renew', { minutes: 120 })).text, /Renewed: .* until .*session ends by/)
  assert.match((await s.call('vm_renew', { minutes: 241 })).text, /minutes must be 1-240/)
  assert.match((await s.call('vm_status')).text, /leased, running until .*\(session ends by .*\)(.|\n)*renewable to 480 min per work session \(the default\)/)

  // A reset: restored, started again with the same build (re-checked), the guest's state gone.
  assert.match((await s.call('vm_reset')).text, /Started .* from its clean checkpoint.*build copied in to C:\\build \(2 files/)
  assert.strictEqual(restores(), r0 + 1)
  assert.match((await s.call('vm_read_out')).text, /C:\\out is empty/)
  assert.deepStrictEqual(buildOf(sc, vm), { 'setup.exe': 'MZ-build', 'sub/data.txt': 'hello again' })
  // And syncing goes on after it.
  write(app, { 'setup.exe': 'MZ-v2' })
  assert.match((await s.call('vm_sync')).text, /1 file\(s\) copied/)

  // Release restores it to the verified baseline.
  assert.match((await s.call('vm_release')).text, /Released\. .*restored to clean \(Off, at its clean checkpoint, network disconnected, no CPU reserve\)/)
  const v = vmOf(sc, vm)
  assert.strictEqual(v.state, 'Off')
  assert.strictEqual(v.parent, v.checkpoints[0].id)
  assert.deepStrictEqual(buildOf(sc, vm), {})
  assert.strictEqual(restores(), r0 + 2)
})

test('vm_sync checks the build folder every time: outside the roots, the profile and a junction are refused', async t => {
  const sc = scratch('sync-roots')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home') }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  await s.call('vm_acquire')
  assert.match((await s.call('vm_sync', { build: path.join(sc.builds, 'app') })).text, /not running: vm_start it first/)
  await s.call('vm_start', { build: path.join(sc.builds, 'app') })
  assert.match((await s.call('vm_sync', { build: path.join(sc.dir, 'outside') })).text, /not under an allowed folder/)
  assert.match((await s.call('vm_sync', { build: path.join(sc.dir, 'home') })).text, /can't be used/)
  const j = path.join(sc.builds, 'j')
  require('child_process').execFileSync('cmd.exe', ['/c', 'mklink', '/J', j, path.join(sc.dir, 'outside')], { stdio: 'ignore' })
  assert.match((await s.call('vm_sync', { build: j })).text, /not under an allowed folder/)
  // A junction inside the build is skipped, never followed.
  fs.mkdirSync(path.join(sc.builds, 'app2'))
  fs.writeFileSync(path.join(sc.builds, 'app2', 'ok.txt'), 'ok')
  require('child_process').execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(sc.builds, 'app2', 'link'), path.join(sc.dir, 'outside')], { stdio: 'ignore' })
  const r = await s.call('vm_sync', { build: path.join(sc.builds, 'app2') })
  assert.match(r.text, /1 file\(s\) copied .*2 removed[\s\S]*Links skipped \(never followed\): link/)
  assert.ok(!JSON.stringify(sc.stub().syncs).includes('secret'))
  // Allowed roots are asked again each time: once the client drops a root, its folder is refused.
  s.setRoots([path.join(sc.dir, 'disks')])
  assert.match((await s.call('vm_sync', { build: path.join(sc.builds, 'app2') })).text, /not under an allowed folder/)
  assert.match((await s.call('vm_reset')).text, /not under an allowed folder/, 'reset re-checks the remembered build too')
})

// ---------- the helper's protocol ----------

/** Starts a build through the protocol, as server.js does: { 'rel': 'text' }. */
async function startWith(c, files, args = {}) {
  await c.request('stage_begin')
  for (const [p, d] of Object.entries(files)) {
    await c.request('stage_file', { path: p, size: Buffer.byteLength(d) })
    if (d.length) await c.request('stage_chunk', { data: Buffer.from(d).toString('base64') })
  }
  await c.request('stage_end')
  return c.request('start', args)
}

const manifest = files => Object.entries(files).map(([p, d]) => ({ path: p, size: Buffer.byteLength(d), sha256: sha(d) }))

/** A sync through the protocol: plan, stage exactly what it needs, apply. */
async function syncWith(c, files, opts = {}) {
  const plan = await c.request('sync_plan', { files: manifest(files), ...opts })
  const byKey = new Map(Object.entries(files).map(([p, d]) => [p.replace(/\//g, '\\').toUpperCase(), d]))
  if (plan.data.need.length) {
    await c.request('stage_begin', { planId: plan.data.planId })
    for (const p of plan.data.need) {
      const d = byKey.get(p.toUpperCase())
      await c.request('stage_file', { path: p, size: Buffer.byteLength(d) })
      if (d.length) await c.request('stage_chunk', { data: Buffer.from(d).toString('base64') })
    }
    await c.request('stage_end')
  }
  return { plan, result: await c.request('sync', { planId: plan.data.planId }) }
}

async function session(name, opts) {
  const sc = scratch(name, opts)
  const { h, admin } = await withPool(sc, 1)
  const a = h.conn(10)
  const vm = (await a.request('acquire')).data.vm
  return { sc, h, admin, a, vm }
}

test('records: delete:false keeps files (a later delete:true removes them); a full sync replaces the record outright', async t => {
  const { sc, h, a, vm } = await session('sync-record')
  t.after(() => h.stop())
  await startWith(a, { 'a.txt': 'A', 'b.txt': 'B' })
  // MR1's case: a.txt removed on the host, synced with delete:false, then delete:true.
  let r = await syncWith(a, { 'b.txt': 'B' }, { delete: false })
  assert.strictEqual(r.plan.data.remove, 0)
  assert.deepStrictEqual(buildOf(sc, vm), { 'a.txt': 'A', 'b.txt': 'B' })
  r = await syncWith(a, { 'b.txt': 'B' }, { delete: true })
  assert.strictEqual(r.plan.data.remove, 1)
  assert.deepStrictEqual(buildOf(sc, vm), { 'b.txt': 'B' })
  // A full sync after a delete:false: the old record goes, so nothing it held is removed later.
  await syncWith(a, { 'b.txt': 'B', 'c.txt': 'C' })
  await syncWith(a, { 'b.txt': 'B' }, { delete: false })
  r = await syncWith(a, { 'b.txt': 'B2' }, { full: true })
  assert.deepStrictEqual(r.plan.data.need, ['b.txt'])
  assert.deepStrictEqual(buildOf(sc, vm), { 'b.txt': 'B2' })
  r = await syncWith(a, { 'b.txt': 'B2' })
  assert.strictEqual(r.plan.data.remove, 0, 'c.txt left the record with the full sync')
  assert.strictEqual(r.plan.data.unchanged, 1)
})

test('records: file <-> folder transitions, and delete:false refusing a kept file in the new build\'s way', async t => {
  const { sc, h, a, vm } = await session('sync-transitions')
  t.after(() => h.stop())
  await startWith(a, { 'a': 'file a', 'b/inner.txt': 'in b' })
  await assert.rejects(syncWith(a, { 'a/child.txt': 'x', 'b/inner.txt': 'in b' }, { delete: false }), /with delete: false, "a" \(kept\) and "a\\child.txt" \(new\) can't both be there/)
  await assert.rejects(syncWith(a, { 'a': 'file a', 'b': 'now a file' }, { delete: false }), /with delete: false, "b\\inner.txt" \(kept\) and "b" \(new\) can't both be there/)
  assert.deepStrictEqual(buildOf(sc, vm), { 'a': 'file a', 'b/inner.txt': 'in b' }, 'nothing changed')
  await syncWith(a, { 'a/child.txt': 'now a folder', 'b': 'now a file' })
  assert.deepStrictEqual(buildOf(sc, vm), { 'a/child.txt': 'now a folder', 'b': 'now a file' })
  const r = await syncWith(a, { 'a/child.txt': 'now a folder', 'b': 'now a file' })
  assert.deepStrictEqual([r.plan.data.need.length, r.plan.data.remove, r.plan.data.unchanged], [0, 0, 2])
})

test('manifests: unsafe paths, the same file twice on Windows, and a file with its own descendant are refused', async t => {
  const { h, a } = await session('sync-manifest')
  t.after(() => h.stop())
  await startWith(a, { 'k.txt': 'k' })
  const one = p => [{ path: p, size: 1, sha256: sha('x') }]
  for (const bad of ['../x', 'C:/x', '\\\\server\\share\\x', 'a:b', 'nul', 'x/../../y', 'trail. ']) {
    await assert.rejects(a.request('sync_plan', { files: one(bad) }), /not allowed|absolute|drive|dot or space|device|":"/, bad)
  }
  await assert.rejects(a.request('sync_plan', { files: [...one('Dir/A.txt'), ...one('dir\\a.TXT')] }), /are the same file on Windows/)
  await assert.rejects(a.request('sync_plan', { files: [...one('x'), ...one('X/y.txt')] }), /"x" is a file, and also a folder of "X\\y.txt"/)
  await assert.rejects(a.request('sync_plan', { files: [{ path: 'q', size: -1, sha256: sha('x') }] }), /bad size/)
  await assert.rejects(a.request('sync_plan', { files: [{ path: 'q', size: 1, sha256: 'nope' }] }), /bad sha256/)
  await assert.rejects(a.request('sync_plan', { files: [{ path: 'big', size: 65 * 1024 * 1024, sha256: sha('x') }] }), /over the policy's 64 MB/)
})

test('plans: a replaced, used or stale plan is refused, and its staging must be exactly the needed files', async t => {
  const { sc, h, a } = await session('sync-plans')
  t.after(() => h.stop())
  await startWith(a, { 'a.txt': 'A' })
  const files = { 'a.txt': 'A2', 'b.txt': 'B' }
  const p1 = (await a.request('sync_plan', { files: manifest(files) })).data.planId
  const p2 = (await a.request('sync_plan', { files: manifest(files) })).data.planId // same generation, replaces p1
  await assert.rejects(a.request('stage_begin', { planId: p1 }), /not this lease's current plan/)
  await assert.rejects(a.request('sync', { planId: p1 }), /not this lease's current plan/)
  await assert.rejects(a.request('sync', { planId: p2 }), /files aren't all staged/)
  await a.request('stage_begin', { planId: p2 })
  await assert.rejects(a.request('stage_file', { path: 'c.txt', size: 1 }), /not one of the files sync plan .* needs/)
  await assert.rejects(a.request('stage_file', { path: 'b.txt', size: 5 }), /5 bytes, but the plan has 1: it changed while syncing/)
  await a.request('stage_file', { path: 'b.txt', size: 1 })
  await a.request('stage_chunk', { data: Buffer.from('X').toString('base64') }) // not what was hashed
  await assert.rejects(a.request('stage_end'), /isn't what the plan hashed: it changed while syncing/)
  await a.request('stage_begin', { planId: p2 })
  await a.request('stage_file', { path: 'B.TXT', size: 1 })
  await a.request('stage_chunk', { data: Buffer.from('B').toString('base64') })
  await assert.rejects(a.request('stage_file', { path: 'b.txt', size: 1 }), /staged twice/)
  await a.request('stage_begin', { planId: p2 })
  await a.request('stage_file', { path: 'b.txt', size: 1 })
  await a.request('stage_chunk', { data: Buffer.from('B').toString('base64') })
  await assert.rejects(a.request('stage_end'), /needs 1 file\(s\) not staged: a.txt/)
  await assert.rejects(a.request('sync', { planId: p2 }), /files aren't all staged/)
  const calls = sc.stub().calls.filter(c => c.op === 'copy-apply' && c.kind === 'sync').length
  assert.strictEqual(calls, 0, 'nothing reached the guest')
  // A used plan can't be applied again; a plan from before a reset is stale.
  const { plan } = await syncWith(a, files)
  await assert.rejects(a.request('sync', { planId: plan.data.planId }), /not this lease's current plan/)
  const p3 = (await a.request('sync_plan', { files: manifest({ 'a.txt': 'A3' }) })).data.planId
  await a.request('start') // a reset
  await assert.rejects(a.request('stage_begin', { planId: p3 }), /not this lease's current plan/)
  await assert.rejects(a.request('sync', { planId: p3 }), /not this lease's current plan/)
  // A start's staging never takes a plan's partial staging as its build.
  const p4 = (await a.request('sync_plan', { files: manifest({ 'z.txt': 'Z' }) })).data.planId
  await a.request('stage_begin', { planId: p4 })
  await a.request('start')
  assert.strictEqual(sc.stub().calls.filter(c => c.op === 'copy-apply' && c.kind === 'copy').length, 1, 'only the first start copied a build')
})

test('manifests in parts: bound to the lease and generation, taken once, capped per batch and in all', async t => {
  const { sc, h, a, vm } = await session('sync-manifest-parts')
  t.after(() => h.stop())
  await startWith(a, { 'a.txt': 'A' })
  await assert.rejects(a.request('manifest_add', { files: [] }), /manifest_begin first/)
  await assert.rejects(a.request('sync_plan', {}), /no manifest/)
  // In parts, then planned and applied as one manifest (aggregate checks included).
  await a.request('manifest_begin')
  await a.request('manifest_add', { files: manifest({ 'a.txt': 'A2' }) })
  await a.request('manifest_add', { files: manifest({ 'b.txt': 'B' }) })
  let plan = await a.request('sync_plan', {})
  assert.deepStrictEqual(plan.data.need.sort(), ['a.txt', 'b.txt'])
  await assert.rejects(a.request('sync_plan', {}), /no manifest/, 'taken once')
  await a.request('manifest_begin')
  await a.request('manifest_add', { files: manifest({ 'x.txt': 'X' }) })
  await a.request('manifest_add', { files: manifest({ 'X.TXT': 'X' }) })
  await assert.rejects(a.request('sync_plan', {}), /are the same file on Windows/, 'duplicates across batches')
  // Stale after a start; capped per batch and in all.
  await a.request('manifest_begin')
  await a.request('start')
  await assert.rejects(a.request('manifest_add', { files: [] }), /stale/)
  await assert.rejects(a.request('sync_plan', {}), /no manifest|stale/)
  await a.request('manifest_begin')
  const many = n => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, size: 0, sha256: sha('') }))
  await assert.rejects(a.request('manifest_add', { files: many(5001) }), /at most 5000 entries per manifest_add/)
  for (let i = 0; i < 20; i++) await a.request('manifest_add', { files: many(5000) })
  await assert.rejects(a.request('manifest_add', { files: many(1) }), /more than 100000 files/)
  // None of that touched the lease or the guest.
  assert.match((await a.request('status')).text, new RegExp(`${vm}: .*leased, running`))
  assert.strictEqual(sc.stub().calls.filter(c => c.op === 'copy-apply' && c.kind === 'sync').length, 0)
})

test('server.js refuses a request line over the host\'s 4 MB limit before sending it: the lease is untouched', async t => {
  const sc = scratch('line-guard')
  const { h } = await withPool(sc, 1)
  t.after(() => h.stop())
  const net = require('net')
  const readline = require('readline')
  // A pipe that answers like the helper and records every line's length (as the host would see it).
  const pipe = `hyperv-mcp-test-guard-${process.pid}`
  const lens = []
  const srv = net.createServer(s => readline.createInterface({ input: s, crlfDelay: Infinity }).on('line', line => {
    lens.push(line.length)
    const m = JSON.parse(line)
    s.write(JSON.stringify({ id: m.id, ok: true, result: { text: m.op === 'version' ? 'hyperv-mcp/2' : 'ok', data: m.op === 'version' ? { protocol: 'hyperv-mcp/2', buildRoots: [] } : {} } }) + '\n')
  }))
  await new Promise(r => srv.listen(`\\\\.\\pipe\\${pipe}`, r))
  t.after(() => srv.close())
  const s = server({ ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_PIPE: pipe })
  t.after(() => s.close())
  const r = await s.call('vm_run', { command: 'x'.repeat(5 * 1024 * 1024) })
  assert.strictEqual(r.isError, true)
  assert.match(r.text, /over the helper's 4 MB line limit: it was not sent \(your lease is untouched\)/)
  assert.ok(lens.every(n => n < 4 * 1024 * 1024), 'nothing over the limit reached the pipe')
  assert.match((await s.call('vm_status')).text, /Mode: service/, 'the connection still works')
})

test('a failed sync leaves C:\\build untrusted: incremental syncs are refused until a full sync or a reset', async t => {
  const { sc, h, a, vm } = await session('sync-failed')
  t.after(() => h.stop())
  await startWith(a, { 'a.txt': 'A' })
  sc.patchStub(s => { s.fail['copy-apply'] = 1 })
  await assert.rejects(syncWith(a, { 'a.txt': 'A2' }), /The sync failed \(.*injected failure.*\)\. C:\\build may be partly changed: the next vm_sync must be full: true, or vm_reset/)
  await assert.rejects(a.request('sync_plan', { files: manifest({ 'a.txt': 'A2' }) }), /didn't finish.*full: true.*vm_reset/)
  await syncWith(a, { 'a.txt': 'A2' }, { full: true })
  assert.deepStrictEqual(buildOf(sc, vm), { 'a.txt': 'A2' })
  await syncWith(a, { 'a.txt': 'A3' })
  // A failed full sync too.
  sc.patchStub(s => { s.fail['copy-apply'] = 1 })
  await assert.rejects(syncWith(a, { 'a.txt': 'A4' }, { full: true }), /The sync failed/)
  await assert.rejects(a.request('sync_plan', { files: manifest({ 'a.txt': 'A4' }) }), /didn't finish/)
  // A reset makes it trusted again.
  await startWith(a, { 'a.txt': 'A5' })
  await syncWith(a, { 'a.txt': 'A6' })
  assert.deepStrictEqual(buildOf(sc, vm), { 'a.txt': 'A6' })
  // A start that fails after the restore leaves no earlier record usable.
  sc.patchStub(s => { s.fail['copy-part'] = 1 })
  await assert.rejects(startWith(a, { 'a.txt': 'A7' }), /injected failure of copy-part/)
  await assert.rejects(a.request('sync_plan', { files: manifest({ 'a.txt': 'A6' }) }), /didn't finish/)
})

test('the guest changing C:\\build itself isn\'t tracked (documented): a full sync puts it right', async t => {
  const { sc, h, a, vm } = await session('sync-guest-edit')
  t.after(() => h.stop())
  await startWith(a, { 'a.txt': 'A' })
  await a.request('run', { command: 'write C:\\build\\a.txt changed-in-guest' })
  const r = await syncWith(a, { 'a.txt': 'A' })
  assert.strictEqual(r.plan.data.need.length, 0)
  assert.deepStrictEqual(buildOf(sc, vm), { 'a.txt': 'changed-in-guest' })
  await syncWith(a, { 'a.txt': 'A' }, { full: true })
  assert.deepStrictEqual(buildOf(sc, vm), { 'a.txt': 'A' })
})

test('sync is refused when the VM is stopped or kept, and a disconnect mid-sync kills it and restores the VM', async t => {
  const { sc, h, admin, a, vm } = await session('sync-disconnect')
  t.after(() => h.stop())
  await assert.rejects(a.request('sync_plan', { files: [] }), /not running/)
  await startWith(a, { 'a.txt': 'A' })
  await a.request('stop', { keep: true })
  await assert.rejects(a.request('sync_plan', { files: [] }), /kept for inspection/)
  await a.request('release')
  await a.request('acquire')
  await startWith(a, { 'a.txt': 'A' })
  const gate = path.join(sc.dir, 'sync-gate')
  const pidFile = path.join(sc.dir, 'sync.pid')
  sc.patchStub(s => { s.syncGate = gate; s.syncPidFile = pidFile })
  const pending = syncWith(a, { 'a.txt': 'A2' }).catch(e => e)
  // MC-1554: each step waits for what the helper itself signals (the apply's PID, the VM free in its status, the apply
  // gone), not for a time budget. What proves the lease ended "without waiting for the sync" is the gate: it stays shut
  // until after the lease ended, so a helper that waited for the apply would never free the VM. HANG_MS only stops a
  // test that would otherwise hang; it is no claim about speed (15 s timed out once in a loaded full run, 17 Nov,
  // while this step takes about 0.5 s alone and 0.7 s beside three other hyper-v test files).
  const HANG_MS = 120_000
  const pid = await waitFor(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')), HANG_MS, 'the apply to start')
  a.close()
  await waitFor(async () => /; free/.test((await admin.request('status')).text), HANG_MS, 'the lease to end without waiting for the sync')
  assert.ok(!fs.existsSync(gate), 'the gate was still shut when the VM came free: the lease didn\'t wait for the apply')
  const alive = p => { try { process.kill(p, 0); return true } catch (e) { return e.code === 'EPERM' } }
  await waitFor(() => !alive(pid), HANG_MS, 'the apply to be killed')
  const v = vmOf(sc, vm)
  assert.strictEqual(v.state, 'Off')
  assert.strictEqual(v.parent, v.checkpoints[0].id)
  assert.deepStrictEqual(buildOf(sc, vm), {})
  fs.writeFileSync(gate, 'open')
  assert.ok((await pending) instanceof Error)
})

// ---------- renewal, with an injected clock and mocked timers ----------

async function inProcess(t, name, policyOver = {}) {
  const { Helper } = require('../helper/core')
  const { hv } = require('../helper/hv')
  const sc = scratch(name, { policy: policyOver })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const saved = { ...process.env }
  Object.assign(process.env, { HYPERV_MCP_PS_STUB: sc.env.HYPERV_MCP_PS_STUB, HYPERV_MCP_STUB_STATE: sc.env.HYPERV_MCP_STUB_STATE, ...T.profile('inProcess') })
  const clock = { now: Date.parse('2026-11-13T12:00:00Z') }
  const helper = new Helper({ stateDir: sc.stateDir, hv, checkApprovalAcl: false, now: () => clock.now })
  await helper.init()
  t.after(() => { helper.close(); process.env = saved })
  helper.connect('a', 1)
  return { sc, helper, clock }
}
const MIN = 60_000

test('renew: refused at the deadline even before its timer fires; within maxLeaseMinutes; never past the session cap', async t => {
  const { helper, clock } = await inProcess(t, 'renew-bounds')
  const t0 = clock.now
  await helper.acquire('a', { minutes: 240 })
  const lease = [...helper.leases.values()][0]
  assert.strictEqual(lease.deadline, t0 + 240 * MIN)
  assert.strictEqual(lease.sessionEnd, t0 + 480 * MIN, 'the default cap: max(maxLeaseMinutes, 480)')
  assert.throws(() => helper.renew('a', { minutes: 241 }), /minutes must be 1-240/)
  assert.throws(() => helper.renew('a', { minutes: 0 }), /minutes must be 1-240/)
  clock.now = t0 + 200 * MIN
  assert.match(helper.renew('a', { minutes: 240 }).text, /until 2026-11-13T19:20:00\.000Z/)
  clock.now = t0 + 400 * MIN
  assert.throws(() => helper.renew('a', { minutes: 81 }), /past this work session's end, 2026-11-13T20:00:00\.000Z .*at most 80 minutes now\. Nothing was changed/)
  assert.strictEqual(lease.deadline, t0 + 440 * MIN, 'unchanged by the refusal')
  helper.renew('a', { minutes: 80 })
  assert.strictEqual(lease.deadline, t0 + 480 * MIN, 'exactly the cap is allowed')
  await helper.endLease(lease, 'test')

  // A new lease: one millisecond before its deadline it can still be renewed; at the deadline it can't.
  const t1 = clock.now
  await helper.acquire('a', { minutes: 30 })
  const next = [...helper.leases.values()][0]
  clock.now = next.deadline - 1
  helper.renew('a', { minutes: 30 })
  assert.strictEqual(next.deadline, t1 + 60 * MIN - 1)
  clock.now = next.deadline
  assert.throws(() => helper.renew('a', { minutes: 30 }), /has passed its deadline and is ending: it can't be renewed/)
  assert.ok(helper.leases.has(next.vmId) && !next.ending, 'its timer hasn\'t fired yet: refused all the same')
  assert.strictEqual(next.deadline, t1 + 60 * MIN - 1, 'not brought back')
})

test('renew: the policy\'s maxSessionMinutes is checked against maxLeaseMinutes, and sets the cap', async t => {
  const base = { ...policy.DEFAULTS, diskFolders: ['D:\\hv'] }
  assert.deepStrictEqual(policy.problems({ ...base, maxSessionMinutes: undefined }), [])
  assert.match(policy.problems({ ...base, maxLeaseMinutes: 240, maxSessionMinutes: 100 }).join(), /maxSessionMinutes must be a whole number, at least maxLeaseMinutes/)
  assert.deepStrictEqual(policy.problems({ ...base, maxSessionMinutes: 2000 }), [], 'MC-1579: no ceiling (formerly 1440)')
  assert.strictEqual(policy.sessionMinutes({ maxLeaseMinutes: 240 }), 480)
  assert.strictEqual(policy.sessionMinutes({ maxLeaseMinutes: 600 }), 600)
  assert.strictEqual(policy.sessionMinutes({ maxLeaseMinutes: 60, maxSessionMinutes: 90 }), 90)
  const { helper, clock } = await inProcess(t, 'renew-policy', { maxLeaseMinutes: 60, maxSessionMinutes: 90 })
  await helper.acquire('a', { minutes: 60 })
  clock.now += 50 * MIN
  assert.throws(() => helper.renew('a', { minutes: 60 }), /at most 40 minutes now/)
  assert.match(helper.status('a').text, /leases up to 60 min at a time, renewable to 90 min per work session;/)
})

test('MC-1579 round 2: a session cap past JavaScript\'s last date ends the session on that date; renewing past it is refused by name, never a RangeError', async t => {
  const huge = Number.MAX_SAFE_INTEGER
  const { helper, clock } = await inProcess(t, 'renew-datemax', { maxLeaseMinutes: huge, maxSessionMinutes: huge })
  // An own copy (its ready record's licence): no evaluation end to cap the session first.
  for (const r of helper.journal.records) if (r.t === 'ready') r.licence = { kind: 'own' }
  await helper.acquire('a', { minutes: 60 })
  const lease = [...helper.leases.values()][0]
  assert.strictEqual(lease.sessionEnd, 8.64e15, 'the last date JavaScript can hold')
  assert.doesNotThrow(() => new Date(lease.sessionEnd).toISOString())
  assert.throws(() => helper.renew('a', { minutes: huge }), /past this work session's end, \+275760-09-13T00:00:00\.000Z \(the last date JavaScript can hold\)/)
  const left = Math.floor((lease.sessionEnd - clock.now) / MIN)
  helper.renew('a', { minutes: left })
  assert.ok(lease.deadline <= lease.sessionEnd)
  assert.doesNotThrow(() => helper.status('a').text)
})

test('renew: the deadline timer is re-armed (old ones dropped, not piling up) and the renewed deadline ends the lease', async t => {
  const { sc, helper, clock } = await inProcess(t, 'renew-timer')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await helper.acquire('a', { minutes: 10 })
  const lease = [...helper.leases.values()][0]
  const before = helper.timers.size
  for (let i = 0; i < 20; i++) helper.renew('a', { minutes: 30 })
  assert.strictEqual(helper.timers.size, before, 'one deadline timer per lease, however often it is renewed')
  t.mock.timers.tick(10 * MIN) // the first deadline: cleared by the renewals
  assert.ok(helper.leases.has(lease.vmId) && !lease.ending, 'not ended at the old deadline')
  clock.now += 30 * MIN
  t.mock.timers.tick(20 * MIN) // the renewed one
  assert.ok(lease.ending, 'the renewed deadline ended it')
  t.mock.timers.reset() // the restore's own PowerShell call uses real timers
  const r = await lease.ending
  assert.strictEqual(r.ok, true)
  assert.ok(!helper.leases.has(lease.vmId))
  assert.strictEqual(Object.values(sc.stub().vms)[0].state, 'Off')
  assert.ok(!helper.timers.has(lease.timer), 'its timer is gone from the set')
})
