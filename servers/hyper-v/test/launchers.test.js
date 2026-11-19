// MC-1575: the admin steps' launchers (setup\install.cmd, setup\uninstall.cmd, helper\approve.cmd), run for real as a user
// types their one line, `cmd /c call "<launcher>" <arguments>`, in each terminal: cmd, Windows PowerShell 5.1 and
// PowerShell 7. Each launcher here is a copy in a folder with a space in its name, beside a stub for its script that
// reports the engine it ran in, the arguments it got, and exits with a chosen code. Checked:
// - the arguments arrive exactly (spaced paths for every path option), and the exit code reaches each caller;
// - the engine: Windows PowerShell 5.1 where it is registered, else PowerShell 7 (a copy whose 5.1 key is renamed, so
//   the fallback runs on this PC too), else nothing runs and it says why;
// - nothing is taken from PATH or the current folder: fake powershell, pwsh and reg there are never run;
// - a % or ^ still in an argument when the launcher runs is refused, the script never run; what the caller's own shell
//   expands first can't be seen by the launcher (the documented limit), and isn't claimed here;
// - the installed uninstall.cmd runs uninstall\uninstall.ps1, and finishes cleanly when the uninstall removes it;
// - the three launchers are one text, apart from the script each runs.
// And hv.js's engine choice (findEngine, psEnv), on reg.exe output.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { scratch, psEngines, T } = require('./helpers')
const { findEngine, psEnv } = require('../helper/hv')
const windows = process.platform === 'win32'
const ROOT = path.join(__dirname, '..')
const LAUNCHERS = { 'setup/install.cmd': 'install.ps1', 'setup/uninstall.cmd': 'uninstall.ps1', 'helper/approve.cmd': 'approve.ps1' }
const ENGINES = psEngines()
const HAS7 = ENGINES.some(e => e.name === '7')
const COMSPEC = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
const KEY51 = 'HKLM\\SOFTWARE\\Microsoft\\PowerShell\\3\\PowerShellEngine'
const KEY7 = 'HKLM\\SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions'

// The stub for a launcher's script: one STUB: line with its engine and arguments, then the exit code asked for.
const STUB = [
  "$o = [ordered]@{ engine = $PSVersionTable.PSEdition; args = @($args) }",
  "[Console]::Out.WriteLine('STUB:' + (ConvertTo-Json -InputObject $o -Compress))",
  'if ($env:HVMCP_TEST_DELETE) { Remove-Item -LiteralPath $env:HVMCP_TEST_DELETE -Force }',
  'exit ([int]$env:HVMCP_TEST_EXIT)', ''
].join('\r\n')

/** A copy of launcher (repo-relative) in <scratch>\with spaces\, beside its stub; edit(text) changes the copy. */
function place(name, launcher, edit = t => t) {
  const dir = path.join(scratch(name).dir, 'with spaces')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, path.basename(launcher))
  fs.writeFileSync(file, edit(fs.readFileSync(path.join(ROOT, launcher), 'latin1')), 'latin1')
  fs.writeFileSync(path.join(dir, LAUNCHERS[launcher]), STUB)
  return file
}

/**
 * Types line in a terminal: 'cmd' (cmd.exe /s /c "<line>", read as a typed command line, not as a batch file), or an
 * engine (the line as a script, the way a PowerShell window runs it). Returns { status, out, err, stub }.
 */
function typeIn(caller, line, { env = {}, cwd } = {}) {
  let r
  if (caller === 'cmd') {
    r = spawnSync(COMSPEC, ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, encoding: 'utf8', env: { ...process.env, ...env }, cwd, timeout: T.spawnMs })
  } else {
    const e = ENGINES.find(x => x.name === caller)
    const file = path.join(scratch(`typed-${caller}`).dir, 'typed.ps1')
    fs.writeFileSync(file, `${line}\r\nexit $LASTEXITCODE\r\n`)
    r = spawnSync(e.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', env: { ...e.env, ...env }, cwd, timeout: T.spawnMs })
  }
  const s = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('STUB:'))
  return { status: r.status, out: r.stdout || '', err: r.stderr || '', stub: s ? JSON.parse(s.slice(5)) : null }
}

const CALLERS = ['cmd', ...ENGINES.map(e => e.name)]
const SPACED = ['-DiskFolder', 'D:\\some folder', '-BuildRoot', 'C:\\a b\\builds', '-ProjectsFile', 'C:\\x y\\projects.json', '-ProductKeyFile', 'C:\\k k\\key.txt', '-Plan', 'p-0123456789abcdef']
const typed = args => args.map(a => (a.startsWith('-') ? a : `"${a}"`)).join(' ')

test('the three launchers are one text, apart from the script each runs', { skip: !windows }, () => {
  const texts = Object.keys(LAUNCHERS).map(l => fs.readFileSync(path.join(ROOT, l), 'latin1'))
  for (const t of texts) {
    assert.ok(!/(^|[^\r])\n/.test(t), 'CRLF throughout (cmd misreads labels in an LF batch file)')
    assert.match(t, /^@echo off\r\n/)
  }
  const common = t => t.split('\r\n').filter(l => !/HVMCP_SCRIPT=/.test(l)).join('\n')
  assert.strictEqual(new Set(texts.map(common)).size, 1)
  assert.match(texts[0], /set "HVMCP_SCRIPT=%~dp0install\.ps1"/)
  assert.match(texts[1], /set "HVMCP_SCRIPT=%~dp0uninstall\.ps1"\r\nif not exist "%HVMCP_SCRIPT%" set "HVMCP_SCRIPT=%~dp0uninstall\\uninstall\.ps1"/)
  assert.match(texts[2], /set "HVMCP_SCRIPT=%~dp0approve\.ps1"/)
  // Every program by its full path: reg.exe under %SystemRoot%, the engines from their registration.
  const code = common(texts[0]).split('\n').filter(l => !/^\s*(rem|echo) /.test(l)).join('\n')
  assert.doesNotMatch(code, /(^|[\s('"&])(powershell|pwsh|reg|findstr|where|cmd)(\.exe)?\s/im)
  assert.deepStrictEqual([...code.matchAll(/"%SystemRoot%\\System32\\(\w+\.exe)"/g)].map(m => m[1]), ['reg.exe', 'reg.exe', 'cmd.exe'])
})

for (const launcher of Object.keys(LAUNCHERS)) {
  for (const caller of CALLERS) {
    test(`${launcher}, typed in ${caller === 'cmd' ? 'cmd' : `PowerShell ${caller}`}: spaced paths and arguments arrive exactly; exit codes reach the caller`, { skip: !windows }, () => {
      const file = place(`launch-${path.basename(launcher, '.cmd')}-${caller}`, launcher)
      const r = typeIn(caller, `cmd /c call "${file}" ${typed(SPACED)}`, { env: { HVMCP_TEST_EXIT: '7' } })
      assert.ok(r.stub, `the script ran: ${r.out}${r.err}`)
      assert.deepStrictEqual(r.stub.args, SPACED)
      assert.strictEqual(r.stub.engine, ENGINES[0].name === '5.1' ? 'Desktop' : 'Core', 'Windows PowerShell 5.1 where it is registered')
      assert.strictEqual(r.status, 7)
      const ok = typeIn(caller, `cmd /c call "${file}" -Plan p-0123456789abcdef`, { env: { HVMCP_TEST_EXIT: '0' } })
      assert.deepStrictEqual([ok.status, ok.stub?.args], [0, ['-Plan', 'p-0123456789abcdef']])
    })
  }
}

test('no Windows PowerShell registered: the launcher runs PowerShell 7, from cmd and from PowerShell 7', { skip: !windows || !HAS7 }, () => {
  const file = place('launch-no51', 'setup/install.cmd', t => t.replace('PowerShell\\3\\PowerShellEngine', 'PowerShell\\3\\HvMcpNoSuchEngine'))
  for (const caller of ['cmd', '7']) {
    const r = typeIn(caller, `cmd /c call "${file}" ${typed(SPACED)}`, { env: { HVMCP_TEST_EXIT: '7' } })
    assert.ok(r.stub, `${caller}: ${r.out}${r.err}`)
    assert.strictEqual(r.stub.engine, 'Core')
    assert.deepStrictEqual(r.stub.args, SPACED)
    assert.strictEqual(r.status, 7)
  }
})

test('neither registered: nothing runs, it says why, exit 1', { skip: !windows }, () => {
  const file = place('launch-none', 'setup/install.cmd', t => t.replace('PowerShell\\3\\PowerShellEngine', 'PowerShell\\3\\HvMcpNoSuchEngine').replace('PowerShellCore\\InstalledVersions', 'HvMcpNoSuchCore'))
  for (const caller of CALLERS) {
    const r = typeIn(caller, `cmd /c call "${file}" -DiskFolder D:\\hv`)
    assert.strictEqual(r.stub, null, caller)
    assert.strictEqual(r.status, 1, caller)
    assert.match(r.err, /Neither Windows PowerShell nor PowerShell 7 is installed: nothing was run\./, caller)
  }
})

test('nothing is taken from PATH or the current folder: fake powershell, pwsh and reg there never run', { skip: !windows }, () => {
  const file = place('launch-hijack', 'setup/install.cmd')
  const fakes = path.join(scratch('launch-fakes').dir, 'fakes')
  fs.mkdirSync(fakes, { recursive: true })
  const marker = path.join(fakes, 'ran.txt')
  for (const n of ['powershell', 'pwsh', 'reg', 'findstr', 'where']) for (const ext of ['.bat', '.cmd']) {
    fs.writeFileSync(path.join(fakes, n + ext), `@echo ${n}${ext}>>"${marker}"\r\n@exit /b 0\r\n`)
  }
  for (const caller of CALLERS) {
    const r = typeIn(caller, `cmd /c call "${file}" -DiskFolder "D:\\some folder"`, { cwd: fakes, env: { PATH: `${fakes};${process.env.PATH}`, Path: `${fakes};${process.env.PATH}`, HVMCP_TEST_EXIT: '0' } })
    assert.ok(r.stub, `${caller}: ${r.out}${r.err}`)
    assert.strictEqual(r.status, 0)
    assert.ok(!fs.existsSync(marker), `${caller}: a fake ran: ${fs.existsSync(marker) && fs.readFileSync(marker, 'utf8')}`)
  }
})

test('a % or ^ still in an argument when the launcher runs is refused, the script never run; what the shell expands first arrives expanded (the documented limit)', { skip: !windows }, () => {
  const file = place('launch-chars', 'setup/install.cmd')
  const refused = (caller, line) => {
    const r = typeIn(caller, line, { env: { HVMCP_TEST_EXIT: '0' } })
    assert.strictEqual(r.stub, null, `${caller}: ran with ${JSON.stringify(r.stub)}`)
    assert.strictEqual(r.status, 1, caller)
    assert.match(r.err, /An argument holds % or \^, which cmd would change on the way: nothing was run\./, caller)
  }
  // An unset variable stays as typed, through cmd and call: the launcher sees its % and refuses.
  for (const caller of CALLERS) refused(caller, `cmd /c call "${file}" -DiskFolder "D:\\50%HVMCP_NO_SUCH_VAR%x y"`)
  // A quoted ^ reaches the launcher (call doubles it): refused.
  for (const caller of CALLERS) refused(caller, `cmd /c call "${file}" -DiskFolder "D:\\a^b c"`)
  // A set variable is expanded by cmd before the launcher runs: it can't tell, and it isn't claimed to.
  const r = typeIn('cmd', `cmd /c call "${file}" -DiskFolder "D:\\%HVMCP_SET_VAR%"`, { env: { HVMCP_SET_VAR: 'expanded', HVMCP_TEST_EXIT: '0' } })
  assert.deepStrictEqual(r.stub?.args, ['-DiskFolder', 'D:\\expanded'])
})

test('the installed uninstall.cmd runs uninstall\\uninstall.ps1, and finishes cleanly when the uninstall removes it', { skip: !windows }, () => {
  const pf = path.join(scratch('launch-installed').dir, 'Program Files', 'hyperv-mcp')
  fs.mkdirSync(path.join(pf, 'uninstall'), { recursive: true })
  const file = path.join(pf, 'uninstall.cmd')
  fs.copyFileSync(path.join(ROOT, 'setup', 'uninstall.cmd'), file)
  fs.writeFileSync(path.join(pf, 'uninstall', 'uninstall.ps1'), STUB)
  for (const caller of CALLERS) {
    if (!fs.existsSync(file)) fs.copyFileSync(path.join(ROOT, 'setup', 'uninstall.cmd'), file)
    const r = typeIn(caller, `cmd /c call "${file}" -KeepPool`, { env: { HVMCP_TEST_EXIT: '5', HVMCP_TEST_DELETE: file } })
    assert.deepStrictEqual(r.stub?.args, ['-KeepPool'], `${caller}: ${r.out}${r.err}`)
    assert.ok(!fs.existsSync(file), 'the stub removed the launcher, as the uninstall\'s teardown does')
    assert.strictEqual(r.status, 5, caller)
    assert.doesNotMatch(r.err, /batch file cannot be found/i, caller)
  }
})

test('typed without cmd /c, in a cmd session or from a batch file, the launcher hands on its exit code and the caller goes on', { skip: !windows }, () => {
  const file = place('launch-direct', 'helper/approve.cmd')
  const env = { ...process.env, HVMCP_TEST_EXIT: '5' }
  const direct = spawnSync(COMSPEC, ['/d', '/s', '/c', `""${file}" -Plan p-0123456789abcdef & call echo AFTER=%^errorlevel%"`], { windowsVerbatimArguments: true, encoding: 'utf8', env, timeout: T.spawnMs })
  assert.match(direct.stdout, /STUB:.*\r?\nAFTER=5/, direct.stdout + direct.stderr)
  const caller = path.join(path.dirname(file), 'caller.cmd')
  fs.writeFileSync(caller, `@echo off\r\ncall "${file}" -Plan p-0123456789abcdef\r\necho AFTER-CALL=%errorlevel%\r\n`)
  const batch = spawnSync(COMSPEC, ['/d', '/c', caller], { encoding: 'utf8', env, timeout: T.spawnMs })
  assert.match(batch.stdout, /AFTER-CALL=5/, batch.stdout + batch.stderr)
  assert.strictEqual(batch.status, 0)
})

test('hv.js finds its engine as the launchers do: 5.1 first, else the last PowerShell 7, never PATH', () => {
  const regOut = {
    [KEY51]: '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\PowerShell\\3\\PowerShellEngine\r\n    ApplicationBase    REG_SZ    C:\\Windows\\System32\\WindowsPowerShell\\v1.0\r\n\r\n',
    [KEY7]: '\r\nHKEY_LOCAL_MACHINE\\...\\{a}\r\n    InstallLocation    REG_SZ    C:\\Program Files\\PowerShell\\7-preview\\\r\n\r\nHKEY_LOCAL_MACHINE\\...\\{b}\r\n    InstallLocation    REG_SZ    C:\\Program Files\\PowerShell\\7\\\r\n\r\nEnd of search: 2 match(es) found.\r\n'
  }
  const calls = []
  const run = (exe, args) => { calls.push([exe, ...args]); return regOut[args[1]] ? { status: 0, stdout: regOut[args[1]] } : { status: 1, stdout: '' } }
  const all = () => true
  assert.strictEqual(findEngine({ run, exists: all }), path.join('C:\\Windows\\System32\\WindowsPowerShell\\v1.0', 'powershell.exe'))
  assert.match(calls[0][0], /System32[\\/]reg\.exe$/i, 'reg.exe by its full path')
  assert.deepStrictEqual(calls[0].slice(1), ['query', KEY51, '/v', 'ApplicationBase'])
  assert.strictEqual(findEngine({ run, exists: f => !/powershell\.exe$/i.test(f) }), path.join('C:\\Program Files\\PowerShell\\7\\', 'pwsh.exe'), 'the 5.1 file missing: the last 7')
  assert.strictEqual(findEngine({ run, key51: 'HKLM\\nope', exists: all }), path.join('C:\\Program Files\\PowerShell\\7\\', 'pwsh.exe'))
  assert.strictEqual(findEngine({ run, key51: 'HKLM\\nope', exists: f => !/\\7\\pwsh/.test(f) }), path.join('C:\\Program Files\\PowerShell\\7-preview\\', 'pwsh.exe'))
  assert.throws(() => findEngine({ run, key51: 'HKLM\\nope', key7: 'HKLM\\nope7', exists: all }), /neither Windows PowerShell nor PowerShell 7 is installed/)
  // A PowerShell 7 child keeps its module folders; a 5.1 child loses 7's.
  const env = { PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules', X: '1' }
  assert.deepStrictEqual(psEnv('C:\\Program Files\\PowerShell\\7\\pwsh.exe', env), env)
  assert.strictEqual(psEnv('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', env).PSModulePath, 'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules')
})

test('hv.js runs hv.ps1 with the engine the service names (HYPERV_MCP_POWERSHELL), under each engine installed', { skip: !windows }, async () => {
  for (const E of ENGINES) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(ROOT, 'helper', 'hv.js'))}).hv('nope', {}).then(a => console.log('OK', JSON.stringify(a)), e => console.log('ERR', e.message))`], { encoding: 'utf8', env: { ...process.env, HYPERV_MCP_POWERSHELL: E.exe }, timeout: T.spawnMs })
    // hv.ps1 answers an unknown op with its own error: it ran, under this engine.
    assert.match(r.stdout, /^ERR nope: /m, `${E.name}: ${r.stdout}${r.stderr}`)
  }
})
