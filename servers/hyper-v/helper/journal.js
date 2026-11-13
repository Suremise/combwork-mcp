/**
 * The pool's durable journal: an append-only JSON-lines file in the helper's state folder. Every record is written and
 * flushed (fsync) before the side effect it announces, so a crash at any point leaves a record of what may have been
 * done. The pool's state is never stored separately: it is replayed from the journal at every start (it stays small:
 * a few records per VM per pool change).
 *
 * Records (t = type):
 *   epoch     { epoch }                                   first record; a fresh state gets a fresh random epoch
 *   image     { sha256, size, file, source, edition, build, pinned }   a verified image in the helper's own folder
 *   job       { jobId, op, planId, nonce }                a pool change began; its approval's nonce is now used
 *   intent    { jobId, intentId, vmName, folder, cores, memoryMB, diskGB }   about to create this VM, in this folder
 *   created   { intentId, vmId }                          New-VM returned this id
 *   ready     { intentId, vmId, cleanCheckpointId }       installed, set up, clean checkpoint taken
 *   rolledBack{ intentId }                                an unfinished create was undone
 *   removing  { jobId, vmId }                             about to remove this VM
 *   removed   { vmId }
 *   switch    { jobId, name, phase: 'creating'|'created'|'removing'|'removed', switchId? }
 *   jobEnd    { jobId, ok, note }
 *   quarantine{ vmId, why } / unquarantine { vmId }       a VM that couldn't be confirmed clean, and its release
 */
const fs = require('fs')
const crypto = require('crypto')
const { join } = require('path')

const FILE = 'journal.jsonl'

class Journal {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, FILE)
    this.records = []
    this.seq = 0
  }

  /** Reads every record; a fresh state gets its epoch. A torn last line (a crash mid-write) is ignored. */
  open() {
    fs.mkdirSync(this.dir, { recursive: true })
    let text = ''
    try { text = fs.readFileSync(this.file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      try {
        this.records.push(JSON.parse(lines[i]))
      } catch (e) {
        if (i < lines.length - 1 && lines.slice(i + 1).some(l => l.trim())) throw new Error(`journal record ${i + 1} is unreadable: ${e.message}`)
      }
    }
    this.seq = this.records.reduce((m, r) => Math.max(m, r.seq || 0), 0)
    if (!this.records.length || this.records[0].t !== 'epoch') {
      if (this.records.length) throw new Error('the journal has no epoch record: it was not written by this helper')
      this.append({ t: 'epoch', epoch: crypto.randomBytes(16).toString('hex') })
    }
    return this
  }

  get epoch() { return this.records[0].epoch }

  /** Appends one record and flushes it to disk before returning. */
  append(rec) {
    const r = { ...rec, seq: ++this.seq, at: new Date().toISOString() }
    const fd = fs.openSync(this.file, 'a')
    try {
      fs.writeSync(fd, JSON.stringify(r) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    this.records.push(r)
    return r
  }

  /**
   * The pool, replayed: { vms: Map<vmId, vm>, intents: Map<intentId, intent>, jobs, usedNonces, images, switch,
   * quarantined }. A vm is { vmId, vmName, folder, cores, memoryMB, diskGB, intentId, cleanCheckpointId, ready, removing }.
   */
  state() {
    const s = { vms: new Map(), intents: new Map(), jobs: new Map(), usedNonces: new Set(), images: new Map(), switch: null, quarantined: new Map() }
    for (const r of this.records) {
      switch (r.t) {
        case 'image': s.images.set(r.sha256, r); break
        case 'job': s.jobs.set(r.jobId, { ...r, ended: false }); if (r.nonce) s.usedNonces.add(r.nonce); break
        case 'jobEnd': { const j = s.jobs.get(r.jobId); if (j) Object.assign(j, { ended: true, ok: r.ok, note: r.note }); break }
        case 'intent': s.intents.set(r.intentId, { ...r, vmId: null, done: false }); break
        case 'created': {
          const i = s.intents.get(r.intentId)
          if (!i) break
          i.vmId = r.vmId
          s.vms.set(r.vmId, { vmId: r.vmId, vmName: i.vmName, folder: i.folder, cores: i.cores, memoryMB: i.memoryMB, diskGB: i.diskGB, intentId: i.intentId, cleanCheckpointId: null, ready: false, removing: false })
          break
        }
        case 'ready': {
          const vm = s.vms.get(r.vmId)
          if (vm) Object.assign(vm, { ready: true, cleanCheckpointId: r.cleanCheckpointId, readyAt: r.at })
          const i = s.intents.get(r.intentId)
          if (i) i.done = true
          break
        }
        case 'rolledBack': {
          const i = s.intents.get(r.intentId)
          if (i) { i.done = true; if (i.vmId) s.vms.delete(i.vmId) }
          break
        }
        case 'removing': { const vm = s.vms.get(r.vmId); if (vm) vm.removing = true; break }
        case 'removed': s.vms.delete(r.vmId); s.quarantined.delete(r.vmId); break
        case 'switch':
          if (r.phase === 'removed') s.switch = null
          else s.switch = { name: r.name, switchId: r.switchId ?? s.switch?.switchId ?? null, phase: r.phase, jobId: r.jobId }
          break
        case 'quarantine': s.quarantined.set(r.vmId, r.why); break
        case 'unquarantine': s.quarantined.delete(r.vmId); break
      }
    }
    return s
  }
}

module.exports = { Journal, FILE }
