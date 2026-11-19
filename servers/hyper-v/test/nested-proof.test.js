// MC-1559: the nested live proof's driver (test/live/nested-proof.js), offline. Nothing here touches Hyper-V, SSH or the
// network: a fake remote stands in for the outer VM.
// - the identity guard: the host's identity.txt, GUIDs compared normalised, every mismatch refused, and assertTarget run
//   before each remote change in the matrix and again before its cleanup (a mismatch stops the run, with no cleanup on
//   that target and the manual cleanup reported); the cleanup's result read back and never claimed when unverified;
// - pool VM names in core.js's real format (prefix and 8 hex digits);
// - pinned SSH: StrictHostKeyChecking=yes, its own known_hosts and alias, BatchMode, one key per account;
// - the ACL sets are exactly net.aclsFor's (simple port ACLs), empty after a stop or release, any extra or missing fails;
// - probes are bounded, validated before they're put in a command, and parsed from a run's reply;
// - verdicts: a negative row passes only with its positive controls, else it's unclaimed; IPv6 is always unclaimed;
//   an allow rule that could cover 18081, or a profile that doesn't block, makes its rows unclaimed;
// - a refusal passes only when refused for the cap asked about.
const test = require('node:test')
const assert = require('assert')
const P = require('./live/nested-proof')

const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const EXPECTED = { biosGuid: GUID, token: 'tok-1' }
const GOOD = { uuid: `{${GUID.toUpperCase()}}`, model: 'Virtual Machine', hostname: 'HVNEST-PROOF', marker: { biosGuid: GUID, token: 'tok-1' } }

test('identity.txt: parsed and checked; GUIDs normalised', () => {
  assert.deepStrictEqual(P.parseIdentityTxt(`vmId={${GUID.toUpperCase()}}\r\nfolder=C:\\hvnest-proof\\\r\nbiosGuid=${GUID}\r\n`), { vmId: GUID, biosGuid: GUID })
  assert.throws(() => P.parseIdentityTxt(`vmId=${GUID}\nfolder=C:\\hvnest-proof`), /no biosGuid/)
  assert.throws(() => P.parseIdentityTxt(`vmId=${GUID}\nfolder=C:\\elsewhere\nbiosGuid=${GUID}`), /folder/)
  assert.throws(() => P.parseIdentityTxt(`folder=C:\\hvnest-proof\nbiosGuid=${GUID}`), /no vmId/)
  assert.strictEqual(P.normGuid(' {ABC} '), 'abc')
})

test('targetProblems: the outer VM passes; each mismatch is named', () => {
  assert.deepStrictEqual(P.targetProblems(EXPECTED, GOOD), [])
  const bad = (o, re) => assert.ok(P.targetProblems(EXPECTED, { ...GOOD, ...o }).some(p => re.test(p)), JSON.stringify(o))
  bad({ uuid: '11111111-1111-1111-1111-111111111111' }, /BIOS GUID/)
  bad({ marker: null }, /no marker/)
  bad({ marker: { biosGuid: GUID, token: 'other' } }, /token differs/)
  bad({ marker: { biosGuid: '11111111-1111-1111-1111-111111111111', token: 'tok-1' } }, /marker's BIOS GUID/)
  bad({ model: 'Precision 7865' }, /model/)
  bad({ hostname: 'WORKSTATION-1' }, /hostname/)
  assert.ok(P.targetProblems({ biosGuid: GUID }, GOOD).some(p => /no expected token/.test(p)))
})

test('sshArgs: pinned host key only, its own key, no prompts, never accept-new', () => {
  const a = P.sshArgs({ keyDir: 'K' }, 'admin').join(' ')
  for (const s of ['StrictHostKeyChecking=yes', 'BatchMode=yes', 'IdentitiesOnly=yes', 'HostKeyAlias=hvnest-proof', 'UserKnownHostsFile=K', 'GlobalKnownHostsFile=K']) assert.ok(a.includes(s), s)
  assert.ok(/-i K[\\/]id_admin/.test(a))
  assert.ok(!/accept-new|StrictHostKeyChecking=no/.test(a))
  assert.throws(() => P.sshArgs({ keyDir: 'K' }, 'root'), /no account/)
})

test('ACLs: exactly the mode\'s set (simple port ACLs, both directions), empty and disconnected after a stop or release', () => {
  const ctx = { hostAddress: '10.137.42.1', gateway: '172.20.80.1' }
  const both = list => list.flatMap(([action, remote]) => [{ action, direction: 'Both', remote }])
  const host = both([['Allow', '10.137.42.1'], ['Deny', '0.0.0.0/0'], ['Deny', '::/0']])
  assert.strictEqual(P.aclVerdict('host', ctx, { switch: 'hvmcp-host', acls: host }).verdict, 'passed')
  assert.deepStrictEqual(P.expectedAcls('internet-lan', ctx), ['Deny|Inbound|::/0', 'Deny|Outbound|::/0'])
  assert.strictEqual(P.expectedAcls('internet', ctx).length, 2 * 7, 'gateway allow, 5 private ranges, IPv6')
  const missing = P.aclVerdict('host', ctx, { switch: 'hvmcp-host', acls: host.slice(0, 2) })
  assert.strictEqual(missing.verdict, 'failed'); assert.match(missing.why, /missing Deny\|Inbound\|::\/0/)
  const extra = P.aclVerdict('internet-lan', ctx, { switch: 'Default Switch', acls: [...both([['Deny', '::/0']]), { action: 'Allow', direction: 'Outbound', remote: '0.0.0.0/0' }] })
  assert.strictEqual(extra.verdict, 'failed'); assert.match(extra.why, /unexpected Allow\|Outbound/)
  assert.strictEqual(P.aclVerdict('host', ctx, { switch: '', acls: host }).verdict, 'failed', 'not connected')
  assert.strictEqual(P.aclVerdict('none', {}, { switch: '', connected: false, acls: [] }, { disconnected: true }).verdict, 'passed')
  assert.match(P.aclVerdict('none', {}, { switch: '', acls: host }, { disconnected: true }).why, /unexpected/)
  assert.match(P.aclVerdict('none', {}, { switch: 'Default Switch', acls: [] }, { disconnected: true }).why, /still connected/)
  assert.throws(() => P.aclReadPs("x'; Remove-VM *"), /isn't a pool VM name/)
  assert.match(P.aclReadPs('hvmcp-1234abcd'), /Get-VMNetworkAdapterAcl -VM \$vm/)
})

test('probes: validated before use, bounded, one JSON line each, a batch exits 0; parsed back from a reply', () => {
  const t = { target: 'L', kind: 'tcp', ip: '192.168.1.1', port: 80 }
  const h = { target: 'HTTPS', kind: 'https', url: 'https://www.microsoft.com/' }
  assert.match(P.psProbe(t), /ConnectAsync\('192\.168\.1\.1',80\)\.Wait\(5000\)/)
  assert.match(P.psProbe(h), /-TimeoutSec 15/)
  assert.match(P.bashProbe(t), /timeout 5 bash -c '<\/dev\/tcp\/192\.168\.1\.1\/80'/)
  assert.match(P.bashProbe(h), /^timeout 60 python3 -c /)
  assert.match(P.bashProbe(h), /for t in range\(2\):/)
  assert.match(P.psProbe(h), /foreach \(\$t in 1\.\.2\)/)
  assert.match(P.bashProbe(h), /timeout=15/)
  for (const bad of [{ ...t, ip: '1.2.3.4; rm -rf /' }, { ...t, port: 0 }, { ...h, url: "https://x/'; id" }, { ...h, url: 'http://plain/' }, { ...t, target: 'a b' }]) assert.throws(() => P.psProbe(bad), /bad|unknown/)
  assert.match(P.probeScript('powershell', [t]), /\nexit 0$/)
  assert.match(P.probeScript('bash', [t]), /\nexit 0$/)
  const reply = 'Exit code 0.\n--- stdout ---\n{"probe":"tcp","target":"L","ok":true}\nnoise\n{"probe":"https","target":"HTTPS","ok":false,"code":0}\n--- stderr ---\n'
  assert.deepStrictEqual(P.parseProbes(reply).map(p => [p.target, p.ok]), [['L', true], ['HTTPS', false]])
})

/** Every probe as the expected outcome says, and every outer control reached. */
function idealResults() {
  const results = {}
  for (const o of ['windows', 'debian']) for (const [mode, exp] of Object.entries(P.EXPECT)) for (const [t, e] of Object.entries(exp)) results[`${o}|${mode}|${t}`] = { probe: 'tcp', target: t, ip: '1.1.1.1', port: 1, ok: e === 'pass' }
  const outer = Object.fromEntries(['H80', 'H81', 'L', 'IT', 'HTTPS'].map(t => [t, { target: t, ok: true }]))
  return { results, outer }
}

test('classify: with every control, all rows pass but IPv6 (unclaimed); a negative without its control is unclaimed, never passed', () => {
  const { results, outer } = idealResults()
  const rows = P.classify(results, outer)
  assert.deepStrictEqual(rows.filter(r => r.verdict !== 'passed').map(r => `${r.os}|${r.target}|${r.verdict}`), ['windows|IPv6|unclaimed', 'debian|IPv6|unclaimed'])
  // The LAN not reachable from the outer VM: every negative L row unclaimed; internet-lan's L fails.
  const noLan = P.classify(results, { ...outer, L: { ok: false } })
  assert.ok(noLan.filter(r => r.target === 'L' && r.expect === 'fail').every(r => r.verdict === 'unclaimed' && /outer VM/.test(r.why)))
  // The guest's own control (internet-lan L) failed: its negative L rows unclaimed, the positive one failed.
  const r2 = { ...results, 'debian|internet-lan|L': { target: 'L', ok: false } }
  const c2 = P.classify(r2, outer)
  assert.ok(c2.filter(r => r.os === 'debian' && r.target === 'L' && r.expect === 'fail').every(r => r.verdict === 'unclaimed'))
  assert.strictEqual(c2.find(r => r.os === 'debian' && r.mode === 'internet-lan' && r.target === 'L').verdict, 'failed')
  assert.ok(c2.filter(r => r.os === 'windows' && r.target === 'L').every(r => r.verdict === 'passed'), 'the other OS unaffected')
  // A negative reached: failed (a real defect).
  const c3 = P.classify({ ...results, 'windows|internet|L': { target: 'L', ok: true } }, outer)
  assert.strictEqual(c3.find(r => r.os === 'windows' && r.mode === 'internet' && r.target === 'L').verdict, 'failed')
  // Not run: unclaimed.
  const r4 = { ...results }; delete r4['windows|host|H80']
  assert.strictEqual(P.classify(r4, outer).find(r => r.os === 'windows' && r.mode === 'host' && r.target === 'H80').verdict, 'unclaimed')
  // H81: its control is the outer VM's local connection; an unclaimable firewall makes it unclaimed.
  assert.strictEqual(P.classify(results, { ...outer, H81: { ok: false } }).find(r => r.target === 'H81').verdict, 'unclaimed')
  assert.ok(P.classify(results, outer, { firewall: { h81Unclaimed: 'an unrelated allow rule covers it: x' } }).filter(r => r.target === 'H81').every(r => r.verdict === 'unclaimed'))
})

test('firewall: a rule that could allow 18081 (or anything not understood) makes it unclaimed; a blocking profile with none claims it', () => {
  const ctx = { address: '10.137.42.1', guestAddress: '10.137.42.10', nodePath: 'C:\\Program Files\\nodejs\\node.exe' }
  const profile = { name: 'Public', enabled: true, defaultInboundAction: 'Block' }
  const ours = { name: 'ours', profile: 'Any', protocol: 'TCP', localPort: ['18080'], localAddress: ['10.137.42.1'], remoteAddress: ['10.137.42.0/24'], program: 'Any', service: 'Any' }
  const svc = { name: 'svc', profile: 'Any', protocol: 'TCP', localPort: ['Any'], localAddress: ['Any'], remoteAddress: ['Any'], program: 'Any', service: 'Spooler' }
  const otherProg = { name: 'app', profile: 'Public', protocol: 'TCP', localPort: ['Any'], localAddress: ['Any'], remoteAddress: ['Any'], program: 'C:\\app.exe', service: 'Any' }
  const priv = { name: 'priv', profile: 'Private', protocol: 'TCP', localPort: ['Any'], localAddress: ['Any'], remoteAddress: ['Any'], program: 'Any', service: 'Any' }
  const udp = { ...priv, name: 'udp', profile: 'Any', protocol: 'UDP' }
  assert.strictEqual(P.h81Unclaimed({ profile, rules: [ours, svc, otherProg, priv, udp] }, ctx), null)
  const broad = { name: 'broad', profile: 'Any', protocol: 'Any', localPort: ['18000-18100'], localAddress: ['Any'], remoteAddress: ['LocalSubnet'], program: 'Any', service: 'Any' }
  assert.match(P.h81Unclaimed({ profile, rules: [ours, broad] }, ctx), /broad/)
  const nodeRule = { ...otherProg, name: 'node', program: 'C:\\Program Files\\nodejs\\node.exe' }
  assert.match(P.h81Unclaimed({ profile, rules: [nodeRule] }, ctx), /node/)
  const range = { ...broad, name: 'range', localPort: ['Any'], localAddress: ['10.137.42.0/24'], remoteAddress: ['10.137.42.10-10.137.42.20'] }
  assert.match(P.h81Unclaimed({ profile, rules: [range] }, ctx), /range/)
  assert.match(P.h81Unclaimed({ profile: { ...profile, defaultInboundAction: 'Allow' }, rules: [] }, ctx), /default inbound action is Allow/)
  assert.match(P.h81Unclaimed({ profile: { ...profile, enabled: false }, rules: [] }, ctx), /off/)
  assert.match(P.h81Unclaimed({}, ctx), /couldn't be read/)
})

/**
 * A fake outer VM: the admin scripts the driver sends, recognised by what they do; a session whose VM follows the
 * modes (its ACLs as hv.ps1 would set them) and answers probes as the expected outcomes say.
 */
function fakeRemote({ identity = () => GOOD, outerLan = true, outerH80 = true, alive = { running: true, listening: [18080, 18081] }, cleanupResult = { code: 0, out: { record: null, listenerRunning: false, rule: false } } } = {}) {
  const calls = []
  const state = { mode: null, connected: false }
  const ok = o => ({ code: 0, stdout: JSON.stringify(o) + '\n', stderr: '' })
  const remote = {
    calls,
    run(role, script) {
      const kind = /Win32_ComputerSystemProduct/.test(script) ? 'identity' : /Get-NetTCPConnection/.test(script) ? 'check' : /nested-listener\.js/.test(script) ? 'listen' : /New-NetFirewallRule/.test(script) ? 'fwAdd'
        : /Get-NetFirewallPortFilter/.test(script) ? 'fwRead' : /Get-VMNetworkAdapterAcl/.test(script) ? 'acl' : /Stop-Process/.test(script) ? 'cleanup'
          : /vEthernet \(Default Switch\)/.test(script) ? 'dsw' : /TcpClient/.test(script) ? 'outer' : 'other'
      calls.push(kind)
      if (kind === 'identity') return ok(identity(calls.filter(c => c === 'identity').length))
      if (kind === 'listen') return ok({ pid: 42, start: 'x', node: 'C:\\Program Files\\nodejs\\node.exe' })
      if (kind === 'check') return ok(alive)
      if (kind === 'fwAdd') return ok([{ name: P.FW_RULE, enabled: 'True' }])
      if (kind === 'fwRead') return ok({ category: 'Public', profile: { name: 'Public', enabled: true, defaultInboundAction: 'Block' }, rules: [] })
      if (kind === 'dsw') return ok({ gateway: '172.20.80.1', prefix: 20 })
      if (kind === 'outer') return { code: 0, stderr: '', stdout: ['H80', 'H81', 'L', 'IT', 'HTTPS'].map(t => JSON.stringify({ probe: 'tcp', target: t, ok: t === 'L' ? outerLan : t === 'H80' ? outerH80 : true })).join('\n') }
      if (kind === 'acl') {
        const acls = state.connected ? require('../helper/net').aclsFor(state.mode, { hostAddress: '10.137.42.1', gateway: '172.20.80.1' }).map(a => ({ action: a.action, direction: 'Both', remote: a.remote })) : []
        return ok({ switch: state.connected ? (state.mode === 'host' ? 'hvmcp-host' : 'Default Switch') : '', connected: state.connected, acls })
      }
      if (kind === 'cleanup') return cleanupResult.code === 0 ? ok(cleanupResult.out) : { code: cleanupResult.code, stdout: '', stderr: 'ssh: connection reset' }
      return { code: 1, stdout: '', stderr: 'unexpected script' }
    },
    session() {
      calls.push('session')
      return {
        async call(tool, args) {
          calls.push(tool)
          if (tool === 'vm_acquire') return { text: 'Leased hvmcp-1234abcd (lease l-1) until ...', isError: false }
          if (tool === 'vm_start') { state.mode = args.network; state.connected = args.network !== 'none'; return { text: `Started (network ${args.network})`, isError: false } }
          if (tool === 'vm_run') return { text: 'Exit code 0.\n--- stdout ---\n' + Object.entries(P.EXPECT[state.mode]).map(([t, e]) => JSON.stringify({ probe: 'tcp', target: t, ip: '1.1.1.1', port: 1, ok: e === 'pass' })).join('\n') + '\n--- stderr ---\n', isError: false }
          if (tool === 'vm_stop' || tool === 'vm_release') { state.connected = false; state.mode = null; return { text: 'Reverted', isError: false } }
          return { text: 'unknown', isError: true }
        },
        async close() {}
      }
    }
  }
  return remote
}

test('matrix (fake outer VM): identity before each change, every row and ACL readback passes, IPv6 unclaimed, cleanup last', async () => {
  const remote = fakeRemote()
  const out = await P.matrix(remote, EXPECTED, { lan: { ip: '192.168.1.1', port: 80 }, internetTcp: { ip: '1.1.1.1', port: 443 }, https: 'https://www.microsoft.com/', repoDir: 'C:\\hvnest-proof\\repo-x' }, () => {})
  assert.deepStrictEqual(out.rows.filter(r => r.verdict !== 'passed').map(r => r.target), ['IPv6', 'IPv6'])
  assert.ok(out.acl.length === 2 * (4 + 2) && out.acl.every(a => a.verdict === 'passed'), JSON.stringify(out.acl.filter(a => a.verdict !== 'passed')))
  const c = remote.calls
  assert.strictEqual(c[0], 'identity', 'identity before the listeners')
  assert.strictEqual(c[1], 'listen')
  assert.deepStrictEqual(c.slice(2, 4), ['fwAdd', 'check'], 'the listener confirmed from a later session before anything relies on it')
  for (let i = 0; i < c.length; i++) if (c[i] === 'session') assert.strictEqual(c[i - 1], 'identity', 'identity right before each lease')
  assert.deepStrictEqual(c.slice(-2), ['identity', 'cleanup'], 'identity right before the cleanup, the cleanup last')
  assert.strictEqual(out.cleanup.verified, true)
  const md = P.report({ id: 'r', commit: 'c', target: GOOD, ...out })
  assert.match(md, /\| debian \| internet-lan \| L \| pass \| \*\*passed\*\*/)
  assert.match(md, /Cleanup: the listeners stopped and the 18080 rule removed \(read back\)/)
})

const CFG = { lan: { ip: '192.168.1.1', port: 80 }, internetTcp: { ip: '1.1.1.1', port: 443 }, https: 'https://www.microsoft.com/', repoDir: 'C:\\r' }

test('matrix: an identity mismatch mid-run stops it; no session starts, no cleanup on the unconfirmed target, the manual cleanup reported', async () => {
  const remote = fakeRemote({ identity: n => (n === 1 ? GOOD : { ...GOOD, uuid: '11111111-1111-1111-1111-111111111111' }) })
  const logs = []
  await assert.rejects(P.matrix(remote, EXPECTED, CFG, e => logs.push(e)), e => /Not the outer VM \(before leasing the windows VM\)/.test(e.message) && /CLEANUP NOT VERIFIED/.test(e.message) && /Remove-NetFirewallRule/.test(e.message) && /Get-Process -Id 42/.test(e.message))
  assert.ok(!remote.calls.includes('session'))
  assert.ok(!remote.calls.includes('cleanup'), 'no remote change on a target that no longer matches')
  const cl = logs.find(e => e.kind === 'cleanup')
  assert.strictEqual(cl.verified, false)
  assert.deepStrictEqual(cl.listener, { pid: 42, start: 'x', node: 'C:\\Program Files\\nodejs\\node.exe' }, 'the listener record kept in the log')
  // The first check failing: nothing at all is started or cleaned.
  const r2 = fakeRemote({ identity: () => ({ ...GOOD, hostname: 'WORKSTATION-1' }) })
  await assert.rejects(P.matrix(r2, EXPECTED, { lan: { ip: '192.168.1.1', port: 80 }, internetTcp: { ip: '1.1.1.1', port: 443 }, https: 'https://www.microsoft.com/', repoDir: 'C:\\r' }, () => {}), /hostname/)
  assert.deepStrictEqual(r2.calls, ['identity'], 'nothing started, nothing cleaned up on an unconfirmed target')
})

test('cleanup: an SSH failure, or a rule or listener still there on readback, is reported as not verified, never success', async () => {
  // The matrix itself succeeded, but its cleanup's call failed: results kept, cleanup.verified false, the report says so.
  const failed = await P.matrix(fakeRemote({ cleanupResult: { code: 255 } }), EXPECTED, CFG, () => {})
  assert.strictEqual(failed.cleanup.verified, false)
  assert.match(failed.cleanup.why, /cleanup's call failed \(exit 255\)/)
  assert.match(P.report({ id: 'r', commit: 'c', target: GOOD, ...failed }), /\*\*CLEANUP NOT VERIFIED\*\*.*Remove-NetFirewallRule/)
  // The rule still there, or the listener still running, after the cleanup.
  const rule = await P.matrix(fakeRemote({ cleanupResult: { code: 0, out: { record: null, listenerRunning: false, rule: true } } }), EXPECTED, CFG, () => {})
  assert.match(rule.cleanup.why, /the rule is still there/)
  const lis = await P.matrix(fakeRemote({ cleanupResult: { code: 0, out: { record: { pid: 42 }, listenerRunning: true, rule: false } } }), EXPECTED, CFG, () => {})
  assert.match(lis.cleanup.why, /the listener still runs/)
  // The explicit cleanup command's path: guarded (identity first), verified, never throwing.
  const r = fakeRemote({ identity: () => ({ ...GOOD, token: undefined, marker: { biosGuid: GUID, token: 'other' } }) })
  const c = P.guardedCleanup(r, EXPECTED, () => {}, null)
  assert.strictEqual(c.verified, false)
  assert.match(c.why, /token differs/)
  assert.deepStrictEqual(r.calls, ['identity'], 'nothing removed on a mismatched target')
  const ok = fakeRemote()
  assert.strictEqual(P.guardedCleanup(ok, EXPECTED, () => {}, null).verified, true)
  assert.deepStrictEqual(ok.calls, ['identity', 'cleanup'])
})

test('matrix: the LAN unreachable from the outer VM leaves its negative rows unclaimed', async () => {
  const out = await P.matrix(fakeRemote({ outerLan: false }), EXPECTED, { lan: { ip: '192.168.1.1', port: 80 }, internetTcp: { ip: '1.1.1.1', port: 443 }, https: 'https://www.microsoft.com/', repoDir: 'C:\\r' }, () => {})
  assert.ok(out.rows.filter(r => r.target === 'L' && r.expect === 'fail').every(r => r.verdict === 'unclaimed'))
})

test('refusal: passes only when refused for the cap asked about', async () => {
  const mk = text => ({ run: () => ({ code: 0, stdout: JSON.stringify(GOOD), stderr: '' }), session: () => ({ async call(tool) { return tool === 'vm_start' ? { text, isError: true } : { text: 'Leased hvmcp-1234abcd (lease l)', isError: false } }, async close() {} }) })
  const pool = 'Network internet-lan is above the pool\'s internet: ask for a lower one, ...'
  assert.strictEqual((await P.refusal(mk(pool), EXPECTED, 'windows', 'internet-lan', 'pool', () => {})).verdict, 'passed')
  assert.strictEqual((await P.refusal(mk(pool), EXPECTED, 'windows', 'internet-lan', 'policy', () => {})).verdict, 'failed', 'refused, but for the other cap')
  assert.strictEqual((await P.refusal(mk('the guest did not answer'), EXPECTED, 'debian', 'internet', 'pool', () => {})).verdict, 'failed')
  await assert.rejects(P.refusal(mk(pool), EXPECTED, 'mac', 'internet', 'pool', () => {}), /refusal </)
})

test('pool VM names in the helper\'s real format: vm_acquire\'s reply and the ACL readback accept them', () => {
  // core.js names a pool VM `${policy.prefix}-${hex(4)}`, hex(n) being n random bytes in hex: checked in its source,
  // so a change there fails here rather than at the first live lease.
  const core = require('fs').readFileSync(require('path').join(__dirname, '..', 'helper', 'core.js'), 'utf8')
  assert.ok(core.includes('const hex = n => crypto.randomBytes(n).toString(\'hex\')'))
  assert.ok(core.includes('name: `${this.policy.prefix}-${hex(4)}`'))
  const crypto = require('crypto')
  for (const prefix of ['hvmcp', 'ab', 'z12345678901']) {
    const name = `${prefix}-${crypto.randomBytes(4).toString('hex')}`
    assert.strictEqual(P.vmFromAcquire(`Leased ${name} (lease l-123) until 2026-11-18T13:00:00.000Z; vm_renew can extend it`), name)
    assert.match(P.aclReadPs(name), new RegExp(`Get-VM -Name '${name}'`))
  }
  assert.strictEqual(P.vmFromAcquire('Leased hvmcp-1234abcd (lease l-123) until ...'), 'hvmcp-1234abcd')
  assert.throws(() => P.vmFromAcquire('Leased hvmcp-ab12 (lease l) until x'), /no VM/, 'a 4-digit suffix isn\'t the helper\'s')
  assert.throws(() => P.aclReadPs('hvmcp-ab12'), /isn't a pool VM name/)
  assert.throws(() => P.vmFromAcquire('No VM is free'), /no VM/)
})

test('18081 under a firewall that could let it through, or a non-blocking profile: unclaimed whether reached or not', () => {
  const { results, outer } = idealResults()
  for (const why of ['an unrelated allow rule covers it: allow-node', 'the Public profile\'s default inbound action is Allow']) {
    for (const ok of [true, false]) {
      const rows = P.classify({ ...results, 'windows|host|H81': { target: 'H81', ok } }, outer, { firewall: { h81Unclaimed: why } })
      const row = rows.find(r => r.os === 'windows' && r.target === 'H81')
      assert.strictEqual(row.verdict, 'unclaimed', `${why}, reached ${ok}`)
      assert.strictEqual(row.why, why)
    }
  }
  // Without such a rule, a reached 18081 is a real failure.
  assert.strictEqual(P.classify({ ...results, 'windows|host|H81': { target: 'H81', ok: true } }, outer).find(r => r.os === 'windows' && r.target === 'H81').verdict, 'failed')
})

test('every PowerShell script the driver sends parses (Windows PowerShell 5.1\'s parser; nothing is run)', () => {
  const { spawnSync } = require('child_process')
  const t = P.targets({ lan: { ip: '192.168.1.1', port: 80 }, internetTcp: { ip: '1.1.1.1', port: 443 }, https: 'https://www.microsoft.com/' }, '10.137.42.1')
  const REPO_DIR = 'C:\\hvnest-proof\\repo-0123456789ab'
  const scripts = {
    identity: P.IDENTITY_PS, firewall: P.FIREWALL_PS('10.137.42.1'), listenersStart: P.LISTENERS_START_PS(REPO_DIR, '10.137.42.1'), listenersCheck: P.LISTENERS_CHECK_PS('10.137.42.1'),
    listenersStop: P.LISTENERS_STOP_PS, fwAdd: P.FW_ADD_PS('10.137.42.1', '10.137.42.0/24'), defaultSwitch: P.DEFAULT_SWITCH_PS,
    acl: P.aclReadPs('hvmcp-1234abcd'), probes: P.probeScript('powershell', Object.values(t)),
    preflight: P.SCRIPTS.preflight, deployPrepare: P.SCRIPTS.deployPrepare,
    deployUnpack: P.SCRIPTS.deployUnpack('0123456789abcdef0123456789abcdef01234567', 'a'.repeat(64), REPO_DIR),
    setup: P.SCRIPTS.setup(REPO_DIR, 'InternetLan'),
    setup7: P.SCRIPTS.setup(REPO_DIR, 'Host', '7'),
    uploadCheck: P.SCRIPTS.uploadCheck('Win11_Eval.iso', 'b'.repeat(64)),
    installNode: P.SCRIPTS.installNode('node-v22.11.0-x64.msi'),
    installPwsh: P.SCRIPTS.installPwsh('PowerShell-7.6.10-win-x64.msi')
  }
  // MC-1575: setup by the user's own line (install.cmd) by default, or under the registered PowerShell 7; approvals by
  // the user's approve.cmd line.
  assert.match(scripts.setup, /^cmd \/c call "C:\\hvnest-proof\\repo-0123456789ab\\servers\\hyper-v\\setup\\install\.cmd" -DiskFolder C:\\hyperv-mcp-disks -User "hvnest-proof\\proofuser" -MaxNetwork InternetLan /)
  assert.match(scripts.setup7, /PowerShellCore\\InstalledVersions[\s\S]*& \$pwsh -NoProfile -ExecutionPolicy Bypass -File 'C:\\hvnest-proof\\repo-0123456789ab\\servers\\hyper-v\\setup\\install\.ps1' -DiskFolder/)
  for (const s of [scripts.setup, scripts.setup7]) assert.match(s, /"engine: " \+ \[string\]\(Get-Content -LiteralPath 'C:\\Program Files\\hyperv-mcp\\host\.config'/)
  assert.throws(() => P.SCRIPTS.setup(REPO_DIR, 'Host', '5'), /bad setup/)
  assert.throws(() => P.SCRIPTS.installPwsh('PowerShell-7.6.10-win-x64.msi"; evil'), /bad PowerShell msi/)
  assert.match(scripts.installPwsh, /O=Microsoft Corporation/)
  assert.strictEqual(P.approveLine('p-0123456789abcdef'), 'cmd /c call "C:\\Program Files\\hyperv-mcp\\approve.cmd" -Plan p-0123456789abcdef')
  assert.throws(() => P.approveLine('p-01 & evil'), /approve <p-/)
  assert.throws(() => P.SCRIPTS.uploadCheck("x'.iso", 'b'.repeat(64)), /bad upload/)
  assert.throws(() => P.SCRIPTS.installNode('evil.msi'), /bad node msi/)
  assert.throws(() => P.SCRIPTS.setup("C:\\x'; rm", 'InternetLan'), /bad setup/)
  assert.throws(() => P.SCRIPTS.setup(REPO_DIR, 'Internet'), /bad setup/)
  assert.throws(() => P.SCRIPTS.deployUnpack('0123456789abcdef0123456789abcdef01234567', 'a'.repeat(64), 'C:\\other'), /bad deploy/)
  const ps = '$all = [Console]::In.ReadToEnd() | ConvertFrom-Json; foreach ($p in $all.PSObject.Properties) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([string]$p.Value, [ref]$null, [ref]$e); foreach ($x in $e) { [Console]::WriteLine($p.Name + ": " + $x.Message) } }'
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { input: JSON.stringify(scripts), encoding: 'utf8', windowsHide: true })
  assert.strictEqual(r.status, 0, r.stderr)
  assert.strictEqual(r.stdout.trim(), '')
})

test('matrix: a listener that died with its SSH session, or one the outer VM can\'t reach, stops the run before any guest', async () => {
  // The first live run: Start-Process's listener was killed when sshd's job closed; every 18080 row was then unprovable.
  for (const alive of [{ running: false, listening: [] }, { running: true, listening: [18080] }]) {
    const remote = fakeRemote({ alive })
    await assert.rejects(P.matrix(remote, EXPECTED, CFG, () => {}), e => /isn't running and listening/.test(e.message) && /no guest was run/.test(e.message) && /cleaned up, verified/.test(e.message))
    assert.ok(!remote.calls.includes('session'), 'no lease taken')
    assert.deepStrictEqual(remote.calls.slice(-2), ['identity', 'cleanup'], 'still cleaned up, guarded')
  }
  const remote = fakeRemote({ outerH80: false })
  await assert.rejects(P.matrix(remote, EXPECTED, CFG, () => {}), /can't reach its own listeners .*no guest was run/)
  assert.ok(!remote.calls.includes('session'))
  // The start goes through WMI, outside the session's job, and records the pid before waiting on it.
  const start = P.LISTENERS_START_PS('C:\hvnest-proof\repo-0123456789ab', '10.137.42.1')
  assert.match(start, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/)
  assert.doesNotMatch(start, /Start-Process/)
  assert.ok(start.indexOf('Set-Content') < start.indexOf('Start-Sleep'), 'recorded before the wait, so a cleanup can find it')
})

test('classify: an expected reach that failed while the outer VM couldn\'t reach the target either is unclaimed, not failed', () => {
  const { results, outer } = idealResults()
  const miss = { ...results, 'debian|host|H80': { target: 'H80', ok: false } }
  const row = rows => rows.find(r => r.os === 'debian' && r.mode === 'host' && r.target === 'H80')
  assert.strictEqual(row(P.classify(miss, { ...outer, H80: { target: 'H80', ok: false } })).verdict, 'unclaimed')
  assert.strictEqual(row(P.classify(miss, outer)).verdict, 'failed', 'with a working control, a miss is a real failure')
  assert.strictEqual(row(P.classify(results, { ...outer, H80: { target: 'H80', ok: false } })).verdict, 'passed', 'a reach passes whatever the control saw')
})
