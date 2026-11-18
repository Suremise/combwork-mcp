// Several projects sharing the pool (MC-1502): a project is what the caller's roots say (the one project with a folder
// they're in; none or several is "other"); caps at every grant (no reserved VMs: dropped on MC-1502); vm_acquire's FIFO queue with bounded
// waits (HYPERV_MCP_WAIT_MS), a place kept between calls (HYPERV_MCP_KEEP_MS), grants only to a waiting request, a
// newer call superseding an older one, a disconnect leaving the line, and a freed VM (release, pool job) going to the
// first waiter allowed it; build folders scoped per project; setup's projects check. Through helper.js (the host
// protocol, several connections at once), in-process where one connection's requests overlap, and through server.js.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { T, scratch, startHelper, withPool, approve, waitFor } = require('./helpers')
const { server } = require('../client')
const { ps51Env } = require('../helper/hv')

const windows = process.platform === 'win32'
const Q = { HYPERV_MCP_WAIT_MS: '400', HYPERV_MCP_KEEP_MS: '60000' }

/** A pool of n VMs with this policy's projects, then a helper with the queue's test timings. */
async function pool(name, n, projects, env = Q) {
  const sc = scratch(name, { policy: { maxVms: Math.max(3, n), projects } })
  for (const d of ['cli', 'mcp', 'cli-builds', 'web']) fs.mkdirSync(path.join(sc.dir, d), { recursive: true })
  const { h } = await withPool(sc, n)
  await h.stop()
  const helper = await startHelper(sc, env)
  const dir = d => path.join(sc.dir, d)
  return { sc, h: helper, dir }
}
const acquire = (c, args) => c.request('acquire', { minutes: 30, ...args }).then(r => r, e => ({ error: e.message }))
const status = async c => (await c.request('status')).text

test('no projects: one shared pool, first come first served, as before', async () => {
  const { h, dir } = await pool('pr-none', 2, undefined)
  const [a, b, c] = [h.conn(1), h.conn(2), h.conn(3)]
  assert.match((await acquire(a, { roots: [dir('cli')] })).text, /^Leased hvmcp-\w+ \(lease l-\w+\) until/)
  assert.match((await acquire(b, { roots: [dir('mcp')] })).text, /^Leased /)
  const r = await acquire(c, {})
  assert.match(r.error, /^No VM is free \(2 in the pool\)\. The next lease ends by .* Try again later, or vm_acquire with wait: true to wait in line \(you'd be number 1\)\./)
  assert.doesNotMatch(await status(a), /Projects:/)
  await h.stop()
})

test('caps: cli 2 + mcp 1 on 3 VMs; cli at its cap is refused while mcp still gets its VM', async () => {
  const sc0 = scratch('pr-share-setup')
  const cli = path.join(sc0.dir, 'cli')
  const mcp = path.join(sc0.dir, 'mcp')
  const { h } = await pool('pr-share', 3, [{ name: 'cli', folders: [cli], maxVms: 2 }, { name: 'mcp', folders: [mcp], maxVms: 1 }])
  const [c1, c2, c3, m1, m2, o1] = [1, 2, 3, 4, 5, 6].map(i => h.conn(i))
  assert.match((await acquire(c1, { roots: [path.join(cli, 'worktree')] })).text, /^Leased .* for project cli /)
  assert.match((await acquire(c2, { roots: [cli] })).text, /for project cli/)
  assert.match((await acquire(c3, { roots: [cli] })).error, /^No VM for you now: project cli holds its windows cap of 2 \(3 in the pool\)/)
  assert.match((await acquire(m1, { roots: [mcp] })).text, /for project mcp/)
  assert.match((await acquire(m2, { roots: [mcp] })).error, /project mcp holds its windows cap of 1/)
  assert.match((await acquire(o1, { roots: [path.join(sc0.dir, 'web')] })).error, /^No VM is free \(3 in the pool\)/)
  assert.match(await status(c1), /Projects: cli holds 2 windows of its cap of 2; mcp holds 1 windows of its cap of 1; other holds 0\./)
  await h.stop()
})

test('the queue: first come first served; a VM freed by a release goes to the first active waiter', async () => {
  const { h } = await pool('pr-fifo', 1, undefined, { HYPERV_MCP_WAIT_MS: '5000', HYPERV_MCP_KEEP_MS: '60000' })
  const [a, b, c] = [h.conn(1), h.conn(2), h.conn(3)]
  await acquire(a, {})
  const pb = acquire(b, { wait: true })
  await waitFor(async () => /Waiting in line: 1\. other/.test(await status(a)), T.waitForMs, 'b in line')
  const pc = acquire(c, { wait: true })
  await waitFor(async () => /Waiting in line: 1\. other.*; 2\. other/.test(await status(a)), T.waitForMs, 'c in line')
  await a.request('release')
  assert.match((await pb).text, /^Leased /)
  const rc = await pc // c waits out its bound: still in line
  assert.match(rc.text, /^Still waiting for a VM \(none is free\): number 1 of 1 in line\. Call vm_acquire with wait: true again within 60 s to keep your place\./)
  await h.stop()
})

test('a waiter its project\'s cap blocks keeps its place; a later waiter of another project is served past it', async () => {
  const sc0 = scratch('pr-pass-setup')
  const cli = path.join(sc0.dir, 'cli')
  const { h } = await pool('pr-pass', 2, [{ name: 'cli', folders: [cli], maxVms: 1 }], { HYPERV_MCP_WAIT_MS: '5000', HYPERV_MCP_KEEP_MS: '60000' })
  const [c1, c2, o1, o2] = [h.conn(1), h.conn(2), h.conn(3), h.conn(4)]
  await acquire(c1, { roots: [cli] })
  await acquire(o1, {})
  const p2 = acquire(c2, { roots: [cli], wait: true })
  await waitFor(async () => /Waiting in line: 1\. cli/.test(await status(c1)), T.waitForMs, 'c2 in line')
  const po = acquire(o2, { wait: true })
  await waitFor(async () => /2\. other/.test(await status(c1)), T.waitForMs, 'o2 in line')
  await o1.request('release')
  assert.match((await po).text, /^Leased /, 'other was served past the capped cli waiter')
  const r2 = await p2
  assert.match(r2.text, /^Still waiting for a VM \(project cli holds its windows cap of 1\): number 1 of 1/, 'and cli kept its place')
  await h.stop()
})

test('an abandoned wait is never given a VM: it goes to a caller who is there, and the place expires', async () => {
  const { h } = await pool('pr-abandon', 1, undefined, { HYPERV_MCP_WAIT_MS: '300', HYPERV_MCP_KEEP_MS: '1500' })
  const [a, b, c] = [h.conn(1), h.conn(2), h.conn(3)]
  await acquire(a, {})
  assert.match((await acquire(b, { wait: true })).text, /^Still waiting/) // b's client stops calling
  await a.request('release')
  await waitFor(async () => /disk; free/.test(await status(a)), T.waitForMs, 'the VM free again')
  assert.match(await status(a), /Waiting in line: 1\. other, \d+ s \(between calls\)/, 'b kept its place but got nothing')
  assert.match((await acquire(c, {})).text, /^Leased /, 'the VM goes to a caller who is there')
  await waitFor(async () => !/Waiting in line/.test(await status(a)), T.waitForMs, 'b\'s place to expire')
  await h.stop()
})

test('a repeat call within the keep time keeps its place ahead of later waiters', async () => {
  // Each wait lasts 5 s: long enough that the release's restore (slow under a loaded test run) finishes while b and c
  // are both still waiting. A 300 ms wait could expire first and hand b "Still waiting" (MC-1528's review).
  const { h } = await pool('pr-keep', 1, undefined, { HYPERV_MCP_WAIT_MS: '5000', HYPERV_MCP_KEEP_MS: '60000' })
  const [a, b, c] = [h.conn(1), h.conn(2), h.conn(3)]
  await acquire(a, {})
  assert.match((await acquire(b, { wait: true })).text, /number 1 of 1/)
  assert.match((await acquire(c, { wait: true })).text, /number 2 of 2/)
  // Both call again: b is still first. Release only once both are waiting right then (not between calls).
  const pb = acquire(b, { wait: true })
  const pc = acquire(c, { wait: true })
  await waitFor(async () => { const st = await status(a); return /Waiting in line: 1\. other, \d+ s[^;]*; 2\. other, \d+ s/.test(st) && !/between calls/.test(st) }, T.waitForMs, 'b and c both waiting')
  await a.request('release')
  assert.match((await pb).text, /^Leased /)
  assert.match((await pc).text, /^Still waiting/)
  await h.stop()
})

test('a disconnect leaves the line, and a pool resize finishing serves the next waiter', async () => {
  const { sc, h } = await pool('pr-resize', 1, undefined, { HYPERV_MCP_WAIT_MS: '20000', HYPERV_MCP_KEEP_MS: '60000' })
  const [admin, a, b, c] = [h.conn(9), h.conn(1), h.conn(2), h.conn(3)]
  await acquire(a, {})
  void acquire(b, { wait: true })
  await waitFor(async () => /Waiting in line: 1\. other/.test(await status(admin)), T.waitForMs, 'b in line')
  const pc = acquire(c, { wait: true })
  await waitFor(async () => /2\. other/.test(await status(admin)), T.waitForMs, 'c in line')
  b.close()
  await waitFor(async () => !/2\. other/.test(await status(admin)), T.waitForMs, 'b gone from the line')
  // A second VM, by an approved resize: when its job ends, c (now first) gets it.
  const plan = await admin.request('pool_plan', { action: 'resize', vms: 2 })
  approve(sc, plan.data.planId)
  await admin.request('pool_resize', { planId: plan.data.planId })
  assert.match((await pc).text, /^Leased /)
  await h.stop()
})

test('a lease keeps the project it was granted for: the cap counts it whatever its caller\'s roots say later', async () => {
  const sc0 = scratch('pr-pin-setup')
  const cli = path.join(sc0.dir, 'cli')
  const { h } = await pool('pr-pin', 2, [{ name: 'cli', folders: [cli], maxVms: 1 }])
  const [c1, c2] = [h.conn(1), h.conn(2)]
  assert.match((await acquire(c1, { roots: [cli] })).text, /for project cli/)
  assert.strictEqual((await c1.request('whoami', { roots: [path.join(sc0.dir, 'elsewhere')] })).data.project, 'other')
  assert.match((await acquire(c2, { roots: [cli] })).error, /project cli holds its windows cap of 1/)
  await h.stop()
})

test('matching: a root under exactly one project\'s folder is that project; several, none or no roots are "other"', async () => {
  const sc0 = scratch('pr-match-setup')
  const [cli, mcp] = [path.join(sc0.dir, 'cli'), path.join(sc0.dir, 'mcp')]
  const { h } = await pool('pr-match', 1, [{ name: 'cli', folders: [cli, path.join(sc0.dir, 'cli-wt')] }, { name: 'mcp', folders: [mcp], buildRoots: [path.join(sc0.dir, 'mcp-builds')] }])
  const c = h.conn(1)
  const who = async roots => (await c.request('whoami', { roots })).data
  assert.strictEqual((await who([path.join(sc0.dir, 'cli-wt', 'slot-a')])).project, 'cli')
  assert.strictEqual((await who([cli.toUpperCase()])).project, 'cli', 'Windows paths: case does not count')
  assert.strictEqual((await who([cli, mcp])).project, 'other', 'roots spanning two projects')
  assert.strictEqual((await who([sc0.dir])).project, 'other', 'a root above a project is not in it')
  assert.strictEqual((await who([])).project, 'other')
  assert.strictEqual((await who(undefined)).project, 'other')
  const m = await who([mcp])
  assert.deepStrictEqual(m.projectBuildRoots, [path.join(sc0.dir, 'mcp-builds')])
  assert.deepStrictEqual((await who([cli])).projectBuildRoots, [])
  await h.stop()
})

test('one connection\'s overlapping vm_acquire calls (direct mode): the newer supersedes the older, which ends at once', async t => {
  const sc = scratch('pr-supersede', { policy: { maxVms: 3 } })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const saved = { ...process.env }
  Object.assign(process.env, { HYPERV_MCP_PS_STUB: sc.env.HYPERV_MCP_PS_STUB, HYPERV_MCP_STUB_STATE: sc.env.HYPERV_MCP_STUB_STATE, HYPERV_MCP_POLL_MS: '10', HYPERV_MCP_WAIT_MS: '5000', HYPERV_MCP_KEEP_MS: '60000' })
  delete require.cache[require.resolve('../helper/core')]
  const { Helper } = require('../helper/core')
  const { hv } = require('../helper/hv')
  const helper = new Helper({ stateDir: sc.stateDir, hv, checkApprovalAcl: false })
  await helper.init()
  t.after(() => { helper.close(); process.env = saved; delete require.cache[require.resolve('../helper/core')] })
  helper.connect('a', 1)
  helper.connect('b', 2)
  await helper.request('a', 'acquire', { minutes: 30 })
  const first = helper.request('b', 'acquire', { minutes: 30, wait: true }).then(r => ({ r }), e => ({ e }))
  await waitFor(() => helper.queue.length === 1 && helper.queue[0].pending, T.waitForMs, 'b waiting')
  const second = helper.request('b', 'acquire', { minutes: 30, wait: true })
  const f = await first
  assert.match(f.e?.message || '', /Superseded by a newer vm_acquire from this connection/)
  assert.strictEqual(helper.queue.length, 1, 'one entry per connection, its place kept')
  await helper.request('a', 'release')
  assert.match((await second).text, /^Leased /)
})

test('server.js: a project\'s own build folder is its alone; the global ones stay global; status names the project', async t => {
  const sc = scratch('pr-builds', { policy: { maxVms: 3 } })
  const projBuild = path.join(sc.dir, 'proj-builds')
  fs.mkdirSync(path.join(projBuild, 'app'), { recursive: true })
  fs.writeFileSync(path.join(projBuild, 'app', 'x.txt'), 'x')
  const mine = path.join(sc.dir, 'builds')
  const theirs = path.join(sc.dir, 'outside')
  const policyFile = path.join(sc.stateDir, 'policy.json')
  const pol = JSON.parse(fs.readFileSync(policyFile, 'utf8'))
  pol.projects = [{ name: 'proj', folders: [mine], buildRoots: [projBuild] }]
  fs.writeFileSync(policyFile, JSON.stringify(pol))
  const { h } = await withPool(sc, 2)
  await h.stop()
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home') }
  const inProj = server(env, { roots: [mine] })
  t.after(() => inProj.close())
  assert.match((await inProj.call('vm_status')).text, /Your project: proj\./)
  assert.match((await inProj.call('vm_acquire', { minutes: 30 })).text, /for project proj/)
  assert.match((await inProj.call('vm_start', { build: path.join(projBuild, 'app') })).text, /build copied in to C:\\build \(1 files/)
  await inProj.call('vm_release')
  await inProj.close()
  const outside = server(env, { roots: [theirs] })
  t.after(() => outside.close())
  assert.match((await outside.call('vm_status')).text, /Your project: other\./)
  await outside.call('vm_acquire', { minutes: 30 })
  assert.match((await outside.call('vm_start', { build: path.join(projBuild, 'app') })).text, /can't be used: it is not under an allowed folder/)
})

test('server.js: a newer helper still serves this server\'s features (protocol "at least", not "exactly")', async t => {
  const sc = scratch('pr-newer-helper', { policy: { maxVms: 3 } })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const shim = path.join(sc.dir, 'newer-core.js')
  fs.writeFileSync(shim, `const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') return { text: 'hyperv-mcp/9', data: { protocol: 'hyperv-mcp/9', features: ['projects', 'later'], buildRoots: [] } }
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  assert.match((await s.call('vm_status')).text, /newer than this server's hyperv-mcp\/3: everything here works/)
  await s.call('vm_acquire', { minutes: 30, wait: true })
  assert.match((await s.call('vm_start', { interactive: 'user' })).text, /hvuser logged on interactively/)
})

test('the projects feature: this helper still reports hyperv-mcp/3 (so hyper-v 1.2.0\'s exact check keeps working); a /3 helper without it refuses wait', async t => {
  const sc = scratch('pr-feature', { policy: { maxVms: 3 } })
  const { h } = await withPool(sc, 1)
  await h.stop()
  const helper = await startHelper(sc)
  const v = await helper.conn(1).request('version')
  assert.strictEqual(v.data.protocol, 'hyperv-mcp/3')
  assert.deepStrictEqual(v.data.features, ['projects', 'images', 'named', 'checkpoints', 'pool-checkpoints', 'refresh-clean', 'linux', 'debug-keep', 'timing'])
  await helper.stop()
  const shim = path.join(sc.dir, 'older-core.js')
  fs.writeFileSync(shim, `const m = require(${JSON.stringify(path.join(__dirname, '..', 'helper', 'core.js'))})
const request = m.Helper.prototype.request
m.Helper.prototype.request = async function (connId, op, args) {
  if (op === 'version') return { text: 'hyperv-mcp/3', data: { protocol: 'hyperv-mcp/3', buildRoots: [] } }
  return request.call(this, connId, op, args)
}
`)
  const env = { ...sc.env, HYPERV_MCP_ENABLED: '1', HYPERV_MCP_MODE: 'direct', USERPROFILE: path.join(sc.dir, 'home'), NODE_OPTIONS: `--require ${JSON.stringify(shim)}` }
  const s = server(env, { roots: [sc.builds] })
  t.after(() => s.close())
  assert.match((await s.call('vm_acquire', { minutes: 30, wait: true })).text, /The helper \(hyperv-mcp\/3\) has no 'projects' feature, which waiting in line \(wait: true\) needs: run setup again/)
  assert.match((await s.call('vm_acquire', { minutes: 30 })).text, /^Leased /, 'without wait, as before')
  assert.doesNotMatch((await s.call('vm_status')).text, /Your project:/)
})

test('setup\'s -ProjectsFile check uses the helper\'s own policy code, before anything changes', { skip: !windows }, () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup', 'install.ps1'), 'utf8')
  const block = /^\$projects = @\(\)\r?\n[\s\S]*?\r?\n(?=# The helper refuses a policy whose session cap)/m.exec(src)
  assert.ok(block, 'the projects block in install.ps1')
  const sc = scratch('setup-projects')
  const file = path.join(sc.dir, 'projects.ps1')
  // The block runs as setup runs it, before any change: the projects read, the pool's VM limit worked out, the whole
  // check, and the report formatted.
  fs.writeFileSync(file, `param([string]$ProjectsFile, [string]$state, [string]$src, [int]$MaxVms = 0)\n$ErrorActionPreference = 'Stop'\n${block[0]}\n"projects: $($projects.Count)"\n"line: $projectsLine"\n`)
  const run = (json, maxVms = 3) => {
    const pf = path.join(sc.dir, `p-${Math.random().toString(16).slice(2)}.json`)
    fs.writeFileSync(pf, json)
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-ProjectsFile', pf, '-state', sc.stateDir, '-src', path.join(__dirname, '..'), '-MaxVms', String(maxVms)], { encoding: 'utf8', env: ps51Env() })
  }
  const good = run(JSON.stringify([{ name: 'cli', folders: ['D:\\Dev\\cli'], maxVms: 2 }, { name: 'mcp', folders: ['D:\\Dev\\mcp'] }]))
  assert.strictEqual(good.status, 0, good.stdout + good.stderr)
  assert.match(good.stdout, /projects: 2/)
  assert.match(good.stdout, /line: cli \(cap 2\); mcp \(cap none\)/)
  // Caps per OS are formatted as they are, never cast to a number (that threw after the service had stopped).
  const perOs = run(JSON.stringify([{ name: 'cli', folders: ['D:\\Dev\\cli'], maxVms: { windows: 2, linux: 1 }, images: ['ab'.repeat(32)] }]))
  assert.strictEqual(perOs.status, 0, perOs.stdout + perOs.stderr)
  assert.match(perOs.stdout, /line: cli \(cap windows 2, linux 1, images 1\)/)
  // A file from before reserved VMs were dropped is refused here, before anything changes, saying why.
  const reserved = run(JSON.stringify([{ name: 'cli', folders: ['D:\\Dev\\cli'], reserveVms: { windows: 1 } }]), 1)
  assert.notStrictEqual(reserved.status, 0)
  assert.match((reserved.stdout + reserved.stderr).replace(/\s+/g, ' '), /The projects can't be used: project "cli": reserveVms isn't supported \(projects share the pool by their maxVms caps and the line\)\. Nothing was changed\./)
  const bad = run(JSON.stringify([{ name: 'cli', folders: ['D:\\Dev'], maxVms: -1 }, { name: 'cli', folders: ['D:\\Dev\\mcp'] }]))
  assert.notStrictEqual(bad.status, 0)
  const said = (bad.stdout + bad.stderr).replace(/\s+/g, ' ') // PowerShell wraps its error lines
  assert.match(said, /The projects can't be used: project "cli": maxVms must be a whole number 0-64, or one per OS .*; project "cli": the name is taken; project "cli": folder "D:\\Dev\\mcp" overlaps another of its folders .*Nothing was changed\./)
  const overlap = run(JSON.stringify([{ name: 'cli', folders: ['D:\\Dev'] }, { name: 'mcp', folders: ['D:\\Dev\\mcp'] }]))
  assert.match((overlap.stdout + overlap.stderr).replace(/\s+/g, ' '), /project "mcp": folder "D:\\Dev\\mcp" overlaps project "cli"'s \(one root must belong to one project\)/)
  const notJson = run('{ nope')
  assert.match(notJson.stdout + notJson.stderr, /can't be read as JSON/)
})

test('the policy\'s projects: names, caps per OS, image lists, overlaps; reserved VMs refused', () => {
  const policy = require('../helper/policy')
  const D = (...p) => ['D:', ...p].join(path.win32.sep) // Windows paths, without escaping
  const base = { ...policy.DEFAULTS, diskFolders: [D('hv')], maxVms: 3 }
  const ok = { ...base, projects: [{ name: 'cli', folders: [D('Dev', 'cli'), D('Dev', 'cli-wt')], maxVms: 2 }, { name: 'mcp', folders: [D('Dev', 'mcp')], maxVms: { windows: 1, linux: 0 }, images: ['ab'.repeat(32)], buildRoots: [D('b')] }] }
  assert.deepStrictEqual(policy.problems(ok), [])
  const why = p => policy.problems({ ...base, projects: p }).join('\n')
  assert.match(why([{ name: 'a', folders: [D('a')], reserveVms: 1 }]), /project "a": reserveVms isn't supported/)
  assert.match(why([{ name: 'a', folders: [D('a')], maxVms: -1 }]), /maxVms must be a whole number 0-64, or one per OS/)
  assert.match(why([{ name: 'a', folders: [D('a')], maxVms: { mac: 1 } }]), /maxVms must be a whole number 0-64, or one per OS \(windows, linux\)/)
  assert.match(why([{ name: 'a', folders: [D('a')], images: ['abc'] }]), /images must be a list of at most 16 image SHA-256s/)
  assert.match(why([{ name: 'other', folders: [D('a')] }]), /the name is taken \("other" is everyone outside the projects\)/)
  assert.match(why([{ name: 'A b', folders: [D('a')] }]), /name must be 1-32 lower-case letters/)
  assert.match(why([{ name: 'a', folders: [] }]), /folders must list 1-16 folders/)
  assert.match(why([{ name: 'a', folders: [D('')] }]), /must be an absolute local folder/)
  assert.match(why([{ name: 'a', folders: [D('x')] }, { name: 'b', folders: ['d:' + path.win32.sep + 'X' + path.win32.sep + 'y'] }]), /project "b": folder ".*" overlaps project "a"'s/)
  assert.match(why([{ name: 'a', folders: [D('x')], extra: 1 }]), /unknown field "extra"/)
  assert.match(why('nope'), /projects must be a list/)
  const loaded = policy.problems({ ...base }) // no projects: none needed
  assert.deepStrictEqual(loaded, [])
})
