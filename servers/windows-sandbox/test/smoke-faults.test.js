// smoke.js's own cleanup under faults (found in review): every Sandbox it starts must be stopped, or reported as
// possibly still running, whatever fails. Runs smoke.js (hard-kill scenario only) against the wsb stub.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { scratch } = require('./helpers')

const SMOKE = path.join(__dirname, 'smoke.js')

function smoke(s, env) {
  const dir = path.join(s.dir, 'smoke')
  const root = path.join(dir, 'sandbox')
  const watchdogs = []
  try {
    const r = spawnSync(process.execPath, [SMOKE, '--runs', '0'], { env: { ...s.env, WSB_TEST_SCRATCH: dir, SMOKE_KILL_WAIT_MS: '1500', ...env }, encoding: 'utf8', timeout: 60_000 })
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'smoke.json'), 'utf8'))
    for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      try { watchdogs.push(JSON.parse(fs.readFileSync(path.join(root, d, 'watchdog.json'), 'utf8'))) } catch { /* none written */ }
    }
    return { code: r.status, out: r.stdout + r.stderr, summary, watchdogs }
  } finally {
    // The watchdogs these runs leave waiting (slowed down or failing on purpose): end them, by the PID their server
    // recorded, whatever happened above.
    for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      let st = {}
      try { st = JSON.parse(fs.readFileSync(path.join(root, d, 'state.json'), 'utf8').toString() || '{}') } catch { /* no state */ }
      try { if (st.watchdogPid) process.kill(st.watchdogPid) } catch { /* already gone */ }
    }
  }
}

test('watchdog never stops it, and reading its evidence throws: the finally still stops the Sandbox', () => {
  const s = scratch('smoke-evidence')
  const r = smoke(s, { SMOKE_FAULT: 'evidence', WSB_WATCHDOG_CHECK_MS: '600000' })
  assert.strictEqual(r.code, 1)
  assert.match(r.out, /FAIL hard kill: the watchdog stopped/)
  assert.match(r.out, /FAIL hard kill: no exception[\s\S]*injected fault/)
  assert.match(r.out, /PASS hard kill: cleanup of \S+ confirmed \(fallback stop\)/)
  assert.deepStrictEqual(s.read().sandboxes, [])
  assert.strictEqual(r.summary.fallbackStops.length, 1)
  assert.ok(!r.summary.leftRunning)
})

test('the watchdog\'s stop fails: the fallback stop confirms it', () => {
  // MC-1538: every stop the watchdog makes fails (the stub tells it by its caller tag), however long smoke waits or
  // however loaded the machine; the fallback's stops aren't affected. (A count of failing stops raced the watchdog's
  // next round against smoke's wait.)
  const s = scratch('smoke-watchdog-fails', { stopCaller: 'watchdog' })
  const r = smoke(s, { WSB_WATCHDOG_CHECK_MS: '100' })
  assert.strictEqual(r.code, 1, 'the watchdog failed on purpose: a failing check')
  assert.match(r.out, /FAIL hard kill: the watchdog stopped/)
  assert.match(r.out, /PASS hard kill: cleanup of \S+ confirmed \(fallback stop\)/)
  assert.deepStrictEqual(s.read().sandboxes, [])
  assert.strictEqual(r.watchdogs.length, 1)
  const w = r.watchdogs[0]
  assert.strictEqual(w.stopped, false, 'the watchdog reported its stop unconfirmed')
  assert.match(JSON.stringify(w.attempts), /stop failed \(watchdog\)/, 'its attempts were made and refused by the stub')
  assert.deepStrictEqual(r.summary.fallbackStops.map(f => f.ok), [true], 'one fallback stop, confirmed')
  assert.ok(!r.summary.leftRunning)
})

test('every stop fails: reported as possibly still running, with the id kept, and a non-zero exit', () => {
  const s = scratch('smoke-all-fail', { stop: -1 })
  const r = smoke(s, { WSB_WATCHDOG_CHECK_MS: '600000' })
  assert.strictEqual(r.code, 1)
  const id = s.read().sandboxes[0]
  assert.match(r.out, new RegExp(`FAIL hard kill: cleanup of ${id} confirmed \\(fallback stop\\)[\\s\\S]*CLEANUP NOT CONFIRMED: Sandbox ${id} may still be running`))
  assert.deepStrictEqual(r.summary.leftRunning, [id])
})
