// MC-1588: the size limits that go to or from the guest in one call, settled. Through helper.js against the stub
// Hyper-V: a vm_run command's length is a setting (HYPERV_MCP_COMMAND_CHARS, default 8000); a long one reaches a
// Windows guest in pieces (guest-run-stage), never one call carrying it all, as the account that runs it, and a start
// refuses a staging that isn't whole; vm_read_out reads a Windows guest's files back in calls of at most 2 MB, going on
// from where each stopped, and its only ceiling is what one reply can hold. The Linux side (bytes after the request
// line, and a dispatcher built before MC-1588) is in linux.test.js and guest_unit_check.py.
const test = require('node:test')
const assert = require('assert')
const { scratch, withPool } = require('./helpers')
const { READ_TOTAL_MAX, RUN_INLINE_CHARS, READ_PART_BYTES } = require('../helper/core')

async function running(t, name, stub = {}) {
  const sc = scratch(name, { stub })
  const { h } = await withPool(sc, 1)
  t.after(() => h.stop())
  const a = h.conn(1)
  return { sc, h, a }
}
const start = async a => { await a.request('acquire', { minutes: 30 }); await a.request('start') }

test('MC-1588: a vm_run command is at most commandChars (default 8000), the connection\'s setting, kept by its lease', async t => {
  const { a } = await running(t, 'caps-cmd-default')
  await start(a)
  assert.match((await a.request('run', { command: `echo ${'x'.repeat(7995)}` })).text, /^Exit code 0\./, '8000 characters: taken')
  await assert.rejects(a.request('run', { command: `echo ${'x'.repeat(7996)}` }), /command is over 8000 characters \(HYPERV_MCP_COMMAND_CHARS\): raise that setting, or put the command in a script in the build/)
  await a.request('set-timing', { timing: { commandChars: 100_000 } })
  await assert.rejects(a.request('run', { command: `echo ${'x'.repeat(9000)}` }), /over 8000 characters/, 'the lease keeps the value it was acquired with')
})

test('MC-1588: a long command reaches a Windows guest in 1 MB pieces (base64), as the account that runs it, then runs whole; a short one goes in the start as before', async t => {
  const { sc, h, a } = await running(t, 'caps-cmd-staged')
  await a.request('set-timing', { timing: { commandChars: 3 * 1024 * 1024 } })
  await start(a)
  // At the inline limit: in the start call, no staging.
  const inline = `echo ${'i'.repeat(RUN_INLINE_CHARS - 5)}`
  assert.match((await a.request('run', { command: inline })).text, /^Exit code 0\./)
  assert.strictEqual(sc.stub().stageCalls, undefined, 'no staging up to the inline limit')
  // 2.2 MB of command, run as the standard user: three pieces, each as that user, then a start carrying no command.
  const long = `echo ${'é'.repeat(1_100_000)}`
  const r = await a.request('run', { command: long, as: 'user' })
  assert.ok(/^Exit code 0\.\n--- stdout ---\néé/.test(r.text), r.text.slice(0, 200))
  const st = sc.stub()
  const bytes = Buffer.byteLength(long)
  assert.deepStrictEqual(st.stageCalls.map(c => c.part), [0, 1, 2])
  assert.ok(st.stageCalls.every(c => c.as === 'user' && c.chars <= Math.ceil(1024 * 1024 / 3) * 4), 'pieces of at most 1 MB as base64, as the user')
  assert.deepStrictEqual(st.stagedRuns.at(-1), { n: st.stageCalls[0].n, bytes, interactive: false })
  assert.strictEqual(st.calls.filter(c => c.op === 'guest-run-start').at(-1).command, undefined, 'the start carries no command')
  const vm = Object.values(st.vms)[0]
  assert.strictEqual(vm.runs[st.stageCalls[0].n].command, long, 'what runs is the command, byte for byte')
  assert.strictEqual(vm.runs[st.stageCalls[0].n].as, 'hvuser')
  // A staging the guest doesn't confirm whole: the run is never started.
  sc.patchStub(s => { s.stageShort = true })
  const starts = st.calls.filter(c => c.op === 'guest-run-start').length
  await assert.rejects(a.request('run', { command: long }), /the run's command couldn't be staged in the guest \(1048575 of 1048576 bytes after piece 1\)/)
  assert.strictEqual(sc.stub().calls.filter(c => c.op === 'guest-run-start').length, starts, 'no start after a short staging')
  await h.stop()
})

test('MC-1588: vm_read_out reads a Windows guest\'s files in calls of at most 2 MB, going on where each stopped; maxBytes has no cap of its own, maxTotalBytes the one reply\'s', async t => {
  const { sc, a } = await running(t, 'caps-read')
  await start(a)
  const big = Buffer.alloc(5 * 1024 * 1024 + 7)
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) % 251
  const small = Buffer.from('small file')
  sc.patchStub(s => {
    const vm = Object.values(s.vms)[0]
    vm.disk['C:\\out\\a.bin'] = small.toString('base64')
    vm.disk['C:\\out\\big.bin'] = big.toString('base64')
    vm.disk['C:\\out\\z.txt'] = Buffer.from('after the big one').toString('base64')
  })
  const before = (sc.stub().readCalls || []).length
  const r = await a.request('read_out', { paths: ['a.bin', 'big.bin', 'z.txt'], maxBytes: 32 * 1024 * 1024, maxTotalBytes: 6 * 1024 * 1024 })
  const files = r.files
  assert.deepStrictEqual(files.map(f => [f.path, f.size, f.cut]), [['a.bin', small.length, false], ['big.bin', big.length, false], ['z.txt', 17, false]])
  assert.ok(Buffer.from(files[1].data, 'base64').equals(big), 'the big file whole, in order')
  const calls = sc.stub().readCalls.slice(before)
  assert.ok(calls.every(c => c.maxTotalBytes <= READ_PART_BYTES && c.bytes <= READ_PART_BYTES), JSON.stringify(calls))
  assert.deepStrictEqual(calls.map(c => [c.paths, c.offset]), [[3, 0], [2, READ_PART_BYTES - small.length], [2, 2 * READ_PART_BYTES - small.length]], 'went on in big.bin at its offset, then z.txt in the last call')
  // The call's total cuts the read where it ends, mid-file.
  const cut = await a.request('read_out', { paths: ['big.bin', 'z.txt'], maxBytes: 32 * 1024 * 1024, maxTotalBytes: 3 * 1024 * 1024 })
  assert.deepStrictEqual(cut.files.map(f => [f.path, f.cut]), [['big.bin', true]])
  // maxBytes per file still counts from each file's start.
  const per = await a.request('read_out', { paths: ['big.bin', 'z.txt'], maxBytes: 3 * 1024 * 1024 })
  assert.deepStrictEqual(per.files.map(f => [f.path, f.cut]), [['big.bin', true]], 'the default total, 1 MB')
  const per2 = await a.request('read_out', { paths: ['big.bin', 'z.txt'], maxBytes: 3 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 })
  assert.deepStrictEqual(per2.files.map(f => [f.path, f.cut]), [['big.bin', true], ['z.txt', false]])
  // The ceilings: maxTotalBytes at what one reply can hold, with its reason; maxBytes none of its own.
  assert.strictEqual(READ_TOTAL_MAX, Math.floor((require('buffer').constants.MAX_STRING_LENGTH - 1024 * 1024) / 6))
  await assert.rejects(a.request('read_out', { paths: ['a.bin'], maxTotalBytes: READ_TOTAL_MAX + 1 }), new RegExp(`maxTotalBytes must be 1-${READ_TOTAL_MAX}: the files come back in one reply, which Node holds as one string`))
  assert.strictEqual((await a.request('read_out', { paths: ['a.bin'], maxBytes: 2 ** 40, maxTotalBytes: READ_TOTAL_MAX })).files[0].size, small.length)
  // Round 2: a maxBytes past Int64 (which hv.ps1 casts to [long]; the stub refuses it as that cast does) reaches the
  // guest clamped to the call's total, so it reads as any other.
  for (const huge of [1e20, 1e21, Number.MAX_SAFE_INTEGER * 2 ** 20]) {
    const r = await a.request('read_out', { paths: ['a.bin', 'big.bin'], maxBytes: huge, maxTotalBytes: 1024 })
    assert.deepStrictEqual(r.files.map(f => [f.path, Buffer.from(f.data, 'base64').length, f.cut]), [['a.bin', small.length, false], ['big.bin', 1024 - small.length, true]], `${huge}`)
    assert.ok(sc.stub().readCalls.at(-1).maxBytes <= 1024, `${huge} sent as ${sc.stub().readCalls.at(-1).maxBytes}`)
  }
  await assert.rejects(a.request('read_out', { maxBytes: 0 }), /maxBytes must be a whole number of bytes, at least 1/)
})

test('MC-1588: ssh.js reads a Linux guest\'s answer up to room for vm_read_out\'s most, as base64', () => {
  const { OUT_CAP } = require('../helper/ssh')
  assert.ok(OUT_CAP >= Math.ceil(READ_TOTAL_MAX / 3) * 4 + 1024 * 1024, `${OUT_CAP}`)
  assert.ok(OUT_CAP < require('buffer').constants.MAX_STRING_LENGTH)
})

// The guest side for real, in Windows PowerShell 5.1: hv.ps1's own $GuestRunStage, $RunFiles and $GuestRead (its C:\out
// root pointed at a scratch folder), as the guest runs them.
test('MC-1588: hv.ps1 for real: pieces staged and moved into place whole (a short staging refused), and a read from an offset', { skip: process.platform !== 'win32' }, () => {
  const fs = require('fs')
  const path = require('path')
  const { spawnSync } = require('child_process')
  const { ps51Env } = require('../helper/hv')
  const { T } = require('./helpers')
  const HV = fs.readFileSync(path.join(__dirname, '..', 'helper', 'hv.ps1'), 'utf8')
  const block = name => { const s = HV.indexOf(`\n$${name} = {`); const e = s < 0 ? -1 : HV.indexOf('\n}\n', s + 1); return e < 0 ? null : HV.slice(s + 1, e + 3) }
  const sc = scratch('caps-ps')
  const dir = path.join(sc.dir, 'hvmcp')
  const out = path.join(sc.dir, 'out')
  fs.mkdirSync(out, { recursive: true })
  const q = s => s.replace(/'/g, "''")
  // A .ps1 of 2.5 MB of UTF-8 (a BOM, non-ASCII text, a long comment), sent in 1 MB pieces.
  const script = Buffer.from(`\uFEFFWrite-Output ('grüße'.Length)\n#${'é'.repeat(1_300_000)}\nWrite-Output 'end'\n`, 'utf8')
  const pieces = []
  for (let at = 0; at < script.length; at += 1024 * 1024) pieces.push(script.subarray(at, at + 1024 * 1024).toString('base64'))
  fs.writeFileSync(path.join(sc.dir, 'pieces.json'), JSON.stringify(pieces))
  fs.writeFileSync(path.join(out, 'f.bin'), Buffer.from('0123456789abcdef'))
  fs.writeFileSync(path.join(out, 'g.txt'), 'second')
  const read = block('GuestRead').replace("$root = 'C:\\out'",`$root = '${q(out)}'`)
  assert.ok(read.includes(q(out)), 'the read\'s root was pointed at scratch')
  const harness = path.join(sc.dir, 'h.ps1')
  fs.writeFileSync(harness, `$ErrorActionPreference = 'Stop'
${block('GuestRunStage')}
${block('RunFiles')}
${read}
$res = @{}
$pieces = [IO.File]::ReadAllText('${q(path.join(sc.dir, 'pieces.json'))}') | ConvertFrom-Json
$res.sizes = @(for ($i = 0; $i -lt $pieces.Count; $i++) { (& $GuestRunStage @{ n = 7; part = $i; data = [string]$pieces[$i]; dir = '${q(dir)}' }).bytes })
try { [void](& $RunFiles @{ n = 7; staged = ${script.length + 1}; shell = 'powershell'; cwd = '${q(sc.dir)}'; out = '${q(out)}' } '${q(dir)}'); $res.short = 'taken' } catch { $res.short = $_.Exception.Message }
$wrapper = & $RunFiles @{ n = 7; staged = ${script.length}; shell = 'powershell'; cwd = '${q(sc.dir)}'; out = '${q(out)}' } '${q(dir)}'
& cmd.exe /d /c "\`"$wrapper\`""
$res.stageLeft = Test-Path -LiteralPath '${q(path.join(dir, 'run-7.stage'))}'
$res.read = & $GuestRead @{ paths = @('f.bin', 'g.txt'); offset = 5; maxBytes = 12; maxTotalBytes = 100 }
$res.read2 = & $GuestRead @{ paths = @('f.bin', 'g.txt'); offset = 0; maxBytes = 100; maxTotalBytes = 4 }
$huge = '{"maxBytes":100000000000000000000}' | ConvertFrom-Json
try { [void](& $GuestRead @{ paths = @('f.bin'); offset = 0; maxBytes = $huge.maxBytes; maxTotalBytes = 1024 }); $res.huge = 'read' } catch { $res.huge = $_.Exception.Message }
$res.clamped = & $GuestRead @{ paths = @('f.bin'); offset = 0; maxBytes = ${Math.min(1e20, 1024)}; maxTotalBytes = 1024 }
'RESULT:' + (ConvertTo-Json -InputObject $res -Depth 6 -Compress)
`)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', env: ps51Env(), timeout: T.spawnMs, windowsHide: true })
  const m = /RESULT:(.*)/.exec(r.stdout || '')
  assert.ok(m, `no result: ${r.stdout}${r.stderr}`)
  const res = JSON.parse(m[1])
  assert.deepStrictEqual(res.sizes, [1024 * 1024, 2 * 1024 * 1024, script.length], 'each piece appended, its length so far answered')
  assert.match(res.short, /the run's command wasn't staged whole \(\d+ bytes expected\)/)
  assert.strictEqual(res.stageLeft, false, 'moved into place')
  assert.ok(fs.readFileSync(path.join(dir, 'run-7.ps1')).equals(script), 'the run file holds the bytes sent')
  assert.strictEqual(fs.readFileSync(path.join(out, '.run-7.exit'), 'utf8').trim(), '0', fs.existsSync(path.join(out, '.run-7.stderr.txt')) ? fs.readFileSync(path.join(out, '.run-7.stderr.txt'), 'utf8') : '')
  assert.match(fs.readFileSync(path.join(out, '.run-7.stdout.txt'), 'utf8'), /^5\r?\nend/, 'Windows PowerShell 5.1 ran it, reading its text as UTF-8 (5 characters, not 7)')
  const files = [].concat(res.read.files)
  assert.deepStrictEqual(files.map(f => [f.path, f.offset, f.cut, Buffer.from(f.data, 'base64').toString()]), [['f.bin', 5, true, '56789ab'], ['g.txt', 0, false, 'second']], 'the first from its offset, up to maxBytes from its start; the next from 0')
  assert.deepStrictEqual([].concat(res.read2.files).map(f => [f.path, f.cut, Buffer.from(f.data, 'base64').toString()]), [['f.bin', true, '0123']], 'the call\'s total stops it')
  // Round 2: why core.js clamps maxBytes to the call's total before sending it: past Int64, $GuestRead's [long] cast
  // fails; the clamped value (what the helper sends) reads as any other.
  assert.match(res.huge, /Int64/, 'a maxBytes past Int64, unclamped, fails in the guest')
  assert.deepStrictEqual([].concat(res.clamped.files).map(f => [f.path, f.cut, Buffer.from(f.data, 'base64').toString()]), [['f.bin', false, '0123456789abcdef']])
})
