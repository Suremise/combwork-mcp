/**
 * The pool's hard limits, from policy.json in the helper's state folder. Only the elevated setup writes it (the folder's
 * ACL gives the service read and write to its own records, but setup owns policy.json: the helper never writes it).
 * Every pool change is checked against it under the pool lock, whatever its plan or approval says, so even a forged
 * approval can't go beyond it.
 */
const fs = require('fs')
const { join, win32 } = require('path')
const net = require('./net')
const timing = require('./timing')

const FILE = 'policy.json'
const PREFIX_RE = /^[a-z][a-z0-9]{1,11}$/

const DEFAULTS = {
  schema: 1,
  prefix: 'hvmcp',
  maxVms: 4,
  maxCoresPerVm: 4,
  maxMemoryMBTotal: 16 * 1024,
  maxDiskGBPerVm: 128,
  diskFolders: [],
  maxNetwork: 'none',
  maxReservePercent: 100,
  maxLeaseMinutes: 240,
  maxSessionMinutes: 480,
  maxBuildMB: 2048,
  buildRoots: [],
  // MC-1576: 'within-caps' (plans within the policy apply; a new image, a guest setup script or a ready-made disk still
  // needs the user's approval) or 'each' (every plan approved). A policy from before it has none: within-caps.
  approvePoolChanges: 'within-caps'
}

// MC-1579: the policy's numbers have no ceiling of their own, and lower bounds stay only where a smaller value can't
// work. VMs, cores, memory and disk have none here: their maximums depend on the host's Hyper-V version, so Hyper-V itself
// refuses a VM beyond them, by name, when it is created. The one Hyper-V limit checked here is the checkpoints of a VM:
// 50 on every version Microsoft lists (Windows Server 2016 to 2025), and passing it would fail a checkpoint mid-lease.
const HV = Object.freeze({ checkpoints: 50 })
// A VM holds its clean checkpoint, its pool checkpoints (maxCheckpointsPerVm, counting retiring ones and ones being
// taken), the lease's own (maxLeaseCheckpoints), and for a moment during a refresh a second clean one: so the two
// policy numbers together may be at most Hyper-V's 50 less those 2.
const CHECKPOINTS_FREE = HV.checkpoints - 2
const DEFAULT_LEASE_CHECKPOINTS = 3
const DEFAULT_POOL_CHECKPOINTS = 4
// Whole numbers stay exact up to here; a larger one would be rounded.
const ANY = Number.MAX_SAFE_INTEGER
const PROJECT_RE = /^[a-z][a-z0-9-]{0,31}$/
const OSES = ['windows', 'linux']
/** A project's cap as { os: n }: a plain number means Windows (the only kind before images had an OS). */
const byOs = v => v === undefined ? undefined : typeof v === 'number' ? { windows: v } : v
/** Why a policy folder isn't an absolute local folder (not UNC, a device path, a drive root or with ".."), or null. */
const folderProblem = f =>
  typeof f !== 'string' || !/^[a-zA-Z]:[\\/]/.test(f) || f.split(/[\\/]/).includes('..') || win32.parse(f).root === win32.normalize(f)
    ? 'must be an absolute local folder (X:\\...), not a drive root, with no ".."' : null
const tidy = f => win32.normalize(f).replace(/\\+$/, '')

const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi

/** Problems with a policy, [] when it is usable. */
function problems(p) {
  const out = []
  if (p.schema !== 1) out.push(`schema ${p.schema} is not 1`)
  if (!PREFIX_RE.test(p.prefix ?? '')) out.push('prefix must be 2-12 lower-case letters and digits, starting with a letter')
  if (!int(p.maxVms, 1, ANY)) out.push('maxVms must be a whole number, at least 1')
  if (!int(p.maxCoresPerVm, 1, ANY)) out.push('maxCoresPerVm must be a whole number, at least 1')
  if (!int(p.maxMemoryMBTotal, 2048, ANY)) out.push('maxMemoryMBTotal must be a whole number, at least 2048')
  if (!int(p.maxDiskGBPerVm, 64, ANY)) out.push('maxDiskGBPerVm must be a whole number, at least 64 (Windows 11 needs 64 GB)')
  if (!Array.isArray(p.diskFolders) || !p.diskFolders.length) out.push('diskFolders must name at least one folder')
  else for (const f of p.diskFolders) if (typeof f !== 'string' || !win32.isAbsolute(f) || /^\\\\/.test(f) || win32.parse(f).root === win32.normalize(f)) out.push(`disk folder "${f}" must be an absolute local folder, not a drive root`)
  // MC-1556: the highest network mode a pool may be planned with (setup's -MaxNetwork). A policy from before it has
  // allowNetwork instead: true reads as host, false as none.
  if (p.maxNetwork !== undefined && !net.isMode(p.maxNetwork)) out.push(`maxNetwork must be one of ${net.MODES.join(', ')}`)
  if (p.maxNetwork === undefined && typeof p.allowNetwork !== 'boolean') out.push('maxNetwork must be set (or, from an older setup, allowNetwork true or false)')
  // Host mode's switch and addresses, made by setup: required for a policy that allows host or above.
  if (p.hostNetwork !== undefined) { const why = net.hostNetworkProblem(p.hostNetwork); if (why) out.push(why) }
  out.push(...timing.capsProblems(p.timingCaps)) // MC-1558: each a known key, a number within its floor and maximum
  if (p.approvePoolChanges !== undefined && !['within-caps', 'each'].includes(p.approvePoolChanges)) out.push('approvePoolChanges must be within-caps or each')
  if (!int(p.maxReservePercent, 0, 100)) out.push('maxReservePercent must be 0-100')
  // MC-1579: leases and sessions have no ceiling (formerly 24 h): the helper waits for a deadline past Node's timer
  // limit in steps, and ends a session no later than the last date JavaScript can hold (core.js, DATE_MAX_MS).
  if (!int(p.maxLeaseMinutes, 1, ANY)) out.push('maxLeaseMinutes must be a whole number, at least 1')
  // A work session's cap (vm_renew), optional so a policy from before it stays usable; never below one lease.
  if (p.maxSessionMinutes !== undefined && (!int(p.maxSessionMinutes, 1, ANY) || p.maxSessionMinutes < p.maxLeaseMinutes)) out.push('maxSessionMinutes must be a whole number, at least maxLeaseMinutes')
  if (!int(p.maxBuildMB, 1, ANY)) out.push('maxBuildMB must be a whole number, at least 1')
  // MC-1529: lease checkpoints, optional (defaults 3 and 20 GB): how many one lease may hold, and the free space the
  // VM folder's drive must keep for a take.
  if (p.maxLeaseCheckpoints !== undefined && !int(p.maxLeaseCheckpoints, 0, CHECKPOINTS_FREE)) out.push(`maxLeaseCheckpoints must be 0-${CHECKPOINTS_FREE}`)
  if (p.minFreeGBForCheckpoint !== undefined && !int(p.minFreeGBForCheckpoint, 0, ANY)) out.push('minFreeGBForCheckpoint must be a whole number, at least 0')
  // MC-1532: pool checkpoints per VM, optional (default 4), counting retiring ones and ones being taken.
  if (p.maxCheckpointsPerVm !== undefined && !int(p.maxCheckpointsPerVm, 0, CHECKPOINTS_FREE)) out.push(`maxCheckpointsPerVm must be 0-${CHECKPOINTS_FREE}`)
  const checkpoints = (p.maxLeaseCheckpoints ?? DEFAULT_LEASE_CHECKPOINTS) + (p.maxCheckpointsPerVm ?? DEFAULT_POOL_CHECKPOINTS)
  if (checkpoints > CHECKPOINTS_FREE) out.push(`maxLeaseCheckpoints and maxCheckpointsPerVm together must be at most ${CHECKPOINTS_FREE} (they are ${checkpoints}): Hyper-V keeps at most ${HV.checkpoints} checkpoints of a VM, and its clean checkpoint, with a second one while it is refreshed, takes 2`)
  // MC-1572: allowUnpinnedIso is gone (any image the approved plan names is used); a policy from before may still hold it.
  if (p.allowUnpinnedIso !== undefined && typeof p.allowUnpinnedIso !== 'boolean') out.push('allowUnpinnedIso, if present, must be true or false (it is no longer used)')
  // MC-1501: how the helper reaches Linux guests, optional (setup's -LinuxTransport): only the Hyper-V socket today.
  if (p.linuxTransport !== undefined && p.linuxTransport !== 'hvsocket') out.push('linuxTransport must be hvsocket')
  // Build folders an admin named at setup (install.ps1 -BuildRoot): optional, so a policy from before it stays usable.
  if (p.buildRoots !== undefined) {
    if (!Array.isArray(p.buildRoots)) out.push('buildRoots must be a list of folders')
    else for (const f of p.buildRoots) { const why = folderProblem(f); if (why) out.push(`build root "${f}" ${why}`) }
  }
  // Projects sharing the pool (MC-1502), optional: setup's -ProjectsFile. Each: { name, folders, maxVms?, images?,
  // buildRoots? }. A caller belongs to the one project with a folder its roots are in, so no project folder may be the
  // same as, inside or around another project's.
  if (p.projects !== undefined) out.push(...projectProblems(p.projects))
  return out
}

/** Problems with a policy's projects list. */
function projectProblems(projects) {
  const out = []
  if (!Array.isArray(projects)) return ['projects must be a list'] // MC-1579: of any length (formerly at most 16)
  const names = new Set()
  const owned = [] // [folder (lower case), project]
  for (const [i, pr] of projects.entries()) {
    const at = `project ${typeof pr?.name === 'string' ? `"${pr.name}"` : i + 1}`
    if (!pr || typeof pr !== 'object' || Array.isArray(pr)) { out.push(`${at} must be an object`); continue }
    const known = ['name', 'folders', 'maxVms', 'buildRoots', 'images']
    for (const k of Object.keys(pr)) {
      // Reserved VMs were dropped (MC-1502): projects share by their caps and the line.
      if (k === 'reserveVms') out.push(`${at}: reserveVms isn't supported (projects share the pool by their maxVms caps and the line)`)
      else if (!known.includes(k)) out.push(`${at}: unknown field "${k}"`)
    }
    if (!PROJECT_RE.test(pr.name ?? '')) out.push(`${at}: name must be 1-32 lower-case letters, digits and -, starting with a letter`)
    else if (names.has(pr.name) || pr.name === 'other') out.push(`${at}: the name is taken${pr.name === 'other' ? ' ("other" is everyone outside the projects)' : ''}`)
    names.add(pr.name)
    if (!Array.isArray(pr.folders) || !pr.folders.length) out.push(`${at}: folders must list at least one folder`)
    else for (const f of pr.folders) {
      const why = folderProblem(f)
      if (why) { out.push(`${at}: folder "${f}" ${why}`); continue }
      const n = tidy(f).toLowerCase()
      for (const [o, other] of owned) {
        if (n === o || n.startsWith(o + '\\') || o.startsWith(n + '\\')) out.push(`${at}: folder "${f}" overlaps ${other === pr.name ? 'another of its folders' : `project "${other}"'s`} (one root must belong to one project)`)
      }
      owned.push([n, pr.name])
    }
    // maxVms: a whole number (Windows), or by OS: { "windows": 2, "linux": 1 }; 0 means the project may not use that OS.
    const v = pr.maxVms
    if (v !== undefined && !(int(v, 0, ANY) || (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length && Object.entries(v).every(([os, n]) => OSES.includes(os) && int(n, 0, ANY))))) {
      out.push(`${at}: maxVms must be a whole number, at least 0, or one per OS (${OSES.join(', ')}), such as { "windows": 2, "linux": 1 }`)
    }
    if (pr.images !== undefined && (!Array.isArray(pr.images) || pr.images.some(i => typeof i !== 'string' || !/^[0-9a-f]{64}$/i.test(i)))) out.push(`${at}: images must be a list of image SHA-256s (64 hex digits)`)
    if (pr.buildRoots !== undefined) {
      if (!Array.isArray(pr.buildRoots)) out.push(`${at}: buildRoots must be a list of folders`)
      else for (const f of pr.buildRoots) { const why = folderProblem(f); if (why) out.push(`${at}: build root "${f}" ${why}`) }
    }
  }
  return out
}

/** Reads and checks policy.json; throws naming every problem. */
function load(dir) {
  let p
  try { p = JSON.parse(fs.readFileSync(join(dir, FILE), 'utf8')) } catch (e) {
    throw new Error(`policy.json can't be read (${e.code === 'ENOENT' ? 'missing: run setup' : e.message})`)
  }
  const bad = problems(p)
  if (bad.length) throw new Error(`policy.json is not usable: ${bad.join('; ')}. Run setup again.`)
  const projects = (p.projects ?? []).map(pr => Object.freeze({
    name: pr.name, folders: Object.freeze(pr.folders.map(tidy)), maxVms: byOs(pr.maxVms),
    buildRoots: Object.freeze((pr.buildRoots ?? []).map(tidy)), images: Object.freeze((pr.images ?? []).map(i => i.toLowerCase()))
  }))
  const maxNetwork = p.maxNetwork ?? (p.allowNetwork ? 'host' : 'none')
  const hostNetwork = p.hostNetwork ? Object.freeze({ ...p.hostNetwork }) : null
  return Object.freeze({ ...p, approvePoolChanges: p.approvePoolChanges ?? DEFAULTS.approvePoolChanges, maxNetwork, hostNetwork, diskFolders: Object.freeze(p.diskFolders.map(tidy)), buildRoots: Object.freeze((p.buildRoots ?? []).map(tidy)), projects: Object.freeze(projects) })
}

/**
 * Whether a pool, after a change, stays within the policy. vms: every VM the pool would hold (committed and planned),
 * each { cores, memoryMB, diskGB, folder }. Returns [] or the problems.
 */
function checkPool(policy, vms, { network = 'none' } = {}) {
  const out = []
  if (vms.length > policy.maxVms) out.push(`${vms.length} VMs is more than the policy's ${policy.maxVms}`)
  const mem = vms.reduce((s, v) => s + v.memoryMB, 0)
  if (mem > policy.maxMemoryMBTotal) out.push(`${mem} MB of memory in all is more than the policy's ${policy.maxMemoryMBTotal} MB`)
  for (const v of vms) {
    if (!int(v.cores, 1, policy.maxCoresPerVm)) out.push(`${v.cores} cores for one VM is outside the policy's 1-${policy.maxCoresPerVm}`)
    if (!int(v.memoryMB, 2048, policy.maxMemoryMBTotal) || v.memoryMB % 2) out.push(`${v.memoryMB} MB for one VM must be an even number of MB, at least 2048`)
    if (!int(v.diskGB, 64, policy.maxDiskGBPerVm)) out.push(`a ${v.diskGB} GB disk is outside the policy's 64-${policy.maxDiskGBPerVm} GB`)
    if (!underDiskFolder(policy, v.folder)) out.push(`folder "${v.folder}" is not under one of the policy's disk folders`)
  }
  // MC-1556: the pool's network mode, at or below the policy's; host needs setup's host network.
  const why = net.above(network, policy.maxNetwork ?? 'none', 'the policy')
  if (why) out.push(`${why} (rerun setup with -MaxNetwork to raise it)`)
  else if (network === 'host' && !policy.hostNetwork) out.push("host mode needs setup's host network (rerun setup with -MaxNetwork Host or above)")
  return [...new Set(out)]
}

/** A work session's cap in minutes: from acquire, renewals can't take a lease past it. Without one set, 480 (or one lease). */
const sessionMinutes = p => p.maxSessionMinutes ?? Math.max(p.maxLeaseMinutes, DEFAULTS.maxSessionMinutes)

const lower = s => s.toLowerCase()
/** Whether a folder is strictly inside one of the policy's disk folders (compared as normalised Windows paths). */
function underDiskFolder(policy, folder) {
  if (typeof folder !== 'string' || !win32.isAbsolute(folder)) return false
  const f = lower(win32.normalize(folder))
  if (f.split('\\').includes('..')) return false
  return policy.diskFolders.some(d => f.startsWith(lower(d) + '\\') && f.length > d.length + 1)
}

module.exports = { load, problems, projectProblems, checkPool, underDiskFolder, sessionMinutes, DEFAULTS, DEFAULT_LEASE_CHECKPOINTS, DEFAULT_POOL_CHECKPOINTS, HV, FILE, PREFIX_RE }
