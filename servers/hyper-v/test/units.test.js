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

test('setup ACLs: earlier grants removed from a folder and what it holds; VM grants kept; links refused (non-elevated)', { skip: !windows }, () => {
  const { spawnSync } = require('child_process')
  const sc = scratch('acl')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'acl-check.ps1'), '-Dir', sc.dir], { encoding: 'utf8' })
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
  // Provenance: a forged state folder is refused before anything changes; fresh and already-secured ones are fine.
  assert.match(a.evil, /already exists with contents setup didn't secure, so they can't be trusted .*Nothing was changed/)
  assert.strictEqual(a.evilJournalUntouched, true)
  assert.strictEqual(a.evilAclUntouched, true, 'refused untouched: no repair that would make it look trusted')
  assert.match(a.evilOwned, /can't be trusted/, 'without the grant, its user-owned contents are still refused')
  assert.strictEqual(a.missing, 'fresh')
  assert.strictEqual(a.empty, 'fresh')
  assert.strictEqual(a.good, 'trusted')
})

test('approve.ps1 runs only from the installed, admin-only folder', { skip: !windows }, () => {
  const { spawnSync } = require('child_process')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'helper', 'approve.ps1'), '-Plan', 'p-0123456789abcdef'], { encoding: 'utf8' })
  assert.notStrictEqual(r.status, 0)
  assert.match(r.stderr + r.stdout, /Run approve\.ps1 from .*hyperv-mcp, not from/)
})
