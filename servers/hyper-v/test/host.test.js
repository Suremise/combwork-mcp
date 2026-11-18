// The real process topology, without a service install: HvMcpHost.cs compiled with the in-box csc.exe and run in
// console mode, supervising helper.js (against the stub Hyper-V), with server.js connecting over the named pipe as in
// service mode. Killing the helper mid-run ends that run's PowerShell child with it (the job object), closes the
// client, and the respawned helper restores the VM before the pipe reopens; killing the host ends the helper too; a
// host refuses to start on a pipe name that already exists. Skipped where csc.exe is missing.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { T, scratch, withPool, waitFor } = require('./helpers')
const { server } = require('../client')

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const skip = process.platform !== 'win32' || !fs.existsSync(CSC) ? 'needs Windows and the .NET Framework compiler' : false
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

/** Compiles the host into dir (each host its own copy: a freshly written exe can be held open by a virus scan). */
function compile(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, 'HvMcpHost.exe')
  execFileSync(CSC, ['-nologo', '-target:exe', `-out:${out}`, '-reference:System.ServiceProcess.dll', '-reference:System.Core.dll', path.join(__dirname, '..', 'helper', 'host', 'HvMcpHost.cs')], { stdio: 'pipe' })
  return out
}

/** A host in console mode for sc, on its own pipe name. Returns { child, pipe, exited, helperPids() }. */
async function startHost(sc, pipe) {
  const dir = path.join(sc.dir, `host-${pipe}-${Date.now()}`)
  compile(dir)
  const sid = execFileSync(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim().split(',').at(-1).replace(/"/g, '')
  fs.writeFileSync(path.join(dir, 'host.config'), [
    `node=${process.execPath}`, `helper=${path.join(__dirname, '..', 'helper', 'helper.js')}`, `stateDir=${sc.stateDir}`, `pipe=${pipe}`, `usersSid=S-1-5-32-545;${sid}`
  ].join('\r\n'))
  // A freshly compiled exe can be held briefly by a virus scan: retried until it starts (MC-1558: a condition, not a
  // fixed pause), within timing.json's hostSpawnRetryMs, then the spawn error named.
  let child
  const until = Date.now() + T.hostSpawnRetryMs
  for (;;) {
    child = spawn(path.join(dir, 'HvMcpHost.exe'), ['--console'], { env: sc.env, stdio: 'ignore', windowsHide: true })
    const err = await new Promise(r => { child.once('spawn', () => r(null)); child.once('error', r) })
    if (!err) break
    if (Date.now() > until) throw new Error(`can't start the host: ${err.message}`)
    await new Promise(r => setTimeout(r, T.pollMs))
  }
  const exited = new Promise(r => child.on('exit', code => r(code)))
  const log = () => { try { return fs.readFileSync(path.join(sc.stateDir, 'host.log'), 'utf8') } catch { return '' } }
  return { child, pipe, exited, log, helperPids: () => [...log().matchAll(/helper started, pid (\d+)/g)].map(m => Number(m[1])) }
}

// By listing the pipes, never by opening one (fs.existsSync on a pipe path connects to it, and still says false).
const pipeExists = name => fs.readdirSync('\\\\.\\pipe\\').some(n => n.toLowerCase() === name.toLowerCase())

test('the host: a pipe client runs a VM; the helper killed mid-run takes its run with it and the VM is restored', { skip }, async t => {
  const sc = scratch('host-kill-helper')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const pipe = `hyperv-mcp-test-${process.pid}-a`
  const host = await startHost(sc, pipe)
  t.after(async () => { host.child.kill(); await host.exited })
  await waitFor(() => pipeExists(pipe), T.waitForMs, 'the pipe')
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_PIPE: pipe }
  const a = server(env)
  t.after(() => a.close())
  assert.match((await a.call('vm_acquire')).text, /Leased hvmcp-/)
  assert.match((await a.call('vm_start')).text, /Started/)
  const marker = path.join(sc.dir, 'hang-finished.txt')
  const pidFile = path.join(sc.dir, 'hang.pid')
  // The run's child (in place of its PowerShell) records its PID, then blocks for 30 s before it would write the marker.
  const run = a.call('vm_run', { command: `hang ${marker} 30000 ${pidFile}`, timeoutSec: 120 })
  const childPid = await waitFor(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')), T.waitForMs, 'the run\'s child to record its PID')
  assert.ok(alive(childPid), 'the run\'s child is running')
  const [first] = host.helperPids()
  process.kill(first)
  const r = await run
  assert.strictEqual(r.isError, true, r.text)
  assert.match(r.text, /connection to the helper service closed/)
  await waitFor(() => !alive(childPid), T.waitForMs, 'the killed run\'s child to die with the job (else it would run 30 s more)')
  assert.ok(!fs.existsSync(marker), 'it never finished')
  await waitFor(() => (host.log().match(/helper ready/g) || []).length === 2, T.waitForMs, 'the respawned helper to recover and reopen the pipe')
  assert.match(host.log(), /ending the helper: the helper exited or closed its output/)
  const vm = Object.values(sc.stub().vms)[0]
  assert.strictEqual(vm.state, 'Off', 'restored by the new helper\'s recovery')
  const b = server(env)
  t.after(() => b.close())
  assert.match((await b.call('vm_acquire')).text, /Leased hvmcp-/, 'free again')
  const st = await a.call('vm_status')
  assert.match(st.text, /restored and its lease has ended|leased/)
})

test('the host: killing it ends its helper (the job closes); a pipe name already taken is refused', { skip }, async t => {
  const sc = scratch('host-kill-host')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const pipe = `hyperv-mcp-test-${process.pid}-b`
  const host = await startHost(sc, pipe)
  await waitFor(() => pipeExists(pipe), T.waitForMs, 'the pipe')
  const second = await startHost(sc, pipe)
  assert.strictEqual(await second.exited, 3, 'a second host on the same pipe name refuses to start')
  assert.match(host.log(), /refusing to start: a pipe named .* already exists/)
  const [helperPid] = host.helperPids()
  assert.ok(alive(helperPid))
  host.child.kill()
  await host.exited
  await waitFor(() => !alive(helperPid), T.waitForMs, 'the helper to die with the host\'s job')
  assert.ok(!pipeExists(pipe))
})

test('the host: a vm_sync whose manifest is over 4 MB goes in batches; the warm session and its lease survive', { skip }, async t => {
  const sc = scratch('host-big-manifest')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const pipe = `hyperv-mcp-test-${process.pid}-d`
  const host = await startHost(sc, pipe)
  t.after(async () => { host.child.kill(); await host.exited })
  await waitFor(() => pipeExists(pipe), T.waitForMs, 'the pipe')
  // 18000 empty files with 157-character paths: about 4.6 MB of manifest JSON, under every build cap.
  const build = path.join(sc.builds, 'big')
  const dirs = Array.from({ length: 18 }, (_, i) => path.join(build, `dir-${String(i).padStart(2, '0')}-${'d'.repeat(80)}`))
  for (const d of dirs) fs.mkdirSync(d, { recursive: true })
  for (let i = 0; i < 18000; i++) fs.writeFileSync(path.join(dirs[i % 18], `file-${String(i).padStart(5, '0')}-${'f'.repeat(54)}.txt`), '')
  const manifestBytes = 18000 * (Buffer.byteLength(JSON.stringify({ path: `${path.basename(dirs[0])}/file-00000-${'f'.repeat(54)}.txt`, size: 0, sha256: '0'.repeat(64) })) + 1)
  assert.ok(manifestBytes > 4 * 1024 * 1024, `the manifest is over the host's line limit (${manifestBytes} bytes)`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_PIPE: pipe }
  const a = server(env, { roots: [sc.builds] })
  t.after(() => a.close())
  await a.call('vm_acquire')
  await a.call('vm_start')
  await a.call('vm_run', { command: 'write state.txt warm' })
  // MC-1553: a sync this big may outlast the reply bound: then vm_wait gives its result, as an agent would get it.
  const settled = async r => { while (/still in progress/.test(r.text)) r = await a.call('vm_wait'); return r }
  const r1 = await settled(await a.call('vm_sync', { build }))
  assert.match(r1.text, /18000 file\(s\) copied/, r1.text)
  const r2 = await settled(await a.call('vm_sync'))
  assert.match(r2.text, /0 file\(s\) copied .*0 removed, 18000 unchanged/, r2.text)
  assert.doesNotMatch(host.log(), /over 4 MB/)
  assert.match((await a.call('vm_status')).text, /leased, running.*\(yours\)/, 'the same lease, still running')
  assert.match((await a.call('vm_read_out', { paths: ['state.txt'] })).content.map(c => c.text).join(), /warm/, 'no restore: the session\'s state is there')
})

test('the host: a client line can\'t forge framing, and an over-long line closes only that connection', { skip }, async t => {
  const sc = scratch('host-framing')
  const { h } = await withPool(sc, 1)
  await h.stop()
  const pipe = `hyperv-mcp-test-${process.pid}-c`
  const host = await startHost(sc, pipe)
  t.after(async () => { host.child.kill(); await host.exited })
  await waitFor(() => pipeExists(pipe), T.waitForMs, 'the pipe')
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_PIPE: pipe }
  const a = server(env)
  t.after(() => a.close())
  await a.call('vm_acquire')
  const net = require('net')
  const raw = net.connect(`\\\\.\\pipe\\${pipe}`)
  raw.on('error', () => {}) // the host closes it mid-write
  await new Promise(r => raw.once('connect', r))
  raw.write('1}\nclose 1\nmsg 1 {"id":9,"op":"release"}\n')
  raw.write('x'.repeat(5 * 1024 * 1024))
  await new Promise(r => raw.once('close', r))
  assert.match((await a.call('vm_status')).text, /leased.*\(yours\)/, 'the first connection\'s lease is untouched')
})
