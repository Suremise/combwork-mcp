/**
 * The helper's entry point under its service host (HvMcpHost.exe, or test/fake-host.js in the tests). The host owns
 * the named pipe and relays each client connection over this process's stdin/stdout, one line per message, as text:
 *
 *   host → helper  go                  the host has put this process in its job object: start (nothing runs before)
 *                  open <c> <pid>      client connection c, from process pid (GetNamedPipeClientProcessId)
 *                  msg <c> <line>      one request line from c, as the client sent it: { id, op, args } in JSON
 *                  close <c>           c disconnected: its lease ends
 *                  ping <n>            heartbeat: no "pong <n>" within 30 s and the host restarts this process
 *   helper → host  ready               recovery is done: the host opens the pipe only now
 *                  msg <c> <json>      one reply to c: { id, ok: true, result } or { id, ok: false, error }
 *                  pong <n>
 *
 * The client's line is passed on as it is and parsed here: a line can't hold a newline, so a client can't forge a
 * framing message. c and pid are decimal numbers the host assigns and reads. Each connection's requests run one at a
 * time, in order (a build is staged chunk by chunk), except 'status' and 'version'. If stdin closes, the host is gone:
 * the process exits (the host's job object would end it anyway).
 */
const os = require('os')
const fs = require('fs')
const { join } = require('path')
const { createInterface } = require('readline')
const { Helper } = require('./core')
const { hv } = require('./hv')

const STATE_DIR = process.env.HYPERV_MCP_STATE_DIR || join(process.env.ProgramData || 'C:\\ProgramData', 'hyperv-mcp')
const LOG_MAX = 4 * 1024 * 1024
const NUM = /^\d{1,10}$/

function logger(dir) {
  const file = join(dir, 'helper.log')
  return line => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + '.1')
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}${os.EOL}`)
    } catch { /* logging never stops the helper */ }
  }
}

/** Replies carry text, data and, for read_out, files as base64. */
function serialise(r) {
  if (r && Array.isArray(r.files) && r.files.some(f => Buffer.isBuffer(f.data))) {
    return { ...r, files: r.files.map(f => ({ ...f, data: f.data.toString('base64') })) }
  }
  return r
}

/** Serves the host protocol on input/output with a Helper; returns { done } (resolves when input closes). */
function serve(input, output, makeHelper, log = () => {}) {
  const send = line => output.write(line + '\n')
  const queues = new Map()
  const pending = []
  let helper = null
  let ready = false

  const reply = (c, m) => send(`msg ${c} ${JSON.stringify(m)}`)
  const handle = (kind, rest) => {
    if (kind === 'open') {
      const [c, pid] = rest.split(' ')
      if (!NUM.test(c) || !NUM.test(pid || '')) return
      helper.connect(c, Number(pid))
      queues.set(c, Promise.resolve())
      log(`connection ${c} from pid ${pid}`)
    } else if (kind === 'close') {
      if (!queues.has(rest)) return
      const q = queues.get(rest)
      queues.delete(rest)
      q.then(() => helper.disconnect(rest)).catch(e => log(`disconnect ${rest}: ${e.message}`))
    } else if (kind === 'msg') {
      const sp = rest.indexOf(' ')
      const c = rest.slice(0, sp)
      if (sp < 0 || !queues.has(c)) return
      let m
      try { m = JSON.parse(rest.slice(sp + 1)) } catch { return reply(c, { id: null, ok: false, error: 'not JSON' }) }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return reply(c, { id: null, ok: false, error: 'not a request object' })
      const id = typeof m.id === 'number' || typeof m.id === 'string' ? m.id : null
      const op = String(m.op)
      const args = m.args && typeof m.args === 'object' && !Array.isArray(m.args) ? m.args : {}
      const run = () => helper.request(c, op, args).then(
        result => reply(c, { id, ok: true, result: serialise(result) }),
        e => reply(c, { id, ok: false, error: e.message }))
      if (op === 'status' || op === 'version') return void run()
      const q = queues.get(c).then(run)
      queues.set(c, q.catch(() => {}))
    }
  }

  let resolveDone
  const done = new Promise(r => { resolveDone = r })
  createInterface({ input })
    .on('line', line => {
      line = line.replace(/\r$/, '')
      const sp = line.indexOf(' ')
      const kind = sp < 0 ? line : line.slice(0, sp)
      const rest = sp < 0 ? '' : line.slice(sp + 1)
      if (kind === 'ping') return NUM.test(rest) && send(`pong ${rest}`)
      if (kind === 'go') {
        if (helper) return
        helper = makeHelper()
        helper.init().then(() => {
          ready = true
          log(`ready; recovery: ${helper.recovery.join(' ') || 'nothing to do'}`)
          send('ready')
          for (const [k, r] of pending.splice(0)) handle(k, r)
        }, e => {
          log(`start-up failed: ${e.stack || e.message}`)
          process.stderr.write(`hyper-v helper: start-up failed: ${e.message}\n`)
          process.exit(2)
        })
        return
      }
      if (!ready) { if (pending.length < 1000) pending.push([kind, rest]); return }
      handle(kind, rest)
    })
    .on('close', () => resolveDone())
  return { done, helper: () => helper }
}

function main() {
  const log = logger(STATE_DIR)
  const s = serve(process.stdin, process.stdout,
    () => new Helper({ stateDir: STATE_DIR, hv, log, checkApprovalAcl: process.env.HYPERV_MCP_TEST_NO_ACL !== '1' }), log)
  s.done.then(() => process.exit(0))
}

if (require.main === module) main()
module.exports = { serialise, serve }
