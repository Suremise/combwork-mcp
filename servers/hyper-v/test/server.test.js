// server.js over stdio, as an MCP client drives it: the tools, the kill switch, build folders from the client's MCP
// roots by real path (the profile, dot-folders and links refused or skipped), the build copied in, read-back, pool plans,
// and the lease ending when the server exits. Direct mode against the stub Hyper-V (the helper in-process); the pipe
// and the service host are covered by host.test.js.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const net = require('net')
const readline = require('readline')
const { T, scratch, withPool, startHelper, seedImage } = require('./helpers')
const { server } = require('../client')

async function pooled(name, n = 1) {
  const sc = scratch(name)
  const { h } = await withPool(sc, n)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home') }
  return { sc, env }
}

test('tools, instructions and the kill switch', async t => {
  const { sc, env } = await pooled('tools')
  const off = server({ ...env, HYPERV_MCP_ENABLED: '' })
  t.after(() => off.close())
  const init = await off.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  assert.strictEqual(init.result.serverInfo.name, 'hyper-v')
  assert.match(init.result.instructions, /turned off/)
  const list = await off.request('tools/list')
  assert.deepStrictEqual(list.result.tools.map(x => x.name), ['vm_acquire', 'vm_start', 'vm_renew', 'vm_sync', 'vm_reset', 'vm_run', 'vm_read_out', 'vm_stop', 'vm_checkpoint', 'vm_restore', 'vm_release', 'vm_status', 'vm_wait', 'pool_plan', 'pool_refresh', 'pool_persistence', 'pool_checkpoint', 'pool_create', 'pool_resize', 'pool_remove', 'pool_status'])
  assert.match((await off.call('vm_acquire')).text, /turned off: set HYPERV_MCP_ENABLED=1/)
  assert.match((await off.call('vm_status')).text, /Mode: direct.*TURNED OFF/)
  assert.ok(fs.existsSync(sc.stateDir))
})

test('a run with a build from the roots: copied in, links skipped, read back; the lease ends when the server exits', async t => {
  const { sc, env } = await pooled('run-build')
  const app = path.join(sc.builds, 'app')
  try { execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(app, 'escape'), path.join(sc.dir, 'outside')], { stdio: 'ignore' }) } catch { /* junctions need no admin; if it fails the skip check below is moot */ }
  const a = server(env, { roots: [sc.builds] })
  assert.match((await a.call('vm_acquire')).text, /Leased hvmcp-/)
  const start = await a.call('vm_start', { build: app })
  assert.match(start.text, /build copied in to C:\\build \(2 files, 19 bytes/)
  if (fs.existsSync(path.join(app, 'escape'))) assert.match(start.text, /Links skipped \(never followed\): escape/)
  const vm = Object.values(sc.stub().vms).find(v => v.state === 'Running')
  assert.strictEqual(Buffer.from(vm.disk['C:\\build\\sub\\data.txt'], 'base64').toString(), 'hello build')
  assert.ok(!Object.keys(vm.disk).some(k => /secret/i.test(k)), 'nothing from outside the build')
  await a.call('vm_run', { command: 'write report.txt all good' })
  sc.patchStub(s => { const v = Object.values(s.vms).find(x => x.state === 'Running'); v.disk['C:\\out\\shot.png'] = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]).toString('base64'); v.disk['C:\\out\\blob.bin'] = Buffer.from([0, 1, 2]).toString('base64') })
  const r = await a.call('vm_read_out', { paths: ['report.txt', 'shot.png', 'blob.bin', 'nope.txt'] })
  assert.match(r.text, /--- report\.txt ---\nall good/)
  assert.ok(r.content.some(c => c.type === 'image' && c.mimeType === 'image/png'))
  assert.match(r.text, /blob\.bin: binary, 3 bytes \(pass base64: true/)
  assert.match(r.text, /nope\.txt: not found/)
  await a.close()
  const b = server(env, { roots: [sc.builds] })
  t.after(() => b.close())
  assert.match((await b.call('vm_acquire')).text, /Leased hvmcp-/, 'the first server\'s lease ended when it exited')
  assert.strictEqual(Object.values(sc.stub().vms)[0].disk['C:\\out\\report.txt'], undefined, 'and its VM was restored')
})

test('build folders: only under the roots, by real path; never the profile or a dot-folder', async t => {
  const { sc, env } = await pooled('build-folders')
  fs.mkdirSync(path.join(sc.builds, 'link-parent'), { recursive: true })
  let junction = null
  try { execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(sc.builds, 'link-parent', 'out'), path.join(sc.dir, 'outside')], { stdio: 'ignore' }); junction = path.join(sc.builds, 'link-parent', 'out') } catch { /* skipped below */ }
  const a = server(env, { roots: [sc.builds] })
  t.after(() => a.close())
  await a.call('vm_acquire')
  assert.match((await a.call('vm_start', { build: path.join(sc.dir, 'outside') })).text, /is not under an allowed folder/)
  assert.match((await a.call('vm_start', { build: path.join(sc.dir, 'nope') })).text, /not found/)
  if (junction) assert.match((await a.call('vm_start', { build: junction })).text, /is not under an allowed folder/)
  const home = server(env, { roots: [path.join(sc.dir, 'home')] })
  t.after(() => home.close())
  await assert.doesNotReject(home.call('vm_status'))
  assert.match((await home.call('vm_start', { build: path.join(sc.dir, 'home', '.ssh') })).text, /can't be used/)
  const none = server(env)
  t.after(() => none.close())
  assert.match((await none.call('vm_start', { build: sc.builds })).text, /can't be used: .*roots/i)
})

test('pool tools: a plan names the approve line; without the user\'s approval nothing changes', async t => {
  const sc = scratch('server-pool')
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  const s = server({ ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct' })
  t.after(() => s.close())
  const p = await s.call('pool_plan', { vms: 1, cores: 2, memoryGB: 4 })
  assert.match(p.text, /cmd \/c call "[^"]*\\approve\.cmd" -Plan (p-[0-9a-f]{16})/)
  const id = /-Plan (p-[0-9a-f]{16})/.exec(p.text)[1]
  const c = await s.call('pool_create', { planId: id })
  assert.strictEqual(c.isError, true)
  assert.match(c.text, /is not approved/)
  assert.deepStrictEqual(Object.keys(sc.stub().vms), [])
  assert.match((await s.call('pool_status')).text, /Pool: no VMs/)
})

test('service mode without the helper: a clear refusal naming setup', async t => {
  const sc = scratch('no-service')
  const s = server({ ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_PIPE: `hyperv-mcp-test-missing-${process.pid}` })
  t.after(() => s.close())
  const r = await s.call('vm_acquire')
  assert.strictEqual(r.isError, true)
  assert.match(r.text, /helper service isn't running \(no pipe .*Has setup been run\?/)
  assert.match((await s.call('vm_status')).text, /Mode: service/)
})

// Build folders an admin named (policy.json buildRoots, by install.ps1 -BuildRoot): used beside the client's roots, by
// real path, for a client with no roots (as Codex) and one with other roots (as Claude Code); a root that is a junction,
// or in the profile's AppData\Roaming, isn't used; nothing outside both is allowed.
test('admin-set build folders: beside the client\'s roots, by real path; a junction or AppData root isn\'t used', async t => {
  const sc = scratch('admin-roots')
  const staging = path.join(sc.dir, 'staging')
  const roaming = path.join(sc.dir, 'home', 'AppData', 'Roaming', 'builds')
  for (const d of [path.join(staging, 'run1'), roaming]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(staging, 'run1', 'setup.exe'), 'MZ-staged')
  let jroot = path.join(sc.dir, 'jroot')
  let escape = path.join(staging, 'escape')
  try { execFileSync('cmd.exe', ['/c', 'mklink', '/J', jroot, path.join(sc.dir, 'outside')], { stdio: 'ignore' }) } catch { jroot = null }
  try { execFileSync('cmd.exe', ['/c', 'mklink', '/J', escape, path.join(sc.dir, 'outside')], { stdio: 'ignore' }) } catch { escape = null }
  const file = path.join(sc.stateDir, 'policy.json')
  const missing = path.join(sc.dir, 'not-yet')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), buildRoots: [staging, roaming, missing, ...(jroot ? [jroot] : [])] }))
  const { h } = await withPool(sc, 1)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home') }

  const codex = server(env) // no roots, no settings
  t.after(() => codex.close())
  const st = (await codex.call('vm_status')).text
  assert.match(st, /And from build folders set by an admin: .*staging/)
  assert.match(st, /builds" isn't used: it is in AppData\\Roaming/)
  assert.match(st, /not-yet" isn't used: it doesn't exist/)
  if (jroot) assert.match(st, /jroot" isn't used: it is or passes through a link or junction/)
  await codex.call('vm_acquire')
  assert.match((await codex.call('vm_start', { build: path.join(staging, 'run1') })).text, /build copied in to C:\\build \(1 files?, 9 bytes/)
  const refused = await codex.call('vm_start', { build: path.join(sc.dir, 'outside') })
  assert.match(refused.text, /can't be used: it is not under an allowed folder\. Your MCP roots: none \(.*\)\. Build folders set by an admin: .*staging/)
  if (escape) assert.match((await codex.call('vm_start', { build: escape })).text, /is not under an allowed folder/)
  if (jroot) assert.match((await codex.call('vm_start', { build: jroot })).text, /is not under an allowed folder/)
  assert.match((await codex.call('vm_start', { build: roaming })).text, /can't be used: it is in AppData\\Roaming/)
  await codex.call('vm_release')

  const claude = server(env, { roots: [sc.builds] }) // its own roots, unchanged
  t.after(() => claude.close())
  await claude.call('vm_acquire')
  assert.match((await claude.call('vm_start', { build: path.join(staging, 'run1') })).text, /build copied in/)
  assert.match((await claude.call('vm_start', { build: path.join(sc.builds, 'app') })).text, /build copied in/)
  // HYPERV_MCP_ALLOWED_ROOTS narrows the client's roots, not the admin's folders.
  const narrowed = server({ ...env, HYPERV_MCP_ALLOWED_ROOTS: path.join(sc.builds, 'app') }, { roots: [sc.builds] })
  t.after(() => narrowed.close())
  assert.match((await narrowed.call('vm_status')).text, /narrowed by HYPERV_MCP_ALLOWED_ROOTS[\s\S]*And from build folders set by an admin: .*staging/)
})

test('a helper from before admin-set build folders: none are used, and status says to rerun setup', async t => {
  const sc = scratch('old-helper')
  const pipe = `hyperv-mcp-test-old-${process.pid}`
  const old = net.createServer(s => readline.createInterface({ input: s }).on('line', line => {
    const m = JSON.parse(line)
    const reply = m.op === 'version' ? { ok: true, result: { text: 'hyperv-mcp/1', data: { protocol: 'hyperv-mcp/1' } } }
      : m.op === 'status' ? { ok: true, result: { text: 'Pool: no VMs.' } } : { ok: false, error: `unknown operation ${m.op}` }
    s.write(JSON.stringify({ id: m.id, ...reply }) + '\n')
  }))
  await new Promise(r => old.listen(`\\\\.\\pipe\\${pipe}`, r))
  t.after(() => old.close())
  const s = server({ ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_PIPE: pipe, USERPROFILE: path.join(sc.dir, 'home') })
  t.after(() => s.close())
  assert.match((await s.call('vm_status')).text, /set by an admin: none \(the helper predates them: run setup again/)
  assert.match((await s.call('vm_start', { build: path.join(sc.dir, 'outside') })).text, /not under an allowed folder.*predates them/)
  // Nor the warm-session operations: the tools say to update it, and status names the protocol gap.
  assert.match((await s.call('vm_status')).text, /The helper speaks hyperv-mcp\/1, this server hyperv-mcp\/3: run setup again/)
  assert.match((await s.call('vm_renew', { minutes: 10 })).text, /predates warm sessions .*run setup again/)
})

// MC-1554: a call that may outlast the 1 s bound on a loaded machine, settled through vm_wait as an agent would.
async function settled(a, r) {
  while (/still in progress after/.test(r.text)) r = await a.call('vm_wait')
  return r.text.replace(/^\S+ finished \(\d+ s after it was called\):\n/, '')
}

// MC-1553: a slow tool replies within HYPERV_MCP_REPLY_MS (1 s here) instead of outlasting the client's patience: it
// says it's still in progress and that vm_wait is the next call, and vm_wait gives the result once it settles.
test('MC-1553: a slow vm_start says "still in progress" and vm_wait gives its result; only vm_wait and status run beside it', async t => {
  const { sc, env } = await pooled('slow-start')
  const a = server({ ...env, ...T.profile('replyShort') }, { roots: [sc.builds] })
  t.after(() => a.close())
  assert.match((await a.call('vm_wait')).text, /Nothing is in progress in this session/)
  assert.match((await a.call('vm_acquire')).text, /Leased hvmcp-/)
  // A sign-in that takes its time: the guest's readiness check is held until the test opens the gate.
  const gate = path.join(sc.dir, 'ready-gate')
  sc.patchStub(s => { s.readyGate = gate })
  const t0 = Date.now()
  const start = await a.call('vm_start')
  assert.ok(Date.now() - t0 < T.bounds.replyBoundMs, `it replied within its bound, not when the start ended (${Date.now() - t0} ms)`)
  assert.match(start.text, /vm_start is still in progress after \d+ s: it goes on in this session\. Call vm_wait now/)
  assert.match(start.text, /Don't end your turn while it's in progress: nothing will wake you/)
  assert.ok(!start.isError, 'not an error: the start goes on')
  assert.match((await a.call('vm_run', { command: 'echo hi' })).text, /vm_start is still in progress in this session: call vm_wait for its result before vm_run/)
  assert.match((await a.call('vm_status')).text, /Mode: direct/, 'status runs beside it')
  assert.match((await a.call('vm_wait')).text, /vm_start is still in progress/, 'vm_wait says so again while it is held')
  fs.writeFileSync(gate, 'open')
  let done
  for (let i = 0; i < 30 && !/finished/.test((done = await a.call('vm_wait')).text); i++) { /* each call waits up to 1 s */ }
  assert.match(done.text, /^vm_start finished \(\d+ s after it was called\):\nStarted hvmcp-/)
  assert.match((await a.call('vm_wait')).text, /Nothing is in progress/, 'collected once')
  assert.match(await settled(a, await a.call('vm_run', { command: 'echo hi' })), /Exit code 0/, 'tools run again once it is collected')
})

test('MC-1553: a long vm_run replies "still in progress"; its result, if nobody waited, comes with the next call', async t => {
  const { sc, env } = await pooled('slow-run')
  const a = server({ ...env, ...T.profile('replyShort') }, { roots: [sc.builds] })
  t.after(() => a.close())
  await a.call('vm_acquire')
  await settled(a, await a.call('vm_start'))
  // "sleep" never ends: its 3 s timeout ends it, after the 1 s reply bound.
  const run = await a.call('vm_run', { command: 'sleep', timeoutSec: 3 })
  assert.match(run.text, /vm_run is still in progress after \d+ s/)
  let done
  for (let i = 0; i < 30 && !/finished/.test((done = await a.call('vm_wait')).text); i++) { /* waiting */ }
  assert.match(done.text, /^vm_run finished \(\d+ s after it was called\):\nTimed out after 3 s/)
  assert.ok(done.isError, 'a timed-out run is still reported as one')
  // Again, but nobody calls vm_wait: the result comes with the first call after it settled (round 2: observed by
  // polling, no fixed sleep), its failure named, and exactly once.
  const earlierOf = r => r.content.find(c => /^Your earlier vm_run finished/.test(c.text))?.text
  const until = async call => { for (let i = 0; i < 120; i++) { const r = await call(); if (earlierOf(r)) return r; await new Promise(res => setTimeout(res, 250)) } throw new Error('the earlier result never came') }
  assert.match((await a.call('vm_run', { command: 'sleep', timeoutSec: 2 })).text, /still in progress/)
  const next = await until(() => a.call('vm_status'))
  assert.match(earlierOf(next), /^Your earlier vm_run finished, and FAILED:\nTimed out after 2 s/)
  assert.match(next.content.at(-1).text, /Mode: direct/, 'and the call\'s own reply')
  assert.ok(!earlierOf(await a.call('vm_status')), 'given once')
  assert.match((await a.call('vm_wait')).text, /Nothing is in progress/)
  // The next call fails (round 2: its error path used to drop the result): the result still comes with it, once.
  assert.match((await a.call('vm_run', { command: 'sleep', timeoutSec: 2 })).text, /still in progress/)
  const failing = await until(() => a.call('pool_resize', { planId: 'p-0000000000000000' }))
  assert.ok(failing.isError, 'the call itself failed')
  assert.match(earlierOf(failing), /^Your earlier vm_run finished, and FAILED:\nTimed out after 2 s/)
  assert.match(failing.content.at(-1).text, /p-0000000000000000/, 'with its own error')
  assert.match((await a.call('vm_wait')).text, /Nothing is in progress/, 'delivered: not left for vm_wait')
  assert.ok(!earlierOf(await a.call('vm_status')), 'nor given again')
})

test('MC-1553: vm_renew and vm_release run beside a slow vm_start; the release ends it, and its outcome comes with the next call', async t => {
  const { sc, env } = await pooled('slow-release')
  const a = server({ ...env, ...T.profile('replyShort') }, { roots: [sc.builds] })
  t.after(() => a.close())
  await a.call('vm_acquire')
  const gate = path.join(sc.dir, 'ready-gate')
  sc.patchStub(s => { s.readyGate = gate })
  assert.match((await a.call('vm_start')).text, /vm_start is still in progress/)
  assert.match((await a.call('vm_renew', { minutes: 30 })).text, /Renewed|deadline/i, 'renew runs beside it')
  const rel = await a.call('vm_release')
  assert.match(rel.text, /^Released/)
  fs.writeFileSync(gate, 'open')
  let w
  for (let i = 0; i < 30 && /still in progress/.test((w = await a.call('vm_wait')).text); i++) { /* settling */ }
  assert.match(w.text, /^vm_start finished/, 'its outcome is still given')
  assert.doesNotMatch(w.text, /^vm_start finished[^\n]*\nStarted /, 'not a start: the lease ended under it')
})

test('server.js (MC-1577): a helper without the guest-script feature is never sent a guestScript: pool_plan refuses it with "run setup again"', async t => {
  const sc = scratch('gs-feature', { policy: { maxVms: 3 } })
  let h = await startHelper(sc)
  await h.stop()
  // A 4.1.0-era helper: no guest-script feature. It would ignore the script and build plain VMs.
  const shim = path.join(sc.dir, 'older-core.js')
  fs.writeFileSync(shim, `const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') { const v = await request.call(this, connId, op, args); return { ...v, data: { ...v.data, features: v.data.features.filter(f => f !== 'guest-script') } } }
  if (op === 'pool_plan' && args?.guestScript !== undefined) throw new Error('should not be sent: guestScript')
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env)
  t.after(() => s.close())
  const r = await s.call('pool_plan', { vms: 1, cores: 2, memoryGB: 4, guestScript: 'C:\setup\guest.ps1' })
  assert.match(r.text, /has no 'guest-script' feature, which a guest setup script \(guestScript\) needs: run setup again/)
})

test('server.js (MC-1578): a helper without the ready-images feature is never sent a ready-made disk or VM: pool_plan refuses it with "run setup again"', async t => {
  const sc = scratch('ready-feature', { policy: { maxVms: 3 } })
  let h = await startHelper(sc)
  await h.stop()
  const shim = path.join(sc.dir, 'older-core.js')
  fs.writeFileSync(shim, `const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') { const v = await request.call(this, connId, op, args); return { ...v, data: { ...v.data, features: v.data.features.filter(f => f !== 'ready-images') } } }
  if (op === 'pool_plan' && args?.image && (args.image.vhdx !== undefined || args.image.vm !== undefined)) throw new Error('should not be sent: a ready-made image')
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env)
  t.after(() => s.close())
  for (const image of [{ vhdx: 'C:\\disks\\win.vhdx', admin: 'Administrator' }, { vm: 'mywin', admin: 'Administrator' }]) {
    const r = await s.call('pool_plan', { vms: 1, cores: 2, memoryGB: 4, image })
    assert.match(r.text, /has no 'ready-images' feature, which a ready-made Windows disk or VM as the image needs: run setup again/, JSON.stringify(image))
  }
})

test('MC-1576 round 1: the advertised pool tools and instructions follow the plan: within the caps it applies; approval only when its reply says so, never by the agent', async t => {
  const { env } = await pooled('approval-text')
  const s = server(env)
  t.after(() => s.close())
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  assert.match(init.result.instructions, /A plan within the policy's caps applies when you call it; one whose reply says it needs the user's approval is approved by the user in an admin terminal \(cmd or PowerShell\): never run the approve line yourself\./)
  assert.doesNotMatch(init.result.instructions, /approves each plan/)
  const tools = Object.fromEntries((await s.request('tools/list')).result.tools.map(x => [x.name, x.description]))
  assert.match(tools.pool_plan, /Within the policy's caps \(setup's default, WithinCaps\) it applies when you call its pool_\* tool, unless it needs the user's approval: a new image no approved plan has built from, a guest setup script, or a ready-made disk or VM \(or every plan, when setup chose Each\)\. Then the reply says why and holds the one line the USER runs .*never run that line yourself/)
  for (const n of ['pool_refresh', 'pool_persistence', 'pool_checkpoint', 'pool_create', 'pool_resize', 'pool_remove']) {
    assert.match(tools[n], /Applies once, as planned, within the policy's caps \(checked again now\)\. Refused if .* needs the user's approval \(its pool_plan reply said so: a new image, a guest setup script, a ready-made disk, or every plan when setup chose Each; and always uninstall's own pool removal\)/, n)
    assert.doesNotMatch(tools[n], /Refused unless the user approved|Carry out an approved/, n)
  }
})
