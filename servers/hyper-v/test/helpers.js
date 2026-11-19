/**
 * Test helpers: a scratch folder per test (a fake state folder with policy.json, a disk folder, a fake profile and a
 * builds root), the stub's state, the helper run as a child process speaking the host protocol (as HvMcpHost.exe
 * does), approvals written the way approve.ps1 writes them, and the stdio client for server.js.
 * Scratch goes under HYPERV_TEST_SCRATCH (default %LOCALAPPDATA%\combwork-mcp-tests\hyperv-mcp-tests), never the repo;
 * the repo's test/clean-scratch.js clears earlier runs' folders there before `npm test`.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { createInterface } = require('readline')
const BASE = require('../../../test/clean-scratch').TARGETS['hyper-v'].base
// MC-1558: every test timing, from test/timing.json (generous defaults; 'narrow' values asked for by name). T.waitForMs,
// T.spawnMs, ... are its waits; T.bounds its deliberate narrow results.
const TIMING = JSON.parse(fs.readFileSync(path.join(__dirname, 'timing.json'), 'utf8'))
const T = {
  ...TIMING.waits, bounds: TIMING.bounds, env: TIMING.env, narrow: TIMING.narrow,
  /** A named set of the helper's test-only timing env (timing.json's profiles), as env strings. */
  profile(name) {
    const p = TIMING.profiles[name]
    if (!p || name.startsWith('_')) throw new Error(`timing.json has no profile ${name}`)
    return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]))
  }
}
/** The helper's test-only timing env: the defaults, with 'narrow' (all) or the named narrow values over them. */
function timingEnv(timing) {
  const env = { ...TIMING.env }
  const names = timing === 'narrow' ? Object.keys(TIMING.narrow) : Array.isArray(timing) ? timing : []
  for (const n of names) { if (!(n in TIMING.narrow)) throw new Error(`timing.json has no narrow ${n}`); env[n] = TIMING.narrow[n] }
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]))
}

const STUB = path.join(__dirname, 'stub-hv.js')
const SSH_STUB = path.join(__dirname, 'stub-guest.js') // MC-1501: a Linux guest, in place of ssh.exe
const HELPER = path.join(__dirname, '..', 'helper', 'helper.js')
const SERVER = path.join(__dirname, '..', 'server.js')

// Every helper started by a test file is ended when the file's tests are done, also after a failure, so a leftover
// child can't keep the test run alive.
const started = new Set()
require('node:test').after(async () => { await Promise.all([...started].map(c => { c.kill(); return new Promise(r => (c.exitCode !== null || c.signalCode !== null) ? r() : c.on('exit', r)) })) })

/**
 * MC-1546: the stub's state file, as text that parses. A stub process may be mid-write (writeFileSync truncates, then
 * writes), so a read that doesn't parse is retried, as the stubs' own loads do: up to 50 times, 10 ms apart, then the
 * parse error is thrown. Never a half-written file taken as the state, nor a torn text searched for a secret.
 */
function readState(file) {
  let last
  for (let i = 0; i < 50; i++) {
    const text = fs.readFileSync(file, 'utf8')
    try { JSON.parse(text); return text } catch (e) { last = e }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  throw last
}

let seq = 0
// MC-1556: setup's host-mode switch, as setup records it in policy.json and as the stub's Hyper-V has it.
const HOST_SWITCH_ID = '5e7a1c2b-0d3e-4f5a-8b6c-7d8e9f0a1b2c'
const HOST_NETWORK = { switchId: HOST_SWITCH_ID, switchName: 'hvmcp-host', subnet: '10.137.42.0/24', hostAddress: '10.137.42.1' }
/** A fresh folder: state (policy.json), disks, a fake profile and builds, and the stub's state. */
function scratch(name, { policy = {}, stub = {}, timing = null } = {}) {
  const dir = path.join(BASE, `${process.pid}-${++seq}-${name}`)
  fs.rmSync(dir, { recursive: true, force: true })
  for (const d of ['state/approvals', 'disks', 'home/.ssh', 'builds/app/sub', 'outside']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(dir, 'home/.ssh/id_ed25519'), 'SECRET')
  fs.writeFileSync(path.join(dir, 'outside/secret.txt'), 'SECRET')
  fs.writeFileSync(path.join(dir, 'builds/app/setup.exe'), 'MZ-build')
  fs.writeFileSync(path.join(dir, 'builds/app/sub/data.txt'), 'hello build')
  const disks = path.join(dir, 'disks')
  fs.writeFileSync(path.join(dir, 'state/policy.json'), JSON.stringify({
    schema: 1, prefix: 'hvmcp', maxVms: 3, maxCoresPerVm: 4, maxMemoryMBTotal: 24576, maxDiskGBPerVm: 128, diskFolders: [disks],
    maxNetwork: 'internet-lan', hostNetwork: HOST_NETWORK, maxReservePercent: 50, maxLeaseMinutes: 240, maxBuildMB: 64, ...policy
  }))
  const state = path.join(dir, 'stub.json')
  fs.writeFileSync(state, JSON.stringify({ switches: { 'hvmcp-host': { id: HOST_SWITCH_ID, type: 'Internal', notes: 'hvmcp:host:' + 'ab'.repeat(16) } }, hostNet: HOST_NETWORK, ...stub }))
  return {
    dir,
    stateDir: path.join(dir, 'state'),
    disks,
    builds: path.join(dir, 'builds'),
    stubState: state,
    env: {
      ...process.env,
      HYPERV_MCP_STATE_DIR: path.join(dir, 'state'),
      HYPERV_MCP_PS_STUB: STUB,
      HYPERV_MCP_SSH_STUB: SSH_STUB,
      HYPERV_MCP_STUB_STATE: state,
      ...timingEnv(timing),
      HYPERV_MCP_CRASH_AT: ''
    },
    stub: () => JSON.parse(readState(state)),
    stubText: () => readState(state),
    patchStub: fn => { const s = JSON.parse(readState(state)); fn(s); fs.writeFileSync(state, JSON.stringify(s)) },
    journal: () => fs.readFileSync(path.join(dir, 'state', 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  }
}

/**
 * Starts helper.js as the host does: "go", then waits for "ready". Returns { conn(pid), exited, kill(), lines }.
 * conn() opens a connection: { request(op, args), close() }.
 */
async function startHelper(sc, extraEnv = {}) {
  const child = spawn(process.execPath, [HELPER], { env: { ...sc.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  started.add(child)
  const exited = new Promise(r => child.on('exit', code => { started.delete(child); r(code) }))
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  const waiting = new Map()
  let ready
  const isReady = new Promise((resolve, reject) => {
    ready = resolve
    exited.then(code => reject(new Error(`helper exited (${code}) before ready: ${stderr}`)))
  })
  createInterface({ input: child.stdout }).on('line', line => {
    if (line === 'ready') return ready()
    const m = /^msg (\d+) (.*)$/.exec(line)
    if (!m) return
    const reply = JSON.parse(m[2])
    const w = waiting.get(`${m[1]}:${reply.id}`)
    if (w) { waiting.delete(`${m[1]}:${reply.id}`); reply.ok ? w.resolve(reply.result) : w.reject(new Error(reply.error)) }
  })
  child.stdin.on('error', () => {})
  const send = l => child.stdin.write(l + '\n')
  send('go')
  await isReady
  let nextConn = 0
  let nextId = 0
  return {
    child,
    exited,
    stderr: () => stderr,
    send,
    conn(pid = 4242) {
      const c = ++nextConn
      send(`open ${c} ${pid}`)
      return {
        id: c,
        request(op, args = {}) {
          const id = ++nextId
          return new Promise((resolve, reject) => {
            waiting.set(`${c}:${id}`, { resolve, reject })
            send(`msg ${c} ${JSON.stringify({ id, op, args })}`)
          })
        },
        raw: line => send(`msg ${c} ${line}`),
        close: () => send(`close ${c}`)
      }
    },
    async stop() { child.stdin.end(); await exited },
    kill() { child.kill(); return exited }
  }
}

/** Approves a plan as approve.ps1 does: approvals\<id>.json bound to the plan file's digest. Overrides for forgeries. */
function approve(sc, planId, over = {}) {
  const bytes = fs.readFileSync(path.join(sc.stateDir, 'plans', `${planId}.json`))
  const plan = JSON.parse(bytes)
  const epoch = JSON.parse(fs.readFileSync(path.join(sc.stateDir, 'journal.jsonl'), 'utf8').split('\n')[0]).epoch
  const a = {
    planId, digest: crypto.createHash('sha256').update(bytes).digest('hex'), op: plan.op,
    expires: new Date(Math.min(plan.expires, Date.now() + 30 * 60_000)).toISOString(), nonce: crypto.randomBytes(16).toString('hex'), epoch, ...over
  }
  fs.writeFileSync(path.join(sc.stateDir, 'approvals', `${planId}.json`), JSON.stringify(a))
  return a
}

/** Seeds a verified image in the journal (most tests don't need a real ISO). */
function seedImage(sc) {
  const dir = path.join(sc.disks, 'images')
  fs.mkdirSync(dir, { recursive: true })
  const sha256 = 'ab'.repeat(32)
  const file = path.join(dir, `${sha256}.iso`)
  fs.writeFileSync(file, 'iso')
  const line = JSON.stringify({ t: 'image', sha256, size: 3, file, source: 'local', edition: 'EnterpriseEval', build: '26200.6584', pinned: true, seq: 1000, at: new Date().toISOString() })
  fs.appendFileSync(path.join(sc.stateDir, 'journal.jsonl'), line + '\n')
}

/** Polls fn until truthy. */
async function waitFor(fn, ms = T.waitForMs, what = 'condition') {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, T.pollMs))
  }
}

/**
 * A helper with a ready pool of n VMs: starts it (creating the journal), seeds an image, restarts it, plans, approves
 * and creates the pool, and waits for the job. Returns the running helper and one admin connection.
 */
async function withPool(sc, n = 2, planArgs = {}) {
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  const admin = h.conn(1)
  const plan = await admin.request('pool_plan', { action: 'create', vms: n, cores: 2, memoryGB: 4, ...planArgs })
  approve(sc, plan.data.planId)
  await admin.request('pool_create', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: create finished/.test((await admin.request('status')).text), T.poolJobMs, 'the pool job')
  return { h, admin }
}

/**
 * MC-1575: the PowerShells installed here, each as { name ('5.1' or '7'), exe, env (its child's environment) }, found as
 * the helper finds them (HKLM). Setup, uninstall, approve and hv.ps1 run under both: a test that runs one for real runs
 * it under each. Empty off Windows.
 */
function psEngines() {
  if (process.platform !== 'win32') return []
  const hv = require('../helper/hv')
  const out = []
  const exists = f => fs.existsSync(f)
  for (const b of hv.regValues('HKLM\\SOFTWARE\\Microsoft\\PowerShell\\3\\PowerShellEngine', 'ApplicationBase', false)) {
    const exe = path.join(b, 'powershell.exe'); if (exists(exe)) { out.push({ name: '5.1', exe, env: hv.ps51Env() }); break }
  }
  const sevens = hv.regValues('HKLM\\SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions', 'InstallLocation', true).map(b => path.join(b, 'pwsh.exe')).filter(exists)
  if (sevens.length) out.push({ name: '7', exe: sevens[sevens.length - 1], env: { ...process.env } })
  return out
}

module.exports = { T, timingEnv, HOST_NETWORK, scratch, startHelper, approve, seedImage, waitFor, withPool, psEngines, STUB, SSH_STUB, HELPER, SERVER, BASE }
