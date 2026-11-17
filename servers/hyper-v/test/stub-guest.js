/**
 * A fake Linux guest for the tests (HYPERV_MCP_SSH_STUB, MC-1501): run instead of ssh.exe, with the VM id as its one
 * argument and the dispatcher's stdin (one JSON request, then a sync's file bytes); answers one HVJSON: line, as
 * guest.py does. It works on the same stub state as stub-hv.js: the VM's disk is its `disk` map (Linux paths such as
 * /build/x), so restores and checkpoints carry it as they do a Windows guest's.
 *
 * A guest that isn't running (or never comes up: state.linuxNeverReady) answers nothing and exits 255, as ssh does
 * when it can't connect. verify answers from the VM's seed (its public parts, as stub-hv kept them), with
 * state.linuxGuest ({ id, versionId, serial, kernel }, default Debian 13), state.cloudInitStatus (default done) and
 * state.verifyOverride (fields answered instead). Runs use stub-hv's tiny language (echo, exit, sleep, slow, write,
 * cat, check, whoami, big, shutdown); a sync checks each file's size and hash as guest.py does (its no-follow rules
 * are proved on real trees by guest_py_check.py).
 */
const fs = require('fs')
const crypto = require('crypto')

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
const save = st => fs.writeFileSync(FILE, JSON.stringify(st, null, 1))
const answer = o => process.stdout.write('HVJSON:' + JSON.stringify(o) + '\n')
const vmId = process.argv[2]

const chunks = []
process.stdin.on('data', d => chunks.push(d))
process.stdin.on('end', () => {
  const buf = Buffer.concat(chunks)
  const nl = buf.indexOf(10)
  const req = JSON.parse(buf.subarray(0, nl < 0 ? buf.length : nl).toString('utf8'))
  const data = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1)
  const s = load()
  s.sshCalls = [...(s.sshCalls || []), { vmId, op: req.op, command: req.command }]
  const vm = s.vms?.[vmId]
  if (!vm || vm.state !== 'Running' || vm.installed === false || s.linuxNeverReady) {
    save(s)
    process.stderr.write('ssh: connect to host hvmcp port 22: Connection refused\n')
    process.exit(255)
  }
  if (s.sshFail?.[req.op] > 0) { s.sshFail[req.op]--; save(s); answer({ error: `injected failure of ${req.op}` }); return }
  try {
    const r = run(s, vm, req, data)
    save(s)
    answer({ result: r })
  } catch (e) {
    save(s)
    answer({ error: e.message })
  }
})

const b64 = t => Buffer.from(t).toString('base64')
const under = (vm, root) => Object.keys(vm.disk).filter(k => k.startsWith(root + '/'))

function run(s, vm, req, data) {
  switch (req.op) {
    case 'ready': return { ready: true, boot: `boot-${vm.boot || 0}` }
    case 'verify': {
      const g = { id: 'debian', versionId: '13', serial: null, kernel: '6.12.117+deb13-cloud-amd64', ...(s.linuxGuest || {}) }
      return {
        ...g, cloudInit: s.cloudInitStatus || 'done', hostKey: vm.seed?.hostKey ?? null, otherHostKeys: [], authorizedKeys: vm.seed?.authorized ?? null,
        sudoers: vm.seed?.sudoers ?? null, sshdConfigOk: true, socket: { active: 'active', enabled: 'enabled' }, ssh: { active: 'inactive', enabled: 'masked' },
        sshSocket: { active: 'inactive', enabled: 'masked' }, addresses: [], listeners: [], hvSockDriver: true, cloudInitDisabled: vm.disk['/etc/cloud/cloud-init.disabled'] !== undefined,
        paths: { '/build': { mode: '0o755', uid: 0, dir: true }, '/out': { mode: '0o775', uid: 0, dir: true }, '/hvmcp': { mode: '0o711', uid: 0, dir: true } },
        boot: `boot-${vm.boot || 0}`, ...(s.verifyOverride || {})
      }
    }
    case 'finish': vm.disk['/etc/cloud/cloud-init.disabled'] = b64('off'); return { finished: true }
    case 'poweroff': vm.state = 'Off'; return { poweringOff: true }
    case 'run-start': {
      if (!['bash', 'sh'].includes(req.shell)) throw new Error('shell must be bash or sh')
      vm.runs ??= {}
      // As guest.py: a run of this number in this boot is refused; one from an earlier boot is replaced.
      if (vm.runs[req.n]?.boot === `boot-${vm.boot || 0}`) throw new Error(`run ${req.n} already exists`)
      vm.runs[req.n] = { command: String(req.command), as: req.as === 'user' ? 'hvuser' : 'root', cwd: req.cwd, polls: 0, boot: `boot-${vm.boot || 0}` }
      return { started: true, unit: `hvmcp-run-${req.n}`, boot: `boot-${vm.boot || 0}` }
    }
    case 'run-poll': {
      const r = vm.runs?.[req.n]
      if (!r) throw new Error(`no run ${req.n}`)
      r.polls++
      if (r.result) return r.result
      const blank = { stdout: '', stdoutCut: false, stderr: '', stderrCut: false, pending: false }
      const [cmd, ...rest] = r.command.split(' ')
      if (r.killed || cmd === 'sleep') return { ...blank, stdout: 'partial\n', done: false }
      if (cmd === 'slow' && r.polls < Number(rest[0])) return { ...blank, done: false }
      const ok = (o = {}) => { r.result = { ...blank, done: true, exitCode: 0, ...o }; return r.result }
      const at = p => (p.startsWith('/') ? p : `/out/${p}`)
      if (cmd === 'echo') return ok({ stdout: rest.join(' ') + '\n' })
      if (cmd === 'exit') return ok({ exitCode: Number(rest[0]) })
      if (cmd === 'slow') return ok({ stdout: 'slow done\n' })
      if (cmd === 'write') { vm.disk[at(rest[0])] = b64(rest.slice(1).join(' ')); return ok() }
      if (cmd === 'cat') { const v = vm.disk[at(rest[0])]; return v === undefined ? ok({ exitCode: 1, stderr: `cat: ${rest[0]}: No such file or directory\n` }) : ok({ stdout: Buffer.from(v, 'base64').toString() }) }
      if (cmd === 'check') return ok({ exitCode: vm.disk[at(rest[0])] !== undefined ? 0 : 1 })
      if (cmd === 'whoami') return ok({ stdout: `${r.as}\n` })
      if (cmd === 'pwd') return ok({ stdout: `${r.cwd}\n` })
      if (cmd === 'big') return ok({ stdout: 'x'.repeat(req.cap), stdoutCut: true })
      if (cmd === 'shutdown') { vm.state = 'Off'; return ok() }
      return ok({ exitCode: 127, stderr: `bash: ${cmd}: command not found\n` })
    }
    case 'run-kill': {
      const r = vm.runs?.[req.n]
      s.kills = [...(s.kills || []), { n: req.n, boot: req.boot }]
      if (req.boot && req.boot !== `boot-${vm.boot || 0}`) return { killed: false, why: 'the guest has restarted since the run started' }
      if (!r || r.result) return { killed: false, gone: true }
      r.killed = true
      return { killed: true, gone: true }
    }
    case 'sync': {
      // syncGate: a host path; the apply waits for it (records its PID in syncPidFile first), to be killed mid-apply.
      if (s.syncGate) {
        if (s.syncPidFile) fs.writeFileSync(s.syncPidFile, String(process.pid))
        save(s)
        while (!fs.existsSync(s.syncGate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
      let off = 0
      const files = []
      for (const f of req.files) {
        const body = data.subarray(off, off + f.size)
        off += f.size
        if (body.length !== f.size) throw new Error('the stream ended early')
        if (crypto.createHash('sha256').update(body).digest('hex') !== f.sha256) throw new Error(`${f.path} arrived with another hash`)
        files.push([`/build/${f.path}`, body])
      }
      s.syncs = [...(s.syncs || []), { files: req.files.map(f => f.path), remove: req.remove, full: req.full, delete: req.delete, gen: req.gen, linux: true }]
      let removed = 0
      if (req.full) for (const k of under(vm, '/build')) { delete vm.disk[k]; removed++ }
      else for (const p of req.remove) { const k = `/build/${p}`; const ks = Object.keys(vm.disk).filter(d => d === k || d.startsWith(k + '/')); if (ks.length) removed++; for (const d of ks) delete vm.disk[d] }
      for (const [k, body] of files) vm.disk[k] = body.toString('base64')
      return { copied: files.length, removed }
    }
    case 'list': {
      const files = under(vm, '/out').filter(k => vm.disk[k] !== '').map(k => ({ path: k.slice(5), size: Buffer.from(vm.disk[k], 'base64').length }))
      return { files, skipped: s.outLinks || [] }
    }
    case 'read': {
      let total = 0
      const files = []
      for (const p of req.paths) {
        const v = vm.disk[`/out/${p}`]
        if (v === undefined) continue
        const b = Buffer.from(v, 'base64')
        const take = Math.min(b.length, req.maxBytes, req.maxTotalBytes - total)
        if (take <= 0) break
        total += take
        files.push({ path: p, size: b.length, cut: take < b.length, data: b.subarray(0, take).toString('base64') })
      }
      return { files }
    }
    default: throw new Error('an unknown operation')
  }
}
