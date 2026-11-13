/**
 * The helper's core: the only code that holds Hyper-V rights (in the service, or in-process in direct mode). It is the
 * security boundary: anything running as the user can reach it without server.js, so every rule about VMs, the pool,
 * disks, switches, CPU, checkpoints, leases and approvals is checked here.
 *
 * Invariants:
 * - It acts only on VMs the journal records as its own, by VM id, and hv.ps1 re-checks each one's name and folder.
 * - Every pool change needs an approval written by the elevated approve.ps1 (not writable by the user or the service),
 *   bound to the plan's digest, operation, expiry, epoch and a single-use nonce; and stays within policy.json.
 * - Every pool change is journalled before each side effect, and recovered at start (journal.js).
 * - Every start restores the clean checkpoint by id first, unconditionally; every stop and release restores it and
 *   verifies the baseline (Off, parent = clean, adapter disconnected, reserve 0). A VM that fails that is quarantined.
 * - Leases end on release, at their deadline, or when their connection closes.
 */
const fs = require('fs')
const crypto = require('crypto')
const { join, win32 } = require('path')
const { Journal } = require('./journal')
const policyMod = require('./policy')
const { segments, globMatcher } = require('./paths')
const images = require('./images')

const PLAN_ID_RE = /^p-[0-9a-f]{16}$/
const PLAN_TTL_MS = 30 * 60_000
const OUTPUT_CAP = 16 * 1024
const MAX_COMMAND = 8000
const READY_WAIT_MS = Number(process.env.HYPERV_MCP_READY_WAIT_MS || 5 * 60_000)
const INSTALL_WAIT_MS = Number(process.env.HYPERV_MCP_INSTALL_WAIT_MS || 90 * 60_000)
const POLL_MS = Number(process.env.HYPERV_MCP_POLL_MS || 3000)
const RETRY_MS = Number(process.env.HYPERV_MCP_RETRY_MS || 5 * 60_000)
const CHUNK_MAX = 1024 * 1024
const MINUTE_MS = Number(process.env.HYPERV_MCP_MINUTE_MS || 60_000) // test-only: shorter lease minutes

const hex = n => crypto.randomBytes(n).toString('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const mins = ms => `${Math.max(0, Math.round(ms / 60000))} min`

/** Canonical JSON: keys sorted, no spaces, so a plan's bytes (and digest) are one exact text. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/** A simple FIFO lock. */
function mutex() {
  let chain = Promise.resolve()
  return fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p }
}

class Helper {
  /**
   * stateDir: the helper's own folder (%ProgramData%\hyperv-mcp); hv: the Hyper-V runner (hv.js); approvalsDir: where
   * approve.ps1 writes (default stateDir\approvals); checkApprovalAcl: whether to ask hv.ps1 to confirm that only
   * Administrators and SYSTEM can write there (on in the service; tests run without real ACLs).
   */
  constructor({ stateDir, hv, approvalsDir, checkApprovalAcl = true, now = () => Date.now(), log = () => {} }) {
    this.dir = stateDir
    this.hv = hv
    this.approvalsDir = approvalsDir || join(stateDir, 'approvals')
    this.checkApprovalAcl = checkApprovalAcl
    this.now = now
    this.log = log
    this.poolLock = mutex()
    this.vmLocks = new Map()
    this.leases = new Map() // vmId -> lease
    this.conns = new Map() // connId -> { pid, vmId }
    this.job = null // the pool job in progress: { jobId, op, progress, promise }
    this.imageJob = null
    this.lastJob = null
    this.quiesced = false
    this.timers = new Set()
    this.ready = false
  }

  // ---------- start-up ----------

  async init() {
    this.policy = policyMod.load(this.dir)
    this.journal = new Journal(this.dir).open()
    for (const d of ['plans', 'runs', 'secrets']) fs.mkdirSync(join(this.dir, d), { recursive: true })
    fs.rmSync(join(this.dir, 'runs'), { recursive: true, force: true }) // per-run staging: swept at every start
    fs.mkdirSync(join(this.dir, 'runs'), { recursive: true })
    this.recovery = await this.recover()
    this.ready = true
    const t = setInterval(() => void this.retryQuarantined(), RETRY_MS)
    t.unref?.()
    this.timers.add(t)
    return this
  }

  close() { for (const t of this.timers) clearInterval(t), clearTimeout(t); this.timers.clear() }

  get state() { return this.journal.state() }

  /** The VM operations' identity: what hv.ps1 re-checks before touching a VM. */
  ident(vm) { return { vmId: vm.vmId, name: vm.vmName, folder: vm.folder } }

  vmLock(vmId) {
    if (!this.vmLocks.has(vmId)) this.vmLocks.set(vmId, mutex())
    return this.vmLocks.get(vmId)
  }

  /**
   * Replays the journal and finishes or undoes whatever a crash interrupted, before any connection is served:
   * unfinished creates are rolled back (the VM found only by its exact random name and exact folder), unfinished
   * removals completed, an unfinished switch change finished, open jobs closed, then every pool VM restored to clean.
   */
  async recover() {
    const notes = []
    let s = this.state
    for (const i of s.intents.values()) {
      if (i.done) continue
      try {
        await this.rollBack(i)
        notes.push(`Rolled back the unfinished VM ${i.vmName}.`)
      } catch (e) {
        notes.push(`Couldn't roll back the unfinished VM ${i.vmName}: ${e.message}. It is retried at the next start.`)
      }
    }
    s = this.state
    for (const vm of s.vms.values()) {
      if (!vm.removing) continue
      try {
        await this.removeVm(vm)
        notes.push(`Finished removing ${vm.vmName}.`)
      } catch (e) {
        notes.push(`Couldn't finish removing ${vm.vmName}: ${e.message}.`)
      }
    }
    s = this.state
    if (s.switch && s.switch.phase !== 'created') {
      try {
        const r = await this.finishSwitch(s.switch)
        notes.push(r.foreign ? `A switch named ${s.switch.name} exists but isn't the pool's (another id, no token of ours): left untouched.` : `Finished the interrupted change to switch ${s.switch.name}.`)
      } catch (e) {
        notes.push(`Couldn't finish the change to switch ${s.switch.name}: ${e.message}.`)
      }
    }
    for (const j of this.state.jobs.values()) {
      if (!j.ended) {
        this.journal.append({ t: 'jobEnd', jobId: j.jobId, ok: false, note: 'interrupted by a restart; recovered' })
        notes.push(`Pool job ${j.jobId} (${j.op}) was interrupted: what it did was recovered as above.`)
      }
    }
    for (const vm of this.state.vms.values()) {
      if (!vm.ready) continue
      const r = await this.restore(vm)
      notes.push(r.ok ? `${vm.vmName}: restored to clean.` : `${vm.vmName}: ${r.text}`)
    }
    return notes
  }

  /** Undoes an unfinished create: removes the VM this intent made (by id, or by exact name and folder), its folder. */
  async rollBack(intent) {
    const found = intent.vmId
      ? { vmId: intent.vmId }
      : await this.hv('find-vm', { name: intent.vmName, folder: intent.folder })
    if (found?.vmId) await this.hv('remove-vm', { vmId: found.vmId, name: intent.vmName, folder: intent.folder })
    this.removeFolder(intent.folder)
    this.journal.append({ t: 'rolledBack', intentId: intent.intentId })
  }

  async removeVm(vm) {
    await this.hv('remove-vm', this.ident(vm))
    this.removeFolder(vm.folder)
    this.journal.append({ t: 'removed', vmId: vm.vmId })
  }

  /** Deletes a VM's own folder: only an exact intent folder strictly inside a policy disk folder. */
  removeFolder(folder) {
    if (!policyMod.underDiskFolder(this.policy, folder) || !/\\pool\\i-[0-9a-f]{16}$/i.test(folder)) {
      throw new Error(`refusing to delete "${folder}": not one of the pool's VM folders`)
    }
    fs.rmSync(folder, { recursive: true, force: true })
  }

  async finishSwitch(sw) {
    if (sw.phase === 'creating' || sw.phase === 'removing') {
      // Only the pool's own: by its journalled id, or by the token written into its Notes at creation, never by name.
      const r = await this.hv('remove-switch', { name: sw.name, switchId: sw.switchId, token: sw.token })
      this.journal.append({ t: 'switch', jobId: sw.jobId, name: sw.name, phase: 'removed' })
      return r
    }
    return {}
  }

  // ---------- connections and leases ----------

  connect(connId, pid) { this.conns.set(connId, { pid, vmId: null, stage: null }) }

  /** A connection closed (its MCP server exited or was killed): its lease ends. */
  async disconnect(connId) {
    const c = this.conns.get(connId)
    this.conns.delete(connId)
    if (!c) return
    this.dropStage(c)
    const lease = c.vmId && this.leases.get(c.vmId)
    if (lease && lease.connId === connId) {
      lease.connId = null
      if (lease.kept) return // kept for inspection: it reverts at its deadline
      await this.endLease(lease, 'its connection closed')
    }
  }

  leaseOf(connId) {
    const c = this.conns.get(connId)
    const lease = c?.vmId && this.leases.get(c.vmId)
    if (!lease || lease.connId !== connId) throw new Error('This connection has no VM: call vm_acquire first.')
    if (lease.ending) throw new Error(`This connection's lease on ${lease.vmName} is ending: call vm_acquire again.`)
    return lease
  }

  /**
   * Inside a VM's lock, before acting for a lease: the lease must still be the VM's, and not ending. An operation that
   * queued for the lock while its lease ended (deadline, disconnect, release) must not act on a VM that is being
   * restored, or has been handed to someone else.
   */
  stillHeld(lease) {
    if (this.leases.get(lease.vmId) !== lease || lease.ending) throw new Error(`This connection's lease on ${lease.vmName} ended while the request waited: call vm_acquire again.`)
  }

  vmOf(lease) {
    const vm = this.state.vms.get(lease.vmId)
    if (!vm || !vm.ready) throw new Error(`VM ${lease.vmName} is no longer in the pool.`)
    return vm
  }

  /** The VMs that can be leased now: ready, not removing, not quarantined, not leased. */
  freeVms() {
    const s = this.state
    return [...s.vms.values()].filter(v => v.ready && !v.removing && !s.quarantined.has(v.vmId) && !this.leases.has(v.vmId))
  }

  acquire(connId, { minutes = 60, keepOnFailure = false } = {}) {
    return this.poolLock(async () => {
      if (this.quiesced) throw new Error('The helper is being uninstalled: no new leases.')
      const c = this.conns.get(connId)
      if (!c) throw new Error('unknown connection')
      if (c.vmId && this.leases.get(c.vmId)?.connId === connId) throw new Error(`This connection already has ${this.leases.get(c.vmId).vmName}: one VM per connection.`)
      const max = this.policy.maxLeaseMinutes
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > max) throw new Error(`minutes must be 1-${max} (the policy's maxLeaseMinutes).`)
      const vm = this.freeVms()[0]
      if (!vm) {
        const s = this.state
        const ready = [...s.vms.values()].filter(v => v.ready)
        if (!ready.length) throw new Error('The pool has no VMs yet: ask the user to create one (pool_plan, then their approval, then pool_create).')
        const next = [...this.leases.values()].sort((a, b) => a.deadline - b.deadline)[0]
        throw new Error(`No VM is free (${ready.length} in the pool${s.quarantined.size ? `, ${s.quarantined.size} quarantined` : ''}).${next ? ` The next lease ends by ${new Date(next.deadline).toISOString()}.` : ''} Try again later.`)
      }
      const lease = {
        leaseId: `l-${hex(6)}`, vmId: vm.vmId, vmName: vm.vmName, connId, ownerConn: connId, pid: c.pid, ending: null,
        deadline: this.now() + Math.round(minutes * MINUTE_MS), keepOnFailure: !!keepOnFailure,
        kept: false, running: false, failed: false, runs: 0, dirty: false, network: false, reserve: 0
      }
      this.leases.set(vm.vmId, lease)
      c.vmId = vm.vmId
      this.armDeadline(lease)
      return { text: `Leased ${vm.vmName} (lease ${lease.leaseId}) until ${new Date(lease.deadline).toISOString()}. Call vm_start next; always vm_release when done.`, data: { lease: lease.leaseId, vm: vm.vmName, deadline: lease.deadline } }
    })
  }

  armDeadline(lease) {
    clearTimeout(lease.timer)
    lease.timer = setTimeout(() => {
      this.timers.delete(lease.timer)
      void this.endLease(lease, 'its deadline passed')
    }, Math.max(0, lease.deadline - this.now()))
    lease.timer.unref?.()
    this.timers.add(lease.timer)
  }

  /**
   * Ends a lease: marks it ending at once (so nothing new, and nothing still queued, acts for it), restores the VM, then
   * frees it (or it is quarantined if the restore can't be confirmed). Ending twice shares the one ending.
   */
  endLease(lease, why) {
    if (this.leases.get(lease.vmId) !== lease) return Promise.resolve({ ok: true, text: 'already released' })
    if (lease.ending) return lease.ending
    clearTimeout(lease.timer)
    lease.ending = (async () => {
      const vm = this.state.vms.get(lease.vmId)
      let r = { ok: true, text: `${lease.vmName} restored to clean.` }
      if (vm) r = await this.vmLock(vm.vmId)(() => this.restore(vm))
      if (this.leases.get(lease.vmId) === lease) this.leases.delete(lease.vmId)
      const owner = this.conns.get(lease.ownerConn)
      if (owner && owner.vmId === lease.vmId) owner.vmId = null
      this.log(`lease ${lease.leaseId} on ${lease.vmName} ended (${why}): ${r.text}`)
      return r
    })()
    return lease.ending
  }

  /**
   * Turns the VM off, restores the clean checkpoint by id, and verifies the baseline. Quarantines it on failure.
   * Returns { ok, text }.
   */
  async restore(vm) {
    let facts = null
    let why = null
    try {
      facts = await this.hv('restore', { ...this.ident(vm), checkpointId: vm.cleanCheckpointId })
      why = baselineProblem(facts, vm)
    } catch (e) {
      why = e.message
    }
    const s = this.state
    if (why) {
      if (s.quarantined.get(vm.vmId) !== why) this.journal.append({ t: 'quarantine', vmId: vm.vmId, why })
      return { ok: false, text: `CLEANUP FAILED: ${vm.vmName} could not be confirmed clean (${why}). It is quarantined (never leased) until a restore confirms it; the helper retries every few minutes.` }
    }
    if (s.quarantined.has(vm.vmId)) this.journal.append({ t: 'unquarantine', vmId: vm.vmId })
    return { ok: true, text: `${vm.vmName} restored to clean (Off, at its clean checkpoint, network disconnected, no CPU reserve).` }
  }

  /** Retries quarantined VMs that nobody holds. */
  async retryQuarantined() {
    for (const vmId of this.state.quarantined.keys()) {
      const vm = this.state.vms.get(vmId)
      if (vm && vm.ready && !vm.removing && !this.leases.has(vmId)) await this.vmLock(vmId)(() => this.restore(vm)).catch(() => {})
    }
  }

  // ---------- build staging ----------

  dropStage(c) {
    if (c?.stage) { fs.rmSync(c.stage.dir, { recursive: true, force: true }); c.stage = null }
  }

  stageBegin(connId) {
    const lease = this.leaseOf(connId)
    const c = this.conns.get(connId)
    this.dropStage(c)
    const dir = join(this.dir, 'runs', lease.leaseId + '-' + hex(4), 'staging')
    fs.mkdirSync(dir, { recursive: true })
    c.stage = { dir, files: 0, bytes: 0, current: null, done: false }
    return { text: 'staging' }
  }

  stageFile(connId, { path, size }) {
    const c = this.conns.get(connId)
    const st = c?.stage
    if (!st || st.done) throw new Error('no build being staged: stage_begin first')
    this.closeStaged(st)
    const parts = segments(path)
    if (!Number.isInteger(size) || size < 0) throw new Error('bad size')
    if (st.bytes + size > this.policy.maxBuildMB * 1024 * 1024) throw new Error(`the build is over the policy's ${this.policy.maxBuildMB} MB`)
    if (++st.files > 100_000) throw new Error('the build has more than 100000 files')
    const file = join(st.dir, ...parts)
    fs.mkdirSync(join(file, '..'), { recursive: true })
    st.current = { fd: fs.openSync(file, 'wx'), left: size, path }
    st.bytes += size
    return { text: 'ok' }
  }

  stageChunk(connId, { data }) {
    const st = this.conns.get(connId)?.stage
    if (!st?.current) throw new Error('no staged file open')
    const buf = Buffer.from(String(data), 'base64')
    if (buf.length > CHUNK_MAX || buf.length > st.current.left) throw new Error(`${st.current.path}: more bytes than its size`)
    fs.writeSync(st.current.fd, buf)
    st.current.left -= buf.length
    return { text: 'ok' }
  }

  closeStaged(st) {
    if (!st.current) return
    fs.closeSync(st.current.fd)
    const short = st.current.left
    const p = st.current.path
    st.current = null
    if (short) throw new Error(`${p}: ${short} bytes short of its size`)
  }

  stageEnd(connId) {
    const st = this.conns.get(connId)?.stage
    if (!st) throw new Error('no build being staged')
    this.closeStaged(st)
    st.done = true
    return { text: `staged ${st.files} files, ${st.bytes} bytes`, data: { files: st.files, bytes: st.bytes } }
  }

  // ---------- runs ----------

  async start(connId, { network = false, reserveCpu = 0 } = {}) {
    const lease = this.leaseOf(connId)
    const c = this.conns.get(connId)
    if (lease.kept) throw new Error(`${lease.vmName} is kept for inspection: vm_release it, then vm_acquire again (a release restores it).`)
    if (network && !this.policy.allowNetwork) throw new Error('The policy does not allow networking.')
    if (network && this.state.switch?.phase !== 'created') throw new Error('The pool has no internal switch: create the pool with network on to use networking.')
    if (!Number.isInteger(reserveCpu) || reserveCpu < 0 || reserveCpu > this.policy.maxReservePercent) throw new Error(`reserveCpu must be a whole percentage, 0-${this.policy.maxReservePercent} (the policy's cap).`)
    if (c.stage && !c.stage.done) throw new Error('the build is still being staged')
    const vm = this.vmOf(lease)
    return this.vmLock(vm.vmId)(async () => {
      this.stillHeld(lease)
      const t0 = this.now()
      lease.running = false
      lease.failed = false
      const r = await this.restore(vm) // unconditionally, before every run
      if (!r.ok) { lease.dirty = true; throw new Error(`${r.text} The start was refused.`) }
      const tRestore = this.now()
      const sw = network ? this.state.switch : null
      await this.hv('configure-start', { ...this.ident(vm), switchName: sw ? sw.name : null, switchId: sw ? sw.switchId : null, reserve: reserveCpu })
      lease.running = true
      lease.dirty = true
      lease.network = !!network
      lease.reserve = reserveCpu
      const creds = this.creds()
      const waited = await this.waitGuest(vm, creds.admin, READY_WAIT_MS)
      if (waited === null) throw new Error(`${vm.vmName} started but its guest didn't answer within ${Math.round(READY_WAIT_MS / 1000)} s. vm_stop it and try again.`)
      let build = 'no build'
      if (c.stage?.done) {
        const res = await this.hv('copy-in', { ...this.ident(vm), cred: creds.admin, userName: creds.user.user, source: c.stage.dir }, { timeoutMs: 30 * 60_000 })
        build = `build copied in to C:\\build (${c.stage.files} files, ${c.stage.bytes} bytes${res.ms ? `, ${(res.ms / 1000).toFixed(1)} s` : ''})`
        this.dropStage(c)
      }
      return {
        text: `Started ${vm.vmName} from its clean checkpoint: restore ${((tRestore - t0) / 1000).toFixed(1)} s, guest ready after ${(waited / 1000).toFixed(1)} s; ${build}; network ${network ? `ON (internal switch ${this.state.switch.name})` : 'off'}; CPU reserve ${reserveCpu}%. C:\\out is empty. Deadline ${new Date(lease.deadline).toISOString()}.`,
        data: { vm: vm.vmName, network: !!network, reserveCpu }
      }
    })
  }

  async waitGuest(vm, cred, ms) {
    const t0 = this.now()
    while (this.now() - t0 < ms) {
      const r = await this.hv('guest-ready', { ...this.ident(vm), cred }).catch(() => null)
      if (r?.ready) return this.now() - t0
      await sleep(POLL_MS)
    }
    return null
  }

  creds() {
    const c = JSON.parse(fs.readFileSync(join(this.dir, 'secrets', 'guest.json'), 'utf8'))
    if (!c?.admin?.password || !c?.user?.password) throw new Error('the guest credentials are missing: the pool must be created again')
    return c
  }

  async run(connId, { command, shell = 'cmd', as = 'admin', timeoutSec = 120, cwd } = {}) {
    const lease = this.leaseOf(connId)
    if (!lease.running) throw new Error('The VM is not running: call vm_start first.')
    if (typeof command !== 'string' || !command.trim()) throw new Error('command is required')
    if (command.length > MAX_COMMAND) throw new Error(`command is over ${MAX_COMMAND} characters: put it in a script in the build`)
    if (!['cmd', 'powershell'].includes(shell)) throw new Error('shell must be cmd or powershell')
    if (!['admin', 'user'].includes(as)) throw new Error('as must be admin or user')
    if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) throw new Error('timeoutSec must be 1-3600')
    if (cwd !== undefined && (typeof cwd !== 'string' || !/^[a-zA-Z]:\\/.test(cwd) || cwd.length > 260 || /[\0-\x1f"]/.test(cwd))) throw new Error('cwd must be an absolute guest folder such as C:\\build')
    const vm = this.vmOf(lease)
    return this.vmLock(vm.vmId)(async () => {
      this.stillHeld(lease)
      const n = ++lease.runs
      const creds = this.creds()
      const r = await this.hv('guest-run', { ...this.ident(vm), cred: creds.admin, runAs: as === 'user' ? creds.user : null, n, command, shell, timeoutSec, cwd: cwd || 'C:\\build', cap: OUTPUT_CAP }, { timeoutMs: (timeoutSec + 120) * 1000 })
      const exit = Number.isInteger(r.exitCode) ? r.exitCode : null
      if (r.timedOut || exit !== 0) lease.failed = true
      const out = s => (typeof s === 'string' ? s : '').slice(0, OUTPUT_CAP)
      const lines = [
        r.timedOut
          ? `Timed out after ${timeoutSec} s: ${r.killed ? 'killed inside the guest by its PID (taskkill /T /F).' : 'no PID recorded; vm_stop is the fallback.'}`
          : `Exit code ${exit === null ? 'unknown' : exit}.`,
        `--- stdout${r.stdoutCut ? ` (first ${OUTPUT_CAP} bytes)` : ''} ---`, out(r.stdout),
        `--- stderr${r.stderrCut ? ` (first ${OUTPUT_CAP} bytes)` : ''} ---`, out(r.stderr)
      ]
      return { text: lines.join('\n'), isError: !!r.timedOut, data: { exitCode: exit, timedOut: !!r.timedOut } }
    })
  }

  async readOut(connId, { paths, glob, maxBytes = 256 * 1024, maxTotalBytes = 1024 * 1024 } = {}) {
    const lease = this.leaseOf(connId)
    if (!lease.running) throw new Error('The VM is not running: files in C:\\out are read while it runs (vm_stop restores it and discards them).')
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('maxBytes must be 1-16777216')
    if (!Number.isInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 64 * 1024 * 1024) throw new Error('maxTotalBytes must be 1-67108864')
    const vm = this.vmOf(lease)
    const want = []
    if (paths !== undefined) {
      if (!Array.isArray(paths) || paths.length > 200) throw new Error('paths must be a list of at most 200 paths')
      for (const p of paths) want.push(segments(p).join('/'))
    }
    const match = glob !== undefined ? globMatcher(glob) : null
    return this.vmLock(vm.vmId)(async () => {
      this.stillHeld(lease)
      const creds = this.creds()
      const listing = await this.hv('guest-list', { ...this.ident(vm), cred: creds.admin })
      const files = (Array.isArray(listing.files) ? listing.files : []).filter(f => f && typeof f.path === 'string' && Number.isFinite(f.size)).slice(0, 1000)
      const skipped = Array.isArray(listing.skipped) ? listing.skipped.slice(0, 50).map(String) : []
      if (!want.length && !match) {
        return { text: files.length ? files.map(f => `${f.path}  ${f.size} bytes`).join('\n') + (skipped.length ? `\nSkipped (links): ${skipped.join(', ')}` : '') : 'C:\\out is empty.', data: { files } }
      }
      const byPath = new Map(files.map(f => [f.path.toLowerCase(), f]))
      const chosen = []
      const missing = []
      for (const p of want) { const f = byPath.get(p.toLowerCase()); if (f) chosen.push(f); else missing.push(p) }
      if (match) for (const f of files) if (match(f.path) && !chosen.includes(f)) chosen.push(f)
      const r = chosen.length
        ? await this.hv('guest-read', { ...this.ident(vm), cred: creds.admin, paths: chosen.map(f => f.path), maxBytes, maxTotalBytes })
        : { files: [] }
      let total = 0
      const got = []
      for (const f of Array.isArray(r.files) ? r.files : []) {
        if (!f || typeof f.path !== 'string' || typeof f.data !== 'string') continue
        const buf = Buffer.from(f.data, 'base64').subarray(0, Math.max(0, Math.min(maxBytes, maxTotalBytes - total)))
        total += buf.length
        got.push({ path: f.path, size: f.size, cut: !!f.cut || buf.length < f.size, data: buf })
        if (total >= maxTotalBytes) break
      }
      return { files: got, missing, skipped }
    })
  }

  async stop(connId, { keep = false } = {}) {
    const lease = this.leaseOf(connId)
    const vm = this.vmOf(lease)
    if (keep || (lease.keepOnFailure && lease.failed)) {
      lease.kept = true
      lease.running = false
      return { text: `${vm.vmName} is kept for inspection as it is (not restored)${keep ? '' : ' because a run failed and the lease has keepOnFailure'}. It is restored when you vm_release it or at the lease's deadline (${new Date(lease.deadline).toISOString()}); vm_start is refused until then.` }
    }
    const r = await this.vmLock(vm.vmId)(() => { this.stillHeld(lease); return this.restore(vm) })
    lease.running = false
    lease.dirty = !r.ok
    return { text: r.ok ? `Reverted: ${r.text}` : r.text, isError: !r.ok }
  }

  async release(connId) {
    const lease = this.leaseOf(connId)
    lease.kept = false
    const r = await this.endLease(lease, 'released')
    return { text: r.ok ? `Released. ${r.text}` : r.text, isError: !r.ok }
  }

  // ---------- status ----------

  status(connId) {
    const s = this.state
    const mine = connId && this.conns.get(connId)?.vmId
    const vms = [...s.vms.values()].map(v => {
      const l = this.leases.get(v.vmId)
      const state = s.quarantined.has(v.vmId) ? `QUARANTINED (${s.quarantined.get(v.vmId)})`
        : v.removing ? 'removing' : !v.ready ? 'creating'
          : l ? `leased${l.kept ? ', kept for inspection' : ''}${l.running ? ', running' : ''} until ${new Date(l.deadline).toISOString()}` : 'free'
      return `- ${v.vmName}: ${v.cores} cores, ${v.memoryMB} MB, ${v.diskGB} GB disk; ${state}${v.vmId === mine ? ' (yours)' : ''}${expiry(v, this.now())}`
    })
    const img = [...s.images.values()].at(-1)
    const lines = [
      `Pool: ${vms.length ? `${vms.length} VM(s)` : 'no VMs'}; switch: ${s.switch ? `${s.switch.name} (${s.switch.phase})` : 'none'}; image: ${img ? `${img.edition} ${img.build} (${img.sha256.slice(0, 12)}…, ${img.pinned ? 'pinned' : img.source})` : 'none'}.`,
      ...vms,
      this.job ? `Pool job in progress: ${this.job.op} (${this.job.jobId}): ${this.job.progress}` : this.lastJob ? `Last pool job: ${this.lastJob.op} ${this.lastJob.ok ? 'finished' : 'FAILED'}: ${this.lastJob.note}` : null,
      this.imageJob ? `Image: ${this.imageJob.progress}` : this.lastImage ? `Image: ${this.lastImage}` : null,
      this.quiesced ? `Quiesced for uninstall: no new leases${this.quiesced.allowRemove ? '; only an approved remove of the pool' : '; no pool changes'}.` : null,
      this.recovery?.length ? `At start-up: ${this.recovery.join(' ')}` : null,
      `Policy: up to ${this.policy.maxVms} VMs, ${this.policy.maxCoresPerVm} cores each, ${this.policy.maxMemoryMBTotal} MB in all, ${this.policy.maxDiskGBPerVm} GB disks, in ${this.policy.diskFolders.join('; ')}; network ${this.policy.allowNetwork ? 'allowed (internal switch only)' : 'not allowed'}; CPU reserve up to ${this.policy.maxReservePercent}%; leases up to ${this.policy.maxLeaseMinutes} min.`
    ]
    return { text: lines.filter(Boolean).join('\n'), data: { vms: s.vms.size, job: this.job ? this.job.op : null, epoch: this.journal.epoch, connections: this.conns.size, lastJob: this.lastJob } }
  }

  // ---------- pool plans ----------

  /** pool_plan: read-only apart from writing the plan record (and starting an image check if one is needed). */
  async plan(args = {}) {
    const op = args.action ?? 'create'
    if (!['create', 'resize', 'remove'].includes(op)) throw new Error('action must be create, resize or remove')
    const s = this.state
    const pool = [...s.vms.values()]
    const facts = await this.hv('facts', { folders: this.policy.diskFolders })
    if (!facts.hyperv) throw new Error('Hyper-V is not available on this host (its service or PowerShell module is missing).')
    const plan = { id: `p-${hex(8)}`, op, epoch: this.journal.epoch, created: this.now(), expires: this.now() + PLAN_TTL_MS, prefix: this.policy.prefix, host: { logicalCpus: facts.logicalCpus, memoryMB: facts.memoryMB } }
    if (op === 'remove') {
      if (!pool.length && !s.switch) throw new Error('There is no pool to remove.')
      plan.remove = pool.map(v => ({ vmId: v.vmId, name: v.vmName, folder: v.folder }))
      plan.removeSwitch = s.switch ? s.switch.name : null
    } else {
      if (op === 'create' && pool.length) throw new Error(`The pool already has ${pool.length} VM(s): use action "resize" (or "remove" first).`)
      if (op === 'resize' && !pool.length) throw new Error('There is no pool yet: use action "create".')
      const like = pool.find(v => v.ready)
      const n = args.vms ?? (op === 'create' ? Math.min(2, this.policy.maxVms) : pool.length)
      if (!Number.isInteger(n) || n < (op === 'create' ? 1 : 0) || n > this.policy.maxVms) throw new Error(`vms must be ${op === 'create' ? 1 : 0}-${this.policy.maxVms}`)
      const cores = args.cores ?? like?.cores ?? Math.max(1, Math.min(this.policy.maxCoresPerVm, Math.floor(facts.logicalCpus / 4)))
      const memoryMB = args.memoryGB !== undefined ? Math.round(args.memoryGB * 1024) : like?.memoryMB ?? Math.min(8192, Math.floor(this.policy.maxMemoryMBTotal / Math.max(1, n) / 2) * 2)
      const diskGB = args.diskGB ?? like?.diskGB ?? Math.max(64, Math.min(this.policy.maxDiskGBPerVm, 64))
      const folders = facts.folders || []
      const location = args.location ?? like?.folder?.replace(/\\pool\\i-[0-9a-f]{16}$/i, '') ?? folders.slice().sort((a, b) => b.freeGB - a.freeGB)[0]?.folder ?? this.policy.diskFolders[0]
      if (!this.policy.diskFolders.some(d => d.toLowerCase() === win32.normalize(location).replace(/\\+$/, '').toLowerCase())) throw new Error(`location must be one of the policy's disk folders: ${this.policy.diskFolders.join('; ')}`)
      const network = op === 'create' ? !!args.network : !!s.switch
      const keep = pool.slice(0, Math.min(pool.length, n))
      const add = Math.max(0, n - pool.length)
      plan.add = Array.from({ length: add }, () => {
        const intentId = `i-${hex(8)}`
        return { intentId, name: `${this.policy.prefix}-${hex(4)}`, folder: `${location}\\pool\\${intentId}`, cores, memoryMB, diskGB }
      })
      plan.remove = pool.slice(n).map(v => ({ vmId: v.vmId, name: v.vmName, folder: v.folder }))
      plan.switch = op === 'create' && network ? `${this.policy.prefix}-internal` : null
      const bad = policyMod.checkPool(this.policy, [...keep, ...plan.add], { network })
      if (bad.length) throw new Error(`That plan is outside the policy: ${bad.join('; ')}.`)
      if (cores * 2 > facts.logicalCpus) throw new Error(`${cores} cores per VM is more than half this host's ${facts.logicalCpus} logical CPUs.`)
      const free = folders.find(f => f.folder.toLowerCase() === location.toLowerCase())?.freeGB ?? 0
      const need = plan.add.length * 40 + (plan.add.length ? 10 : 0)
      if (plan.add.length && free < need) throw new Error(`${location} has ${free} GB free; ${plan.add.length} new VM(s) need about ${need} GB (installed Windows plus checkpoints and the image).`)
      if (plan.add.length) {
        const img = await this.planImage(args.image, location)
        if (!img.ready) return { text: img.text }
        plan.image = img.image
      }
      if (!plan.add.length && !plan.remove.length) throw new Error(`The pool already has ${pool.length} VM(s): nothing to change.`)
    }
    const bytes = Buffer.from(canonical(plan), 'utf8')
    const file = join(this.dir, 'plans', `${plan.id}.json`)
    fs.writeFileSync(file, bytes, { flag: 'wx' })
    const digest = sha256(bytes)
    return { text: describePlan(plan, digest, this.approveLine(plan.id)), data: { planId: plan.id, digest } }
  }

  approveLine(planId) {
    const dir = process.env.HYPERV_MCP_INSTALL_DIR || 'C:\\Program Files\\hyperv-mcp'
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${dir}\\approve.ps1" -Plan ${planId}`
  }

  /** The image for a plan: an already verified one, or start checking the one asked for. */
  async planImage(want, location) {
    const s = this.state
    if (this.imageJob) return { ready: false, text: `The image is still being checked: ${this.imageJob.progress}. Call pool_status, then pool_plan again.` }
    const have = [...s.images.values()].filter(i => fs.existsSync(i.file))
    if (!want) {
      const img = have.at(-1)
      if (!img) throw new Error('No verified image yet: pass image { iso: "<path to the Windows 11 Enterprise evaluation ISO>" } or image { download: "win11-enterprise-eval" }.')
      return { ready: true, image: pick(img) }
    }
    const job = { progress: 'starting' }
    this.imageJob = job
    const p = images.prepare({
      want, dir: join(location, 'images'), hv: this.hv, policy: this.policy, known: s.images, ownDirs: [this.dir],
      progress: t => { job.progress = t }
    })
    p.then(img => {
      if (img.existing) { this.lastImage = `ready: ${img.edition} ${img.build} (${img.sha256.slice(0, 12)}…)`; return }
      this.journal.append({ t: 'image', ...img })
      this.lastImage = `verified: ${img.edition} ${img.build} (${img.sha256.slice(0, 12)}…, ${img.pinned ? 'pinned' : img.source})`
    }, e => { this.lastImage = `REFUSED: ${e.message}` }).finally(() => { this.imageJob = null })
    return { ready: false, text: 'Checking the image now (copied into the helper\'s folder while hashed, then its files and signatures checked before anything runs). This takes a few minutes for a 7 GB ISO: call pool_status, then pool_plan again with no image to use it.' }
  }

  // ---------- pool changes (approved) ----------

  /** pool_create / pool_resize / pool_remove: checks the approval and the policy under the pool lock, then runs the job. */
  apply(op, { planId } = {}) {
    return this.poolLock(async () => {
      if (typeof planId !== 'string' || !PLAN_ID_RE.test(planId)) throw new Error('planId must be a plan id from pool_plan (p- and 16 hex digits)')
      if (this.job) throw new Error(`A pool job is already running (${this.job.op}, ${this.job.jobId}): wait for it (pool_status).`)
      if (this.quiesced && !(op === 'remove' && this.quiesced.allowRemove)) throw new Error('The helper is being uninstalled: no pool changes (only uninstall -RemovePool\'s own approved remove).')
      let bytes
      try { bytes = fs.readFileSync(join(this.dir, 'plans', `${planId}.json`)) } catch { throw new Error(`No plan ${planId}.`) }
      const plan = JSON.parse(bytes.toString('utf8'))
      const digest = sha256(bytes)
      if (plan.op !== op) throw new Error(`Plan ${planId} is a ${plan.op} plan, not ${op}.`)
      if (plan.epoch !== this.journal.epoch) throw new Error(`Plan ${planId} belongs to an earlier pool state: make a new plan.`)
      if (this.now() > plan.expires) throw new Error(`Plan ${planId} has expired: make a new plan (pool_plan) and approve it.`)
      const nonce = await this.checkApproval(plan, digest)
      const s = this.state
      // Recheck against the pool as it is now (under the lock) and the policy.
      for (const r of plan.remove || []) {
        const vm = s.vms.get(r.vmId)
        if (!vm || vm.vmName !== r.name || vm.folder !== r.folder) throw new Error(`Plan ${planId} names ${r.name}, which is no longer in the pool as planned: make a new plan.`)
        if (this.leases.has(r.vmId)) throw new Error(`${r.name} is leased (or kept for inspection): its lease must end before it can be removed. Nothing was changed.`)
      }
      if (plan.add?.length) {
        const after = [...s.vms.values()].filter(v => !(plan.remove || []).some(r => r.vmId === v.vmId))
        const bad = policyMod.checkPool(this.policy, [...after, ...plan.add], { network: !!plan.switch || !!s.switch })
        if (bad.length) throw new Error(`Plan ${planId} is outside the policy now: ${bad.join('; ')}.`)
        if (op === 'create' && s.vms.size) throw new Error('The pool is no longer empty: make a new plan.')
        if (!s.images.has(plan.image?.sha256)) throw new Error('The plan\'s image is no longer verified: make a new plan.')
      }
      const jobId = `j-${hex(6)}`
      this.journal.append({ t: 'job', jobId, op, planId, nonce })
      for (const r of plan.remove || []) this.journal.append({ t: 'removing', jobId, vmId: r.vmId })
      const job = { jobId, op, progress: 'started' }
      this.job = job
      job.promise = this.runJob(job, plan).then(
        note => { this.journal.append({ t: 'jobEnd', jobId, ok: true, note }); this.lastJob = { op, ok: true, note } },
        e => { this.journal.append({ t: 'jobEnd', jobId, ok: false, note: e.message }); this.lastJob = { op, ok: false, note: e.message } }
      ).finally(() => { this.job = null })
      return { text: `Approved plan ${planId} accepted: pool job ${jobId} (${op}) is running. ${op === 'remove' ? '' : 'Creating a VM installs Windows unattended: about 20-40 minutes each, one at a time. '}Follow it with pool_status.`, data: { jobId } }
    })
  }

  /**
   * The approval: approvals\<planId>.json, written by the elevated approve.ps1, for this exact digest, operation and
   * epoch, unexpired, its nonce unused. Its folder must be writable only by Administrators and SYSTEM (hv.ps1 checks).
   */
  async checkApproval(plan, digest) {
    const file = join(this.approvalsDir, `${plan.id}.json`)
    let a
    try {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('link')
      a = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      throw new Error(`Plan ${plan.id} is not approved. The user approves it in an admin PowerShell with:\n${this.approveLine(plan.id)}`)
    }
    const bad = []
    if (a.planId !== plan.id) bad.push('it names another plan')
    if (String(a.digest).toLowerCase() !== digest) bad.push('its digest is not this plan\'s')
    if (a.op !== plan.op) bad.push('its operation differs')
    if (a.epoch !== this.journal.epoch) bad.push('it is from an earlier pool state')
    if (!(Date.parse(a.expires) > this.now())) bad.push('it has expired')
    if (typeof a.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(a.nonce)) bad.push('its nonce is malformed')
    else if (this.state.usedNonces.has(a.nonce)) bad.push('it has already been used')
    if (bad.length) throw new Error(`The approval of plan ${plan.id} doesn't count: ${bad.join('; ')}. Approve it again with:\n${this.approveLine(plan.id)}`)
    if (this.checkApprovalAcl) {
      const acl = await this.hv('approval-acl', { dir: this.approvalsDir, file })
      if (!acl.ok) throw new Error(`The approval of plan ${plan.id} doesn't count: ${acl.why || 'its folder can be written by someone other than Administrators and SYSTEM'}. Run setup again.`)
    }
    return a.nonce
  }

  async runJob(job, plan) {
    const done = []
    if (plan.switch) {
      job.progress = `creating the internal switch ${plan.switch}`
      const token = hex(16)
      this.journal.append({ t: 'switch', jobId: job.jobId, name: plan.switch, phase: 'creating', token })
      let sw
      try {
        sw = await this.hv('new-switch', { name: plan.switch, token })
      } catch (e) {
        // Undo whatever the attempt made: only a switch carrying this token can be removed.
        await this.finishSwitch(this.state.switch).catch(() => {})
        throw new Error(`creating the switch ${plan.switch}: ${e.message}`)
      }
      this.journal.append({ t: 'switch', jobId: job.jobId, name: plan.switch, phase: 'created', switchId: sw.switchId })
    }
    for (const r of plan.remove || []) {
      job.progress = `removing ${r.name}`
      const vm = this.state.vms.get(r.vmId)
      if (vm) await this.vmLock(vm.vmId)(() => this.removeVm(vm))
      done.push(`removed ${r.name}`)
    }
    if (plan.op === 'remove' && plan.removeSwitch) {
      job.progress = `removing the switch ${plan.removeSwitch}`
      const sw = this.state.switch
      this.journal.append({ t: 'switch', jobId: job.jobId, name: sw.name, phase: 'removing', switchId: sw.switchId })
      await this.hv('remove-switch', { name: sw.name, switchId: sw.switchId, token: sw.token })
      this.journal.append({ t: 'switch', jobId: job.jobId, name: sw.name, phase: 'removed' })
      done.push(`removed the switch ${sw.name}`)
    }
    if (plan.add?.length) this.ensureCreds()
    for (const [k, a] of (plan.add || []).entries()) {
      const label = `VM ${k + 1} of ${plan.add.length} (${a.name})`
      try {
        await this.createVm(job, plan, a, label)
        done.push(`created ${a.name}`)
      } catch (e) {
        job.progress = `${label} failed (${e.message}); rolling it back`
        const intent = this.state.intents.get(a.intentId)
        if (intent && !intent.done) await this.rollBack(intent).catch(e2 => done.push(`rollback of ${a.name} failed (${e2.message}): retried at the next start`))
        throw new Error(`${label}: ${e.message}${done.length ? ` (done before it: ${done.join(', ')})` : ''}`)
      }
    }
    return done.join(', ') || 'nothing to do'
  }

  ensureCreds() {
    const file = join(this.dir, 'secrets', 'guest.json')
    if (fs.existsSync(file)) return
    const pw = () => crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, 'x') + 'aA1!'
    fs.writeFileSync(file, JSON.stringify({ admin: { user: 'hvadmin', password: pw() }, user: { user: 'hvuser', password: pw() } }), { flag: 'wx' })
  }

  async createVm(job, plan, a, label) {
    const step = t => { job.progress = `${label}: ${t}` }
    this.journal.append({ t: 'intent', jobId: job.jobId, intentId: a.intentId, vmName: a.name, folder: a.folder, cores: a.cores, memoryMB: a.memoryMB, diskGB: a.diskGB })
    if (!policyMod.underDiskFolder(this.policy, a.folder)) throw new Error('its folder is outside the policy')
    fs.mkdirSync(a.folder, { recursive: true })
    const creds = this.creds()
    step('writing its answer file')
    const media = join(a.folder, 'setup-media')
    require('./unattend').writeMedia(media, { computerName: a.name.toUpperCase().slice(0, 15), creds })
    const unattendIso = join(a.folder, 'unattend.iso')
    await this.hv('make-iso', { source: media, out: unattendIso, label: 'HVMCP' })
    const img = this.state.images.get(plan.image.sha256)
    step('creating the VM')
    const c = await this.hv('create-vm', { name: a.name, folder: a.folder, cores: a.cores, memoryMB: a.memoryMB, diskGB: a.diskGB, iso: img.file, unattendIso })
    this.journal.append({ t: 'created', intentId: a.intentId, vmId: c.vmId })
    const vm = this.state.vms.get(c.vmId)
    step('installing Windows unattended (network off)')
    await this.hv('start-vm', this.ident(vm))
    const waited = await this.waitGuest(vm, creds.admin, INSTALL_WAIT_MS)
    if (waited === null) throw new Error(`Windows setup didn't finish within ${Math.round(INSTALL_WAIT_MS / 60000)} minutes`)
    step('setting up the guest and checking its install media')
    const g = await this.hv('guest-setup', { ...this.ident(vm), cred: creds.admin, userName: creds.user.user }, { timeoutMs: 15 * 60_000 })
    const why = images.guestReportProblem(g, img)
    if (why) throw new Error(`the guest's sanity check failed: ${why}`)
    step('shutting down and taking the clean checkpoint')
    const cp = await this.hv('make-clean', { ...this.ident(vm) }, { timeoutMs: 15 * 60_000 })
    fs.rmSync(media, { recursive: true, force: true })
    fs.rmSync(unattendIso, { force: true })
    const facts = await this.hv('restore', { ...this.ident(vm), checkpointId: cp.checkpointId })
    const bad = baselineProblem(facts, { ...vm, cleanCheckpointId: cp.checkpointId })
    if (bad) throw new Error(`its clean baseline doesn't verify: ${bad}`)
    this.journal.append({ t: 'ready', intentId: a.intentId, vmId: vm.vmId, cleanCheckpointId: cp.checkpointId })
  }

  // ---------- uninstall ----------

  /**
   * Quiesce for uninstall: authorised like a pool change, by approvals\quiesce.json (written by the elevated
   * uninstall.ps1) with an unused nonce. Refuses new leases, ends every lease (kept ones too) and restores every VM.
   * Its purpose decides what may still happen: 'keep-pool' allows no pool change at all; 'remove-pool' allows exactly
   * one kind, an approved remove plan (uninstall -RemovePool's own), and nothing else.
   */
  quiesce() {
    return this.poolLock(async () => {
      const file = join(this.approvalsDir, 'quiesce.json')
      let a
      try { a = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { throw new Error('quiesce is for uninstall.ps1 only (no approval)') }
      if (a.epoch !== this.journal.epoch || !(Date.parse(a.expires) > this.now()) || !/^[0-9a-f]{32}$/.test(a.nonce ?? '') || this.state.usedNonces.has(a.nonce)) throw new Error('quiesce: its approval is expired, used or from another state')
      if (this.checkApprovalAcl) {
        const acl = await this.hv('approval-acl', { dir: this.approvalsDir, file })
        if (!acl.ok) throw new Error(`quiesce: ${acl.why}`)
      }
      if (!['keep-pool', 'remove-pool'].includes(a.purpose)) throw new Error('quiesce: its approval names no purpose (keep-pool or remove-pool)')
      if (this.job) throw new Error(`a pool job is running (${this.job.op}): wait for it`)
      const jobId = `j-${hex(6)}`
      this.journal.append({ t: 'job', jobId, op: 'quiesce', nonce: a.nonce })
      this.journal.append({ t: 'jobEnd', jobId, ok: true, note: a.purpose })
      this.quiesced = { allowRemove: a.purpose === 'remove-pool' }
      const failed = []
      for (const lease of [...this.leases.values()]) { lease.kept = false; const r = await this.endLease(lease, 'uninstall'); if (!r.ok) failed.push(lease.vmName) }
      for (const vm of this.state.vms.values()) if (vm.ready && !this.leases.has(vm.vmId)) { const r = await this.vmLock(vm.vmId)(() => this.restore(vm)); if (!r.ok && !failed.includes(vm.vmName)) failed.push(vm.vmName) }
      if (failed.length) return { text: `QUIESCE INCOMPLETE: ${failed.join(', ')} could not be restored.`, isError: true }
      return { text: `Quiesced: no leases, every VM restored (${this.state.vms.size}).` }
    })
  }

  // ---------- dispatch ----------

  async request(connId, op, args = {}) {
    if (!this.ready) throw new Error('the helper is still starting')
    switch (op) {
      case 'status': return this.status(connId)
      case 'acquire': return this.acquire(connId, args)
      case 'stage_begin': return this.stageBegin(connId)
      case 'stage_file': return this.stageFile(connId, args)
      case 'stage_chunk': return this.stageChunk(connId, args)
      case 'stage_end': return this.stageEnd(connId)
      case 'start': return this.start(connId, args)
      case 'run': return this.run(connId, args)
      case 'read_out': return this.readOut(connId, args)
      case 'stop': return this.stop(connId, args)
      case 'release': return this.release(connId)
      case 'pool_plan': return this.plan(args)
      case 'pool_create': return this.apply('create', args)
      case 'pool_resize': return this.apply('resize', args)
      case 'pool_remove': return this.apply('remove', args)
      case 'quiesce': return this.quiesce()
      case 'version': return { text: PROTOCOL, data: { protocol: PROTOCOL } }
      default: throw new Error(`unknown operation ${op}`)
    }
  }
}

const PROTOCOL = 'hyperv-mcp/1'
const EVAL_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

/** A warning when a VM's evaluation install is within 14 days of its 90 (counted from its clean checkpoint), or ''. */
function expiry(vm, now) {
  if (!vm.readyAt) return ''
  const left = Math.floor((Date.parse(vm.readyAt) + EVAL_DAYS * DAY_MS - now) / DAY_MS)
  if (left > 14) return ''
  return left > 0
    ? `. WARNING: its Windows evaluation expires in about ${left} day(s): ask the user to rebuild the pool (plan a remove, then a create).`
    : '. WARNING: its Windows evaluation has expired: ask the user to rebuild the pool (plan a remove, then a create).'
}

/** Why restored facts aren't the clean baseline, or null. */
function baselineProblem(f, vm) {
  if (!f || typeof f !== 'object') return 'no facts'
  if (f.vmId !== vm.vmId) return 'a different VM answered'
  if (f.state !== 'Off') return `state is ${f.state}, not Off`
  if (!vm.cleanCheckpointId) return 'no clean checkpoint recorded'
  if (!Array.isArray(f.checkpointIds) || !f.checkpointIds.includes(vm.cleanCheckpointId)) return 'its clean checkpoint is missing'
  if (f.parentCheckpointId !== vm.cleanCheckpointId) return 'it is not at its clean checkpoint'
  if (f.switchName) return `its network adapter is connected to ${f.switchName}`
  if (f.reserve !== 0) return `CPU reserve is ${f.reserve}%`
  return null
}

const pick = img => ({ sha256: img.sha256, size: img.size, edition: img.edition, build: img.build, pinned: img.pinned, source: img.source })

function describePlan(plan, digest, approve) {
  const lines = [`Plan ${plan.id} (${plan.op}), valid for 30 minutes. Digest ${digest}; its first 6 characters are ${digest.slice(0, 6)}.`]
  for (const a of plan.add || []) lines.push(`- create ${a.name}: ${a.cores} cores, ${a.memoryMB} MB static memory, ${a.diskGB} GB dynamic disk, in ${a.folder}; network adapter disconnected`)
  for (const r of plan.remove || []) lines.push(`- remove ${r.name} and its folder ${r.folder}`)
  if (plan.switch) lines.push(`- create the internal switch ${plan.switch} (host and guests only; no internet, no LAN)`)
  if (plan.removeSwitch) lines.push(`- remove the switch ${plan.removeSwitch}`)
  if (plan.image) lines.push(`- image: ${plan.image.edition} build ${plan.image.build}, SHA-256 ${plan.image.sha256} (${plan.image.pinned ? 'pinned: a known Microsoft download' : plan.image.source === 'download' ? 'downloaded by the helper over HTTPS from Microsoft' : 'NOT AUTHENTICATED: a local file you chose to trust'})`)
  lines.push(`Host: ${plan.host.logicalCpus} logical CPUs, ${plan.host.memoryMB} MB.`)
  lines.push('', 'Nothing is changed until the user approves this exact plan, in an admin PowerShell (one UAC prompt):', approve,
    'It shows the plan from the helper\'s own record and asks for the 6 characters above. Then call ' + `pool_${plan.op}({ planId: "${plan.id}" }).`,
    'Don\'t approve it for the user: only they can, and only they should.')
  return lines.join('\n')
}

module.exports = { Helper, canonical, baselineProblem, expiry, PLAN_ID_RE, PROTOCOL }
