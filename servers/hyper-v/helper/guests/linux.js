/**
 * The Linux guest driver (MC-1501; design: docs/linux-guests.md §1, §3-§6). core.js reaches a guest through
 * `guestCall(vm, op, args, opts)`: a Windows VM's ops go to hv.ps1 (PowerShell Direct), a Linux VM's come here, under
 * the same names and with the same answers, so the rules around them (leases, restores, the journal, the line) stay
 * the same for both. Here each op is one SSH session (ssh.js) to the VM's dispatcher (guest.py).
 *
 * The VM's keys live in the helper's secrets folder, secrets\ssh\<vm name>\: its client key (the helper's, for hvadmin's
 * forced command only) and known_hosts (its host key, pinned at create). Never in a reply, plan, journal or log.
 *
 * Also here: a Linux VM's build (the seed, the first boot with its serial diagnostics, the checks, cloud-init turned
 * off) and its refresh's guest steps.
 */
const fs = require('fs')
const crypto = require('crypto')
const { join } = require('path')
const ssh = require('../ssh')
const sshkeys = require('../sshkeys')
const seed = require('../seed')
const net = require('../net')

// MC-1558: a new Linux VM's readiness and cloud-init waits are the job's timings (guestReadyMinutes, cloudInitMinutes);
// HYPERV_MCP_LINUX_READY_MS stays a test-only base for the readiness wait.
const LINUX_READY_BASE = Number(process.env.HYPERV_MCP_LINUX_READY_MS || 0)
const POLL_MS = Number(process.env.HYPERV_MCP_POLL_MS || 3000)
const ATTEMPT_MS = Number(process.env.HYPERV_MCP_LINUX_ATTEMPT_MS || 60_000) // one readiness attempt's bound (test-only override)
// MC-1588: the longest command sent in the request line, as every dispatcher takes it (one built before MC-1588 took
// at most this many characters); a longer one follows the line as bytes.
const LINE_COMMAND_CHARS = 8000
const DIAG_KEYS = ['stage', 'vmbus', 'hv_sock_driver', 'hv_sock_modinfo', 'vsock_listen', 'sshd_config_ok', 'sshd_error', 'kernel', 'n', 'result', 'code', 'status']
const PATHS = { build: '/build', out: '/out' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

class LinuxDriver {
  constructor(h) { this.h = h }

  keyDir(vm) { return join(this.h.dir, 'secrets', 'ssh', vm.vmName) }

  /** The transport the pool's Linux VMs use: the policy's (setup's -LinuxTransport), hvsocket by default. */
  transport() { return this.h.policy?.linuxTransport || 'hvsocket' }

  target(vm) {
    const d = this.keyDir(vm)
    const transport = vm.transport || this.transport()
    if (transport !== 'hvsocket') throw new Error(`${vm.vmName} was built for the ${transport} transport, which this helper doesn't provide: rebuild it`)
    return { vmId: vm.vmId, keyFile: join(d, 'client'), knownHosts: join(d, 'known_hosts'), transport }
  }

  dispatch(vm, request, opts = {}, files = []) {
    return ssh.call(this.target(vm), request, { files, timeoutMs: opts.timeoutMs ?? 120_000, onChild: opts.onChild, verbose: !!opts.verbose })
  }

  /** The Windows guest ops core.js uses, answered for a Linux guest. */
  async call(vm, op, a = {}, opts = {}) {
    switch (op) {
      case 'guest-ready': {
        const st = await this.h.hv('facts-vm', this.h.ident(vm), opts)
        if (st.state !== 'Running') return { ready: false }
        return this.dispatch(vm, { op: 'ready' }, opts)
      }
      case 'guest-run-start': {
        if (!['bash', 'sh'].includes(a.shell)) throw new Error('a Linux guest runs bash or sh')
        const req = { op: 'run-start', n: a.n, shell: a.shell, as: a.runAs ? 'user' : 'admin', cwd: a.cwd }
        // MC-1588: a command over LINE_COMMAND_CHARS goes as bytes after the request line (commandBytes), which a
        // dispatcher built before MC-1588 refuses: it took at most 8000 characters in the line.
        if (typeof a.command !== 'string' || a.command.length <= LINE_COMMAND_CHARS) {
          const r = await this.dispatch(vm, { ...req, command: a.command }, opts)
          return { pid: null, started: r.boot, unit: r.unit }
        }
        const bytes = Buffer.from(a.command, 'utf8')
        const r = await this.dispatch(vm, { ...req, commandBytes: bytes.length }, opts, [bytes]).catch(e => {
          if (/: a bad command$/.test(e.message) && !a.command.includes('\0')) throw new Error(`${vm.vmName}'s guest dispatcher takes a command of at most ${LINE_COMMAND_CHARS} characters (it was built before MC-1588): rebuild the VM to run longer ones, or put the command in a script in the build`)
          throw e
        })
        return { pid: null, started: r.boot, unit: r.unit }
      }
      case 'guest-run-poll': return this.dispatch(vm, { op: 'run-poll', n: a.n, cap: a.cap }, opts)
      // MC-1577: a build-time run's files live under /hvmcp/runs, which the build's finish clears before the checkpoint.
      case 'guest-run-clear': return { cleared: 'at finish' }
      case 'guest-run-kill': return this.dispatch(vm, { op: 'run-kill', n: a.n, boot: a.started }, opts)
      case 'guest-list': return this.dispatch(vm, { op: 'list' }, opts)
      case 'guest-read': return this.dispatch(vm, { op: 'read', paths: a.paths, maxBytes: a.maxBytes, maxTotalBytes: a.maxTotalBytes }, opts)
      case 'copy-in': {
        // A start's build: everything staged, after clearing /build.
        const entries = [...a.entries.values()]
        const t0 = Date.now()
        await this.dispatch(vm, { op: 'sync', full: true, delete: true, remove: [], gen: a.gen, files: entries.map(f => ({ path: f.path.replace(/\\/g, '/'), size: f.size, sha256: f.sha256 })) }, opts, entries.map(f => join(a.source, ...f.path.split(/[\\/]/))))
        return { ms: Date.now() - t0 }
      }
      case 'sync-in': {
        const t0 = Date.now()
        const entries = a.entries
        const r = await this.dispatch(vm, {
          op: 'sync', full: !!a.full, delete: a.delete !== false, gen: a.gen,
          remove: a.remove.map(p => p.replace(/\\/g, '/')),
          files: entries.map(f => ({ path: f.path.replace(/\\/g, '/'), size: f.size, sha256: f.sha256 }))
        }, opts, a.source ? entries.map(f => join(a.source, ...f.path.split(/[\\/]/))) : [])
        return { ms: Date.now() - t0, copied: r.copied, removed: r.removed }
      }
      // MC-1556: the guest's network for a mode, and its read-back, each a fixed root script of the helper's own (never an
      // agent's), run through the dispatcher's existing run path, so no rebuild is needed. Nothing of it persists: /run
      // is tmpfs and a restore brings the disk back, so 'none' (a pool checkpoint's reset) has nothing to undo.
      case 'guest-net': {
        if (a.mode === 'none') return { reset: true }
        const r = await this.internalRun(vm, net.linuxSetScript(a.mode, { mac: a.mac, address: a.address }), opts)
        if (r.exitCode !== 0) throw new Error(`setting its network failed (exit ${r.exitCode}${r.stderr ? `: ${String(r.stderr).trim().slice(-300)}` : ''})`)
        return { set: true }
      }
      case 'guest-net-read': {
        const r = await this.internalRun(vm, net.linuxReadScript({ lookup: !!a.lookup }), opts)
        const read = net.parseRead(r.stdout)
        if (!read) throw new Error(`its network couldn't be read (exit ${r.exitCode}${r.stderr ? `: ${String(r.stderr).trim().slice(-300)}` : ''})`)
        return read
      }
      default: throw new Error(`${op} isn't available in a Linux guest`)
    }
  }

  /**
   * MC-1556: one of the helper's own root scripts, as a run numbered above any agent's (900000000 up), polled to its
   * end within 60 s. Never listed as a run of the lease. Returns the poll's answer.
   */
  async internalRun(vm, script, opts = {}) {
    this.netRuns = ((this.netRuns || 0) % 99_999_999) + 1
    const n = 900_000_000 + this.netRuns
    await this.dispatch(vm, { op: 'run-start', n, command: script, shell: 'bash', as: 'admin', cwd: '/' }, opts)
    const t0 = Date.now()
    for (;;) {
      const r = await this.dispatch(vm, { op: 'run-poll', n, cap: 64 * 1024 }, opts)
      if (r.done) return r
      if (Date.now() - t0 > 60_000) {
        await this.dispatch(vm, { op: 'run-kill', n }, opts).catch(() => {})
        throw new Error("its network script didn't finish within 60 s")
      }
      await sleep(Math.min(POLL_MS, 500))
    }
  }

  // ---------- build ----------

  /** Makes the VM's keys (before its create): its client key and its host key, the host key's public half pinned. */
  makeKeys(vmName) {
    const d = join(this.h.dir, 'secrets', 'ssh', vmName)
    fs.rmSync(d, { recursive: true, force: true })
    fs.mkdirSync(d, { recursive: true })
    const client = sshkeys.generate(`hvmcp-helper@${vmName}`)
    const host = sshkeys.generate(`hvmcp-host@${vmName}`)
    fs.writeFileSync(join(d, 'client'), client.private, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(join(d, 'client.pub'), client.public + '\n', { flag: 'wx' })
    fs.writeFileSync(join(d, 'known_hosts'), sshkeys.knownHosts('hvmcp', host.public), { flag: 'wx' })
    return { client, host }
  }

  dropKeys(vmName) { fs.rmSync(join(this.h.dir, 'secrets', 'ssh', vmName), { recursive: true, force: true }) }

  /**
   * The Linux part of a create, after the journal's intent: the seed, the VM from its image's base VHDX, its first boot
   * (serial diagnostics alongside), readiness by the authenticated round trip, cloud-init's finish, the checks, then
   * cloud-init turned off, the seed and COM port removed and the VM shut down for its clean checkpoint. Returns
   * { vm, record } for the journal's ready record (core takes the clean checkpoint).
   */
  async build(job, plan, a, img, step) {
    const h = this.h
    const transport = this.transport()
    if (transport !== 'hvsocket') throw new Error(`the ${transport} transport isn't provided by this helper (docs/linux-guests.md §4.1: only on the user's decision after the trial)`)
    step('checking its image\'s base VHDX')
    const base = img.file
    if (!fs.existsSync(base)) throw new Error('its image\'s base VHDX is missing: plan the image again')
    if (img.vhdxSha256) {
      const got = await require('../linux-images').hashFile(base)
      if (got !== img.vhdxSha256) throw new Error('its image\'s base VHDX has changed since it was verified: refused')
    }
    step('making its SSH keys and cloud-init seed')
    const keys = this.makeKeys(a.name)
    const seedDir = join(a.folder, 'seed')
    const seedIso = join(a.folder, 'seed.iso')
    try {
      seed.write(seedDir, { instanceId: `i-${crypto.randomBytes(8).toString('hex')}`, hostname: a.name.toLowerCase(), keys, transport, dispatcher: seed.dispatcher() })
      await h.hv('make-iso', { source: seedDir, out: seedIso, label: 'cidata' })
    } finally {
      fs.rmSync(seedDir, { recursive: true, force: true }) // it held the host key: gone as soon as the ISO is made
    }
    step('creating the VM from the image')
    const c = await h.hv('create-vm', { os: 'linux', name: a.name, folder: a.folder, cores: a.cores, memoryMB: a.memoryMB, diskGB: a.diskGB, baseVhdx: base, seedIso }, { timeoutMs: 20 * 60_000 })
    h.journal.append({ t: 'created', intentId: a.intentId, vmId: c.vmId })
    const vm = h.state.vms.get(c.vmId)
    const pipe = `hvmcp-diag-${crypto.randomBytes(8).toString('hex')}`
    await h.hv('com-attach', { ...h.ident(vm), pipe })
    step('first boot from its seed (network off), with its serial diagnostics')
    // MC-1545: COM1 is read through the whole readiness wait (the guest reports each SSH connection's start and end),
    // and ended by a stop file the build writes when the wait is over, so its answer is never lost to a kill.
    let reader = null
    const READY_MS = LINUX_READY_BASE || h.tm().ms.guestReadyMinutes
    const stopFile = join(h.dir, 'runs', `${pipe}.stop`)
    fs.rmSync(stopFile, { force: true })
    const diag = h.hv('com-read', { pipe, ms: READY_MS + 30_000, through: true, stopFile }, { timeoutMs: READY_MS + 90_000, onChild: c => { reader = c } }).then(r => r, e => ({ lines: [], error: e.message }))
    const stopReading = async () => {
      try { fs.writeFileSync(stopFile, 'stop') } catch { /* the reader still ends at its deadline */ }
      const r = await Promise.race([diag, sleep(20_000).then(() => ({ lines: [], late: true }))])
      try { reader?.kill() } catch { /* ended */ }
      fs.rmSync(stopFile, { force: true })
      return r
    }
    let ready = null
    const attempts = {} // MC-1544: the readiness wait's last error, for the reason if it never answers
    try {
      await h.hv('start-vm', { ...h.ident(vm), noKeys: true })
      ready = await this.waitReady(vm, READY_MS, null, attempts, { verbose: true })
    } catch (e) {
      await stopReading()
      throw e
    }
    const facts = parseDiag(await stopReading())
    if (ready === null) {
      const why = notReadyWhy(facts, attempts)
      h.log(`${vm.vmName}: Linux build never ready: ${why}`)
      throw new Error(why)
    }
    step('waiting for cloud-init to finish')
    const g = await this.waitCloudInit(vm)
    step('checking the guest')
    const bad = verifyProblem(g, { keys, transport, img })
    if (bad.length) throw new Error(`the guest's checks failed: ${bad.join('; ')}`)
    // MC-1577: the plan's guest setup script (the user's own), as root, offline, before cloud-init is turned off.
    let guestScript = null
    if (plan.guestScript) {
      step(`running the guest setup script ${plan.guestScript.name} (offline)`)
      guestScript = await h.runGuestScript(vm, plan.guestScript)
    }
    step('turning cloud-init off, then shutting down')
    const fin = await this.dispatch(vm, { op: 'finish' })
    // MC-1551: cloud-init's cached seed (a second copy of the host key's private half) must be gone before the clean
    // checkpoint. An older dispatcher says nothing of it; this one lists what it couldn't remove.
    if (Array.isArray(fin?.seedCacheLeft) && fin.seedCacheLeft.length) throw new Error(`cloud-init's cached seed is still there: ${fin.seedCacheLeft.join(', ')}`)
    const off = await h.hv('guest-shutdown', { ...h.ident(vm), shutdownMs: h.tm().ms.shutdownMinutes }, { timeoutMs: h.tm().d.shutdownCallMs })
    if (off.state !== 'Off') throw new Error(`the guest didn't shut down (the VM is ${off.state})`)
    const com = await h.hv('com-detach', h.ident(vm))
    if (com.path) throw new Error(`its COM port is still set (${com.path})`)
    fs.rmSync(seedIso, { force: true })
    return {
      vm,
      record: { licence: { kind: 'linux' }, guest: { id: g.id, versionId: g.versionId, serial: g.serial, kernel: g.kernel }, diag: facts, transport, guestScript }
    }
  }

  /**
   * Polls the authenticated round trip until the dispatcher answers: ms to ready, or null. MC-1544: out (optional) gets
   * the attempts' count and the last one's error (ssh.exe's exit code and stderr, which carries HvMcpVsock.exe's own
   * message), cleaned by sshError, so a build that never answers can say why.
   */
  async waitReady(vm, ms, lease = null, out = {}, { verbose = false } = {}) {
    const t0 = Date.now()
    out.attempts = 0
    while (Date.now() - t0 < ms) {
      if (lease) this.h.stillHeld(lease)
      out.attempts++
      // MC-1545: verbose (a build's wait only) asks ssh for its DEBUG1 lines; the error keeps the last 10, cleaned.
      const opts = { ...(lease ? this.h.forLease(lease, ATTEMPT_MS) : { timeoutMs: ATTEMPT_MS }), verbose }
      const r = await this.call(vm, 'guest-ready', {}, opts).catch(e => { out.error = sshError(e.message, verbose ? 1500 : 400); return null })
      if (r?.ready) return Date.now() - t0
      if (r && !r.ready) out.error = 'the VM is not running'
      await sleep(POLL_MS)
    }
    return null
  }

  async waitCloudInit(vm) {
    const t0 = Date.now()
    let last = null
    const CLOUD_INIT_MS = this.h.tm().ms.cloudInitMinutes
    while (Date.now() - t0 < CLOUD_INIT_MS) {
      last = await this.dispatch(vm, { op: 'verify' }, { timeoutMs: 90_000 }).catch(e => ({ error: e.message }))
      if (last.cloudInit === 'done') return last
      if (last.cloudInit === 'error' || last.cloudInit === 'degraded') throw new Error(`cloud-init finished with status ${last.cloudInit}`)
      await sleep(POLL_MS)
    }
    throw new Error(`cloud-init didn't finish within ${Math.round(CLOUD_INIT_MS / 60_000)} minutes (last: ${last?.cloudInit || last?.error || 'nothing'})`)
  }

  /**
   * A refresh's guest steps (MC-1531) for a Linux VM: the dispatcher's checks, read again. Its files come from the
   * seed and aren't rewritten in place: a change to them needs a rebuild.
   */
  async guestSteps(vm) {
    const g = await this.dispatch(vm, { op: 'verify' }, { timeoutMs: 90_000 })
    const img = this.h.state.images.get(this.h.imageOf(vm)) || {}
    const keys = { client: { public: fs.readFileSync(join(this.keyDir(vm), 'client.pub'), 'utf8').trim() }, host: { public: knownHostKey(fs.readFileSync(join(this.keyDir(vm), 'known_hosts'), 'utf8')) } }
    const bad = verifyProblem(g, { keys, transport: vm.transport || this.transport(), img, built: true })
    if (bad.length) throw new Error(`the guest's checks failed: ${bad.join('; ')}`)
    return g
  }
}

function knownHostKey(text) { const p = String(text).trim().split(/\s+/); return `${p[1]} ${p[2]}` }

/** The allowlisted HVMCP-DIAG facts: the last value of each known key, from a fixed alphabet; everything else dropped. */
function parseDiag(r) {
  const facts = {}
  let starts = 0
  let ends = 0
  for (const line of Array.isArray(r?.lines) ? r.lines.slice(0, 64) : []) {
    if (typeof line !== 'string' || !line.startsWith('HVMCP-DIAG ')) continue
    const kv = {}
    for (const pair of line.slice(11).split(' ')) {
      const m = /^([a-z_]+)=([A-Za-z0-9._+-]{1,64})$/.exec(pair)
      if (m && DIAG_KEYS.includes(m[1])) kv[m[1]] = m[2]
    }
    // MC-1545: each SSH connection the guest saw (its socket unit's instance starting and ending) is counted, and the
    // last one's end kept (result, code, status), apart from the seed's stages.
    if (kv.stage === 'conn-start') { starts++; continue }
    if (kv.stage === 'conn-end') { ends++; for (const k of ['result', 'code', 'status']) if (kv[k] !== undefined) facts[`conn_${k}`] = kv[k]; continue }
    for (const [k, v] of Object.entries(kv)) if (!['n', 'result', 'code', 'status'].includes(k)) facts[k] = v
  }
  if (starts || ends) Object.assign(facts, { conn_starts: String(starts), conn_ends: String(ends) })
  if (!Object.keys(facts).length) facts.unavailable = r?.late ? 'still reading' : r?.error ? 'unreadable' : r?.connected === false ? 'no connection' : 'no lines'
  return facts
}

/**
 * MC-1544: an SSH attempt's error, fit for a reason and a log. Printable ASCII only, whitespace collapsed, anything that
 * looks like key material (a PEM line, or a base64 run of 40+ characters) replaced, at most 400 characters.
 */
function sshError(text, max = 400) {
  return String(text ?? '')
    .replace(/-----BEGIN[\s\S]*?(-----END[^-]*-----|$)/g, '[key material removed]')
    .replace(/[A-Za-z0-9+/=]{40,}/g, '[removed]')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * MC-1545: where an SSH connection stopped, from the host's side (HvMcpVsock.exe's lines in the SSH error) and the
 * guest's (its socket unit's connections on COM1). null when neither says.
 */
function connectionStop(d, attempts) {
  const e = attempts.error || ''
  const starts = Number(d.conn_starts || 0)
  const ends = Number(d.conn_ends || 0)
  // Round 2: only what the evidence shows. The guest's COM1 trace counts only when it was read (a stage line seen);
  // a banner is ssh -v's "Remote protocol version" line, or (MC-1549) its "compat_banner: match" or "remote software
  // version" (the error keeps only ssh's last lines, so the first may be gone); any recorded end is reported with its
  // result, code and status, a "success" included (the unit's ExecStart=- hides sshd's own exit status).
  const trace = !d.unavailable && d.stage !== undefined
  const banner = /Remote protocol version|remote software version|compat_banner: match/.test(e)
  const ended = ends ? `; the guest's sshd ended ${d.conn_result || 'unknown'}/${d.conn_code || 'unknown'}/${d.conn_status || 'unknown'}` : ''
  if (/HvMcpVsock: (connect timed out|can't connect)/.test(e)) return 'connect never completed (host side)'
  if (banner) return `sshd answered (its banner arrived), then SSH failed: see the last SSH error${ended}`
  if (ends) return `guest started sshd, which ended ${d.conn_result || 'unknown'}/${d.conn_code || 'unknown'}/${d.conn_status || 'unknown'}, with no SSH banner seen`
  if (starts) return 'guest started sshd, no SSH banner'
  if (/HvMcpVsock: connected to /.test(e) && trace) return 'connected, guest saw no connection'
  return null
}

/**
 * Why a build's guest never answered: conclusive from the diagnostics, or inconclusive. Never retried over B. MC-1544:
 * the readiness wait's last SSH error comes with it, whichever it is.
 */
function notReadyWhy(d, attempts = {}) {
  const seen = Object.entries(d).map(([k, v]) => `${k}=${v}`).join(' ')
  const ssh = attempts.error ? ` Last SSH error (attempt ${attempts.attempts}): ${attempts.error}` : attempts.attempts ? ` No SSH error was seen in ${attempts.attempts} attempt(s).` : ''
  if (d.hv_sock_driver === 'absent') return `the guest kernel has no hv_sock driver (kernel ${d.kernel || 'unknown'}): this image can't use the Hyper-V socket transport. Moving to the internal-switch transport is the user's decision (docs/linux-guests.md §4.1). Diagnostics: ${seen}.${ssh}`
  if (d.vsock_listen && d.vsock_listen !== 'active') return `the guest's sshd socket on vsock isn't listening (${d.vsock_listen}). Diagnostics: ${seen}.${ssh}`
  if (d.sshd_config_ok === 'no') return `the guest's sshd config doesn't parse${d.sshd_error ? ` (${d.sshd_error})` : ''}. Diagnostics: ${seen}.${ssh}`
  const stop = connectionStop(d, attempts)
  if (stop) return `the guest never answered over SSH: ${stop}. Diagnostics: ${seen}.${ssh}`
  return `the guest never answered over SSH, and the diagnostics don't say why (inconclusive): ${seen}.${ssh} The build stops here: the transport is the user's decision`
}

/** The build's checks (§3, §4.1's row for A): what must hold before the clean checkpoint. */
function verifyProblem(g, { keys, transport, img, built = false }) {
  const bad = []
  if (!g || typeof g !== 'object') return ['no answer']
  const lg = require('../linux-images').guestReportProblem(g, img)
  if (lg) bad.push(lg)
  if (img?.serial && g.serial && img.distro === 'ubuntu' && g.serial !== img.serial) bad.push(`the guest's build serial is ${g.serial}, the image's ${img.serial}`)
  if (g.hostKey !== keys.host.public.split(' ').slice(0, 2).join(' ')) bad.push('its host key is not the one made for it')
  if (g.otherHostKeys?.length && built) bad.push(`other host keys exist: ${g.otherHostKeys.join(', ')}`)
  const wantKey = `restrict,command="${seed.FORCED}" ${keys.client.public}`
  if (!Array.isArray(g.authorizedKeys) || g.authorizedKeys.length !== 1 || g.authorizedKeys[0] !== wantKey) bad.push('hvadmin\'s authorized_keys is not exactly the helper\'s restricted key')
  if (g.sudoers !== `hvadmin ALL=(root) NOPASSWD: ${seed.DISPATCH} ""\n`) bad.push('the sudoers rule is not exactly the dispatcher\'s')
  if (g.sshdConfigOk !== true) bad.push('its sshd config doesn\'t parse')
  if (g.socket?.active !== 'active' || g.socket?.enabled !== 'enabled') bad.push(`hvmcp-sshd.socket is ${g.socket?.active}/${g.socket?.enabled}`)
  for (const [k, n] of [['ssh', 'ssh.service'], ['sshSocket', 'ssh.socket']]) if (g[k]?.enabled !== 'masked' || g[k]?.active === 'active') bad.push(`${n} is ${g[k]?.active}/${g[k]?.enabled}, not masked`)
  if (transport === 'hvsocket') {
    if (!Array.isArray(g.addresses) || g.addresses.length) bad.push(`it has addresses: ${(g.addresses || ['unreadable']).join(', ')}`)
    if (!Array.isArray(g.listeners) || g.listeners.length) bad.push(`something listens beyond loopback: ${(g.listeners || ['unreadable']).join(', ')}`)
    if (g.hvSockDriver !== true) bad.push('no hv_sock driver')
  }
  const p = g.paths || {}
  if (!p['/build']?.dir || p['/build'].uid !== 0 || p['/build'].mode !== '0o755') bad.push('/build is not root\'s, 0755')
  if (!p['/out']?.dir || p['/out'].uid !== 0) bad.push('/out is not root\'s')
  if (!p['/hvmcp']?.dir || p['/hvmcp'].uid !== 0 || p['/hvmcp'].mode !== '0o711') bad.push('/hvmcp is not root\'s, 0711')
  if (built && g.cloudInitDisabled !== true) bad.push('cloud-init is not turned off')
  return bad
}

module.exports = { LinuxDriver, parseDiag, notReadyWhy, verifyProblem, sshError, connectionStop, PATHS }
