/**
 * A fake hv.ps1 for the tests (HYPERV_MCP_PS_STUB): reads { op, args } on stdin like the real script and answers one
 * HVJSON: line. It keeps a fake Hyper-V in HYPERV_MCP_STUB_STATE (JSON): VMs with their checkpoints, state, network
 * switch, CPU reserve and guest files (a VM's disk), switches, and a log of every call.
 *
 * It enforces what hv.ps1 does: Get-OwnVm (the id must name a VM with the expected name inside the expected folder).
 * Guest commands are a tiny language: "echo <text>", "exit <n>", "sleep" (never ends), "write <path> <text>",
 * "check <path>" (exit 0 if it exists), "cat <path>" (its text as stdout; exit 1 if missing), "shutdown" (the guest shuts itself down: Off, its disk changes kept),
 * "hang <host file> <ms> <pid file>" (records its PID, blocks, then writes the file: a killed run never finishes).
 * restoreGate: a host path; restore waits until that file exists (to hold the VM's lock at a known point).
 * Interactive logon (MC-1503, MC-1504): guest-logon records the account (never its password), whether the session is
 * elevated (an admin logon turns UAC's Admin Approval Mode off) and its watcher, and restarts the guest (its boot count
 * moves on, so the disk stays); guest-session reports the boot and the session in which the account's watcher runs
 * (state.extraRestart: the guest restarts once more after it is first seen). A restore and a start log nobody on.
 * guest-run with interactive runs only as the logged-on account through its watcher (clean: true when it exits);
 * "sleep" times out, a run with nobody logged on or no watcher is never taken (both unclean), "logoff" logs the account
 * off, "killwatcher" ends the watcher, and state.interactiveThrows makes the next one fail outright.
 * Faults (state.fail): { "<op>": n } fails the next n calls of op; restoreLeaves: { switchName, reserve, state } makes
 * restore leave that behind; signatureBad: true; aclBad: "<why>"; installNeverReady: true.
 * Licences (MC-1513): facts reports the Default Switch unless noDefaultSwitch. guest-activate connects the adapter to
 * "Default Switch" (each VM's onlineCount counts it), then answers state.activation (default: licensed, 90 days left)
 * and disconnects; activateDies: it fails with the adapter still connected (a killed call); activateStaysConnected: it
 * answers but leaves it connected (disconnected: false). guest-licence answers state.licence (default: status 1).
 * net-off turns the VM off and disconnects it (fail it with fail['net-off']).
 * Profiles at build (MC-1516): guest-logon refuses unless the VM's Userinit is Windows' own (null counts, as a fresh
 * install), as hv.ps1's $UserinitValue does, and records the UAC state each logon's restart applies (logons[].lua);
 * guest-logon-undo puts Userinit, UAC and autologon back (undoOverride: fields it reports instead). guest-provisioned
 * samples the account's first-logon work: busy for provisionBusy samples (or provisionNever, or at sample
 * provisionBusyAt), failing at sample provisionFailAt, and losing the logon at sample provisionLoseOnce (once).
 * The guest setup script (MC-1577) runs as a run does (guest-run-start/poll below); guest-run-clear removes the run's
 * record and lists its number in state.cleared.
 * Logon diagnostics (MC-1520): guest-logon-diag answers state.diag, or a sample that also carries fields the helper must
 * drop (an event message, a command line, a password), to show only the allowlisted ones are kept.
 * Linux VMs (MC-1501): create-vm with os 'linux' needs its base VHDX and its seed ISO (make-iso with label cidata keeps
 * only the seed's public parts: the host key's public half, hvadmin's authorized_keys line, the sudoers rule; never a
 * private key); com-attach/com-detach set and unset COM1, com-read answers state.diagLines (default: every stage, hv_sock
 * present; comReadFails); vhd-convert copies the VHD. The guest itself is test/stub-guest.js (the SSH transport's stub).
 * Network modes (MC-1556): each VM's adapter has port ACLs (vm.acls: { action, remote }, both directions); net-prepare
 * (Off only) disconnects, clears and installs them (aclsDrop: n leaves the last n out, a half-done install;
 * prepareStaysConnected), configure-start connects by kind (host: state.hostNet's switch by id; default: the Default
 * Switch), net-host and net-default read the host (hostRead / defaultRead: fields reported instead), restore and
 * net-disconnect disconnect then clear them, and guest-net / guest-net-read are stub-net.js's. After every call,
 * stub-net's invariant is checked on every VM.
 */
const fs = require('fs')
const crypto = require('crypto')
const { join } = require('path')
const stubNet = require('./stub-net')

const FILE = process.env.HYPERV_MCP_STUB_STATE
// A read that catches another stub process mid-write (a torn file) is retried, never taken as an empty state.
const load = () => {
  for (let i = 0; i < 50; i++) {
    let text
    try { text = fs.readFileSync(FILE, 'utf8') } catch { return {} }
    try { return JSON.parse(text) } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) }
  }
  throw new Error('the stub state stays unreadable')
}
const save = s => fs.writeFileSync(FILE, JSON.stringify(s, null, 1))
const answer = o => { process.stdout.write('HVJSON:' + JSON.stringify(o) + '\n') }
const norm = p => String(p).replace(/[\\/]+$/, '').toLowerCase()
const USERINIT = 'C:\\Windows\\system32\\userinit.exe,'
const under = (loc, folder) => norm(loc) === norm(folder) || norm(loc).startsWith(norm(folder) + '\\')

let input = ''
process.stdin.on('data', d => { input += d })
process.stdin.on('end', () => {
  const { op, args: a = {} } = JSON.parse(input)
  const s = load()
  s.vms ??= {}
  s.switches ??= {}
  s.calls ??= []
  s.fail ??= {}
  // MC-1501: com-read runs alongside a Linux build's other calls, so it only reads: it never saves (a save racing
  // another call's read could hand that call a half-written file).
  const keep = op !== 'com-read'
  // MC-1578: which account a guest call signed in as (a.cred.user; never its password).
  s.calls.push({ op, argv: process.argv.slice(2), vmId: a.vmId, command: a.command, ...(a.kind ? { kind: a.kind } : {}), ...(a.cred?.user ? { as: a.cred.user } : {}) })
  if (keep) save(s) // logged before it runs, so a test can see a call in progress
  try {
    if (s.fail[op] > 0) { s.fail[op]--; if (keep) save(s); throw new Error(`injected failure of ${op}`) }
    const r = run(s, op, a)
    for (const vm of Object.values(s.vms)) stubNet.checkInvariant(s, vm, op)
    if (keep) save(s)
    answer({ result: r })
  } catch (e) {
    if (keep) save(s)
    answer({ error: e.message })
  }
})

const knobOn = k => k === true || (typeof k === 'string' && fs.existsSync(k)) // MC-1537: true, or a file that exists
function own(s, a) {
  const vm = s.vms[a.vmId]
  if (!vm) throw new Error(`VM ${a.vmId} does not exist`)
  if (vm.name !== a.name) throw new Error(`VM ${a.vmId} is named '${vm.name}', not '${a.name}': not the pool's`)
  if (!under(vm.location, a.folder)) throw new Error(`VM ${a.name} is not in its pool folder: not the pool's`)
  return vm
}
const swId = (s, name) => name === 'Default Switch' ? 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444' : name ? s.switches[name]?.id ?? null : null
let S = null // the state, for facts' switch id
const facts = vm => ({ vmId: vm.id, state: vm.state, parentCheckpointId: vm.parent, checkpointIds: vm.checkpoints.map(c => c.id), switchName: vm.switchName, switchId: swId(S, vm.switchName), mac: stubNet.macOf(vm), acls: (vm.acls || []).flatMap(e => ['Inbound', 'Outbound'].map(direction => ({ action: e.action, direction, remote: e.remote }))), reserve: vm.reserve })

function run(s, op, a) {
  S = s
  switch (op) {
    case 'facts': return { hyperv: true, logicalCpus: 16, memoryMB: 65536, folders: (a.folders || []).map(folder => ({ folder, freeGB: s.freeGB ?? 500 })), defaultSwitch: !s.noDefaultSwitch }
    case 'guest-activate': {
      const vm = own(s, a)
      if (s.noDefaultSwitch) throw new Error('this host has no Default Switch')
      vm.switchName = 'Default Switch'
      vm.onlineCount = (vm.onlineCount || 0) + 1
      if (s.activateDies) throw new Error('injected: the activation call died')
      const r = { status: 1, graceMinutes: 90 * 24 * 60, evalEnd: null, channel: 'Retail:TB:Eval', error: null, ...(s.activation || {}) }
      if (!s.activateStaysConnected) vm.switchName = null
      return { ...r, disconnected: !vm.switchName }
    }
    case 'guest-run-clear': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      s.cleared = [...(s.cleared || []), a.n]
      delete vm.runs?.[a.n]
      return { cleared: true }
    }
    case 'guest-logon-diag': {
      const vm = own(s, a)
      vm.diags = (vm.diags || 0) + 1
      return s.diag || {
        uptime: 600, appxLast: 300, autoAdminLogon: '0', defaultUserIsAccount: false, watcher: false, watcherS: null, message: 'raw event text', password: 'hunter2',
        logs: { lsm: [{ id: 21, s: 400, message: 'User: X\\hvadmin' }, { id: 22, s: 402 }], security: [{ id: 4647, s: 460 }], winlogon: [], profile: [{ id: 1, s: 399 }], shellCore: 'unavailable', appReadinessAdmin: [], appReadinessOperational: [], cloudExperienceHost: 'unavailable' },
        processes: [{ name: 'explorer', s: 403 }, { name: 'OneDriveSetup', s: 410, commandLine: 'OneDriveSetup.exe /token=SECRET' }]
      }
    }
    case 'guest-logon-undo': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      vm.userinit = USERINIT
      vm.enableLUA = 1
      vm.armed = false
      vm.autologon = false // MC-1578: whatever a ready-made disk came with
      vm.lsaSecret = false
      vm.undos = (vm.undos || 0) + 1
      return { autoAdminLogon: '0', defaultUserName: '', secretRemoved: true, enableLUA: 1, userinit: USERINIT, hvmcpEmpty: true, hvmcpExplicitAces: 0, hvmcpProtected: false, ...(s.undoOverride || {}) }
    }
    case 'guest-provisioned': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      const k = vm.provisionChecks = (vm.provisionChecks || 0) + 1
      vm.provisioned = [...(vm.provisioned || []), a.account]
      if (s.provisionFailAt === k) throw new Error('injected: the provisioning probe failed')
      if (s.provisionLoseOnce === k) { delete s.provisionLoseOnce; vm.loggedOn = null }
      const busy = s.provisionNever || k <= (s.provisionBusy || 0) || k === s.provisionBusyAt ? ['OneDriveSetup'] : []
      // MC-1520: the account's AppContainer counts: grow for profileGrow samples (one per sample), unknown at sample
      // profileUnknownAt.
      const grow = Math.min(k, s.profileGrow || 0)
      const unknown = s.profileUnknownAt === k
      // MC-1528: App Readiness's per-user queue. readinessDoneAt: k: not done (39 tasks left, suspended) before this
      // logon's k-th probe, then done, and the AppContainer wave (+39 each) has landed; readinessNever: never done;
      // readinessUnknown: its logs unreadable (null). Default: done from the first probe.
      const doneAt = s.readinessNever || s.readinessUnknown ? Infinity : (s.readinessDoneAt || 1)
      const done = k >= doneAt
      const wave = s.readinessDoneAt && done ? 39 : 0
      const appReadiness = s.readinessUnknown ? { done: null, tasks: null, completedAt: null, completionId: null, suspendedUntil: null, resumedAt: null }
        : done ? { done: true, tasks: 0, completedAt: '2026-11-16T02:01:55.000Z', completionId: 7, suspendedUntil: '2026-11-16T02:00:55.499Z', resumedAt: '2026-11-16T02:00:55.600Z', secret: 'dropped' }
          : { done: false, tasks: 39, completedAt: null, completionId: null, suspendedUntil: '2026-11-16T02:00:55.499Z', resumedAt: null }
      return { boot: `boot-${vm.boot || 0}`, user: vm.loggedOn === a.account, lastEvent: '2026-11-15T00:00:00.000Z', count: 42, inventory: 'cafe', busy, mappings: unknown ? null : 60 + grow + wave, packagesDirs: unknown ? null : 25 + grow + wave, appReadiness }
    }
    case 'guest-licence': { const vm = own(s, a); if (vm.state !== 'Running') throw new Error('the VM is not running'); vm.licenceReads = (vm.licenceReads || 0) + 1; return { status: 1, graceMinutes: 0, evalEnd: null, channel: 'Retail', error: null, ...(s.licence || {}) } }
    case 'net-off': { const vm = own(s, a); vm.state = 'Off'; vm.switchName = null; return { offline: true } }
    case 'find-vm': {
      const hits = Object.values(s.vms).filter(v => v.name === a.name && under(v.location, a.folder))
      return { vmId: hits[0]?.id ?? null }
    }
    case 'create-vm': {
      const id = crypto.randomUUID()
      if (a.os === 'linux') {
        if (!fs.existsSync(a.baseVhdx)) throw new Error('its base VHDX is missing')
        if (!s.seeds?.[a.seedIso] || !fs.existsSync(a.seedIso)) throw new Error('its seed ISO is missing')
        fs.copyFileSync(a.baseVhdx, join(a.folder, 'disk.vhdx'))
        s.vms[id] = { id, name: a.name, os: 'linux', location: join(a.folder, a.name), state: 'Off', checkpoints: [], parent: null, switchName: null, reserve: 0, disk: {}, cores: a.cores, memoryMB: a.memoryMB, installed: true, seed: s.seeds[a.seedIso], dvd: a.seedIso, com: null }
        if (s.failAfterCreate) { s.failAfterCreate = false; throw new Error('injected failure after New-VM') }
        return { vmId: id }
      }
      // MC-1578: a ready-made Windows disk (baseVhdx): its hash checked against baseSha256 as hv.ps1 does, then copied.
      // The guest is what state.readyGuest says the disk holds: { accounts: { name: { password, admin, enabled, rmu } },
      // autologon, lsaSecret, generalized }; by default an installed Windows with one admin, Administrator / src-pw.
      if (a.baseVhdx) {
        if (!/^[0-9a-f]{64}$/.test(a.baseSha256 || '')) throw new Error('create-vm needs the approved disk\'s SHA-256')
        const got = crypto.createHash('sha256').update(fs.readFileSync(a.baseVhdx)).digest('hex')
        if (got !== a.baseSha256) throw new Error(`the disk's copy has changed since it was checked and approved (SHA-256 ${got}, not ${a.baseSha256}): refused, nothing created`)
        fs.copyFileSync(a.baseVhdx, join(a.folder, 'disk.vhdx'))
        const g = s.readyGuest || {}
        s.vms[id] = { id, name: a.name, location: join(a.folder, a.name), state: 'Off', checkpoints: [], parent: null, switchName: null, reserve: 0, disk: {}, cores: a.cores, memoryMB: a.memoryMB, installed: true, fromDisk: true, accounts: JSON.parse(JSON.stringify(g.accounts || { Administrator: { password: 'src-pw', admin: true, enabled: true } })), autologon: !!g.autologon, lsaSecret: !!g.lsaSecret, generalized: !!g.generalized }
        return { vmId: id }
      }
      // MC-1572: hv.ps1 hashes the ISO against isoSha256 before anything is created (tested for real in units.test.js);
      // the stub only checks that the approved hash is passed, and keeps it for the tests to read.
      if (!/^[0-9a-f]{64}$/.test(a.isoSha256 || '')) throw new Error('create-vm needs the approved image\'s SHA-256')
      fs.writeFileSync(join(a.folder, 'disk.vhdx'), 'vhd')
      s.vms[id] = { id, name: a.name, location: join(a.folder, a.name), state: 'Off', checkpoints: [], parent: null, switchName: null, reserve: 0, disk: {}, cores: a.cores, memoryMB: a.memoryMB, installed: false, isoSha256: a.isoSha256 }
      if (s.failAfterCreate) { s.failAfterCreate = false; throw new Error('injected failure after New-VM') }
      return { vmId: id }
    }
    case 'start-vm': { const vm = own(s, a); vm.state = 'Running'; if (vm.os === 'linux') vm.boot = (vm.boot || 0) + 1; if (vm.os !== 'linux') vm.installed = !s.installNeverReady; else if (s.linuxNeverReady) vm.installed = false; return { started: true } }
    case 'guest-ready': {
      const vm = own(s, a)
      // readyGate: PowerShell Direct hangs (records its PID in readyPidFile, then waits for the gate file); notReady: the
      // guest never answers.
      if (s.readyGate) {
        if (s.readyPidFile) fs.writeFileSync(s.readyPidFile, String(process.pid))
        while (!fs.existsSync(s.readyGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
      if (s.notReady) return { ready: false }
      // MC-1578: a ready-made disk's guest answers only an enabled account with its own password (and never while
      // generalized: it would still be in OOBE).
      if (vm.fromDisk) {
        const acct = vm.accounts?.[a.cred?.user]
        return { ready: vm.state === 'Running' && !vm.generalized && !!acct && acct.enabled !== false && acct.password === a.cred.password }
      }
      return { ready: vm.state === 'Running' && vm.installed !== false }
    }
    // MC-1578: the helper's accounts, made through the disk's admin, as hv.ps1's $GuestAccounts does; accountsOverride:
    // fields the read-back reports instead (a reset that didn't take).
    case 'guest-accounts': {
      const vm = own(s, a)
      if (vm.state !== 'Running' || !vm.fromDisk) throw new Error('the VM is not running a ready-made disk')
      const by = vm.accounts[a.cred?.user]
      if (!by || by.password !== a.cred.password || !by.admin) throw new Error('Access is denied (the disk\'s admin account)')
      vm.accounts[a.admin.user] = { ...(vm.accounts[a.admin.user] || {}), password: a.admin.password, enabled: true, admin: true }
      vm.accounts[a.user.user] = { ...(vm.accounts[a.user.user] || {}), password: a.user.password, enabled: true, admin: false, rmu: false }
      const read = (x, o = {}) => { const u = vm.accounts[x.user]; return { exists: !!u, enabled: !!u?.enabled, isAdmin: !!u?.admin, remoteMgmt: !!u?.rmu, signsIn: u?.password === x.password, ...o } }
      const o = s.accountsOverride || {}
      return { admin: read(a.admin, o.admin), user: read(a.user, o.user) }
    }
    // MC-1578: one of the user's own VMs (state.outsideVms: { id: { name, state, generation, disks: [path], checkpoints } }),
    // read only: its disk's bytes copied to a.out, as Convert-VHD flattens it.
    case 'image-from-vm': {
      const all = Object.entries(s.outsideVms || {})
      const hit = all.find(([id]) => id === a.vm) || all.find(([, v]) => v.name === a.vm)
      if (!hit && s.vms[a.vm]) throw new Error(`${s.vms[a.vm].name} is one of the pool's own VMs: name a VM of your own`)
      if (!hit) throw new Error(`there's no VM named ${a.vm}`)
      const [id, v] = hit
      if ((a.poolVmIds || []).includes(id)) throw new Error(`${v.name} is one of the pool's own VMs: name a VM of your own`)
      if (v.state !== 'Off') throw new Error(`${v.name} is ${v.state}: turn it off first (its disk is only read, and a running VM's isn't consistent)`)
      if (v.generation !== 2) throw new Error(`${v.name} is a Generation ${v.generation} VM: pool VMs are Generation 2 (UEFI)`)
      if (v.disks.length !== 1) throw new Error(`${v.name} has ${v.disks.length} disks: only a VM with one disk can be used`)
      if (s.convertFails) throw new Error('Convert-VHD failed (injected)')
      fs.copyFileSync(v.disks[0], a.out)
      return { vmId: id, name: v.name }
    }
    // MC-1531 knobs: setupMarker (written to C:\marker.txt, a stand-in for a fix the setup applies), setupThrows,
    // setupEntered + setupGate (held as it begins).
    case 'guest-setup': { const vm = own(s, a); if (s.setupEntered) fs.writeFileSync(s.setupEntered, 'entered'); if (s.setupGate) while (!fs.existsSync(s.setupGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); s.setupCalls = (s.setupCalls || 0) + 1; if (s.setupTransport > 0) { s.setupTransport--; save(s); throw new Error('the PowerShell Direct connection was lost (injected)') } if (s.setupHang > 0) { s.setupHang--; save(s); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_600_000) } if (s.setupThrows) throw new Error('injected: the guest setup failed'); vm.disk['C:\\build'] = ''; if (s.setupMarker) vm.disk['C:\\marker.txt'] = Buffer.from(s.setupMarker).toString('base64'); return { editionId: s.guestEdition ?? 'EnterpriseEval', build: '26200', ubr: 6584, folders: true, buildProtected: true, ...(s.setupOverride || {}) } }
    case 'make-clean': {
      const vm = own(s, a)
      s.makeCleans = [...(s.makeCleans || []), a.shutdownMs ?? null] // MC-1558: the job's shutdown wait
      vm.state = 'Off'
      vm.dvd = null
      vm.switchName = null
      vm.reserve = 0
      const id = crypto.randomUUID()
      vm.checkpoints = [{ id, name: 'clean', parentId: null, disk: { ...vm.disk }, userinit: vm.userinit ?? null, enableLUA: vm.enableLUA ?? 1, ...(vm.fromDisk ? { autologon: vm.autologon, lsaSecret: vm.lsaSecret, accounts: JSON.parse(JSON.stringify(vm.accounts)) } : {}) }]
      vm.parent = id
      return { checkpointId: id }
    }
    case 'restore': {
      const vm = own(s, a)
      // MC-1558: each restore's off-wait (the lease's, a job's or the default), and restoreSlowMs: the restore takes this long.
      s.restores = [...(s.restores || []), { vmId: a.vmId, offWaitMs: a.offWaitMs ?? null }]
      if (s.restoreSlowMs) { save(s); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.restoreSlowMs) }
      if (s.restoreGate) while (!fs.existsSync(s.restoreGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25) // held until the test opens the gate
      const cp = vm.checkpoints.find(c => c.id === a.checkpointId)
      if (!cp) throw new Error('its clean checkpoint (by id) is missing')
      // MC-1536: restoreTimeout: { last } reports the Off phase timed out: nothing is restored (the VM ends Off, disk and
      // parent untouched), so facts read afterwards may match the target.
      if (s.restoreTimeout) {
        vm.state = 'Off'
        return { ...facts(vm), restore: { ok: false, phase: 'off', timedOut: true, last: s.restoreTimeout.last ?? 'Running', waitedMs: 20000 } }
      }
      // MC-1537: as on real Hyper-V, the restoring call's own facts keep the parent it started with; only a fresh
      // facts-vm shows the new one. restoreNeverLands: the restore is reported issued, but nothing changes.
      // restoreFreshAfter: { n, when }: the next n facts-vm calls still show the old parent. Each knob is true, or a file
      // that must exist first (set before the lease, so no call in flight saves over it).
      const before = vm.parent
      s.justRestored = a.vmId // MC-1537: the next facts-vm is this restore's verification
      if (knobOn(s.restoreNeverLands)) { vm.state = 'Off'; return { ...facts(vm), restore: { ok: true, phase: 'restored', timedOut: false, last: 'Off', waitedMs: 0 } } }
      if (s.restoreFreshAfter && knobOn(s.restoreFreshAfter.when ?? true)) { s.staleReads = { vmId: a.vmId, parent: before, n: s.restoreFreshAfter.n }; delete s.restoreFreshAfter }
      vm.state = 'Off'
      vm.parent = cp.id
      vm.switchName = null
      vm.acls = s.aclsStay ? vm.acls : [] // MC-1556: after the disconnect
      vm.guestNet = null
      vm.reserve = 0
      vm.disk = { ...cp.disk }
      vm.loggedOn = null; vm.watcher = false; vm.elevated = false
      vm.userinit = cp.userinit ?? null; vm.enableLUA = cp.enableLUA ?? 1 // the checkpoint's
      vm.restores = (vm.restores || 0) + 1
      if (s.restoreLeaves && (!s.restoreLeavesWhen || fs.existsSync(s.restoreLeavesWhen))) Object.assign(vm, s.restoreLeaves) // restoreLeavesWhen: only once that file exists
      return { ...facts(vm), parentCheckpointId: before, restore: { ok: true, phase: 'restored', timedOut: false, last: 'Off', waitedMs: 0 } }
    }
    case 'configure-start': {
      const vm = own(s, a)
      if (s.configureEntered) fs.writeFileSync(s.configureEntered, 'entered')
      if (s.configureGate) while (!fs.existsSync(s.configureGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      if (vm.state !== 'Off') throw new Error('the VM is not Off after its restore')
      if (a.kind === 'host') {
        const sw = s.switches[a.switchName]
        if (!sw || sw.id !== a.switchId || sw.type !== 'Internal') throw new Error(`switch ${a.switchName} (id ${a.switchId}) is missing, renamed or not internal`)
        if (!(vm.acls || []).length) throw new Error('its port ACLs are missing: not connected')
        vm.switchName = a.switchName
      } else if (a.kind === 'default') {
        if (s.noDefaultSwitch) throw new Error('this host has no Default Switch')
        if (!(vm.acls || []).length) throw new Error('its port ACLs are missing: not connected')
        vm.switchName = 'Default Switch'
      } else vm.switchName = null // MC-1529: network off is disconnected, whatever a restored checkpoint's adapter said
      if (s.crashAfterConnect) { delete s.crashAfterConnect; throw new Error('injected: the call died after connecting') }
      vm.reserve = a.reserve
      vm.state = 'Running'
      vm.boot = (vm.boot || 0) + 1
      vm.loggedOn = null; vm.watcher = false; vm.elevated = false
      vm.disk['C:\\out'] = ''
      return { started: true }
    }
    // MC-1529: a snapshot tree. A take's parent is the VM's current position, which then becomes the new snapshot (as
    // Hyper-V does); a restore moves the current position to the snapshot; a removal merges into the children (they're
    // re-parented to its parent). Knobs: productionFail (the take fails, nothing made), productionFailButMade (made, then
    // the call fails, as a timeout), snapshotsFail (listing fails), snapRemoveFail: n (the next n removals fail),
    // extraSnapshot: { name } (an unrelated snapshot appears at the next listing).
    case 'snapshots': {
      const vm = own(s, a)
      if (s.snapshotsFail) throw new Error('injected: listing snapshots failed')
      if (s.extraSnapshot && !vm.checkpoints.some(c => c.name === s.extraSnapshot.name)) vm.checkpoints.push({ id: crypto.randomUUID(), name: s.extraSnapshot.name, parentId: vm.parent, disk: { ...vm.disk } })
      // productionFailDelayed: a take whose call failed completes afterwards: it appears from the second listing on.
      if (vm.delayedTake && ++vm.delayedTake.listings >= (s.delayedAfter || 2)) { vm.checkpoints.push(vm.delayedTake.cp); vm.delayedTake = null }
      return { snapshots: vm.checkpoints.map(c => ({ id: c.id, name: c.name, parentId: c.parentId ?? null })) }
    }
    case 'lease-checkpoint': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error(`the VM is ${vm.state}, not Running`)
      if (!/^hvmcp-lease-[0-9a-f]{12}$/.test(a.snapName)) throw new Error('bad checkpoint name')
      // takeEntered: a file written as the take begins; takeGate: held before the snapshot is made; takeGateAfter: held
      // after it's made (Hyper-V succeeded, the call hasn't answered). typeRestoreFails: the type stays ProductionOnly.
      if (s.takeEntered) fs.writeFileSync(s.takeEntered, 'entered')
      const orig = vm.checkpointType || 'Production'
      vm.checkpointType = 'ProductionOnly'
      const wait = g => { while (!fs.existsSync(g)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25) }
      if (s.takeGate) wait(s.takeGate)
      // productionFail: Hyper-V's own terminal failure, answered as such (failed: true), as hv.ps1 does.
      if (s.productionFail) { vm.checkpointType = orig; return { failed: true, error: 'injected: a production checkpoint could not be made', checkpointType: orig } }
      // productionCallDies: the call itself fails (transport, a killed process): the outcome is unknown.
      if (s.productionCallDies) { vm.checkpointType = orig; throw new Error('injected: the take call died') }
      const id = crypto.randomUUID()
      const cp = { id, name: a.snapName, parentId: vm.parent, disk: { ...vm.disk }, switchName: vm.switchName, acls: vm.acls || [], reserve: vm.reserve, production: true }
      if (s.productionFailDelayed) { vm.delayedTake = { cp, listings: 0 }; vm.checkpointType = orig; throw new Error('injected: the take call failed; Hyper-V finishes it later') }
      vm.checkpoints.push(cp)
      vm.parent = id
      vm.leaseTakes = (vm.leaseTakes || 0) + 1
      if (s.takeGateAfter) { save(s); wait(s.takeGateAfter) } // saved first: Hyper-V has made it, whatever happens to this call
      if (!s.typeRestoreFails) vm.checkpointType = orig
      if (s.productionFailButMade) throw new Error('injected: the take timed out after making the checkpoint')
      return { checkpointId: id, checkpointType: vm.checkpointType }
    }
    case 'checkpoint-type': {
      const vm = own(s, a)
      if (a.set && !s.typeSetFails) vm.checkpointType = a.set
      return { type: vm.checkpointType || 'Production' }
    }
    case 'lease-restore': {
      const vm = own(s, a)
      if (s.restoreEntered) fs.writeFileSync(s.restoreEntered, 'entered')
      if (s.leaseRestoreGate) while (!fs.existsSync(s.leaseRestoreGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      const cp = vm.checkpoints.find(c => c.id === a.checkpointId && c.name === a.snapName)
      if (!cp) throw new Error(`checkpoint ${a.snapName} (by id) is missing on this VM`)
      if (s.restoreTimeout) {
        vm.state = 'Off'
        return { ...facts(vm), restore: { ok: false, phase: 'off', timedOut: true, last: s.restoreTimeout.last ?? 'Running', waitedMs: 20000 } }
      }
      const before = vm.parent
      s.justRestored = a.vmId // MC-1537: the next facts-vm is this restore's verification
      if (knobOn(s.restoreNeverLands)) { vm.state = 'Off'; return { ...facts(vm), restore: { ok: true, phase: 'restored', timedOut: false, last: 'Off', waitedMs: 0 } } }
      if (s.restoreFreshAfter && knobOn(s.restoreFreshAfter.when ?? true)) { s.staleReads = { vmId: a.vmId, parent: before, n: s.restoreFreshAfter.n }; delete s.restoreFreshAfter }
      vm.state = 'Off' // a production checkpoint restores Off
      vm.parent = cp.id
      vm.disk = { ...cp.disk }
      vm.switchName = cp.switchName ?? null // the checkpoint's own configuration, until the start reapplies the lease's
      vm.acls = cp.acls || []
      vm.reserve = cp.reserve ?? 0
      vm.loggedOn = null; vm.watcher = false; vm.elevated = false
      return { ...facts(vm), parentCheckpointId: before, restore: { ok: true, phase: 'restored', timedOut: false, last: 'Off', waitedMs: 0 } }
    }
    // factsParentWrong: the next facts-vm reports another parent (a verification mismatch), once; not a restore's own
    // verification read (MC-1537), which comes first.
    case 'facts-vm': {
      const vm = own(s, a)
      if (s.factsCalls !== undefined) s.factsCalls++
      if (s.staleReads && s.staleReads.vmId === a.vmId && s.staleReads.n > 0) { s.staleReads.n--; return { ...facts(vm), parentCheckpointId: s.staleReads.parent } }
      const verifying = s.justRestored === a.vmId
      delete s.justRestored
      if (s.factsParentWrong && !verifying) { delete s.factsParentWrong; return { ...facts(vm), parentCheckpointId: 'someone-else' } }
      return facts(vm)
    }
    // MC-1532: a pool checkpoint's steps. Knobs: disconnectFails (the adapter stays connected), shutdownFails (the guest
    // stays Running), poolTakeFail (Hyper-V's terminal failure), poolTakeEntered + poolTakeGate (held before the take).
    case 'net-disconnect': { const vm = own(s, a); if (!s.disconnectFails) { vm.switchName = null; vm.acls = [] } return facts(vm) }
    case 'net-prepare': {
      const vm = own(s, a)
      if (vm.state !== 'Off') throw new Error('the VM is not Off')
      if (!s.prepareStaysConnected) vm.switchName = null
      vm.acls = []
      const want = (a.acls || []).map(x => ({ action: x.action, remote: x.remote }))
      vm.acls = s.aclsDrop ? want.slice(0, Math.max(0, want.length - s.aclsDrop)) : want
      if (s.crashAfterAcls) { delete s.crashAfterAcls; throw new Error('injected: the call died after the ACLs') }
      return facts(vm)
    }
    case 'net-host': {
      const h = s.hostNet
      const sw = h && Object.entries(s.switches).find(([, x]) => x.id === a.switchId)
      return {
        switch: sw ? { id: sw[1].id, name: sw[0], type: sw[1].type } : null,
        hostAddrs: sw ? [{ ip: h.hostAddress, prefix: 24 }] : [],
        others: [{ alias: 'Ethernet', ip: '192.168.1.20', prefix: 24 }, ...(s.hostClash ? [s.hostClash] : [])],
        routes: [{ alias: 'Ethernet', prefix: '0.0.0.0/0', ours: false }, { alias: 'Ethernet', prefix: '192.168.1.0/24', ours: false }],
        ...(s.hostRead || {})
      }
    }
    case 'net-default': return s.noDefaultSwitch ? { present: false, ip: null, prefix: null } : { present: true, ...stubNet.dflt(s), ...(s.defaultRead || {}) }
    case 'guest-net': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      stubNet.setGuestNet(s, vm, a.mode, a.address)
      return a.mode === 'none' ? { reset: true } : { set: true }
    }
    case 'guest-net-read': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      return stubNet.readGuestNet(s, vm, a.lookup)
    }
    case 'guest-shutdown': { const vm = own(s, a); s.shutdowns = [...(s.shutdowns || []), a.shutdownMs ?? null]; if (!s.shutdownFails) { vm.state = 'Off'; vm.loggedOn = null; vm.watcher = false } return facts(vm) }
    case 'pool-take': {
      const vm = own(s, a)
      if (s.poolTakeEntered) fs.writeFileSync(s.poolTakeEntered, 'entered')
      if (s.poolTakeGate) while (!fs.existsSync(s.poolTakeGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      if (vm.state !== 'Off') throw new Error(`the VM is ${vm.state}, not Off`)
      if (!/^hvmcp-(pool|clean|lease)-[0-9a-f]{12}$/.test(a.snapName)) throw new Error('bad checkpoint name') // lease: a Linux lease checkpoint, taken Off (MC-1501)
      if (s.poolTakeFail) return { failed: true, error: 'injected: Hyper-V could not take it' }
      const id = crypto.randomUUID()
      // poolTakeDelayed: the call fails and Hyper-V finishes the take later (a running job until it appears, at the
      // delayedAfter-th listing, as productionFailDelayed).
      if (s.poolTakeDelayed) { vm.delayedTake = { cp: { id, name: a.snapName, parentId: vm.parent, disk: { ...vm.disk } }, listings: 0 }; throw new Error('injected: the take call died; Hyper-V finishes it later') }
      vm.checkpoints.push({ id, name: a.snapName, parentId: vm.parent, disk: { ...vm.disk }, userinit: vm.userinit ?? null, enableLUA: vm.enableLUA ?? 1 })
      vm.parent = id
      if (s.poolTakeFailButMade) throw new Error('injected: the take call failed after Hyper-V made it')
      return { checkpointId: id }
    }
    // A take Hyper-V hasn't finished (productionFailDelayed) is a running job until it appears; jobsUnreadable fails.
    case 'jobs-idle': {
      if (s.jobsUnreadable) throw new Error('injected: the job state is unreadable')
      // finishOnIdle: the pending take finishes just as the job check runs (after the first, empty listing).
      if (s.finishOnIdle) for (const v of Object.values(s.vms)) if (v.delayedTake) { v.checkpoints.push(v.delayedTake.cp); v.delayedTake = null }
      const running = Object.values(s.vms).filter(v => v.delayedTake).length
      return { idle: running === 0, running }
    }
    case 'snapshot-remove': {
      const vm = own(s, a)
      if (s.snapRemoveFail > 0) { s.snapRemoveFail--; throw new Error('injected: removing the snapshot failed') }
      const cp = vm.checkpoints.find(c => c.id === a.checkpointId && c.name === a.snapName)
      if (cp) {
        for (const c of vm.checkpoints) if (c.parentId === cp.id) c.parentId = cp.parentId
        if (vm.parent === cp.id) vm.parent = cp.parentId
        vm.checkpoints = vm.checkpoints.filter(c => c !== cp)
        vm.removedSnaps = [...(vm.removedSnaps || []), a.snapName]
      }
      return { removed: !vm.checkpoints.some(c => c.id === a.checkpointId) }
    }
    // MC-1558: a Windows copy-in or vm_sync in bounded calls, as hv.ps1 and guest-sync.ps1 do it, on the guest's disk map:
    // the stage is vm.stages[guestStage] (canonical path -> base64 content). Knobs: copySlowMs (each item of copy-part
    // takes this long), copyStallAt: k (the k-th item ever blocks until the call is killed, once), copyStallAll (every
    // item blocks), copyStallRel (every item of that file blocks), syncGate and
    // syncPidFile (the apply waits for the gate file, to be killed mid-apply).
    case 'copy-prepare': case 'copy-part': case 'copy-lengths': case 'copy-apply': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      if (!/^C:\\hvmcp\\sync-\d{1,9}$/.test(a.guestStage)) throw new Error('bad guest staging folder')
      const keyOfRel = r => String(r).replace(/\//g, '\\').toUpperCase()
      vm.stages = vm.stages || {}
      if (op === 'copy-prepare') { vm.stages = { [a.guestStage]: {} }; return { prepared: true } }
      const st = vm.stages[a.guestStage]
      if (!st) throw new Error(`the staging folder '${a.guestStage}' does not exist`)
      if (op === 'copy-lengths') {
        const lengths = {}
        for (const r of a.rels) lengths[r] = st[keyOfRel(r)] === undefined ? -1 : Buffer.from(st[keyOfRel(r)], 'base64').length
        return { lengths }
      }
      if (op === 'copy-part') {
        let appended = 0, skipped = 0, n = 0
        s.copyPartCalls = [...(s.copyPartCalls || []), a.items.map(it => `${it.rel}@${it.offset}`)]
        save(s)
        for (const it of a.items) {
          s.copyItems = (s.copyItems || 0) + 1
          if (s.copyStallAll || s.copyStallRel === it.rel || s.copyStallAt === s.copyItems) { if (!s.copyStallAll) delete s.copyStallAt; save(s); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_600_000) }
          if (s.copySlowMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s.copySlowMs)
          const bytes = fs.readFileSync(it.src)
          if (bytes.length !== it.length) throw new Error(`part of '${it.rel}' is ${bytes.length} bytes, not ${it.length}`)
          const k = keyOfRel(it.rel)
          const cur = st[k] === undefined ? null : Buffer.from(st[k], 'base64')
          const len = cur ? cur.length : 0
          if (cur && len >= it.offset + it.length) { skipped++; continue }
          if (len !== it.offset) throw new Error(`the staged file '${it.rel}' is ${len} bytes, not the ${it.offset} this part follows`)
          st[k] = Buffer.concat([cur || Buffer.alloc(0), bytes]).toString('base64')
          appended++; n++
          s.copyParts = (s.copyParts || 0) + 1
          save(s) // each item is committed as it goes: a killed call keeps what it finished
        }
        return { appended, skipped }
      }
      // copy-apply
      if (a.kind === 'sync') s.syncs = [...(s.syncs || []), { files: a.files, remove: a.remove, full: a.full, delete: a.delete }]
      if (s.syncGate) {
        if (s.syncPidFile) fs.writeFileSync(s.syncPidFile, String(process.pid))
        save(s)
        while (!fs.existsSync(s.syncGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
      for (const f of a.files) if (st[keyOfRel(String(f).replace(/\//g, '\\'))] === undefined) throw new Error(`the staged file '${f}' is missing or not a plain file`)
      const B = 'c:\\build\\'
      const rel = p => String(p).replace(/\//g, '\\')
      const keysUnder = k => Object.keys(vm.disk).filter(d => d.toLowerCase() === k.toLowerCase() || d.toLowerCase().startsWith(k.toLowerCase() + '\\'))
      let removed = 0
      if (a.full) for (const d of Object.keys(vm.disk)) { if (d.toLowerCase().startsWith(B)) { delete vm.disk[d]; removed++ } }
      else {
        for (const r of a.remove) { const ks = keysUnder(`C:\\build\\${rel(r)}`); if (ks.length) removed++; for (const d of ks) delete vm.disk[d] }
        const blockers = new Set()
        for (const f of a.files) {
          const parts = rel(f).split('\\')
          for (let i = 1; i < parts.length; i++) { const up = `C:\\build\\${parts.slice(0, i).join('\\')}`; if (Object.keys(vm.disk).some(d => d.toLowerCase() === up.toLowerCase())) blockers.add(up) }
          const dst = `C:\\build\\${rel(f)}`
          if (keysUnder(dst).some(d => d.toLowerCase() !== dst.toLowerCase())) blockers.add(dst)
        }
        if (blockers.size && !a.delete) throw new Error(`with delete false, these are in the way and were left alone (nothing was changed): ${[...blockers].join(', ')}`)
        for (const b of blockers) for (const d of keysUnder(b)) delete vm.disk[d]
      }
      for (const f of a.files) {
        const dst = `C:\\build\\${rel(f)}`
        for (const d of Object.keys(vm.disk)) if (d.toLowerCase() === dst.toLowerCase()) delete vm.disk[d]
        vm.disk[dst] = st[keyOfRel(rel(f))]
      }
      delete vm.stages[a.guestStage]
      return { copied: a.files.length, removed }
    }
    case 'guest-logon': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      if (!a.logon?.user || !a.logon?.password) throw new Error('no account to log on')
      if (vm.userinit && vm.userinit !== USERINIT) throw new Error(`unexpected Userinit in the guest ('${vm.userinit}'): only Windows' own is changed`)
      vm.userinit = 'watcher'
      const lua = a.elevated ? 0 : (vm.enableLUA ?? 1)
      if (a.elevated) vm.enableLUA = 0
      vm.provisionChecks = 0
      const before = `boot-${vm.boot || 0}`
      vm.boot = (vm.boot || 0) + 1 // the restart: the disk (C:\build, C:\out) stays
      vm.loggedOn = s.logonNeverAppears ? null : a.logon.user
      vm.armed = true // AutoAdminLogon
      // The watcher (Userinit starts it in the session). MC-1518's cases: watcherLate: n session checks before it starts;
      // watcherNever: never; logonThenLogoff: n checks, then Windows logs the session off and clears autologon;
      // restartBeforeWatcher: the guest restarts once by itself while logged on (one check logged off, still armed), then
      // logs on again and the watcher starts. sessionFailAt: the k-th session check fails (a transient probe).
      vm.watcher = !s.logonNeverAppears && !s.watcherNever && !s.watcherLate && !s.logonThenLogoff && !s.restartBeforeWatcher
      vm.watcherIn = s.watcherLate || 0
      vm.logoffIn = s.logonThenLogoff || 0
      vm.restartPending = !!s.restartBeforeWatcher
      // MC-1524: logonDroppedUnseen: n: the first n logons are dropped by Windows before any check (the account gone,
      // autologon cleared, this boot's LSM events show one logon and one logoff). droppedEvents overrides those counts
      // (null: the log unreadable). droppedArmed keeps autologon armed (a restart pending, not a logoff).
      // A logon's own LSM event: there for every logon (logonNeverAppears too: its event, but no session to be seen).
      // MC-1526: logonSilent: n: the first n logons never begin: no event, no user; autologon stays armed, or is absent
      // (silentArmed: false). silentEvents overrides the count (null: the log unreadable).
      vm.lsm = { logons: 1, logoffs: 0 }
      if (s.logonSilent && (s.silentSoFar || 0) < s.logonSilent) {
        s.silentSoFar = (s.silentSoFar || 0) + 1
        vm.loggedOn = null; vm.armed = s.silentArmed !== false; vm.watcher = false
        vm.lsm = s.silentEvents !== undefined ? s.silentEvents : { logons: 0, logoffs: 0 }
      }
      if (s.logonDroppedUnseen && (s.droppedSoFar || 0) < s.logonDroppedUnseen) {
        s.droppedSoFar = (s.droppedSoFar || 0) + 1
        vm.loggedOn = null; vm.armed = !!s.droppedArmed
        vm.lsm = s.droppedEvents !== undefined ? s.droppedEvents : { logons: 1, logoffs: 1 }
      }
      vm.sessionChecks = 0
      vm.elevated = !!a.elevated // EnableLUA 0: the admin's session is elevated
      vm.logons = [...(vm.logons || []), { user: a.logon.user, elevated: !!a.elevated, lua }]
      if (s.extraRestart) vm.extraRestartPending = true
      return { boot: before }
    }
    case 'guest-session': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      vm.sessionChecks = (vm.sessionChecks || 0) + 1
      if (s.sessionFailAt && vm.sessionChecks === s.sessionFailAt) throw new Error('injected: the session probe failed')
      if (vm.relogonIn > 0 && --vm.relogonIn === 0) { vm.loggedOn = a.account; vm.watcher = true }
      if (vm.watcherIn > 0 && --vm.watcherIn === 0) vm.watcher = true
      if (vm.logoffIn > 0 && --vm.logoffIn === 0) { vm.loggedOn = null; vm.armed = false }
      // extraRestart: the guest restarts once more by itself after the watcher was first seen (MC-1504's trial).
      const r = { boot: `boot-${vm.boot || 0}`, sessions: vm.loggedOn === a.account && vm.watcher ? [1] : [], user: !!vm.loggedOn && vm.loggedOn === a.account, armed: vm.armed !== false, logons: vm.lsm ? vm.lsm.logons : 0, logoffs: vm.lsm ? vm.lsm.logoffs : 0 }
      if (vm.extraRestartPending && r.sessions.length) { vm.extraRestartPending = false; vm.boot++ }
      if (vm.restartPending && r.user) { vm.restartPending = false; vm.boot++; vm.loggedOn = null; vm.relogonIn = 2 }
      return r
    }
    // Runs (MC-1510): started (session 0) or published (interactive) in one call, then polled; a timeout's kill by PID.
    // A run's outcome is worked out when it finishes, by its command: "sleep" never finishes; "slow <k>" finishes on its
    // k-th poll; "fast" has finished before its start could read its creation time; "hang <file> <ms> <pid file>" blocks
    // the poll that finishes it (its PID recorded) for ms, then writes the file: a killed poll never does.
    // state.killMismatch: the PID at the kill is no longer the run's process; state.interactiveGate: the publish waits.
    // state.startDelayMs / publishDelayMs: a slow start or publish; state.pollDelayOnceMs: the next poll hangs that long.
    case 'guest-run-start':
    case 'guest-run-publish': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      const interactive = op === 'guest-run-publish'
      const slow = interactive ? s.publishDelayMs : s.startDelayMs
      if (slow) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slow)
      if (interactive) {
        if (s.interactiveThrows) { s.interactiveThrows = false; throw new Error('injected failure of the interactive run') }
        if (s.interactiveGate) {
          fs.writeFileSync(s.interactiveReached, 'reached')
          while (!fs.existsSync(s.interactiveGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
          Object.assign(s, load()) // the test may have set faults meanwhile: keep them when this call saves
        }
        if (!vm.logons?.length) throw new Error('no interactive logon in this guest (no watcher)')
      }
      vm.runs ??= {}
      // An interactive run is taken by the session's watcher: its account then, if the watcher is there.
      vm.runs[a.n] = { command: String(a.command), interactive, as: interactive ? null : (a.runAs ? a.runAs.user : 'admin'), polls: 0, taken: interactive ? (vm.watcher ? vm.loggedOn : null) : true }
      if (interactive) return { published: true }
      // runJobs (MC-1547): the run is started in its own job, named as hv.ps1 names it.
      return { pid: 4000 + a.n, started: String(a.command) === 'fast' ? null : `2026-11-13T00:00:${String(a.n).padStart(2, '0')}.0000000Z`, ...(s.runJobs ? { job: `hvmcp-run-${a.n}-${'0123456789abcdef'}` } : {}) }
    }
    case 'guest-run-poll': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      const run = vm.runs?.[a.n]
      if (!run) throw new Error(`no run ${a.n}`)
      if (s.pollDelayOnceMs) {
        const ms = s.pollDelayOnceMs
        s.pollDelayOnceMs = 0
        save(s) // the next poll doesn't hang
        if (s.pollPidFile) fs.writeFileSync(s.pollPidFile, String(process.pid))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
      }
      run.polls++
      if (run.result) return run.result
      const blank = { stdout: '', stdoutCut: false, stderr: '', stderrCut: false }
      if (!run.taken || (run.interactive && (vm.loggedOn !== run.taken || !vm.watcher))) return { ...blank, done: false, pending: run.interactive }
      const [cmd, ...rest] = run.command.replace(/^﻿/, '').split(' ') // MC-1577: a .ps1 setup script's BOM
      if (run.killed || cmd === 'sleep') return { ...blank, stdout: 'partial\r\n', done: false, pending: false }
      if (cmd === 'slow' && run.polls < Number(rest[0])) return { ...blank, done: false, pending: false }
      const put = (p, t) => { vm.disk[p.includes(':') ? p : `C:\\out\\${p}`] = Buffer.from(t).toString('base64') }
      const ok = (o = {}) => { run.result = { ...blank, done: true, exitCode: 0, ...o }; return run.result }
      if (cmd === 'hang') { // a long run: records its PID (rest[2]), and if it is ever let finish, leaves a marker (rest[0])
        if (rest[2]) fs.writeFileSync(rest[2], String(process.pid))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(rest[1] || 4000))
        fs.writeFileSync(rest[0], 'finished')
        return ok()
      }
      if (run.interactive) {
        const who = run.taken
        if (cmd === 'whoami') return ok({ stdout: `${who} session 1${vm.elevated ? ' elevated' : ''}` })
        if (cmd === 'killwatcher') { vm.watcher = false; return ok() }
        if (cmd === 'logoff') { vm.loggedOn = null; return ok() }
      }
      if (cmd === 'echo') return ok({ stdout: rest.join(' ') + '\r\n' })
      if (cmd === 'exit') return ok({ exitCode: Number(rest[0]) })
      if (cmd === 'fast' || cmd === 'slow') return ok({ stdout: `${cmd} done\r\n` })
      if (cmd === 'write') { put(rest[0], rest.slice(1).join(' ')); return ok() }
      if (cmd === 'cat') { const v = vm.disk[rest[0]]; return v === undefined ? ok({ exitCode: 1 }) : ok({ stdout: Buffer.from(v, 'base64').toString() }) }
      if (cmd === 'check') return ok({ exitCode: vm.disk[rest[0]] !== undefined ? 0 : 1 })
      if (cmd === 'whoami') return ok({ stdout: run.as })
      if (cmd === 'big') return ok({ stdout: 'x'.repeat(a.cap), stdoutCut: true })
      if (cmd === 'shutdown') { vm.state = 'Off'; return ok() }
      return ok({ exitCode: 9009, stderr: `'${cmd}' is not recognized` })
    }
    case 'guest-run-kill': {
      const vm = own(s, a)
      const run = Object.entries(vm.runs || {}).find(([n]) => 4000 + Number(n) === a.pid)?.[1]
      s.kills = [...(s.kills || []), { pid: a.pid, started: a.started, job: a.job ?? null }]
      // MC-1547: a run with a job is killed through it; jobKillFails: that can't be confirmed (never a PID fallback).
      if (a.job) {
        if (!run || run.result) return { killed: false, gone: true }
        if (s.jobKillFails) return { killed: false, jobFailed: true, why: 'processes were still in its job 10 s after it was terminated' }
        run.killed = true
        return { killed: true, via: 'job' }
      }
      if (!run || run.result) return { killed: false, gone: true }
      if (!a.started) return { killed: false, why: 'its identity was never recorded' }
      if (s.killMismatch) return { killed: false, why: `PID ${a.pid} is no longer the run's process (it exited and the PID was reused)` }
      run.killed = true
      return { killed: true }
    }
    case 'guest-list': {
      const vm = own(s, a)
      const files = Object.entries(vm.disk).filter(([p, v]) => p.toLowerCase().startsWith('c:\\out\\') && v !== '').map(([p, v]) => ({ path: p.slice(7).replace(/\\/g, '/'), size: Buffer.from(v, 'base64').length }))
      return { files, skipped: s.outLinks || [] }
    }
    case 'guest-read': {
      const vm = own(s, a)
      let total = 0
      const files = []
      for (const p of a.paths) {
        const v = vm.disk[`C:\\out\\${p.replace(/\//g, '\\')}`]
        if (v === undefined) continue
        const buf = Buffer.from(v, 'base64')
        const take = Math.min(buf.length, a.maxBytes, a.maxTotalBytes - total)
        if (take <= 0) break
        total += take
        files.push({ path: p, size: buf.length, cut: take < buf.length, data: buf.subarray(0, take).toString('base64') })
      }
      return { files }
    }
    case 'remove-vm': {
      if (!s.vms[a.vmId]) return { gone: true }
      own(s, a)
      delete s.vms[a.vmId]
      return { removed: true }
    }
    case 'new-switch': {
      if (!/^[0-9a-f]{32}$/.test(a.token || '')) throw new Error('a switch needs its ownership token')
      if (s.switches[a.name]) throw new Error(`a switch named ${a.name} already exists`)
      const id = crypto.randomUUID()
      s.switches[a.name] = { id, type: 'Internal', notes: `hvmcp:${a.token}` }
      if (s.failAfterSwitch) { s.failAfterSwitch = false; throw new Error('injected failure after New-VMSwitch') }
      return { switchId: id }
    }
    case 'remove-switch': {
      // Only by id or the token in its notes, never by name alone (as hv.ps1).
      const mine = Object.entries(s.switches).filter(([, sw]) => sw.type === 'Internal' && ((a.switchId && sw.id === a.switchId) || (/^[0-9a-f]{32}$/.test(a.token || '') && sw.notes === `hvmcp:${a.token}`)))
      if (mine.length) { delete s.switches[mine[0][0]]; return { removed: true } }
      return { gone: true, foreign: !!s.switches[a.name] }
    }
    case 'make-iso': {
      if (a.label === 'cidata') {
        // A Linux seed: only its public parts are kept (never the host key's private half).
        const u = JSON.parse(fs.readFileSync(join(a.source, 'user-data'), 'utf8').replace(/^#cloud-config\n/, ''))
        const file = path => u.write_files.find(w => w.path === path)?.content ?? null
        s.seeds = { ...(s.seeds || {}), [a.out]: { hostKey: u.ssh_keys.ed25519_public.split(' ').slice(0, 2).join(' '), authorized: u.users[0].ssh_authorized_keys, sudoers: file('/etc/sudoers.d/hvmcp'), socket: file('/etc/systemd/system/hvmcp-sshd.socket'), network: fs.readFileSync(join(a.source, 'network-config'), 'utf8') } }
        fs.writeFileSync(a.out, 'iso')
        return { out: a.out }
      }
      // The answer file it carries, kept (in the stub's state only) so tests can check the image index and key.
      const answer = join(a.source, 'autounattend.xml')
      if (fs.existsSync(answer)) s.answers = [...(s.answers || []), fs.readFileSync(answer, 'utf8').replace(/<Password>[\s\S]*?<\/Password>/g, '<Password>(not kept)</Password>')]
      fs.writeFileSync(a.out, 'iso')
      return { out: a.out }
    }
    case 'com-attach': { const vm = own(s, a); if (!/^hvmcp-diag-[0-9a-f]{16}$/.test(a.pipe)) throw new Error('bad pipe name'); vm.com = `\\\\.\\pipe\\${a.pipe}`; return { path: vm.com } }
    case 'com-read': {
      if (s.comReadFails) throw new Error('injected: the COM pipe could not be read')
      const lines = s.diagLines ?? ['HVMCP-DIAG stage=seed-read vmbus=present hv_sock_driver=present hv_sock_modinfo=present vsock_listen=inactive sshd_config_ok=yes kernel=6.12.117+deb13-cloud-amd64', 'HVMCP-DIAG stage=socket-up vmbus=present hv_sock_driver=present hv_sock_modinfo=present vsock_listen=active sshd_config_ok=yes kernel=6.12.117+deb13-cloud-amd64 secret=dropped']
      return { lines, connected: true, complete: true }
    }
    case 'com-detach': { const vm = own(s, a); if (!s.comStays) vm.com = null; return { path: vm.com || '' } }
    case 'vhd-convert': { fs.copyFileSync(a.vhd, a.vhdx); return { vhdx: a.vhdx } }
    case 'signatures': return { files: a.files.map(f => ({ file: f, ok: !s.signatureBad, why: s.signatureBad ? 'signature NotSigned' : null })) }
    case 'approval-acl': return { ok: !s.aclBad, why: s.aclBad || null }
    default: throw new Error(`unknown operation '${op}'`)
  }
}
