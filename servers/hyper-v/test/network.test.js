// MC-1556: a run's network modes (none, host, internet, internet-lan), against the stub Hyper-V and guest:
// - the pure rules (helper/net.js): modes and caps, the old booleans, each mode's port ACLs and their read-back, the
//   host-mode checks (switch, address, clashes), the guest's read-back (NIC, address, routes, DHCP, DNS, lookup), the
//   subnet rules setup uses, the Linux scripts; the policy's ceiling and its legacy mapping;
// - plans: the mode in every create and resize plan (default none), refused above the policy or without setup's host
//   network, a resize changing only the network, the mode journalled when the approved plan runs;
// - runs: each mode's switch, ACLs and guest network; refused above the pool's mode, also on a reset after the pool's
//   mode was lowered; fail-closed when the ACLs don't read back, when host mode's checks fail and when the guest's
//   network never settles; a guest whose address wobbles once settles; stop restores disconnected with no ACLs;
// - crashes after the ACLs, after the connect, and mid-start: the next helper restores every VM to its clean baseline;
// - throughout, the stub's invariant: no VM ever Running on a switch without its mode's exact ACL set.
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const net = require('../helper/net')
const policy = require('../helper/policy')
const { T, scratch, startHelper, withPool, approve, waitFor, seedImage, HOST_NETWORK } = require('./helpers')

const only = sc => Object.values(sc.stub().vms)[0]
const noViolations = sc => assert.deepStrictEqual(sc.stub().violations || [], [], 'never Running on a switch without its exact ACLs')
const keys = list => net.aclKeys(list)

async function resize(sc, admin, args) {
  const plan = await admin.request('pool_plan', { action: 'resize', ...args })
  assert.ok(plan.data?.planId, plan.text)
  approve(sc, plan.data.planId)
  await admin.request('pool_resize', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: resize finished/.test((await admin.request('status')).text), T.waitForMs, 'the resize job')
  return plan
}

// ---------- the pure rules ----------

test('modes: ordered, the old booleans mapped, anything else refused; caps compare by order', () => {
  assert.deepStrictEqual(net.MODES, ['none', 'host', 'internet', 'internet-lan'])
  assert.strictEqual(net.modeOf(undefined), 'none')
  assert.strictEqual(net.modeOf(undefined, 'internet'), 'internet')
  assert.strictEqual(net.modeOf(true), 'host')
  assert.strictEqual(net.modeOf(false), 'none')
  assert.strictEqual(net.modeOf('internet-lan'), 'internet-lan')
  assert.throws(() => net.modeOf('lan'), /network must be one of none, host, internet, internet-lan/)
  assert.throws(() => net.modeOf(1), /network must be one of/)
  assert.strictEqual(net.above('host', 'internet', 'the pool'), null)
  assert.match(net.above('internet-lan', 'internet', 'the pool'), /network internet-lan is above the pool's internet/)
  for (const m of net.MODES) assert.ok(net.DESCRIBE[m], `${m} is described`)
})

test('ACLs: each mode\'s exact set (IPv6 always denied), read back exactly or named', () => {
  assert.deepStrictEqual(net.aclsFor('none'), [])
  assert.deepStrictEqual(keys(net.aclsFor('host', { hostAddress: '10.137.42.1' })), keys([
    { action: 'Allow', remote: '10.137.42.1/32' }, { action: 'Deny', remote: '0.0.0.0/0' }, { action: 'Deny', remote: '::/0' }]))
  const inet = net.aclsFor('internet', { gateway: '172.20.16.1' })
  for (const r of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10']) assert.ok(inet.some(e => e.action === 'Deny' && e.remote === r), `internet denies ${r}`)
  assert.ok(inet.some(e => e.action === 'Allow' && e.remote === '172.20.16.1/32'), 'the gateway allowed, for DHCP and DNS')
  assert.deepStrictEqual(net.aclsFor('internet-lan', { gateway: '172.20.16.1' }), [{ action: 'Deny', remote: '::/0' }])
  for (const m of ['host', 'internet', 'internet-lan']) assert.ok(net.aclsFor(m, { hostAddress: '10.137.42.1', gateway: '172.20.16.1' }).some(e => e.action === 'Deny' && e.remote === '::/0'), `${m} denies all IPv6`)
  // Read-back: Hyper-V lists each direction; a host address may come back without its /32; '::' for ::/0.
  const want = net.aclsFor('host', { hostAddress: '10.137.42.1' })
  const back = [
    ...['Inbound', 'Outbound'].map(direction => ({ action: 'Allow', direction, remote: '10.137.42.1' })),
    ...['Inbound', 'Outbound'].map(direction => ({ action: 'Deny', direction, remote: '0.0.0.0/0' })),
    ...['Inbound', 'Outbound'].map(direction => ({ action: 'Deny', direction, remote: '::' }))]
  assert.strictEqual(net.aclProblem(back, want), null)
  assert.match(net.aclProblem(back.slice(0, 5), want), /missing Deny\|Outbound\|::\/0/)
  assert.match(net.aclProblem([...back, { action: 'Allow', direction: 'Inbound', remote: '192.168.1.0/24' }], want), /extra Allow\|Inbound\|192\.168\.1\.0\/24/)
  assert.match(net.aclProblem([], want), /missing/)
})

test('host mode\'s checks: setup\'s switch by id, internal, exactly the host address, no clash with another interface or route', () => {
  const h = HOST_NETWORK
  const good = { switch: { id: h.switchId, name: h.switchName, type: 'Internal' }, hostAddrs: [{ ip: '10.137.42.1', prefix: 24 }], others: [{ alias: 'Ethernet', ip: '192.168.1.20', prefix: 24 }], routes: [{ alias: 'Ethernet', prefix: '0.0.0.0/0' }, { alias: 'Ethernet', prefix: '192.168.1.0/24' }] }
  assert.strictEqual(net.hostProblem(good, h), null)
  assert.match(net.hostProblem({ ...good, switch: null }, h), /switch hvmcp-host .* is missing: rerun setup/)
  assert.match(net.hostProblem({ ...good, switch: { ...good.switch, name: 'other' } }, h), /renamed or isn't internal/)
  assert.match(net.hostProblem({ ...good, switch: { ...good.switch, type: 'External' } }, h), /renamed or isn't internal/)
  assert.match(net.hostProblem({ ...good, hostAddrs: [] }, h), /isn't exactly 10\.137\.42\.1\/24 \(it has none\)/)
  assert.match(net.hostProblem({ ...good, hostAddrs: [{ ip: '10.137.42.1', prefix: 24 }, { ip: '10.137.42.2', prefix: 24 }] }, h), /isn't exactly/)
  assert.match(net.hostProblem({ ...good, others: [{ alias: 'VPN', ip: '10.137.0.5', prefix: 16 }] }, h), /VPN has 10\.137\.0\.5\/16, which overlaps the host subnet/)
  assert.match(net.hostProblem({ ...good, routes: [{ alias: 'VPN', prefix: '10.0.0.0/8' }] }, h), /a route to 10\.0\.0\.0\/8 on VPN overlaps/)
  assert.strictEqual(net.hostProblem({ ...good, routes: [{ alias: 'Ethernet', prefix: '0.0.0.0/0' }] }, h), null, 'a default route is no clash')
})

test('the host subnet setup takes: a /24 in 10/8 or 192.168/16, never the Default Switch\'s 172.16/12; addresses .1 and .10 up', () => {
  assert.strictEqual(net.subnetProblem('10.137.42.0/24'), null)
  assert.strictEqual(net.subnetProblem('192.168.250.0/24'), null)
  assert.match(net.subnetProblem('172.20.1.0/24'), /172\.16\.0\.0\/12/)
  assert.match(net.subnetProblem('10.137.42.0/25'), /a\.b\.c\.0\/24/)
  assert.match(net.subnetProblem('10.137.42.7/24'), /a\.b\.c\.0\/24/)
  assert.match(net.subnetProblem('8.8.8.0/24'), /10\.0\.0\.0\/8 or 192\.168/)
  assert.strictEqual(net.hostAddressOf('10.137.42.0/24'), '10.137.42.1')
  assert.strictEqual(net.allocate('10.137.42.0/24', []), '10.137.42.10')
  assert.strictEqual(net.allocate('10.137.42.0/24', ['10.137.42.10', '10.137.42.11']), '10.137.42.12')
  assert.strictEqual(net.clashProblem('10.137.42.0/24', [{ alias: 'Wi-Fi', ip: '10.137.42.99', prefix: 24 }], []) !== null, true)
  assert.strictEqual(net.clashProblem('10.137.42.0/24', [{ alias: 'Wi-Fi', ip: '192.168.1.5', prefix: 24 }], [{ alias: 'Wi-Fi', prefix: '0.0.0.0/0' }]), null)
})

test('the guest\'s read-back: the VM\'s own NIC, exactly its address and no gateway (host); a DHCP lease, route, DNS and lookup (internet)', () => {
  const mac = '00155DAABBCC'
  const host = { mode: 'host', mac, address: '10.137.42.10', subnet: '10.137.42.0/24' }
  const hostOk = { nics: [{ name: 'eth0', mac: '00:15:5d:aa:bb:cc', ipv4: [{ ip: '10.137.42.10', prefix: 24 }] }], routes: [{ dest: '10.137.42.0/24' }, { dest: '10.137.42.10/32' }, { dest: '224.0.0.0/4' }], dns: [], lookup: null }
  assert.strictEqual(net.guestProblem(hostOk, host), null)
  assert.match(net.guestProblem({ ...hostOk, nics: [{ ...hostOk.nics[0], mac: '00155D000000' }] }, host), /no network adapter with the VM's MAC/)
  assert.match(net.guestProblem({ ...hostOk, nics: [{ ...hostOk.nics[0], ipv4: [{ ip: '169.254.3.4', prefix: 16 }] }] }, host), /not exactly 10\.137\.42\.10\/24/)
  assert.match(net.guestProblem({ ...hostOk, routes: [...hostOk.routes, { dest: '0.0.0.0/0', gateway: '10.137.42.1' }] }, host), /a default route/)
  assert.match(net.guestProblem({ ...hostOk, routes: [...hostOk.routes, { dest: '::/0', gateway: 'fe80::1' }] }, host), /a default route/)
  assert.match(net.guestProblem({ ...hostOk, routes: [...hostOk.routes, { dest: '192.168.1.0/24' }] }, host), /a route beyond the host subnet/)
  assert.match(net.guestProblem({ ...hostOk, nics: [...hostOk.nics, { name: 'eth1', mac: '00155D111111', ipv4: [{ ip: '192.168.1.9', prefix: 24 }] }] }, host), /another interface has an address/)
  const inet = { mode: 'internet', mac, subnet: '172.20.16.0/20', gateway: '172.20.16.1' }
  const inetOk = { nics: [{ name: 'Ethernet', mac, ipv4: [{ ip: '172.20.16.77', prefix: 20 }] }], routes: [{ dest: '0.0.0.0/0', gateway: '172.20.16.1' }], dns: ['172.20.16.1'], lookup: true }
  assert.strictEqual(net.guestProblem(inetOk, inet), null)
  assert.match(net.guestProblem({ ...inetOk, nics: [{ ...inetOk.nics[0], ipv4: [{ ip: '169.254.9.9', prefix: 16 }] }] }, inet), /no DHCP address from the Default Switch/)
  assert.match(net.guestProblem({ ...inetOk, routes: [] }, inet), /no default route via the Default Switch/)
  assert.match(net.guestProblem({ ...inetOk, dns: [] }, inet), /no DNS server/)
  assert.match(net.guestProblem({ ...inetOk, lookup: false }, inet), /DNS lookup of dns\.msftncsi\.com didn't answer/)
  assert.match(net.guestProblem(null, inet), /couldn't be read/)
})

test('the Linux scripts: fixed text with only the VM\'s MAC and the helper\'s address; anything else refused', () => {
  const host = net.linuxSetScript('host', { mac: '00155DAABBCC', address: '10.137.42.10' })
  assert.match(host, /^# hvmcp-net set/)
  assert.match(host, /MAC=00:15:5d:aa:bb:cc/)
  assert.match(host, /Address=%s\/24\\nDHCP=no\\nLinkLocalAddressing=no\\nIPv6AcceptRA=no/)
  assert.match(host, /ip addr add 10\.137\.42\.10\/24 dev "\$NIC"/)
  assert.match(host, /NetworkManager is running/)
  const inet = net.linuxSetScript('internet', { mac: '00155DAABBCC' })
  assert.match(inet, /DHCP=ipv4/)
  assert.match(inet, /no DHCP client in this image/)
  assert.throws(() => net.linuxSetScript('host', { mac: '00155DAABBCC', address: '10.0.0.1; reboot' }), /unsafe value/)
  assert.match(net.linuxReadScript({ lookup: true }), /python3 - 1/)
  assert.deepStrictEqual(net.parseRead('noise\nHVNET:{"nics":[]}\n'), { nics: [] })
  assert.strictEqual(net.parseRead('nothing'), null)
})

test('the policy: maxNetwork is the ceiling (a missing one is none); an older allowNetwork maps (true host, false none); host needs setup\'s host network', () => {
  const base = { ...policy.DEFAULTS, diskFolders: ['D:\\hv'] }
  assert.deepStrictEqual(policy.problems(base), [])
  assert.strictEqual(policy.DEFAULTS.maxNetwork, 'none', 'a fresh policy is none')
  assert.match(policy.problems({ ...base, maxNetwork: 'lan' }).join(), /maxNetwork must be one of/)
  const legacy = { ...base }
  delete legacy.maxNetwork
  assert.match(policy.problems(legacy).join(), /maxNetwork must be set/)
  assert.deepStrictEqual(policy.problems({ ...legacy, allowNetwork: true }), [])
  assert.match(policy.problems({ ...base, hostNetwork: { ...HOST_NETWORK, hostAddress: '10.137.42.2' } }).join(), /hostAddress must be 10\.137\.42\.1/)
  assert.match(policy.problems({ ...base, hostNetwork: { ...HOST_NETWORK, subnet: '172.20.0.0/24', hostAddress: '172.20.0.1' } }).join(), /172\.16\.0\.0\/12/)
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hvmcp-pol-'))
  try {
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ ...legacy, allowNetwork: true }))
    assert.strictEqual(policy.load(dir).maxNetwork, 'host')
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ ...legacy, allowNetwork: false }))
    assert.strictEqual(policy.load(dir).maxNetwork, 'none')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  const vm = { cores: 2, memoryMB: 4096, diskGB: 64, folder: 'D:\\hv\\pool\\i-1' }
  const p = { ...base, maxNetwork: 'internet', hostNetwork: HOST_NETWORK }
  assert.deepStrictEqual(policy.checkPool(p, [vm], { network: 'internet' }), [])
  assert.match(policy.checkPool(p, [vm], { network: 'internet-lan' }).join(), /above the policy's internet \(rerun setup with -MaxNetwork/)
  assert.match(policy.checkPool({ ...p, hostNetwork: null }, [vm], { network: 'host' }).join(), /host mode needs setup's host network/)
})

// ---------- plans ----------

test('plans: the mode in every create and resize (default none), refused above the policy; a resize may change only the network; the job journals it', async t => {
  const sc = scratch('net-plans', { policy: { maxNetwork: 'internet' } })
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  t.after(() => h.stop())
  const admin = h.conn(1)
  await assert.rejects(admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, network: 'internet-lan' }), /network internet-lan is above the policy's internet/)
  await assert.rejects(admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, network: 'wifi' }), /network must be one of/)
  const plan = await admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4 })
  assert.match(plan.text, /- network: none: no network: the VM's adapter is disconnected\./)
  approve(sc, plan.data.planId)
  await admin.request('pool_create', { planId: plan.data.planId })
  await waitFor(async () => /Last pool job: create finished/.test((await admin.request('status')).text), T.waitForMs, 'the create job')
  assert.ok(!sc.journal().some(r => r.t === 'pool-network'), 'none needs no record')
  assert.match((await admin.request('status')).text, /network none \(approved in a plan/)
  await assert.rejects(admin.request('pool_plan', { action: 'resize' }), /nothing to change/)
  const r = await resize(sc, admin, { network: 'host' })
  assert.match(r.text, /- keep hvmcp-[0-9a-f]{8}: 2 cores, 4096 MB static memory, 64 GB disk \(unchanged\)/)
  assert.match(r.text, /- network: host \(was none\): host only: the VM reaches only this PC/)
  assert.deepStrictEqual(sc.journal().filter(x => x.t === 'pool-network').map(x => x.mode), ['host'])
  assert.match((await admin.request('status')).text, /network host \(approved in a plan/)
  const again = await admin.request('pool_plan', { action: 'resize', vms: 1, network: 'host' }).catch(e => e)
  assert.match(String(again.message || again.text), /nothing to change/)
})

test('a host plan needs setup\'s host network; an internet plan needs the Default Switch', async t => {
  const sc = scratch('net-plan-host', { policy: { hostNetwork: undefined }, stub: { noDefaultSwitch: true } })
  let h = await startHelper(sc)
  await h.stop()
  seedImage(sc)
  h = await startHelper(sc)
  t.after(() => h.stop())
  const admin = h.conn(1)
  await assert.rejects(admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, network: 'host' }), /host mode needs setup's host network/)
  await assert.rejects(admin.request('pool_plan', { action: 'create', vms: 1, cores: 2, memoryGB: 4, network: 'internet' }), /no Default Switch, so the network mode internet can't be used here/)
})

test('an approved plan is rechecked against the policy as it is now: a network-only resize and an add, approved before setup lowered the cap, are refused, nothing changed', async t => {
  const sc = scratch('net-apply-lowered')
  let { h, admin } = await withPool(sc, 1)
  const netOnly = (await admin.request('pool_plan', { action: 'resize', network: 'internet-lan' })).data.planId
  const grow = (await admin.request('pool_plan', { action: 'resize', vms: 2, cores: 2, memoryGB: 4, network: 'host' })).data.planId
  approve(sc, netOnly)
  approve(sc, grow)
  await h.stop()
  const jobs = sc.journal().filter(r => r.t === 'job').length
  const file = path.join(sc.stateDir, 'policy.json')
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), maxNetwork: 'none' }))
  h = await startHelper(sc)
  t.after(() => h.stop())
  admin = h.conn(1)
  await assert.rejects(admin.request('pool_resize', { planId: netOnly }), /outside the policy now: network internet-lan is above the policy's none .*Nothing was changed/)
  await assert.rejects(admin.request('pool_resize', { planId: grow }), /outside the policy now: network host is above the policy's none/)
  assert.ok(!sc.journal().some(r => r.t === 'pool-network'), 'no mode recorded')
  assert.strictEqual(sc.journal().filter(r => r.t === 'job').length, jobs, 'no job started')
  assert.strictEqual(Object.keys(sc.stub().vms).length, 1)
  assert.match((await admin.request('status')).text, /network none \(approved in a plan/)
})

// ---------- runs ----------

test('runs: host mode (setup\'s switch, exact ACLs, the guest\'s static address), internet and internet-lan (Default Switch, DHCP); stop restores disconnected with no ACLs', async t => {
  const sc = scratch('net-runs')
  const { h, admin } = await withPool(sc, 1, { network: 'internet-lan' })
  t.after(() => h.stop())
  const a = h.conn(10)
  await a.request('acquire')
  const host = await a.request('start', { network: 'host' })
  assert.match(host.text, /network host \(10\.137\.42\.10 on hvmcp-host; this PC is 10\.137\.42\.1, its firewall decides which ports\)/)
  assert.strictEqual(host.data.address, '10.137.42.10')
  let vm = only(sc)
  assert.strictEqual(vm.switchName, 'hvmcp-host')
  assert.deepStrictEqual(keys(vm.acls), keys(net.aclsFor('host', { hostAddress: '10.137.42.1' })))
  assert.deepStrictEqual(vm.guestNet, { mode: 'host', address: '10.137.42.10' })
  const order = sc.stub().calls.map(c => c.op).filter(op => ['restore', 'net-host', 'net-prepare', 'configure-start', 'guest-ready', 'guest-net', 'guest-net-read'].includes(op))
  const last = order.lastIndexOf('restore')
  assert.deepStrictEqual(order.slice(last, last + 5), ['restore', 'net-host', 'net-prepare', 'configure-start', 'guest-ready'], 'ACLs before the connect, the connect before the start')
  await a.request('stop')
  vm = only(sc)
  assert.strictEqual(vm.switchName, null)
  assert.deepStrictEqual(vm.acls, [])

  const inet = await a.request('start', { network: 'internet' })
  assert.match(inet.text, /network internet \(DHCP from Windows' Default Switch; the LAN is blocked\)/)
  vm = only(sc)
  assert.strictEqual(vm.switchName, 'Default Switch')
  assert.deepStrictEqual(keys(vm.acls), keys(net.aclsFor('internet', { gateway: '172.20.16.1' })))
  assert.ok(sc.stub().calls.some(c => c.op === 'guest-net-read'), 'read back')

  const lan = await a.request('start', { network: 'internet-lan' })
  assert.match(lan.text, /network internet-lan \(DHCP from Windows' Default Switch\)/)
  assert.deepStrictEqual(keys(only(sc).acls), keys([{ action: 'Deny', remote: '::/0' }]))
  const off = await a.request('start', {})
  assert.match(off.text, /network off/)
  assert.strictEqual(only(sc).switchName, null)
  assert.deepStrictEqual(only(sc).acls, [])
  await a.request('release')
  assert.deepStrictEqual(only(sc).acls, [])
  noViolations(sc)
  void admin
})

test('a run above the pool\'s mode is refused before anything changes; lowering the pool\'s mode is checked at the next reset', async t => {
  const sc = scratch('net-caps')
  const { h, admin } = await withPool(sc, 1, { network: 'internet' })
  t.after(() => h.stop())
  const a = h.conn(10)
  await a.request('acquire')
  const restores = () => sc.stub().calls.filter(c => c.op === 'restore').length
  const before = restores()
  await assert.rejects(a.request('start', { network: 'internet-lan' }), /Network internet-lan is above the pool's internet/)
  assert.strictEqual(restores(), before, 'refused before the restore')
  await a.request('start', { network: 'internet' })
  await resize(sc, admin, { network: 'none' })
  assert.strictEqual(only(sc).switchName, 'Default Switch', 'a running lease keeps its mode until its next start')
  await assert.rejects(a.request('start', { network: 'internet' }), /above the pool's none/)
  await a.request('start', { network: 'none' })
  assert.strictEqual(only(sc).switchName, null)
  noViolations(sc)
})

test('fail-closed: ACLs that don\'t read back exactly leave the VM disconnected and Off; nothing runs', async t => {
  const sc = scratch('net-acl-fail')
  const { h } = await withPool(sc, 1, { network: 'host' })
  t.after(() => h.stop())
  const a = h.conn(10)
  await a.request('acquire')
  sc.patchStub(s => { s.aclsDrop = 1 })
  await assert.rejects(a.request('start', { network: 'host' }), /network couldn't be prepared: its port ACLs aren't the mode's exact set \(missing .*\)\. It was left disconnected; nothing was started/)
  const vm = only(sc)
  assert.strictEqual(vm.state, 'Off')
  assert.strictEqual(vm.switchName, null)
  assert.ok(!sc.stub().calls.some(c => c.op === 'configure-start' && c.vmId === vm.id && sc.stub().calls.indexOf(c) > sc.stub().calls.findLastIndex(x => x.op === 'net-prepare')), 'never connected')
  sc.patchStub(s => { delete s.aclsDrop })
  await a.request('start', { network: 'host' })
  noViolations(sc)
})

test('host mode\'s checks fail closed: a clashing interface, a missing switch, a lost host address', async t => {
  const sc = scratch('net-host-fail')
  const { h } = await withPool(sc, 1, { network: 'host' })
  t.after(() => h.stop())
  const a = h.conn(10)
  await a.request('acquire')
  sc.patchStub(s => { s.hostClash = { alias: 'VPN', ip: '10.137.42.200', prefix: 24 } })
  await assert.rejects(a.request('start', { network: 'host' }), /Host mode can't be used now: VPN has 10\.137\.42\.200\/24, which overlaps the host subnet.*Nothing was started/)
  assert.strictEqual(only(sc).state, 'Off')
  sc.patchStub(s => { delete s.hostClash; s.hostRead = { hostAddrs: [] } })
  await assert.rejects(a.request('start', { network: 'host' }), /isn't exactly 10\.137\.42\.1\/24 \(it has none\): rerun setup/)
  sc.patchStub(s => { delete s.hostRead; delete s.switches['hvmcp-host'] })
  await assert.rejects(a.request('start', { network: 'host' }), /switch hvmcp-host .* is missing: rerun setup/)
  assert.strictEqual(only(sc).switchName, null)
  noViolations(sc)
})

test('the guest\'s network: a wobble settles; one that never settles restores the VM to clean and fails the start', async t => {
  const sc = scratch('net-guest', { timing: ['HYPERV_MCP_NET_WAIT_MS'] }) // the never-settling case runs its wait out
  const { h } = await withPool(sc, 1, { network: 'internet' })
  t.after(() => h.stop())
  const a = h.conn(10)
  await a.request('acquire')
  sc.patchStub(s => { s.netUnsteady = 1 })
  await a.request('start', { network: 'host' })
  assert.strictEqual(sc.stub().netUnsteady, 0, 'the wobble was seen, and the read went on until it held')
  sc.patchStub(s => { s.netNeverReady = true })
  await assert.rejects(a.request('start', { network: 'internet' }), /started, but its network \(internet\) wasn't ready and steady within 3 s \(HYPERV_MCP_NETWORK_SECONDS, up to 600 s, if it needs longer\): no DHCP address from the Default Switch yet.*It was restored to clean \(network disconnected\)/)
  const vm = only(sc)
  assert.strictEqual(vm.state, 'Off')
  assert.strictEqual(vm.switchName, null)
  assert.deepStrictEqual(vm.acls, [])
  sc.patchStub(s => { delete s.netNeverReady; s.netSetFails = true })
  await assert.rejects(a.request('start', { network: 'host' }), /setting the guest network failed/)
  assert.strictEqual(only(sc).switchName, null)
  noViolations(sc)
})

// ---------- crashes ----------

for (const at of ['after:net-prepare', 'after:configure-start', 'after:guest-net']) {
  test(`a crash at ${at} in a host-mode start: the next helper restores the VM disconnected with no ACLs`, async t => {
    const sc = scratch(`net-crash-${at.replace(':', '-')}`)
    let { h } = await withPool(sc, 1, { network: 'host' })
    await h.stop()
    h = await startHelper(sc, { HYPERV_MCP_CRASH_AT: at })
    const a = h.conn(10)
    await a.request('acquire')
    a.request('start', { network: 'host' }).catch(() => {}) // the helper dies before it replies
    assert.strictEqual(await h.exited, 99, `the helper crashed at ${at}`)
    const mid = only(sc)
    if (at === 'after:net-prepare') { assert.strictEqual(mid.state, 'Off'); assert.strictEqual(mid.switchName, null); assert.ok(mid.acls.length) }
    else assert.strictEqual(mid.switchName, 'hvmcp-host')
    h = await startHelper(sc)
    t.after(() => h.stop())
    const vm = only(sc)
    assert.strictEqual(vm.state, 'Off')
    assert.strictEqual(vm.switchName, null)
    assert.deepStrictEqual(vm.acls, [])
    assert.doesNotMatch((await h.conn(1).request('status')).text, /QUARANTINED/)
    noViolations(sc)
  })
}

test('a configure-start that fails after connecting: the VM is restored to clean at once (disconnected, no ACLs) while the lease holds; a crash there is recovered too', async t => {
  const sc = scratch('net-crash-connect')
  let { h } = await withPool(sc, 1, { network: 'internet' })
  const a = h.conn(10)
  await a.request('acquire')
  sc.patchStub(s => { s.crashAfterConnect = true })
  await assert.rejects(a.request('start', { network: 'internet' }), /the call died after connecting\. hvmcp-[0-9a-f]{8} was restored to clean \(network disconnected\)\./)
  let mid = only(sc)
  assert.strictEqual(mid.state, 'Off')
  assert.strictEqual(mid.switchName, null, 'disconnected now, not at the next stop or recovery')
  assert.deepStrictEqual(mid.acls, [])
  assert.doesNotMatch((await h.conn(1).request('status')).text, /QUARANTINED/)
  // The helper dying in that call instead (no chance to clean up): the next one's recovery does it.
  await h.stop()
  h = await startHelper(sc, { HYPERV_MCP_CRASH_AT: 'after:configure-start' })
  const b = h.conn(10)
  await b.request('acquire')
  b.request('start', { network: 'internet' }).catch(() => {}) // the helper dies before it replies
  assert.strictEqual(await h.exited, 99)
  mid = only(sc)
  assert.strictEqual(mid.switchName, 'Default Switch', 'connected, with its ACLs, when it died')
  h = await startHelper(sc)
  t.after(() => h.stop())
  assert.strictEqual(only(sc).switchName, null)
  assert.deepStrictEqual(only(sc).acls, [])
  noViolations(sc)
})

test('a baseline with leftover ACLs is quarantined, not leased', async t => {
  const sc = scratch('net-baseline')
  const { h } = await withPool(sc, 1, { network: 'host' })
  t.after(() => h.stop())
  const a = h.conn(10)
  await a.request('acquire')
  await a.request('start', { network: 'host' })
  sc.patchStub(s => { s.aclsStay = true })
  const r = await a.request('stop')
  assert.match(r.text, /CLEANUP FAILED: .*port ACL\(s\)/)
  assert.match((await h.conn(1).request('status')).text, /QUARANTINED/)
})

// ---------- setup ----------

// install.ps1's host-subnet check, run as setup runs it (the block itself, cut from the script, not elevated), with
// this PC's interfaces and routes mocked: it loads the helper's own net.js from the source folder and refuses a bad
// or clashing subnet before setup changes anything (MC-1556 round 1: the path to net.js was broken).
test('setup: the host-subnet check loads helper/net.js and refuses a bad or clashing subnet, before anything changes', { skip: process.platform !== 'win32' }, () => {
  const { spawnSync } = require('child_process')
  const { ps51Env } = require('../helper/hv')
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup', 'install.ps1'), 'utf8')
  const block = /^if \(\$wantHost\) \{\r?\n  \$nodeNet = [\s\S]*?\r?\n\}\r?\n/m.exec(src)
  assert.ok(block, 'the host-subnet block in install.ps1')
  assert.match(block[0], /Join-Path \$src 'helper\\net\.js'\) \$subnet\r?\n/, 'the real file, on one line')
  const sc = scratch('setup-subnet')
  const file = path.join(sc.dir, 'subnet.ps1')
  fs.writeFileSync(file, [
    'param([string]$src, [string]$subnet, [string]$clash = \'\')',
    "$ErrorActionPreference = 'Stop'",
    '$wantHost = $true; $ourHostSw = $null',
    'function Get-HostAdapter($id) { $null }',
    "function Get-NetIPAddress { @([pscustomobject]@{ InterfaceIndex = 4; InterfaceAlias = 'Ethernet'; IPAddress = '192.168.1.20'; PrefixLength = 24 }) + @(if ($clash) { [pscustomobject]@{ InterfaceIndex = 9; InterfaceAlias = 'VPN'; IPAddress = $clash; PrefixLength = 16 } }) }",
    "function Get-NetRoute { @([pscustomobject]@{ ifIndex = 4; InterfaceAlias = 'Ethernet'; DestinationPrefix = '0.0.0.0/0' }, [pscustomobject]@{ ifIndex = 4; InterfaceAlias = 'Ethernet'; DestinationPrefix = '192.168.1.0/24' }) }",
    block[0],
    "'checked'"
  ].join('\n'))
  const run = (subnet, clash = '') => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-src', path.join(__dirname, '..'), '-subnet', subnet, '-clash', clash], { encoding: 'utf8', env: ps51Env(), timeout: T.spawnMs })
  const good = run('10.137.42.0/24')
  assert.strictEqual(good.status, 0, good.stdout + good.stderr)
  assert.match(good.stdout, /checked/)
  const clash = run('10.137.42.0/24', '10.137.9.9')
  assert.notStrictEqual(clash.status, 0)
  assert.match(clash.stdout + clash.stderr, /Host mode can't use 10\.137\.42\.0\/24: VPN has 10\.137\.9\.9\/16, which overlaps the host subnet/)
  const bad = run('10.137.42.1/24')
  assert.notStrictEqual(bad.status, 0)
  assert.match(bad.stdout + bad.stderr, /the host subnet must be a \/24 written as a\.b\.c\.0\/24/)
})
