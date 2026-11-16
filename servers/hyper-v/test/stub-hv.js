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
 * Defender (MC-1519): guest-defender records the exclusions (vm.exclusions) and answers them with real-time on;
 * defenderOverride: fields it reports instead.
 * Logon diagnostics (MC-1520): guest-logon-diag answers state.diag, or a sample that also carries fields the helper must
 * drop (an event message, a command line, a password), to show only the allowlisted ones are kept.
 */
const fs = require('fs')
const crypto = require('crypto')
const { join } = require('path')

const FILE = process.env.HYPERV_MCP_STUB_STATE
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
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
  s.calls.push({ op, argv: process.argv.slice(2), vmId: a.vmId, command: a.command })
  save(s) // logged before it runs, so a test can see a call in progress
  try {
    if (s.fail[op] > 0) { s.fail[op]--; throw new Error(`injected failure of ${op}`) }
    const r = run(s, op, a)
    save(s)
    answer({ result: r })
  } catch (e) {
    save(s)
    answer({ error: e.message })
  }
})

function own(s, a) {
  const vm = s.vms[a.vmId]
  if (!vm) throw new Error(`VM ${a.vmId} does not exist`)
  if (vm.name !== a.name) throw new Error(`VM ${a.vmId} is named '${vm.name}', not '${a.name}': not the pool's`)
  if (!under(vm.location, a.folder)) throw new Error(`VM ${a.name} is not in its pool folder: not the pool's`)
  return vm
}
const facts = vm => ({ vmId: vm.id, state: vm.state, parentCheckpointId: vm.parent, checkpointIds: vm.checkpoints.map(c => c.id), switchName: vm.switchName, reserve: vm.reserve })

function run(s, op, a) {
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
    case 'guest-defender': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      vm.exclusions = [...new Set([...(vm.exclusions || []), ...a.paths])]
      return { exclusions: vm.exclusions, realTime: true, service: true, tamper: true, ...(s.defenderOverride || {}) }
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
      fs.writeFileSync(join(a.folder, 'disk.vhdx'), 'vhd')
      s.vms[id] = { id, name: a.name, location: join(a.folder, a.name), state: 'Off', checkpoints: [], parent: null, switchName: null, reserve: 0, disk: {}, cores: a.cores, memoryMB: a.memoryMB, installed: false }
      if (s.failAfterCreate) { s.failAfterCreate = false; throw new Error('injected failure after New-VM') }
      return { vmId: id }
    }
    case 'start-vm': { const vm = own(s, a); vm.state = 'Running'; vm.installed = !s.installNeverReady; return { started: true } }
    case 'guest-ready': {
      const vm = own(s, a)
      // readyGate: PowerShell Direct hangs (records its PID in readyPidFile, then waits for the gate file); notReady: the
      // guest never answers.
      if (s.readyGate) {
        if (s.readyPidFile) fs.writeFileSync(s.readyPidFile, String(process.pid))
        while (!fs.existsSync(s.readyGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
      if (s.notReady) return { ready: false }
      return { ready: vm.state === 'Running' && vm.installed !== false }
    }
    // MC-1531 knobs: setupMarker (written to C:\marker.txt, a stand-in for a fix the setup applies), setupThrows,
    // setupEntered + setupGate (held as it begins).
    case 'guest-setup': { const vm = own(s, a); if (s.setupEntered) fs.writeFileSync(s.setupEntered, 'entered'); if (s.setupGate) while (!fs.existsSync(s.setupGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); if (s.setupThrows) throw new Error('injected: the guest setup failed'); vm.disk['C:\\build'] = ''; if (s.setupMarker) vm.disk['C:\\marker.txt'] = Buffer.from(s.setupMarker).toString('base64'); return { editionId: s.guestEdition ?? 'EnterpriseEval', build: '26200', ubr: 6584, disableForceUnload: 1, ...(s.setupOverride || {}) } }
    case 'make-clean': {
      const vm = own(s, a)
      vm.state = 'Off'
      vm.switchName = null
      vm.reserve = 0
      const id = crypto.randomUUID()
      vm.checkpoints = [{ id, name: 'clean', parentId: null, disk: { ...vm.disk }, userinit: vm.userinit ?? null, enableLUA: vm.enableLUA ?? 1 }]
      vm.parent = id
      return { checkpointId: id }
    }
    case 'restore': {
      const vm = own(s, a)
      if (s.restoreGate) while (!fs.existsSync(s.restoreGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25) // held until the test opens the gate
      const cp = vm.checkpoints.find(c => c.id === a.checkpointId)
      if (!cp) throw new Error('its clean checkpoint (by id) is missing')
      vm.state = 'Off'
      vm.parent = cp.id
      vm.switchName = null
      vm.reserve = 0
      vm.disk = { ...cp.disk }
      vm.loggedOn = null; vm.watcher = false; vm.elevated = false
      vm.userinit = cp.userinit ?? null; vm.enableLUA = cp.enableLUA ?? 1 // the checkpoint's
      vm.restores = (vm.restores || 0) + 1
      if (s.restoreLeaves && (!s.restoreLeavesWhen || fs.existsSync(s.restoreLeavesWhen))) Object.assign(vm, s.restoreLeaves) // restoreLeavesWhen: only once that file exists
      return facts(vm)
    }
    case 'configure-start': {
      const vm = own(s, a)
      if (s.configureEntered) fs.writeFileSync(s.configureEntered, 'entered')
      if (s.configureGate) while (!fs.existsSync(s.configureGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      if (vm.state !== 'Off') throw new Error('the VM is not Off after its restore')
      if (a.switchName) {
        const sw = s.switches[a.switchName]
        if (!a.switchId) throw new Error(`no recorded id for switch ${a.switchName}`)
        if (!sw || sw.id !== a.switchId || sw.type !== 'Internal') throw new Error(`switch ${a.switchName} (id ${a.switchId}) is missing, renamed or not internal`)
        vm.switchName = a.switchName
      } else vm.switchName = null // MC-1529: network off is disconnected, whatever a restored checkpoint's adapter said
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
      const cp = { id, name: a.snapName, parentId: vm.parent, disk: { ...vm.disk }, switchName: vm.switchName, reserve: vm.reserve, production: true }
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
      vm.state = 'Off' // a production checkpoint restores Off
      vm.parent = cp.id
      vm.disk = { ...cp.disk }
      vm.switchName = cp.switchName ?? null // the checkpoint's own configuration, until the start reapplies the lease's
      vm.reserve = cp.reserve ?? 0
      vm.loggedOn = null; vm.watcher = false; vm.elevated = false
      return facts(vm)
    }
    // factsParentWrong: the next facts-vm reports another parent (a verification mismatch), once.
    case 'facts-vm': { const vm = own(s, a); if (s.factsParentWrong) { delete s.factsParentWrong; return { ...facts(vm), parentCheckpointId: 'someone-else' } } return facts(vm) }
    // MC-1532: a pool checkpoint's steps. Knobs: disconnectFails (the adapter stays connected), shutdownFails (the guest
    // stays Running), poolTakeFail (Hyper-V's terminal failure), poolTakeEntered + poolTakeGate (held before the take).
    case 'net-disconnect': { const vm = own(s, a); if (!s.disconnectFails) vm.switchName = null; return facts(vm) }
    case 'guest-shutdown': { const vm = own(s, a); if (!s.shutdownFails) { vm.state = 'Off'; vm.loggedOn = null; vm.watcher = false } return facts(vm) }
    case 'pool-take': {
      const vm = own(s, a)
      if (s.poolTakeEntered) fs.writeFileSync(s.poolTakeEntered, 'entered')
      if (s.poolTakeGate) while (!fs.existsSync(s.poolTakeGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      if (vm.state !== 'Off') throw new Error(`the VM is ${vm.state}, not Off`)
      if (!/^hvmcp-(pool|clean)-[0-9a-f]{12}$/.test(a.snapName)) throw new Error('bad checkpoint name')
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
    case 'copy-in': {
      const vm = own(s, a)
      const walk = (dir, rel) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}\\${e.name}` : e.name
          if (e.isDirectory()) walk(join(dir, e.name), r)
          else vm.disk[`C:\\build\\${r}`] = fs.readFileSync(join(dir, e.name)).toString('base64')
        }
      }
      walk(a.source, '')
      return { ms: 5 }
    }
    case 'sync-in': {
      // As guest-sync.ps1 on the guest's disk map (its path checks are proved on real trees by guest-sync.test.js).
      // syncGate: a host path; the apply waits for it (records its PID in syncPidFile first), to be killed mid-apply.
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      if (!/^C:\\hvmcp\\sync-\d{1,9}$/.test(a.guestStage)) throw new Error('bad guest staging folder')
      s.syncs = [...(s.syncs || []), { files: a.files, remove: a.remove, full: a.full, delete: a.delete }]
      if (s.syncGate) {
        if (s.syncPidFile) fs.writeFileSync(s.syncPidFile, String(process.pid))
        save(s)
        while (!fs.existsSync(s.syncGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
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
        vm.disk[dst] = fs.readFileSync(join(a.source, ...rel(f).split('\\'))).toString('base64')
      }
      return { ms: 5, copied: a.files.length, removed }
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
      return { pid: 4000 + a.n, started: String(a.command) === 'fast' ? null : `2026-11-13T00:00:${String(a.n).padStart(2, '0')}.0000000Z` }
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
      const [cmd, ...rest] = run.command.split(' ')
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
      s.kills = [...(s.kills || []), { pid: a.pid, started: a.started }]
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
      // The answer file it carries, kept (in the stub's state only) so tests can check the image index and key.
      const answer = join(a.source, 'autounattend.xml')
      if (fs.existsSync(answer)) s.answers = [...(s.answers || []), fs.readFileSync(answer, 'utf8').replace(/<Password>[\s\S]*?<\/Password>/g, '<Password>(not kept)</Password>')]
      fs.writeFileSync(a.out, 'iso')
      return { out: a.out }
    }
    case 'signatures': return { files: a.files.map(f => ({ file: f, ok: !s.signatureBad, why: s.signatureBad ? 'signature NotSigned' : null })) }
    case 'approval-acl': return { ok: !s.aclBad, why: s.aclBad || null }
    default: throw new Error(`unknown operation '${op}'`)
  }
}
