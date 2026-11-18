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
 * - Leases end on release, at their deadline, or when their connection closes. A lease can be renewed (vm_renew) while
 *   its deadline hasn't passed, up to the policy's maxLeaseMinutes at a time and its maxSessionMinutes from acquire.
 * - A warm session's sync (vm_sync) copies files into the running guest's C:\build only, over PowerShell Direct (no
 *   host share), from a staging of exactly the plan's files hashed here; the guest side (guest-sync.ps1) never follows
 *   a link. It never restores, and it never stands in for one: release, the deadline and a disconnect still restore.
 */
const fs = require('fs')
const crypto = require('crypto')
const { join, win32 } = require('path')
const { Journal } = require('./journal')
const policyMod = require('./policy')
const { segments, globMatcher } = require('./paths')
const images = require('./images')
const linuxImages = require('./linux-images')
const net = require('./net')
const { LinuxDriver, PATHS: LINUX_PATHS } = require('./guests/linux')

const PLAN_ID_RE = /^p-[0-9a-f]{16}$/
const PLAN_TTL_MS = 30 * 60_000
const OUTPUT_CAP = 16 * 1024
const MAX_COMMAND = 8000
const READY_WAIT_MS = Number(process.env.HYPERV_MCP_READY_WAIT_MS || 5 * 60_000)
// MC-1556: a connected start's guest network: read back until it has held for NET_STABLE_MS (a network manager undoing
// a static address shows within it), within NET_WAIT_MS (a DHCP lease and DNS take a few seconds).
const NET_WAIT_MS = Number(process.env.HYPERV_MCP_NET_WAIT_MS || 90_000)
const NET_STABLE_MS = Number(process.env.HYPERV_MCP_NET_STABLE_MS || 5000)
// The interactive logon's own wait (MC-1518): a guest restart, the logon and the watcher starting in its session; a
// first logon from the clean checkpoint runs Windows' per-user first-logon work and can take several minutes.
const LOGON_WAIT_MS = Number(process.env.HYPERV_MCP_LOGON_WAIT_MS || 10 * 60_000)
const INSTALL_WAIT_MS = Number(process.env.HYPERV_MCP_INSTALL_WAIT_MS || 90 * 60_000)
const POLL_MS = Number(process.env.HYPERV_MCP_POLL_MS || 3000)
const LOGON_STABLE_MS = Number(process.env.HYPERV_MCP_LOGON_STABLE_MS || 10_000) // test-only override
// The build's profile provisioning (MC-1516): an account's first-logon work is taken as done after PROVISION_QUIET_MS
// of consecutive good, idle samples (PROVISION_POLL_MS apart), within PROVISION_WAIT_MS. Test-only overrides.
const PROVISION_QUIET_MS = Number(process.env.HYPERV_MCP_PROVISION_QUIET_MS || 4 * 60_000) // MC-1520: 4 min, a trial value
const PROVISION_POLL_MS = Number(process.env.HYPERV_MCP_PROVISION_POLL_MS || 15_000)
const PROVISION_WAIT_MS = Number(process.env.HYPERV_MCP_PROVISION_WAIT_MS || 30 * 60_000) // MC-1520: 30 min per account (the user's scope decision)
// MC-1520: a build-time logon attempt waits up to BUILD_LOGON_WAIT_MS (within the account's deadline), leaving room for
// one retry; one that is still waiting at LOGON_SNAPSHOT_MS (the runtime limit) gets a read-only diagnostic snapshot.
const BUILD_LOGON_WAIT_MS = Number(process.env.HYPERV_MCP_BUILD_LOGON_WAIT_MS || 15 * 60_000)
const LOGON_SNAPSHOT_MS = Number(process.env.HYPERV_MCP_LOGON_SNAPSHOT_MS || 10 * 60_000)
// MC-1526: a logon attempt with no logon event for the account this long after its new boot is first seen (host clock)
// has not begun, and ends, for a retry (a build) or a failed start. Test-only override.
const FIRST_LOGON_SIGN_MS = Number(process.env.HYPERV_MCP_FIRST_LOGON_SIGN_MS || 3 * 60_000)
const DIAG_LOGS = ['lsm', 'security', 'winlogon', 'profile', 'shellCore', 'appReadinessAdmin', 'appReadinessOperational', 'cloudExperienceHost']
const FIRST_LOGON_WORKERS = ['OneDriveSetup', 'UserOOBEBroker', 'msedgewebview2', 'CloudExperienceHostBroker', 'StartMenuExperienceHost', 'SearchHost']
const USERINIT = 'C:\\Windows\\system32\\userinit.exe,' // Windows' own list, as the build's undo leaves it
// MC-1519 (the user's decision): the guest's test work folders, excluded from Defender's scanning at build (real-time
// and scheduled scans: an ExclusionPath). The user's chosen mitigation for an intermittent load failure of a freshly
// written exe; Defender's part in it is suspected, not established.
const DEFENDER_EXCLUSIONS = ['C:\\build', 'C:\\out', 'C:\\trial-session', 'C:\\hvmcp']
const RETRY_MS = Number(process.env.HYPERV_MCP_RETRY_MS || 5 * 60_000)
// The build's one online step (MC-1513): its call's bound, and net-off's after a failure.
const ACTIVATE_MS = Number(process.env.HYPERV_MCP_ACTIVATE_MS || 8 * 60_000)
const NET_OFF_MS = 60_000
const EVAL_MIN_DAYS = 85 // a fresh evaluation build must have at least this long left (90 nominal)
const EVAL_LAST_MS = 60 * 60_000 // an evaluation VM with less than this left is no longer leased
const CHUNK_MAX = 1024 * 1024
const MANIFEST_BATCH = 5000 // entries per manifest_add, at most (server.js sends batches of at most 1 MB of JSON)
const MINUTE_MS = Number(process.env.HYPERV_MCP_MINUTE_MS || 60_000) // test-only: shorter lease minutes
// vm_acquire's queue (MC-1502): one request waits at most WAIT_MS (under a client's 60 s tool timeout), and a place in
// line is kept KEEP_MS after a wait ends without a VM, for the caller's next vm_acquire. Test-only overrides.
const WAIT_MS = Number(process.env.HYPERV_MCP_WAIT_MS || 20_000)
// One PowerShell Direct call's bound for a run's start, poll or kill (MC-1510: never near the transport's 10 minutes).
const CALL_MS = 60_000
// A poll's least bound however little of the run is left, and the bound of a timeout's cleanup (the kill, a last read).
const MIN_POLL_MS = Number(process.env.HYPERV_MCP_MIN_POLL_MS || 5_000)
const CLEANUP_MS = 15_000
const KEEP_MS = Number(process.env.HYPERV_MCP_KEEP_MS || 120_000)

const hex = n => crypto.randomBytes(n).toString('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))
// MC-1537: how long a restore's new parent is waited for, read fresh (each facts-vm its own process), probe time included.
const RESTORE_VERIFY_MS = Number(process.env.HYPERV_MCP_RESTORE_VERIFY_MS || 45_000)
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const mins = ms => `${Math.max(0, Math.round(ms / 60000))} min`

/** Canonical JSON: keys sorted, no spaces, so a plan's bytes (and digest) are one exact text. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/**
 * A guest path's canonical identity on Windows: its segments (paths.js, so "/" and "\" are one) joined by "\" and
 * upper-cased one UTF-16 unit at a time, as .NET's ToUpperInvariant does (guest-sync.ps1 uses that: the same identity on
 * both sides). A unit whose upper case is longer (such as ß) stays as it is, as in .NET.
 */
function keyOf(parts) {
  return parts.join('\\').split('').map(ch => { const u = ch.toUpperCase(); return u.length === 1 ? u : ch }).join('')
}

/** A key of `a` that is a proper ancestor (a folder) of a key of `b`, as [its path, the descendant's path], or null. */
function ancestorClash(a, b) {
  for (const [k, f] of b) {
    const parts = k.split('\\')
    for (let i = 1; i < parts.length; i++) {
      const up = parts.slice(0, i).join('\\')
      if (a.has(up)) return [a.get(up).path, f.path]
    }
  }
  return null
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
  constructor({ stateDir, hv, approvalsDir, checkApprovalAcl = true, now = () => Date.now(), log = () => {}, mono = () => performance.now(), sleepFn = sleep }) {
    this.dir = stateDir
    this.hv = hv
    this.approvalsDir = approvalsDir || join(stateDir, 'approvals')
    this.checkApprovalAcl = checkApprovalAcl
    this.now = now
    this.mono = mono // MC-1537: a monotonic clock and a sleeper, injectable, for the restore verification's deadline
    this.sleep = sleepFn
    this.log = log
    this.poolLock = mutex()
    this.vmLocks = new Map()
    this.unknownSnapshots = new Map() // MC-1529: vmId -> names of checkpoints neither clean nor a lease's: left alone
    this.pcpBusy = new Set() // MC-1532: VMs a pool-checkpoint operation has reserved: never leased or cleaned meanwhile
    this.refreshing = new Set() // MC-1531: VMs a clean refresh is working on: never leased meanwhile
    this.leases = new Map() // vmId -> lease
    this.conns = new Map() // connId -> { pid, vmId }
    this.job = null // the pool job in progress: { jobId, op, progress, promise }
    this.imageJob = null
    this.lastJob = null
    this.quiesced = false
    this.pendingCleanup = new Set() // staging folders that couldn't be removed yet (retried; swept at every start)
    // vmId -> { at, why, interactive }: the VM's last start failed after its restore (its guest didn't answer, or the
    // interactive logon never appeared). Free VMs without one are leased first; a good start clears it (MC-1513).
    this.startFailed = new Map()
    // vm_acquire's FIFO queue: { connId, project, since, minutes, keepOnFailure, pending: { token, settle } | null,
    // expires }. An entry is active while one of its requests is waiting (pending), and only an active one is given a VM.
    this.queue = []
    this.tokens = 0
    this.timers = new Set()
    this.ready = false
    this.linux = new LinuxDriver(this) // MC-1501: a Linux VM's guest ops (SSH to its dispatcher)
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

  /**
   * MC-1501: a guest op, by the VM's guest driver: a Windows VM's go to hv.ps1 (PowerShell Direct), a Linux VM's to its
   * dispatcher over SSH (guests/linux.js), under the same names and with the same answers.
   */
  guestCall(vm, op, args, opts) { return this.osOf(vm) === 'linux' ? this.linux.call(vm, op, args, opts) : this.hv(op, args, opts) }
  isLinux(vm) { return this.osOf(vm) === 'linux' }
  /** The guest's build and output folders, as the agent sees them. */
  paths(vm) { return this.isLinux(vm) ? LINUX_PATHS : { build: 'C:\\build', out: 'C:\\out' } }

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
    // A VM left in the build's online step (journalled online, never offline): off and disconnected first, verified;
    // the removal is tried even if that fails (a removed VM is on no network either).
    if (found?.vmId && intent.online && !intent.offline) {
      try {
        await this.hv('net-off', { vmId: found.vmId, name: intent.vmName, folder: intent.folder }, { timeoutMs: NET_OFF_MS })
        this.journal.append({ t: 'offline', intentId: intent.intentId })
      } catch (e) { this.log(`net-off of ${intent.vmName} failed (${e.message}): removing it anyway`) }
    }
    if (found?.vmId) await this.hv('remove-vm', { vmId: found.vmId, name: intent.vmName, folder: intent.folder })
    this.removeFolder(intent.folder)
    this.linux.dropKeys(intent.vmName) // MC-1501: a Linux VM's SSH keys (none for Windows)
    this.journal.append({ t: 'rolledBack', intentId: intent.intentId })
  }

  async removeVm(vm) {
    await this.hv('remove-vm', this.ident(vm))
    this.removeFolder(vm.folder)
    this.linux.dropKeys(vm.vmName) // MC-1501: a Linux VM's SSH keys (none for Windows)
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

  /**
   * A connection closed (its MCP server exited or was killed): its lease ends first (which kills its in-flight
   * operations, such as a copy-in reading the staged build), and only then is its staging removed. Staging cleanup can't
   * fail the disconnect: a folder still held open is recorded and retried.
   */
  async disconnect(connId) {
    const c = this.conns.get(connId)
    this.conns.delete(connId)
    this.leaveQueue(connId, 'its connection closed')
    if (!c) return
    try {
      const lease = c.vmId && this.leases.get(c.vmId)
      if (lease && lease.connId === connId) {
        lease.connId = null
        if (!lease.kept) await this.endLease(lease, 'its connection closed') // a kept one reverts at its deadline
      }
    } finally {
      this.dropStage(c)
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
  /** hv options that register the operation's PowerShell with the lease, so ending the lease can kill it. */
  // One registered after the lease began ending (missed by endLease's one-time kill) is killed at once.
  forLease(lease, timeoutMs = 120_000) {
    return {
      timeoutMs,
      onChild: ch => {
        if (lease.ending) { try { ch.kill() } catch { /* gone */ } return }
        lease.children.add(ch)
        ch.on('exit', () => lease.children.delete(ch))
      }
    }
  }

  stillHeld(lease) {
    if (this.leases.get(lease.vmId) !== lease || lease.ending) throw new Error(`This connection's lease on ${lease.vmName} ended while the request waited: call vm_acquire again.`)
  }

  vmOf(lease) {
    const vm = this.state.vms.get(lease.vmId)
    if (!vm || !vm.ready) throw new Error(`VM ${lease.vmName} is no longer in the pool.`)
    return vm
  }

  /**
   * The VMs that can be leased now: ready, not removing, not quarantined, not leased, and not an evaluation within
   * EVAL_LAST_MS of its recorded end (MC-1513: it would log users off and shut down hourly).
   */
  freeVms() {
    const s = this.state
    const now = this.now()
    return [...s.vms.values()].filter(v => v.ready && !v.removing && !s.quarantined.has(v.vmId) && !this.leases.has(v.vmId) && !this.pcpBusy.has(v.vmId) && !this.refreshing.has(v.vmId) && !this.refreshOf(v.vmId) && (evalEnd(v) ?? Infinity) - now >= EVAL_LAST_MS)
  }

  // ---------- projects, fair share and the queue (MC-1502) ----------

  /**
   * The caller's project, from the roots its server sends (real paths): the one project with a folder that one of them is
   * in (or is). None, several, or no roots (an older server) is "other". Advisory, like the roots themselves: it keeps
   * honest agents from starving each other, not a determined one.
   */
  projectOf(roots) {
    const list = Array.isArray(roots) ? roots.filter(r => typeof r === 'string' && /^[a-zA-Z]:[\\/]/.test(r) && r.length <= 1024).slice(0, 64) : []
    const norm = f => win32.normalize(f).replace(/\\+$/, '').toLowerCase()
    const hits = new Set()
    for (const r of list.map(norm)) {
      for (const p of this.policy.projects) if (p.folders.some(f => { const n = norm(f); return r === n || r.startsWith(n + '\\') })) hits.add(p.name)
    }
    return hits.size === 1 ? [...hits][0] : 'other'
  }

  /**
   * A VM's image: recorded by its create, or else recovered through its job's approved plan (the plan names the image
   * its VMs were built from, and its digest was approved), or else 'legacy': never guessed. A legacy VM is Windows (no
   * other kind existed before images were recorded); it serves a plain Windows acquire, never an exact image request.
   */
  imageOf(vm) {
    const s = this.state
    const i = s.intents.get(vm.intentId)
    if (i?.image) return i.image
    this.provenance ??= new Map()
    if (this.provenance.has(vm.vmId)) return this.provenance.get(vm.vmId)
    let sha = 'legacy'
    const planId = i?.jobId && s.jobs.get(i.jobId)?.planId
    if (planId && PLAN_ID_RE.test(planId)) {
      try {
        const plan = JSON.parse(fs.readFileSync(join(this.dir, 'plans', `${planId}.json`), 'utf8'))
        if (/^[0-9a-f]{64}$/.test(plan?.image?.sha256 || '') && (plan.add || []).some(a => a.intentId === vm.intentId)) sha = plan.image.sha256
      } catch { /* no plan file: legacy */ }
    }
    this.provenance.set(vm.vmId, sha)
    return sha
  }

  osOf(vm) { const sha = this.imageOf(vm); return sha === 'legacy' ? 'windows' : (this.state.images.get(sha)?.os || 'windows') }

  /** A verified image by its sha256 (or a unique prefix of 12 or more), or throws. */
  verifiedImage(want) {
    const w = String(want).toLowerCase()
    if (!/^[0-9a-f]{12,64}$/.test(w)) throw new Error('image must be a verified image\'s SHA-256 (at least its first 12 hex digits): pool_status lists them.')
    const hits = [...this.state.images.values()].filter(i => i.sha256.startsWith(w))
    if (hits.length !== 1) throw new Error(hits.length ? `image ${want} matches more than one verified image: give more of its SHA-256.` : `No verified image ${want}: pool_status lists them.`)
    return hits[0]
  }

  held(project, os) { return [...this.leases.values()].filter(l => l.project === project && (!os || l.os === os)).length }

  /** Why this project may never have this kind (not "not now": its cap for the OS is 0, or the image isn't on its list), or null. */
  notAllowed(project, want) {
    const p = this.policy.projects.find(x => x.name === project)
    if (!p) return null
    if (p.maxVms?.[want.os] === 0) return `project ${project} may not use ${want.os} VMs`
    if (want.image && p.images.length && !p.images.includes(want.image)) return `project ${project} may not use image ${want.image.slice(0, 12)}`
    if (want.distro && p.images.length && !p.images.some(sha => this.state.images.get(sha)?.distro === want.distro)) return `project ${project} may not use any ${want.distro} image`
    // MC-1523: a named VM made before images were recorded (legacy) can't be on an image allowlist.
    if (want.vm && want.vmImage === 'legacy' && p.images.length) return `project ${project} may not use ${want.vm}: its image is unknown (made before images were recorded), so it isn't on the project's image list`
    return null
  }

  /** MC-1523: why the named VM isn't free now (it isn't among the candidates), or null if it is. Never throws. */
  namedWhy(name) {
    const s = this.state
    const v = [...s.vms.values()].find(x => x.vmName === name)
    if (!v) return `${name} is no longer in the pool`
    if (s.quarantined.has(v.vmId)) return `${name} is quarantined (${s.quarantined.get(v.vmId)})`
    if (v.removing) return `${name} is being removed`
    if (v.debugKept) return `${name} is a failed build kept for debugging: it is never leased`
    if (!v.ready) return `${name} is being created`
    const l = this.leases.get(v.vmId)
    if (l) return `${name} is leased until ${new Date(l.deadline).toISOString()}`
    if ((evalEnd(v) ?? Infinity) - this.now() < EVAL_LAST_MS) return `${name} is in its Windows evaluation's last hour`
    return null
  }

  /**
   * The free VMs this project may take for this request: of its OS, of its image if asked, of its allowed images. Those
   * whose last start failed come last, the longest ago first, so a retry gets another VM when one fits (MC-1513).
   */
  candidates(project, want) {
    const p = this.policy.projects.find(x => x.name === project)
    const failedAt = v => this.startFailed.get(v.vmId)?.at ?? 0
    return this.freeVms().filter(v => {
      const img = this.imageOf(v)
      if (this.osOf(v) !== want.os) return false
      if (want.vm && v.vmName !== want.vm) return false
      if (want.checkpoint && !this.poolCheckpointOn(v.vmId, want.checkpoint)) return false
      if (want.image && img !== want.image) return false
      if (want.distro && this.state.images.get(img)?.distro !== want.distro) return false
      if (p?.images.length && !p.images.includes(img)) return false
      return true
    }).sort((a, b) => failedAt(a) - failedAt(b))
  }

  /**
   * MC-1532: what a lease's start or reset restores: null (clean) for 'clean'; with no name, the lease's own start
   * point; a name, this VM's published checkpoint of it, or one this lease already pinned (even retiring). Never another
   * VM's, and never clean in place of a missing one.
   */
  startTarget(lease, checkpoint) {
    if (checkpoint !== undefined && checkpoint.toLowerCase() === 'clean') return null
    if (checkpoint === undefined) return lease.startFrom ? { ...lease.startFrom } : null
    const p = this.poolCheckpointOn(lease.vmId, checkpoint)
    if (p) return { name: p.name, checkpointId: p.checkpointId }
    const pinned = [...lease.refs].map(id => this.state.poolSnaps.get(id)).find(x => x && x.name.toLowerCase() === checkpoint.toLowerCase())
    if (pinned) return { name: pinned.name, checkpointId: pinned.checkpointId }
    throw new Error(`${lease.vmName} has no pool checkpoint "${checkpoint}" (nothing was restored; vm_start({ checkpoint: 'clean' }) for clean).`)
  }

  /** MC-1532: the published, not retiring, pool checkpoints of this name (case-insensitive), on any VM. */
  poolCheckpointsNamed(name) {
    const n = String(name).toLowerCase()
    return [...this.state.poolSnaps.values()].filter(x => !x.retiring && x.name.toLowerCase() === n && this.state.vms.get(x.vmId)?.ready)
  }

  /** MC-1532: this VM's published, not retiring, pool checkpoint of this name, or null. */
  poolCheckpointOn(vmId, name) {
    const n = String(name).toLowerCase()
    return [...this.state.poolSnaps.values()].find(x => x.vmId === vmId && !x.retiring && x.name.toLowerCase() === n) || null
  }

  /** A VM's failed last start, for the lease text and vm_status, or ''. */
  failedNote(vm) {
    const f = this.startFailed.get(vm.vmId)
    return f ? `its last start failed at ${new Date(f.at).toISOString()} (${f.why})` : ''
  }

  /**
   * Why a free VM can't go to this project for this request now, or null: its allowlist and its cap for the OS, then a
   * VM of that kind, then every other project's unmet reservation for that OS, which the usable free VMs of the OS must
   * still cover after this one goes (the image only narrows which VM is taken).
   */
  blocked(project, want = { os: 'windows' }) {
    const no = this.notAllowed(project, want)
    if (no) return no
    const p = this.policy.projects.find(x => x.name === project)
    const cap = p?.maxVms?.[want.os]
    if (cap !== undefined && this.held(project, want.os) >= cap) return `project ${project} holds its ${want.os} cap of ${cap}`
    if (this.candidates(project, want).length) return null
    if (want.vm) return this.namedWhy(want.vm) || `${want.vm} is not free`
    if (want.checkpoint) return this.poolCheckpointsNamed(want.checkpoint).length ? `no VM with the pool checkpoint "${want.checkpoint}" is free` : `no VM has the pool checkpoint "${want.checkpoint}" now (it was removed)`
    return want.image ? `none of image ${want.image.slice(0, 12)} is free` : this.freeVms().some(v => this.osOf(v) === want.os) || want.os === 'windows' ? 'none is free' : `the pool has no free ${want.os} VM`
  }

  /** Makes the lease (under the pool lock): the first free VM, for this connection and project. */
  grant(connId, project, minutes, keepOnFailure, want = { os: 'windows' }) {
    const c = this.conns.get(connId)
    if (!c) throw new Error('unknown connection')
    const vm = this.candidates(project, want)[0]
    const now = this.now()
    // An evaluation VM's lease never runs past its recorded end: the work session is capped there too.
    const licenceEnd = evalEnd(vm)
    const sessionEnd = Math.min(now + policyMod.sessionMinutes(this.policy) * MINUTE_MS, licenceEnd ?? Infinity)
    const lease = {
      leaseId: `l-${hex(6)}`, vmId: vm.vmId, vmName: vm.vmName, connId, ownerConn: connId, pid: c.pid, ending: null, children: new Set(),
      acquiredAt: now, sessionEnd, deadline: Math.min(sessionEnd, now + Math.round(minutes * MINUTE_MS)), keepOnFailure: !!keepOnFailure,
      kept: false, running: false, failed: false, runs: 0, dirty: false, network: 'none', net: null, reserve: 0,
      // project: pinned here, so a later change of the caller's roots never moves the lease or its count; os and image:
      // the VM's, for the per-OS shares.
      project, os: this.osOf(vm), image: this.imageOf(vm),
      // interactive: the account logged on in the guest by this start ('user' or 'admin'), or null.
      interactive: null,
      // MC-1532: the pool checkpoint this lease starts from by default ({ name, checkpointId }, exact; null = clean), and
      // every pool checkpoint id it has started or reset from (pinned: a retiring one stays usable by this lease).
      startFrom: null, refs: new Set(),
      // What the helper knows of the guest's C:\build (vm_sync): the files it placed, by canonical key; gen moves on at
      // every start, sync and the lease's end (a plan from an earlier gen is stale); trusted is false while an apply
      // is unfinished or after one failed, when only a full sync or a reset may follow.
      sync: { record: new Map(), gen: 0, trusted: false, plan: null }
    }
    // MC-1532: a lease acquired by a pool checkpoint starts from that exact checkpoint by default (pinned).
    if (want.checkpoint) { const p = this.poolCheckpointOn(vm.vmId, want.checkpoint); lease.startFrom = { name: p.name, checkpointId: p.checkpointId }; lease.refs.add(p.checkpointId) }
    this.leases.set(vm.vmId, lease)
    c.vmId = vm.vmId
    this.armDeadline(lease)
    const share = `${project === 'other' ? '' : ` for project ${project}`}${this.osOf(vm) === 'windows' && !want.image ? '' : ` (${this.osOf(vm)}, image ${this.imageOf(vm).slice(0, 12)})`}`
    const failed = this.failedNote(vm)
    const cap = licenceEnd !== null && sessionEnd === licenceEnd ? `its Windows evaluation's end` : `the policy's work-session cap`
    const from = lease.startFrom ? ` It starts from the pool checkpoint "${lease.startFrom.name}" (vm_start({ checkpoint: 'clean' }) for clean).` : ''
    return { text: `Leased ${vm.vmName} (lease ${lease.leaseId})${share} until ${new Date(lease.deadline).toISOString()}; vm_renew can extend it up to ${new Date(sessionEnd).toISOString()} (${cap}). Call vm_start next; always vm_release when done.${from}${failed ? ` Note: ${failed}; every free VM that fitted had a failed start, and this one's was the longest ago.` : ''}`, data: { lease: lease.leaseId, vm: vm.vmName, deadline: lease.deadline, sessionEnd, project, os: lease.os, image: lease.image } }
  }

  /** Settles an entry's waiting request once: with a result, or an error. Its token makes a late timer a no-op. */
  settle(e, outcome) {
    const w = e.pending
    if (!w) return
    e.pending = null
    clearTimeout(w.timer)
    this.timers.delete(w.timer)
    w.settle(outcome)
  }

  /** Inactive entries past their keep time leave the queue. */
  dropExpired() {
    const now = this.now()
    this.queue = this.queue.filter(e => e.pending || !(e.expires <= now))
  }

  /**
   * Under the pool lock: gives free VMs to active entries, first come first served. An entry its project's cap or
   * another's reservation blocks keeps its place, and later ones are served past it. Never waits on anything.
   */
  drain() {
    if (this.quiesced) { for (const e of this.queue.splice(0)) this.settle(e, { error: new Error('The helper is being uninstalled: no new leases.') }); return }
    this.dropExpired()
    for (const e of [...this.queue]) {
      if (!this.freeVms().length) break
      if (!e.pending || this.blocked(e.project, e.want)) continue
      this.queue = this.queue.filter(x => x !== e)
      let outcome
      try { outcome = { result: this.grant(e.connId, e.project, e.minutes, e.keepOnFailure, e.want) } } catch (err) { outcome = { error: err } }
      this.settle(e, outcome)
    }
  }

  /** A drain once the change that freed a VM (a lease ended, a quarantine cleared, a pool job ended) has committed. */
  kick() { void this.poolLock(async () => this.drain()).catch(() => {}) }

  leaveQueue(connId, why) {
    const e = this.queue.find(x => x.connId === connId)
    if (!e) return
    this.queue = this.queue.filter(x => x !== e)
    this.settle(e, { error: new Error(`The wait for a VM ended: ${why}.`) })
  }

  position(connId) {
    const i = this.queue.findIndex(x => x.connId === connId)
    return i < 0 ? this.queue.length + 1 : i + 1
  }

  /**
   * vm_acquire. Without wait: the queue's active waiters are served first, then this call gets a VM only if one is free
   * for its project now (its cap, and the other projects' reservations); otherwise it's refused, saying why and where it
   * would stand. With wait: it takes (or resumes) the connection's place in line and waits at most WAIT_MS; a VM freed
   * meanwhile goes to the first active entry it is allowed to; a wait that ends without one keeps the place KEEP_MS for
   * the next call. A newer call from the same connection supersedes a waiting one. The pool lock is held only for these
   * decisions, never while waiting.
   */
  async acquire(connId, { minutes = 60, keepOnFailure = false, wait = false, roots, os: osAsked, image, vm: named, checkpoint, distro } = {}) {
    // MC-1523: an omitted os stays omitted until a named VM is resolved (its own OS then); unnamed, it means windows.
    if (osAsked !== undefined && !OSES.includes(osAsked)) throw new Error(`os must be ${OSES.join(' or ')}`)
    if (named !== undefined && (typeof named !== 'string' || !named || named.length > 64)) throw new Error('vm must be a VM name from vm_status.')
    if (checkpoint !== undefined && (typeof checkpoint !== 'string' || !POOL_CHECKPOINT_RE.test(checkpoint))) throw new Error("checkpoint must be a pool checkpoint's name (vm_status lists them).")
    // MC-1501: distro ('debian' | 'ubuntu') narrows a Linux request to that distro's images, and implies os 'linux'.
    if (distro !== undefined && !linuxImages.DISTROS.includes(distro)) throw new Error(`distro must be ${linuxImages.DISTROS.join(' or ')}`)
    if (distro !== undefined && osAsked !== undefined && osAsked !== 'linux') throw new Error(`distro is for Linux VMs: ${distro} isn't a ${osAsked} distro.`)
    const os = osAsked ?? (distro !== undefined ? 'linux' : 'windows')
    const step = await this.poolLock(async () => {
      if (this.quiesced) throw new Error('The helper is being uninstalled: no new leases.')
      const c = this.conns.get(connId)
      if (!c) throw new Error('unknown connection')
      if (c.vmId && this.leases.get(c.vmId)?.connId === connId) throw new Error(`This connection already has ${this.leases.get(c.vmId).vmName}: one VM per connection.`)
      const max = this.policy.maxLeaseMinutes
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > max) throw new Error(`minutes must be 1-${max} (the policy's maxLeaseMinutes).`)
      const s = this.state
      // A named VM that exists is served (or refused with its state, or waited for) even while none is ready (MC-1523).
      if (named === undefined && ![...s.vms.values()].some(v => v.ready)) throw new Error('The pool has no VMs yet: ask the user to create one (pool_plan, then their approval, then pool_create).')
      let want
      if (named !== undefined) {
        // MC-1523: one VM by name, for trials and censuses. The request becomes that VM's own OS and image; an os or
        // image given as well must agree with it. It is then served like any other: the same caps, allowlists and line.
        const target = [...s.vms.values()].find(v => v.vmName === named)
        if (!target) throw new Error(`No VM named ${named} in the pool (vm_status lists them).`)
        const tOs = this.osOf(target)
        const tImg = this.imageOf(target)
        if (osAsked !== undefined && osAsked !== tOs) throw new Error(`${named} is a ${tOs} VM, not ${osAsked}.`)
        if (image !== undefined && this.verifiedImage(image).sha256 !== tImg) throw new Error(`${named} wasn't built from image ${String(image).slice(0, 12)}${tImg === 'legacy' ? ' (its image is unknown: made before images were recorded)' : ` (its image is ${tImg.slice(0, 12)})`}.`)
        if (distro !== undefined && s.images.get(tImg)?.distro !== distro) throw new Error(`${named} isn't a ${distro} VM.`)
        want = { os: tOs, ...(tImg !== 'legacy' ? { image: tImg } : {}), vm: named, vmImage: tImg }
      } else {
        want = { os, ...(image !== undefined ? { image: this.verifiedImage(image).sha256 } : {}), ...(distro !== undefined ? { distro } : {}) }
        if (want.image && distro !== undefined && s.images.get(want.image)?.distro !== distro) throw new Error(`image ${want.image.slice(0, 12)} isn't a ${distro} image.`)
        // MC-1532: with a checkpoint and no os, the OS comes from the checkpoint's VMs (filtered by this image below).
        if (want.image && !(checkpoint !== undefined && osAsked === undefined) && (this.state.images.get(want.image)?.os || 'windows') !== os) throw new Error(`image ${want.image.slice(0, 12)} is a ${this.state.images.get(want.image)?.os || 'windows'} image, not ${os}.`)
      }
      if (checkpoint !== undefined) {
        // MC-1532: only VMs with this published (not retiring) pool checkpoint. A vm narrows first; then os and image.
        let have = this.poolCheckpointsNamed(checkpoint)
        if (named !== undefined) have = have.filter(x => s.vms.get(x.vmId)?.vmName === named)
        if (!have.length) throw new Error(named !== undefined ? `${named} has no pool checkpoint "${checkpoint}" (vm_status lists each VM's).` : `No VM has a pool checkpoint "${checkpoint}" (vm_status lists them).`)
        if (osAsked !== undefined) { have = have.filter(x => this.osOf(s.vms.get(x.vmId)) === osAsked); if (!have.length) throw new Error(`No ${osAsked} VM has a pool checkpoint "${checkpoint}".`) }
        if (want.image) { have = have.filter(x => this.imageOf(s.vms.get(x.vmId)) === want.image); if (!have.length) throw new Error(`No VM of image ${want.image.slice(0, 12)} has a pool checkpoint "${checkpoint}".`) }
        if (want.distro) { have = have.filter(x => s.images.get(this.imageOf(s.vms.get(x.vmId)))?.distro === want.distro); if (!have.length) throw new Error(`No ${want.distro} VM has a pool checkpoint "${checkpoint}".`) }
        const oses = [...new Set(have.map(x => this.osOf(s.vms.get(x.vmId))))]
        if (oses.length > 1) throw new Error(`The pool checkpoint "${checkpoint}" is on ${oses.join(' and ')} VMs: give os to choose.`)
        want = { ...want, os: oses[0], checkpoint: have[0].name }
      }
      this.dropExpired()
      let e = this.queue.find(x => x.connId === connId)
      if (e) this.settle(e, { error: new Error('Superseded by a newer vm_acquire from this connection.') })
      // A kind this project may never have is refused at once, never queued.
      const no = this.notAllowed(e ? e.project : this.projectOf(roots), want)
      if (no) { if (e) this.queue = this.queue.filter(x => x !== e); throw new Error(`No VM for you: ${no}.`) }
      if (!wait) {
        this.drain()
        const project = e ? e.project : this.projectOf(roots)
        const why = this.blocked(project, want)
        if (!why) {
          if (e) this.queue = this.queue.filter(x => x !== e)
          return { result: this.grant(connId, project, minutes, keepOnFailure, want) }
        }
        const next = [...this.leases.values()].sort((a, b) => a.deadline - b.deadline)[0]
        const pool = `${s.vms.size} in the pool${s.quarantined.size ? `, ${s.quarantined.size} quarantined` : ''}${this.queue.length ? `, ${this.queue.length} waiting` : ''}`
        throw new Error(`${why === 'none is free' ? `No VM is free (${pool}).` : `No VM for you now: ${why} (${pool}).`}${next ? ` The next lease ends by ${new Date(next.deadline).toISOString()}.` : ''} Try again later, or vm_acquire with wait: true to wait in line (you'd be number ${this.position(connId)}).`)
      }
      if (!e) {
        e = { connId, project: this.projectOf(roots), since: this.now(), expires: null, pending: null }
        this.queue.push(e)
      }
      Object.assign(e, { minutes, keepOnFailure, want, expires: null })
      const token = ++this.tokens
      const done = new Promise(resolve => {
        const timer = setTimeout(() => {
          this.timers.delete(timer)
          if (e.pending?.token !== token) return
          e.pending = null
          e.expires = this.now() + KEEP_MS
          resolve({ waiting: true })
        }, WAIT_MS)
        timer.unref?.()
        this.timers.add(timer)
        e.pending = { token, timer, settle: resolve }
      })
      this.drain()
      return { done, e }
    })
    if (step.result) return step.result
    const out = await step.done
    if (out.error) throw out.error
    if (out.result) return out.result
    // Waited WAIT_MS without a VM: the place is kept for the next call.
    return await this.poolLock(async () => {
      const why = this.blocked(step.e.project, step.e.want) || 'none is free'
      const i = this.queue.indexOf(step.e)
      return {
        text: `Still waiting for a VM (${why}): number ${i + 1} of ${this.queue.length} in line. Call vm_acquire with wait: true again within ${Math.round(KEEP_MS / 1000)} s to keep your place.`,
        data: { waiting: true, position: i + 1, of: this.queue.length, project: step.e.project }
      }
    })
  }

  /** The caller's project and the build folders it may use: its own (policy) and the global ones. */
  whoami(roots) {
    const project = this.projectOf(roots)
    const own = this.policy.projects.find(p => p.name === project)?.buildRoots || []
    return { text: project, data: { project, buildRoots: [...own, ...this.policy.buildRoots], projectBuildRoots: [...own] } }
  }

  /**
   * vm_renew: the lease's deadline becomes now + minutes (1 to maxLeaseMinutes), never past its session's end (acquire +
   * the policy's maxSessionMinutes). Refused once the deadline has passed, even before its timer has fired, so an
   * expired lease can't be brought back; and while the lease is ending.
   */
  renew(connId, { minutes = 60 } = {}) {
    const lease = this.leaseOf(connId)
    const now = this.now()
    if (now >= lease.deadline) throw new Error(`This connection's lease on ${lease.vmName} has passed its deadline and is ending: it can't be renewed. vm_acquire again.`)
    const max = this.policy.maxLeaseMinutes
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > max) throw new Error(`minutes must be 1-${max} (the policy's maxLeaseMinutes).`)
    const want = now + Math.round(minutes * MINUTE_MS)
    if (want > lease.sessionEnd) {
      const vm = this.state.vms.get(lease.vmId)
      const why = vm && evalEnd(vm) === lease.sessionEnd ? `${lease.vmName}'s Windows evaluation ends then` : `the policy's maxSessionMinutes, ${policyMod.sessionMinutes(this.policy)} min from vm_acquire`
      throw new Error(`That is past this work session's end, ${new Date(lease.sessionEnd).toISOString()} (${why}): at most ${Math.floor((lease.sessionEnd - now) / MINUTE_MS)} minutes now. Nothing was changed.`)
    }
    lease.deadline = want
    this.armDeadline(lease)
    return { text: `Renewed: ${lease.vmName} is yours until ${new Date(want).toISOString()} (the session ends by ${new Date(lease.sessionEnd).toISOString()}).`, data: { deadline: want, sessionEnd: lease.sessionEnd } }
  }

  armDeadline(lease) {
    if (lease.timer) { clearTimeout(lease.timer); this.timers.delete(lease.timer) }
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
    this.timers.delete(lease.timer)
    lease.sync.gen++
    lease.sync.trusted = false
    lease.sync.plan = null
    // Its in-flight operations (a long vm_run, a copy) are killed now: the lease is over, and its VM's restore must not
    // wait for them. The guest side dies with the restore.
    for (const ch of lease.children) { try { ch.kill() } catch { /* gone */ } }
    lease.ending = (async () => {
      const vm = this.state.vms.get(lease.vmId)
      let r = { ok: true, text: `${lease.vmName} restored to clean.` }
      if (vm) r = await this.vmLock(vm.vmId)(() => this.restore(vm))
      if (this.leases.get(lease.vmId) === lease) this.leases.delete(lease.vmId)
      const owner = this.conns.get(lease.ownerConn)
      if (owner && owner.vmId === lease.vmId) owner.vmId = null
      this.log(`lease ${lease.leaseId} on ${lease.vmName} ended (${why}): ${r.text}`)
      this.kick()
      return r
    })()
    return lease.ending
  }

  /**
   * MC-1537: every restore, by one path. The op (restore or lease-restore) turns the VM off and issues the restore; an
   * explicit failed or timed-out report from it is returned as it is (refused by restoreProblem: fresh facts can't turn
   * an unissued restore into success). Otherwise the new parent is read from fresh facts-vm calls, each its own
   * PowerShell process (the restoring process's Hyper-V objects keep the parent it started with), polled until it is
   * the target, within verifyMs on the monotonic clock: probe time included, each probe's timeout and each sleep capped
   * to the time left, and no result accepted after the deadline. Returns the last fresh facts with a restore report
   * { ok, phase: 'verified' | 'parent', timedOut, last, waitedMs }, for the callers' existing checks. With a lease,
   * every call is the lease's (ending it kills them) and it is checked still held after each await.
   */
  async restoreVia(vm, op, args, { lease = null, verifyMs = RESTORE_VERIFY_MS } = {}) {
    const opts = ms => lease ? this.forLease(lease, ms) : { timeoutMs: ms }
    const held = () => { if (lease) this.stillHeld(lease) }
    const r = await this.hv(op, args, opts(120_000))
    held()
    const rep0 = r?.restore
    if (rep0 && typeof rep0 === 'object' && (rep0.timedOut === true || rep0.ok === false)) return r
    const t0 = this.mono()
    const spent = () => this.mono() - t0
    let last = null
    let lastErr = null
    for (;;) {
      const left = verifyMs - spent()
      if (left <= 0) break
      let f = null
      try {
        f = await this.hv('facts-vm', this.ident(vm), opts(Math.max(1, Math.ceil(left))))
      } catch (e) {
        held()
        lastErr = e.message
      }
      held()
      if (f) {
        if (spent() > verifyMs) { lastErr = 'the last read came after the wait ended'; break }
        last = f
        lastErr = null
        if (f.parentCheckpointId === args.checkpointId) return { ...f, restore: { ok: true, phase: 'verified', timedOut: false, last: f.parentCheckpointId, waitedMs: Math.round(spent()) } }
      }
      const rest = verifyMs - spent()
      if (rest <= 0) break
      await this.sleep(Math.min(1000, rest))
      held()
    }
    const seen = last ? (last.parentCheckpointId || 'no parent') : 'nothing'
    return { ...(last || {}), restore: { ok: false, phase: 'parent', timedOut: true, last: lastErr ? `${seen}; the last read failed: ${lastErr}` : seen, waitedMs: Math.round(spent()) } }
  }

  /**
   * Turns the VM off, restores the clean checkpoint by id, and verifies the baseline. Quarantines it on failure.
   * Returns { ok, text }. With a lease (a start or stop on its behalf), the restore is the lease's: if the lease ends
   * meanwhile, it stops there and leaves the VM to the lease's own cleanup, without quarantining it.
   */
  async restore(vm, target = null, lease = null) {
    let facts = null
    let why = null
    // MC-1532: a lease's start may restore one of the VM's pool checkpoints instead of clean (by its exact id); the
    // baseline is then checked against that id. Everything else (release, recovery, retries) restores clean.
    // MC-1531: an unresolved refresh (a crash or a failed cleanup) is settled first: abandoned before its commit,
    // its old clean retired after. Not while a refresh is working on the VM.
    if (!this.refreshing.has(vm.vmId) && this.refreshOf(vm.vmId)) {
      const rec = this.refreshOf(vm.vmId)
      const left = rec.selected ? await this.rclRetire(vm) : await this.rclAbandon(vm)
      if (left) { this.quarantineWhy(vm, left); return { ok: false, text: `CLEANUP FAILED: ${vm.vmName} could not be confirmed clean (${left}). It is quarantined (never leased) until a restore confirms it; the helper retries every few minutes.` } }
      vm = this.state.vms.get(vm.vmId) || vm // the current record (its clean id may have changed)
    }
    const to = target ? target.checkpointId : vm.cleanCheckpointId
    try {
      facts = await this.restoreVia(vm, 'restore', { ...this.ident(vm), checkpointId: to, label: target ? `"${target.name}"` : 'clean' }, { lease })
      why = baselineProblem(facts, { ...vm, cleanCheckpointId: to })
    } catch (e) {
      if (lease && (lease.ending || this.leases.get(lease.vmId) !== lease)) return { ok: false, text: `This connection's lease on ${vm.vmName} ended while the request waited: call vm_acquire again.` }
      why = e.message
    }
    const s = this.state
    // MC-1529: then the lease checkpoints no live lease owns (an ended lease's, or any a crash left) are removed; until
    // they're confirmed gone the VM stays quarantined, even though clean itself verified.
    if (!why) why = await this.dropLeaseSnapshots(vm)
    if (why) {
      if (s.quarantined.get(vm.vmId) !== why) this.journal.append({ t: 'quarantine', vmId: vm.vmId, why })
      return { ok: false, text: `CLEANUP FAILED: ${vm.vmName} could not be confirmed clean (${why}). It is quarantined (never leased) until a restore confirms it; the helper retries every few minutes.` }
    }
    if (s.quarantined.has(vm.vmId)) this.journal.append({ t: 'unquarantine', vmId: vm.vmId })
    return { ok: true, text: target ? `${vm.vmName} restored to its pool checkpoint "${target.name}".` : `${vm.vmName} restored to clean (Off, at its clean checkpoint, network disconnected, no CPU reserve).` }
  }

  /**
   * MC-1529: removes this VM's journalled lease checkpoints that no live lease owns, deepest first (a child before its
   * parent), each by its exact id and owned name, confirmed gone before it's journalled dropped. A take that never got
   * its id journalled is found by its unique name. Any other snapshot that isn't clean is left alone and noted.
   * Returns null, or why cleanup is still pending.
   */
  async dropLeaseSnapshots(vm) {
    const live = this.leases.get(vm.vmId)
    const keep = live && !live.ending ? live.leaseId : null
    const all = [...this.state.leaseSnaps.values()].filter(x => x.vmId === vm.vmId)
    const mine = all.filter(x => x.leaseId !== keep)
    // MC-1532: the VM's pool checkpoints are owned too. Published ones are never removed here; retiring ones are,
    // once no live lease holds the VM (a lease that pinned one keeps using it until it ends).
    const pool = [...this.state.poolSnaps.values()].filter(x => x.vmId === vm.vmId)
    const retiring = live && !live.ending ? [] : pool.filter(x => x.retiring)
    // A start within a live lease with nothing to drop doesn't look (one Hyper-V call fewer on every start).
    if (!mine.length && !retiring.length && keep) return null
    let list
    try { list = (await this.hv('snapshots', this.ident(vm))).snapshots || [] } catch (e) { return mine.length || retiring.length ? `lease checkpoint cleanup pending: ${e.message}` : null }
    // Ownership by identity: a confirmed take by its id, an unconfirmed one by its unique name. Anything else that
    // isn't clean (a same-named snapshot with another id included) is unknown: reported, never deleted.
    // MC-1531: an unresolved refresh's provisional snapshot (by id, or its unique name) and old clean are owned too:
    // never unknown, and never removed here (only its abandon or retire step touches them).
    const rf = this.refreshOf(vm.vmId)
    const ownedIds = new Set([...all.filter(x => x.checkpointId).map(x => x.checkpointId), ...pool.map(x => x.checkpointId), ...(rf ? [rf.oldClean, rf.newId].filter(Boolean) : [])])
    const pendingNames = new Set([...all.filter(x => !x.checkpointId).map(x => x.snapName), ...(rf && !rf.newId ? [rf.snapName] : [])])
    const unknown = list.filter(x => x.id !== vm.cleanCheckpointId && !ownedIds.has(x.id) && !pendingNames.has(x.name)).map(x => `${x.name} (${x.id})`)
    if (unknown.length) this.unknownSnapshots.set(vm.vmId, unknown); else this.unknownSnapshots.delete(vm.vmId)
    if (!mine.length && !retiring.length) return null
    const byId = new Map(list.map(x => [x.id, x]))
    const depth = x => { let d = 0; for (let p = x.parentId; p && byId.has(p) && d < 64; p = byId.get(p).parentId) d++; return d }
    const targets = []
    for (const x of mine) {
      if (x.checkpointId) {
        const y = byId.get(x.checkpointId)
        // The known id under another name: not removed (it may not be ours any more), not forgotten either.
        if (y && y.name !== x.snapName) return `lease checkpoint cleanup pending: ${x.name}'s id ${x.checkpointId} now has the name "${y.name}"`
        targets.push({ x, snap: y || null })
      } else {
        // An unconfirmed take (its call died or timed out): by its unique name. Absent, it's settled as never made only
        // when Hyper-V positively shows no job still starting or running on the host: absence alone proves nothing.
        // Two with the name is a mismatch, left alone.
        let ys = list.filter(y => y.name === x.snapName)
        if (ys.length > 1) return `lease checkpoint cleanup pending: ${ys.length} snapshots are named ${x.snapName}`
        if (!ys.length) {
          let idle = null
          try { idle = (await this.hv('jobs-idle', this.ident(vm))).idle === true } catch { idle = null }
          if (idle !== true) return `lease checkpoint cleanup pending: the take of ${x.name} may still be in progress (Hyper-V ${idle === false ? 'has a job that hasn\'t ended' : 'job state unreadable'})`
          // Idle now, so the take has ended either way: a fresh look decides (it may have finished since the first one).
          let fresh
          try { fresh = (await this.hv('snapshots', this.ident(vm))).snapshots || [] } catch (e) { return `lease checkpoint cleanup pending: ${e.message}` }
          ys = fresh.filter(y => y.name === x.snapName)
          if (ys.length > 1) return `lease checkpoint cleanup pending: ${ys.length} snapshots are named ${x.snapName}`
          for (const y of fresh) if (!byId.has(y.id)) byId.set(y.id, y)
        }
        targets.push({ x, snap: ys[0] || null })
      }
    }
    // Retiring pool checkpoints (MC-1532): by their exact id and name; the known id under another name is left alone.
    for (const p of retiring) {
      const y = byId.get(p.checkpointId)
      if (y && y.name !== p.snapName) return `pool checkpoint cleanup pending: "${p.name}"'s id ${p.checkpointId} now has the name "${y.name}"`
      targets.push({ x: { ...p, pool: true }, snap: y || null })
    }
    targets.sort((a, b) => (b.snap ? depth(b.snap) : -1) - (a.snap ? depth(a.snap) : -1))
    for (const { x, snap } of targets) {
      if (x.pool) {
        // A retiring pool checkpoint: removed, or already gone (its id was confirmed, so absence is definitive).
        if (snap) {
          let gone = false
          try { gone = (await this.hv('snapshot-remove', { ...this.ident(vm), checkpointId: snap.id, snapName: x.snapName })).removed === true } catch (e) { return `pool checkpoint cleanup pending: removing "${x.name}" failed (${e.message})` }
          if (!gone) return `pool checkpoint cleanup pending: "${x.name}" is still there`
        }
        this.journal.append({ t: 'pcp-retired', checkpointId: x.checkpointId })
        continue
      }
      if (snap) {
        if (!x.dropping) this.journal.append({ t: 'lcp-drop', opId: x.opId })
        let gone = false
        try { gone = (await this.hv('snapshot-remove', { ...this.ident(vm), checkpointId: snap.id, snapName: x.snapName })).removed === true } catch (e) { return `lease checkpoint cleanup pending: removing ${x.name} failed (${e.message})` }
        if (!gone) return `lease checkpoint cleanup pending: ${x.name} is still there`
      }
      // The VM's checkpoint type, as it was before this take (an interrupted take may have left ProductionOnly).
      if (x.origType) {
        let type = null
        try { type = (await this.hv('checkpoint-type', this.ident(vm))).type; if (type !== x.origType) type = (await this.hv('checkpoint-type', { ...this.ident(vm), set: x.origType })).type } catch (e) { return `lease checkpoint cleanup pending: putting back the checkpoint type failed (${e.message})` }
        if (type !== x.origType) return `lease checkpoint cleanup pending: the checkpoint type is ${type}, not ${x.origType}`
      }
      this.journal.append({ t: 'lcp-dropped', opId: x.opId })
    }
    return null
  }

  /** Retries quarantined VMs that nobody holds. */
  async retryQuarantined() {
    for (const dir of [...this.pendingCleanup]) this.removeStaging(dir)
    // A build whose rollback failed while it may still be online: retried here, not only at the next start.
    await this.poolLock(async () => {
      if (this.job) return
      for (const i of this.state.intents.values()) {
        if (!i.done && i.online && !i.offline) await this.rollBack(i).catch(e => this.log(`rollback of ${i.vmName} (it may still be online) failed: ${e.message}; retried later`))
      }
    }).catch(() => {})
    for (const vmId of this.state.quarantined.keys()) {
      const vm = this.state.vms.get(vmId)
      if (vm && vm.ready && !vm.removing && !this.leases.has(vmId)) await this.vmLock(vmId)(() => this.restore(vm)).catch(() => {})
    }
    this.kick()
  }

  // ---------- refreshing a VM's clean checkpoint (MC-1531) ----------

  /** MC-1531: this VM's unresolved refresh record (one at most), or null. */
  refreshOf(vmId) {
    return [...this.state.refreshes.values()].find(x => x.vmId === vmId) || null
  }

  /**
   * MC-1531: a refresh plan: each target ready, with no unresolved refresh and not in its evaluation's last hour (the
   * host record), on a drive above the floor. Bound to its current clean checkpoint id and image.
   */
  async planRefresh(args) {
    const list = Array.isArray(args.targets) ? args.targets : Array.isArray(args.vms) ? args.vms : []
    const names = [...new Set(list)]
    if (!names.length || names.length > 16 || names.some(n => typeof n !== 'string')) throw new Error('targets must list 1-16 VM names (vm_status lists them).')
    const s = this.state
    const floor = this.policy.minFreeGBForCheckpoint ?? 20
    const facts = await this.hv('facts', { folders: this.policy.diskFolders })
    const entries = []
    for (const n of names) {
      const vm = [...s.vms.values()].find(v => v.vmName === n)
      if (!vm || !vm.ready || vm.removing) throw new Error(`No ready VM named ${n} in the pool.`)
      if (this.refreshOf(vm.vmId)) throw new Error(`${n} has an unfinished refresh (its old clean checkpoint not yet removed): wait for it (vm_status), then plan again.`)
      if ((evalEnd(vm) ?? Infinity) - this.now() < EVAL_LAST_MS) throw new Error(`${n} is in its Windows evaluation's last hour.`)
      const folder = (facts.folders || []).find(x => vm.folder.toLowerCase().startsWith(x.folder.toLowerCase()))
      if (!folder || !Number.isFinite(folder.freeGB) || folder.freeGB < floor) throw new Error(`${n}'s drive has ${folder?.freeGB ?? 'unknown'} GB free, under the ${floor} GB a checkpoint must leave.`)
      entries.push({ vmId: vm.vmId, name: vm.vmName, cleanCheckpointId: vm.cleanCheckpointId, image: this.imageOf(vm) })
    }
    const plan = { id: `p-${hex(8)}`, op: 'refresh', epoch: this.journal.epoch, created: this.now(), expires: this.now() + PLAN_TTL_MS, prefix: this.policy.prefix, refresh: entries }
    const bytes = Buffer.from(canonical(plan), 'utf8')
    fs.writeFileSync(join(this.dir, 'plans', `${plan.id}.json`), bytes, { flag: 'wx' })
    const digest = sha256(bytes)
    return { text: describePlan(plan, digest, this.approveLine(plan.id)), data: { planId: plan.id, digest } }
  }

  /**
   * MC-1531: refreshes one VM's clean checkpoint, inside the pool job. Bound and held synchronously (no await between the
   * free check, the hold and rcl-begin), then under its VM lock: the old clean restored and started offline, the
   * build's guest steps rerun, its licence read (record only), shut down, a new snapshot of the Off VM taken and
   * verified, then rcl-select (the commit), then the old clean retired. Before the commit any failure abandons (old
   * clean restored, the provisional snapshot reconciled); after it, never a rollback. Returns the job note's line.
   */
  async refreshOne(job, e, label) {
    const s = this.state
    const vm = s.vms.get(e.vmId)
    const step = t => { job.progress = `${label}: ${t}` }
    if (!vm || !vm.ready || vm.removing || vm.vmName !== e.name || vm.cleanCheckpointId !== e.cleanCheckpointId) return `${e.name}: skipped (it changed since the plan: make a new one)`
    if (this.leases.has(vm.vmId) || s.quarantined.has(vm.vmId) || this.pcpBusy.has(vm.vmId) || this.refreshing.has(vm.vmId) || this.refreshOf(vm.vmId)) return `${e.name}: skipped (leased, quarantined or busy: plan again when it's free)`
    if ((evalEnd(vm) ?? Infinity) - this.now() < EVAL_LAST_MS) return `${e.name}: skipped (its Windows evaluation's last hour)`
    // The hold and the durable intent, with no await since the checks.
    this.refreshing.add(vm.vmId)
    const opId = hex(6)
    const snapName = `hvmcp-clean-${opId}`
    let oldName = null
    try {
      return await this.vmLock(vm.vmId)(async () => {
        const list0 = (await this.hv('snapshots', this.ident(vm))).snapshots || []
        oldName = list0.find(x => x.id === e.cleanCheckpointId)?.name ?? null
        if (!oldName) throw new Error('its clean checkpoint is missing')
        this.journal.append({ t: 'rcl-begin', opId, vmId: vm.vmId, oldClean: e.cleanCheckpointId, oldName, snapName })
        const creds = this.creds()
        let committed = false
        try {
          const floor = this.policy.minFreeGBForCheckpoint ?? 20
          const freeOk = async () => { const f = await this.hv('facts', { folders: [vm.folder] }); const g = f.folders?.[0]?.freeGB; if (!Number.isFinite(g) || g < floor) throw new Error(`its drive has ${g ?? 'unknown'} GB free, under the ${floor} GB a checkpoint must leave`) }
          await freeOk()
          step('restoring its clean checkpoint and starting it (offline)')
          const f0 = await this.restoreVia(vm, 'restore', { ...this.ident(vm), checkpointId: e.cleanCheckpointId })
          const bad0 = baselineProblem(f0, { ...vm, cleanCheckpointId: e.cleanCheckpointId })
          if (bad0) throw new Error(`its clean checkpoint doesn't verify: ${bad0}`)
          await this.configureStart(vm, null, 'none', 0)
          if (await this.waitGuest(vm, creds.admin, READY_WAIT_MS) === null) throw new Error('its guest didn\'t answer')
          let licNote
          if (this.isLinux(vm)) {
            // MC-1501: a Linux VM's guest steps: its seed's files, sshd and keys checked again (they aren't rewritten in
            // place; a change to them needs a rebuild). No Defender, no licence.
            step('rechecking the guest (its dispatcher, sshd and keys)')
            await this.linux.guestSteps(vm)
            licNote = 'Linux, no licence'
          } else {
            step('rerunning the guest setup')
            const g = await this.hv('guest-setup', { ...this.ident(vm), cred: creds.admin, userName: creds.user.user }, { timeoutMs: 15 * 60_000 })
            const img = this.state.images.get(this.imageOf(vm))
            const why = img ? images.guestReportProblem(g, img) : (g?.disableForceUnload === 1 ? null : 'DisableForceUnload is not 1')
            if (why) throw new Error(`the guest's sanity check failed: ${why}`)
            // MC-1539 (the user's decision): no account logs on. The test accounts' profiles are carried unchanged in the
            // clean checkpoint (an already-provisioned account's re-logon makes App Readiness log nothing at all, so the
            // build's first-logon wait could never complete here); fixes to the build's profile setup need a rebuild.
            step('excluding the test folders from Defender\'s scanning (offline)')
            await this.defenderStep(vm, creds)
            // The licence, read while it runs, for the record only: nothing is activated, and the host's evaluation end
            // (vm.licence.expiresAt) is never rewritten.
            const lic = await this.hv('guest-licence', { ...this.ident(vm), cred: creds.admin }, { timeoutMs: 120_000 })
            const licBad = refreshLicenceProblem(lic, vm, this.now())
            if (licBad) throw new Error(`its licence doesn't check out: ${licBad}`)
            licNote = `licence status ${lic.status}`
          }
          await freeOk()
          step('shutting down and taking the new clean checkpoint')
          const f1 = await this.hv('guest-shutdown', this.ident(vm), { timeoutMs: 6 * 60_000 })
          if (f1.state !== 'Off') throw new Error(`the guest didn't shut down (the VM is ${f1.state})`)
          const r = await this.hv('pool-take', { ...this.ident(vm), snapName }, { timeoutMs: 10 * 60_000 }).catch(err => ({ unknown: err.message }))
          if (r.unknown) {
            const list = await this.hv('snapshots', this.ident(vm)).then(x => x.snapshots || [], () => null)
            const found = list ? list.filter(x => x.name === snapName) : []
            if (found.length === 1) this.journal.append({ t: 'rcl-taken', opId, checkpointId: found[0].id })
            throw new Error(`the take's outcome is unknown (${r.unknown})`)
          }
          if (r.failed) throw new Error(`Hyper-V couldn't take the new clean checkpoint (${r.error})`)
          this.journal.append({ t: 'rcl-taken', opId, checkpointId: r.checkpointId })
          const f2 = await this.hv('facts-vm', this.ident(vm))
          if (f2.state !== 'Off' || f2.parentCheckpointId !== r.checkpointId) throw new Error(`the new clean checkpoint didn't verify (the VM is ${f2.state}, at ${f2.parentCheckpointId})`)
          // The commit: from here the new clean is the VM's, whatever happens.
          this.journal.append({ t: 'rcl-select', opId })
          committed = true
          step('removing the old clean checkpoint')
          const retired = await this.rclRetire(vm)
          if (retired) { this.quarantineWhy(vm, retired); return `${e.name}: refreshed (${licNote}; profiles kept as built), but ${retired}: it stays quarantined until that's done` }
          // The selected baseline, verified as a start would see it.
          const f3 = await this.restoreVia(vm, 'restore', { ...this.ident(vm), checkpointId: r.checkpointId })
          const bad3 = baselineProblem(f3, { ...vm, cleanCheckpointId: r.checkpointId })
          if (bad3) { this.quarantineWhy(vm, `its new clean checkpoint doesn't verify: ${bad3}`); return `${e.name}: refreshed, but its new clean checkpoint doesn't verify (${bad3}): quarantined` }
          return `${e.name}: refreshed (${licNote}; profiles kept as built; its pool checkpoints kept)`
        } catch (err) {
          if (committed) { this.quarantineWhy(vm, `refresh cleanup pending: ${err.message}`); return `${e.name}: refreshed, but ${err.message}: quarantined until cleanup verifies` }
          const left = await this.rclAbandon(vm)
          if (left) { this.quarantineWhy(vm, left); return `${e.name}: FAILED (${err.message}); ${left}: it stays quarantined until that's done` }
          return `${e.name}: FAILED (${err.message}); its old clean checkpoint is kept, unchanged`
        }
      })
    } catch (err) {
      return `${e.name}: FAILED (${err.message})`
    } finally { this.refreshing.delete(vm.vmId) }
  }

  /** Quarantines a VM with this reason (journalled once). */
  quarantineWhy(vm, why) {
    if (this.state.quarantined.get(vm.vmId) !== why) this.journal.append({ t: 'quarantine', vmId: vm.vmId, why })
  }

  /**
   * MC-1531: abandons an unselected refresh: the old clean restored and verified (Off, at it, disconnected, no reserve),
   * then the provisional snapshot reconciled (by id, or by its unique name: absent only counts once Hyper-V's jobs are
   * all ended and a fresh look agrees), removed if there, then rcl-abandoned. Returns null, or why it's still pending.
   * Uses the raw restore (never this.restore, which would come back here).
   */
  async rclAbandon(vm) {
    const rec = this.refreshOf(vm.vmId)
    if (!rec || rec.selected) return null
    try {
      const f = await this.restoreVia(vm, 'restore', { ...this.ident(vm), checkpointId: rec.oldClean })
      const bad = baselineProblem(f, { ...vm, cleanCheckpointId: rec.oldClean })
      if (bad) return `refresh cleanup pending: its old clean checkpoint doesn't verify (${bad})`
      let list = (await this.hv('snapshots', this.ident(vm))).snapshots || []
      let snap = rec.newId ? list.find(x => x.id === rec.newId) : null
      if (rec.newId && snap && snap.name !== rec.snapName) return `refresh cleanup pending: its new snapshot's id ${rec.newId} now has the name "${snap.name}"`
      if (!rec.newId) {
        let ys = list.filter(x => x.name === rec.snapName)
        if (ys.length > 1) return `refresh cleanup pending: ${ys.length} snapshots are named ${rec.snapName}`
        if (!ys.length) {
          const idle = await this.hv('jobs-idle', this.ident(vm)).then(x => x.idle === true, () => null)
          if (idle !== true) return `refresh cleanup pending: its take may still be in progress (Hyper-V ${idle === false ? 'has a job that hasn\'t ended' : 'job state unreadable'})`
          list = (await this.hv('snapshots', this.ident(vm))).snapshots || []
          ys = list.filter(x => x.name === rec.snapName)
          if (ys.length > 1) return `refresh cleanup pending: ${ys.length} snapshots are named ${rec.snapName}`
        }
        snap = ys[0] || null
      }
      if (snap) {
        const gone = (await this.hv('snapshot-remove', { ...this.ident(vm), checkpointId: snap.id, snapName: rec.snapName })).removed === true
        if (!gone) return `refresh cleanup pending: its unpublished new snapshot is still there`
      }
      this.journal.append({ t: 'rcl-abandoned', opId: rec.opId })
      return null
    } catch (err) { return `refresh cleanup pending: ${err.message}` }
  }

  /**
   * MC-1531: retires a selected refresh's old clean: removed by its exact id and name (its children merged, kept), then
   * the new clean and every published pool checkpoint of the VM confirmed still there, then rcl-retired. Returns null, or
   * why it's still pending.
   */
  async rclRetire(vm) {
    const rec = this.refreshOf(vm.vmId)
    if (!rec || !rec.selected) return null
    try {
      const list = (await this.hv('snapshots', this.ident(vm))).snapshots || []
      const old = list.find(x => x.id === rec.oldClean)
      if (old && old.name !== rec.oldName) return `old clean removal pending: its id ${rec.oldClean} now has the name "${old.name}"`
      // Preflight, before the old one is touched: the selected new clean, by id and name, and every published pool
      // checkpoint of the VM must be there. Otherwise the old clean stays (it may be the only good baseline left).
      const fresh = new Map(list.map(x => [x.id, x]))
      const nw = fresh.get(rec.newId)
      if (!nw) return 'old clean removal pending: the new clean checkpoint is missing (the old one is kept)'
      if (nw.name !== rec.snapName) return `old clean removal pending: the new clean checkpoint's id ${rec.newId} now has the name "${nw.name}" (the old one is kept)`
      const missing = [...this.state.poolSnaps.values()].filter(x => x.vmId === vm.vmId && !fresh.has(x.checkpointId))
      if (missing.length) return `old clean removal pending: pool checkpoint(s) ${missing.map(x => `"${x.name}"`).join(', ')} are missing (the old clean is kept)`
      if (old) {
        const gone = (await this.hv('snapshot-remove', { ...this.ident(vm), checkpointId: rec.oldClean, snapName: rec.oldName })).removed === true
        if (!gone) return 'old clean removal pending: it is still there'
      }
      const after = new Set(((await this.hv('snapshots', this.ident(vm))).snapshots || []).map(x => x.id))
      if (!after.has(rec.newId)) return 'old clean removal pending: the new clean checkpoint is missing afterwards'
      const lost = [...this.state.poolSnaps.values()].filter(x => x.vmId === vm.vmId && !after.has(x.checkpointId))
      if (lost.length) return `old clean removal pending: pool checkpoint(s) ${lost.map(x => `"${x.name}"`).join(', ')} missing afterwards`
      this.journal.append({ t: 'rcl-retired', opId: rec.opId })
      return null
    } catch (err) { return `old clean removal pending: ${err.message}` }
  }

  // ---------- build staging ----------

  /** Abandons a connection's staged build: closes any staged file still open, then removes it. Never throws. */
  dropStage(c) {
    const st = c?.stage
    if (!st) return
    c.stage = null
    if (st.current) { try { fs.closeSync(st.current.fd) } catch { /* closed */ } st.current = null }
    this.removeStaging(st.dir)
  }

  /** Removes a staging folder; one that can't be removed yet (a file still open) is recorded and retried. */
  removeStaging(dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      this.pendingCleanup.delete(dir)
    } catch (e) {
      if (!this.pendingCleanup.has(dir)) this.log(`staging cleanup of ${dir} failed (${e.code || e.message}): retried later`)
      this.pendingCleanup.add(dir)
    }
  }

  /**
   * Starts staging a build: for vm_start (no planId), or for a vm_sync plan (planId), whose staging takes exactly the
   * plan's needed files, each once, at the plan's size and SHA-256 (hashed here as the bytes arrive, never taken on trust).
   */
  stageBegin(connId, { planId } = {}) {
    const lease = this.leaseOf(connId)
    const c = this.conns.get(connId)
    let plan = null
    if (planId !== undefined) plan = this.currentPlan(lease, planId)
    this.dropStage(c)
    const dir = join(this.dir, 'runs', lease.leaseId + '-' + hex(4), 'staging')
    fs.mkdirSync(dir, { recursive: true })
    c.stage = { dir, files: 0, bytes: 0, current: null, done: false, plan, hashes: new Map() }
    return { text: 'staging' }
  }

  stageFile(connId, { path, size }) {
    const c = this.conns.get(connId)
    const st = c?.stage
    if (!st || st.done) throw new Error('no build being staged: stage_begin first')
    this.closeStaged(st)
    const parts = segments(path)
    const key = keyOf(parts)
    if (!Number.isInteger(size) || size < 0) throw new Error('bad size')
    if (st.hashes.has(key)) throw new Error(`${path}: staged twice (as ${st.hashes.get(key).path})`)
    if (st.plan) {
      const want = st.plan.need.get(key)
      if (!want) throw new Error(`${path}: not one of the files sync plan ${st.plan.planId} needs`)
      if (want.size !== size) throw new Error(`${path}: ${size} bytes, but the plan has ${want.size}: it changed while syncing. Call vm_sync again.`)
    }
    if (st.bytes + size > this.policy.maxBuildMB * 1024 * 1024) throw new Error(`the build is over the policy's ${this.policy.maxBuildMB} MB`)
    if (++st.files > 100_000) throw new Error('the build has more than 100000 files')
    const file = join(st.dir, ...parts)
    fs.mkdirSync(join(file, '..'), { recursive: true })
    st.current = { fd: fs.openSync(file, 'wx'), left: size, size, path: parts.join('\\'), key, hash: crypto.createHash('sha256') }
    st.bytes += size
    return { text: 'ok' }
  }

  stageChunk(connId, { data }) {
    const st = this.conns.get(connId)?.stage
    if (!st?.current) throw new Error('no staged file open')
    const buf = Buffer.from(String(data), 'base64')
    if (buf.length > CHUNK_MAX || buf.length > st.current.left) throw new Error(`${st.current.path}: more bytes than its size`)
    fs.writeSync(st.current.fd, buf)
    st.current.hash.update(buf)
    st.current.left -= buf.length
    return { text: 'ok' }
  }

  closeStaged(st) {
    if (!st.current) return
    const cur = st.current
    st.current = null
    fs.closeSync(cur.fd)
    if (cur.left) throw new Error(`${cur.path}: ${cur.left} bytes short of its size`)
    const sha256 = cur.hash.digest('hex')
    if (st.plan && st.plan.need.get(cur.key).sha256 !== sha256) throw new Error(`${cur.path}: its content isn't what the plan hashed: it changed while syncing. Call vm_sync again.`)
    st.hashes.set(cur.key, { path: cur.path, size: cur.size, sha256 })
  }

  stageEnd(connId) {
    const st = this.conns.get(connId)?.stage
    if (!st) throw new Error('no build being staged')
    this.closeStaged(st)
    if (st.plan) {
      const missing = [...st.plan.need].filter(([k]) => !st.hashes.has(k)).map(([, f]) => f.path)
      if (missing.length) throw new Error(`sync plan ${st.plan.planId} needs ${missing.length} file(s) not staged: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`)
    }
    st.done = true
    return { text: `staged ${st.files} files, ${st.bytes} bytes`, data: { files: st.files, bytes: st.bytes } }
  }

  // ---------- warm sessions: sync ----------

  /** The lease's current sync plan, if planId names it and it is still current (same lease, same gen); else throws. */
  currentPlan(lease, planId) {
    const p = lease.sync.plan
    if (typeof planId !== 'string' || !p || p.planId !== planId) throw new Error(`Sync plan ${planId} is not this lease's current plan (replaced by a newer one, or used): call vm_sync again.`)
    if (p.leaseId !== lease.leaseId || p.gen !== lease.sync.gen) throw new Error(`Sync plan ${planId} is stale (the VM was started, reset or synced since): call vm_sync again.`)
    return p
  }

  /**
   * sync_plan: compares the build's manifest (the server's walk of an allowed folder: [{ path, size, sha256 }]) with
   * what the helper placed in C:\build, and returns the plan: the files it needs (new or changed) and the ones to remove
   * (in the record, gone from the manifest; with delete, the default). full: everything, into a cleared C:\build.
   */
  /**
   * A manifest sent in parts (manifest_begin, then manifest_add batches), so no request line comes near the service
   * host's 4 MB frame limit, whatever the build's size: a line over it closes the connection, which would end the lease.
   * It is the connection's, bound to its lease and generation; sync_plan without `files` takes it (once).
   */
  manifestBegin(connId) {
    const lease = this.leaseOf(connId)
    const c = this.conns.get(connId)
    c.manifest = { leaseId: lease.leaseId, gen: lease.sync.gen, files: [] }
    return { text: 'manifest' }
  }

  manifestAdd(connId, { files } = {}) {
    const lease = this.leaseOf(connId)
    const m = this.conns.get(connId).manifest
    if (!m) throw new Error('no manifest being sent: manifest_begin first')
    if (m.leaseId !== lease.leaseId || m.gen !== lease.sync.gen) throw new Error('This manifest is stale (the VM was started, reset or synced since): call vm_sync again.')
    if (!Array.isArray(files) || files.length > MANIFEST_BATCH) throw new Error(`files must be a list of at most ${MANIFEST_BATCH} entries per manifest_add`)
    if (m.files.length + files.length > 100_000) { this.conns.get(connId).manifest = null; throw new Error('the build has more than 100000 files') }
    for (const f of files) m.files.push(f && typeof f === 'object' ? { path: f.path, size: f.size, sha256: f.sha256 } : f)
    return { text: 'ok', data: { files: m.files.length } }
  }

  syncPlan(connId, { files, full = false, delete: del = true } = {}) {
    const lease = this.leaseOf(connId)
    const conn = this.conns.get(connId)
    if (files === undefined) {
      const m = conn.manifest
      conn.manifest = null
      if (!m) throw new Error('no manifest: send one (manifest_begin, manifest_add) or pass files')
      if (m.leaseId !== lease.leaseId || m.gen !== lease.sync.gen) throw new Error('This manifest is stale (the VM was started, reset or synced since): call vm_sync again.')
      files = m.files
    }
    if (lease.kept) throw new Error(`${lease.vmName} is kept for inspection: vm_release it first.`)
    if (!lease.running) throw new Error('The VM is not running: vm_start it first (a sync copies into the running guest).')
    if (!Array.isArray(files) || files.length > 100_000) throw new Error('files must be a list of at most 100000 entries')
    const manifest = new Map()
    let bytes = 0
    for (const f of files) {
      if (!f || typeof f !== 'object') throw new Error('each file must be { path, size, sha256 }')
      let parts
      try { parts = segments(f.path) } catch (e) { throw new Error(`"${f.path}": ${e.message}`) }
      if (!Number.isInteger(f.size) || f.size < 0) throw new Error(`"${f.path}": bad size`)
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`"${f.path}": bad sha256`)
      const key = keyOf(parts)
      if (manifest.has(key)) throw new Error(`"${f.path}" and "${manifest.get(key).path}" are the same file on Windows (case and slashes don't count)`)
      manifest.set(key, { path: parts.join('\\'), size: f.size, sha256: f.sha256 })
      bytes += f.size
    }
    if (bytes > this.policy.maxBuildMB * 1024 * 1024) throw new Error(`the build is over the policy's ${this.policy.maxBuildMB} MB`)
    const clash = ancestorClash(manifest, manifest)
    if (clash) throw new Error(`"${clash[0]}" is a file, and also a folder of "${clash[1]}": refused`)
    const s = lease.sync
    if (!full && !s.trusted) throw new Error('The last sync or start didn\'t finish, so C:\\build may be partly changed: use vm_sync with full: true (recopies everything), or vm_reset.')
    const need = new Map()
    const remove = []
    if (full) {
      for (const [k, f] of manifest) need.set(k, f)
    } else {
      for (const [k, f] of manifest) { const r = s.record.get(k); if (!r || r.size !== f.size || r.sha256 !== f.sha256) need.set(k, f) }
      const gone = new Map([...s.record].filter(([k]) => !manifest.has(k)))
      if (del) for (const r of gone.values()) remove.push(r.path)
      else {
        // Kept files stay in the record (a later delete:true removes them); one in the way of the new build can't stay.
        const c1 = ancestorClash(gone, manifest) // [kept, new]
        const c2 = ancestorClash(manifest, gone) // [new, kept]
        const [kept, fresh] = c1 || (c2 && [c2[1], c2[0]]) || []
        if (kept) throw new Error(`with delete: false, "${kept}" (kept) and "${fresh}" (new) can't both be there: sync with delete: true, or full: true. Nothing was changed.`)
      }
    }
    const plan = { planId: `sp-${hex(8)}`, leaseId: lease.leaseId, gen: s.gen, full: !!full, delete: !!del, need, remove, manifest }
    s.plan = plan // replaces any earlier plan
    return {
      text: `Sync plan ${plan.planId}: ${need.size} file(s) to copy, ${full ? 'C:\\build cleared first' : `${remove.length} to remove, ${manifest.size - need.size} unchanged`}.`,
      data: { planId: plan.planId, need: [...need.values()].map(f => f.path), remove: remove.length, unchanged: full ? 0 : manifest.size - need.size }
    }
  }

  /**
   * sync: applies the current plan to the running guest (guest-sync.ps1 through hv.ps1's sync-in), without a restore.
   * Rechecked inside the VM's lock. C:\build is untrusted from the first change until the apply finishes: a failure,
   * a timeout or the lease ending leaves it untrusted, and only a full sync or a reset may follow.
   */
  async sync(connId, { planId } = {}) {
    const lease = this.leaseOf(connId)
    const c = this.conns.get(connId)
    const vm = this.vmOf(lease)
    return this.vmLock(vm.vmId)(async () => {
      this.stillHeld(lease)
      if (lease.kept || !lease.running) throw new Error('The VM is not running: vm_start it first.')
      const plan = this.currentPlan(lease, planId)
      const st = c.stage
      if (plan.need.size && !(st && st.plan === plan && st.done)) throw new Error(`Sync plan ${plan.planId}'s files aren't all staged: stage them first.`)
      const s = lease.sync
      s.plan = null
      s.trusted = false
      const gen = ++s.gen
      const t0 = this.now()
      try {
        const creds = this.creds()
        const r = await this.guestCall(vm, 'sync-in', {
          ...this.ident(vm), cred: creds.admin, source: plan.need.size ? st.dir : null, guestStage: `C:\\hvmcp\\sync-${gen}`,
          files: [...plan.need.values()].map(f => f.path), remove: plan.remove, full: plan.full, delete: plan.delete,
          ...(this.isLinux(vm) ? { entries: [...plan.need.values()], gen } : {})
        }, this.forLease(lease, 30 * 60_000))
        this.stillHeld(lease)
        if (plan.full) s.record = new Map(plan.manifest)
        else {
          for (const p of plan.remove) {
            const k = keyOf(segments(p))
            for (const rk of [...s.record.keys()]) if (rk === k || rk.startsWith(k + '\\')) s.record.delete(rk)
          }
          for (const [k, f] of plan.need) s.record.set(k, f)
        }
        s.trusted = true
        const copied = Number(r.copied) || 0
        return {
          text: `Synced into ${vm.vmName}'s ${this.paths(vm).build} without a restore: ${copied} file(s) copied (${[...plan.need.values()].reduce((n, f) => n + f.size, 0)} bytes), ${plan.full ? 'after clearing it' : `${Number(r.removed) || 0} removed, ${plan.manifest.size - plan.need.size} unchanged`}; ${((this.now() - t0) / 1000).toFixed(1)} s. ${this.paths(vm).out} and everything else in the guest are as the last run left them.`,
          data: { copied, removed: Number(r.removed) || 0, full: plan.full }
        }
      } catch (e) {
        throw new Error(`The sync failed (${e.message}). C:\\build may be partly changed: the next vm_sync must be full: true, or vm_reset.`)
      } finally {
        if (c.stage && c.stage.plan === plan) this.dropStage(c)
      }
    })
  }

  // ---------- a run's network (MC-1556) ----------

  /** Throws unless a run may use this mode now: at or below the pool's approved mode, which is at or below the policy's. */
  netAllowed(mode) {
    const why = net.above(mode, this.state.network, 'the pool') || net.above(mode, this.policy.maxNetwork, 'the policy')
    if (why) throw new Error(`${why[0].toUpperCase()}${why.slice(1)}: ask for a lower one, or ask the user to approve a pool_plan resize with a higher network mode${net.above(mode, this.policy.maxNetwork, 'x') ? ' (above the policy, setup must be rerun first)' : ''}.`)
  }

  /**
   * What a mode needs, checked now: { mode, switchId, switchName, kind, acls, address?, hostAddress?, subnet?, gateway? }.
   * Host mode: setup's switch by id, internal, the host's address exactly on it, no clash with any other interface or
   * route; the guest's address the lowest free one among the live host-mode leases. Internet modes: the Default Switch's
   * gateway and subnet, read now (Windows can change them at a restart).
   */
  async netSpec(lease, mode, opts) {
    if (mode === 'none') return { mode, switchId: null, switchName: null, kind: null, acls: [] }
    if (mode === 'host') {
      const h = this.policy.hostNetwork
      if (!h) throw new Error('Host mode needs setup\'s host network: ask the user to rerun setup with -MaxNetwork Host or above.')
      const r = await this.hv('net-host', { switchId: h.switchId, switchName: h.switchName }, opts)
      const why = net.hostProblem(r, h)
      if (why) throw new Error(`Host mode can't be used now: ${why}. Nothing was started.`)
      // Synchronous from here to the assignment: two starts can't take the same address.
      const used = [...this.leases.values()].filter(l => l !== lease && l.net?.address).map(l => l.net.address)
      const address = lease?.net?.mode === 'host' && lease.net.address && !used.includes(lease.net.address) ? lease.net.address : net.allocate(h.subnet, used)
      if (!address) throw new Error('No host-mode address is free.')
      const spec = { mode, switchId: h.switchId, switchName: h.switchName, kind: 'host', acls: net.aclsFor('host', { hostAddress: h.hostAddress }), address, hostAddress: h.hostAddress, subnet: h.subnet }
      if (lease) lease.net = spec
      return spec
    }
    const d = net.defaultFacts(await this.hv('net-default', {}, opts))
    if (d.why) throw new Error(`${d.why[0].toUpperCase()}${d.why.slice(1)}. Nothing was started.`)
    const spec = { mode, switchId: net.DEFAULT_SWITCH_ID, switchName: 'Default Switch', kind: 'default', acls: net.aclsFor(mode, { gateway: d.gateway }), gateway: d.gateway, subnet: d.subnet }
    if (lease) lease.net = spec
    return spec
  }

  /**
   * Starts an Off VM in a network mode, fail-closed: first the adapter disconnected and the mode's complete port-ACL set
   * installed while it is (net-prepare), read back exactly; only then connected, by switch id, and started
   * (configure-start). A failure before the start leaves the VM Off and disconnected. Returns the spec.
   */
  async configureStart(vm, lease, mode, reserve) {
    const opts = lease ? this.forLease(lease) : undefined
    const spec = await this.netSpec(lease, mode, opts)
    if (lease) this.stillHeld(lease)
    const prep = await this.hv('net-prepare', { ...this.ident(vm), acls: spec.acls }, opts)
    if (lease) this.stillHeld(lease)
    if (prep.switchName) throw new Error(`${vm.vmName}'s network adapter didn't disconnect (it reads ${prep.switchName}). Nothing was started.`)
    const bad = net.aclProblem(prep.acls, spec.acls)
    if (bad) throw new Error(`${vm.vmName}'s network couldn't be prepared: ${bad}. It was left disconnected; nothing was started.`)
    await this.hv('configure-start', { ...this.ident(vm), switchId: spec.switchId, switchName: spec.switchName, kind: spec.kind, reserve }, opts)
    return spec
  }

  /**
   * The guest's own network for the lease's mode (host: its static address; internet: DHCP), then read back until it has
   * held for NET_STABLE_MS, within NET_WAIT_MS. Returns the text for the reply. Throws with the last reason seen.
   */
  async guestNet(vm, lease, creds) {
    const spec = lease.net
    if (lease.network === 'none' || !spec) return 'off'
    const opts = this.forLease(lease)
    const f = await this.hv('facts-vm', this.ident(vm), opts)
    this.stillHeld(lease)
    if (!f.mac) throw new Error(`${vm.vmName}'s network adapter has no MAC address yet`)
    const cred = (creds || this.creds()).admin
    const want = { mode: lease.network, mac: f.mac, address: spec.address, subnet: spec.subnet, gateway: spec.gateway }
    await this.guestCall(vm, 'guest-net', { ...this.ident(vm), cred, mode: net.defaultSwitch(lease.network) ? 'internet' : 'host', mac: f.mac, address: spec.address }, opts)
    this.stillHeld(lease)
    const t0 = this.now()
    let okSince = null
    let why = 'not read yet'
    for (;;) {
      let read = null
      try { read = await this.guestCall(vm, 'guest-net-read', { ...this.ident(vm), cred, lookup: net.defaultSwitch(lease.network) }, opts) } catch (e) { why = `the read failed: ${e.message}` }
      this.stillHeld(lease)
      if (read) why = net.guestProblem(read, want)
      const now = this.now()
      if (read && !why) {
        if (okSince === null) okSince = now
        if (now - okSince >= NET_STABLE_MS) break
      } else okSince = null
      if (now - t0 > NET_WAIT_MS) throw new Error(`its network (${lease.network}) wasn't ready and steady within ${Math.round(NET_WAIT_MS / 1000)} s: ${why || 'it changed while it was read'}`)
      await this.sleep(Math.min(1000, Math.max(50, NET_STABLE_MS / 5)))
    }
    return lease.network === 'host'
      ? `host (${spec.address} on ${spec.switchName}; this PC is ${spec.hostAddress}, its firewall decides which ports)`
      : `${lease.network} (DHCP from Windows' Default Switch${lease.network === 'internet' ? '; the LAN is blocked' : ''})`
  }

  /**
   * configureStart for a lease, and on its failure the VM restored to clean at once, while the lease still holds it:
   * never left Off on a switch with its ACLs, or started half-configured, until a later stop or recovery. A restore
   * that doesn't verify quarantines the VM (restore's own rule). MC-1556 round 1.
   */
  async configureStartOrClean(vm, lease, mode, reserve) {
    try { return await this.configureStart(vm, lease, mode, reserve) } catch (e) {
      this.stillHeld(lease)
      lease.running = false
      const r = await this.restore(vm, null, lease)
      throw new Error(`${e.message.replace(/\.?$/, '.')} ${r.ok ? `${vm.vmName} was restored to clean (network disconnected).` : r.text}`)
    }
  }

  /** guestNet, and on its failure the VM restored to clean (never left running half-configured) and the start failed. */
  async guestNetOrClean(vm, lease, creds) {
    try { return await this.guestNet(vm, lease, creds) } catch (e) {
      this.stillHeld(lease)
      lease.running = false
      const r = await this.restore(vm, null, lease)
      throw new Error(`${vm.vmName} started, but ${e.message}. ${r.ok ? 'It was restored to clean (network disconnected).' : r.text} vm_reset to try again, or ask for network none.`)
    }
  }

  // ---------- runs ----------

  async start(connId, { network, reserveCpu = 0, interactive = false, checkpoint } = {}) {
    const lease = this.leaseOf(connId)
    const c = this.conns.get(connId)
    if (checkpoint !== undefined && (typeof checkpoint !== 'string' || !POOL_CHECKPOINT_RE.test(checkpoint))) throw new Error("checkpoint must be 'clean' or one of this VM's pool checkpoints (vm_status lists them).")
    if (![false, 'user', 'admin'].includes(interactive)) throw new Error("interactive must be false, 'user' or 'admin'")
    if (lease.kept) throw new Error(`${lease.vmName} is kept for inspection: vm_release it, then vm_acquire again (a release restores it).`)
    if (interactive && lease.os === 'linux') throw new Error('Linux guests have no desktop session: interactive is for Windows guests.')
    const mode = net.modeOf(network)
    this.netAllowed(mode)
    if (!Number.isInteger(reserveCpu) || reserveCpu < 0 || reserveCpu > this.policy.maxReservePercent) throw new Error(`reserveCpu must be a whole percentage, 0-${this.policy.maxReservePercent} (the policy's cap).`)
    if (c.stage?.plan) this.dropStage(c) // a sync's partial staging is never a start's build
    if (c.stage && !c.stage.done) throw new Error('the build is still being staged')
    const vm = this.vmOf(lease)
    return this.vmLock(vm.vmId)(async () => {
      this.stillHeld(lease)
      // MC-1532: what to start from (resolved under the lock): 'clean', a name, or the lease's own start point.
      const target = this.startTarget(lease, checkpoint)
      if (target) lease.refs.add(target.checkpointId) // pinned before the restore, so a pending one counts
      const t0 = this.now()
      lease.running = false
      lease.failed = false
      lease.interactive = null
      // C:\build is the clean checkpoint's (empty) once restored, then the build's: untrusted until the copy finishes,
      // so a failed start leaves no earlier record usable. Any sync plan is stale from here.
      const s = lease.sync
      s.gen++
      s.plan = null
      s.trusted = false
      s.record = new Map()
      const r = await this.restore(vm, target, lease) // unconditionally, before every run
      if (!r.ok) { lease.dirty = true; throw new Error(`${r.text} The start was refused.`) }
      const tRestore = this.now()
      // Every stage of a start is the lease's: its Hyper-V calls are registered with it (ending the lease kills them), and
      // each stage first checks the lease still holds, so nothing more starts once it has ended.
      this.stillHeld(lease)
      // The guest not answering, or its logon not appearing, is the VM's failure (unless the lease ended meanwhile).
      const failed = why => { if (this.leases.get(lease.vmId) === lease && !lease.ending) this.startFailed.set(vm.vmId, { at: this.now(), why, interactive: !!interactive }) }
      lease.dirty = true
      lease.network = mode
      lease.reserve = reserveCpu
      await this.configureStartOrClean(vm, lease, mode, reserveCpu)
      lease.running = true
      const creds = this.creds()
      const waited = await this.waitGuest(vm, creds.admin, READY_WAIT_MS, lease)
      if (waited === null) { failed(`its guest didn't answer within ${Math.round(READY_WAIT_MS / 1000)} s`); throw new Error(`${vm.vmName} started but its guest didn't answer within ${Math.round(READY_WAIT_MS / 1000)} s. vm_reset to try again, or vm_release and vm_acquire for another VM (one whose start failed is leased last).`) }
      this.stillHeld(lease)
      const netText = await this.guestNetOrClean(vm, lease, creds)
      let logon = ''
      if (interactive) {
        const who = creds[interactive].user
        const o = await this.logon(vm, lease, interactive, creds)
        const again = 'vm_reset to try again, or vm_release and vm_acquire for another VM (one whose start failed is leased last).'
        const wait = Math.round(LOGON_WAIT_MS / 1000)
        if (o.silent) { failed(`no logon of ${who} began within ${Math.round(FIRST_LOGON_SIGN_MS / 1000)} s of its new boot being seen`); throw new Error(`${vm.vmName} restarted to log ${who} on, but no logon of it began within ${Math.round(FIRST_LOGON_SIGN_MS / 1000)} s of the new boot being seen (no logon event for it on this boot). ${again}`) }
        if (o.loggedOff && o.unseen) { failed(`Windows logged ${who}'s logon off before it was seen`); throw new Error(`${vm.vmName} logged ${who} on, but Windows logged the session off again before the first check saw it (its logon and logoff events on this boot), and turned autologon off. ${again}`) }
        if (o.loggedOff) { failed(`${who} logged on, then Windows logged the session off`); throw new Error(`${vm.vmName} logged ${who} on (after ${(o.after / 1000).toFixed(1)} s), but Windows logged the session off again before its watcher started, and turned autologon off. ${again}`) }
        if (o.ms === undefined && o.user) { failed(`${who} logged on, but its watcher didn't start within ${wait} s`); throw new Error(`${vm.vmName} logged ${who} on, but its session's watcher didn't start within ${wait} s. ${again}`) }
        if (o.ms === undefined) { failed(`no interactive session of ${who} appeared within ${wait} s`); throw new Error(`${vm.vmName} restarted to log ${who} on, but no interactive session of it appeared within ${wait} s. ${again}`) }
        const ms = o.ms
        lease.interactive = interactive
        logon = `; ${creds[interactive].user} logged on interactively after a guest restart (${(ms / 1000).toFixed(1)} s): vm_run with session: 'interactive', as: '${interactive}' runs in its session`
      }
      // A good start clears a failure, an interactive one only by an interactive start.
      if (interactive || !this.startFailed.get(vm.vmId)?.interactive) this.startFailed.delete(vm.vmId)
      let build = 'no build'
      if (c.stage?.done) {
        const res = await this.guestCall(vm, 'copy-in', { ...this.ident(vm), cred: creds.admin, userName: creds.user.user, source: c.stage.dir, ...(this.isLinux(vm) ? { entries: c.stage.hashes, gen: s.gen } : {}) }, this.forLease(lease, 30 * 60_000))
        this.stillHeld(lease)
        build = `build copied in to ${this.paths(vm).build} (${c.stage.files} files, ${c.stage.bytes} bytes${res.ms ? `, ${(res.ms / 1000).toFixed(1)} s` : ''})`
        s.record = new Map(c.stage.hashes)
        this.dropStage(c)
      }
      s.trusted = true
      return {
        text: `Started ${vm.vmName} from ${target ? `its pool checkpoint "${target.name}"` : 'its clean checkpoint'}: restore ${((tRestore - t0) / 1000).toFixed(1)} s, guest ready after ${(waited / 1000).toFixed(1)} s${logon}; ${build}; network ${netText}; CPU reserve ${reserveCpu}%. ${this.paths(vm).out} is empty. Deadline ${new Date(lease.deadline).toISOString()}.`,
        data: { vm: vm.vmName, network: mode, ...(lease.net?.address ? { address: lease.net.address, hostAddress: lease.net.hostAddress } : {}), reserveCpu, interactive }
      }
    })
  }

  /**
   * Polls until the guest answers over PowerShell Direct. For a leased start (lease given), each poll is the lease's (an
   * ending lease kills it) and the loop stops as soon as the lease ends. The pool install's wait has no lease.
   */
  async waitGuest(vm, cred, ms, lease = null) {
    const t0 = this.now()
    while (this.now() - t0 < ms) {
      if (lease) this.stillHeld(lease)
      const r = await this.guestCall(vm, 'guest-ready', { ...this.ident(vm), cred }, lease ? this.forLease(lease, 60_000) : undefined).catch(() => null)
      if (lease) this.stillHeld(lease)
      if (r?.ready) return this.now() - t0
      await sleep(POLL_MS)
    }
    return null
  }

  /**
   * vm_start's interactive logon: hv.ps1 'guest-logon' turns on autologon of the account (its password as the guest's LSA
   * secret, wiped by the next restore), installs the session's watcher (guest-agent.ps1) to start at logon, turns UAC's
   * Admin Approval Mode off for the admin (so its session is elevated), and restarts the guest. Then it waits, as the
   * lease's, for a new boot with the account's watcher running in a session >= 1, seen twice LOGON_STABLE_MS apart on the
   * same boot: the guest may restart once more by itself after an autologon (MC-1504's trial). Up to LOGON_WAIT_MS.
   * MC-1518: it also notes the account logged on at all, per boot (a new boot other than before's; a boot change starts
   * over). Only an answered probe on that same boot saying the account is gone and autologon is no longer armed (Winlogon
   * clears it at a logoff) ends the wait early, as "logged off"; a failed probe is never evidence. Returns { ms }, or
   * { loggedOff: true, after } (ms from the start of the wait to its logon being seen), or { user } once the wait is up.
   * MC-1524: a logon no check saw (Windows drops a fresh guest's first one within seconds) ends it too, as { loggedOff,
   * unseen }, but only on the same evidence plus that boot's own LSM logon and logoff events for the account.
   * MC-1516: the build passes its account's provisioning deadline: every call and sleep is then bounded by the time left,
   * nothing that returns after it is accepted, and { late: true } is returned once it has passed. A start passes none.
   */
  async logon(vm, lease, which, creds, deadline = null, onSlow = null) {
    const account = creds[which]
    // A start's logon is the lease's (its calls end with it); the build's (MC-1516) has no lease, but a deadline.
    const left = ms => deadline === null ? ms : Math.max(1, Math.min(ms, deadline - this.now()))
    const late = () => deadline !== null && this.now() >= deadline
    const opts = ms => lease ? this.forLease(lease, ms) : { timeoutMs: left(ms) }
    const held = () => { if (lease) this.stillHeld(lease) }
    if (late()) return { late: true }
    const before = await this.hv('guest-logon', { ...this.ident(vm), cred: creds.admin, logon: account, elevated: which === 'admin' }, opts(120_000))
    if (late()) return { late: true }
    const t0 = this.now()
    let seen = null // { boot, at }: the watcher first seen on this boot
    let user = null // { boot, at }: the account first seen logged on, on this boot
    let bootSeen = null // MC-1526: { boot, at, began }: the new boot first seen (host clock), and any sign of a logon on it
    let snapped = false
    // A start waits LOGON_WAIT_MS; a build's attempt (MC-1520) up to BUILD_LOGON_WAIT_MS within its deadline, with one
    // diagnostic snapshot (onSlow) once LOGON_SNAPSHOT_MS has passed.
    const limit = deadline === null ? LOGON_WAIT_MS : BUILD_LOGON_WAIT_MS
    while (this.now() - t0 < limit) {
      if (late()) return { late: true }
      if (deadline !== null && onSlow && !snapped && this.now() - t0 >= LOGON_SNAPSHOT_MS) {
        snapped = true
        await onSlow().catch(() => {})
        if (late()) return { late: true }
      }
      held()
      const r = await this.hv('guest-session', { ...this.ident(vm), cred: creds.admin, account: account.user }, opts(60_000)).catch(() => null)
      held()
      if (late()) return { late: true }
      if (r && r.boot !== before.boot) {
        if (user && user.boot !== r.boot) user = null
        if (r.user === true && !user) user = { boot: r.boot, at: this.now() - t0 }
        if (user && r.user === false && r.armed === false) return { loggedOff: true, after: user.at }
        // MC-1524: a logon Windows dropped before any check saw it: this boot's own logon and logoff events for the
        // account, with the account gone and autologon disarmed. Unreadable events (null) are never evidence.
        if (!user && r.user === false && r.armed === false && r.logons >= 1 && r.logoffs >= 1 && Number.isInteger(r.logons) && Number.isInteger(r.logoffs)) return { loggedOff: true, after: null, unseen: true }
        // MC-1526: a logon that never begins. The host clock starts when this new boot is first seen (a later boot
        // starts it over, with the latch cleared); any sign of a logon on the boot (an event, the user) latches the rule
        // off. Only an answered probe with an integer zero count, the user never seen, FIRST_LOGON_SIGN_MS on, ends it.
        if (bootSeen?.boot !== r.boot) bootSeen = { boot: r.boot, at: this.now(), began: false }
        if (r.user === true || (Number.isInteger(r.logons) && r.logons >= 1)) bootSeen.began = true
        if (!bootSeen.began && !user && r.user === false && r.logons === 0 && this.now() - bootSeen.at >= FIRST_LOGON_SIGN_MS) return { silent: true }
      }
      if (r && r.boot !== before.boot && Array.isArray(r.sessions) && r.sessions.length) {
        if (seen?.boot === r.boot && this.now() - seen.at >= LOGON_STABLE_MS) return { ms: this.now() - t0, boot: r.boot }
        if (seen?.boot !== r.boot) seen = { boot: r.boot, at: this.now() }
      } else seen = null
      await sleep(deadline === null ? POLL_MS : Math.min(POLL_MS, Math.max(0, deadline - this.now())))
    }
    return { user: !!user }
  }

  creds() {
    const c = JSON.parse(fs.readFileSync(join(this.dir, 'secrets', 'guest.json'), 'utf8'))
    if (!c?.admin?.password || !c?.user?.password) throw new Error('the guest credentials are missing: the pool must be created again')
    return c
  }

  async run(connId, { command, shell, as = 'admin', timeoutSec = 120, cwd, session = 'service' } = {}) {
    const lease = this.leaseOf(connId)
    if (!lease.running) throw new Error('The VM is not running: call vm_start first.')
    if (!['service', 'interactive'].includes(session)) throw new Error("session must be 'service' or 'interactive'")
    if (typeof command !== 'string' || !command.trim()) throw new Error('command is required')
    if (command.length > MAX_COMMAND) throw new Error(`command is over ${MAX_COMMAND} characters: put it in a script in the build`)
    // MC-1501: a Linux guest runs bash (its default) or sh; a Windows guest cmd (its default) or powershell.
    const linux = lease.os === 'linux'
    shell ??= linux ? 'bash' : 'cmd'
    if (linux && !['bash', 'sh'].includes(shell)) throw new Error('shell must be bash or sh in a Linux guest')
    if (!linux && !['cmd', 'powershell'].includes(shell)) throw new Error('shell must be cmd or powershell in a Windows guest (bash and sh are for Linux guests)')
    if (linux && session === 'interactive') throw new Error("Linux guests have no desktop session: session must be 'service'.")
    if (!['admin', 'user'].includes(as)) throw new Error('as must be admin or user')
    if (!Number.isFinite(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) throw new Error('timeoutSec must be 1-3600')
    if (cwd !== undefined && linux && (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.length > 1024 || /[\0-\x1f]/.test(cwd))) throw new Error('cwd must be an absolute guest folder such as /build')
    if (cwd !== undefined && !linux && (typeof cwd !== 'string' || !/^[a-zA-Z]:\\/.test(cwd) || cwd.length > 260 || /[\0-\x1f"]/.test(cwd))) throw new Error('cwd must be an absolute guest folder such as C:\\build')
    const vm = this.vmOf(lease)
    return this.vmLock(vm.vmId)(async () => {
      this.stillHeld(lease)
      // Again inside the lock: a run queued behind an interactive one that restored the VM (or failed to, and
      // quarantined it) must not reach the guest. Only a start or reset makes it running again.
      if (!lease.running) throw new Error('The VM is not running (it was stopped or restored while this run waited): call vm_start or vm_reset first.')
      const interactive = session === 'interactive'
      if (interactive) {
        if (!lease.interactive) throw new Error("No one is logged on interactively in this VM: vm_start (or vm_reset) with interactive: 'user' or 'admin' first.")
        if (as !== lease.interactive) throw new Error(`The interactive session is ${lease.interactive === 'user' ? 'the standard user' : 'the admin'}'s: run it with as: '${lease.interactive}'.`)
      }
      const n = ++lease.runs
      const creds = this.creds()
      const args = { ...this.ident(vm), cred: creds.admin, n, command, shell, cwd: cwd || this.paths(vm).build, cap: OUTPUT_CAP }
      // Started (or published), then polled with short calls against one deadline, counted from the start's reply
      // (MC-1510): no PowerShell Direct call is held for the run, since one call ends after 10 minutes.
      let started = null
      if (interactive) {
        try {
          await this.hv('guest-run-publish', args, this.forLease(lease, CALL_MS))
        } catch (e) {
          this.stillHeld(lease) // an ending lease restores the VM itself
          started = { lost: e.message } // unproven: restored below, never chased
        }
      } else {
        started = await this.guestCall(vm, 'guest-run-start', { ...args, runAs: as === 'user' ? creds.user : null }, this.forLease(lease, CALL_MS))
      }
      const deadline = this.now() + timeoutSec * 1000
      const polled = started?.lost ? { result: null, last: null } : await this.pollRun(lease, vm, creds, n, deadline)
      let r = polled.result
      if (!interactive && !r) {
        // Timed out: killed by its PID only if that PID is still the run's process (its recorded creation time), then
        // a last read of its output. Both are cleanup after the run's own budget, each bounded by CLEANUP_MS.
        this.stillHeld(lease)
        const k = await this.guestCall(vm, 'guest-run-kill', { ...this.ident(vm), cred: creds.admin, pid: started.pid, started: started.started, n, job: started.job ?? null }, this.forLease(lease, CLEANUP_MS)).catch(e => ({ killed: false, why: e.message }))
        this.stillHeld(lease)
        const last = await this.guestCall(vm, 'guest-run-poll', { ...this.ident(vm), cred: creds.admin, n, cap: OUTPUT_CAP }, this.forLease(lease, CLEANUP_MS)).catch(() => null)
        r = last?.done && k.gone ? last : { ...(last || {}), exitCode: null, timedOut: true, killed: !!k.killed, killVia: k.via, killWhy: k.why }
      } else if (interactive && !r) {
        const pending = polled.last?.pending
        r = { ...(polled.last || {}), exitCode: null, clean: false, timedOut: !started?.lost, why: started?.lost ? `its request wasn't confirmed (${started.lost})` : pending ? 'the session\'s watcher never took the run (is the account still logged on?)' : `no exit within ${timeoutSec} s` }
      } else if (interactive) r = { ...r, clean: true }
      const exit = Number.isInteger(r.exitCode) ? r.exitCode : null
      if (r.timedOut || exit !== 0) lease.failed = true
      const out = s => (typeof s === 'string' ? s : '').slice(0, OUTPUT_CAP)
      // An interactive run that didn't finish cleanly isn't chased: the VM is restored, which ends whatever it started.
      // MC-1547: a Windows run in its own job whose timeout kill couldn't be confirmed through that job is never chased
      // process by process (a PID-tree kill could miss a child created as it ran): the VM is restored, as for an
      // interactive run that didn't finish cleanly, which ends everything the run started.
      const jobUnconfirmed = !interactive && !linux && !!r.timedOut && !r.killed && !!started?.job
      const restored = (interactive && r.clean !== true) || jobUnconfirmed ? await this.restoreAfterRun(lease, vm) : null
      const lines = [
        interactive
          ? (restored ? `The interactive run didn't finish cleanly (${r.why || 'no exit code'}). ${restored}` : `Exit code ${exit} (in the interactive session).`)
          : jobUnconfirmed
            ? `Timed out after ${timeoutSec} s, and its job's kill couldn't be confirmed${r.killWhy ? ` (${r.killWhy})` : ''}. ${restored}`
            : r.timedOut
            ? `Timed out after ${timeoutSec} s: ${r.killed ? (linux ? 'killed inside the guest with everything it started (its systemd unit' + "'" + 's cgroup).' : r.killVia === 'job' ? 'killed inside the guest with everything it started (its job object, MC-1547).' : 'killed inside the guest by its PID (taskkill /T /F).') : `not confirmed killed${r.killWhy ? ` (${r.killWhy})` : ''}; vm_stop is the fallback.`}`
            : `Exit code ${exit === null ? 'unknown' : exit}.`,
        `--- stdout${r.stdoutCut ? ` (first ${OUTPUT_CAP} bytes)` : ''} ---`, out(r.stdout),
        `--- stderr${r.stderrCut ? ` (first ${OUTPUT_CAP} bytes)` : ''} ---`, out(r.stderr)
      ]
      return { text: lines.join('\n'), isError: !!r.timedOut || !!restored, data: { exitCode: exit, timedOut: !!r.timedOut, session, ...(restored ? { restored: true } : {}) } }
    })
  }

  /**
   * Polls a started run's exit file with short calls until it is there or the deadline passes: { result (or null), last
   * poll }. There is always at least one poll, so a run that has already finished is seen however slow its start was.
   * One deadline for the run: a poll that fails (the socket ending, a blip) is retried within it, never extending it;
   * each poll is bounded by what is left of it (at least MIN_POLL_MS). The lease is checked before every call, and
   * ending it kills the call in flight, so nothing is sent after it ends.
   */
  async pollRun(lease, vm, creds, n, deadline) {
    const t0 = this.now()
    let last = null
    for (let polls = 0; ; polls++) {
      this.stillHeld(lease)
      const left = deadline - this.now()
      if (left <= 0 && polls > 0) return { result: null, last }
      if (polls > 0 || left > 0) await sleep(Math.max(0, Math.min(left, this.now() - t0 < 10_000 ? Math.min(1000, POLL_MS) : POLL_MS)))
      this.stillHeld(lease)
      const bound = Math.max(MIN_POLL_MS, Math.min(CALL_MS, deadline - this.now()))
      const r = await this.guestCall(vm, 'guest-run-poll', { ...this.ident(vm), cred: creds.admin, n, cap: OUTPUT_CAP }, this.forLease(lease, bound)).catch(() => null)
      if (r) last = r
      if (r?.done) return { result: r, last }
    }
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
      if (!lease.running) throw new Error('The VM is not running (it was stopped or restored while this read waited): its C:\\out is gone.')
      const creds = this.creds()
      const listing = await this.guestCall(vm, 'guest-list', { ...this.ident(vm), cred: creds.admin }, this.forLease(lease))
      this.stillHeld(lease)
      const files = (Array.isArray(listing.files) ? listing.files : []).filter(f => f && typeof f.path === 'string' && Number.isFinite(f.size)).slice(0, 1000)
      const skipped = Array.isArray(listing.skipped) ? listing.skipped.slice(0, 50).map(String) : []
      if (!want.length && !match) {
        return { text: files.length ? files.map(f => `${f.path}  ${f.size} bytes`).join('\n') + (skipped.length ? `\nSkipped (links): ${skipped.join(', ')}` : '') : `${this.paths(vm).out} is empty.`, data: { files } }
      }
      const byPath = new Map(files.map(f => [f.path.toLowerCase(), f]))
      const chosen = []
      const missing = []
      for (const p of want) { const f = byPath.get(p.toLowerCase()); if (f) chosen.push(f); else missing.push(p) }
      if (match) for (const f of files) if (match(f.path) && !chosen.includes(f)) chosen.push(f)
      const r = chosen.length
        ? await this.guestCall(vm, 'guest-read', { ...this.ident(vm), cred: creds.admin, paths: chosen.map(f => f.path), maxBytes, maxTotalBytes }, this.forLease(lease))
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

  /**
   * After an interactive run that didn't finish cleanly: restores the VM (inside the VM's lock, which the run holds),
   * as vm_stop does. Returns the text for the reply.
   */
  async restoreAfterRun(lease, vm) {
    this.stillHeld(lease)
    const r = await this.restore(vm, null, lease)
    lease.running = false
    lease.interactive = null
    lease.dirty = !r.ok
    Object.assign(lease.sync, { gen: lease.sync.gen + 1, plan: null, trusted: false, record: new Map() })
    return r.ok
      ? `The VM was restored to its clean checkpoint, which ends everything the run started (C:\\out with it; its output above was read first): vm_start or vm_reset to go on.`
      : `Restoring the VM to end what it started failed: ${r.text}`
  }

  async stop(connId, { keep = false } = {}) {
    const lease = this.leaseOf(connId)
    const vm = this.vmOf(lease)
    if (keep || (lease.keepOnFailure && lease.failed)) {
      lease.kept = true
      lease.running = false
      return { text: `${vm.vmName} is kept for inspection as it is (not restored)${keep ? '' : ' because a run failed and the lease has keepOnFailure'}. It is restored when you vm_release it or at the lease's deadline (${new Date(lease.deadline).toISOString()}); vm_start is refused until then.` }
    }
    const r = await this.vmLock(vm.vmId)(() => { this.stillHeld(lease); return this.restore(vm, null, lease) })
    lease.running = false
    lease.interactive = null
    lease.dirty = !r.ok
    Object.assign(lease.sync, { gen: lease.sync.gen + 1, plan: null, trusted: false, record: new Map() })
    return { text: r.ok ? `Reverted: ${r.text}` : r.text, isError: !r.ok }
  }

  /** MC-1529: this lease's checkpoints, journalled and not dropped (a take not yet confirmed included). */
  leaseCheckpoints(lease) {
    return [...this.state.leaseSnaps.values()].filter(x => x.leaseId === lease.leaseId && x.vmId === lease.vmId && !x.dropping && !x.snapName.startsWith('hvmcp-pool-'))
  }

  /**
   * MC-1529: vm_checkpoint. A production checkpoint (disk-consistent, no memory) of the leased VM as it runs now, under
   * the VM's lock (so never during a run, a sync, a start or a restore), journalled before the take under a unique
   * Hyper-V name and confirmed after it. Only while running, not kept, with a trusted sync record; within the lease's
   * cap (unconfirmed takes count) and the disk floor. Dropped when the lease ends.
   */
  async checkpoint(connId, { name } = {}) {
    const lease = this.leaseOf(connId)
    if (typeof name !== 'string' || !LEASE_CHECKPOINT_RE.test(name) || name.toLowerCase() === 'clean') throw new Error('name must be 1-40 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit, and not "clean".')
    const vm = this.vmOf(lease)
    return this.vmLock(vm.vmId)(async () => {
      this.stillHeld(lease)
      if (lease.kept) throw new Error(`${vm.vmName} is kept for inspection: vm_release it first.`)
      if (!lease.running) throw new Error('The VM is not running: vm_start it first (a checkpoint is taken of a running VM).')
      if (lease.sync.trusted === false) throw new Error(`${this.paths(vm).build} is unconfirmed (a copy or sync didn't finish): run a full vm_sync or vm_reset first.`)
      const mine = this.leaseCheckpoints(lease)
      if (mine.some(x => x.name === name)) throw new Error(`This lease already has a checkpoint "${name}".`)
      const cap = this.policy.maxLeaseCheckpoints ?? 3
      if (mine.length >= cap) throw new Error(`This lease holds ${mine.length} checkpoints, the policy's maxLeaseCheckpoints (${cap}).`)
      const floor = this.policy.minFreeGBForCheckpoint ?? 20
      const facts = await this.hv('facts', { folders: [vm.folder] }, this.forLease(lease))
      this.stillHeld(lease)
      const free = facts.folders?.[0]?.freeGB
      if (!Number.isFinite(free) || free < floor) throw new Error(`The VM folder's drive has ${free ?? 'unknown'} GB free, under the ${floor} GB a checkpoint must leave (minFreeGBForCheckpoint).`)
      const opId = hex(6)
      const snapName = `hvmcp-lease-${opId}`
      if (lease.os === 'linux') return this.checkpointOff(lease, vm, name, opId, snapName)
      // The VM's checkpoint type before the take, journalled: the take sets ProductionOnly and puts it back, and if that
      // is interrupted (the call killed), the lease's end puts it back from this record.
      const origType = (await this.hv('checkpoint-type', this.ident(vm), this.forLease(lease))).type
      this.stillHeld(lease)
      this.journal.append({ t: 'lcp-take', opId, vmId: vm.vmId, leaseId: lease.leaseId, name, snapName, origType, at: new Date(this.now()).toISOString() })
      let r = null
      try {
        r = await this.hv('lease-checkpoint', { ...this.ident(vm), snapName }, this.forLease(lease, 10 * 60_000))
      } catch (e) {
        // It may have been made despite the failure (a timeout, or completing after the call died). Found by its unique
        // name, it's confirmed as this lease's; not found, it stays journalled and unconfirmed (an absence now proves
        // nothing): it holds its slot, and the lease's end settles it after clean is restored.
        const list = await this.hv('snapshots', this.ident(vm)).then(x => x.snapshots || [], () => null)
        const found = list ? list.filter(x => x.name === snapName) : []
        if (found.length === 1) this.journal.append({ t: 'lcp-taken', opId, checkpointId: found[0].id })
        throw new Error(`The checkpoint "${name}" couldn't be taken (${e.message}).${found.length === 1 ? " One was made all the same: it's kept as this lease's, and removed with it." : ' Whether Hyper-V made one is settled when this lease ends (it holds a checkpoint slot until then).'}`)
      }
      if (r.failed) {
        // Hyper-V's own terminal failure (Checkpoint-VM answered with an error): nothing is in progress. Confirmed absent
        // by name, the intent is settled now; if it exists after all, it's this lease's.
        const list = await this.hv('snapshots', this.ident(vm)).then(x => x.snapshots || [], () => null)
        const found = list ? list.filter(x => x.name === snapName) : null
        if (found?.length === 1) this.journal.append({ t: 'lcp-taken', opId, checkpointId: found[0].id })
        else if (found?.length === 0) this.journal.append({ t: 'lcp-dropped', opId })
        throw new Error(`The checkpoint "${name}" couldn't be taken (${r.error}).${found?.length === 1 ? " One was made all the same: it's kept as this lease's, and removed with it." : ''} No standard checkpoint is taken instead.`)
      }
      const id = r.checkpointId
      this.journal.append({ t: 'lcp-taken', opId, checkpointId: id })
      // The checkpoint type, read back: put back now if the take left it changed, and said if that fails (the lease's
      // end tries again from the journal).
      let typeNote = ''
      if (r.checkpointType !== origType) {
        const now = await this.hv('checkpoint-type', { ...this.ident(vm), set: origType }, this.forLease(lease)).then(x => x.type, () => null)
        if (now !== origType) typeNote = ` Note: the VM's checkpoint type was left as ${r.checkpointType} (it was ${origType}); it's put back when this lease ends.`
      }
      this.stillHeld(lease) // a lease that ended meanwhile gets no success; its release removes the checkpoint
      return { text: `Checkpoint "${name}" taken of ${vm.vmName} (files, installed software and the registry; not running programs or a logon session). vm_restore({ name: "${name}" }) brings it back; it's removed when this lease ends.${typeNote}`, data: { name, checkpointId: id } }
    })
  }

  /**
   * MC-1501: a Linux lease checkpoint (design §6). Linux guests have no VSS (hv_vss_daemon isn't in the images and can't
   * be installed offline), so it is taken of the Off VM: the guest shut down cleanly, a standard checkpoint of the Off
   * VM under the same journalled name and the same unconfirmed-take rules, then the VM started again with the lease's
   * network and CPU reserve, the guest awaited and read back. The promise is the same as Windows': files, installed
   * software and configuration, no memory or running programs. /build stays confirmed (its disk is unchanged).
   */
  async checkpointOff(lease, vm, name, opId, snapName) {
    this.journal.append({ t: 'lcp-take', opId, vmId: vm.vmId, leaseId: lease.leaseId, name, snapName, origType: null, at: new Date(this.now()).toISOString() })
    // MC-1556: the restart is a new connection, so both caps are checked again. A mode now above one (a plan lowered
    // the pool's) restarts with no network instead, and the reply says so: the VM stays usable, never over a cap.
    let netNote = ''
    const restart = async () => {
      try { this.netAllowed(lease.network) } catch (e) {
        netNote = ` Its network was ${lease.network}, now above a cap (${e.message}), so it was started with network none.`
        lease.network = 'none'; lease.net = null
      }
      await this.configureStartOrClean(vm, lease, lease.network, lease.reserve || 0)
      this.stillHeld(lease)
      const waited = await this.waitGuest(vm, null, READY_WAIT_MS, lease)
      this.stillHeld(lease)
      if (waited === null) throw new Error(`${vm.vmName}'s guest didn't answer after the checkpoint: vm_reset to go on from clean`)
      lease.running = true
      await this.guestNetOrClean(vm, lease, null)
    }
    let r = null
    try {
      const off = await this.hv('guest-shutdown', this.ident(vm), this.forLease(lease, 6 * 60_000))
      this.stillHeld(lease)
      if (off.state !== 'Off') { this.journal.append({ t: 'lcp-dropped', opId }); throw new Error(`the guest didn't shut down (the VM is ${off.state})`) }
      lease.running = false
      r = await this.hv('pool-take', { ...this.ident(vm), snapName }, this.forLease(lease, 10 * 60_000))
    } catch (e) {
      if (lease.running === false && !this.leases.get(vm.vmId)?.ending) {
        const list = await this.hv('snapshots', this.ident(vm)).then(x => x.snapshots || [], () => null)
        const found = list ? list.filter(x => x.name === snapName) : []
        if (found.length === 1) this.journal.append({ t: 'lcp-taken', opId, checkpointId: found[0].id })
        await restart().catch(() => {})
      }
      throw new Error(`The checkpoint "${name}" couldn't be taken (${e.message}).`)
    }
    if (r.failed) {
      const list = await this.hv('snapshots', this.ident(vm)).then(x => x.snapshots || [], () => null)
      const found = list ? list.filter(x => x.name === snapName) : null
      if (found?.length === 1) this.journal.append({ t: 'lcp-taken', opId, checkpointId: found[0].id })
      else if (found?.length === 0) this.journal.append({ t: 'lcp-dropped', opId })
      await restart().catch(() => {})
      throw new Error(`The checkpoint "${name}" couldn't be taken (${r.error}).`)
    }
    this.journal.append({ t: 'lcp-taken', opId, checkpointId: r.checkpointId })
    await restart()
    const f = await this.hv('facts-vm', this.ident(vm), this.forLease(lease))
    this.stillHeld(lease)
    if (f.state !== 'Running' || f.parentCheckpointId !== r.checkpointId) throw new Error(`${vm.vmName} took the checkpoint "${name}", but didn't read back as running from it (${f.state}, at ${f.parentCheckpointId}): vm_reset to go on from clean.`)
    return { text: `Checkpoint "${name}" taken of ${vm.vmName} with the guest shut down (Linux: files, installed software and configuration; not running programs). The guest was started again from it.${netNote} vm_restore({ name: "${name}" }) brings it back; it's removed when this lease ends.`, data: { name, checkpointId: r.checkpointId } }
  }

  /**
   * MC-1529: vm_restore. The lease's named checkpoint, verified as this lease's on this VM by id and name, restored
   * (a production checkpoint restores Off), then started like vm_start: the lease's current network and CPU reserve,
   * the guest awaited, all read back. The sync record is cleared and untrusted; run numbers keep rising; no one is
   * logged on interactively afterwards.
   */
  async restoreCheckpoint(connId, { name } = {}) {
    const lease = this.leaseOf(connId)
    const vm = this.vmOf(lease)
    return this.vmLock(vm.vmId)(async () => {
      this.stillHeld(lease)
      if (lease.kept) throw new Error(`${vm.vmName} is kept for inspection: vm_release it first.`)
      const cp = this.leaseCheckpoints(lease).find(x => x.name === name)
      if (!cp) throw new Error(`This lease has no checkpoint "${name}"${this.leaseCheckpoints(lease).length ? ` (it has: ${this.leaseCheckpoints(lease).map(x => x.name).join(', ')})` : ''}.`)
      if (!cp.checkpointId) throw new Error(`The checkpoint "${name}" wasn't confirmed when it was taken: it can't be restored.`)
      const t0 = this.now()
      lease.running = false
      lease.interactive = null
      Object.assign(lease.sync, { gen: lease.sync.gen + 1, plan: null, trusted: false, record: new Map() })
      this.dropStage(this.conns.get(lease.connId))
      lease.dirty = true
      const after = await this.restoreVia(vm, 'lease-restore', { ...this.ident(vm), checkpointId: cp.checkpointId, snapName: cp.snapName }, { lease })
      this.stillHeld(lease)
      const rp = restoreProblem(after) // MC-1536/1537: a timed-out phase is refused, whatever the facts say
      if (rp) throw new Error(`Restoring "${name}" didn't verify: ${rp}. vm_reset to go on from clean.`)
      if (after.vmId !== vm.vmId || after.parentCheckpointId !== cp.checkpointId || after.state !== 'Off') throw new Error(`Restoring "${name}" didn't verify (state ${after.state}, parent ${after.parentCheckpointId}): vm_reset to go on from clean.`)
      // MC-1556: the lease's mode, checked again against the pool's (lowered meanwhile? then refused, nothing started).
      this.netAllowed(lease.network)
      const spec = await this.configureStartOrClean(vm, lease, lease.network, lease.reserve || 0)
      this.stillHeld(lease)
      const creds = this.creds()
      const waited = await this.waitGuest(vm, creds.admin, READY_WAIT_MS, lease)
      this.stillHeld(lease)
      if (waited === null) throw new Error(`${vm.vmName} was restored to "${name}" but its guest didn't answer within ${Math.round(READY_WAIT_MS / 1000)} s: vm_reset to go on from clean.`)
      const facts = await this.hv('facts-vm', this.ident(vm), this.forLease(lease))
      this.stillHeld(lease)
      if (facts.state !== 'Running' || facts.parentCheckpointId !== cp.checkpointId || (facts.switchId ?? null) !== (spec.switchId ?? null) || facts.reserve !== (lease.reserve || 0)) {
        // MC-1556 round 1: never left running on an unexpected network: restored to clean at once.
        lease.running = false
        const r = await this.restore(vm, null, lease)
        throw new Error(`${vm.vmName} restored to "${name}", but its state didn't read back as expected (${facts.state}, network ${facts.switchName ?? 'none'}, reserve ${facts.reserve}). ${r.ok ? 'It was restored to clean (network disconnected): vm_reset to go on.' : r.text}`)
      }
      lease.running = true // the sync record stays cleared and untrusted: only a full sync or a reset follows
      const netText = await this.guestNetOrClean(vm, lease, creds)
      return { text: `Restored ${vm.vmName} to its checkpoint "${name}" and started it (${((this.now() - t0) / 1000).toFixed(1)} s; guest ready after ${(waited / 1000).toFixed(1)} s); network ${netText}; CPU reserve ${lease.reserve || 0}%. ${this.isLinux(vm)
        // MC-1551: a Linux guest's words (no registry, no logon session; its build folder is /build).
        ? 'Files, installed software and configuration are as at the checkpoint; running programs aren\'t (the guest booted fresh).'
        : 'Files, installed software and the registry are as at the checkpoint; running programs and any logon session aren\'t (no one is logged on interactively: vm_start or vm_reset with interactive restores clean instead).'} ${this.paths(vm).build} is as the checkpoint left it but unconfirmed: run a full vm_sync before relying on it.`, data: { name, vm: vm.vmName } }
    })
  }

  async release(connId) {
    const lease = this.leaseOf(connId)
    lease.kept = false
    const r = await this.endLease(lease, 'released')
    return { text: r.ok ? `Released. ${r.text}` : r.text, isError: !r.ok }
  }

  // ---------- status ----------

  /** vm_status's lines on sharing: each project's use against its share, "other", and the queue in order. */
  shareLines() {
    this.dropExpired()
    const out = []
    if (this.policy.projects.length) {
      const per =this.policy.projects.map(p => {
        const oses = [...new Set([...Object.keys(p.maxVms || {}), ...[...this.leases.values()].filter(l => l.project === p.name).map(l => l.os)])]
        const parts = (oses.length ? oses : ['windows']).map(os => `${this.held(p.name, os)} ${os}${p.maxVms?.[os] !== undefined ? ` of its cap of ${p.maxVms[os]}` : ''}`)
        return `${p.name} holds ${parts.join(', ')}${p.images.length ? ` (images ${p.images.map(i => i.slice(0, 12)).join(', ')} only)` : ''}`
      })
      out.push(`Projects: ${per.join('; ')}; other holds ${this.held('other')}.`)
    }
    if (this.queue.length) {
      const now = this.now()
      out.push(`Waiting in line: ${this.queue.map((e, i) => `${i + 1}. ${e.project}${e.want && e.want.os !== 'windows' ? ` (${e.want.os})` : ''}${e.want?.vm ? ` (for ${e.want.vm})` : ''}, ${Math.round((now - e.since) / 1000)} s${e.pending ? '' : ' (between calls)'}${this.blocked(e.project, e.want) ? ` (${this.blocked(e.project, e.want)})` : ''}`).join('; ')}.`)
    }
    return out
  }

  status(connId) {
    const s = this.state
    const mine = connId && this.conns.get(connId)?.vmId
    const vms = [...s.vms.values()].map(v => {
      const l = this.leases.get(v.vmId)
      const state = s.quarantined.has(v.vmId) ? `QUARANTINED (${s.quarantined.get(v.vmId)})`
        : v.removing ? 'removing' : v.debugKept ? 'KEPT FOR DEBUG (a failed Linux build: running, disconnected, never leased; an administrator can inspect it in Hyper-V Manager; a resize plan with no image and vms equal to the number of other VMs in the pool removes only it; any other create or resize removes it too, along with the changes it asks for; a remove plan removes the whole pool)' : !v.ready ? 'creating'
          : l ? `leased${l.kept ? ', kept for inspection' : ''}${l.running ? ', running' : ''}${l.interactive ? `, ${l.interactive === 'user' ? 'the standard user' : 'the admin'} logged on interactively` : ''} until ${new Date(l.deadline).toISOString()} (session ends by ${new Date(l.sessionEnd).toISOString()})` : 'free'
      const img = this.imageOf(v)
      const failed = this.failedNote(v)
      // MC-1529: the caller's own lease checkpoints (only theirs), and checkpoints neither clean nor a lease's, left alone.
      const cps = l && v.vmId === mine ? this.leaseCheckpoints(l) : []
      const cpNote = cps.length ? `; your checkpoints: ${cps.map(x => `"${x.name}" (${x.checkpointId ? `taken ${x.at}` : 'unconfirmed'})`).join(', ')}` : ''
      // MC-1532: the VM's pool checkpoints, with their provenance (a shared name doesn't mean identical contents), and a
      // lease's start point.
      const pcs = [...s.poolSnaps.values()].filter(x => x.vmId === v.vmId)
      const pcNote = pcs.length ? `; pool checkpoints: ${pcs.map(x => `"${x.name}" (owner ${x.owner}, ${x.os}, image ${x.image === 'legacy' ? 'unknown' : String(x.image).slice(0, 12)}, taken ${x.at} from lease ${x.sourceLease}${x.retiring ? ', RETIRING: no longer offered' : ''})`).join(', ')}` : ''
      const fromNote = l?.startFrom ? `; starts from "${l.startFrom.name}"` : ''
      const unknown = this.unknownSnapshots.get(v.vmId)
      const unknownNote = unknown?.length ? `; unknown checkpoints left alone: ${unknown.join(', ')}` : ''
      const li = this.isLinux(v) ? s.images.get(img) : null
      const osLabel = li?.distro ? `linux (${li.name || `${li.distro} ${li.release}`}, build ${li.serial})` : this.osOf(v)
      return `- ${v.vmName}: ${osLabel}, image ${img === 'legacy' ? 'unknown (made before images were recorded)' : img.slice(0, 12)}; ${v.cores} cores, ${v.memoryMB} MB, ${v.diskGB} GB disk; ${state}${v.vmId === mine ? ' (yours)' : ''}${expiry(v, this.now())}${failed ? `; ${failed}` : ''}${fromNote}${pcNote}${cpNote}${unknownNote}`
    })
    const img = [...s.images.values()].at(-1)
    const lines = [
      `Pool: ${vms.length ? `${vms.length} VM(s)` : 'no VMs'}; network ${s.network} (approved in a plan: ${net.DESCRIBE[s.network]})${s.switch ? `; old pool switch ${s.switch.name} (${s.switch.phase}, unused by runs)` : ''}; image: ${img ? (img.os === 'linux' ? linuxImages.describe(img) : `${img.edition} ${img.build} (${img.sha256.slice(0, 12)}…, ${img.pinned ? 'pinned' : img.source})`) : 'none'}.`,
      ...vms,
      ...this.shareLines(),
      this.job ? `Pool job in progress: ${this.job.op} (${this.job.jobId}): ${this.job.progress}` : this.lastJob ? `Last pool job: ${this.lastJob.op} ${this.lastJob.ok ? 'finished' : 'FAILED'}: ${this.lastJob.note}` : null,
      this.imageJob ? `Image: ${this.imageJob.progress}` : this.lastImage ? `Image: ${this.lastImage}` : null,
      this.quiesced ? `Quiesced for uninstall: no new leases${this.quiesced.allowRemove ? '; only an approved remove of the pool' : '; no pool changes'}.` : null,
      this.recovery?.length ? `At start-up: ${this.recovery.join(' ')}` : null,
      ...[...s.intents.values()].filter(i => !i.done && i.online && !i.offline).map(i => `WARNING: ${i.vmName} may still be online (its build's activation step didn't finish): it is being removed, retried every few minutes.`),
      `Product key for non-evaluation images (install.ps1 -ProductKeyFile): ${this.productKey() ? 'set' : 'none'}.`,
      `Policy: up to ${this.policy.maxVms} VMs, ${this.policy.maxCoresPerVm} cores each, ${this.policy.maxMemoryMBTotal} MB in all, ${this.policy.maxDiskGBPerVm} GB disks, in ${this.policy.diskFolders.join('; ')}; network up to ${this.policy.maxNetwork}${this.policy.hostNetwork ? ` (host mode: ${this.policy.hostNetwork.switchName}, this PC ${this.policy.hostNetwork.hostAddress} on ${this.policy.hostNetwork.subnet})` : ''}; CPU reserve up to ${this.policy.maxReservePercent}%; leases up to ${this.policy.maxLeaseMinutes} min at a time, renewable to ${policyMod.sessionMinutes(this.policy)} min per work session${this.policy.maxSessionMinutes === undefined ? ' (the default)' : ''}.`,
      `Build folders set by an admin (install.ps1 -BuildRoot): ${this.policy.buildRoots.length ? this.policy.buildRoots.join('; ') : 'none'}.`,
      'vm_acquire\'s vm names one VM: for trials and censuses on a specific VM, not for normal use (it waits in line like any other request, for that VM only).'
    ]
    return { text: lines.filter(Boolean).join('\n'), data: { vms: s.vms.size, job: this.job ? this.job.op : null, epoch: this.journal.epoch, connections: this.conns.size, lastJob: this.lastJob } }
  }

  // ---------- pool plans ----------

  /** pool_plan: read-only apart from writing the plan record (and starting an image check if one is needed). */
  async plan(args = {}) {
    const op = args.action ?? 'create'
    if (op === 'checkpoint' || op === 'checkpoint-remove') return this.planCheckpoint(args)
    if (op === 'refresh-clean') return this.planRefresh(args)
    if (!['create', 'resize', 'remove'].includes(op)) throw new Error('action must be create, resize, remove, checkpoint, checkpoint-remove or refresh-clean')
    const s = this.state
    const all = [...s.vms.values()]
    // MC-1545: a failed Linux build kept for debugging is in no group and counts toward nothing: every create or resize
    // removes it (the next build replaces it), as a remove does.
    const kept = all.filter(v => v.debugKept)
    const pool = all.filter(v => !v.debugKept)
    const facts = await this.hv('facts', { folders: this.policy.diskFolders })
    if (!facts.hyperv) throw new Error('Hyper-V is not available on this host (its service or PowerShell module is missing).')
    const plan = { id: `p-${hex(8)}`, op, epoch: this.journal.epoch, created: this.now(), expires: this.now() + PLAN_TTL_MS, prefix: this.policy.prefix, host: { logicalCpus: facts.logicalCpus, memoryMB: facts.memoryMB } }
    if (op === 'remove') {
      if (!all.length && !s.switch) throw new Error('There is no pool to remove.')
      plan.remove = all.map(v => ({ vmId: v.vmId, name: v.vmName, folder: v.folder }))
      plan.removeSwitch = s.switch ? s.switch.name : null
    } else {
      if (op === 'create' && pool.length) throw new Error(`The pool already has ${pool.length} VM(s): use action "resize" (or "remove" first).`)
      if (op === 'resize' && !pool.length) throw new Error('There is no pool yet: use action "create".')
      // An image named by its SHA-256 (a verified one): create from it, or resize that image's group only. A resize with
      // no image is the whole pool, as before; legacy VMs (image unknown) are in no image's group.
      const groupImg = typeof args.image === 'string' ? this.verifiedImage(args.image) : null
      const group = groupImg && op === 'resize' ? pool.filter(v => this.imageOf(v) === groupImg.sha256) : pool
      const others = pool.filter(v => !group.includes(v))
      const like = group.find(v => v.ready) || pool.find(v => v.ready)
      const n = args.vms ?? (op === 'create' ? Math.min(2, this.policy.maxVms) : group.length)
      if (!Number.isInteger(n) || n < (op === 'create' ? 1 : 0) || n > this.policy.maxVms) throw new Error(`vms must be ${op === 'create' ? 1 : 0}-${this.policy.maxVms}`)
      const cores = args.cores ?? like?.cores ?? Math.max(1, Math.min(this.policy.maxCoresPerVm, Math.floor(facts.logicalCpus / 4)))
      const memoryMB = args.memoryGB !== undefined ? Math.round(args.memoryGB * 1024) : like?.memoryMB ?? Math.min(8192, Math.floor(this.policy.maxMemoryMBTotal / Math.max(1, n) / 2) * 2)
      const diskGB = args.diskGB ?? like?.diskGB ?? Math.max(64, Math.min(this.policy.maxDiskGBPerVm, 64))
      const folders = facts.folders || []
      const location = args.location ?? like?.folder?.replace(/\\pool\\i-[0-9a-f]{16}$/i, '') ?? folders.slice().sort((a, b) => b.freeGB - a.freeGB)[0]?.folder ?? this.policy.diskFolders[0]
      if (!this.policy.diskFolders.some(d => d.toLowerCase() === win32.normalize(location).replace(/\\+$/, '').toLowerCase())) throw new Error(`location must be one of the policy's disk folders: ${this.policy.diskFolders.join('; ')}`)
      // MC-1556: the pool's network mode, the user's choice in this plan like cores, memory and disk: none unless the
      // plan says, a resize keeping the pool's current mode unless it says otherwise.
      const network = net.modeOf(args.network, op === 'create' ? 'none' : s.network)
      const keep = group.slice(0, Math.min(group.length, n))
      const add = Math.max(0, n - group.length)
      plan.add = Array.from({ length: add }, () => {
        const intentId = `i-${hex(8)}`
        return { intentId, name: `${this.policy.prefix}-${hex(4)}`, folder: `${location}\\pool\\${intentId}`, cores, memoryMB, diskGB }
      })
      plan.remove = [...kept, ...group.slice(n)].map(v => ({ vmId: v.vmId, name: v.vmName, folder: v.folder }))
      plan.network = network
      if (op === 'resize') plan.networkWas = s.network
      plan.keep = [...others, ...keep].filter(v => v.ready).map(v => ({ name: v.vmName, cores: v.cores, memoryMB: v.memoryMB, diskGB: v.diskGB }))
      const bad = policyMod.checkPool(this.policy, [...others, ...keep, ...plan.add], { network })
      if (bad.length) throw new Error(`That plan is outside the policy: ${bad.join('; ')}.`)
      if (net.defaultSwitch(network) && !facts.defaultSwitch) throw new Error(`This host has no Default Switch, so the network mode ${network} can't be used here.`)
      if (cores * 2 > facts.logicalCpus) throw new Error(`${cores} cores per VM is more than half this host's ${facts.logicalCpus} logical CPUs.`)
      const free = folders.find(f => f.folder.toLowerCase() === location.toLowerCase())?.freeGB ?? 0
      const need = plan.add.length * 40 + (plan.add.length ? 10 : 0)
      if (plan.add.length && free < need) throw new Error(`${location} has ${free} GB free; ${plan.add.length} new VM(s) need about ${need} GB (installed Windows plus checkpoints and the image).`)
      if (plan.add.length && groupImg) plan.image = pick(groupImg)
      else if (plan.add.length) {
        const img = await this.planImage(args.image, location)
        if (!img.ready) return { text: img.text }
        plan.image = img.image
      }
      if (plan.add.length) {
        // The build's one online step, bound here (MC-1513): an evaluation image always (it lasts about a day
        // unactivated); an own copy only when asked. Nothing else ever connects the Default Switch.
        const evaluation = plan.image.evaluation
        if (plan.image.os === 'linux' && args.activate !== undefined) throw new Error('activate is for Windows images: a Linux VM is built offline, with no licence to activate.')
        if (evaluation && args.activate === false) throw new Error('An evaluation image must be activated online once when each VM is built (unactivated, it stops allowing interactive logons after about a day): leave activate out.')
        const online = evaluation || args.activate === true
        if (online && !facts.defaultSwitch) throw new Error(`This host has no Default Switch, so Windows can't be activated online when a VM is built${evaluation ? ' (an evaluation image needs that)' : ''}.`)
        plan.activation = online ? 'online-once' : 'none'
        plan.productKey = plan.image.os !== 'linux' && !evaluation && !!this.productKey()
      }
      // MC-1545 (the user's decision, debug only, off by default): a Linux build that fails keeps its VM, turned on,
      // disconnected and never leased, for an administrator to inspect in Hyper-V Manager. The plan says so.
      if (args.debugKeepFailedBuild !== undefined) {
        if (args.debugKeepFailedBuild !== true) throw new Error('debugKeepFailedBuild must be true, or left out.')
        if (!plan.add.length || plan.image?.os !== 'linux') throw new Error('debugKeepFailedBuild is only for a plan that builds Linux VMs.')
        plan.debugKeepFailedBuild = true
      }
      if (!plan.add.length && !plan.remove.length && network === s.network) throw new Error(`The pool already has ${pool.length} VM(s) and network ${network}: nothing to change.`)
    }
    const bytes = Buffer.from(canonical(plan), 'utf8')
    const file = join(this.dir, 'plans', `${plan.id}.json`)
    fs.writeFileSync(file, bytes, { flag: 'wx' })
    const digest = sha256(bytes)
    return { text: describePlan(plan, digest, this.approveLine(plan.id)), data: { planId: plan.id, digest } }
  }

  /**
   * MC-1532: a pool-checkpoint plan. Publish (or replace, replace: true) a named checkpoint of each listed VM's current
   * state: each must be leased now by a live lease of the caller's project, which owns it. Remove (checkpoint-remove):
   * each VM's published checkpoint of the name, owned by the caller's project. Bound to the exact VM ids, lease ids,
   * owner, images and (replace, remove) the checkpoint ids; checked against the cap and the disk floor.
   */
  async planCheckpoint(args) {
    const mode = args.action === 'checkpoint-remove' ? 'remove' : args.replace === true ? 'replace' : 'publish'
    const name = args.name
    if (typeof name !== 'string' || !POOL_CHECKPOINT_RE.test(name) || name.toLowerCase() === 'clean') throw new Error('name must be 1-40 letters, digits, spaces, dots, dashes, pluses or underscores, starting with a letter or digit, and not "clean".')
    const list = Array.isArray(args.targets) ? args.targets : Array.isArray(args.vms) ? args.vms : []
    const names = [...new Set(list)]
    if (!names.length || names.length > 16 || names.some(n => typeof n !== 'string')) throw new Error('targets must list 1-16 VM names (vm_status lists them).')
    const project = this.projectOf(args.roots)
    const s = this.state
    const cap = this.policy.maxCheckpointsPerVm ?? 4
    const floor = this.policy.minFreeGBForCheckpoint ?? 20
    const facts = mode === 'remove' ? null : await this.hv('facts', { folders: this.policy.diskFolders })
    const entries = []
    for (const n of names) {
      const vm = [...s.vms.values()].find(v => v.vmName === n)
      if (!vm || !vm.ready) throw new Error(`No ready VM named ${n} in the pool.`)
      const mine = [...s.poolSnaps.values()].filter(x => x.vmId === vm.vmId)
      const same = mine.find(x => !x.retiring && x.name.toLowerCase() === name.toLowerCase())
      const e = { vmId: vm.vmId, name: vm.vmName, image: this.imageOf(vm), os: this.osOf(vm) }
      if (mode === 'remove') {
        if (!same) throw new Error(`${n} has no pool checkpoint "${name}".`)
        if (same.owner !== project) throw new Error(`"${name}" on ${n} belongs to project ${same.owner}: only its owner removes it.`)
        entries.push({ ...e, checkpointId: same.checkpointId, owner: same.owner })
        continue
      }
      const lease = this.leases.get(vm.vmId)
      if (!lease || lease.ending) throw new Error(`${n} isn't leased: a pool checkpoint is taken of the state a lease prepared on it.`)
      if (lease.project !== project) throw new Error(`${n} is leased by project ${lease.project}, not yours (${project}).`)
      if (mode === 'publish' && mine.some(x => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`${n} already has a pool checkpoint "${name}"${mine.find(x => x.name.toLowerCase() === name.toLowerCase()).retiring ? ' (retiring)' : ''}: use replace: true to replace it.`)
      if (mode === 'replace') {
        if (!same) throw new Error(`${n} has no pool checkpoint "${name}" to replace.`)
        if (same.owner !== project) throw new Error(`"${name}" on ${n} belongs to project ${same.owner}: only its owner replaces it.`)
      }
      const pending = [...s.leaseSnaps.values()].filter(x => x.vmId === vm.vmId && x.snapName.startsWith('hvmcp-pool-')).length
      if (mine.length + pending + 1 > cap) throw new Error(`${n} would hold more than the policy's maxCheckpointsPerVm (${cap}) pool checkpoints (${mine.length} now, retiring included${pending ? `, ${pending} being taken` : ''}).`)
      const folder = (facts.folders || []).find(x => vm.folder.toLowerCase().startsWith(x.folder.toLowerCase()))
      if (!folder || folder.freeGB < floor) throw new Error(`${n}'s drive has ${folder?.freeGB ?? 'unknown'} GB free, under the ${floor} GB a checkpoint must leave.`)
      entries.push({ ...e, leaseId: lease.leaseId, owner: project, ...(same ? { replaces: same.checkpointId } : {}) })
    }
    const plan = { id: `p-${hex(8)}`, op: 'checkpoint', mode, checkpoint: name, epoch: this.journal.epoch, created: this.now(), expires: this.now() + PLAN_TTL_MS, prefix: this.policy.prefix, vms: entries }
    const bytes = Buffer.from(canonical(plan), 'utf8')
    fs.writeFileSync(join(this.dir, 'plans', `${plan.id}.json`), bytes, { flag: 'wx' })
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
    // MC-1501: a Linux image: { distro, release? } or { pin }, downloaded, or { file }, a local copy of a pinned one.
    const linux = typeof want === 'object' && want !== null && (want.distro !== undefined || want.pin !== undefined || want.file !== undefined)
    if (linux && want.file === undefined) {
      const pin = linuxImages.pinFor(want)
      const ready = have.find(i => i.pin === pin.id)
      if (ready) return { ready: true, image: pick(ready) }
    }
    const job = { progress: 'starting' }
    this.imageJob = job
    const p = linux
      ? linuxImages.prepare({ want, dir: join(location, 'images'), hv: this.hv, known: s.images, ownDirs: [this.dir], progress: t => { job.progress = t }, maxVirtualBytes: this.policy.maxDiskGBPerVm * 1024 ** 3 })
      : images.prepare({
      want, dir: join(location, 'images'), hv: this.hv, policy: this.policy, known: s.images, ownDirs: [this.dir],
      progress: t => { job.progress = t }
    })
    p.then(img => {
      const what = img.os === 'linux' ? linuxImages.describe(img) : `${img.edition} ${img.build} (${img.sha256.slice(0, 12)}…${img.existing ? '' : `, ${img.pinned ? 'pinned' : img.source}`})`
      if (img.existing) { this.lastImage = `ready: ${what}`; return }
      this.journal.append({ t: 'image', ...img })
      this.lastImage = `verified: ${what}`
    }, e => { this.lastImage = `REFUSED: ${e.message}` }).finally(() => { this.imageJob = null })
    return { ready: false, text: linux ? 'Checking the Linux image now (downloaded or copied while hashed, its pin and the distro\'s published checksums checked, then converted to the base VHDX with nothing installed on the host). This takes a few minutes: call pool_status, then pool_plan again with the same image to use it.' : 'Checking the image now (copied into the helper\'s folder while hashed, then its files and signatures checked before anything runs). This takes a few minutes for a 7 GB ISO: call pool_status, then pool_plan again with no image to use it.' }
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
      // MC-1556: the mode the plan approves (an older plan's: the pool's current one), against the policy as it is now,
      // for every create and resize: a network-only or removal-only one too. Checked alone here, so a lowered VM limit
      // never blocks a resize that shrinks the pool.
      const network = op === 'create' || op === 'resize' ? net.modeOf(plan.network, s.network) : 'none'
      const netBad = policyMod.checkPool(this.policy, [], { network })
      if (netBad.length) throw new Error(`Plan ${planId} is outside the policy now: ${netBad.join('; ')}. Nothing was changed: make a new plan.`)
      if (plan.add?.length) {
        const after = [...s.vms.values()].filter(v => !(plan.remove || []).some(r => r.vmId === v.vmId))
        const bad = policyMod.checkPool(this.policy, [...after, ...plan.add], { network })
        if (bad.length) throw new Error(`Plan ${planId} is outside the policy now: ${bad.join('; ')}.`)
        // MC-1545: a create's pool must be empty after its approved removals (a kept failed build it replaces goes first);
        // any other VM, a real one or one kept after the plan was made, refuses it.
        if (op === 'create' && after.length) throw new Error('The pool is no longer empty: make a new plan.')
        const rec = s.images.get(plan.image?.sha256)
        if (!rec) throw new Error('The plan\'s image is no longer verified: make a new plan.')
        if (rec.os !== 'linux' && (rec.edition !== plan.image.edition || (rec.imageIndex ?? 1) !== (plan.image.imageIndex ?? 1))) throw new Error('The plan\'s image edition no longer matches its record: make a new plan.')
        if (isEval(plan.image) && plan.activation !== 'online-once') throw new Error(`Plan ${planId} doesn't activate its evaluation image (it was made before activation was planned): make a new plan.`)
        if (plan.productKey && !this.productKey()) throw new Error(`Plan ${planId} uses the pool's product key, but setup holds none now: make a new plan.`)
      }
      const jobId = `j-${hex(6)}`
      this.journal.append({ t: 'job', jobId, op, planId, nonce })
      for (const r of plan.remove || []) this.journal.append({ t: 'removing', jobId, vmId: r.vmId })
      const job = { jobId, op, progress: 'started' }
      this.job = job
      job.promise = this.runJob(job, plan).then(
        note => { this.journal.append({ t: 'jobEnd', jobId, ok: true, note }); this.lastJob = { op, ok: true, note } },
        e => { this.journal.append({ t: 'jobEnd', jobId, ok: false, note: e.message }); this.lastJob = { op, ok: false, note: e.message } }
      ).finally(() => { this.job = null; this.kick() })
      return { text: `Approved plan ${planId} accepted: pool job ${jobId} (${op}) is running. ${op === 'remove' || (op !== 'refresh' && !(plan.add || []).length) ? '' : op === 'refresh' ? "Each VM's guest steps are rerun offline: about 20-40 minutes each, one at a time. " : plan.image?.os === 'linux' ? 'Creating a Linux VM copies its verified image and first boots it offline from its cloud-init seed: a few minutes each, one at a time. ' : 'Creating a VM installs Windows unattended: about 20-40 minutes each, one at a time. '}Follow it with pool_status.`, data: { jobId } }
    })
  }

  /**
   * MC-1532: pool_checkpoint. Carries out an approved pool-checkpoint plan, VM by VM (each commits on its own; the reply
   * lists each one's outcome). The approval's nonce is used up whatever happens.
   */
  async poolCheckpoint(connId, { planId } = {}) {
    if (typeof planId !== 'string' || !PLAN_ID_RE.test(planId)) throw new Error('planId must be a plan id from pool_plan (p- and 16 hex digits)')
    // The approval, checked and used up under the pool lock (briefly): never held across Hyper-V work.
    const plan = await this.poolLock(async () => {
      if (this.quiesced) throw new Error('The helper is being uninstalled: no pool changes.')
      let bytes
      try { bytes = fs.readFileSync(join(this.dir, 'plans', `${planId}.json`)) } catch { throw new Error(`No plan ${planId}.`) }
      const p = JSON.parse(bytes.toString('utf8'))
      if (p.op !== 'checkpoint') throw new Error(`Plan ${planId} is a ${p.op} plan, not a pool-checkpoint plan.`)
      if (p.epoch !== this.journal.epoch) throw new Error(`Plan ${planId} belongs to an earlier pool state: make a new plan.`)
      if (this.now() > p.expires) throw new Error(`Plan ${planId} has expired: make a new plan (pool_plan) and approve it.`)
      const nonce = await this.checkApproval(p, sha256(bytes))
      const jobId = `j-${hex(6)}`
      this.journal.append({ t: 'job', jobId, op: 'checkpoint', planId, nonce })
      this.journal.append({ t: 'jobEnd', jobId, ok: true, note: `pool checkpoint "${p.checkpoint}" (${p.mode}): carried out VM by VM` })
      return p
    })
    const out = []
    for (const e of plan.vms) {
      let r
      try { r = plan.mode === 'remove' ? await this.pcpRemove(plan, e) : await this.pcpPublish(plan, e) } catch (err) { r = `FAILED: ${err.message}` }
      out.push(`- ${e.name}: ${r}`)
    }
    this.kick()
    return { text: `Pool checkpoint "${plan.checkpoint}" (${plan.mode}), plan ${planId}:\n${out.join('\n')}`, isError: out.some(l => l.includes(': FAILED: ')) }
  }

  /**
   * MC-1532: publishes (or replaces) one VM's pool checkpoint from its bound lease's state: the build's verified undo,
   * network disconnected and read back, a clean guest shutdown, a checkpoint of the Off VM (an lcp-take of the lease,
   * so unpublished it's removed with the lease), verified, then pcp-select: published, with the replaced one retiring.
   * Hyper-V work runs under the VM's lock only; the bound lease is checked after every await and just before publishing.
   */
  async pcpPublish(plan, e) {
    const vm = this.state.vms.get(e.vmId)
    // The binding, re-read from the journal's current state at every boundary (state() is rebuilt each time): the
    // lease, and the name's target on this VM: a publish finds none of that name (retiring ones included); a replace
    // finds exactly the planned one, still selected.
    const bound = () => {
      const st = this.state
      const v = st.vms.get(e.vmId)
      const l = this.leases.get(e.vmId)
      if (!v || v.vmName !== e.name || !l || l.leaseId !== e.leaseId || l.ending || l.project !== e.owner || this.imageOf(v) !== e.image) throw new Error('the lease the plan was made from has ended or changed: nothing was published (make a new plan)')
      if (this.refreshing.has(e.vmId) || this.refreshOf(e.vmId)) throw new Error('its clean checkpoint is being refreshed: nothing was published (plan again when that has finished)')
      const same = [...st.poolSnaps.values()].filter(x => x.vmId === e.vmId && x.name.toLowerCase() === plan.checkpoint.toLowerCase())
      if (!e.replaces && same.length) throw new Error(`it already has a pool checkpoint "${plan.checkpoint}"${same.every(x => x.retiring) ? ' (retiring)' : ''}: nothing was published (replace it with a new plan, replace: true)`)
      if (e.replaces) { const live = same.filter(x => !x.retiring); if (live.length !== 1 || live[0].checkpointId !== e.replaces || live[0].owner !== e.owner) throw new Error('the checkpoint to replace has changed: nothing was published (make a new plan)') }
      return l
    }
    let lease = bound()
    if (this.pcpBusy.has(e.vmId)) throw new Error('another pool-checkpoint operation is running on it')
    const cap = this.policy.maxCheckpointsPerVm ?? 4
    const held = [...this.state.poolSnaps.values()].filter(x => x.vmId === e.vmId).length + [...this.state.leaseSnaps.values()].filter(x => x.vmId === e.vmId && x.snapName.startsWith('hvmcp-pool-')).length
    if (held + 1 > cap) throw new Error(`it would hold more than maxCheckpointsPerVm (${cap}) pool checkpoints`)
    this.pcpBusy.add(e.vmId)
    try {
      return await this.vmLock(e.vmId)(async () => {
        lease = bound()
        const opts = () => this.forLease(lease)
        const creds = this.creds()
        let stage = 'disk'
        try {
          // 0. The disk floor, now (the plan's reading may be 30 minutes old): nothing has changed yet.
          const floor = this.policy.minFreeGBForCheckpoint ?? 20
          const df = await this.hv('facts', { folders: [vm.folder] }, opts())
          lease = bound()
          const free = df.folders?.[0]?.freeGB
          if (!Number.isFinite(free) || free < floor) throw new Error(`the VM folder's drive has ${free ?? 'unknown'} GB free, under the ${floor} GB a checkpoint must leave`)
          // 1. The logon undone and verified (no autologon, no LSA secret, UAC on, Userinit, C:\hvmcp empty and plain).
          // From here no interactive run may start: the undo removes the watcher's start and files, verified or not.
          stage = 'undo'
          lease.interactive = null
          if (!this.isLinux(vm)) await this.undoLogon(vm, creds, opts()) // MC-1501: a Linux guest has no logon to undo
          lease = bound()
          // 2. The network disconnected, read back. Assumed off from the attempt on, whatever the call's outcome.
          stage = 'network'
          // MC-1556: a Windows guest's own network settings back to DHCP first (a static address would be kept in the
          // checkpoint), then the adapter disconnected and its port ACLs removed, both read back.
          if (!this.isLinux(vm) && lease.network !== 'none') await this.guestCall(vm, 'guest-net', { ...this.ident(vm), cred: creds.admin, mode: 'none' }, opts())
          lease = bound()
          lease.network = 'none'
          lease.net = null
          const f1 = await this.hv('net-disconnect', this.ident(vm), opts())
          lease = bound()
          if (f1.switchName) throw new Error(`its network adapter is still connected to ${f1.switchName}`)
          if (f1.acls?.length) throw new Error('its network adapter still has port ACLs')
          // 3. A clean guest shutdown, verified Off.
          stage = 'shutdown'
          const f2 = await this.hv('guest-shutdown', this.ident(vm), this.forLease(lease, 6 * 60_000))
          lease = bound()
          if (f2.state !== 'Off') throw new Error(`the guest didn't shut down (the VM is ${f2.state})`)
          lease.running = false
          // 4. The checkpoint of the Off VM, journalled as the lease's until it's published.
          stage = 'take'
          const opId = hex(6)
          const snapName = `hvmcp-pool-${opId}`
          this.journal.append({ t: 'lcp-take', opId, vmId: vm.vmId, leaseId: lease.leaseId, name: `pool:${plan.checkpoint}`, snapName, at: new Date(this.now()).toISOString() })
          let r
          try { r = await this.hv('pool-take', { ...this.ident(vm), snapName }, this.forLease(lease, 10 * 60_000)) } catch (err) {
            const list = await this.hv('snapshots', this.ident(vm)).then(x => x.snapshots || [], () => null)
            const found = list ? list.filter(x => x.name === snapName) : []
            if (found.length === 1) this.journal.append({ t: 'lcp-taken', opId, checkpointId: found[0].id })
            throw err
          }
          if (r.failed) {
            const list = await this.hv('snapshots', this.ident(vm)).then(x => x.snapshots || [], () => null)
            const found = list ? list.filter(x => x.name === snapName) : null
            if (found?.length === 1) this.journal.append({ t: 'lcp-taken', opId, checkpointId: found[0].id })
            else if (found?.length === 0) this.journal.append({ t: 'lcp-dropped', opId })
            throw new Error(`Hyper-V couldn't take the checkpoint (${r.error})`)
          }
          this.journal.append({ t: 'lcp-taken', opId, checkpointId: r.checkpointId })
          // 5. Verified: Off, at the new checkpoint.
          stage = 'verify'
          const f3 = await this.hv('facts-vm', this.ident(vm), opts())
          if (f3.state !== 'Off' || f3.parentCheckpointId !== r.checkpointId) throw new Error(`the new checkpoint didn't verify (the VM is ${f3.state}, at ${f3.parentCheckpointId})`)
          // 6. Published: checked and journalled with no await between, so no acquire decision sees a half state.
          lease = bound()
          this.journal.append({ t: 'pcp-select', opId, name: plan.checkpoint, vmId: vm.vmId, checkpointId: r.checkpointId, snapName, owner: e.owner, image: e.image, os: e.os, at: new Date(this.now()).toISOString(), sourceLease: lease.leaseId, ...(e.replaces ? { replaces: e.replaces } : {}) })
          lease.startFrom = { name: plan.checkpoint, checkpointId: r.checkpointId }
          lease.refs.add(r.checkpointId)
          Object.assign(lease.sync, { gen: lease.sync.gen + 1, plan: null, trusted: false })
          return `published "${plan.checkpoint}" (${r.checkpointId}); the VM is Off at it, and this lease now starts from it (vm_start)${e.replaces ? '; the old one is no longer offered and is removed when this lease ends' : ''}.`
        } catch (err) {
          // Nothing was published. Say what changed, and get the prepared state running again if it's safely Off.
          const done = { disk: 'nothing changed', undo: 'its logon may be partly undone (no interactive session from now; vm_start or vm_reset with interactive logs on again)', network: 'its logon was undone (no interactive session) and its network may be disconnected (taken as off)', shutdown: 'its logon was undone and its network disconnected', take: 'its logon was undone, its network disconnected and it was shut down', verify: 'it was shut down and checkpointed, but that checkpoint is unpublished (removed with this lease)' }[stage]
          if (this.leases.get(e.vmId)?.leaseId !== e.leaseId || this.leases.get(e.vmId)?.ending) throw new Error(`${err.message}; the lease ended meanwhile, so nothing was published (its release cleans up)`)
          let state = null
          try { state = (await this.hv('facts-vm', this.ident(vm), this.forLease(lease))).state } catch { state = null }
          if (state === 'Off' && stage !== 'undo' && stage !== 'disk') {
            let again = null
            try {
              await this.configureStart(vm, lease, 'none', lease.reserve || 0)
              const waited = await this.waitGuest(vm, creds.admin, READY_WAIT_MS, lease)
              if (waited === null) throw new Error('its guest didn\'t answer')
            } catch (e2) { again = e2 }
            if (again) {
              // Read again: the start may have succeeded with the guest not answering. No runs until it's verified.
              lease.running = false
              let now = null
              try { now = (await this.hv('facts-vm', this.ident(vm), this.forLease(lease))).state } catch { now = null }
              const where = now === 'Off' ? 'the VM is Off, and vm_start would restore its start point and lose what you prepared (take a lease checkpoint, vm_checkpoint, before pool_checkpoint next time)' : `the VM is ${now ?? 'in an unknown state'}; no runs until vm_start or vm_reset (which restore its start point)`
              throw new Error(`${err.message}. Nothing was published; ${done}. Starting it again failed (${again.message}): ${where}.`)
            }
            lease.running = true
            lease.sync.trusted = false
            throw new Error(`${err.message}. Nothing was published; ${done}. The VM was started again from its current disk (no restore), so what you prepared is still there (no logon session, network off; C:\\build unconfirmed until a full vm_sync).`)
          }
          if (state === 'Running') { lease.running = true; throw new Error(`${err.message}. Nothing was published; ${done}. The VM is still running with what you prepared.`) }
          lease.running = false
          throw new Error(`${err.message}. Nothing was published; ${done}. Its state is ${state ?? 'unknown'}: no further runs until vm_start or vm_reset (which restore its start point).`)
        }
      })
    } finally { this.pcpBusy.delete(e.vmId) }
  }

  /**
   * MC-1532: retires one VM's pool checkpoint by plan: no new consumers from now (pcp-retire, journalled with no await
   * after the checks). If the VM is free, it's removed now (child-first, identity-checked); otherwise when it's next
   * restored with no lease (the lease using it keeps it until it ends).
   */
  async pcpRemove(plan, e) {
    const s = this.state
    const vm = s.vms.get(e.vmId)
    const p = s.poolSnaps.get(e.checkpointId)
    if (!vm || !p || p.vmId !== e.vmId || p.retiring || p.owner !== e.owner || p.name.toLowerCase() !== plan.checkpoint.toLowerCase()) throw new Error('the checkpoint has changed or is already retiring: nothing was done (make a new plan)')
    this.journal.append({ t: 'pcp-retire', vmId: e.vmId, checkpointId: e.checkpointId })
    if (this.leases.has(e.vmId)) return `retired: no longer offered; the lease holding ${vm.vmName} keeps it until it ends, then it's removed.`
    if (this.pcpBusy.has(e.vmId) || this.refreshing.has(e.vmId)) return 'retired: no longer offered; it is removed at the VM\'s next restore.'
    this.pcpBusy.add(e.vmId)
    try {
      const r = await this.vmLock(e.vmId)(() => this.restore(vm))
      return r.ok ? 'retired and removed.' : `retired (no longer offered), but removal is pending: ${r.text}`
    } finally { this.pcpBusy.delete(e.vmId) }
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
    // MC-1556: the pool's network mode, as the approved plan says (a removed pool's is none again). Runs already
    // going keep theirs until their next start, reset or restore, which checks the new mode.
    const mode = plan.op === 'remove' ? 'none' : plan.network
    if (mode && mode !== this.state.network) { this.journal.append({ t: 'pool-network', jobId: job.jobId, mode }); done.push(`network ${mode}`) }
    if (plan.op === 'remove' && plan.removeSwitch) {
      job.progress = `removing the switch ${plan.removeSwitch}`
      const sw = this.state.switch
      this.journal.append({ t: 'switch', jobId: job.jobId, name: sw.name, phase: 'removing', switchId: sw.switchId })
      await this.hv('remove-switch', { name: sw.name, switchId: sw.switchId, token: sw.token })
      this.journal.append({ t: 'switch', jobId: job.jobId, name: sw.name, phase: 'removed' })
      done.push(`removed the switch ${sw.name}`)
    }
    // MC-1531: refreshes, VM by VM, each committing on its own.
    for (const [k, e] of (plan.refresh || []).entries()) {
      done.push(await this.refreshOne(job, e, `VM ${k + 1} of ${plan.refresh.length} (${e.name})`))
    }
    if (plan.add?.length) this.ensureCreds()
    for (const [k, a] of (plan.add || []).entries()) {
      const label = `VM ${k + 1} of ${plan.add.length} (${a.name})`
      try {
        const note = await this.createVm(job, plan, a, label)
        done.push(`created ${a.name}${note ? ` (${note})` : ''}`)
      } catch (e) {
        job.progress = `${label} failed (${e.message}); rolling it back`
        const intent = this.state.intents.get(a.intentId)
        // MC-1545: a Linux build whose plan keeps a failure for debugging keeps its VM as it is (on, disconnected, never
        // leased); its intent is settled by that record, so no start rolls it back.
        if (plan.debugKeepFailedBuild && intent && !intent.done && intent.vmId && this.state.vms.has(intent.vmId)) {
          // MC-1545 (round 2): the approved debug state is made and read back, never assumed: started if it isn't
          // running (a failure before the first start, or after the shutdown), its network disconnected, then its facts.
          // Only a VM confirmed running and disconnected is kept; otherwise it's rolled back as usual, saying why.
          const vm = this.state.vms.get(intent.vmId)
          const state = await (async () => {
            let f = await this.hv('facts-vm', this.ident(vm))
            if (f.state !== 'Running') { await this.hv('start-vm', { ...this.ident(vm), noKeys: true }); f = await this.hv('facts-vm', this.ident(vm)) }
            const d = await this.hv('net-disconnect', this.ident(vm))
            return { state: d.state ?? f.state, switchName: d.switchName ?? null }
          })().catch(err => ({ error: err.message }))
          if (state.state === 'Running' && !state.switchName) {
            this.journal.append({ t: 'debugKept', intentId: a.intentId, vmId: intent.vmId, why: String(e.message).slice(0, 2000), state: 'Running, disconnected' })
            throw new Error(`${label}: ${e.message} KEPT FOR DEBUG: ${a.name} is running and disconnected (read back), never leased, for an administrator to inspect in Hyper-V Manager; a resize plan with no image and vms equal to the number of other VMs in the pool removes only it; any other create or resize removes it too, along with the changes it asks for; a remove plan removes the whole pool.${done.length ? ` (done before it: ${done.join(', ')})` : ''}`)
          }
          done.push(`it couldn't be kept for debugging (${state.error ? state.error : `it read back ${state.state}${state.switchName ? `, connected to ${state.switchName}` : ''}`}), so it's rolled back`)
        }
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
    this.journal.append({ t: 'intent', jobId: job.jobId, intentId: a.intentId, vmName: a.name, folder: a.folder, cores: a.cores, memoryMB: a.memoryMB, diskGB: a.diskGB, image: plan.image?.sha256 })
    if (!policyMod.underDiskFolder(this.policy, a.folder)) throw new Error('its folder is outside the policy')
    fs.mkdirSync(a.folder, { recursive: true })
    const linuxImg = this.state.images.get(plan.image.sha256)
    if ((linuxImg?.os || 'windows') === 'linux') return this.createLinuxVm(job, plan, a, linuxImg, step)
    const creds = this.creds()
    step('writing its answer file')
    const media = join(a.folder, 'setup-media')
    require('./unattend').writeMedia(media, { computerName: a.name.toUpperCase().slice(0, 15), creds, imageIndex: plan.image.imageIndex ?? 1, productKey: plan.productKey ? this.productKey() : null })
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
    step(plan.activation === 'online-once' ? 'activating Windows online (network on for this step only)' : 'reading its Windows licence (offline)')
    const licence = await this.licenceStep(vm, a, plan, creds)
    step('provisioning the test accounts\' profiles (offline)')
    const profiles = await this.provisionProfiles(vm, creds, t => step(`provisioning the test accounts' profiles (offline): ${t}`))
    step('excluding the test folders from Defender\'s scanning (offline)')
    const defender = await this.defenderStep(vm, creds)
    step('shutting down and taking the clean checkpoint')
    const cp = await this.hv('make-clean', { ...this.ident(vm) }, { timeoutMs: 15 * 60_000 })
    fs.rmSync(media, { recursive: true, force: true })
    fs.rmSync(unattendIso, { force: true })
    const facts = await this.restoreVia(vm, 'restore', { ...this.ident(vm), checkpointId: cp.checkpointId })
    const bad = baselineProblem(facts, { ...vm, cleanCheckpointId: cp.checkpointId })
    if (bad) throw new Error(`its clean baseline doesn't verify: ${bad}`)
    this.journal.append({ t: 'ready', intentId: a.intentId, vmId: vm.vmId, cleanCheckpointId: cp.checkpointId, licence, profiles, defender })
    return buildNote(profiles)
  }

  /**
   * MC-1501: a Linux VM's create (design §3): the driver's build (seed, first boot with its diagnostics, readiness by the
   * authenticated round trip, cloud-init, the checks, cloud-init off, the seed and COM port gone), then the clean
   * checkpoint and its verification, as for Windows. Nothing goes online, nothing is activated.
   */
  async createLinuxVm(job, plan, a, img, step) {
    const { vm, record } = await this.linux.build(job, plan, a, img, step)
    step('taking the clean checkpoint')
    const cp = await this.hv('make-clean', { ...this.ident(vm) }, { timeoutMs: 15 * 60_000 })
    const facts = await this.restoreVia(vm, 'restore', { ...this.ident(vm), checkpointId: cp.checkpointId })
    const bad = baselineProblem(facts, { ...vm, cleanCheckpointId: cp.checkpointId })
    if (bad) throw new Error(`its clean baseline doesn't verify: ${bad}`)
    this.journal.append({ t: 'ready', intentId: a.intentId, vmId: vm.vmId, cleanCheckpointId: cp.checkpointId, ...record })
    const d = record.diag || {}
    return `${record.guest.id} ${record.guest.versionId}${record.guest.serial ? ` build ${record.guest.serial}` : ''}, kernel ${record.guest.kernel}; SSH over the Hyper-V socket${d.hv_sock_driver ? ` (hv_sock ${d.hv_sock_driver})` : ''}`
  }

  /**
   * MC-1519: hv.ps1 'guest-defender' adds the test folders as Defender exclusions; the read-back must hold exactly those
   * folders, with real-time protection and the antivirus service still on, or the build fails.
   */
  async defenderStep(vm, creds) {
    const r = await this.hv('guest-defender', { ...this.ident(vm), cred: creds.admin, paths: DEFENDER_EXCLUSIONS }, { timeoutMs: 120_000 })
    const got = (Array.isArray(r?.exclusions) ? r.exclusions : []).map(p => String(p).replace(/\\+$/, '').toLowerCase()).sort()
    const want = DEFENDER_EXCLUSIONS.map(p => p.toLowerCase()).sort()
    const bad = []
    if (got.join('|') !== want.join('|')) bad.push(`its exclusions are ${got.length ? got.join(', ') : 'none'}, not exactly ${want.join(', ')}`)
    if (r?.realTime !== true) bad.push('real-time protection is off')
    if (r?.service !== true) bad.push('the antivirus service is off')
    if (bad.length) throw new Error(`Defender's settings didn't verify: ${bad.join('; ')}`)
    return { exclusions: DEFENDER_EXCLUSIONS, realTime: true }
  }

  /**
   * MC-1516: each test account logged on interactively once at build, as a start does (guest-logon), and its first-logon
   * work let finish, so the clean checkpoint holds provisioned profiles and an interactive start doesn't replay it.
   * hvadmin, then hvuser; a verified undo after each (and before a retry), so the next logon sees Windows' own Userinit
   * and the intended UAC state, and the checkpoint keeps no autologon, password, UAC change or watcher grants. A lost
   * logon is retried once per account, within the same PROVISION_WAIT_MS deadline: a retry gets no new allowance.
   * Returns what was observed, per account.
   */
  async provisionProfiles(vm, creds, step) {
    const out = {}
    for (const which of ['admin', 'user']) {
      const name = creds[which].user
      const deadline = this.now() + PROVISION_WAIT_MS // the account's one provisioning budget, retry included
      const attempts = [] // MC-1520: each attempt's outcome, a slow one's snapshot and a failed one's diagnosis
      for (let attempt = 1; ; attempt++) {
        if (this.now() >= deadline) throw provisionLate(name)
        step(`logging ${name} on${attempt > 1 ? ' (again)' : ''} (${name}'s budget: ${Math.max(0, Math.round((deadline - this.now()) / 60_000))} of ${Math.round(PROVISION_WAIT_MS / 60_000)} min left)`)
        // MC-1520: a read-only snapshot of the guest when the attempt is slow, and before the undo when it failed.
        const diag = async () => {
          const left = deadline - this.now()
          if (left <= 0) return { unavailable: true }
          const r = await this.hv('guest-logon-diag', { ...this.ident(vm), cred: creds.admin, account: name }, { timeoutMs: Math.max(1, Math.min(60_000, left)) }).catch(() => null)
          return diagSummary(r)
        }
        let slow = null
        const o = await this.logon(vm, null, which, creds, deadline, async () => {
          slow = await diag()
          step(`${name}'s logon is still waiting at ${Math.round(LOGON_SNAPSHOT_MS / 1000)} s: ${diagLine(slow)}`)
          this.log(`${vm.vmName}: ${name}'s build logon still waiting at ${Math.round(LOGON_SNAPSHOT_MS / 1000)} s: ${diagLine(slow)}`)
        })
        if (o.late) throw new Error(`${provisionLate(name).message}${slow ? ` (at ${Math.round(LOGON_SNAPSHOT_MS / 1000)} s: ${diagLine(slow)})` : ''}`)
        let why = null
        const waited = Math.round(BUILD_LOGON_WAIT_MS / 1000)
        if (o.silent) why = `no logon of ${name} began within ${Math.round(FIRST_LOGON_SIGN_MS / 1000)} s of its new boot being seen`
        else if (o.loggedOff && o.unseen) why = `Windows logged ${name}'s logon off before it was seen`
        else if (o.loggedOff) why = `${name} logged on, then Windows logged the session off`
        else if (o.ms === undefined) why = o.user ? `${name} logged on, but its watcher didn't start within ${waited} s` : `no interactive session of ${name} appeared within ${waited} s`
        let quiet = null
        if (!why) {
          step(`waiting for ${name}'s first-logon work to finish`)
          quiet = await this.waitProvisioned(vm, creds, name, o.boot, deadline)
          if (quiet.lost) why = `${name}'s session was lost while its first-logon work ran`
        }
        const failed = why ? await diag() : null
        attempts.push({ attempt, why, dropped: !!(o.loggedOff && o.unseen), silent: !!o.silent, logonMs: o.ms ?? null, slow, diag: failed })
        if (why) {
          step(`${name}'s logon attempt ${attempt} failed (${why}; ${diagLine(failed)})${attempt < 2 ? ', retrying' : ''}`)
          this.log(`${vm.vmName}: ${name}'s build logon attempt ${attempt} failed (${why}; ${diagLine(failed)})`)
        }
        await this.undoLogon(vm, creds)
        if (!why) { out[name] = { logonMs: o.ms, quietMs: quiet.ms, appReadiness: quiet.appReadiness, packages: quiet.count, inventory: quiet.inventory, mappings: quiet.mappings, packagesDirs: quiet.packagesDirs, attempts }; break }
        if (attempt >= 2) throw new Error(`provisioning ${name}'s profile failed twice: ${why} (${diagLine(failed)})`)
      }
    }
    return out
  }

  /**
   * MC-1516: polls hv.ps1 'guest-provisioned' until the account's first-logon work is observed quiet: PROVISION_QUIET_MS
   * of consecutive good samples (all probes answered, the account logged on, on the logon's boot) with no newer AppX
   * deployment event, no change to its package inventory and no busy first-logon worker. A failed probe or a busy one
   * starts the quiet time over; a changed boot or the account gone is { lost }. This is observed quiescence, not proof.
   * Everything is bounded by the account's deadline: each probe's call by the time left, and nothing it returns once
   * the deadline has passed is accepted.
   */
  async waitProvisioned(vm, creds, account, boot, deadline) {
    const t0 = this.now()
    let last = null
    let readiness = null // MC-1528: App Readiness's state for the account, as last answered (for the record)
    let quietSince = null
    while (this.now() < deadline) {
      const left = deadline - this.now()
      const r = await this.hv('guest-provisioned', { ...this.ident(vm), cred: creds.admin, account, quietMs: PROVISION_QUIET_MS }, { timeoutMs: Math.max(1, Math.min(120_000, left)) }).catch(() => null)
      if (this.now() >= deadline) break
      if (r && (r.boot !== boot || r.user === false)) return { lost: true }
      // MC-1520: the account's AppContainer profile counts too: unknown (null) is never good, and a change is busy.
      const good = !!r && r.user === true && typeof r.inventory === 'string' && Array.isArray(r.busy) && Number.isInteger(r.mappings) && Number.isInteger(r.packagesDirs)
      // MC-1528: App Readiness's per-user queue (the AppContainer wave) must be finished: Windows' own 211 for the
      // account with no tasks left. Not done, or unknown (null), counts as busy, so the quiet backstop runs after it.
      if (r?.appReadiness) readiness = r.appReadiness
      const ready = r?.appReadiness?.done === true
      // A new completion (a later 211: more work came and finished) also starts the quiet over.
      const busy = !good || !ready || r.busy.length > 0 || (last && (r.lastEvent !== last.lastEvent || r.inventory !== last.inventory || r.mappings !== last.mappings || r.packagesDirs !== last.packagesDirs || r.appReadiness?.completedAt !== last.appReadiness?.completedAt || r.appReadiness?.completionId !== last.appReadiness?.completionId))
      if (good) last = r
      if (busy) quietSince = null
      else if (quietSince === null) quietSince = this.now()
      if (!busy && this.now() - quietSince >= PROVISION_QUIET_MS) return { ms: this.now() - t0, count: r.count, inventory: r.inventory, mappings: r.mappings, packagesDirs: r.packagesDirs, appReadiness: readinessRecord(r.appReadiness) }
      await sleep(Math.min(PROVISION_POLL_MS, Math.max(0, deadline - this.now())))
    }
    const e = provisionLate(account)
    e.message += ` (${readinessLine(readiness)})`
    throw e
  }

  /** MC-1516: hv.ps1 'guest-logon-undo', every value read back and checked; any mismatch fails the build. */
  async undoLogon(vm, creds, opts = { timeoutMs: 120_000 }) {
    const r = await this.hv('guest-logon-undo', { ...this.ident(vm), cred: creds.admin }, opts)
    const bad = []
    if (r?.autoAdminLogon !== '0') bad.push(`AutoAdminLogon is ${r?.autoAdminLogon}`)
    if (r?.defaultUserName) bad.push('DefaultUserName is still set')
    if (r?.secretRemoved !== true) bad.push('the autologon password secret was not removed')
    if (r?.enableLUA !== 1) bad.push(`EnableLUA is ${r?.enableLUA}`)
    if (String(r?.userinit).toLowerCase() !== USERINIT.toLowerCase()) bad.push(`Userinit is ${r?.userinit}`)
    if (r?.hvmcpEmpty !== true) bad.push('C:\\hvmcp is not empty')
    if (r?.hvmcpExplicitAces !== 0 || r?.hvmcpProtected !== false) bad.push('C:\\hvmcp has explicit or protected ACLs')
    if (bad.length) throw new Error(`undoing a build logon didn't verify: ${bad.join('; ')}`)
  }

  /**
   * The build's licence step (MC-1513). With the plan's 'online-once': journalled online, then hv.ps1 'guest-activate'
   * (the adapter on the Default Switch for that call only, disconnected in its finally and verified), then journalled
   * offline. A failure, a timeout or an unconfirmed disconnection throws, and the rollback does net-off first. Without
   * it, the licence is only read, offline. An evaluation must come back licensed with at least EVAL_MIN_DAYS left.
   */
  async licenceStep(vm, a, plan, creds) {
    let r
    if (plan.activation === 'online-once') {
      this.journal.append({ t: 'online', intentId: a.intentId })
      try { r = await this.hv('guest-activate', { ...this.ident(vm), cred: creds.admin }, { timeoutMs: ACTIVATE_MS }) } catch (e) { throw new Error(`activating Windows online failed: ${e.message}`) }
      if (!r?.disconnected) throw new Error('its network adapter could not be confirmed disconnected after activating Windows')
      this.journal.append({ t: 'offline', intentId: a.intentId })
    } else {
      r = await this.hv('guest-licence', { ...this.ident(vm), cred: creds.admin }, { timeoutMs: 120_000 })
    }
    return licenceOf(r, isEval(plan.image), this.now())
  }

  /** The pool's product key (setup's -ProductKeyFile), or null. Never in a reply, plan, journal or log. */
  productKey() {
    try {
      const k = JSON.parse(fs.readFileSync(join(this.dir, 'secrets', 'product-key.json'), 'utf8').replace(/^\uFEFF/, ''))?.key
      return typeof k === 'string' && require('./unattend').KEY_RE.test(k) ? k : null
    } catch { return null }
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
      case 'renew': return this.renew(connId, args)
      case 'manifest_begin': return this.manifestBegin(connId)
      case 'manifest_add': return this.manifestAdd(connId, args)
      case 'sync_plan': return this.syncPlan(connId, args)
      case 'sync': return this.sync(connId, args)
      case 'stage_begin': return this.stageBegin(connId, args)
      case 'stage_file': return this.stageFile(connId, args)
      case 'stage_chunk': return this.stageChunk(connId, args)
      case 'stage_end': return this.stageEnd(connId)
      case 'start': return this.start(connId, args)
      case 'run': return this.run(connId, args)
      case 'read_out': return this.readOut(connId, args)
      case 'stop': return this.stop(connId, args)
      case 'checkpoint': return this.checkpoint(connId, args)
      case 'restore-checkpoint': return this.restoreCheckpoint(connId, args)
      case 'release': return this.release(connId)
      case 'pool_plan': return this.plan(args)
      case 'pool_create': return this.apply('create', args)
      case 'pool_resize': return this.apply('resize', args)
      case 'pool_remove': return this.apply('remove', args)
      case 'pool_checkpoint': return this.poolCheckpoint(connId, args)
      case 'pool_refresh': return this.apply('refresh', args)
      case 'quiesce': return this.quiesce()
      case 'version': return { text: PROTOCOL, data: { protocol: PROTOCOL, features: [...FEATURES], buildRoots: [...this.policy.buildRoots] } }
      case 'whoami': return this.whoami(args.roots)
      default: throw new Error(`unknown operation ${op}`)
    }
  }
}

const PROTOCOL = 'hyperv-mcp/3' // 2: renew, sync_plan, sync (MC-1497); 3: start's interactive, run's session (MC-1503)
// Additive features since protocol 3, by name, so a server that asks for exactly hyperv-mcp/3 (MC-1503's) keeps
// working with this helper: 'projects' = projects, acquire's wait and roots, whoami; 'images' = image groups,
// acquire's os and image, per-OS shares, a project's image allowlist (MC-1502).
// 'named' = acquire's vm, one VM by name (MC-1523).
// 'checkpoints' = vm_checkpoint and vm_restore, a lease's own checkpoints (MC-1529).
// 'pool-checkpoints' = pool_plan's checkpoint actions, pool_checkpoint, acquire's and start's checkpoint (MC-1532).
// 'refresh-clean' = pool_plan's refresh-clean and pool_refresh (MC-1531).
const FEATURES = ['projects', 'images', 'named', 'checkpoints', 'pool-checkpoints', 'refresh-clean', 'linux', 'debug-keep']
const LEASE_CHECKPOINT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/
// MC-1532: a pool checkpoint's name.
const POOL_CHECKPOINT_RE = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * MC-1520: a build logon's diagnostic snapshot, reduced to its allowlisted fields (event ids and seconds after the boot,
 * process names and seconds, booleans), capped; anything else hv.ps1 might return is dropped. { unavailable } if none.
 */
function diagSummary(r) {
  if (!r || typeof r !== 'object') return { unavailable: true }
  const n = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : null)
  const events = v => (Array.isArray(v) ? v.slice(-12).map(e => ({ id: n(e?.id), s: n(e?.s) })) : 'unavailable')
  const logs = {}
  for (const k of DIAG_LOGS) logs[k] = events(r.logs?.[k])
  return {
    uptime: n(r.uptime), logs, appxLast: r.appxLast === 'unavailable' ? 'unavailable' : n(r.appxLast),
    autoAdminLogon: ['0', '1'].includes(r.autoAdminLogon) ? r.autoAdminLogon : null, defaultUserIsAccount: r.defaultUserIsAccount === true,
    watcher: r.watcher === true, watcherS: n(r.watcherS),
    processes: (Array.isArray(r.processes) ? r.processes : []).slice(0, 25).map(p => ({ name: String(p?.name ?? '').replace(/[^\w.-]/g, '').slice(0, 40), s: n(p?.s) }))
  }
}

/** MC-1520: one line from a snapshot's allowlisted fields, for progress, the job note and the helper's log. */
function diagLine(d) {
  if (!d || d.unavailable) return 'diagnostics unavailable'
  const at = (log, id) => (Array.isArray(d.logs[log]) ? d.logs[log].filter(e => e.id === id).map(e => e.s).at(-1) : undefined)
  const parts = [`up ${d.uptime}s`]
  for (const [id, what] of [[21, 'logon'], [22, 'shell'], [23, 'logoff']]) { const t = at('lsm', id); if (t !== undefined) parts.push(`${what} +${t}s`) }
  const off = at('security', 4647)
  if (off !== undefined) parts.push(`user-initiated logoff +${off}s`)
  parts.push(d.watcher ? `watcher +${d.watcherS}s` : 'no watcher')
  parts.push(d.autoAdminLogon === '1' ? 'autologon armed' : d.autoAdminLogon === '0' ? 'autologon cleared' : 'autologon unknown')
  const busy = [...new Set(d.processes.map(p => p.name).filter(x => FIRST_LOGON_WORKERS.includes(x)))]
  if (busy.length) parts.push(`busy: ${busy.join(', ')}`)
  const gone = DIAG_LOGS.filter(k => d.logs[k] === 'unavailable')
  if (gone.length) parts.push(`unavailable: ${gone.join(', ')}`)
  return parts.join(', ')
}

/** MC-1520: the build's note on its slow or retried logons, for the job's done line (pool_status), or ''. */
function buildNote(profiles) {
  const notes = []
  for (const [name, p] of Object.entries(profiles || {})) {
    // The settled counts, always: what the quiet test saw when it accepted the profile.
    if (Number.isInteger(p.mappings)) notes.push(`${name} settled with ${p.mappings} AppContainer mappings and ${p.packagesDirs} Packages folders after ${Math.round(p.quietMs / 1000)} s${p.appReadiness?.done ? ' (App Readiness finished)' : ''}`)
    // MC-1524: Windows' known drop of a first logon, followed by an attempt that succeeded, is expected: said so, briefly.
    // Any other failed attempt, or a drop with no later success, stays in full.
    const ok = (p.attempts || []).some(t => !t.why)
    for (const t of p.attempts || []) {
      if (t.why && t.dropped && ok) notes.push(`${name}'s first logon was dropped by Windows (attempt ${t.attempt}), retried`)
      else if (t.why && t.silent && ok) notes.push(`${name}'s first logon didn't begin (attempt ${t.attempt}), retried`)
      else if (t.why) notes.push(`${name}'s logon attempt ${t.attempt} failed: ${t.why}; ${diagLine(t.diag)}`)
      else if (t.slow) notes.push(`${name}'s logon took ${Math.round(t.logonMs / 1000)} s; at ${Math.round(LOGON_SNAPSHOT_MS / 1000)} s: ${diagLine(t.slow)}`)
    }
  }
  return notes.join('; ')
}

/** MC-1528: App Readiness's state, allowlisted for the record: done, the task count and three UTC times. */
function readinessRecord(a) {
  if (!a || typeof a !== 'object') return null
  const t = v => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null)
  return { done: a.done === true ? true : a.done === false ? false : null, tasks: Number.isInteger(a.tasks) ? a.tasks : null, completedAt: t(a.completedAt), completionId: Number.isSafeInteger(a.completionId) ? a.completionId : null, suspendedUntil: t(a.suspendedUntil), resumedAt: t(a.resumedAt) }
}

/** MC-1528: one line on App Readiness's state, for a late failure. */
function readinessLine(a) {
  const r = readinessRecord(a)
  if (!r || r.done === null) return 'App Readiness: unknown (its logs unreadable or no answer)'
  if (r.done) return `App Readiness: finished at ${r.completedAt}`
  return `App Readiness: not finished, ${r.tasks ?? 'unknown'} tasks left${r.suspendedUntil ? `, suspended until ${r.suspendedUntil}` : ''}${r.resumedAt ? `, resumed at ${r.resumedAt}` : ''}`
}

/** MC-1516: an account's provisioning budget, retry included, ran out. */
function provisionLate(account) {
  return new Error(`${account}'s first-logon provisioning didn't settle within ${Math.round(PROVISION_WAIT_MS / 1000)} s`)
}

/** An evaluation VM's recorded end (ms), or null: an own copy, or a VM built before licences were recorded. */
function evalEnd(vm) {
  return vm.licence?.kind === 'evaluation' ? Date.parse(vm.licence.expiresAt) : null
}

/**
 * A VM's licence for vm_status and pool_status (MC-1513): an evaluation's days left from its recorded end (a warning
 * from 14 days before; past EVAL_LAST_MS before it, it is no longer leased), an own copy's activation, or unknown for a
 * VM built before licences were recorded. '' for a VM not yet ready.
 */
function expiry(vm, now) {
  const l = vm.licence
  if (!l) return vm.readyAt ? '; licence unknown (built before Windows activation was recorded: an unactivated evaluation stops allowing interactive logons about a day after its build; a rebuild records it)' : ''
  if (l.kind === 'linux') return '; Linux, no licence to track' // MC-1501
  if (l.kind === 'own') return l.activated ? '; own copy of Windows, activated' : `; own copy of Windows, not activated (licence status ${l.status})`
  const end = Date.parse(l.expiresAt)
  const date = new Date(end).toISOString().slice(0, 10)
  const left = Math.floor((end - now) / DAY_MS)
  if (end - now < EVAL_LAST_MS) return `. Its Windows evaluation ${end <= now ? 'ended' : 'ends'} ${new Date(end).toISOString()}: it is no longer leased; the pool needs a rebuild (plan a remove, then a create; the user approves each)`
  if (left <= 14) return `. WARNING: its Windows evaluation ends in about ${left} day(s), on ${date}: ask the user to rebuild the pool (plan a remove, then a create)`
  return `; Windows evaluation, ${left} days left (until ${date})`
}

/**
 * What a build's licence step read, as recorded (MC-1513). An evaluation must be licensed (status 1) with at least
 * EVAL_MIN_DAYS left; its end is the earlier of now + GracePeriodRemaining and EvaluationEndDate, never recomputed later.
 * Only an absent or unreadable date is ignored (hv.ps1 sends none for Windows' 1601 sentinel): a real end date that
 * has passed fails the build, never giving way to the grace figure. An own copy is recorded as it is (no expiry).
 */
function licenceOf(r, evaluation, now) {
  if (!r || typeof r !== 'object') throw new Error('the guest reported no licence')
  const status = Number(r.status)
  if (!evaluation) return { kind: 'own', activated: status === 1, status }
  const evalEnd = r.evalEnd ? Date.parse(r.evalEnd) : NaN
  const ends = [Number(r.graceMinutes) > 0 ? now + Number(r.graceMinutes) * 60_000 : NaN, evalEnd].filter(Number.isFinite)
  if (status !== 1) throw new Error(`Windows didn't activate (licence status ${status}${r.error ? `: ${r.error}` : ''})`)
  if (!ends.length) throw new Error('Windows activated but reported no evaluation period')
  const end = Math.min(...ends)
  if (end <= now) throw new Error(`the evaluation's end date, ${new Date(end).toISOString()}, has already passed`)
  const days = Math.floor((end - now) / DAY_MS)
  if (days < EVAL_MIN_DAYS) throw new Error(`the evaluation activated with only ${days} day(s) left (at least ${EVAL_MIN_DAYS} needed)`)
  return { kind: 'evaluation', expiresAt: new Date(end).toISOString() }
}

/**
 * MC-1531: why a refresh's guest licence report isn't acceptable, or null. A report is required. An evaluation (or a VM
 * with no recorded kind) must be licensed with a reported period not yet over: any length, not the fresh build's
 * minimum, since a refreshed VM is part way through its evaluation. An own copy follows the build's policy (its status
 * is recorded, not required). Never used to write the host's record.
 */
function refreshLicenceProblem(r, vm, now) {
  if (!r || typeof r !== 'object' || !Number.isFinite(Number(r.status))) return 'the guest reported no licence'
  if (vm.licence?.kind === 'own') return null
  const status = Number(r.status)
  if (status !== 1) return `Windows isn't licensed (licence status ${status}${r.error ? `: ${r.error}` : ''})`
  const ends = [Number(r.graceMinutes) > 0 ? now + Number(r.graceMinutes) * 60_000 : NaN, r.evalEnd ? Date.parse(r.evalEnd) : NaN].filter(Number.isFinite)
  if (!ends.length) return 'Windows reported no evaluation period'
  if (Math.min(...ends) <= now) return `the evaluation's end, as Windows reports it (${new Date(Math.min(...ends)).toISOString()}), has passed`
  return null
}

/**
 * MC-1536: why a restore didn't complete, from hv.ps1's own report (f.restore), or null. A timed-out phase is refused
 * whatever the facts read afterwards say (an Off that came late, with the parent already the target, isn't a
 * restore). A reply without the report (an older helper script) is judged on its facts alone, as before.
 */
function restoreProblem(f) {
  const r = f?.restore
  if (!r || typeof r !== 'object') return null
  if (r.timedOut === true || r.ok === false) return `the restore didn't complete: ${r.phase === 'off' ? 'the VM didn\'t turn off' : r.phase === 'parent' ? 'Hyper-V didn\'t report the checkpoint as its parent' : `phase ${r.phase}`} within the wait (last seen: ${r.last || 'nothing'}, after ${r.waitedMs ?? '?'} ms)`
  return null
}

/** Why restored facts aren't the clean baseline, or null. */
function baselineProblem(f, vm) {
  if (!f || typeof f !== 'object') return 'no facts'
  const rp = restoreProblem(f)
  if (rp) return rp
  if (f.vmId !== vm.vmId) return 'a different VM answered'
  if (f.state !== 'Off') return `state is ${f.state}, not Off`
  if (!vm.cleanCheckpointId) return 'no clean checkpoint recorded'
  if (!Array.isArray(f.checkpointIds) || !f.checkpointIds.includes(vm.cleanCheckpointId)) return 'its clean checkpoint is missing'
  if (f.parentCheckpointId !== vm.cleanCheckpointId) return 'it is not at its clean checkpoint'
  if (f.switchName) return `its network adapter is connected to ${f.switchName}`
  if (f.acls?.length) return `its network adapter still has ${f.acls.length} port ACL(s)` // MC-1556
  if (f.reserve !== 0) return `CPU reserve is ${f.reserve}%`
  return null
}

const isEval = img => img.evaluation ?? img.edition === images.EVAL
const pick = img => img.os === 'linux'
  ? { sha256: img.sha256, size: img.size, imageIndex: 1, evaluation: false, pinned: img.pinned, source: img.source, os: 'linux', distro: img.distro ?? null, release: img.release ?? null, serial: img.serial ?? null, name: img.name ?? null, checksums: img.checksums ?? null } // MC-1501
  : { sha256: img.sha256, size: img.size, edition: img.edition, build: img.build, imageIndex: img.imageIndex ?? 1, evaluation: isEval(img), pinned: img.pinned, source: img.source, os: img.os || 'windows' }
const OSES = ['windows', 'linux']

function describePlan(plan, digest, approve) {
  const lines = [`Plan ${plan.id} (${plan.op}), valid for 30 minutes. Digest ${digest}; its first 6 characters are ${digest.slice(0, 6)}.`]
  for (const a of plan.add || []) lines.push(`- create ${a.name}: ${a.cores} cores, ${a.memoryMB} MB static memory, ${a.diskGB} GB dynamic disk, in ${a.folder}; network adapter disconnected`)
  for (const r of plan.remove || []) lines.push(`- remove ${r.name} and its folder ${r.folder}`)
  // MC-1531: refresh plans.
  if (plan.op === 'refresh') for (const v of plan.refresh) lines.push(`- refresh the clean checkpoint of ${v.name}: restore it, start it offline, rerun the build's guest steps (the registry policy and the Defender exclusions; the test accounts' profiles are kept as built, not logged on again: fixes to the build's profile setup need a rebuild, not a refresh), shut it down and take a new clean checkpoint; then remove the old one (its pool checkpoints are kept). Nothing goes online and nothing is re-activated; its evaluation end stays as recorded. The VM isn't leased meanwhile.`)
  // MC-1532: pool-checkpoint plans.
  if (plan.op === 'checkpoint') for (const v of plan.vms) lines.push(plan.mode === 'remove' ? `- remove the pool checkpoint "${plan.checkpoint}" of ${v.name} (owner ${v.owner}); a lease already using it keeps it until that lease ends` : `- ${plan.mode === 'replace' ? 'replace' : 'publish'} the pool checkpoint "${plan.checkpoint}" of ${v.name} (owner ${v.owner}, ${v.os}, image ${v.image === 'legacy' ? 'unknown' : v.image.slice(0, 12)}), from lease ${v.leaseId}'s state: its logon undone and verified, network disconnected, the guest shut down, then checkpointed Off; any project's lease may then start from it${plan.mode === 'replace' ? '; the old one stops being offered at once and is removed when no lease uses it' : ''}`)
  if (plan.switch) lines.push(`- create the internal switch ${plan.switch} (host and guests only; no internet, no LAN)`)
  // MC-1556: every create and resize states the whole pool it leaves and its network mode, for the user to confirm.
  for (const k of plan.keep || []) lines.push(`- keep ${k.name}: ${k.cores} cores, ${k.memoryMB} MB static memory, ${k.diskGB} GB disk (unchanged)`)
  if (plan.network) lines.push(`- network: ${plan.network}${plan.networkWas && plan.networkWas !== plan.network ? ` (was ${plan.networkWas})` : plan.networkWas ? ' (unchanged)' : ''}: ${net.DESCRIBE[plan.network]}. Runs may ask for this mode or a lower one; each run is disconnected again when it stops`)
  if (plan.networkWas && net.rank(plan.network) < net.rank(plan.networkWas)) lines.push(`- lowering it: a lease already running in a higher mode keeps it until its next start, reset, restore or checkpoint restart, each of which is checked against the new mode then (a start, reset or restore above it is refused; a checkpoint restart goes on with network none)`)
  if (plan.removeSwitch) lines.push(`- remove the switch ${plan.removeSwitch}`)
  const linux = plan.image?.os === 'linux' // MC-1501
  if (linux) lines.push(`- image: ${linuxImages.describe(plan.image)}; checksums: ${plan.image.checksums || 'unknown'}`)
  if (linux && plan.add?.length) lines.push('- Linux build: each new VM is a copy of the image\'s verified base VHDX with a cloud-init seed (users hvadmin and hvuser with locked passwords; SSH keys made by the helper and held only by it; sshd only on the Hyper-V socket, for the helper\'s forced command), first booted offline; cloud-init is turned off and the seed removed before its clean checkpoint')
  if (plan.debugKeepFailedBuild) lines.push('- DEBUG (MC-1545): if a Linux build fails, its VM is kept, turned on, network disconnected, never leased, for an administrator to inspect in Hyper-V Manager (its console, its COM1 diagnostics, a host-side HvMcpVsock retry; no login or other access to the guest is added; its seed, with its host key, stays with it); a resize plan with no image and vms equal to the number of other VMs in the pool removes only it; any other create or resize removes it too, along with the changes it asks for; a remove plan removes the whole pool')
  if (plan.image && !linux) lines.push(`- image: ${plan.image.edition}${plan.image.imageIndex > 1 ? ` (index ${plan.image.imageIndex})` : ''} build ${plan.image.build}, SHA-256 ${plan.image.sha256} (${plan.image.pinned ? 'pinned: a known Microsoft download' : plan.image.source === 'download' ? 'downloaded by the helper over HTTPS from Microsoft' : 'NOT AUTHENTICATED: a local file you chose to trust'})`)
  if (plan.add?.length && !linux) lines.push('- registry: a user\'s registry isn\'t forcibly unloaded at logoff (the DisableForceUnload policy): the suspected cause of runs losing their HKCU after the short PowerShell Direct session that started them ends (MC-1522; its real-build trial is MC-1521)')
  if (plan.add?.length && !linux) lines.push(`- Defender: the test work folders ${DEFENDER_EXCLUSIONS.join(', ')} are excluded from Defender's scanning (real-time and scheduled scans) in the guest image; Defender stays on otherwise`)
  if (plan.add?.length && !linux) lines.push(`- provisioning: each new VM logs hvadmin and hvuser on interactively once (offline), waits for Windows' first-logon setup to finish, then turns autologon off and resets UAC and the watcher's start before its clean checkpoint; each account within ${Math.round(PROVISION_WAIT_MS / 60_000)} min (a logon attempt up to ${Math.round(BUILD_LOGON_WAIT_MS / 60_000)} min once it has begun, one with no sign of a logon ${Math.round(FIRST_LOGON_SIGN_MS / 60_000)} min after its new boot is seen retried at once, then accepted once Windows' App Readiness reports the account's first-logon app setup finished and ${Math.round(PROVISION_QUIET_MS / 60_000)} min of observed quiet follow, one retry if needed)`)
  if (plan.activation === 'online-once') lines.push('- activation: each new VM goes online once, through Windows\' Default Switch, to activate Windows; it is disconnected (verified) before its clean checkpoint, and no start ever uses that switch')
  else if (plan.add?.length && !linux) lines.push('- activation: none (each new VM stays offline; its licence is read and shown)')
  if (plan.add?.length && plan.image && !plan.image.evaluation && !linux) lines.push(`- product key: ${plan.productKey ? 'the pool\'s (set by install.ps1 -ProductKeyFile), written only into the answer file' : 'none'}`)
  if (plan.host) lines.push(`Host: ${plan.host.logicalCpus} logical CPUs, ${plan.host.memoryMB} MB.`)
  lines.push('', 'Nothing is changed until the user approves this exact plan, in an admin PowerShell (one UAC prompt):', approve,
    'It shows the plan from the helper\'s own record and asks for the 6 characters above. Then call ' + `pool_${plan.op}({ planId: "${plan.id}" }).`,
    'Don\'t approve it for the user: only they can, and only they should.')
  return lines.join('\n')
}

module.exports = { Helper, canonical, baselineProblem, expiry, licenceOf, diagSummary, diagLine, keyOf, ancestorClash, PLAN_ID_RE, PROTOCOL }
