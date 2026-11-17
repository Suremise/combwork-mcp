/**
 * The pool's durable journal: an append-only JSON-lines file in the helper's state folder. Every record is written and
 * flushed (fsync) before the side effect it announces, so a crash at any point leaves a record of what may have been
 * done. The pool's state is never stored separately: it is replayed from the journal at every start (it stays small:
 * a few records per VM per pool change).
 *
 * Records (t = type):
 *   epoch     { epoch }                                   first record; a fresh state gets a fresh random epoch
 *   image     { sha256, size, file, source, edition, build, imageIndex, pinned, evaluation }   a verified image in the
 *             helper's own folder, with its one edition (older records: evaluation when edition is EnterpriseEval)
 *   job       { jobId, op, planId, nonce }                a pool change began; its approval's nonce is now used
 *   intent    { jobId, intentId, vmName, folder, cores, memoryMB, diskGB }   about to create this VM, in this folder
 *   created   { intentId, vmId }                          New-VM returned this id
 *   online    { intentId }                                about to connect this unfinished VM to the Default Switch
 *                                                         to activate Windows (the approved plan's one online step)
 *   offline   { intentId }                                its adapter confirmed disconnected again
 *   ready     { intentId, vmId, cleanCheckpointId, licence }   installed, set up, clean checkpoint taken; licence:
 *             { kind: 'evaluation', expiresAt } or { kind: 'own', activated, status } (absent: built before MC-1513), or
 *             { kind: 'linux' } with transport, guest { id, versionId, serial, kernel } and diag (MC-1501)
 *   rolledBack{ intentId }                                an unfinished create was undone
 *   debugKept { intentId, vmId, why }                    MC-1545: a failed Linux build kept, on its plan's debug flag
 *   removing  { jobId, vmId }                             about to remove this VM
 *   removed   { vmId }
 *   switch    { jobId, name, phase: 'creating'|'created'|'removing'|'removed', token, switchId? }   token: written
 *             into the switch's Notes at creation, so it is recognised as the pool's even before its id is journalled
 *   jobEnd    { jobId, ok, note }
 *   quarantine{ vmId, why } / unquarantine { vmId }       a VM that couldn't be confirmed clean, and its release
 *   lcp-take  { opId, vmId, leaseId, name, snapName, origType }  MC-1529: before a lease checkpoint's take (its Hyper-V
 *             name is snapName, hvmcp-lease-<opId>; origType the VM's checkpoint type before it); lcp-taken { opId, checkpointId } once confirmed; lcp-drop { opId }
 *             before its removal; lcp-dropped { opId } once confirmed gone (or never made)
 *   pcp-select { opId, name, vmId, checkpointId, snapName, owner, image, os, at, sourceLease, replaces? }  MC-1532: a
 *             pool checkpoint published (its take, an lcp-take of the source lease, leaves the lease's records); the one
 *             it replaces starts retiring; pcp-retire { vmId, checkpointId } retires one by plan; pcp-retired
 *             { checkpointId } once its removal is confirmed
 *   rcl-begin { opId, vmId, oldClean, oldName, snapName }  MC-1531: a refresh of a VM's clean checkpoint begins (its new
 *             snapshot is snapName, hvmcp-clean-<opId>); rcl-taken { opId, checkpointId }; rcl-select { opId } makes it
 *             the VM's clean (the durable commit); rcl-abandoned { opId } (before select, cleaned up) or rcl-retired
 *             { opId } (after, the old clean removed) resolves it
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

  /**
   * Reads every record; a fresh state gets its epoch. A torn last line (a crash mid-write) is cut off the file, flushed,
   * before anything is appended: the file then ends at its last complete record, with its newline. A last record that
   * is complete JSON without its newline gets the newline. Any other unreadable line is an error.
   */
  open() {
    fs.mkdirSync(this.dir, { recursive: true })
    let buf = Buffer.alloc(0)
    try { buf = fs.readFileSync(this.file) } catch (e) { if (e.code !== 'ENOENT') throw e }
    let at = 0 // the byte offset just after the last complete record's newline
    let n = 0
    while (at < buf.length) {
      const nl = buf.indexOf(0x0a, at)
      const end = nl < 0 ? buf.length : nl
      const line = buf.toString('utf8', at, end)
      n++
      let rec
      try {
        rec = line.trim() ? JSON.parse(line) : null
      } catch (e) {
        if (nl >= 0 && buf.subarray(nl + 1).toString('utf8').trim()) throw new Error(`journal record ${n} is unreadable: ${e.message}`)
        this.repair(at, false) // a torn last line: cut it off
        break
      }
      if (rec) this.records.push(rec)
      if (nl < 0) { this.repair(buf.length, true); break } // complete, but its newline was never written
      at = nl + 1
    }
    this.seq = this.records.reduce((m, r) => Math.max(m, r.seq || 0), 0)
    if (!this.records.length || this.records[0].t !== 'epoch') {
      if (this.records.length) throw new Error('the journal has no epoch record: it was not written by this helper')
      this.append({ t: 'epoch', epoch: crypto.randomBytes(16).toString('hex') })
    }
    return this
  }

  /** Makes the file end at a complete record: truncates it to `length`, or adds the missing newline; then flushes. */
  repair(length, addNewline) {
    const fd = fs.openSync(this.file, 'r+')
    try {
      if (addNewline) fs.writeSync(fd, '\n', length)
      else fs.ftruncateSync(fd, length)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
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
    // leaseSnaps (MC-1529): lease checkpoints not yet confirmed removed, by opId: { opId, vmId, leaseId, name, snapName,
    // checkpointId (null until its take is confirmed), at, dropping }.
    // poolSnaps (MC-1532): published pool checkpoints by checkpointId: { checkpointId, opId, name, vmId, snapName, owner,
    // image, os, at, sourceLease, retiring }.
    const s = { vms: new Map(), intents: new Map(), jobs: new Map(), usedNonces: new Set(), images: new Map(), switch: null, quarantined: new Map(), leaseSnaps: new Map(), poolSnaps: new Map(), refreshes: new Map() }
    for (const r of this.records) {
      switch (r.t) {
        case 'image': s.images.set(r.sha256, r); break
        case 'job': s.jobs.set(r.jobId, { ...r, ended: false }); if (r.nonce) s.usedNonces.add(r.nonce); break
        case 'jobEnd': { const j = s.jobs.get(r.jobId); if (j) Object.assign(j, { ended: true, ok: r.ok, note: r.note }); break }
        case 'intent': s.intents.set(r.intentId, { ...r, vmId: null, done: false, online: false, offline: false }); break
        case 'online': { const i = s.intents.get(r.intentId); if (i) i.online = true; break }
        case 'offline': { const i = s.intents.get(r.intentId); if (i) i.offline = true; break }
        case 'created': {
          const i = s.intents.get(r.intentId)
          if (!i) break
          i.vmId = r.vmId
          s.vms.set(r.vmId, { vmId: r.vmId, vmName: i.vmName, folder: i.folder, cores: i.cores, memoryMB: i.memoryMB, diskGB: i.diskGB, intentId: i.intentId, cleanCheckpointId: null, ready: false, removing: false })
          break
        }
        case 'ready': {
          const vm = s.vms.get(r.vmId)
          if (vm) Object.assign(vm, { ready: true, cleanCheckpointId: r.cleanCheckpointId, readyAt: r.at, licence: r.licence ?? null, transport: r.transport ?? null, guest: r.guest ?? null })
          const i = s.intents.get(r.intentId)
          if (i) i.done = true
          break
        }
        // MC-1545: a failed Linux build kept for debugging: its intent is settled (no start rolls it back), and the VM,
        // never ready, is never leased or restored; a remove plan, or the next create or resize, removes it.
        case 'debugKept': {
          const i = s.intents.get(r.intentId)
          if (i) i.done = true
          const vm = s.vms.get(r.vmId)
          if (vm) vm.debugKept = { why: r.why, at: r.at }
          break
        }
        case 'rolledBack': {
          const i = s.intents.get(r.intentId)
          if (i) { i.done = true; if (i.vmId) s.vms.delete(i.vmId) }
          break
        }
        case 'removing': { const vm = s.vms.get(r.vmId); if (vm) vm.removing = true; break }
        case 'removed': s.vms.delete(r.vmId); s.quarantined.delete(r.vmId); for (const [k, x] of s.leaseSnaps) if (x.vmId === r.vmId) s.leaseSnaps.delete(k); for (const [k, x] of s.poolSnaps) if (x.vmId === r.vmId) s.poolSnaps.delete(k); for (const [k, x] of s.refreshes) if (x.vmId === r.vmId) s.refreshes.delete(k); break
        case 'switch':
          if (r.phase === 'removed') s.switch = null
          else s.switch = { name: r.name, switchId: r.switchId ?? s.switch?.switchId ?? null, token: r.token ?? s.switch?.token ?? null, phase: r.phase, jobId: r.jobId }
          break
        // MC-1529: a lease checkpoint's life: intent before the take, its id once confirmed, intent before removal, gone.
        case 'lcp-take': s.leaseSnaps.set(r.opId, { opId: r.opId, vmId: r.vmId, leaseId: r.leaseId, name: r.name, snapName: r.snapName, origType: r.origType ?? null, checkpointId: null, at: r.at, dropping: false }); break
        case 'lcp-taken': { const x = s.leaseSnaps.get(r.opId); if (x) x.checkpointId = r.checkpointId; break }
        case 'lcp-drop': { const x = s.leaseSnaps.get(r.opId); if (x) x.dropping = true; break }
        case 'lcp-dropped': s.leaseSnaps.delete(r.opId); break
        // MC-1532: a pool checkpoint published (out of the lease's records, durably), the one it replaces retiring in the
        // same record; retired by plan; gone once its removal is confirmed.
        case 'pcp-select': {
          const x = s.leaseSnaps.get(r.opId)
          s.leaseSnaps.delete(r.opId)
          s.poolSnaps.set(r.checkpointId, { checkpointId: r.checkpointId, opId: r.opId, name: r.name, vmId: r.vmId, snapName: x?.snapName ?? r.snapName, owner: r.owner, image: r.image, os: r.os, at: r.at, sourceLease: r.sourceLease, retiring: false })
          if (r.replaces && s.poolSnaps.has(r.replaces)) s.poolSnaps.get(r.replaces).retiring = true
          break
        }
        case 'pcp-retire': { const x = s.poolSnaps.get(r.checkpointId); if (x) x.retiring = true; break }
        // MC-1531: a refresh of a VM's clean checkpoint. Unresolved until abandoned (before select) or retired (after).
        case 'rcl-begin': s.refreshes.set(r.opId, { opId: r.opId, vmId: r.vmId, oldClean: r.oldClean, oldName: r.oldName, snapName: r.snapName, newId: null, selected: false }); break
        case 'rcl-taken': { const x = s.refreshes.get(r.opId); if (x) x.newId = r.checkpointId; break }
        case 'rcl-select': { const x = s.refreshes.get(r.opId); if (x) { x.selected = true; const vm = s.vms.get(x.vmId); if (vm) vm.cleanCheckpointId = x.newId } break }
        case 'rcl-abandoned': case 'rcl-retired': s.refreshes.delete(r.opId); break
        case 'pcp-retired': s.poolSnaps.delete(r.checkpointId); break
        case 'quarantine': s.quarantined.set(r.vmId, r.why); break
        case 'unquarantine': s.quarantined.delete(r.vmId); break
      }
    }
    return s
  }
}

module.exports = { Journal, FILE }
