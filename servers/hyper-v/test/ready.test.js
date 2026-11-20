// MC-1578: pool VMs from a ready-made Windows disk ({ vhdx, admin }) or one of the user's own VMs ({ vm, admin }),
// through helper.js against the stub Hyper-V:
// - the image: copied (or flattened from the VM) while hashed, the plan naming its source and SHA-256; the build's
//   recheck of the copy; the source VM only read (its record and disk unchanged, on success and on a failure);
// - the build: the copy started offline, the disk's admin account used once to make hvadmin and hvuser (accounts by
//   those names reset), each read back; the guest setup; the licence read; the verified logon undo (a disk's own
//   autologon and LSA password gone); the clean checkpoint; no unattended install, activation or first-logon wait;
// - the admin password, typed into approve.ps1: bound to one approval, used only by its job, never in a plan, the
//   journal, a status or a note, and deleted when the job ends, when its approval expires unused, and at start-up.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { T, scratch, startHelper, approve, waitFor } = require('./helpers')

const PASSWORD = 'Src-Pa55word-xyzzy'
const statusText = async c => (await c.request('status')).text
const jobLine = async c => (await statusText(c)).split('\n').find(l => l.startsWith('Last pool job')) || ''
const secretDir = sc => path.join(sc.stateDir, 'secrets', 'source-admin')
const secrets = sc => { try { return fs.readdirSync(secretDir(sc)) } catch { return [] } }
const vms = sc => Object.values(sc.stub().vms)

/** As approve.ps1 does for a ready-made disk: the approval, then the password the user typed, bound to it. */
function approveReady(sc, planId, { password = PASSWORD, over = {}, expires } = {}) {
  const a = approve(sc, planId)
  const plan = JSON.parse(fs.readFileSync(path.join(sc.stateDir, 'plans', `${planId}.json`), 'utf8'))
  fs.mkdirSync(secretDir(sc), { recursive: true })
  fs.writeFileSync(path.join(secretDir(sc), `${planId}.json`), JSON.stringify({ planId, digest: a.digest, imageSha256: plan.image.sha256, user: plan.image.admin, password, expires: expires || a.expires, ...over }))
  return a
}

/** A helper with a ready-made image verified from a .vhdx (or from what image says); resolves { sc, h, admin, file }. */
// The disk's guest by default: one administrator, Administrator, with PASSWORD; a non-evaluation edition (an evaluation
// disk's licence must still have its days left, as at any build).
async function withReadyImage(t, name, { stub = {}, timing = null, image } = {}) {
  const sc = scratch(name, { stub: { readyGuest: { accounts: { Administrator: { password: PASSWORD, admin: true, enabled: true } } }, guestEdition: 'Enterprise', ...stub }, timing })
  const h = await startHelper(sc)
  t.after(() => h.stop())
  const admin = h.conn(1)
  const file = path.join(sc.dir, 'user', 'win.vhdx')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'ready-made windows disk bytes')
  const first = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, image: image || { vhdx: file, admin: 'Administrator' } })
  assert.match(first.text, /Copying the disk into the helper's folder now, while hashing it/)
  await waitFor(async () => /Image: (ready|REFUSED)/.test(await statusText(admin)), T.waitForMs, 'the image check')
  return { sc, h, admin, file }
}

async function planAndBuild(sc, admin, { approveIt = approveReady, args = {} } = {}) {
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, ...args })
  assert.ok(plan.data?.planId, plan.text)
  approveIt(sc, plan.data.planId)
  await admin.request('pool_create', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: create (finished|FAILED)/.test(await statusText(admin)), T.waitForMs, 'the build')
  return { plan, line: await jobLine(admin) }
}

/** Nowhere a password may not be: the journal, every plan, the status and the job note. */
function assertNoPassword(sc, status, password = PASSWORD) {
  assert.ok(!fs.readFileSync(path.join(sc.stateDir, 'journal.jsonl'), 'utf8').includes(password), 'not in the journal')
  for (const f of fs.readdirSync(path.join(sc.stateDir, 'plans'))) assert.ok(!fs.readFileSync(path.join(sc.stateDir, 'plans', f), 'utf8').includes(password), `not in plan ${f}`)
  assert.ok(!status.includes(password), 'not in the status')
}

test('a ready-made disk: the plan names it, its SHA-256 and its admin; one VM built with no install, activation or first-logon wait', async t => {
  const { sc, admin, file } = await withReadyImage(t, 'ready-vhdx')
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const { plan, line } = await planAndBuild(sc, admin)
  assert.match(line, /create finished: .*ready-made disk: Enterprise build 26200; licence status 1; no first-logon wait/, line)
  assert.ok(plan.text.includes(`- image: ready-made Windows disk from ${file}, SHA-256 ${sha}, copied into the helper's folder; the build uses that copy, checked against this SHA-256 first`), plan.text)
  assert.match(plan.text, /- ready-made build: .*admin account Administrator is used once, to make the helper's own accounts hvadmin \(an administrator\) and hvuser \(a standard user; accounts by those names in the copy are reset to that\); its password is the one you type when you approve/)
  assert.doesNotMatch(plan.text, /- provisioning:|activation: each new VM goes online|product key:/)
  assert.match(plan.text, /- activation: none/)
  // The steps, in order, and as whom.
  const calls = sc.stub().calls.filter(c => c.vmId || c.op === 'create-vm')
  const ops = calls.map(c => c.op)
  for (const op of ['make-iso', 'guest-logon', 'guest-provisioned', 'guest-activate']) assert.ok(!ops.includes(op), `no ${op}`)
  const at = op => ops.indexOf(op)
  assert.ok(at('create-vm') < at('start-vm') && at('start-vm') < at('guest-accounts') && at('guest-accounts') < at('guest-setup') && at('guest-setup') < at('guest-licence') && at('guest-licence') < at('guest-logon-undo') && at('guest-logon-undo') < at('make-clean'), ops.join(' '))
  assert.deepStrictEqual([...new Set(calls.filter(c => c.op === 'guest-ready').map(c => c.as))], ['Administrator', 'hvadmin'], 'the disk\'s admin to begin with, then the helper\'s own')
  assert.strictEqual(calls.find(c => c.op === 'guest-accounts').as, 'Administrator')
  assert.ok(calls.filter(c => ['guest-setup', 'guest-licence', 'guest-logon-undo'].includes(c.op)).every(c => c.as === 'hvadmin'), 'every later step as hvadmin')
  const vm = vms(sc)[0]
  assert.strictEqual(vm.fromDisk, true)
  const cp = vm.checkpoints[0]
  assert.strictEqual(cp.accounts.hvadmin.admin, true); assert.strictEqual(cp.accounts.hvuser.admin, false)
  const ready = sc.journal().find(r => r.t === 'ready')
  assert.deepStrictEqual([ready.profiles, ready.guest], [null, { editionId: 'Enterprise', build: '26200' }])
  assert.deepStrictEqual(secrets(sc), [], 'the password is gone once the build ends')
  assertNoPassword(sc, await statusText(admin))
})

test('a disk with hvadmin and hvuser already in it (hvuser an administrator, both disabled), autologon on and an LSA password: made right, undone, verified', async t => {
  const readyGuest = { accounts: { Administrator: { password: PASSWORD, admin: true, enabled: true }, hvadmin: { password: 'old', admin: false, enabled: false }, hvuser: { password: 'old', admin: true, enabled: false, rmu: true } }, autologon: true, lsaSecret: true }
  const { sc, admin } = await withReadyImage(t, 'ready-collide', { stub: { readyGuest } })
  const { line } = await planAndBuild(sc, admin, {})
  assert.match(line, /create finished/, line)
  const cp = vms(sc)[0].checkpoints[0]
  assert.deepStrictEqual([cp.accounts.hvadmin.admin, cp.accounts.hvadmin.enabled, cp.accounts.hvuser.admin, cp.accounts.hvuser.rmu, cp.accounts.hvuser.enabled], [true, true, false, false, true])
  assert.deepStrictEqual([cp.autologon, cp.lsaSecret], [false, false], 'the disk\'s own autologon and LSA password are not in the clean state')
  assert.strictEqual(cp.accounts.Administrator.password, PASSWORD, 'the disk\'s other accounts are left as they were')
})

test('the disk\'s admin may itself be named hvuser: its copy is made the helper\'s standard user', async t => {
  const readyGuest = { accounts: { hvuser: { password: 'src-pw', admin: true, enabled: true } } }
  const { sc, admin } = await withReadyImage(t, 'ready-src-hvuser', { stub: { readyGuest }, image: undefined })
  // Planned again with the admin hvuser (the image is the same disk, recorded with Administrator: refused), so a fresh disk.
  const file2 = path.join(sc.dir, 'user', 'win2.vhdx'); fs.writeFileSync(file2, 'another ready-made disk')
  await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, image: { vhdx: file2, admin: 'hvuser' } })
  await waitFor(async () => /Image: ready: ready-made Windows disk from .*win2\.vhdx, 40 GB, admin account hvuser/.test(await statusText(admin)), T.waitForMs, 'the second image')
  const { line } = await planAndBuild(sc, admin, { approveIt: (sc, id) => approveReady(sc, id, { password: 'src-pw' }) })
  assert.match(line, /create finished/, line)
  const cp = vms(sc)[0].checkpoints[0]
  assert.deepStrictEqual([cp.accounts.hvuser.admin, cp.accounts.hvadmin.admin], [false, true])
})

test('a read-back that is wrong, an undo that doesn\'t verify, a wrong password, a generalized disk: each fails the build, rolled back, the password gone', async t => {
  for (const [name, stub, approveOver, why] of [
    ['ready-acct-bad', { accountsOverride: { user: { isAdmin: true } } }, {}, /the helper's accounts didn't verify: hvuser is still in Administrators/],
    ['ready-undo-bad', { undoOverride: { autoAdminLogon: '1' } }, {}, /undoing a build logon didn't verify: AutoAdminLogon is 1/],
    ['ready-wrong-pw', {}, { password: 'not-it' }, /its guest didn't answer as Administrator within \d+ min \(the disk must be an installed Windows that isn't generalized/],
    ['ready-generalized', { readyGuest: { generalized: true } }, {}, /its guest didn't answer as Administrator/]
  ]) {
    const { sc, admin } = await withReadyImage(t, name, { stub, timing: 'narrow' })
    const { line } = await planAndBuild(sc, admin, { approveIt: (sc, id) => approveReady(sc, id, approveOver) })
    assert.match(line, why, `${name}: ${line}`)
    assert.ok(!sc.stub().calls.some(c => c.op === 'make-clean'), `${name}: no checkpoint`)
    assert.ok(sc.journal().some(r => r.t === 'rolledBack'), `${name}: rolled back`)
    assert.deepStrictEqual(secrets(sc), [], `${name}: the password is gone`)
    assertNoPassword(sc, await statusText(admin), approveOver.password || PASSWORD)
  }
})

test('the password: none for this approval, or one bound to another plan, digest, disk or account, refuses the plan; nothing is built', async t => {
  const { sc, admin } = await withReadyImage(t, 'ready-binding')
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  const id = plan.data.planId
  approve(sc, id) // no password typed
  await assert.rejects(admin.request('pool_create', { planId: id }), new RegExp(`Plan ${id} needs the password of Administrator in its disk, and none was given for this approval: approve it again \\(approve\\.cmd asks for it\\)\\.`))
  for (const over of [{ digest: 'f'.repeat(64) }, { imageSha256: 'e'.repeat(64) }, { user: 'Other' }, { planId: 'p-0000000000000000' }]) {
    const p2 = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
    approveReady(sc, p2.data.planId, { over })
    await assert.rejects(admin.request('pool_create', { planId: p2.data.planId }), /needs the password of Administrator/, JSON.stringify(over))
  }
  assert.ok(!sc.stub().calls.some(c => c.op === 'create-vm'), 'nothing created')
})

test('an approval that expires unused: its password goes at the next plan or status; an unexpired one stays', async t => {
  const { sc, admin } = await withReadyImage(t, 'ready-expire')
  const p1 = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  approveReady(sc, p1.data.planId, { expires: new Date(Date.now() - 1000).toISOString() })
  const p2 = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  approveReady(sc, p2.data.planId)
  await statusText(admin)
  assert.deepStrictEqual(secrets(sc), [`${p2.data.planId}.json`], 'the expired one gone, the live one kept')
})

test('a helper stopped mid-build: at its next start the password is gone (and the VM rolled back)', async t => {
  const gate = 'ready-gate'
  const { sc, h, admin } = await withReadyImage(t, 'ready-interrupt')
  const gateFile = path.join(sc.dir, gate); const pidFile = path.join(sc.dir, 'ready.pid')
  sc.patchStub(s => { s.readyGate = gateFile; s.readyPidFile = pidFile })
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  approveReady(sc, plan.data.planId)
  await admin.request('pool_create', { planId: plan.data.planId })
  await waitFor(async () => fs.existsSync(pidFile), T.waitForMs, 'the build waiting on its guest')
  assert.deepStrictEqual(secrets(sc), [`${plan.data.planId}.json`], 'kept while its build runs')
  await h.stop()
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))) } catch { /* gone */ }
  sc.patchStub(s => { s.readyGate = null; s.readyPidFile = null })
  const h2 = await startHelper(sc)
  t.after(() => h2.stop())
  await statusText(h2.conn(1))
  assert.deepStrictEqual(secrets(sc), [], 'deleted at start-up')
  assertNoPassword(sc, await statusText(h2.conn(1)))
})

test('the disk copy changed after the plan was approved: refused at create, nothing created', async t => {
  const { sc, admin } = await withReadyImage(t, 'ready-tamper')
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  const img = sc.journal().find(r => r.t === 'image' && r.ready)
  fs.writeFileSync(img.file, 'changed bytes')
  approveReady(sc, plan.data.planId)
  await admin.request('pool_create', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: create (finished|FAILED)/.test(await statusText(admin)), T.waitForMs, 'the build')
  assert.match(await jobLine(admin), /the disk's copy has changed since it was checked and approved .*refused, nothing created/)
  assert.deepStrictEqual(vms(sc), [])
  assert.deepStrictEqual(secrets(sc), [])
})

test('activate is refused for a ready-made disk; a disk in the helper\'s own folder, a non-.vhdx or a missing file is refused', async t => {
  const { sc, admin } = await withReadyImage(t, 'ready-refusals')
  await assert.rejects(admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, activate: true }), /activate is for a Windows ISO install: a ready-made disk is used as it is/)
  const bad = async (image, re) => {
    const r = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, image }).catch(e => ({ text: e.message }))
    if (!re.test(r.text)) await waitFor(async () => re.test(await statusText(admin)), T.waitForMs, `refusal ${re}`)
  }
  await bad({ vhdx: path.join(sc.dir, 'nope.vhdx'), admin: 'Administrator' }, /image\.vhdx .* can't be read: no such file/)
  const txt = path.join(sc.dir, 'user', 'x.vhd'); fs.writeFileSync(txt, 'x')
  await bad({ vhdx: txt, admin: 'Administrator' }, /image\.vhdx must be a \.vhdx file/)
  await bad({ vhdx: path.join(sc.dir, 'user', 'win.vhdx'), admin: 'bad\\name' }, /image\.admin must name a local administrator account/)
  await bad({ vhdx: 'C:\\x.vhdx', vm: 'x', admin: 'A' }, /image is \{ vhdx, admin \} or \{ vm, admin \}, not both/)
})

test('one of the user\'s own VMs: its disk read into a copy, the VM itself unchanged, on success and on every refusal', async t => {
  const base = scratch('ready-vm-src').dir
  const srcDisk = path.join(base, 'mywin.avhdx'); fs.writeFileSync(srcDisk, 'my own vm disk with its checkpoint chain')
  const outsideVms = {
    'vm-own-1': { name: 'mywin', state: 'Off', generation: 2, disks: [srcDisk], checkpoints: ['cp-a'], memoryMB: 8192 },
    'vm-own-2': { name: 'running', state: 'Running', generation: 2, disks: [srcDisk], checkpoints: [] },
    'vm-own-3': { name: 'gen1', state: 'Off', generation: 1, disks: [srcDisk], checkpoints: [] },
    'vm-own-4': { name: 'twodisks', state: 'Off', generation: 2, disks: [srcDisk, srcDisk], checkpoints: [] }
  }
  const diskHash = () => crypto.createHash('sha256').update(fs.readFileSync(srcDisk)).digest('hex')
  const before = diskHash()
  const { sc, admin } = await withReadyImage(t, 'ready-vm', { stub: { outsideVms }, image: { vm: 'mywin', admin: 'Administrator' } })
  assert.match(await statusText(admin), /Image: ready: ready-made Windows disk from the VM mywin \(vm-own-1\), 40 GB, admin account Administrator/)
  const { plan, line } = await planAndBuild(sc, admin)
  assert.match(plan.text, /- image: ready-made Windows disk from your VM mywin \(id vm-own-1; its disk flattened into a copy; the VM itself is only read, never changed\), SHA-256 [0-9a-f]{64}/)
  assert.match(line, /create finished/, line)
  for (const [vm, re] of [['running', /running is Running: turn it off first/], ['gen1', /gen1 is a Generation 1 VM/], ['twodisks', /twodisks has 2 disks/], ['nosuch', /there's no VM named nosuch/]]) {
    await admin.request('pool_plan', { action: 'resize', vms: 2, cores: 2, memoryGB: 4, image: { vm, admin: 'Administrator' } }).catch(() => {})
    await waitFor(async () => re.test(await statusText(admin)), T.waitForMs, `${vm} refused`)
  }
  sc.patchStub(s => { s.convertFails = true })
  await admin.request('pool_plan', { action: 'resize', vms: 2, cores: 2, memoryGB: 4, image: { vm: 'mywin', admin: 'Other' } }).catch(() => {})
  await waitFor(async () => /Convert-VHD failed \(injected\)/.test(await statusText(admin)), T.waitForMs, 'a failed conversion')
  assert.deepStrictEqual(sc.stub().outsideVms, outsideVms, 'every outside VM exactly as it was')
  assert.strictEqual(diskHash(), before, 'its disk unchanged')
  // A pool VM is never a source.
  const poolVm = vms(sc)[0]
  await admin.request('pool_plan', { action: 'resize', vms: 2, cores: 2, memoryGB: 4, image: { vm: poolVm.id, admin: 'Administrator' } }).catch(() => {})
  await waitFor(async () => /is one of the pool's own VMs: name a VM of your own/.test(await statusText(admin)), T.waitForMs, 'a pool VM refused')
})

// MC-1578 round 1 (MR1's findings).
test('round 1: the disk\'s own size is the floor: recorded, in the plan, each VM grown to at least it; too big for the policy, or a smaller diskGB, refused; a base grown after approval refused at create', async t => {
  const { sc, admin } = await withReadyImage(t, 'ready-size', { stub: { readyDiskGB: 100 } })
  assert.match(await statusText(admin), /Image: ready: ready-made Windows disk from .*win\.vhdx, 100 GB, admin account Administrator/)
  await assert.rejects(admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, diskGB: 64 }), /The ready-made disk is 100 GB: diskGB must be at least that/)
  const { plan, line } = await planAndBuild(sc, admin)
  assert.match(plan.text, /each new VM is a copy of that disk \(100 GB; grown to the plan's disk size, never shrunk\)/)
  assert.match(line, /create finished/, line)
  assert.strictEqual(vms(sc)[0].diskGB, 100, 'the plan\'s size is the disk\'s, not the 64 GB default')
  // A base bigger than the policy allows (maxDiskGBPerVm 128): refused at the plan.
  const big = await withReadyImage(t, 'ready-size-big', { stub: { readyDiskGB: 512 } })
  await assert.rejects(big.admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 }), /outside the policy: .*a 512 GB disk is outside the policy's 64-128 GB.*the ready-made disk is 512 GB/)
  // Approved at 100 GB; the copy's size then reported larger: create refuses, nothing created.
  const late = await withReadyImage(t, 'ready-size-late', { stub: { readyDiskGB: 64 } })
  const p = await late.admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  approveReady(late.sc, p.data.planId)
  late.sc.patchStub(s => { s.readyDiskGB = 512 })
  await late.admin.request('pool_create', { planId: p.data.planId })
  await waitFor(async () => /Last pool job: create (finished|FAILED)/.test(await statusText(late.admin)), T.waitForMs, 'the build')
  assert.match(await jobLine(late.admin), /the ready-made disk is 512 GB, more than the plan's 64 GB: refused, nothing created/)
  assert.deepStrictEqual(vms(late.sc), [])
})

test('round 1: an evaluation part way through its period is taken as it is (no fresh-build minimum), its end recorded; one already over is refused', async t => {
  const end = new Date(Date.now() + 45 * 86_400_000).toISOString()
  const { sc, admin } = await withReadyImage(t, 'ready-eval', { stub: { guestEdition: 'EnterpriseEval', licence: { status: 1, graceMinutes: 45 * 24 * 60, evalEnd: end } } })
  const { line } = await planAndBuild(sc, admin)
  assert.match(line, /create finished/, line)
  const ready = sc.journal().find(r => r.t === 'ready')
  assert.strictEqual(ready.licence.kind, 'evaluation')
  assert.ok(Math.abs(Date.parse(ready.licence.expiresAt) - Date.parse(end)) < 86_400_000, ready.licence.expiresAt)
  assert.ok(!sc.stub().calls.some(c => c.op === 'guest-activate'), 'nothing activated')
  const over = await withReadyImage(t, 'ready-eval-over', { stub: { guestEdition: 'EnterpriseEval', licence: { status: 1, graceMinutes: 0, evalEnd: new Date(Date.now() - 86_400_000).toISOString() } } })
  const r = await planAndBuild(over.sc, over.admin)
  assert.match(r.line, /the evaluation's end date, .*, has already passed/, r.line)
})

test('round 1: the same disk with another admin (a typo corrected, another administrator): recorded anew for later plans, an older plan keeps its own', async t => {
  const readyGuest = { accounts: { Administrator: { password: PASSWORD, admin: true, enabled: true }, Other: { password: 'other-pw', admin: true, enabled: true } } }
  const { sc, admin, file } = await withReadyImage(t, 'ready-admin', { stub: { readyGuest }, image: undefined })
  const p1 = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, image: { vhdx: file, admin: 'Other' } })
  await waitFor(async () => /Image: ready: ready-made Windows disk from .*win\.vhdx, 40 GB, admin account Other/.test(await statusText(admin)), T.waitForMs, 'the same disk with Other')
  const plan1 = JSON.parse(fs.readFileSync(path.join(sc.stateDir, 'plans', `${p1.data.planId}.json`), 'utf8'))
  assert.strictEqual(plan1.image.admin, 'Administrator', 'the older plan keeps its own')
  approveReady(sc, p1.data.planId)
  await admin.request('pool_create', { planId: p1.data.planId })
  await waitFor(async () => /Last pool job: create (finished|FAILED)/.test(await statusText(admin)), T.waitForMs, 'the first build')
  assert.match(await jobLine(admin), /create finished/)
  const sha = plan1.image.sha256
  const p2 = await admin.request('pool_plan', { action: 'resize', vms: 2, image: sha })
  assert.match(p2.text, /admin account Other is used once/, p2.text)
  assert.match(p2.text, /It needs the user's approval: a ready-made disk or VM \(you type its admin password when you approve\)/, 'MC-1576: within the caps too')
  approveReady(sc, p2.data.planId, { password: 'other-pw' })
  await admin.request('pool_resize', { planId: p2.data.planId })
  await waitFor(async () => /Last pool job: resize (finished|FAILED)/.test(await statusText(admin)), T.waitForMs, 'the grow')
  assert.match(await jobLine(admin), /resize finished/)
  assert.deepStrictEqual(sc.stub().calls.filter(c => c.op === 'guest-accounts').map(c => c.as), ['Administrator', 'Other'])
  assert.deepStrictEqual(secrets(sc), [])
})

// MC-1582 with MC-1578: a persistent VM built from a ready-made disk is persistent like any other: the journal's ready
// record says so, a plain acquire skips it, and a named lease's state survives release (parked, never restored).
test('MC-1582: a persistent VM from a ready-made disk: journalled persistent, leased only by name, its state kept across leases', async t => {
  const { sc, h, admin } = await withReadyImage(t, 'ready-persistent')
  const { plan, line } = await planAndBuild(sc, admin, { args: { persistent: true } })
  assert.match(line, /create finished/, line)
  assert.match(plan.text, /- PERSISTENT \(MC-1582\): each VM this plan builds is never restored to clean/)
  const ready = sc.journal().find(r => r.t === 'ready')
  assert.strictEqual(ready.persistent, true)
  const vm = vms(sc)[0]
  const restoresOf = () => (sc.stub().restores || []).filter(r => r.vmId === vm.id).length
  await assert.rejects(h.conn(5).request('acquire', { minutes: 30 }), /No VM is free|none is free/)
  const c = h.conn(6)
  await c.request('acquire', { vm: vm.name, minutes: 30 })
  const r0 = restoresOf()
  assert.match((await c.request('start')).text, /from its disk as it was \(persistent: not restored/)
  await c.request('run', { command: 'write C:\research.txt kept' })
  assert.match((await c.request('release')).text, /parked \(persistent/)
  const d = h.conn(7)
  await d.request('acquire', { vm: vm.name, minutes: 30 })
  await d.request('start')
  assert.match((await d.request('run', { command: 'cat C:\research.txt' })).text, /kept/)
  assert.strictEqual(restoresOf(), r0, 'never restored')
})
