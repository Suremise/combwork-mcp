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

const STUB = path.join(__dirname, 'stub-hv.js')
const HELPER = path.join(__dirname, '..', 'helper', 'helper.js')
const SERVER = path.join(__dirname, '..', 'server.js')

// Every helper started by a test file is ended when the file's tests are done, also after a failure, so a leftover
// child can't keep the test run alive.
const started = new Set()
require('node:test').after(async () => { await Promise.all([...started].map(c => { c.kill(); return new Promise(r => (c.exitCode !== null || c.signalCode !== null) ? r() : c.on('exit', r)) })) })

let seq = 0
/** A fresh folder: state (policy.json), disks, a fake profile and builds, and the stub's state. */
function scratch(name, { policy = {}, stub = {} } = {}) {
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
    allowNetwork: true, maxReservePercent: 50, maxLeaseMinutes: 240, maxBuildMB: 64, allowUnpinnedIso: false, ...policy
  }))
  const state = path.join(dir, 'stub.json')
  fs.writeFileSync(state, JSON.stringify(stub))
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
      HYPERV_MCP_STUB_STATE: state,
      HYPERV_MCP_POLL_MS: '10',
      HYPERV_MCP_READY_WAIT_MS: '3000',
      HYPERV_MCP_LOGON_WAIT_MS: '3000',
      HYPERV_MCP_PROVISION_POLL_MS: '10',
      HYPERV_MCP_PROVISION_QUIET_MS: '40',
      HYPERV_MCP_PROVISION_WAIT_MS: '3000',
      HYPERV_MCP_BUILD_LOGON_WAIT_MS: '3000',
      HYPERV_MCP_LOGON_SNAPSHOT_MS: '2000',
      HYPERV_MCP_INSTALL_WAIT_MS: '3000',
      HYPERV_MCP_LOGON_STABLE_MS: '30',
      HYPERV_MCP_RETRY_MS: '600000',
      HYPERV_MCP_CRASH_AT: ''
    },
    stub: () => JSON.parse(fs.readFileSync(state, 'utf8')),
    patchStub: fn => { const s = JSON.parse(fs.readFileSync(state, 'utf8')); fn(s); fs.writeFileSync(state, JSON.stringify(s)) },
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
async function waitFor(fn, ms = 15_000, what = 'condition') {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 25))
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
  await waitFor(async () => /Last pool job: create finished/.test((await admin.request('status')).text), 15_000, 'the pool job')
  return { h, admin }
}

module.exports = { scratch, startHelper, approve, seedImage, waitFor, withPool, STUB, HELPER, SERVER, BASE }
