// The helper's pieces on their own: the bounded UDF/WIM reader against real UDF images (made with the in-box IMAPI2
// through hv.ps1's make-iso) and malformed ones; the image checks (MC-1572: any local ISO, copied while hashed; signatures
// as information; x64 and one edition per ISO); the policy; the journal (a torn last line); canonical plan text; the answer file's escaping.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { T, scratch, startHelper, approve, waitFor, psEngines } = require('./helpers')
// MC-1575: setup, uninstall and approve run under Windows PowerShell 5.1 and PowerShell 7; each check runs under both.
const ENGINES = psEngines()
const iso = require('../helper/iso')
const images = require('../helper/images')
const policy = require('../helper/policy')
const { Journal } = require('../helper/journal')
const { ps51Env } = require('../helper/hv')
const { canonical, baselineProblem, expiry, licenceOf } = require('../helper/core')
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

test('images (MC-1572): any local ISO the user names is taken, copied while hashed, with its path; no pin, no policy, no override', { skip: !windows }, async () => {
  const sc = scratch('images-local')
  process.env.HYPERV_MCP_MIN_ISO_BYTES = '1'
  const f = await udf(sc, 'local', goodFiles())
  const sig = async (op, a) => ({ files: a.files.map(file => ({ file, ok: true })) })
  const img = await images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'images'), hv: sig })
  assert.deepStrictEqual([img.source, img.path, img.edition, img.build, img.evaluation, img.pinned], ['local', fs.realpathSync.native(f), 'EnterpriseEval', '26200.6584', true, undefined])
  assert.deepStrictEqual(img.signature, { microsoft: true, note: 'setup.exe and sources\\setup.exe validly signed by Microsoft' })
  assert.strictEqual(img.sha256, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'))
  assert.ok(fs.existsSync(img.file) && path.dirname(img.file) === path.join(sc.disks, 'images'), 'its own copy')
  assert.strictEqual(await images.hashFile(img.file), img.sha256, 'the build\'s recheck of the copy')
  const again = await images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'images'), hv: sig, known: new Map([[img.sha256, img]]) })
  assert.strictEqual(again.existing, true)
})

test('images (MC-1572): any x64 edition and build; signatures are information only; ARM and other limits refused by name; the helper never downloads', { skip: !windows }, async () => {
  const sc = scratch('images-any')
  process.env.HYPERV_MCP_MIN_ISO_BYTES = '1'
  const ok = async (op, a) => ({ files: a.files.map(file => ({ file, ok: true })) })
  const bad = async (op, a) => ({ files: a.files.map(file => ({ file, ok: false, why: 'signature NotSigned' })) })
  const broken = async () => { throw new Error('powershell went away') }
  const f = await udf(sc, 'img', goodFiles())
  // Unsigned, or the signature check failing: still taken, and the record says so for the plan.
  const unsigned = await images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'i1'), hv: bad })
  assert.deepStrictEqual(unsigned.signature, { microsoft: false, note: 'setup.exe: signature NotSigned; sources\\setup.exe: signature NotSigned' })
  const unread = await images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'i1b'), hv: broken })
  assert.deepStrictEqual(unread.signature, { microsoft: false, note: 'not read: powershell went away' })
  // Editions and builds the helper once refused: Home (Core), Server, Windows 10, and Microsoft's newer 26H2 build.
  for (const [name, edition, build, sp, evaluation] of [['home', 'Core', 26200, 1, false], ['server', 'ServerStandardEval', 26100, 1742, true], ['win10', 'Professional', 19045, 2965, false], ['h26', 'EnterpriseEval', 26300, 9457, true]]) {
    const iso = await udf(sc, name, { ...goodFiles(), 'sources/install.wim': wim([{ edition, build, sp }]) })
    const r = await images.prepare({ want: { iso }, dir: path.join(sc.disks, `e-${name}`), hv: ok })
    assert.deepStrictEqual([r.edition, r.build, r.evaluation], [edition, `${build}.${sp}`, evaluation], name)
  }
  // Limits, not gates: an x64 host runs x64 guests; the edition asked must be in the ISO.
  const arm = await udf(sc, 'arm', { ...goodFiles(), 'sources/install.wim': wim([{ edition: 'EnterpriseEval', build: 26200, sp: 1, arch: 12 }]) })
  await assert.rejects(images.prepare({ want: { iso: arm }, dir: path.join(sc.disks, 'i3'), hv: ok }), /holds no x64 image \(it holds EnterpriseEval \(arch 12\)\): an x64 Hyper-V host runs x64 guests only/)
  await assert.rejects(images.prepare({ want: { iso: f, edition: 'Education' }, dir: path.join(sc.disks, 'i2'), hv: ok }), /should hold one x64 Education image; it holds EnterpriseEval/)
  await assert.rejects(images.prepare({ want: { iso: f, edition: '../x' }, dir: path.join(sc.disks, 'i2'), hv: ok }), /edition must be an edition ID/)
  await assert.rejects(images.prepare({ want: { iso: f }, dir: path.join(sc.disks, 'i4'), hv: ok, ownDirs: [sc.dir] }), /helper's own folders/)
  await assert.rejects(images.prepare({ want: { iso: 'relative.iso' }, dir: path.join(sc.disks, 'i5'), hv: ok }), /absolute local path/)
  for (const want of [{ download: 'https://go.microsoft.com/fwlink/?LinkId=2382600' }, { download: 'win11-enterprise-eval' }, { iso: f, download: 'https://x.microsoft.com/a.iso' }, { url: 'https://example.com/x.iso' }]) {
    await assert.rejects(images.prepare({ want, dir: path.join(sc.disks, 'i6'), hv: ok }), /The helper doesn't download images: download the ISO yourself, then pass image \{ iso: "<its path>" \}/)
  }
  assert.ok(!require('fs').readFileSync(path.join(__dirname, '../helper/images.js'), 'utf8').includes("require('https')"), 'images.js has no network code')
})

test('the user\'s ISO through the helper (MC-1572): the no-image hint names a file, never a download; the plan names the path and hash; create-vm gets that hash', { skip: !windows }, async () => {
  const sc = scratch('user-iso', { stub: { setupOverride: { build: '26300', ubr: 9457 } } }) // the guest of a 26H2 image
  const iso = await udf(sc, 'Win11_Eval_26H2', { ...goodFiles(), 'sources/install.wim': wim([{ edition: 'EnterpriseEval', build: 26300, sp: 9457 }]) })
  const sha = crypto.createHash('sha256').update(fs.readFileSync(iso)).digest('hex')
  const h = await startHelper(sc, { HYPERV_MCP_MIN_ISO_BYTES: '1' })
  try {
    const admin = h.conn(1)
    const create = { action: 'create', vms: 1, cores: 2, memoryGB: 4 }
    const hint = await admin.request('pool_plan', create).then(() => '', e => e.message)
    assert.match(hint, /^No image yet: pass image \{ iso: "<path to a Windows ISO>" \}, or \{ file: "<path to a Linux qcow2 cloud image>" \}, the file the user chose for these VMs\. The plan they approve names it and its hash\.$/)
    assert.doesNotMatch(hint, /download/i)
    for (const image of [{ download: 'win11-enterprise-eval' }, { download: 'https://go.microsoft.com/fwlink/?LinkId=2382600' }, { distro: 'debian' }, { pin: 'debian-13-20261116-2664' }]) {
      await assert.rejects(admin.request('pool_plan', { ...create, image }), /The helper doesn't download images/, JSON.stringify(image))
    }
    assert.match((await admin.request('pool_plan', { ...create, image: { iso } })).text, /Checking the image now/)
    await waitFor(async () => /Image: ready: EnterpriseEval 26300\.9457/.test((await admin.request('status')).text), T.waitForMs, 'the image check')
    const plan = await admin.request('pool_plan', create)
    assert.ok(plan.text.includes(`- image: EnterpriseEval build 26300.9457, SHA-256 ${sha}, from ${fs.realpathSync.native(iso)}, copied into the helper's folder; the build uses that copy, checked against this SHA-256 first; setup files: signed by Microsoft`), plan.text)
    assert.match(plan.text, /- activation: each new VM goes online once/, 'an evaluation edition is still activated at build')
    const record = JSON.parse(fs.readFileSync(path.join(sc.stateDir, 'plans', `${plan.data.planId}.json`), 'utf8'))
    assert.deepStrictEqual([record.image.sha256, record.image.path, record.image.signature.microsoft, record.image.pinned], [sha, fs.realpathSync.native(iso), true, undefined])
    approve(sc, plan.data.planId)
    await admin.request('pool_create', { planId: plan.data.planId })
    const st = await waitFor(async () => { const t = (await admin.request('status')).text; return /Last pool job: create (finished|FAILED)/.test(t) && t }, T.poolJobMs, 'the pool job')
    assert.match(st, /Last pool job: create finished/, st)
    assert.deepStrictEqual(Object.values(sc.stub().vms).map(v => v.isoSha256), [sha], 'create-vm was given the approved hash to check the copy against')
  } finally { await h.stop() }
})

test('hv.ps1 create-vm (MC-1572): an ISO copy whose SHA-256 is no longer the approved one is refused before anything is created', { skip: !windows }, async () => {
  const sc = scratch('create-vm-swap')
  const iso = path.join(sc.disks, 'swapped.iso')
  fs.writeFileSync(iso, 'the bytes someone swapped in')
  const folder = path.join(sc.disks, 'vm')
  const args = { name: 'hvmcp-swap-test', folder, cores: 1, memoryMB: 1024, diskGB: 1, iso, unattendIso: iso }
  await assert.rejects(hv('create-vm', { ...args, isoSha256: 'ab'.repeat(32) }), /has changed since it was checked and approved \(SHA-256 [0-9a-f]{64}, not (ab){32}\): refused, nothing created/)
  await assert.rejects(hv('create-vm', args), /needs the approved image's SHA-256/)
  assert.ok(!fs.existsSync(path.join(folder, 'disk.vhdx')), 'no disk was made')
})

test('images: one edition per ISO (MC-1513): a multi-edition ISO needs edition; its record keeps it; another edition of it is refused', { skip: !windows }, async () => {
  const sc = scratch('images-editions')
  process.env.HYPERV_MCP_MIN_ISO_BYTES = '1'
  const ok = async (op, a) => ({ files: a.files.map(file => ({ file, ok: true })) })
  const multi = await udf(sc, 'multi', { ...goodFiles(), 'sources/install.wim': wim([{ edition: 'Core', build: 26200, sp: 1 }, { edition: 'Professional', build: 26200, sp: 1 }, { edition: 'Enterprise', build: 26200, sp: 1 }]) })
  const dir = path.join(sc.disks, 'images')
  await assert.rejects(images.prepare({ want: { iso: multi }, dir, hv: ok }), /holds several editions \(Core, Professional, Enterprise\): pass image \{ iso, edition/)
  const pro = await images.prepare({ want: { iso: multi, edition: 'Professional' }, dir, hv: ok })
  assert.deepStrictEqual([pro.edition, pro.imageIndex, pro.evaluation], ['Professional', 2, false])
  const known = new Map([[pro.sha256, pro]])
  await assert.rejects(images.prepare({ want: { iso: multi, edition: 'Enterprise' }, dir, hv: ok, known }), /recorded as Professional; another edition from the same ISO isn't supported/)
  assert.deepStrictEqual([known.get(pro.sha256).edition, known.get(pro.sha256).imageIndex], ['Professional', 2], 'the record is unchanged')
  for (const want of [{ iso: multi, edition: 'Professional' }, { iso: multi }]) {
    const again = await images.prepare({ want, dir, hv: ok, known })
    assert.deepStrictEqual([again.existing, again.edition, again.imageIndex], [true, 'Professional', 2])
  }
  const one = await udf(sc, 'one', { ...goodFiles(), 'sources/install.wim': wim([{ edition: 'Education', build: 26200, sp: 1 }]) })
  const edu = await images.prepare({ want: { iso: one }, dir, hv: ok })
  assert.deepStrictEqual([edu.edition, edu.imageIndex, edu.evaluation], ['Education', 1, false])
  const ev = await images.prepare({ want: { iso: await udf(sc, 'ev', goodFiles()) }, dir: path.join(sc.disks, 'ev'), hv: ok })
  assert.strictEqual(ev.evaluation, true)
})

test('images: the guest\'s report after the install is a sanity check against the image', () => {
  const img = { edition: 'EnterpriseEval', build: '26300.9457' }
  assert.strictEqual(images.guestReportProblem({ editionId: 'EnterpriseEval', build: '26300' }, img), null)
  assert.match(images.guestReportProblem({ editionId: 'Professional', build: '26300' }, img), /edition/)
  assert.match(images.guestReportProblem({ editionId: 'EnterpriseEval', build: '26200' }, img), /build 26200, the image 26300\.9457/)
  // MC-1577: no registry policy of the build's own is checked any more (MC-1522's is gone).
  assert.strictEqual(images.guestReportProblem({ editionId: 'EnterpriseEval', build: '26300', disableForceUnload: 0 }, img), null)
  assert.ok(images.isEvalEdition('EnterpriseEval') && images.isEvalEdition('ServerDatacenterEval') && !images.isEvalEdition('Enterprise'))
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
  assert.deepStrictEqual(policy.problems({ ...p, buildRoots: Array(40).fill('C:\\x') }), [], 'MC-1579: any number of them')
  // MC-1579: no ceilings of the policy's own; Hyper-V's own maximums, each named, and lower bounds where less can't work.
  // Round 2: VMs, cores, memory and disk have no ceiling here (Hyper-V's own depend on its version, and it refuses past
  // them itself); leases and sessions none (a session ends by JavaScript's last date: sessions.test.js).
  for (const ok of [{ maxVms: 5000 }, { maxCoresPerVm: 4096 }, { maxMemoryMBTotal: 512 * 1024 * 1024 }, { maxDiskGBPerVm: 1024 * 1024 }, { maxLeaseMinutes: 1, maxSessionMinutes: 1 }, { maxLeaseMinutes: 60 * 24 * 90, maxSessionMinutes: 60 * 24 * 365 }, { maxLeaseMinutes: 1e9 + 1, maxSessionMinutes: Number.MAX_SAFE_INTEGER }, { maxBuildMB: 1024 * 1024 }, { maxLeaseCheckpoints: 20, maxCheckpointsPerVm: 28 }, { minFreeGBForCheckpoint: 0 }, { minFreeGBForCheckpoint: 5000 }]) {
    assert.deepStrictEqual(policy.problems({ ...p, ...ok }), [], JSON.stringify(ok))
  }
  assert.match(policy.problems({ ...p, maxVms: 0 }).join(), /maxVms must be a whole number, at least 1/)
  assert.match(policy.problems({ ...p, maxLeaseMinutes: 0 }).join(), /maxLeaseMinutes must be a whole number, at least 1/)
  assert.match(policy.problems({ ...p, maxLeaseMinutes: Number.MAX_SAFE_INTEGER + 2 }).join(), /maxLeaseMinutes must be a whole number/)
  assert.match(policy.problems({ ...p, maxCheckpointsPerVm: 49 }).join(), /maxCheckpointsPerVm must be 0-48/)
  assert.match(policy.problems({ ...p, maxLeaseCheckpoints: 25, maxCheckpointsPerVm: 24 }).join(), /together must be at most 48 \(they are 49\): Hyper-V keeps at most 50 checkpoints of a VM/)
  assert.match(policy.problems({ ...p, maxLeaseCheckpoints: 45 }).join(), /they are 49/, 'with the other\'s default')
  for (const f of ['D:\\hyperv-mcp\\pool\\i-1', 'd:\\HYPERV-MCP\\x']) assert.ok(policy.underDiskFolder(p, f), f)
  for (const f of ['D:\\hyperv-mcp', 'D:\\hyperv-mcp-evil\\x', 'D:\\hyperv-mcp\\..\\x', 'C:\\x', 'relative\\x', 42]) assert.ok(!policy.underDiskFolder(p, f), String(f))
  const vm = { cores: 2, memoryMB: 4096, diskGB: 64, folder: 'D:\\hyperv-mcp\\pool\\i-1' }
  assert.deepStrictEqual(policy.checkPool(p, [vm, vm]), [])
  assert.match(policy.checkPool(p, Array(5).fill(vm)).join(), /5 VMs is more than the policy's 4/)
  assert.match(policy.checkPool(p, [{ ...vm, memoryMB: 4097 }]).join(), /even number/)
  assert.match(policy.checkPool({ ...p, maxNetwork: 'none' }, [vm], { network: 'host' }).join(), /network host is above the policy's none/)
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
  assert.doesNotMatch(x, /ProductKey/)
  const keyed = autounattend({ computerName: 'HVMCP-1234', creds, imageIndex: 3, productKey: 'ABCDE-FGHIJ-KLMNO-PQRST-UVWXY' })
  assert.match(keyed, /<Key>\/IMAGE\/INDEX<\/Key><Value>3<\/Value>/)
  // The activation key: Shell-Setup's ProductKey in the specialize pass (the one Microsoft names for a MAK), once;
  // windowsPE's UserData carries none (the image index picks the edition).
  const specialize = keyed.slice(keyed.indexOf('<settings pass="specialize">'), keyed.indexOf('<settings pass="oobeSystem">'))
  const shell = specialize.slice(specialize.indexOf('name="Microsoft-Windows-Shell-Setup"'), specialize.indexOf('</component>', specialize.indexOf('name="Microsoft-Windows-Shell-Setup"')))
  assert.match(shell, /<ProductKey>ABCDE-FGHIJ-KLMNO-PQRST-UVWXY<\/ProductKey>/)
  assert.strictEqual(keyed.split('ABCDE-FGHIJ-KLMNO-PQRST-UVWXY').length, 2, 'the key appears once')
  assert.match(keyed, /<UserData><AcceptEula>true<\/AcceptEula><\/UserData>/)
  assert.throws(() => autounattend({ computerName: 'OK', creds, productKey: 'abc<de' }), /product key/)
  assert.throws(() => autounattend({ computerName: 'OK', creds, imageIndex: 0 }), /image index/)
  assert.throws(() => autounattend({ computerName: 'bad name<', creds }), /computer name/)
  assert.throws(() => autounattend({ computerName: 'OK', creds: { ...creds, user: { user: 'x y', password: 'p' } } }), /user account/)
})

test('the licence note (MC-1513): an evaluation\'s days left from its recorded end, a warning from 14 days, ended; an own copy; unknown for older VMs', () => {
  const day = 24 * 60 * 60 * 1000
  const t0 = Date.parse('2026-11-13T00:00:00Z')
  const vm = { readyAt: new Date(t0).toISOString(), licence: { kind: 'evaluation', expiresAt: new Date(t0 + 90 * day).toISOString() } }
  assert.match(expiry(vm, t0 + 1 * day), /; Windows evaluation, 89 days left \(until 2027-02-11\)$/)
  assert.match(expiry(vm, t0 + 80 * day), /WARNING: its Windows evaluation ends in about 10 day\(s\), on 2027-02-11: ask the user to rebuild the pool/)
  assert.match(expiry(vm, t0 + 90 * day - 30 * 60_000), /evaluation ends 2027-02-11T00:00:00.000Z: it is no longer leased; the pool needs a rebuild/)
  assert.match(expiry(vm, t0 + 91 * day), /evaluation ended 2027-02-11T00:00:00.000Z/)
  assert.strictEqual(expiry({ ...vm, licence: { kind: 'own', activated: true, status: 1 } }, t0), '; own copy of Windows, activated')
  assert.strictEqual(expiry({ ...vm, licence: { kind: 'own', activated: false, status: 5 } }, t0), '; own copy of Windows, not activated (licence status 5)')
  assert.match(expiry({ readyAt: vm.readyAt }, t0 + 91 * day), /^; licence unknown \(built before Windows activation was recorded/)
  assert.strictEqual(expiry({}, t0), '')
})

test('a build\'s licence (MC-1513): an evaluation must be licensed with at least 85 days, its end the earlier of the guest\'s two fields; an own copy as it is', () => {
  const day = 24 * 60 * 60 * 1000
  const now = Date.parse('2026-11-14T00:00:00Z')
  const at = d => new Date(now + d * day).toISOString()
  assert.deepStrictEqual(licenceOf({ status: 1, graceMinutes: 90 * 1440 }, true, now), { kind: 'evaluation', expiresAt: at(90) })
  assert.deepStrictEqual(licenceOf({ status: 1, graceMinutes: 90 * 1440, evalEnd: at(88) }, true, now), { kind: 'evaluation', expiresAt: at(88) }, 'the earlier end')
  assert.deepStrictEqual(licenceOf({ status: 1, graceMinutes: 0, evalEnd: at(86) }, true, now), { kind: 'evaluation', expiresAt: at(86) })
  assert.throws(() => licenceOf({ status: 1, graceMinutes: 84 * 1440 + 1000 }, true, now), /only 84 day\(s\) left \(at least 85 needed\)/)
  assert.throws(() => licenceOf({ status: 5, graceMinutes: 0, error: 'no route' }, true, now), /didn't activate \(licence status 5: no route\)/)
  assert.throws(() => licenceOf({ status: 1, graceMinutes: 0, evalEnd: null }, true, now), /no evaluation period/)
  // A real end date that has passed (or is now) fails closed, whatever the grace figure says.
  assert.throws(() => licenceOf({ status: 1, graceMinutes: 90 * 1440, evalEnd: at(-1) }, true, now), /end date, 2026-11-13T00:00:00.000Z, has already passed/)
  assert.throws(() => licenceOf({ status: 1, graceMinutes: 90 * 1440, evalEnd: at(0) }, true, now), /has already passed/)
  assert.throws(() => licenceOf({ status: 1, graceMinutes: 0, evalEnd: at(-1) }, true, now), /has already passed/)
  // An absent or unreadable date is ignored (hv.ps1 sends none for Windows' 1601 sentinel).
  assert.deepStrictEqual(licenceOf({ status: 1, graceMinutes: 90 * 1440, evalEnd: 'not a date' }, true, now), { kind: 'evaluation', expiresAt: at(90) })
  assert.deepStrictEqual(licenceOf({ status: 1 }, false, now), { kind: 'own', activated: true, status: 1 })
  assert.deepStrictEqual(licenceOf({ status: 5 }, false, now), { kind: 'own', activated: false, status: 5 })
})

for (const E of ENGINES) test(`setup storage and ACLs under PowerShell ${E.name} (non-elevated): grants removed; VM grants kept; links refused; secure creation, receipts, parents, pins`, () => {
  const { spawnSync } = require('child_process')
  const sc = scratch(`acl-${E.name}`)
  const r = spawnSync(E.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'acl-check.ps1'), '-Dir', sc.dir], { encoding: 'utf8', env: E.env })
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
  // MC-1581: an extra account's read-only grant (Explorer's "Continue") is shown, and removed only if the admin agrees;
  // write access by another account, or a changed identity, is still refused.
  assert.match(a.writeWithYes, /contents aren't as setup and the helper leave them.*S-1-5-32-545|BUILTIN.Users/, 'without -WriteRepair (the state folder), a Users write grant is refused even with a yes')
  // MC-1581 (the user's decision): a disk folder after Explorer's Continue (Full Control): offered for removal, with its warning.
  assert.match(a.diskWriterNoQuestion, /has its receipt, but BUILTIN.Users have access to it, and the grant wasn't removed\. Nothing was changed/)
  assert.match(a.diskWriterNo, /have access to it, and the grant wasn't removed/)
  assert.deepStrictEqual(a.diskWriterShown, [{ sid: 'S-1-5-32-545', write: true }], 'shown as able to write')
  assert.strictEqual(a.diskWriterKeptOnNo, true, 'a no changes nothing')
  assert.strictEqual(a.diskWriterYes, 'trusted (extra access removed)')
  assert.strictEqual(a.diskWriterGone, true, 'gone from the folder and everything in it')
  assert.strictEqual(a.diskHyperVKept, true, 'Hyper-V\'s own grants kept')
  assert.strictEqual(a.diskWriterAfter, 'trusted', 'trusted again after')
  // Round 1: links planted while the question is open (a file and a folder symbolic link to outside targets): the
  // removal changes neither target (icacls /L), and the folder is refused for the links.
  assert.strictEqual(a.linksMade, true, `this test needs symbolic links (Developer Mode, or the right to create them): ${a.linksMade}`)
  assert.match(a.plantedResult, /planted(-dir|\.txt) is a link.*It won't be used/)
  assert.strictEqual(a.outsideUnchanged, true, 'the outside targets\' permissions are exactly as they were')
  assert.strictEqual(a.outsideData, 'outside data')
  assert.strictEqual(a.readerBefore, true, 'the folder and its contents carried the read grant')
  assert.match(a.readerNoQuestion, /can read it, and the grant wasn't removed\. Nothing was changed: run setup again and agree to remove it/)
  assert.match(a.readerNo, /can read it, and the grant wasn't removed/)
  assert.strictEqual(a.readerKeptOnNo, true, 'a no changes nothing')
  assert.deepStrictEqual(a.readerShown.map(x => ({ ...x, where: x.where >= 3 })), [{ sid: 'S-1-5-32-545', rights: 'ReadAndExecute, Synchronize', where: true }], 'shown: the account, its rights, on the folder and everything in it')
  assert.strictEqual(a.readerYes, 'trusted (extra access removed)')
  assert.strictEqual(a.readerGone, true, 'gone from the folder and everything in it')
  assert.strictEqual(a.readerAfter, 'trusted', 'and trusted unchanged on the next run')
  assert.strictEqual(a.readerDataKept, true, 'its contents untouched')
  assert.strictEqual(a.teardownReader, true, 'uninstall lets a read-only grant through')
  assert.match(a.teardownWriter, /isn't as setup and the helper leave it \(.*(BUILTIN.Users|S-1-5-32-545) has Write.*\), so it won't be deleted/, 'but not a write grant')
})

for (const E of ENGINES) test(`approve.ps1 runs only from the installed, admin-only folder (PowerShell ${E.name})`, () => {
  const { spawnSync } = require('child_process')
  const r = spawnSync(E.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'helper', 'approve.ps1'), '-Plan', 'p-0123456789abcdef'], { encoding: 'utf8', env: E.env })
  assert.notStrictEqual(r.status, 0)
  assert.match(r.stderr + r.stdout, /Run approve\.ps1 from .*hyperv-mcp, not from/)
})

// MC-1506 refused PowerShell 7 (acl.ps1's Framework-only FileStream constructor); MC-1575 replaced that call, so setup,
// uninstall and approve run under either, each going on to its own checks (here, non-elevated, the admin check), with
// nothing made on the way.
for (const E of ENGINES) test(`setup, uninstall and approve run under PowerShell ${E.name}, on to their own checks, changing nothing`, () => {
  const { spawnSync } = require('child_process')
  const sc = scratch(`runs-under-${E.name}`)
  const disk = path.join(sc.dir, 'never-made')
  const run = (file, args) => spawnSync(E.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8', env: E.env })
  const setup = path.join(__dirname, '..', 'setup')
  for (const [file, args] of [[path.join(setup, 'install.ps1'), ['-DiskFolder', disk]], [path.join(setup, 'uninstall.ps1'), ['-KeepPool']]]) {
    const r = run(file, args)
    assert.notStrictEqual(r.status, 0)
    assert.doesNotMatch(r.stdout + r.stderr, /needs Windows PowerShell 5\.1/)
    assert.match(r.stdout + r.stderr, /Run this in an admin terminal \(Run as administrator\)/, `${file}: the tests run non-elevated, so the admin check is next: ${r.stdout}${r.stderr}`)
  }
  assert.ok(!fs.existsSync(disk), 'setup made its disk folder')
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

// Under 5.1 started from a PowerShell 7 window, each script drops PS7's module folders itself, with the same rule as
// ps51Env; under PowerShell 7 they are its own, and kept (MC-1575).
const PS7_DIR = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'Modules')
const SCRUB = /^if \(\$PSVersionTable\.PSEdition -eq 'Desktop'\) \{ (\$env:PSModulePath = .*) \}$/m
test('setup, uninstall and approve.ps1 load 5.1\'s own modules when started from PowerShell 7', { skip: !windows || !fs.existsSync(PS7_DIR) }, () => {
  const { spawnSync } = require('child_process')
  const lines = ['setup/install.ps1', 'setup/uninstall.ps1', 'helper/approve.ps1'].map(f => {
    const m = fs.readFileSync(path.join(__dirname, '..', f), 'utf8').match(SCRUB)
    assert.ok(m, `${f} drops PowerShell 7's module folders, under 5.1 only`)
    return m[1]
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
  // Under PowerShell 7 the guarded line leaves its module folders as they are, and Get-Acl loads.
  const seven = ENGINES.find(e => e.name === '7')
  if (seven) {
    const guarded = fs.readFileSync(path.join(__dirname, '..', 'setup', 'install.ps1'), 'utf8').match(SCRUB)[0]
    const r = spawnSync(seven.exe, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; $before = $env:PSModulePath; ${guarded}; if ($env:PSModulePath -ne $before) { exit 3 }; ${probe}`], { encoding: 'utf8', env: seven.env })
    assert.strictEqual(r.status, 0, `under 7: ${r.stdout}${r.stderr}`)
  }
})

for (const E of ENGINES) test(`uninstall teardown under PowerShell ${E.name} (non-elevated, fakes): verified targets only; resumable after a crash at every boundary`, { timeout: T.longTestMs }, () => {
  const { spawnSync } = require('child_process')
  const sc = scratch(`teardown-${E.name}`)
  const r = spawnSync(E.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'teardown-check.ps1'), '-Dir', sc.dir], { encoding: 'utf8', env: E.env, timeout: T.longScriptMs })
  const line = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('RESULT:'))
  assert.ok(line, `teardown-check.ps1 failed: ${r.stdout}\n${r.stderr}`)
  const a = JSON.parse(line.slice(7))
  assert.strictEqual(a.full, 'ok')
  assert.strictEqual(a.fullGone, true, 'storage, components, receipts, InstallId and the record all gone')
  // MC-1583: the remove plan and the one question first (nothing changed before the answer), then a fresh plan after
  // quiesce, then the pool, the stop and (after storage) the components.
  assert.strictEqual(a.fullOrder, 'plan,confirm,quiesce:remove-pool,plan,remove-pool,stop,delete-service,rights,group', 'pool, then stop, then (after storage) the components')
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
  assert.match(a.mismatchMode, /started with another choice \(mode keep\).*Nothing was changed/)
  assert.match(a.installDuring, /An uninstall is unfinished/)
  assert.strictEqual(a.keepFinish, 'ok', 'a resume with no option takes the recorded mode'); assert.strictEqual(a.installAfter, 'allowed')
  // MC-1583: the legacy path is retired: storage without receipts is refused untouched, pointing to the manual steps.
  assert.match(a.legacyRefused, /There are no storage receipts .*Nothing was changed\. \(An install from before storage receipts, an unreleased build of 13 Nov, is removed by hand: see the README's Uninstall\.\)/)
  assert.strictEqual(a.legacyUntouched, true)
  // The service started again after 'stopped' (reboot, Start-Service): stopped again before the first deletion; and after
  // 'storage-removed': stopped before it is deleted.
  assert.match(a.restartCrash, /CRASH:after:phase:stopped/); assert.strictEqual(a.restartRerun, 'ok')
  assert.strictEqual(a.restartOrder, 'stop,deleting,delete-service,rights,group'); assert.strictEqual(a.restartGone, true)
  assert.match(a.restart2Crash, /CRASH:after:phase:storage-removed/); assert.strictEqual(a.restart2Rerun, 'ok')
  assert.strictEqual(a.restart2Order, 'stop,delete-service,rights,group'); assert.strictEqual(a.restart2Gone, true)
  // Keep mode verifies the storage too: refusals with no side effect at all.
  assert.match(a.keepJunction, /isn't as setup and the helper leave it/); assert.strictEqual(a.keepJunctionQuiet, true)
  assert.match(a.keepMismatch, /identity differs from its receipt/); assert.strictEqual(a.keepMismatchQuiet, true)
  // A resumed run re-verifies before acting (quiesce writes into the state folder).
  assert.match(a.resumeCrash, /CRASH:after:record/)
  assert.match(a.resumeTampered, /isn't as setup and the helper leave it/); assert.strictEqual(a.resumeTamperedQuiet, true)
  // Hyper-V's grantee pattern is for disk folders only.
  assert.match(a.capabilityInState, /isn't as setup and the helper leave it/); assert.strictEqual(a.capabilityInStateQuiet, true)
  // MC-1557: -WhatIf changes nothing (only reads asked of the outside, no record, files and key as they were).
  for (const m of ['remove', 'keep']) {
    const w = a.whatIf[m]
    assert.strictEqual(w.result, 'ok', `${m}: ${w.result}`)
    assert.strictEqual(w.unchanged, true, `${m}: files and key unchanged: ${w.diff}`)
    assert.strictEqual(w.record, true, `${m}: no record`)
    assert.strictEqual(w.calls, '', `${m}: no outside action asked (the helper's status, a read, is the only one, and every other op throws)`)
    assert.match(w.said, m === 'remove' ? /Verified\. Would remove the pool \(2 VM\(s\).*then these folders: / : /Verified\. Would keep the pool and these folders: /)
  }
  // MC-1557: the install folder's uninstall\ stays (the entry's route) until the retire phase; the rest goes.
  assert.strictEqual(a.keepsUninstall, 'ok')
  assert.strictEqual(a.keepsUninstallLeft, 'uninstall')
  assert.strictEqual(a.keepsUninstallFile, true)
  // MC-1583: the one confirmation, bound to the exact VMs the helper's remove plan names.
  const B = a.bind
  const changed = /^The pool changed since you confirmed what goes: nothing more was approved or removed\. Run the uninstaller again/
  const untouched = { phase: 'verified', removed: 0, storage: true }
  assert.deepStrictEqual(B.normal, { result: 'ok', shownVms: ['vm-1', 'vm-2'], shownFolders: 2, asked: 1, reasked: 0, approved: true, gone: true, order: 'plan,confirm,quiesce:remove-pool,plan,remove-pool,stop,delete-service,rights,group' }, 'one question; the plan approved with no second one')
  assert.deepStrictEqual(B.cancel, { result: 'cancelled', record: true, calls: 'plan,confirm', service: 'running' }, 'a no: nothing written, quiesced, stopped or removed')
  assert.deepStrictEqual(B.askKeep, { result: 'ok', kept: true, removed: 0 })
  assert.match(B.added.result, changed); assert.deepStrictEqual(B.added.change, { was: ['vm-1', 'vm-2'], now: ['vm-1', 'vm-2', 'vm-3'] }); assert.deepStrictEqual(B.added.after, untouched, 'a VM added: nothing removed, the record kept')
  assert.deepStrictEqual(B.addedRerun, { result: 'ok', asked: 1, reasked: 2, gone: true }, 'the rerun asks again (not the first question), and a yes removes the pool as it is')
  assert.match(B.replaced.result, changed); assert.deepStrictEqual(B.replaced.change, { was: ['vm-1', 'vm-2'], now: ['vm-9', 'vm-2'] }); assert.deepStrictEqual(B.replaced.after, untouched, 'the same count, another VM')
  assert.match(B.zeroToOne.result, changed); assert.strictEqual(B.zeroToOne.shownVms, 0); assert.deepStrictEqual(B.zeroToOne.change, { was: [], now: ['vm-new'] }); assert.deepStrictEqual(B.zeroToOne.after, untouched, 'an empty confirmation never covers a VM made since')
  assert.strictEqual(B.resumeEmpty.first, 'CRASH:after:record'); assert.match(B.resumeEmpty.result, changed); assert.strictEqual(B.resumeEmpty.asked, 1); assert.deepStrictEqual(B.resumeEmpty.change, { was: [], now: ['vm-late'] }); assert.deepStrictEqual(B.resumeEmpty.after, untouched)
  assert.deepStrictEqual(B.resumeSame, { first: 'CRASH:after:record', result: 'ok', asked: 1, reasked: 0, gone: true }, 'a resume against the same VMs asks nothing more')
  assert.deepStrictEqual(B.zeroStill, { result: 'ok', plans: 0, reasked: 0, gone: true }, 'none confirmed and none now: no plan, no second question')
})

// MC-1583: approve.ps1 -Confirmed (the uninstaller's) only for a remove plan: any other plan still needs its digest.
// Its checks run in order, so a test copy run from the right folder is needed to reach them; here the check itself is
// read from the script and run against both plan kinds.
test('approve.ps1 -Confirmed: only for a remove plan, and the digest question is skipped only then', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'helper', 'approve.ps1'), 'utf8')
  assert.match(src, /^param\(\[Parameter\(Mandatory = \$true\)\]\[string\]\$Plan, \[switch\]\$Confirmed\)$/m)
  assert.match(src, /^if \(\$Confirmed -and \$p\.op -ne 'remove'\) \{ throw "-Confirmed is only for the uninstaller's remove plan/m)
  const gate = src.indexOf("if ($Confirmed -and $p.op -ne 'remove')")
  assert.ok(gate > src.indexOf("if ($p.expires -le $now)") && gate < src.indexOf('Write-Host "Plan ${Plan}'), 'after every other check, before anything is shown or written')
  assert.match(src, /^if \(-not \$Confirmed\) \{\r?\n[\s\S]*?Read-Host 'To approve exactly this plan, type the first 6 characters of its digest/m)
  assert.ok(src.indexOf('if (-not $Confirmed) {') < src.indexOf("$dir = Join-Path $state 'approvals'"), 'the question comes before the approval is written')
})

// MC-1581: install.ps1's -DiskFolder check, run as setup runs it (the block cut from the script): a folder at any depth
// on a local fixed drive (its parents are checked later, by Open-TrustedAncestors, before anything changes); never a
// drive root. The policy agrees.
for (const E of ENGINES) test(`setup: -DiskFolder at any depth, not a drive root (PowerShell ${E.name})`, () => {
  const { spawnSync } = require('child_process')
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup', 'install.ps1'), 'utf8')
  const block = /^\$folders = @\(\$DiskFolder[\s\S]*?\r?\n\}\r?\n/m.exec(src)
  assert.ok(block, 'the -DiskFolder block in install.ps1')
  const sc = scratch(`setup-diskfolder-${E.name}`)
  const file = path.join(sc.dir, 'disk.ps1')
  fs.writeFileSync(file, `param([string[]]$DiskFolder)\n$ErrorActionPreference = 'Stop'\n${block[0]}\n'ok: ' + ($folders -join '|')\n`)
  const drive = (process.env.SystemDrive || 'C:').slice(0, 2)
  const run = d => spawnSync(E.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-DiskFolder', d], { encoding: 'utf8', env: E.env })
  for (const d of [`${drive}\\hyperv-mcp`, `${drive}\\VMs\\hyperv-mcp`, `${drive}\\VMs\\Pools\\hyperv mcp\\`]) {
    const r = run(d)
    assert.strictEqual(r.status, 0, `${d}: ${r.stdout}${r.stderr}`)
    assert.match(r.stdout, new RegExp(`ok: ${d.replace(/\\+$/, '').replace(/\\/g, '\\\\')}`), d)
    assert.deepStrictEqual(policy.problems({ ...policy.DEFAULTS, diskFolders: [d.replace(/\\+$/, '')] }), [], `the policy takes ${d}`)
  }
  const root = run(`${drive}\\`)
  assert.notStrictEqual(root.status, 0)
  assert.match(root.stdout + root.stderr, /must be a folder on a local drive, such as D:\\hyperv-mcp or D:\\VMs\\hyperv-mcp, not a drive root/)
})

// install.ps1's -BuildRoot checks, run as setup runs them (the block itself, cut from the script, not elevated): they
// refuse what the helper's policy check would (a drive root, '..'; any number of them, MC-1579), before setup changes
// anything.
for (const E of ENGINES) test(`setup: -BuildRoot is refused as the policy would, before anything changes (PowerShell ${E.name})`, () => {
  const { spawnSync } = require('child_process')
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup', 'install.ps1'), 'utf8')
  const block = /^\$buildRoots = @\(\$BuildRoot[\s\S]*?^\} \| Select-Object -Unique\)$/m.exec(src)
  assert.ok(block, 'the -BuildRoot block is in install.ps1')
  const sc = scratch('setup-buildroots')
  const file = path.join(sc.dir, 'buildroots.ps1')
  fs.writeFileSync(file, `param([string[]]$BuildRoot = @())\n$ErrorActionPreference = 'Stop'\n${block[0]}\nConvertTo-Json -Compress @{ buildRoots = @($buildRoots) }\n`)
  const run = roots => spawnSync(E.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& '${file}' -BuildRoot ${roots.map(r => `'${r}'`).join(',')} 3>$null`], { encoding: 'utf8', env: E.env })
  const many = n => Array.from({ length: n }, (_, i) => path.join(sc.dir, `root-${i}`))
  const twenty = run([...many(20), path.join(sc.dir, 'root-0') + '\\'])
  assert.strictEqual(twenty.status, 0, twenty.stderr)
  const written = JSON.parse(twenty.stdout.trim()).buildRoots
  assert.strictEqual(written.length, 20, 'a repeat (with a trailing \\) counts once; more than the former 16')
  assert.deepStrictEqual(policy.problems({ ...policy.DEFAULTS, diskFolders: ['D:\\hv'], buildRoots: written }), [])
  for (const bad of ['C:\\', 'relative', path.join(sc.dir, 'a') + '\\..\\b']) {
    const r = run([bad])
    assert.notStrictEqual(r.status, 0, bad)
    assert.match(r.stderr + r.stdout, /Build root .* must be/, bad)
  }
})

test('setup copies every helper file the service runs (guest-sync.ps1, guests/ and guest.py included), and the zip carries them', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup', 'install.ps1'), 'utf8')
  const list = /^foreach \(\$f in ((?:'[^']+',? ?)+)\) \{\r?\n  Copy-Item -LiteralPath \(Join-Path \$src "helper\\\$f"\)/m.exec(src)
  assert.ok(list, 'the helper file list in install.ps1')
  const copied = list[1].split(',').map(s => s.trim().replace(/'/g, '').replace(/\\/g, '/')).sort()
  // Every file the service runs, in the helper folder and its subfolders (the service host's source is compiled, not
  // copied); MC-1501 added guests/ and the Linux dispatcher (guest.py, copied into each Linux guest's seed).
  const helperDir = path.join(__dirname, '..', 'helper')
  const shipped = fs.readdirSync(helperDir, { recursive: true }).map(f => f.replace(/\\/g, '/')).filter(f => /\.(js|ps1|py|cmd)$/.test(f) && !f.startsWith('host/')).sort()
  assert.deepStrictEqual(copied, shipped)
  const { SERVERS } = await import(require('url').pathToFileURL(path.join(__dirname, '..', '..', '..', 'scripts', 'pack.mjs')).href)
  assert.ok(SERVERS['hyper-v'].some(([from]) => from === 'helper'), 'the zip holds the whole helper folder')
})

for (const E of ENGINES) test(`setup: -MaxSessionMinutes is checked as the helper checks it, before anything changes (PowerShell ${E.name})`, () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup', 'install.ps1'), 'utf8')
  const { spawnSync } = require('child_process')
  const line = /^if \(\$MaxSessionMinutes -and .*$/m.exec(src)
  assert.ok(line)
  const sc = scratch('setup-session')
  const file = path.join(sc.dir, 'session.ps1')
  fs.writeFileSync(file, `param([int]$MaxLeaseMinutes = 240, [int]$MaxSessionMinutes = 0)\n$ErrorActionPreference = 'Stop'\n${line[0]}\n'ok'\n`)
  const run = (lease, session) => spawnSync(E.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-MaxLeaseMinutes', String(lease), '-MaxSessionMinutes', String(session)], { encoding: 'utf8', env: E.env })
  // MC-1579: no upper limit (formerly 1440), and no floor beyond one lease.
  for (const [lease, session, ok] of [[240, 0, true], [240, 480, true], [240, 240, true], [240, 239, false], [60, 4, false], [240, 1441, true], [2880, 100000, true], [1, 1, true]]) {
    const r = run(lease, session)
    assert.strictEqual(r.status === 0, ok, `${lease}/${session}: ${r.stdout}${r.stderr}`)
    if (!ok) assert.match(r.stdout + r.stderr, /-MaxSessionMinutes must be at least -MaxLeaseMinutes/)
    if (session) assert.strictEqual(policy.problems({ ...policy.DEFAULTS, diskFolders: ['D:\\hv'], maxLeaseMinutes: lease, maxSessionMinutes: session }).length === 0, ok, `the helper agrees: ${lease}/${session}`)
  }
})
