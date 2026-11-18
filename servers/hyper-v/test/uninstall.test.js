// MC-1557: removing everything without agents or the repo.
// - the helper's recorded inventory (inventory.js): what it lists and its manual steps; the helper keeps inventory.txt
//   current (written at start, rewritten after a pool change, never torn);
// - the Installed apps entry's launcher, run for real under Windows PowerShell 5.1 as Windows runs an UninstallString,
//   at every state an interrupted uninstall can leave, and its refusals; the retire phase with a crash after R2 and R3a,
//   each finished by relaunching the entry; the protected temporary copy (appsentry-check.ps1);
// - setup copies the uninstaller and writes the entry; the uninstaller's -WhatIf and keep-uninstall\ rules are in
//   teardown-check.ps1 (units.test.js).
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const inventory = require('../helper/inventory')
const { scratch, withPool, approve, waitFor } = require('./helpers')
const windows = process.platform === 'win32'

const FACTS = {
  at: '2026-11-18T06:00:00.000Z', version: '2.1.0', stateDir: 'C:\\ProgramData\\hyperv-mcp', installDir: 'C:\\Program Files\\hyperv-mcp',
  diskFolders: ['D:\\hyperv-mcp'],
  vms: [
    { vmName: 'hvmcp-1a2b3c4d', vmId: 'aaaa-1', folder: 'D:\\hyperv-mcp\\pool\\i-1', os: 'windows', image: 'abababababab', checkpoints: ['clean', 'tools (pool)'] },
    { vmName: 'hvmcp-5e6f7a8b', vmId: 'bbbb-2', folder: "D:\\hyperv-mcp\\pool\\i-2 o'x", os: 'linux', image: 'dededededede', checkpoints: ['clean', "a (a lease's)"] }
  ],
  images: ['D:\\hyperv-mcp\\images\\ab.iso'],
  hostSwitch: { name: 'hvmcp-host' },
  legacySwitch: { name: 'hvmcp-internal', switchId: 'feed-1' }
}

test('the recorded inventory: labelled as the helper\'s record, every item with its manual step, out-of-scope named', () => {
  const t = inventory.render(FACTS)
  assert.match(t, /^hyper-v MCP: the helper's recorded inventory\r\nAs of 2026-11-18T06:00:00\.000Z \(helper 2\.1\.0\)\. The uninstaller verifies each item live before it deletes\r\nanything, and never runs this text\./)
  assert.match(t, /Installed apps > "Hyper-V MCP helper and test VMs" > Uninstall/)
  assert.match(t, /-File 'C:\\Program Files\\hyperv-mcp\\uninstall\\uninstall\.ps1'/)
  assert.match(t, /VMs \(2\):\r\n- hvmcp-1a2b3c4d \(id aaaa-1; windows, image abababababab\); folder D:\\hyperv-mcp\\pool\\i-1; checkpoints: clean, tools \(pool\)\r\n    to remove by hand: Stop-VM -Id aaaa-1 -TurnOff -Force; Remove-VM -Id aaaa-1 -Force; Remove-Item -LiteralPath 'D:\\hyperv-mcp\\pool\\i-1' -Recurse -Force/)
  assert.match(t, /Remove-Item -LiteralPath 'D:\\hyperv-mcp\\pool\\i-2 o''x'/, 'a quote in a path is doubled, as PowerShell reads it')
  assert.match(t, /setup's host-mode switch hvmcp-host, with this PC's address on it\r\n    to remove by hand: Remove-VMSwitch -Name 'hvmcp-host' -Force/)
  assert.match(t, /an older pool's switch hvmcp-internal \(id feed-1\)/)
  for (const s of ["sc.exe delete HyperVMcp", "Remove-LocalGroup -Name 'Hyper-V MCP Users'", "Remove-Item -LiteralPath 'HKLM:\\SOFTWARE\\hyperv-mcp' -Recurse", "Uninstall\\HyperVMcp'", "GuestCommunicationServices", "Remove-Item -LiteralPath 'C:\\ProgramData\\hyperv-mcp' -Recurse -Force", "Remove-Item -LiteralPath 'D:\\hyperv-mcp' -Recurse -Force"]) assert.ok(t.includes(s), s)
  assert.match(t, /Not part of the MCP, so not removed: .*Ollama.*\r\n.*'hyper-v MCP host mode: \*'/)
  const empty = inventory.render({ ...FACTS, vms: [], images: [], hostSwitch: null, legacySwitch: null })
  assert.match(empty, /VMs \(0\):\r\n- none\r\n\r\nCached images \(0\):\r\n- none\r\n\r\nNetworking:\r\n- none/)
})

test('the helper keeps inventory.txt current: at start, after a pool change, with its VMs and checkpoints; never torn', async t => {
  const sc = scratch('inventory')
  const { h, admin } = await withPool(sc, 1)
  t.after(() => h.stop())
  const file = path.join(sc.stateDir, 'inventory.txt')
  const vm = Object.values(sc.stub().vms)[0]
  let text = fs.readFileSync(file, 'utf8')
  assert.match(text, new RegExp(`VMs \\(1\\):\\r\\n- ${vm.name} \\(id ${vm.id}; windows, image abababababab\\); folder .*; checkpoints: clean`))
  assert.match(text, /setup's host-mode switch hvmcp-host/)
  assert.ok(!fs.existsSync(file + '.tmp'), 'written whole, then renamed')
  const plan = await admin.request('pool_plan', { action: 'resize', vms: 2, cores: 2, memoryGB: 4 })
  approve(sc, plan.data.planId)
  await admin.request('pool_resize', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: resize finished/.test((await admin.request('status')).text), 60_000, 'the resize')
  text = fs.readFileSync(file, 'utf8')
  assert.match(text, /VMs \(2\):/)
  const rm = await admin.request('pool_plan', { action: 'remove' })
  approve(sc, rm.data.planId)
  await admin.request('pool_remove', { planId: rm.data.planId })
  await waitFor(async () => /Last pool job: remove finished/.test((await admin.request('status')).text), 60_000, 'the remove')
  assert.match(fs.readFileSync(file, 'utf8'), /VMs \(0\):\r\n- none/)
})

test('setup installs the uninstaller (the retiring set) and writes the Installed apps entry; a rerun clears a kept-pool record', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup', 'install.ps1'), 'utf8')
  assert.match(src, /foreach \(\$f in \$script:RetiringSet\) \{ Copy-Item -LiteralPath \(Join-Path \$PSScriptRoot \$f\) -Destination \(Join-Path \$install "uninstall\\\$f"\) -Force \}/)
  assert.match(src, /Set-AppsEntry \(\[Microsoft\.Win32\.Registry\]::LocalMachine\) \$script:EntryKeyPath \(Get-LauncherCommand \(Get-LauncherText\)\)\.command/)
  assert.match(src, /DeleteValue\('KeptPool', \$false\)/)
  const apps = fs.readFileSync(path.join(__dirname, '..', 'setup', 'appsentry.ps1'), 'utf8')
  const set = /\$script:RetiringSet = @\(([^)]*)\)/.exec(apps)[1].split(',').map(s => s.trim().replace(/'/g, '')).sort()
  assert.deepStrictEqual(set, ['Storage.cs', 'acl.ps1', 'appsentry.ps1', 'teardown.ps1', 'uninstall.ps1'])
  for (const f of set) assert.ok(fs.existsSync(path.join(__dirname, '..', 'setup', f)), f)
  // The uninstaller dot-sources exactly the set (it runs from a copy of it).
  const un = fs.readFileSync(path.join(__dirname, '..', 'setup', 'uninstall.ps1'), 'utf8')
  const sourced = [...un.matchAll(/^\. \(Join-Path \$PSScriptRoot '([^']+)'\)/gm)].map(m => m[1]).sort()
  assert.deepStrictEqual(sourced, ['acl.ps1', 'appsentry.ps1', 'teardown.ps1'])
})

test('the Installed apps entry, run for real (5.1, non-elevated, scratch Program Files and HKCU): each interrupted state finished, refusals intact', { skip: !windows, timeout: 600_000 }, () => {
  const { spawnSync } = require('child_process')
  const { ps51Env } = require('../helper/hv')
  const sc = scratch('appsentry')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'appsentry-check.ps1'), '-Dir', sc.dir], { encoding: 'utf8', env: ps51Env(), timeout: 590_000, cwd: sc.dir })
  const line = (r.stdout || '').trim().split(/\r?\n/).pop()
  let a
  try { a = JSON.parse(line) } catch { assert.fail(`appsentry-check.ps1 failed: ${r.stdout}\n${r.stderr}`) }
  // The production launcher: parses, no test overrides, round-trips, and fits a CreateProcess command line.
  assert.deepStrictEqual([a.prodParses, a.prodNoOverrides, a.prodRoundTrip, a.prodCommand], [true, true, true, true])
  assert.ok(a.prodLength < 32767, `the UninstallString is ${a.prodLength} characters`)
  assert.deepStrictEqual({ ...a.entry, location: undefined }, { name: 'Hyper-V MCP helper and test VMs', publisher: 'Combwork MCP servers', version: '9.9.9', noModify: 1, noRepair: 1, location: undefined })
  // a and b: the installed (or retiring) uninstaller is what runs; nothing else changes.
  assert.deepStrictEqual(a.a, { launched: '-Interactive', entry: true, helper: true })
  assert.deepStrictEqual(a.b, { launched: '-Retire', entry: true, files: 5 })
  // c then d: every partial retiring set, an empty uninstall.retiring\ and an empty install folder: finished by the
  // launcher alone (no uninstaller run), the folder and the entry gone.
  assert.strictEqual(a.partial.length, 15)
  for (const p of a.partial) assert.deepStrictEqual({ ...p, left: undefined }, { left: undefined, launched: null, inst: false, entry: false, code: 0 }, `left: ${p.left}`)
  assert.deepStrictEqual(a.d, { entry: false, other: true, code: 0, said: true }, 'the InstallLocation\'s folder is never a target')
  // Refusals: nothing removed, the entry kept, a reason given.
  const R = a.refuse
  for (const [k, re] of Object.entries({
    extraFile: /uninstall\.retiring holds evil\.txt, which isn't one of the uninstaller's own files/,
    extraFolder: /hyperv-mcp holds stray, which the uninstaller doesn't leave behind/,
    junction: /uninstall\.retiring is a link\./,
    untrustedOwner: /\\pf has an unexpected owner/,
    service: /the service EventLog is still installed/,
    stateFolder: /the helper's state folder .* is still there/,
    record: /An uninstall is unfinished/
  })) {
    assert.strictEqual(R[k].code, 1, k); assert.strictEqual(R[k].entry, true, k); assert.strictEqual(R[k].intact, true, k); assert.match(R[k].out, re, k)
  }
  assert.strictEqual(R.otherEntry.entry, true); assert.match(R.otherEntry.out, /isn't the one setup writes: it was left in place/)
  // Round 1: nothing runs unless its folder, parents and files are trusted: a complete set behind a junction (either
  // folder), a folder or file others may write, an extra file in the set: no script run, nothing removed.
  for (const [k, re] of Object.entries({
    'junctionComplete_uninstall.retiring': /Nothing was run or removed: .*uninstall\.retiring is a link\./,
    junctionComplete_uninstall: /Nothing was run or removed: .*\\uninstall is a link\./,
    writableFolder: /Nothing was run or removed: .*uninstall\.retiring can be changed by S-1-5-32-545/,
    writableFile: /Nothing was run or removed: .*uninstall\\uninstall\.ps1 can be changed by S-1-5-32-545/,
    extraInSet: /Nothing was run or removed: .*uninstall holds extra\.ps1, which setup doesn't put there/,
    writablePartial: /Nothing was removed: .*acl\.ps1 can be changed by S-1-5-32-545/
  })) {
    assert.strictEqual(R[k].code, 1, k); assert.strictEqual(R[k].launched, null, `${k}: no script ran`); assert.strictEqual(R[k].entry, true, k); assert.strictEqual(R[k].intact, true, k); assert.match(R[k].out, re, k)
  }
  // Keep: the entry goes on a verified KeptPool record only; the state and key stay.
  assert.deepStrictEqual(a.kept.ok, { code: 0, entry: false, state: true, key: true, said: true })
  for (const k of ['noMarker', 'otherInstall']) assert.deepStrictEqual(a.kept[k], { code: 1, entry: true, state: true }, k)
  assert.deepStrictEqual(a.kept.record, { code: 1, entry: true })
  assert.deepStrictEqual(a.kept.service, { code: 1, entry: true })
  // The retire phase: interrupted after R2 and after R3a, the entry relaunches the retiring uninstaller, and the phase
  // run again finishes; uninterrupted, it finishes; a junction for uninstall\ is refused, nothing renamed.
  for (const at of ['after:R2', 'after:R3a']) {
    const x = a.retire[at]
    assert.strictEqual(x.first, `CRASH ${at}`)
    assert.deepStrictEqual([x.uninstall, x.retiring, x.entry, x.launched, x.second, x.instAfter, x.entryAfter], [false, 5, true, '-Retire', 'finished', false, false], at)
  }
  assert.strictEqual(a.retire['after:R2'].helper, true, 'R3a not yet run'); assert.strictEqual(a.retire['after:R3a'].helper, false)
  assert.deepStrictEqual([a.retire.none.first, a.retire.none.instAfter, a.retire.none.entryAfter], ['finished', false, false])
  assert.match(a.retire.junction.result, /uninstall is a link: it won't be used/); assert.strictEqual(a.retire.junction.target, true); assert.strictEqual(a.retire.junction.entry, true)
  // The uninstaller's top level (Invoke-UninstallFlow) with a fake world.
  const F = a.flow
  const done = { switch: false, install: false, entry: false }
  assert.deepStrictEqual(F.remove, { result: 0, calls: 'teardown:remove,switch,check:remove,retire', ...done, kept: false })
  assert.deepStrictEqual(F.keep, { result: 0, calls: 'teardown:keep,switch,check:keep,kept,retire', ...done, kept: true }, 'the mark after the check, before the retire')
  assert.deepStrictEqual(F.menuRemove, { result: 0, calls: 'inventory,choices,ask,teardown:remove,switch,check:remove,retire', ...done, kept: false })
  assert.deepStrictEqual([F.menuCancel.result, F.menuCancel.calls, F.menuCancel.install], [1, 'inventory,choices,ask', true])
  assert.deepStrictEqual([F.menuList.result, F.menuList.calls], [0, 'inventory,choices,ask,teardown:remove:whatif'])
  // Round 1: interrupted after the teardown (the service, state and records gone), before or after the switch, or
  // before the retire: the rerun from the entry removes the switch if it's there, checks, and only then retires.
  for (const [at, calls] of Object.entries({ 'after:teardown': 'switch,check:remove,retire', 'before:switch': 'switch,check:remove,retire', 'after:switch': 'check:remove,retire', 'before:retire': 'check:remove,retire' })) {
    const x = F[`resume_${at}`]
    assert.strictEqual(x.first, `CRASH ${at}`)
    assert.deepStrictEqual(x.second, { result: 0, calls, ...done, kept: false }, at)
  }
  assert.deepStrictEqual([F.leftover.result, F.leftover.calls, F.leftover.install, F.leftover.entry], [1, 'teardown:remove,switch,check:remove', true, true], 'a leftover keeps the recovery route')
  // Round 1: -WhatIf changes nothing on any path, -Retire included (every mutating action throws in these runs).
  for (const [k, calls] of Object.entries({ whatIf: 'inventory,choices,teardown:remove:whatif', whatIfRemove: 'inventory,teardown:remove:whatif', retireWhatIf: '', leftoverOnlyWhatIf: '' })) {
    assert.deepStrictEqual(F[k], { result: 0, calls, switch: true, install: true, entry: true, kept: false }, k)
  }
  assert.deepStrictEqual(F.retireKeep, { result: 0, calls: 'check:keep,retire', ...done, kept: true })
  assert.match(F.keptThenRemove.result, /kept the pool and removed the helper.*Nothing was changed/); assert.strictEqual(F.keptThenRemove.calls, '')
  assert.deepStrictEqual([F.nothing.result, F.nothing.calls], [0, ''])
  // The protected temporary copy.
  assert.deepStrictEqual(a.copy, { files: ['acl.ps1', 'appsentry.ps1', 'Storage.cs', 'teardown.ps1', 'uninstall.ps1'], problems: [], protected: true })
})
