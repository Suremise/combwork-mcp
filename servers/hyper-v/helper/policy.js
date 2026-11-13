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
const MAX_PROJECTS = 16
const PROJECT_RE = /^[a-z][a-z0-9-]{0,31}$/
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
  // Projects sharing the pool (MC-1502), optional: setup's -ProjectsFile. Each: { name, folders, maxVms?, reserveVms?,
  // buildRoots? }. A caller belongs to the one project with a folder its roots are in, so no project folder may be the
  // same as, inside or around another project's.
  if (p.projects !== undefined) out.push(...projectProblems(p.projects, p.maxVms))
  return out
}

/** Problems with a policy's projects list. */
function projectProblems(projects, maxVms) {
  const out = []
  if (!Array.isArray(projects) || projects.length > MAX_PROJECTS) return [`projects must be a list of at most ${MAX_PROJECTS}`]
  const names = new Set()
  const owned = [] // [folder (lower case), project]
  let reserved = 0
  for (const [i, pr] of projects.entries()) {
    const at = `project ${typeof pr?.name === 'string' ? `"${pr.name}"` : i + 1}`
    if (!pr || typeof pr !== 'object' || Array.isArray(pr)) { out.push(`${at} must be an object`); continue }
    const known = ['name', 'folders', 'maxVms', 'reserveVms', 'buildRoots']
    for (const k of Object.keys(pr)) if (!known.includes(k)) out.push(`${at}: unknown field "${k}"`)
    if (!PROJECT_RE.test(pr.name ?? '')) out.push(`${at}: name must be 1-32 lower-case letters, digits and -, starting with a letter`)
    else if (names.has(pr.name) || pr.name === 'other') out.push(`${at}: the name is taken${pr.name === 'other' ? ' ("other" is everyone outside the projects)' : ''}`)
    names.add(pr.name)
    if (!Array.isArray(pr.folders) || !pr.folders.length || pr.folders.length > MAX_BUILD_ROOTS) out.push(`${at}: folders must list 1-${MAX_BUILD_ROOTS} folders`)
    else for (const f of pr.folders) {
      const why = folderProblem(f)
      if (why) { out.push(`${at}: folder "${f}" ${why}`); continue }
      const n = tidy(f).toLowerCase()
      for (const [o, other] of owned) {
        if (n === o || n.startsWith(o + '\\') || o.startsWith(n + '\\')) out.push(`${at}: folder "${f}" overlaps ${other === pr.name ? 'another of its folders' : `project "${other}"'s`} (one root must belong to one project)`)
      }
      owned.push([n, pr.name])
    }
    for (const k of ['maxVms', 'reserveVms']) if (pr[k] !== undefined && !int(pr[k], 0, 64)) out.push(`${at}: ${k} must be a whole number 0-64`)
    if (int(pr.maxVms, 0, 64) && int(pr.reserveVms, 0, 64) && pr.reserveVms > pr.maxVms) out.push(`${at}: reserveVms (${pr.reserveVms}) is over its maxVms (${pr.maxVms})`)
    if (int(pr.reserveVms, 0, 64)) reserved += pr.reserveVms
    if (pr.buildRoots !== undefined) {
      if (!Array.isArray(pr.buildRoots) || pr.buildRoots.length > MAX_BUILD_ROOTS) out.push(`${at}: buildRoots must be a list of at most ${MAX_BUILD_ROOTS} folders`)
      else for (const f of pr.buildRoots) { const why = folderProblem(f); if (why) out.push(`${at}: build root "${f}" ${why}`) }
    }
  }
  if (int(maxVms, 1, 64) && reserved > maxVms) out.push(`the projects reserve ${reserved} VMs in all, over the policy's maxVms (${maxVms})`)
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
    name: pr.name, folders: Object.freeze(pr.folders.map(tidy)), maxVms: pr.maxVms, reserveVms: pr.reserveVms ?? 0,
    buildRoots: Object.freeze((pr.buildRoots ?? []).map(tidy))
  }))
  return Object.freeze({ ...p, diskFolders: Object.freeze(p.diskFolders.map(tidy)), buildRoots: Object.freeze((p.buildRoots ?? []).map(tidy)), projects: Object.freeze(projects) })
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

module.exports = { load, problems, projectProblems, checkPool, underDiskFolder, sessionMinutes, DEFAULTS, FILE, PREFIX_RE }
