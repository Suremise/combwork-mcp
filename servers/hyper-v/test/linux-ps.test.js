// hv.ps1's Linux actions (MC-1501), run for real under Windows PowerShell 5.1 and PowerShell 7 (MC-1575): the whole script, dot-sourced after
// mocks of the Hyper-V cmdlets they call (functions win over cmdlets), with { op, args } on stdin as the helper sends it.
// No Hyper-V call is made. com-read reads a real named pipe served by this test: lines across a quiet spell longer
// than its 5 s wait, a line split across writes, the pipe closing and coming back (a guest restart), 64 KB without a
// newline, and a silent guest until the deadline.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const { T, scratch, psEngines } = require('./helpers')
// MC-1575: hv.ps1 runs under the PowerShell setup ran in, 5.1 or 7: every case here runs under each one installed.
const ENGINES = psEngines()
let ENGINE = ENGINES[0]

const HV = path.join(__dirname, '..', 'helper', 'hv.ps1')
const skip = process.platform !== 'win32'
const VM = { vmId: '11111111-1111-1111-1111-111111111111', name: 'hvmcp-ab12', folder: 'C:\\pool\\i-0123456789abcdef' }

const MOCKS = `$global:calls = New-Object Collections.Generic.List[string]
function Get-VM { [CmdletBinding()] param($Id) [pscustomobject]@{ Id = [guid]'${VM.vmId}'; Name = '${VM.name}'; ConfigurationLocation = '${VM.folder}\\${VM.name}'; State = 'Off' } }
function Set-VMComPort { [CmdletBinding()] param($VM, $Number, $Path) $global:comPath = $Path; $global:calls.Add("Set-VMComPort $Number [$Path]") }
function Get-VMComPort { [CmdletBinding()] param($VM, $Number) [pscustomobject]@{ Path = $global:comPath } }
function Convert-VHD { [CmdletBinding()] param($Path, $DestinationPath, $VHDType) $global:calls.Add("Convert-VHD [$Path] [$DestinationPath] $VHDType") }
`

/** Runs hv.ps1 with op and args, after the mocks and an optional prelude; returns { answer, calls }. */
function hv(name, op, args, prelude = '', timeout = 60_000) {
  const sc = scratch(`lxps-${name}`)
  const file = path.join(sc.dir, 'case.ps1')
  fs.writeFileSync(file, `${MOCKS}\n${prelude}\n. '${HV.replace(/'/g, "''")}'\n'CALLS:' + (ConvertTo-Json -InputObject @($global:calls) -Compress)\n`)
  const r = spawnSync(ENGINE.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { input: JSON.stringify({ op, args }), encoding: 'utf8', env: ENGINE.env, timeout })
  const out = r.stdout.split(/\r?\n/)
  const ans = out.find(l => l.startsWith('HVJSON:'))
  const calls = out.find(l => l.startsWith('CALLS:'))
  assert.ok(ans, r.stdout + r.stderr)
  return { answer: JSON.parse(ans.slice(7)), calls: calls ? JSON.parse(calls.slice(6)) : [] }
}

for (const E of ENGINES) test.describe(`hv.ps1's Linux actions under PowerShell ${E.name}`, () => {
test.before(() => { ENGINE = E })

test('com-attach sets COM1 to \\\\.\\pipe\\<name> exactly, and com-detach unsets it, read back; a bad name is refused before any call', { skip }, () => {
  const pipe = 'hvmcp-diag-0123456789abcdef'
  const a = hv('attach', 'com-attach', { ...VM, pipe })
  assert.deepStrictEqual(a.answer, { result: { path: `\\\\.\\pipe\\${pipe}` } })
  assert.deepStrictEqual(a.calls, [`Set-VMComPort 1 [\\\\.\\pipe\\${pipe}]`])
  const d = hv('detach', 'com-detach', { ...VM })
  assert.deepStrictEqual(d.answer, { result: { path: '' } })
  assert.deepStrictEqual(d.calls, ['Set-VMComPort 1 []'])
  for (const bad of ['hvmcp-diag-xyz', '..\\evil', 'hvmcp-diag-0123456789abcdef\\x']) {
    const b = hv('attach-bad', 'com-attach', { ...VM, pipe: bad })
    assert.deepStrictEqual(b.answer, { error: 'bad pipe name' })
    assert.deepStrictEqual(b.calls, [])
  }
})

test('vhd-convert: the helper\'s own convert-<12 hex>.vhd to <SHA-256>.vhdx reaches Convert-VHD; anything else, or an existing VHDX, is refused', { skip }, () => {
  const sc = scratch('lxps-convert')
  const vhd = path.join(sc.disks, 'images', 'convert-012345abcdef.vhd')
  const vhdx = path.join(sc.disks, 'images', `${'a'.repeat(64)}.vhdx`)
  const ok = hv('convert', 'vhd-convert', { vhd, vhdx })
  assert.deepStrictEqual(ok.answer, { result: { vhdx } })
  assert.deepStrictEqual(ok.calls, [`Convert-VHD [${vhd}] [${vhdx}] Dynamic`])
  for (const [v, x] of [[vhd.replace('convert-', 'other-'), vhdx], [vhd, vhdx.replace('aaaa.vhdx', 'aaaa.vhd')], [vhd, path.join(sc.disks, 'images', 'short.vhdx')], ['convert-012345abcdef.vhd', vhdx]]) {
    const r = hv('convert-bad', 'vhd-convert', { vhd: v, vhdx: x })
    assert.deepStrictEqual(r.answer, { error: 'bad conversion paths' }, `${v} -> ${x}`)
    assert.deepStrictEqual(r.calls, [])
  }
  fs.mkdirSync(path.dirname(vhdx), { recursive: true })
  fs.writeFileSync(vhdx, 'x')
  const exists = hv('convert-exists', 'vhd-convert', { vhd, vhdx })
  assert.deepStrictEqual(exists.answer, { error: 'the base VHDX already exists' })
  assert.deepStrictEqual(exists.calls, [])
})

/** A prelude serving the pipe from a background runspace: each session is a list of [write text | sleep ms | 'close']. */
function serve(pipe, sessions, stopFile = '') {
  // A list built item by item: PowerShell would flatten a one-session @(@(...)) into its steps. A step 'STOPFILE'
  // writes the stop file (MC-1545), as the helper does when its readiness wait is over.
  const adds = sessions.map(s => `[void]$sessionList.Add(@(${s.map(x => typeof x === 'number' ? `${x}` : `'${x.replace(/'/g, "''")}'`).join(',')}))`).join('\n')
  return `$sessionList = New-Object Collections.ArrayList
${adds}
$srv = [powershell]::Create()
[void]$srv.AddScript({
  param($name, $sessions, $stop)
  foreach ($steps in $sessions) {
    $s = New-Object IO.Pipes.NamedPipeServerStream($name, [IO.Pipes.PipeDirection]::Out)
    $s.WaitForConnection()
    foreach ($x in $steps) {
      if ($x -is [int]) { Start-Sleep -Milliseconds $x }
      elseif ($x -eq 'STOPFILE') { [IO.File]::WriteAllText($stop, 'stop') }
      else { $b = [Text.Encoding]::ASCII.GetBytes((($x -replace '\\\\n', [string][char]10) -replace '\\\\r', [string][char]13)); $s.Write($b, 0, $b.Length); $s.Flush() }
    }
    $s.Dispose()
  }
}).AddArgument('${pipe}').AddArgument($sessionList).AddArgument('${stopFile.replace(/'/g, "''")}')
$global:srvHandle = $srv.BeginInvoke()
`
}

const pipeName = () => `hvmcp-diag-${crypto.randomBytes(8).toString('hex')}`

test('com-read: lines across a quiet spell longer than its wait and a line split across writes, to the seed\'s last stage; only the HVMCP-DIAG part kept', { skip }, () => {
  const pipe = pipeName()
  const t0 = Date.now()
  const r = hv('read-quiet', 'com-read', { pipe, ms: 30_000 }, serve(pipe, [['boot noise\\n[  1.0] x HVMCP-DIAG stage=seed-read vmbus=present\\r\\n', 6500, 'HVMCP-DIAG stage=sock', 300, 'et-up vsock_listen=active\\nafter\\n', 3000]]))
  assert.deepStrictEqual(r.answer.result, { lines: ['HVMCP-DIAG stage=seed-read vmbus=present', 'HVMCP-DIAG stage=socket-up vsock_listen=active'], connected: true, complete: true, overflow: false, stopped: false })
  assert.ok(Date.now() - t0 < T.bounds.lastStageEndsMs, 'it ended at the last stage, not the deadline')
})

test('com-read: the pipe closing and coming back (a guest restart) is read on; 64 KB without a newline stops it; a silent guest ends at the deadline', { skip }, () => {
  const pipe = pipeName()
  const r = hv('read-restart', 'com-read', { pipe, ms: 30_000 }, serve(pipe, [['HVMCP-DIAG stage=seed-read\\n', 200], ['HVMCP-DIAG stage=socket-up k=v\\n', 2000]]))
  assert.deepStrictEqual(r.answer.result.lines, ['HVMCP-DIAG stage=seed-read', 'HVMCP-DIAG stage=socket-up k=v'])
  assert.strictEqual(r.answer.result.complete, true)
  const big = pipeName()
  const o = hv('read-big', 'com-read', { pipe: big, ms: 30_000 }, serve(big, [['x'.repeat(30000), 'y'.repeat(30000), 'z'.repeat(30000), 5000]]))
  assert.deepStrictEqual(o.answer.result, { lines: [], connected: true, complete: false, overflow: true, stopped: false })
  const quiet = pipeName()
  const t0 = Date.now()
  const q = hv('read-silent', 'com-read', { pipe: quiet, ms: 7000 }, serve(quiet, [[12000]]))
  assert.deepStrictEqual(q.answer.result, { lines: [], connected: true, complete: false, overflow: false, stopped: false })
  assert.ok(Date.now() - t0 >= 6500, 'it waited to its deadline, past one 5 s wait, without failing')
  assert.deepStrictEqual(hv('read-bad', 'com-read', { pipe: 'evil', ms: 100 }).answer, { error: 'bad pipe name' })
})

test('MC-1545 com-read through the wait: the seed\'s last stage doesn\'t end it, the guest\'s connection lines are read after it, and the helper\'s stop file ends it; another stop file is refused', { skip }, () => {
  const pipe = pipeName()
  const sc = scratch('lxps-through')
  fs.mkdirSync(path.join(sc.dir, 'runs'), { recursive: true })
  const stopFile = path.join(sc.dir, 'runs', `${pipe}.stop`)
  const t0 = Date.now()
  const r = hv('read-through', 'com-read', { pipe, ms: 30_000, through: true, stopFile }, serve(pipe, [['HVMCP-DIAG stage=socket-up k=v\n', 1500, 'HVMCP-DIAG stage=conn-start n=1\n', 500, 'HVMCP-DIAG stage=conn-end result=exit-code code=exited status=255\n', 500, 'STOPFILE', 20000]], stopFile))
  assert.deepStrictEqual(r.answer.result, { lines: ['HVMCP-DIAG stage=socket-up k=v', 'HVMCP-DIAG stage=conn-start n=1', 'HVMCP-DIAG stage=conn-end result=exit-code code=exited status=255'], connected: true, complete: true, overflow: false, stopped: true })
  assert.ok(Date.now() - t0 < T.bounds.stopFileEndsMs, 'the stop file ended it, not the deadline')
  for (const bad of [path.join(sc.dir, 'elsewhere', `${pipe}.stop`), path.join(sc.dir, 'runs', 'hvmcp-diag-0000000000000000.stop')]) {
    assert.deepStrictEqual(hv('read-badstop', 'com-read', { pipe, ms: 100, through: true, stopFile: bad }).answer, { error: 'bad stop file' })
  }
})
})

test('MC-1545 HvMcpVsock.exe, compiled by the in-box compiler as setup does: its usage, and an AF_HYPERV connect that fails says so at once (exit 255)', { skip }, () => {
  const sc = scratch('lxps-vsock')
  const exe = path.join(sc.dir, 'HvMcpVsock.exe')
  const csc = path.join(process.env.WINDIR || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const c = spawnSync(csc, ['-nologo', '-target:exe', '-optimize', `-out:${exe}`, path.join(__dirname, '..', 'helper', 'host', 'HvMcpVsock.cs')], { encoding: 'utf8' })
  assert.strictEqual(c.status, 0, c.stdout + c.stderr)
  const u = spawnSync(exe, [], { encoding: 'utf8' })
  assert.strictEqual(u.status, 2)
  assert.match(u.stderr, /usage: HvMcpVsock\.exe <vmId> <port>/)
  const t0 = Date.now()
  const r = spawnSync(exe, ['00000000-0000-0000-0000-000000000001', '22'], { encoding: 'utf8', input: '', timeout: T.probeMs })
  assert.strictEqual(r.status, 255, r.stderr)
  assert.match(r.stderr, /^HvMcpVsock: (can't connect to the guest's vsock port 22: |connect timed out after \d+ ms)/)
  assert.ok(Date.now() - t0 < T.bounds.connectBoundMs, 'bounded by its own 20 s connect timeout at most')
  // The connected and closed lines need a real guest's listener: MC-1542's trial shows them.
})
