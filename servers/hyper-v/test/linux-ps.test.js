// hv.ps1's Linux actions (MC-1501), run for real under Windows PowerShell 5.1: the whole script, dot-sourced after
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
const { ps51Env } = require('../helper/hv')
const { scratch } = require('./helpers')

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
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { input: JSON.stringify({ op, args }), encoding: 'utf8', env: ps51Env(), timeout })
  const out = r.stdout.split(/\r?\n/)
  const ans = out.find(l => l.startsWith('HVJSON:'))
  const calls = out.find(l => l.startsWith('CALLS:'))
  assert.ok(ans, r.stdout + r.stderr)
  return { answer: JSON.parse(ans.slice(7)), calls: calls ? JSON.parse(calls.slice(6)) : [] }
}

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
function serve(pipe, sessions) {
  // A list built item by item: PowerShell would flatten a one-session @(@(...)) into its steps.
  const adds = sessions.map(s => `[void]$sessionList.Add(@(${s.map(x => typeof x === 'number' ? `${x}` : `'${x.replace(/'/g, "''")}'`).join(',')}))`).join('\n')
  return `$sessionList = New-Object Collections.ArrayList
${adds}
$srv = [powershell]::Create()
[void]$srv.AddScript({
  param($name, $sessions)
  foreach ($steps in $sessions) {
    $s = New-Object IO.Pipes.NamedPipeServerStream($name, [IO.Pipes.PipeDirection]::Out)
    $s.WaitForConnection()
    foreach ($x in $steps) {
      if ($x -is [int]) { Start-Sleep -Milliseconds $x }
      else { $b = [Text.Encoding]::ASCII.GetBytes((($x -replace '\\\\n', [string][char]10) -replace '\\\\r', [string][char]13)); $s.Write($b, 0, $b.Length); $s.Flush() }
    }
    $s.Dispose()
  }
}).AddArgument('${pipe}').AddArgument($sessionList)
$global:srvHandle = $srv.BeginInvoke()
`
}

const pipeName = () => `hvmcp-diag-${crypto.randomBytes(8).toString('hex')}`

test('com-read: lines across a quiet spell longer than its wait and a line split across writes, to the seed\'s last stage; only the HVMCP-DIAG part kept', { skip }, () => {
  const pipe = pipeName()
  const t0 = Date.now()
  const r = hv('read-quiet', 'com-read', { pipe, ms: 30_000 }, serve(pipe, [['boot noise\\n[  1.0] x HVMCP-DIAG stage=seed-read vmbus=present\\r\\n', 6500, 'HVMCP-DIAG stage=sock', 300, 'et-up vsock_listen=active\\nafter\\n', 3000]]))
  assert.deepStrictEqual(r.answer.result, { lines: ['HVMCP-DIAG stage=seed-read vmbus=present', 'HVMCP-DIAG stage=socket-up vsock_listen=active'], connected: true, complete: true, overflow: false })
  assert.ok(Date.now() - t0 < 25_000, 'it ended at the last stage, not the deadline')
})

test('com-read: the pipe closing and coming back (a guest restart) is read on; 64 KB without a newline stops it; a silent guest ends at the deadline', { skip }, () => {
  const pipe = pipeName()
  const r = hv('read-restart', 'com-read', { pipe, ms: 30_000 }, serve(pipe, [['HVMCP-DIAG stage=seed-read\\n', 200], ['HVMCP-DIAG stage=socket-up k=v\\n', 2000]]))
  assert.deepStrictEqual(r.answer.result.lines, ['HVMCP-DIAG stage=seed-read', 'HVMCP-DIAG stage=socket-up k=v'])
  assert.strictEqual(r.answer.result.complete, true)
  const big = pipeName()
  const o = hv('read-big', 'com-read', { pipe: big, ms: 30_000 }, serve(big, [['x'.repeat(30000), 'y'.repeat(30000), 'z'.repeat(30000), 5000]]))
  assert.deepStrictEqual(o.answer.result, { lines: [], connected: true, complete: false, overflow: true })
  const quiet = pipeName()
  const t0 = Date.now()
  const q = hv('read-silent', 'com-read', { pipe: quiet, ms: 7000 }, serve(quiet, [[12000]]))
  assert.deepStrictEqual(q.answer.result, { lines: [], connected: true, complete: false, overflow: false })
  assert.ok(Date.now() - t0 >= 6500, 'it waited to its deadline, past one 5 s wait, without failing')
  assert.deepStrictEqual(hv('read-bad', 'com-read', { pipe: 'evil', ms: 100 }).answer, { error: 'bad pipe name' })
})
