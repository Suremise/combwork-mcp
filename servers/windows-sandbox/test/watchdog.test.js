// The detached watchdog on its own: what makes it stop the Sandbox, and that it fails closed like the server.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { scratch, waitFor } = require('./helpers')

const WATCHDOG = path.join(__dirname, '..', 'watchdog.js')
const ID = 'cccccccc-0000-4000-8000-000000000001'

function setup(name, { fail, deadline = Date.now() + 600_000, serverPid } = {}) {
  const s = scratch(name, fail)
  s.patch(x => { x.sandboxes = [ID] })
  const runDir = path.join(s.dir, 'sandbox', 'run')
  fs.mkdirSync(runDir, { recursive: true })
  const dummy = serverPid ? null : spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ id: ID, serverPid: serverPid || dummy.pid, deadline }))
  const wd = spawn(process.execPath, [WATCHDOG, runDir], { env: s.env, stdio: ['pipe', 'ignore', 'ignore'] })
  const exit = new Promise(res => wd.on('exit', res))
  test.after(() => { wd.kill(); dummy?.kill() })
  const report = () => { try { return JSON.parse(fs.readFileSync(path.join(runDir, 'watchdog.json'), 'utf8')) } catch { return null } }
  return { s, wd, dummy, exit, report }
}

test('the server PID dying stops the Sandbox, confirmed', async () => {
  const t = setup('wd-pid')
  t.dummy.kill('SIGKILL')
  assert.strictEqual(await t.exit, 0)
  assert.deepStrictEqual(t.s.read().sandboxes, [])
  assert.deepStrictEqual({ stopped: t.report().stopped, reason: t.report().reason }, { stopped: true, reason: 'server gone' })
  t.wd.stdin.destroy()
})

test('the pipe closing (server killed hard) stops it', async () => {
  const t = setup('wd-pipe')
  t.wd.stdin.end()
  assert.strictEqual(await t.exit, 0)
  assert.strictEqual(t.report().stopped, true)
  t.dummy.kill()
})

test('the deadline passing stops it, with the server alive', async () => {
  const t = setup('wd-deadline', { deadline: Date.now() + 500 })
  assert.strictEqual(await t.exit, 0)
  assert.strictEqual(t.report().reason, 'deadline passed')
  assert.deepStrictEqual(t.s.read().sandboxes, [])
  t.dummy.kill()
})

test('"deadline <ms>" moves the deadline; "done" exits without stopping', async () => {
  const t = setup('wd-done', { deadline: Date.now() + 800 })
  t.wd.stdin.write(`deadline ${Date.now() + 600_000}\n`)
  await new Promise(r => setTimeout(r, 1500))
  assert.deepStrictEqual(t.s.read().sandboxes, [ID])
  t.wd.stdin.write('done\n')
  assert.strictEqual(await t.exit, 0)
  assert.ok(!(t.s.read().calls || []).some(c => c[0] === 'stop'))
  t.dummy.kill()
})

test('a stop that is never confirmed is retried in bounded rounds and reported, not claimed', async () => {
  for (const fail of [{ stop: -1 }, { stopLies: true }, { listAfterStop: 'exit' }]) {
    const t = setup('wd-fail', { fail })
    t.wd.stdin.end()
    const r = await waitFor(() => { const x = t.report(); return x && x.stopped === false && x }, 10_000, 'a failure report')
    assert.match(r.error, /stop not confirmed \(round 1 of 20\)/, JSON.stringify(fail))
    assert.strictEqual(r.attempts.length, 3)
    t.wd.kill()
    t.dummy.kill()
  }
})

// MC-1548: a state or report file replaced while another process has it open. Windows refuses that rename (EPERM):
// the watchdog reading state.json as it starts, a smoke run polling watchdog.json. replaceFile retries, bounded.
const { replaceFile } = require('../wsb')
const windows = process.platform === 'win32'

// A process that opens file (as Node opens it for a read) and holds it until the parent releases it: the release file
// appearing (created synchronously by the test, so a synchronous replaceFile can release it mid-retry). Round 2: no
// wall-clock hold. Resolves once it holds the file; exits() waits for its exit. A 60 s safety exit bounds a lost test.
function holdOpen(file) {
  const release = `${file}.release`
  const script = "const fs=require('fs');const [f,r]=process.argv.slice(1);const fd=fs.openSync(f,'r');process.stdout.write('held');" +
    "const t=setInterval(()=>{if(fs.existsSync(r)){clearInterval(t);fs.closeSync(fd);process.exit(0)}},5);setTimeout(()=>process.exit(3),60000)"
  const p = spawn(process.execPath, ['-e', script, file, release], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const exited = new Promise(res => p.once('exit', code => res(code)))
  const h = { release: () => fs.writeFileSync(release, ''), exited: () => exited }
  test.after(async () => { h.release(); await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]); if (p.exitCode === null) p.kill() })
  return new Promise((res, rej) => { p.stdout.once('data', () => res(h)); exited.then(c => rej(new Error(`holder exited ${c} before holding the file`))) })
}

test('MC-1548: replaceFile replaces a file another process holds open, once it lets go (a plain rename fails there)', { skip: !windows && 'a Windows sharing rule' }, async () => {
  const s = scratch('wd-replace')
  const file = path.join(s.dir, 'state.json')
  fs.writeFileSync(file, '{"v":1}')
  const holder = await holdOpen(file)
  // The premise, while it's certainly held (only the test releases it): Windows refuses a plain rename over it.
  fs.writeFileSync(`${file}.plain`, '{"v":0}')
  assert.throws(() => fs.renameSync(`${file}.plain`, file), e => ['EPERM', 'EACCES', 'EBUSY'].includes(e.code))
  // replaceFile's rename, observed: the first attempt meets the holder (a sharing error), and only then is the holder
  // told to let go; the retries that follow succeed once it has.
  const seen = []
  replaceFile(file, '{"v":2}', {
    renameSync: (a, b) => {
      try { fs.renameSync(a, b); seen.push('ok') } catch (e) {
        seen.push(e.code)
        if (seen.length === 1) holder.release()
        throw e
      }
    }
  })
  assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(seen[0]), `the first attempt met the holder: ${seen}`)
  assert.strictEqual(seen.at(-1), 'ok', `then a retry succeeded: ${seen}`)
  assert.ok(seen.length >= 2, 'it retried')
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"v":2}')
  assert.ok(!fs.existsSync(`${file}.tmp`), 'no temp file left')
  assert.strictEqual(await holder.exited(), 0, 'the holder let go when told, and exited')
})

test('MC-1548: replaceFile is bounded, and throws at once on an error that isn\'t a sharing one', () => {
  const s = scratch('wd-replace-bound')
  const file = path.join(s.dir, 'r.json')
  let tries = 0
  const busy = () => { tries++; const e = new Error('busy'); e.code = 'EPERM'; throw e }
  const t0 = Date.now()
  assert.throws(() => replaceFile(file, 'x', { renameSync: busy, waitMs: 150 }), /busy/)
  assert.ok(Date.now() - t0 >= 150 && Date.now() - t0 < 2000 && tries > 2, `retried for its bound (${tries} tries, ${Date.now() - t0} ms)`)
  tries = 0
  const other = () => { tries++; const e = new Error('nope'); e.code = 'ENOENT'; throw e }
  assert.throws(() => replaceFile(file, 'x', { renameSync: other }), /nope/)
  assert.strictEqual(tries, 1, 'not retried')
})

test('MC-1548: a report the watchdog can\'t write is logged, not thrown: it still stops the Sandbox and exits 0', async () => {
  const t = setup('wd-report-fails')
  // watchdog.json is a folder: no report can replace it, so every write fails after its bounded retry.
  fs.mkdirSync(path.join(t.s.dir, 'sandbox', 'run', 'watchdog.json'))
  t.dummy.kill('SIGKILL')
  assert.strictEqual(await t.exit, 0, 'it carried on past the failed report and stopped')
  assert.deepStrictEqual(t.s.read().sandboxes, [])
  assert.match(fs.readFileSync(path.join(t.s.dir, 'sandbox', 'run', 'watchdog.log'), 'utf8'), /report not written/)
  t.wd.stdin.destroy()
})
