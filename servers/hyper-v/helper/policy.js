/**
 * The pool's hard limits, from policy.json in the helper's state folder. Only the elevated setup writes it (the folder's
 * ACL gives the service read and write to its own records, but setup owns policy.json: the helper never writes it).
 * Every pool change is checked against it under the pool lock, whatever its plan or approval says, so even a forged
 * approval can't go beyond it.
 */
const fs = require('fs')
const { join, win32 } = require('path')

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
  allowNetwork: true,
  maxReservePercent: 100,
  maxLeaseMinutes: 240,
  maxSessionMinutes: 480,
  maxBuildMB: 2048,
  allowUnpinnedIso: false,
  buildRoots: []
}

const MAX_BUILD_ROOTS = 16
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
  if (!int(p.maxVms, 1, 64)) out.push('maxVms must be 1-64')
  if (!int(p.maxCoresPerVm, 1, 64)) out.push('maxCoresPerVm must be 1-64')
  if (!int(p.maxMemoryMBTotal, 2048, 1024 * 1024)) out.push('maxMemoryMBTotal must be 2048-1048576')
  if (!int(p.maxDiskGBPerVm, 64, 4096)) out.push('maxDiskGBPerVm must be 64-4096 (Windows 11 needs 64 GB)')
  if (!Array.isArray(p.diskFolders) || !p.diskFolders.length) out.push('diskFolders must name at least one folder')
  else for (const f of p.diskFolders) if (typeof f !== 'string' || !win32.isAbsolute(f) || /^\\\\/.test(f) || win32.parse(f).root === win32.normalize(f)) out.push(`disk folder "${f}" must be an absolute local folder, not a drive root`)
  if (typeof p.allowNetwork !== 'boolean') out.push('allowNetwork must be true or false')
  if (!int(p.maxReservePercent, 0, 100)) out.push('maxReservePercent must be 0-100')
  if (!int(p.maxLeaseMinutes, 5, 24 * 60)) out.push('maxLeaseMinutes must be 5-1440')
  // A work session's cap (vm_renew), optional so a policy from before it stays usable; never below one lease.
  if (p.maxSessionMinutes !== undefined && (!int(p.maxSessionMinutes, 5, 24 * 60) || p.maxSessionMinutes < p.maxLeaseMinutes)) out.push('maxSessionMinutes must be 5-1440 and at least maxLeaseMinutes')
  if (!int(p.maxBuildMB, 1, 64 * 1024)) out.push('maxBuildMB must be 1-65536')
  if (typeof p.allowUnpinnedIso !== 'boolean') out.push('allowUnpinnedIso must be true or false')
  // Build folders an admin named at setup (install.ps1 -BuildRoot): optional, so a policy from before it stays usable.
  if (p.buildRoots !== undefined) {
    if (!Array.isArray(p.buildRoots) || p.buildRoots.length > MAX_BUILD_ROOTS) out.push(`buildRoots must be a list of at most ${MAX_BUILD_ROOTS} folders`)
    else for (const f of p.buildRoots) { const why = folderProblem(f); if (why) out.push(`build root "${f}" ${why}`) }
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
  return Object.freeze({ ...p, diskFolders: Object.freeze(p.diskFolders.map(tidy)), buildRoots: Object.freeze((p.buildRoots ?? []).map(tidy)) })
}

/**
 * Whether a pool, after a change, stays within the policy. vms: every VM the pool would hold (committed and planned),
 * each { cores, memoryMB, diskGB, folder }. Returns [] or the problems.
 */
function checkPool(policy, vms, { network = false } = {}) {
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
  if (network && !policy.allowNetwork) out.push('the policy does not allow networking')
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

module.exports = { load, problems, checkPool, underDiskFolder, sessionMinutes, DEFAULTS, FILE, PREFIX_RE }
