/**
 * Runs one Hyper-V operation: `<PowerShell> -File hv.ps1`, the fixed script beside this file, with the operation and
 * its arguments as one JSON object on stdin. Nothing an agent sends is ever put on a command line or into script text:
 * hv.ps1 reads its input with ConvertFrom-Json and uses each value as data. Its answer is the last stdout line that
 * starts with HVJSON:.
 *
 * The PowerShell (MC-1575): HYPERV_MCP_POWERSHELL (the service sets it from host.config, admin-only: the one setup ran
 * in), else the one registered in HKLM, as setup's .cmd launchers choose it: Windows PowerShell 5.1 where it is installed,
 * else PowerShell 7. Never one found on PATH.
 *
 * Tests: HYPERV_MCP_PS_STUB names a Node script run instead of PowerShell (same stdin, same answer), and
 * HYPERV_MCP_CRASH_AT ("before:<op>" or "after:<op>", optionally "#<n>" for the n-th call) ends the process at that
 * boundary, the way a crash or a kill would, so recovery can be tested at every side effect.
 */
const { spawn, spawnSync } = require('child_process')
const { existsSync } = require('fs')
const { join } = require('path')

const SCRIPT = join(__dirname, 'hv.ps1')
const MARK = 'HVJSON:'
// hv.ps1's reply, read up to this many characters. MC-1579: room for a vm_run poll at the most output a stream may be
// (timing.js outputBytes, 1 MB), twice, with ConvertTo-Json writing a character as up to six (\uXXXX). MC-1588:
// vm_read_out reads a Windows guest's files in calls of 2 MB (core.js READ_PART_BYTES), 2.8 M characters of base64.
const OUT_CAP = 16 * 1024 * 1024
// Node's timers fire at once past this (about 24.8 days): a longer call bound waits this long instead (MC-1579).
const TIMER_MAX_MS = 2 ** 31 - 1
const counts = new Map()
// PowerShell 7's own module folders: its user and Program Files ones and $PSHOME\Modules, but none of WindowsPowerShell's.
const PS7_MODULES = /(?<!Windows)PowerShell\\(\d[^\\]*\\)?Modules\\?$/i

/**
 * The environment for a Windows PowerShell 5.1 child: this one, without PowerShell 7's folders in PSModulePath. A Node
 * started from a PowerShell 7 window inherits them, and 5.1 then finds PS7's Microsoft.PowerShell.Security first and
 * can't load it (Get-Acl, ConvertTo-SecureString and Get-AuthenticodeSignature all fail). The setup scripts and
 * approve.ps1 drop them the same way for themselves, since a user may type their line in a PowerShell 7 window.
 */
function ps51Env(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    out[k] = k.toLowerCase() === 'psmodulepath' ? String(v).split(';').filter(p => p && !PS7_MODULES.test(p)).join(';') : v
  }
  return out
}

const KEY51 = 'HKLM\\SOFTWARE\\Microsoft\\PowerShell\\3\\PowerShellEngine'
const KEY7 = 'HKLM\\SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions'

/** reg.exe query's values named name, under key (with /s, its subkeys too), in its order. */
function regValues(key, name, recurse, run = spawnSync) {
  const reg = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  const r = run(reg, ['query', key, ...(recurse ? ['/s'] : []), '/v', name], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0 || !r.stdout) return []
  const out = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/.exec(line)
    if (m && m[1].toLowerCase() === name.toLowerCase()) out.push(m[2])
  }
  return out
}

/**
 * The PowerShell for hv.ps1, as the launchers choose it (setup\install.cmd): Windows PowerShell 5.1's powershell.exe
 * where it is registered and present, else the last PowerShell 7 registered. Throws if neither. opts (tests only):
 * key51, key7, exists, run.
 */
function findEngine({ key51 = KEY51, key7 = KEY7, exists = existsSync, run } = {}) {
  for (const b of regValues(key51, 'ApplicationBase', false, run)) { const e = join(b, 'powershell.exe'); if (exists(e)) return e }
  let found = null
  for (const b of regValues(key7, 'InstallLocation', true, run)) { const e = join(b, 'pwsh.exe'); if (exists(e)) found = e }
  if (found) return found
  throw new Error('neither Windows PowerShell nor PowerShell 7 is installed')
}

let engineCache = null
/** HYPERV_MCP_POWERSHELL, else findEngine's (once). */
function psEngine() {
  if (process.env.HYPERV_MCP_POWERSHELL) return process.env.HYPERV_MCP_POWERSHELL
  if (!engineCache) engineCache = findEngine()
  return engineCache
}

/** The environment for a child of engine: ps51Env's for Windows PowerShell, this one unchanged for PowerShell 7. */
function psEnv(engine, env = process.env) {
  return /pwsh\.exe$/i.test(engine) ? { ...env } : ps51Env(env)
}

function crashPoint(when, op) {
  const want = process.env.HYPERV_MCP_CRASH_AT
  if (!want) return
  const [point, nth] = want.split('#')
  if (point !== `${when}:${op}`) return
  const key = `${when}:${op}`
  const n = (counts.get(key) || 0) + 1
  counts.set(key, n)
  if (!nth || Number(nth) === n) {
    process.stderr.write(`HYPERV_MCP_CRASH_AT ${want}: exiting\n`)
    process.exit(99)
  }
}

/**
 * Runs op with args; resolves the script's answer object, or rejects with its error. onChild(child) is told the
 * PowerShell process, so a lease that ends can kill its in-flight operations.
 */
function hv(op, args = {}, { timeoutMs = 120_000, onChild } = {}) {
  crashPoint('before', op)
  const stub = process.env.HYPERV_MCP_PS_STUB
  let cmd, argv
  try {
    ;[cmd, argv] = stub
      ? [process.execPath, [stub]]
      : [psEngine(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]]
  } catch (e) {
    return Promise.reject(new Error(`can't run PowerShell for ${op}: ${e.message}`))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { env: stub ? ps51Env() : psEnv(cmd), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    if (onChild) onChild(child)
    let out = ''
    let err = ''
    let done = false
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v) } }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* gone */ }
      finish(reject, new Error(`Hyper-V operation ${op} timed out after ${Math.round(timeoutMs / 1000)} s`))
    }, Math.min(timeoutMs, TIMER_MAX_MS))
    child.stdout.on('data', d => { if (out.length < OUT_CAP) out += d })
    child.stderr.on('data', d => { if (err.length < 64 * 1024) err += d })
    child.on('error', e => finish(reject, new Error(`can't run PowerShell for ${op}: ${e.message}`)))
    child.on('close', code => {
      const line = out.split(/\r?\n/).reverse().find(l => l.startsWith(MARK))
      let ans = null
      try { ans = line ? JSON.parse(line.slice(MARK.length)) : null } catch { /* below */ }
      if (!ans) return finish(reject, new Error(`Hyper-V operation ${op} gave no answer (exit ${code})${err.trim() ? `: ${err.trim().slice(0, 600)}` : ''}`))
      if (ans.error) return finish(reject, Object.assign(new Error(`${op}: ${ans.error}`), { hv: ans }))
      crashPoint('after', op)
      finish(resolve, ans.result ?? {})
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ op, args }))
  })
}

module.exports = { hv, ps51Env, psEnv, psEngine, findEngine, regValues, SCRIPT, MARK }
