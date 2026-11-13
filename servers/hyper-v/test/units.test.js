// The helper's pieces on their own: the bounded UDF/WIM reader against real UDF images (made with the in-box IMAPI2
// through hv.ps1's make-iso) and malformed ones; the image checks (pinned, downloaded, local and unpinned, signatures,
// edition); the policy; the journal (a torn last line); canonical plan text; the answer file's escaping.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { scratch } = require('./helpers')
const iso = require('../helper/iso')
const images = require('../helper/images')
const policy = require('../helper/policy')
const { Journal } = require('../helper/journal')
const { ps51Env } = require('../helper/hv')
const { canonical, baselineProblem, expiry } = require('../helper/core')
const { autounattend } = require('../helper/unattend')
const { hv } = require('../helper/hv')

const windows = process.platform === 'win32'

/** A minimal WIM: the header, then its XML metadata (UTF-16LE), as Windows install images have. */
function wim(images) {
  const xml = Buffer.from('\ufeff<WIM>' + images.map((i, n) => `<IMAGE INDEX="${n + 1}"><WINDOWS><ARCH>${i.arch ?? 9}</ARCH><EDITIONID>${i.edition}</EDITIONID><VERSION><BUILD>${i.build}</BUILD><SPBUILD>${i.sp}</SPBUILD></VERSION></WINDOWS><NAME>${i.edition}</NAME></IMAGE>`).join('') + '</WIM>', 'utf16le')
  const h = Buffer.alloc(208)
  h.write('MSWIM\0\0\0', 0, 'latin1')
  h.writeBigUInt64LE(BigInt(xml.length), 72)
  h.writeBigUInt64LE(208n, 80)
  return Buffer.concat([h, xml])
}

/** A UDF ISO from a folder, made with the real hv.ps1 (IMAPI2, no admin). Cached per content. */
async function udf(sc, name, files) {
  const src = path.join(sc.dir, `${name}-src`)
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true })
    fs.writeFileSync(path.join(src, rel), data)
  }
  const out = path.join(sc.dir, `${name}.iso`)
  const env = process.env.HYPERV_MCP_PS_STUB
  delete process.env.HYPERV_MCP_PS_STUB
  try { await hv('make-iso', { source: src, out, label: 'TEST', fileSystems: 'udf' }) } finally { if (env) process.env.HYPERV_MCP_PS_STUB = env }
  return out
}

const signed = () => fs.readFileSync(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'notepad.exe'))
const goodFiles = () => ({ 'setup.exe': signed(), 'sources/setup.exe': signed(), 'sources/install.wim': wim([{ edition: 'EnterpriseEval', build: 26200, sp: 6584 }]) })

test('iso: reads names, nested files and WIM metadata from a real UDF image', { skip: !windows }, async () => {
  const sc = scratch('iso-read')
  const f = await udf(sc, 'good', { ...goodFiles(), 'deep/a/b/c.txt': 'nested' })
  const u = new iso.Udf(f).open()
  try {
    assert.deepStrictEqual(u.list(u.root).map(e => e.name).sort(), ['deep', 'setup.exe', 'sources'])
    const e = u.find('DEEP/a/B/c.txt')
    assert.strictEqual(u.readFile(e, 0, e.length).toString(), 'nested')
    assert.strictEqual(u.find('sources/missing.exe'), null)
  } finally { u.close() }
  const r = iso.inspect(f, path.join(sc.dir, 'check'))
  assert.deepStrictEqual(r.images.map(i => [i.editionId, i.build, i.spBuild, i.arch]), [['EnterpriseEval', 26200, 6584, 9]])
  assert.ok(fs.readFileSync(r.files[0]).equals(signed()))
})

test('iso: malformed images are refused with a reason, never followed', { skip: !windows }, async () => {
  const sc = scratch('iso-bad')
  const good = fs.readFileSync(await udf(sc, 'good', goodFiles()))
  const variants = {
    'too small': good.subarray(0, 100 * 2048),
    'no anchor': (() => { const b = Buffer.from(good); b.fill(0, 256 * 2048, 257 * 2048); return b })(),
    'bad checksum': (() => { const b = Buffer.from(good); b[256 * 2048 + 4] ^= 0xff; return b })(),
    'truncated': good.subarray(0, Math.floor(good.length / 2)),
    'random tail': (() => { const b = Buffer.from(good); crypto.randomFillSync(b, 257 * 2048); return b })()
  }
  for (const [what, bytes] of Object.entries(variants)) {
    const f = path.join(sc.dir, `${what.replace(/ /g, '-')}.iso`)
    fs.writeFileSync(f, bytes)
    assert.throws(() => iso.inspect(f, path.join(sc.dir, 'x')), iso.IsoError, what)
  }
  // Every byte flipped in the descriptors, one at a time: always a clean IsoError (or a still-valid read), never a hang or a crash.
  for (let i = 256 * 2048; i < 256 * 2048 + 64; i++) {
    const b = Buffer.from(good); b[i] ^= 0x5a
    const f = path.join(sc.dir, 'flip.iso'); fs.writeFileSync(f, b)
    try { iso.inspect(f, path.join(sc.dir, 'x')) } catch (e) { assert.ok(e instanceof iso.IsoError, `byte ${i}: ${e.message}`) }
  }
  const noWim = await udf(sc, 'nowim', { 'setup.exe': signed(), 'sources/setup.exe': signed() })
  assert.throws(() => iso.inspect(noWim, path.join(sc.dir, 'x')), /install\.wim \(or \.esd\) is missing/)
  const badWim = await udf(sc, 'badwim', { ...goodFiles(), 'sources/install.wim': Buffer.from('not a wim at all') })
  assert.throws(() => iso.inspect(badWim, path.join(sc.dir, 'x')), /not a WIM/)
})

test('wim: XML out of range or missing is refused', () => {
  const w = wim([{ edition: 'EnterpriseEval', build: 1, sp: 2 }])
  w.writeBigUInt64LE(BigInt(w.length), 72)
  assert.throws(() => iso.wimImages((o, l) => w.subarray(o, o + l), w.length), /out of range/)
  const empty = wim([])
  assert.throws(() => iso.wimImages((o, l) => empty.subarray(o, o + l), empty.length), /lists no images/)
})

test('images: an unpinned local ISO is refused unless the policy allows it, and then marked not authenticated', { skip: !windows }, async () => {
  const sc = scratch('images-local')
  process.env.HYPERV_MCP_MIN_ISO_BYTES = '1'
  const f = await udf(sc, 'local', goodFiles())
  const sig = async (op, a) => ({ files: a.files.map(file => ({ file, ok: true })) })
  await assert.rejects(images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'images'), hv: sig, policy: { allowUnpinnedIso: false } }), /not a known Microsoft image, and the policy doesn't allow unpinned local images/)
  assert.deepStrictEqual(fs.readdirSync(path.join(sc.disks, 'images')).filter(n => n.endsWith('.iso')), [], 'the refused copy is deleted')
  const img = await images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'images'), hv: sig, policy: { allowUnpinnedIso: true } })
  assert.strictEqual(img.pinned, false)
  assert.strictEqual(img.source, 'local')
  assert.strictEqual(img.build, '26200.6584')
  assert.strictEqual(img.sha256, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'))
  assert.ok(fs.existsSync(img.file) && path.dirname(img.file) === path.join(sc.disks, 'images'), 'its own copy')
  const again = await images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'images'), hv: sig, policy: { allowUnpinnedIso: true }, known: new Map([[img.sha256, img]]) })
  assert.strictEqual(again.existing, true)
})

test('images: bad signatures, the wrong edition, and the helper\'s own folders are refused', { skip: !windows }, async () => {
  const sc = scratch('images-bad')
  process.env.HYPERV_MCP_MIN_ISO_BYTES = '1'
  const pol = { allowUnpinnedIso: true }
  const ok = async (op, a) => ({ files: a.files.map(file => ({ file, ok: true })) })
  const bad = async (op, a) => ({ files: a.files.map(file => ({ file, ok: false, why: 'signature NotSigned' })) })
  const f = await udf(sc, 'img', goodFiles())
  await assert.rejects(images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'i1'), hv: bad, policy: pol }), /not validly signed by Microsoft: .*NotSigned/)
  const pro = await udf(sc, 'pro', { ...goodFiles(), 'sources/install.wim': wim([{ edition: 'Professional', build: 26200, sp: 1 }]) })
  await assert.rejects(images.prepare({ want: { iso: pro }, dir: path.join(sc.disks, 'i2'), hv: ok, policy: pol }), /should hold one x64 EnterpriseEval image; it holds Professional/)
  const arm = await udf(sc, 'arm', { ...goodFiles(), 'sources/install.wim': wim([{ edition: 'EnterpriseEval', build: 26200, sp: 1, arch: 12 }]) })
  await assert.rejects(images.prepare({ want: { iso: arm }, dir: path.join(sc.disks, 'i3'), hv: ok, policy: pol }), /arch 12/)
  await assert.rejects(images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'i4'), hv: ok, policy: pol, ownDirs: [sc.dir] }), /helper's own folders/)
  await assert.rejects(images.prepare({ want: { iso: 'relative.iso' }, dir: path.join(sc.disks, 'i5'), hv: ok, policy: pol }), /absolute local path/)
  await assert.rejects(images.prepare({ want: { iso: f, download: 'https://x.microsoft.com/a.iso' }, dir: path.join(sc.disks, 'i6'), hv: ok, policy: pol }), /must be \{ iso/)
})

test('images: downloads only over https from microsoft.com hosts', async () => {
  for (const u of ['https://software-static.download.prss.microsoft.com/dbazure/x.iso', 'https://go.microsoft.com/fwlink/?linkid=1']) assert.ok(images.allowedUrl(u), u)
  for (const u of ['http://software-static.download.prss.microsoft.com/x.iso', 'https://microsoft.com.evil.example/x.iso', 'https://evilmicrosoft.com/x.iso', 'https://user:pw@download.microsoft.com/x', 'https://download.microsoft.com:8443/x', 'file:///C:/x.iso', 'not a url']) assert.ok(!images.allowedUrl(u), u)
  const sc = scratch('images-download')
  await assert.rejects(images.prepare({ want: { download: 'https://example.com/win.iso' }, dir: path.join(sc.disks, 'images'), hv: async () => ({}), policy: {} }), /only https on a microsoft\.com host/)
})

test('images: the pinned 25H2 image', () => {
  const pin = images.PINNED.A61ADEAB895EF5A4DB436E0A7011C92A2FF17BB0357F58B13BBC4062E535E7B9
  assert.deepStrictEqual([pin.size, pin.edition, pin.build], [7_092_807_680, 'EnterpriseEval', '26200.6584'])
  assert.strictEqual(images.guestReportProblem({ editionId: 'EnterpriseEval', build: '26200' }, { edition: 'EnterpriseEval', build: '26200.6584' }), null)
  assert.match(images.guestReportProblem({ editionId: 'Professional', build: '26200' }, { edition: 'EnterpriseEval', build: '26200.6584' }), /edition/)
})

test('policy: problems named; disk folders strictly inside; caps', () => {
  const p = { ...policy.DEFAULTS, diskFolders: ['D:\\hyperv-mcp'] }
  assert.deepStrictEqual(policy.problems(p), [])
  assert.match(policy.problems({ ...p, diskFolders: ['D:\\'] }).join(), /not a drive root/)
  assert.match(policy.problems({ ...p, diskFolders: ['\\\\server\\share\\x'] }).join(), /absolute local folder/)
  assert.match(policy.problems({ ...p, prefix: 'Bad-Prefix' }).join(), /prefix/)
  assert.match(policy.problems({ ...p, maxDiskGBPerVm: 32 }).join(), /needs 64 GB/)
  // Build roots an admin named: optional (a policy from before them stays usable), absolute local folders only.
  const { buildRoots: _, ...old } = p
  assert.deepStrictEqual(policy.problems(old), [])
  assert.deepStrictEqual(policy.problems({ ...p, buildRoots: ['C:\\Users\\u\\AppData\\Local\\combwork-cli\\'] }), [])
  for (const b of ['C:\\', '\\\\server\\share\\x', '\\\\?\\C:\\x', 'relative\\x', 'C:\\a\\..\\b', 42]) assert.match(policy.problems({ ...p, buildRoots: [b] }).join(), /build root .* must be an absolute local folder/, String(b))
  assert.match(policy.problems({ ...p, buildRoots: 'C:\\x' }).join(), /buildRoots must be a list/)
  assert.match(policy.problems({ ...p, buildRoots: Array(17).fill('C:\\x') }).join(), /at most 16/)
  for (const f of ['D:\\hyperv-mcp\\pool\\i-1', 'd:\\HYPERV-MCP\\x']) assert.ok(policy.underDiskFolder(p, f), f)
  for (const f of ['D:\\hyperv-mcp', 'D:\\hyperv-mcp-evil\\x', 'D:\\hyperv-mcp\\..\\x', 'C:\\x', 'relative\\x', 42]) assert.ok(!policy.underDiskFolder(p, f), String(f))
  const vm = { cores: 2, memoryMB: 4096, diskGB: 64, folder: 'D:\\hyperv-mcp\\pool\\i-1' }
  assert.deepStrictEqual(policy.checkPool(p, [vm, vm]), [])
  assert.match(policy.checkPool(p, Array(5).fill(vm)).join(), /5 VMs is more than the policy's 4/)
  assert.match(policy.checkPool(p, [{ ...vm, memoryMB: 4097 }]).join(), /even number/)
  assert.match(policy.checkPool({ ...p, allowNetwork: false }, [vm], { network: true }).join(), /does not allow networking/)
})

test('journal: flushed records replay; a torn last line (a crash mid-write) is cut off; damage in the middle is an error', () => {
  const sc = scratch('journal')
  const dir = path.join(sc.dir, 'j')
  const j = new Journal(dir).open()
  j.append({ t: 'intent', jobId: 'j1', intentId: 'i-1', vmName: 'hvmcp-1', folder: 'D:\\x\\pool\\i-1', cores: 1, memoryMB: 2048, diskGB: 64 })
  j.append({ t: 'created', intentId: 'i-1', vmId: 'v1' })
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"t":"ready","intentId":"i-1","vmId":"v1","cleanCh')
  const j2 = new Journal(dir).open()
  assert.strictEqual(j2.epoch, j.epoch)
  const s = j2.state()
  assert.strictEqual(s.vms.get('v1').ready, false)
  assert.strictEqual(s.intents.get('i-1').done, false)
  assert.ok(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').endsWith('}\n'), 'the torn tail was cut off')
  fs.appendFileSync(path.join(dir, 'journal.jsonl'), '{"t":"ready","vmI\n{"t":"removed","vmId":"v1"}\n') // damage in the middle
  assert.throws(() => new Journal(dir).open(), /record 4 is unreadable/)
  const other = path.join(sc.dir, 'k')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, 'journal.jsonl'), '{"t":"intent"}\n')
  assert.throws(() => new Journal(other).open(), /no epoch record/)
})

test('journal: after a torn write, reopen → append → reopen keeps every record (a consumed nonce too)', () => {
  const sc = scratch('journal-torn')
  const dir = path.join(sc.dir, 'j')
  const file = path.join(dir, 'journal.jsonl')
  const j = new Journal(dir).open()
  j.append({ t: 'job', jobId: 'j1', op: 'create', planId: 'p-1', nonce: 'a'.repeat(32) })
  fs.appendFileSync(file, '{"t":"intent","jobId":"j1","intentId":"i-1","vmN') // the crash: half a record
  const j2 = new Journal(dir).open()
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'), 'the torn tail is cut off on open')
  j2.append({ t: 'jobEnd', jobId: 'j1', ok: false, note: 'interrupted' })
  j2.append({ t: 'job', jobId: 'j2', op: 'remove', planId: 'p-2', nonce: 'b'.repeat(32) })
  const j3 = new Journal(dir).open()
  const s = j3.state()
  assert.strictEqual(s.jobs.get('j1').ended, true, 'the jobEnd written after the torn line survives')
  assert.ok(s.usedNonces.has('a'.repeat(32)) && s.usedNonces.has('b'.repeat(32)), 'both consumed nonces survive')
  assert.strictEqual(j3.records.length, 4)
  // A complete last record whose newline was never written gets it, and is kept.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '{"t":"jobEnd","jobId":"j2","ok":true,"note":"x","seq":99}')
  const j4 = new Journal(dir).open()
  assert.strictEqual(j4.state().jobs.get('j2').ended, true)
  j4.append({ t: 'quarantine', vmId: 'v', why: 'test' })
  assert.strictEqual(new Journal(dir).open().state().quarantined.get('v'), 'test')
})

test('canonical plan text and the baseline check', () => {
  assert.strictEqual(canonical({ b: 1, a: [{ d: null, c: 'x' }], u: undefined }), '{"a":[{"c":"x","d":null}],"b":1}')
  const vm = { vmId: 'v', cleanCheckpointId: 'c' }
  const f = { vmId: 'v', state: 'Off', checkpointIds: ['c'], parentCheckpointId: 'c', switchName: null, reserve: 0 }
  assert.strictEqual(baselineProblem(f, vm), null)
  assert.match(baselineProblem({ ...f, vmId: 'w' }, vm), /different VM/)
  assert.match(baselineProblem({ ...f, parentCheckpointId: 'd' }, vm), /not at its clean checkpoint/)
  assert.match(baselineProblem({ ...f, checkpointIds: ['d'] }, vm), /missing/)
})

test('answer file: values escaped, names checked', () => {
  const creds = { admin: { user: 'hvadmin', password: 'a<b>&"\'c' }, user: { user: 'hvuser', password: 'p' } }
  const x = autounattend({ computerName: 'HVMCP-1234', creds })
  assert.match(x, /<Value>a&lt;b&gt;&amp;&quot;&apos;c<\/Value>/)
  assert.ok(!x.includes('a<b>'))
  assert.match(x, /<Key>\/IMAGE\/INDEX<\/Key><Value>1<\/Value>/)
  assert.throws(() => autounattend({ computerName: 'bad name<', creds }), /computer name/)
  assert.throws(() => autounattend({ computerName: 'OK', creds: { ...creds, user: { user: 'x y', password: 'p' } } }), /user account/)
})

test('the 90-day evaluation: a warning from 14 days before, counted from the clean checkpoint', () => {
  const day = 24 * 60 * 60 * 1000
  const t0 = Date.parse('2026-11-13T00:00:00Z')
  const vm = { readyAt: new Date(t0).toISOString() }
  assert.strictEqual(expiry(vm, t0 + 75 * day), '')
  assert.match(expiry(vm, t0 + 80 * day), /expires in about 10 day\(s\)/)
  assert.match(expiry(vm, t0 + 91 * day), /has expired/)
  assert.strictEqual(expiry({}, t0), '')
})

test('setup storage and ACLs (non-elevated): grants removed; VM grants kept; links refused; secure creation, receipts, parents, pins', { skip: !windows }, () => {
  const { spawnSync } = require('child_process')
  const sc = scratch('acl')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'acl-check.ps1'), '-Dir', sc.dir], { encoding: 'utf8', env: ps51Env() })
  const line = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULT:'))
  assert.ok(line, `acl-check.ps1 failed: ${r.stdout}\n${r.stderr}`)
  const a = JSON.parse(line.slice(7))
  assert.strictEqual(a.usersBefore, true, 'the grants were there before')
  assert.deepStrictEqual(a.usersAfter ?? [], [], 'Users\' grants are gone from the folder and everything in it')
  assert.deepStrictEqual(a.problems ?? [], [])
  assert.strictEqual(a.protected, true)
  assert.strictEqual(a.detected, true, 'a grant added afterwards is reported')
  assert.strictEqual(a.vhdBefore, true, 'the VM\'s and Users\' grants were there before')
  assert.strictEqual(a.vmKept, true, 'a VM\'s own grant on its disk stays')
  assert.strictEqual(a.usersOnVhd, false)
  assert.deepStrictEqual(a.vmProblems ?? [], [])
  assert.match(a.innerLink, /holds links or junctions/)
  assert.strictEqual(a.innerUnchanged, true, 'refused before changing anything')
  assert.match(a.ancestorLink, /is a link or junction/)
  assert.strictEqual(a.ancestorUnchanged, true)
  // Trusted storage (s52), through setup's own routines.
  assert.strictEqual(a.ancestorsOk, true, 'the temp folder\'s real parents pass the parent check')
  assert.strictEqual(a.created, 'created')
  assert.strictEqual(a.createdProtected, true, 'created with its final, protected security')
  assert.strictEqual(a.createdUsers, false)
  assert.strictEqual(a.receipt, true, 'its receipt was written')
  assert.strictEqual(a.again, 'trusted', 'the next run trusts it by its receipt')
  assert.strictEqual(a.againUnchanged, true, 'and changes nothing on it')
  assert.strictEqual(a.hyperVGrants, 'trusted', 'a disk folder with what Hyper-V grants (VM group, a VM, its capability SID) is trusted')
  assert.match(a.hyperVPlusUsers, /contents aren't as setup and the helper leave them.*S-1-5-32-545|BUILTIN.Users/, 'but a Users grant is still refused')
  assert.match(a.race, /exists, but setup has no receipt for it.*Nothing was changed/, 'created by someone else between the check and the create: refused')
  assert.strictEqual(a.raceForgedUntouched, true, 'the forged journal is left as it was')
  assert.strictEqual(a.raceNoReceipt, true, 'no receipt is minted for a folder setup didn\'t create')
  assert.match(a.legacy, /no receipt/, 'an exclusive folder without a receipt (an older setup\'s) is refused')
  assert.strictEqual(a.rawCreate, true)
  assert.strictEqual(a.rawCreateAgain, false, 'CreateSecure never reuses an existing folder')
  assert.match(a.interrupted, /no receipt/, 'a creation interrupted before its receipt fails closed')
  assert.match(a.swap, /identity differs from the receipt/, 'a folder deleted and made again doesn\'t match its receipt')
  assert.strictEqual(a.fileText, '{"schema":1}')
  assert.strictEqual(a.fileUsers, false, 'the written file has its own ACL, not the old file\'s')
  assert.strictEqual(a.fileProtected, true)
  assert.strictEqual(a.fileTemps, 0)
  assert.match(a.weakParent, /S-1-5-32-545 holds rights 0x40 there/, 'a parent granting Users DeleteChild is refused')
  assert.match(a.junctionParent, /is a link or junction/)
  assert.strictEqual(a.pinnedRename, 'MethodInvocationException', 'a pinned parent can\'t be renamed while setup runs')
  assert.strictEqual(a.unpinnedRename, 'moved', 'and can once released')
  assert.match(a.weakKey, /isn't protected \(S-1-5-32-545 can write it\)/, 'a receipts key that Users can write is refused')
})

test('approve.ps1 runs only from the installed, admin-only folder', { skip: !windows }, () => {
  const { spawnSync } = require('child_process')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'helper', 'approve.ps1'), '-Plan', 'p-0123456789abcdef'], { encoding: 'utf8' })
  assert.notStrictEqual(r.status, 0)
  assert.match(r.stderr + r.stdout, /Run approve\.ps1 from .*hyperv-mcp, not from/)
})

test('ps51Env drops only PowerShell 7\'s module folders from PSModulePath', () => {
  const env = ps51Env({
    PSMODULEPATH: [
      'C:\\Users\\u\\Documents\\PowerShell\\Modules', 'C:\\Program Files\\PowerShell\\Modules\\',
      'c:\\program files\\powershell\\7\\Modules', 'C:\\Program Files\\PowerShell\\7-preview\\Modules', '',
      'C:\\Users\\u\\Documents\\WindowsPowerShell\\Modules', 'C:\\Program Files\\WindowsPowerShell\\Modules',
      'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules', 'D:\\tools\\Modules'
    ].join(';'),
    Path: 'C:\\Program Files\\PowerShell\\7'
  })
  assert.strictEqual(env.PSMODULEPATH, 'C:\\Users\\u\\Documents\\WindowsPowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules;D:\\tools\\Modules')
  assert.strictEqual(env.Path, 'C:\\Program Files\\PowerShell\\7', 'other variables are kept as they were')
})

// The line a user types for setup, uninstall or an approval may be typed in a PowerShell 7 window: each script drops
// PS7's module folders itself, with the same rule as ps51Env.
const PS7_DIR = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'Modules')
test('setup, uninstall and approve.ps1 load 5.1\'s own modules when started from PowerShell 7', { skip: !windows || !fs.existsSync(PS7_DIR) }, () => {
  const { spawnSync } = require('child_process')
  const lines = ['setup/install.ps1', 'setup/uninstall.ps1', 'helper/approve.ps1'].map(f => {
    const m = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').match(/^\$env:PSModulePath = .*$/m)
    assert.ok(m, `${f} drops PowerShell 7's module folders`)
    return m[0]
  })
  assert.strictEqual(new Set(lines).size, 1, 'the same line in each')
  // As a PowerShell 7 window hands it down: PS7's own folders first.
  const base = Object.entries(ps51Env())
  const own = base.find(([k]) => k.toLowerCase() === 'psmodulepath')?.[1] || ''
  const env = { ...Object.fromEntries(base.filter(([k]) => k.toLowerCase() !== 'psmodulepath')), PSModulePath: `${PS7_DIR};${own}` }
  const run = script => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env })
  const probe = '(Get-Acl -LiteralPath $env:SystemRoot).Owner'
  const without = run(probe)
  assert.notStrictEqual(without.status, 0, 'without the line, 5.1 can\'t load Get-Acl here (else this test proves nothing)')
  const fixed = run(`$ErrorActionPreference = 'Stop'; ${lines[0]}; ${probe}`)
  assert.strictEqual(fixed.status, 0, fixed.stderr)
  assert.match(fixed.stdout, /\S/)
})

test('uninstall teardown (non-elevated, fakes): verified targets only; resumable after a crash at every boundary', { skip: !windows, timeout: 600_000 }, () => {
  const { spawnSync } = require('child_process')
  const sc = scratch('teardown')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'teardown-check.ps1'), '-Dir', sc.dir], { encoding: 'utf8', env: ps51Env(), timeout: 590_000 })
  const line = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULT:'))
  assert.ok(line, `teardown-check.ps1 failed: ${r.stdout}\n${r.stderr}`)
  const a = JSON.parse(line.slice(7))
  assert.strictEqual(a.full, 'ok')
  assert.strictEqual(a.fullGone, true, 'storage, components, receipts, InstallId and the record all gone')
  assert.strictEqual(a.fullOrder, 'quiesce:remove-pool,remove-pool,stop,delete-service,rights,group', 'pool, then stop, then (after storage) the components')
  assert.strictEqual(Object.keys(a.crashes).length, 25)
  for (const [b, c] of Object.entries(a.crashes)) {
    assert.deepStrictEqual(c, { first: true, second: 'ok', gone: true, strict: '' }, `a crash at ${b}, then a rerun`)
  }
  // Fail closed: a forged policy.json (with or without a journal) and no receipts: nothing deleted, no key made.
  assert.match(a.forgedNoJournal, /no storage receipts.*Nothing was changed/)
  assert.match(a.forgedJournal, /no storage receipts.*Nothing was changed/)
  assert.strictEqual(a.victimSurvives, true)
  assert.strictEqual(a.forgedNoKey, true)
  assert.match(a.mismatch, /identity differs from its receipt.*Nothing was changed/)
  assert.strictEqual(a.mismatchUnchanged, true)
  assert.match(a.reparseTarget, /is a link or junction: refusing to delete through it/)
  assert.strictEqual(a.reparseKept, true)
  assert.match(a.innerJunction, /isn't as setup and the helper leave it/, 'a link inside a target refuses it at verification')
  assert.strictEqual(a.innerJunctionUnchanged, true)
  assert.strictEqual(a.lateJunction, 'ok', 'a link slipped in after verification is removed as a link')
  assert.strictEqual(a.lateJunctionKept, true, 'and never followed')
  assert.strictEqual(a.lateJunctionGone, true)
  assert.match(a.leftover, /pool still holds 1 item/)
  assert.strictEqual(a.leftoverUnchanged, true, 'refused at phase 1, nothing changed')
  // Each failure stops at its phase, and a rerun completes.
  assert.match(a.cancelled, /not approved/); assert.strictEqual(a.cancelledPhase, 'verified'); assert.strictEqual(a.cancelledRerun, 'ok'); assert.strictEqual(a.cancelledGone, true)
  assert.match(a.vmLeft, /still lists 1 VM/); assert.strictEqual(a.vmLeftPhase, 'verified'); assert.strictEqual(a.vmLeftRerun, 'ok'); assert.strictEqual(a.vmLeftGone, true)
  assert.match(a.scFail, /sc\.exe delete failed/); assert.strictEqual(a.scFailPhase, 'storage-removed'); assert.strictEqual(a.scFailServiceStopped, true); assert.strictEqual(a.scFailRerun, 'ok'); assert.strictEqual(a.scFailGone, true)
  // KeepPool → reinstall → RemovePool; mismatched resume; install refused during a teardown.
  assert.strictEqual(a.keep, 'ok'); assert.strictEqual(a.keepStorageKept, true, 'storage kept, record retired'); assert.strictEqual(a.keepReceiptsKept, 3)
  assert.strictEqual(a.keepThenRemove, 'ok'); assert.strictEqual(a.keepThenRemoveGone, true)
  assert.match(a.keepCrash, /CRASH:after:phase:stopped/)
  assert.match(a.mismatchMode, /other options \(mode keep\).*Nothing was changed/)
  assert.match(a.mismatchLegacy, /other options \(mode keep\)/)
  assert.match(a.installDuring, /An uninstall is unfinished/)
  assert.strictEqual(a.keepFinish, 'ok'); assert.strictEqual(a.installAfter, 'allowed')
  // Legacy: refused unless admin-owned; nothing written unless confirmed; confirmed, removed.
  assert.match(a.legacyNotAdmin, /is owned by S-1-5-21-.*Nothing was changed/); assert.strictEqual(a.legacyNotAdminNoKey, true)
  assert.match(a.legacyDeclined, /not confirmed: nothing was changed/); assert.strictEqual(a.legacyDeclinedUnchanged, true)
  assert.strictEqual(a.legacyConfirmed, 'ok'); assert.match(a.legacyInventory, /^DELETE .*: \d+ file\(s\)/); assert.strictEqual(a.legacyGone, true)
  // The service started again after 'stopped' (reboot, Start-Service): stopped again before the first deletion; and after
  // 'storage-removed': stopped before it is deleted.
  assert.match(a.restartCrash, /CRASH:after:phase:stopped/); assert.strictEqual(a.restartRerun, 'ok')
  assert.strictEqual(a.restartOrder, 'stop,deleting,delete-service,rights,group'); assert.strictEqual(a.restartGone, true)
  assert.match(a.restart2Crash, /CRASH:after:phase:storage-removed/); assert.strictEqual(a.restart2Rerun, 'ok')
  assert.strictEqual(a.restart2Order, 'stop,delete-service,rights,group'); assert.strictEqual(a.restart2Gone, true)
  // Keep mode verifies the storage too: refusals with no side effect at all.
  assert.match(a.keepLegacyNotAdmin, /is owned by S-1-5-21-/); assert.strictEqual(a.keepLegacyNotAdminQuiet, true)
  assert.match(a.keepJunction, /isn't as setup and the helper leave it/); assert.strictEqual(a.keepJunctionQuiet, true)
  assert.match(a.keepMismatch, /identity differs from its receipt/); assert.strictEqual(a.keepMismatchQuiet, true)
  // A resumed run re-verifies before acting (quiesce writes into the state folder).
  assert.match(a.resumeCrash, /CRASH:after:record/)
  assert.match(a.resumeTampered, /isn't as setup and the helper leave it/); assert.strictEqual(a.resumeTamperedQuiet, true)
  // Hyper-V's grantee pattern is for disk folders only.
  assert.match(a.capabilityInState, /isn't as setup and the helper leave it/); assert.strictEqual(a.capabilityInStateQuiet, true)
})

// install.ps1's -BuildRoot checks, run as setup runs them (the block itself, cut from the script, not elevated): they
// refuse what the helper's policy check would (more than 16, a drive root, '..'), before setup changes anything.
test('setup: -BuildRoot is refused as the policy would, before anything changes', { skip: !windows }, () => {
  const { spawnSync } = require('child_process')
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup', 'install.ps1'), 'utf8')
  const block = /^\$buildRoots = @\(\$BuildRoot[\s\S]*?^if \(\$buildRoots\.Count -gt 16\).*$/m.exec(src)
  assert.ok(block, 'the -BuildRoot block is in install.ps1')
  const sc = scratch('setup-buildroots')
  const file = path.join(sc.dir, 'buildroots.ps1')
  fs.writeFileSync(file, `param([string[]]$BuildRoot = @())\n$ErrorActionPreference = 'Stop'\n${block[0]}\nConvertTo-Json -Compress @{ buildRoots = @($buildRoots) }\n`)
  const run = roots => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& '${file}' -BuildRoot ${roots.map(r => `'${r}'`).join(',')} 3>$null`], { encoding: 'utf8', env: ps51Env() })
  const many = n => Array.from({ length: n }, (_, i) => path.join(sc.dir, `root-${i}`))
  const sixteen = run([...many(16), path.join(sc.dir, 'root-0') + '\\'])
  assert.strictEqual(sixteen.status, 0, sixteen.stderr)
  const written = JSON.parse(sixteen.stdout.trim()).buildRoots
  assert.strictEqual(written.length, 16, 'a repeat (with a trailing \\) counts once')
  assert.deepStrictEqual(policy.problems({ ...policy.DEFAULTS, diskFolders: ['D:\\hv'], buildRoots: written }), [])
  const seventeen = run(many(17))
  assert.notStrictEqual(seventeen.status, 0)
  assert.match(seventeen.stderr + seventeen.stdout, /At most 16 build roots: 17 were given/)
  assert.match(policy.problems({ ...policy.DEFAULTS, diskFolders: ['D:\\hv'], buildRoots: many(17) }).join(), /at most 16/)
  for (const bad of ['C:\\', 'relative', path.join(sc.dir, 'a') + '\\..\\b']) {
    const r = run([bad])
    assert.notStrictEqual(r.status, 0, bad)
    assert.match(r.stderr + r.stdout, /Build root .* must be/, bad)
  }
})
