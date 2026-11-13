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
const { scratch, withPool, startHelper, seedImage } = require('./helpers')
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
  assert.deepStrictEqual(list.result.tools.map(x => x.name), ['vm_acquire', 'vm_start', 'vm_run', 'vm_read_out', 'vm_stop', 'vm_release', 'vm_status', 'pool_plan', 'pool_create', 'pool_resize', 'pool_remove', 'pool_status'])
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
  assert.match(p.text, /approve\.ps1" -Plan (p-[0-9a-f]{16})/)
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
})
