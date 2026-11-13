/**
 * A fake hv.ps1 for the tests (HYPERV_MCP_PS_STUB): reads { op, args } on stdin like the real script and answers one
 * HVJSON: line. It keeps a fake Hyper-V in HYPERV_MCP_STUB_STATE (JSON): VMs with their checkpoints, state, network
 * switch, CPU reserve and guest files (a VM's disk), switches, and a log of every call.
 *
 * It enforces what hv.ps1 does: Get-OwnVm (the id must name a VM with the expected name inside the expected folder).
 * Guest commands are a tiny language: "echo <text>", "exit <n>", "sleep" (never ends), "write <path> <text>",
 * "check <path>" (exit 0 if it exists), "shutdown" (the guest shuts itself down: Off, its disk changes kept),
 * "hang <host file> <ms> <pid file>" (records its PID, blocks, then writes the file: a killed run never finishes).
 * restoreGate: a host path; restore waits until that file exists (to hold the VM's lock at a known point).
 * Faults (state.fail): { "<op>": n } fails the next n calls of op; restoreLeaves: { switchName, reserve, state } makes
 * restore leave that behind; signatureBad: true; aclBad: "<why>"; installNeverReady: true.
 */
const fs = require('fs')
const crypto = require('crypto')
const { join } = require('path')

const FILE = process.env.HYPERV_MCP_STUB_STATE
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { return {} } }
const save = s => fs.writeFileSync(FILE, JSON.stringify(s, null, 1))
const answer = o => { process.stdout.write('HVJSON:' + JSON.stringify(o) + '\n') }
const norm = p => String(p).replace(/[\\/]+$/, '').toLowerCase()
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
    case 'facts': return { hyperv: true, logicalCpus: 16, memoryMB: 65536, folders: (a.folders || []).map(folder => ({ folder, freeGB: s.freeGB ?? 500 })) }
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
    case 'guest-ready': { const vm = own(s, a); return { ready: vm.state === 'Running' && vm.installed !== false } }
    case 'guest-setup': { const vm = own(s, a); vm.disk['C:\\build'] = ''; return { editionId: s.guestEdition ?? 'EnterpriseEval', build: '26200', ubr: 6584 } }
    case 'make-clean': {
      const vm = own(s, a)
      vm.state = 'Off'
      vm.switchName = null
      vm.reserve = 0
      const id = crypto.randomUUID()
      vm.checkpoints = [{ id, name: 'clean', disk: { ...vm.disk } }]
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
      vm.restores = (vm.restores || 0) + 1
      if (s.restoreLeaves) Object.assign(vm, s.restoreLeaves)
      return facts(vm)
    }
    case 'configure-start': {
      const vm = own(s, a)
      if (vm.state !== 'Off') throw new Error('the VM is not Off after its restore')
      if (a.switchName) {
        const sw = s.switches[a.switchName]
        if (!a.switchId) throw new Error(`no recorded id for switch ${a.switchName}`)
        if (!sw || sw.id !== a.switchId || sw.type !== 'Internal') throw new Error(`switch ${a.switchName} (id ${a.switchId}) is missing, renamed or not internal`)
        vm.switchName = a.switchName
      }
      vm.reserve = a.reserve
      vm.state = 'Running'
      vm.disk['C:\\out'] = ''
      return { started: true }
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
    case 'guest-run': {
      const vm = own(s, a)
      if (vm.state !== 'Running') throw new Error('the VM is not running')
      const [cmd, ...rest] = String(a.command).split(' ')
      const put = (p, t) => { vm.disk[p.includes(':') ? p : `C:\\out\\${p}`] = Buffer.from(t).toString('base64') }
      const base = { exitCode: 0, timedOut: false, killed: false, stdout: '', stdoutCut: false, stderr: '', stderrCut: false, as: a.runAs ? a.runAs.user : 'admin' }
      if (cmd === 'echo') return { ...base, stdout: rest.join(' ') + '\r\n' }
      if (cmd === 'exit') return { ...base, exitCode: Number(rest[0]) }
      if (cmd === 'sleep') return { ...base, exitCode: null, timedOut: true, killed: true }
      if (cmd === 'write') { put(rest[0], rest.slice(1).join(' ')); return base }
      if (cmd === 'check') return { ...base, exitCode: vm.disk[rest[0]] !== undefined ? 0 : 1 }
      if (cmd === 'whoami') return { ...base, stdout: base.as }
      if (cmd === 'big') return { ...base, stdout: 'x'.repeat(a.cap), stdoutCut: true }
      if (cmd === 'shutdown') { vm.state = 'Off'; return base }
      if (cmd === 'hang') { // a long run: records its PID (rest[2]), and if it is ever let finish, leaves a marker (rest[0])
        if (rest[2]) fs.writeFileSync(rest[2], String(process.pid))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(rest[1] || 4000))
        fs.writeFileSync(rest[0], 'finished')
        return base
      }
      return { ...base, exitCode: 9009, stderr: `'${cmd}' is not recognized` }
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
    case 'make-iso': fs.writeFileSync(a.out, 'iso'); return { out: a.out }
    case 'signatures': return { files: a.files.map(f => ({ file: f, ok: !s.signatureBad, why: s.signatureBad ? 'signature NotSigned' : null })) }
    case 'approval-acl': return { ok: !s.aclBad, why: s.aclBad || null }
    default: throw new Error(`unknown operation '${op}'`)
  }
}
