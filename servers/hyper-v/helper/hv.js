/**
 * Runs one Hyper-V operation: `powershell.exe -File hv.ps1`, the fixed script beside this file, with the operation and
 * its arguments as one JSON object on stdin. Nothing an agent sends is ever put on a command line or into script text:
 * hv.ps1 reads its input with ConvertFrom-Json and uses each value as data. Its answer is the last stdout line that
 * starts with HVJSON:.
 *
 * Tests: HYPERV_MCP_PS_STUB names a Node script run instead of PowerShell (same stdin, same answer), and
 * HYPERV_MCP_CRASH_AT ("before:<op>" or "after:<op>", optionally "#<n>" for the n-th call) ends the process at that
 * boundary, the way a crash or a kill would, so recovery can be tested at every side effect.
 */
const { spawn } = require('child_process')
const { join } = require('path')

const SCRIPT = join(__dirname, 'hv.ps1')
const MARK = 'HVJSON:'
const OUT_CAP = 4 * 1024 * 1024
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
  const [cmd, argv] = stub
    ? [process.execPath, [stub]]
    : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT]]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { env: ps51Env(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    if (onChild) onChild(child)
    let out = ''
    let err = ''
    let done = false
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v) } }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* gone */ }
      finish(reject, new Error(`Hyper-V operation ${op} timed out after ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
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

module.exports = { hv, ps51Env, SCRIPT, MARK }
