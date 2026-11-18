// guest-agent.ps1, the interactive session's watcher (MC-1504), run for real with Windows PowerShell 5.1 from a host temp
// folder (its root is its own folder, as C:\hvmcp is in the guest): requests are claimed by an atomic rename and run once;
// a restarted watcher never runs a finished request again, nor one claimed before it died. Later requests are the
// barriers that show a restarted watcher has scanned, so nothing here waits on a fixed sleep. What only a pool VM shows
// (the watcher started at logon, in the user's session, elevated for the admin) is the real-VM trial's.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { T, scratch, waitFor } = require('./helpers')
const { ps51Env } = require('../helper/hv')

const windows = process.platform === 'win32'
const AGENT = path.join(__dirname, '..', 'helper', 'guest-agent.ps1')

/** A watcher folder: agent.ps1, req\, and wrappers that append a line to ran-<n>.txt. */
function setup(name) {
  const sc = scratch(name)
  const root = path.join(sc.dir, 'hvmcp')
  fs.mkdirSync(path.join(root, 'req'), { recursive: true })
  fs.copyFileSync(AGENT, path.join(root, 'agent.ps1'))
  const ran = n => path.join(root, `ran-${n}.txt`)
  const wrap = n => fs.writeFileSync(path.join(root, `wrap-${n}.cmd`), `@echo off\r\necho ran>> "${ran(n)}"\r\n`)
  // Published as the helper does: the wrapper first, then req\<n>.tmp renamed to req\<n>.go.
  const publish = n => { wrap(n); const tmp = path.join(root, 'req', `${n}.tmp`); fs.writeFileSync(tmp, 'run'); fs.renameSync(tmp, path.join(root, 'req', `${n}.go`)) }
  const runs = n => fs.existsSync(ran(n)) ? fs.readFileSync(ran(n), 'utf8').split(/\r?\n/).filter(Boolean).length : 0
  const started = []
  const start = () => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'agent.ps1')], { env: ps51Env(), windowsHide: true })
    started.push(c)
    return c
  }
  const stop = c => new Promise(r => { if (c.exitCode !== null || c.signalCode !== null) return r(); c.on('exit', r); c.kill() })
  return { root, publish, runs, start, stop, started, req: n => path.join(root, 'req', n) }
}

test('a request runs once; a restarted watcher replays neither a finished request nor a claimed one', { skip: !windows }, async t => {
  const w = setup('agent-replay')
  t.after(() => Promise.all(w.started.map(w.stop)))
  let agent = w.start()
  w.publish(1)
  await waitFor(() => w.runs(1) === 1, T.waitForMs, 'request 1 to run')
  await waitFor(() => !fs.existsSync(w.req('1.go')), T.waitForMs, 'the request to be removed')
  assert.ok(fs.existsSync(w.req('1.claimed')), 'claimed')
  // A request claimed by a watcher that died before removing its .go: both files left. Never run again.
  fs.writeFileSync(path.join(w.root, 'wrap-5.cmd'), `@echo off\r\necho ran>> "${path.join(w.root, 'ran-5.txt')}"\r\n`)
  fs.writeFileSync(w.req('5.claimed'), '')
  fs.writeFileSync(w.req('5.go'), 'run')

  // A request claimed by a watcher that then died before its run: only its .claimed is left.
  fs.writeFileSync(path.join(w.root, 'wrap-2.cmd'), `@echo off\r\necho ran>> "${path.join(w.root, 'ran-2.txt')}"\r\n`)
  fs.writeFileSync(w.req('2.claimed'), 'run')
  await w.stop(agent)

  agent = w.start()
  w.publish(3) // the barrier: once 3 has run, the new watcher has scanned req\ at least once
  await waitFor(() => w.runs(3) === 1, T.waitForMs, 'request 3 to run')
  w.publish(4) // and a second full scan after that
  await waitFor(() => w.runs(4) === 1, T.waitForMs, 'request 4 to run')
  assert.strictEqual(w.runs(1), 1, 'the finished request ran again')
  assert.strictEqual(w.runs(2), 0, 'the claimed request was run by the new watcher')
  assert.strictEqual(w.runs(5), 0, 'a claimed request whose .go was left was run')
  assert.strictEqual(w.runs(3), 1)
})

test('two watchers at once: each request is claimed by one of them and runs once', { skip: !windows }, async t => {
  const w = setup('agent-two')
  t.after(() => Promise.all(w.started.map(w.stop)))
  w.start()
  w.start()
  for (let n = 1; n <= 6; n++) w.publish(n)
  await waitFor(() => [1, 2, 3, 4, 5, 6].every(n => w.runs(n) >= 1), T.waitForMs, 'every request to run')
  w.publish(7)
  await waitFor(() => w.runs(7) >= 1, T.waitForMs, 'the barrier request to run')
  for (let n = 1; n <= 7; n++) assert.strictEqual(w.runs(n), 1, `request ${n} ran ${w.runs(n)} times`)
})

test('only <digits>.go is a request: a .tmp or another name never runs', { skip: !windows }, async t => {
  const w = setup('agent-names')
  t.after(() => Promise.all(w.started.map(w.stop)))
  w.start()
  fs.writeFileSync(path.join(w.root, 'wrap-5.cmd'), `@echo off\r\necho ran>> "${path.join(w.root, 'ran-5.txt')}"\r\n`)
  fs.writeFileSync(w.req('5.tmp'), 'run') // not yet published
  fs.writeFileSync(w.req('..x.go'), 'run')
  w.publish(6)
  await waitFor(() => w.runs(6) === 1, T.waitForMs, 'request 6 to run')
  w.publish(7)
  await waitFor(() => w.runs(7) === 1, T.waitForMs, 'request 7 to run')
  assert.strictEqual(w.runs(5), 0)
  assert.ok(fs.existsSync(w.req('5.tmp')) && fs.existsSync(w.req('..x.go')), 'left alone')
})
