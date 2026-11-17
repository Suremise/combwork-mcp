/**
 * The Linux driver's transport (MC-1501; design §4): one SSH session per guest call, to the VM's dispatcher.
 *
 * The helper runs Windows' in-box OpenSSH client, %SystemRoot%\System32\OpenSSH\ssh.exe, with fixed arguments and no
 * shell. The only thing it ever sends is the request on stdin (one JSON line, then a sync's file bytes); the remote
 * command is the guest's forced one, so nothing an agent sends is ever an argument, on either side.
 * - Transport A (hvsocket, the user's decision): ProxyCommand is the setup-compiled HvMcpVsock.exe, which pipes its
 *   stdio to an AF_HYPERV socket on the VM's id and vsock port 22. The guest has no network path.
 * - Transport B (internal-switch): the guest's recorded address. Not built yet: only if the trial finds hv_sock
 *   missing, and the user decides (docs/linux-guests.md §4.1).
 * - -F none: no ssh config is read; -i the VM's own client key; IdentitiesOnly; BatchMode (never a prompt);
 *   StrictHostKeyChecking with the VM's own known_hosts (its host key, pinned at create) under the alias hvmcp.
 *
 * Tests: HYPERV_MCP_SSH_STUB names a Node script run instead (argv: the VM id), with the same stdin and answer.
 */
const fs = require('fs')
const { spawn } = require('child_process')
const { join } = require('path')

const MARK = 'HVJSON:'
const OUT_CAP = 100 * 1024 * 1024
const SSH = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
const INSTALL_DIR = process.env.HYPERV_MCP_INSTALL_DIR || join(process.env.ProgramFiles || 'C:\\Program Files', 'hyperv-mcp')
const BRIDGE = join(INSTALL_DIR, 'HvMcpVsock.exe')
const VMID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The ssh.exe arguments for a target: { vmId, keyFile, knownHosts, transport, address }. Fixed but for those. */
function argv(t, { verbose = false } = {}) {
  if (!VMID_RE.test(t.vmId)) throw new Error('a bad VM id')
  // MC-1545: verbose (a build's readiness attempts only, never a lease's calls) logs at DEBUG1, as ssh -v does.
  const common = ['-F', 'none', '-T', '-x', '-a', '-i', t.keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${t.knownHosts}`, '-o', 'GlobalKnownHostsFile=none', '-o', 'HostKeyAlias=hvmcp', '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-o', `LogLevel=${verbose ? 'DEBUG1' : 'ERROR'}`, '-o', 'UpdateHostKeys=no', '-o', 'ClearAllForwardings=yes']
  if (t.transport === 'internal-switch') {
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(t.address || '')) throw new Error('a bad guest address')
    return [...common, `hvadmin@${t.address}`]
  }
  return [...common, '-o', `ProxyCommand="${BRIDGE}" ${t.vmId} 22`, 'hvadmin@hvmcp']
}

/**
 * Sends `request` to the target's dispatcher; then, when `files` is given (absolute host paths, in order), each file's
 * bytes. Resolves the dispatcher's result, or rejects with its error. onChild(child): so an ending lease can kill it.
 */
function call(target, request, { files = [], timeoutMs = 120_000, onChild, verbose = false } = {}) {
  const stub = process.env.HYPERV_MCP_SSH_STUB
  const [cmd, args] = stub ? [process.execPath, [stub, target.vmId, ...(verbose ? ['-v'] : [])]] : [SSH, argv(target, { verbose })]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    if (onChild) onChild(child)
    let out = ''
    let err = ''
    let done = false
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v) } }
    // MC-1545: what ssh (and its ProxyCommand, HvMcpVsock.exe) said, kept for every failure, a timeout included: verbose,
    // its last 10 lines; otherwise its first 400 characters, as before.
    const said = () => {
      const lines = err.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      if (!lines.length) return ''
      return `: ${verbose ? lines.slice(-10).join(' | ') : err.trim().slice(0, 400)}`
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* gone */ }
      finish(reject, new Error(`the guest call ${request.op} timed out after ${Math.round(timeoutMs / 1000)} s${said()}`))
    }, timeoutMs)
    child.stdout.on('data', d => { if (out.length < OUT_CAP) out += d })
    child.stderr.on('data', d => { if (err.length < 16 * 1024) err += d })
    child.on('error', e => finish(reject, new Error(`can't run ssh for ${request.op}: ${e.message}`)))
    child.on('close', code => {
      const line = out.split(/\r?\n/).reverse().find(l => l.startsWith(MARK))
      let ans = null
      try { ans = line ? JSON.parse(line.slice(MARK.length)) : null } catch { /* below */ }
      if (!ans) return finish(reject, new Error(`the guest call ${request.op} gave no answer (ssh exit ${code})${said()}`))
      if (ans.error) return finish(reject, new Error(`${request.op}: ${ans.error}`))
      finish(resolve, ans.result ?? {})
    })
    child.stdin.on('error', () => {})
    // The request, then each file's bytes, streamed in order with backpressure.
    ;(async () => {
      const write = b => new Promise(res => { if (child.stdin.write(b)) res(); else child.stdin.once('drain', res) })
      await write(JSON.stringify(request) + '\n')
      for (const f of files) {
        for await (const chunk of fs.createReadStream(f)) { if (done) return; await write(chunk) }
      }
      child.stdin.end()
    })().catch(e => { try { child.kill() } catch { /* gone */ } finish(reject, new Error(`sending to the guest failed: ${e.message}`)) })
  })
}

module.exports = { call, argv, SSH, BRIDGE }
