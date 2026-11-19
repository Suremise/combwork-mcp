#!/usr/bin/env node
/**
 * The nested live proof (MC-1559; MC-1560 and MC-1561 reuse it): proves the merged hyper-v code inside one
 * hand-made outer VM, hvnest-proof, with nested virtualization, so the host's installed helper and the CLI team's pool
 * are never touched. See README "Live proof in a nested VM" for the user's host and in-VM lines.
 *
 * This file runs on the HOST, as the user (no admin). It only ever runs ssh and scp to the outer VM: it has no code path
 * that runs setup, approve.ps1, the uninstaller or any Hyper-V cmdlet on this machine.
 * - Pinned SSH: StrictHostKeyChecking=yes against its own known_hosts (HostKeyAlias hvnest-proof), BatchMode, one key per
 *   account (proofadmin, proofuser), never a new host key accepted.
 * - assertTarget() before every remote change (deploy, setup, each approval, each pool change, listeners, the firewall
 *   rule, the matrix): the guest's BIOS GUID equals the host's record (C:\hvnest-proof\identity.txt, written by the
 *   user's create line), the guest's marker holds the same GUID and the token the user gave, the model is "Virtual
 *   Machine" and the name is HVNEST-PROOF. Any mismatch stops the run.
 * - Logs on the host (%USERPROFILE%\hvnest-proof-logs\<run>), written as each call returns: the target's identity, the
 *   repo commit, every command with its exit code and output. Outside every install and state folder.
 *
 *   node nested-proof.js <command> [options]
 *     keys                       generate the two SSH keys (prints the public halves for the user's V2 line)
 *     pin "<host key line>"      write the pinned known_hosts from V2's output
 *     preflight                  read-only checks inside the outer VM
 *     upload <file>              copy a file (the Windows ISO) to C:\hvnest-proof\upload, checked by SHA-256
 *     install-node <msi>         upload node-vX.Y.Z-x64.msi and install it, only if validly signed by the OpenJS Foundation
 *     deploy [--commit <sha>]    copy the repo (git archive of a commit) into the outer VM
 *     install-pwsh <msi>         upload PowerShell-X.Y.Z-win-x64.msi and install it, only if validly signed by Microsoft
 *     setup --max-network <InternetLan|Host> [--engine launcher|7]   run the deployed setup inside the outer VM: by the
 *                                user's own line (install.cmd, the default), or under PowerShell 7, so the service runs
 *                                hv.ps1 under 7 (MC-1575); prints the engine setup recorded for the service
 *     approve <planId>           the user's approve line (approve.cmd) inside the outer VM (digest typed by the driver;
 *                                the user's permission)
 *     call <tool> [json]         one tool call in a fresh session as proofuser (pool_plan, pool_create, pool_status, ...)
 *     matrix                     MC-1559's network matrix on the Windows and the Debian pool VM
 *     refusal <os> <mode> <pool|policy>   one run asked above a cap: passes only if refused for that cap
 *     cleanup                    stop the listeners and remove the in-VM firewall rule (also done after each matrix)
 */
'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const net = require('../../helper/net')

// ---------- fixed names ----------

const HOSTNAME = 'HVNEST-PROOF'
const HOST_ALIAS = 'hvnest-proof'
const HOST_ROOT = 'C:\\hvnest-proof' // on the host: the outer VM's folder (identity.txt), the user's create line's
const GUEST_ROOT = 'C:\\hvnest-proof' // in the outer VM: the deployed repo
const GUEST_MARKER = 'C:\\ProgramData\\hvnest-proof\\identity.json'
const GUEST_LISTENER = 'C:\\ProgramData\\hvnest-proof\\listener.json'
const FW_RULE = 'hvnest-proof: host mode TCP 18080 (MC-1559 test)'
const GUEST_NODE = 'C:\\Program Files\\nodejs\\node.exe' // by full path: sshd's sessions keep the PATH it started with
const PORT_ALLOWED = 18080
const PORT_DENIED = 18081
const HTTPS_TRIES = 2
const USERS = { admin: 'proofadmin', user: 'proofuser' }
const KEY_DIR = path.join(os.homedir(), '.ssh', 'hvnest-proof')
const LOG_ROOT = path.join(os.homedir(), 'hvnest-proof-logs')
const MODES = ['none', 'host', 'internet', 'internet-lan']
const OSES = [{ key: 'windows', acquire: { os: 'windows' }, shell: 'powershell' }, { key: 'debian', acquire: { os: 'linux', distro: 'debian' }, shell: 'bash' }]
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const VM_RE = /^[a-z][a-z0-9]{1,11}-[0-9a-f]{8}$/ // core.js: `${policy.prefix}-${hex(4)}`, hex(4) = 4 random bytes as 8 hex digits
const SHA_RE = /^[0-9a-f]{40}$/
const PLAN_RE = /^p-[0-9a-f]{16}$/

// ---------- identity ----------

/** A GUID as compared everywhere: trimmed, no braces, lower case. */
const normGuid = s => String(s ?? '').trim().replace(/^\{/, '').replace(/\}$/, '').toLowerCase()

/** The host's record of the outer VM (identity.txt: vmId=, folder=, biosGuid= lines), or throws why it can't be used. */
function parseIdentityTxt(text) {
  const kv = {}
  for (const line of String(text).split(/\r?\n/)) { const m = /^(vmId|folder|biosGuid)=(.*)$/.exec(line.trim()); if (m) kv[m[1]] = m[2].trim() }
  const vmId = normGuid(kv.vmId)
  const biosGuid = normGuid(kv.biosGuid)
  if (!GUID_RE.test(vmId)) throw new Error('identity.txt has no vmId (a GUID): the create line didn\'t finish')
  if (!GUID_RE.test(biosGuid)) throw new Error('identity.txt has no biosGuid (a GUID): the create line didn\'t finish')
  if ((kv.folder || '').replace(/\\+$/, '').toLowerCase() !== HOST_ROOT.toLowerCase()) throw new Error(`identity.txt's folder isn't ${HOST_ROOT}`)
  return { vmId, biosGuid }
}

/**
 * Why the observed guest isn't the outer VM, as a list (empty: it is). expected: { biosGuid, token } (the host's record
 * and the token the user copied from V1); observed: { uuid, model, hostname, marker: { biosGuid, token } | null }.
 */
function targetProblems(expected, observed) {
  const out = []
  if (!GUID_RE.test(normGuid(expected?.biosGuid))) out.push('no expected BIOS GUID')
  if (!expected?.token) out.push('no expected token')
  if (normGuid(observed?.uuid) !== normGuid(expected?.biosGuid)) out.push(`BIOS GUID ${normGuid(observed?.uuid) || 'none'} isn't the recorded ${normGuid(expected?.biosGuid)}`)
  if (!observed?.marker) out.push(`no marker at ${GUEST_MARKER}`)
  else {
    if (normGuid(observed.marker.biosGuid) !== normGuid(expected?.biosGuid)) out.push('the marker\'s BIOS GUID differs')
    if (String(observed.marker.token ?? '') !== String(expected?.token ?? '')) out.push('the marker\'s token differs')
  }
  if (observed?.model !== 'Virtual Machine') out.push(`model "${observed?.model}" isn't "Virtual Machine"`)
  if (String(observed?.hostname ?? '').toUpperCase() !== HOSTNAME) out.push(`hostname "${observed?.hostname}" isn't ${HOSTNAME}`)
  return out
}

const IDENTITY_PS = `$m=$null; if (Test-Path -LiteralPath '${GUEST_MARKER}') { $m=Get-Content -LiteralPath '${GUEST_MARKER}' -Raw | ConvertFrom-Json }
@{ uuid=[string](Get-CimInstance Win32_ComputerSystemProduct).UUID; model=[string](Get-CimInstance Win32_ComputerSystem).Model; hostname=[string]$env:COMPUTERNAME; marker=$m } | ConvertTo-Json -Compress -Depth 3`

// ---------- ACLs (Add-VMNetworkAdapterAcl, as hv.ps1 writes them) ----------

/** The exact ACL set a mode installs (net.aclsFor, as keys); none, and after a stop or release, is empty. */
function expectedAcls(mode, ctx = {}) {
  return net.aclKeys(mode === 'none' ? [] : net.aclsFor(mode, ctx))
}

/** A readback ({ switch, connected, acls: [{ action, direction, remote }] }) against a mode's expectation. */
function aclVerdict(mode, ctx, readback, { disconnected = false } = {}) {
  const expected = disconnected ? [] : expectedAcls(mode, ctx)
  const actual = net.aclKeys(readback?.acls || [])
  const missing = expected.filter(k => !actual.includes(k))
  const extra = actual.filter(k => !expected.includes(k))
  const why = []
  if (missing.length) why.push(`missing ${missing.join(', ')}`)
  if (extra.length) why.push(`unexpected ${extra.join(', ')}`)
  if (disconnected && (readback?.switch || readback?.connected)) why.push(`still connected (${readback.switch || 'connected'})`)
  if (!disconnected && mode !== 'none' && !readback?.switch) why.push('not connected')
  if (!disconnected && mode === 'none' && readback?.switch) why.push(`connected to ${readback.switch} in mode none`)
  return { verdict: why.length ? 'failed' : 'passed', expected, actual, why: why.join('; ') }
}

const aclReadPs = vm => {
  if (!VM_RE.test(vm)) throw new Error(`"${vm}" isn't a pool VM name`)
  return `$vm=Get-VM -Name '${vm}'; $a=@(Get-VMNetworkAdapter -VM $vm)[0]
@{ vm='${vm}'; switch=[string]$a.SwitchName; connected=[bool]$a.Connected; acls=@(Get-VMNetworkAdapterAcl -VM $vm -ErrorAction SilentlyContinue | ForEach-Object { @{ action=[string]$_.Action; direction=[string]$_.Direction; remote=[string]$_.RemoteAddress } }) } | ConvertTo-Json -Compress -Depth 4`
}

// ---------- probes: bounded, printing one JSON line each, always exit 0 ----------

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const URL_RE = /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9._~\/-]*)?$/

function checkProbe(p) {
  if (p.kind === 'tcp') {
    if (!IPV4_RE.test(p.ip || '') || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error(`bad tcp probe ${JSON.stringify(p)}`)
  } else if (p.kind === 'https') {
    if (!URL_RE.test(p.url || '')) throw new Error(`bad https probe ${JSON.stringify(p)}`)
  } else throw new Error(`unknown probe kind ${p.kind}`)
  if (!/^[A-Za-z0-9-]+$/.test(p.target || '')) throw new Error(`bad probe target name ${p.target}`)
  return p
}

/** One probe as a PowerShell 5.1 statement (Windows guests and the outer VM's own controls). */
function psProbe(p) {
  checkProbe(p)
  if (p.kind === 'tcp') {
    return `$c=New-Object Net.Sockets.TcpClient; $ok=$false; $e=''; try { $ok=$c.ConnectAsync('${p.ip}',${p.port}).Wait(5000) -and $c.Connected } catch { $e=[string]$_.Exception.GetBaseException().Message }; $c.Dispose(); [Console]::WriteLine((@{ probe='tcp'; target='${p.target}'; ip='${p.ip}'; port=${p.port}; ok=[bool]$ok; err=$e } | ConvertTo-Json -Compress))`
  }
  const host = new URL(p.url).hostname
  // Two attempts (HTTPS_TRIES), each recorded: one fetch under nesting timed out where the same guest's other fetch
  // passed. A reach on either is a reach; a negative row needs both to fail, so the retry never helps a block pass.
  return `$code=0; $addr=''; $e=''; $tries=@(); foreach ($t in 1..${HTTPS_TRIES}) { $code=0; $e=''; try { $addr=[string](@([Net.Dns]::GetHostAddresses('${host}') | Where-Object { $_.AddressFamily -eq 'InterNetwork' })[0]) } catch { $e='dns: ' + $_.Exception.GetBaseException().Message }; if ($addr) { try { $r=Invoke-WebRequest -Uri '${p.url}' -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 5; $code=[int]$r.StatusCode } catch { if ($_.Exception.Response) { $code=[int]$_.Exception.Response.StatusCode } else { $e=[string]$_.Exception.GetBaseException().Message } } }; $tries+=@{ code=$code; err=$e }; if ($code -ge 200 -and $code -lt 400) { break } }; [Console]::WriteLine((@{ probe='https'; target='${p.target}'; url='${p.url}'; address=$addr; code=$code; ok=($code -ge 200 -and $code -lt 400); err=$e; tries=$tries } | ConvertTo-Json -Compress -Depth 3))`
}

/** One probe as a bash statement (Linux guests): bash's /dev/tcp under timeout 5; python3 (cloud-init's) for HTTPS. */
function bashProbe(p) {
  checkProbe(p)
  if (p.kind === 'tcp') {
    return `if timeout 5 bash -c '</dev/tcp/${p.ip}/${p.port}' 2>/dev/null; then ok=true; else ok=false; fi; printf '{"probe":"tcp","target":"${p.target}","ip":"${p.ip}","port":${p.port},"ok":%s}\\n' "$ok"`
  }
  const py = `import json,socket,urllib.request,urllib.parse
u='${p.url}'; r={'probe':'https','target':'${p.target}','url':u,'address':'','code':0,'ok':False,'err':'','tries':[]}
for t in range(${HTTPS_TRIES}):
  r['code']=0; r['err']=''
  try:
    r['address']=socket.getaddrinfo(urllib.parse.urlparse(u).hostname,443,socket.AF_INET)[0][4][0]
    r['code']=urllib.request.urlopen(u,timeout=15).status
  except urllib.error.HTTPError as e: r['code']=e.code
  except Exception as e: r['err']=str(e)
  r['tries'].append({'code':r['code'],'err':r['err']})
  if 200<=r['code']<400: break
r['ok']=200<=r['code']<400
print(json.dumps(r))`
  return `timeout ${30 * HTTPS_TRIES} python3 -c ${shQuote(py)} || printf '{"probe":"https","target":"${p.target}","ok":false,"err":"python3 failed or timed out"}\\n'`
}
const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`

/** A batch of probes as one vm_run command for a guest shell, always exiting 0 (a failed probe isn't a failed run). */
function probeScript(shell, probes) {
  if (shell === 'powershell') return probes.map(psProbe).join('\n') + '\nexit 0'
  if (shell === 'bash') return probes.map(bashProbe).join('\n') + '\nexit 0'
  throw new Error(`no probes for shell ${shell}`)
}

/** The probe results ({"probe":...} lines) in a vm_run reply's text or a PowerShell output. */
function parseProbes(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const s = line.trim()
    if (!s.startsWith('{"') || !s.includes('"probe"')) continue
    try { out.push(JSON.parse(s)) } catch { /* not one of ours */ }
  }
  return out
}

// ---------- the matrix: what each mode should do, and which result controls each negative ----------

/** The targets: H80/H81 the outer VM's host-mode listeners, L the agreed LAN endpoint, IT an internet TCP port, HTTPS a page. */
function targets(cfg, hostAddress) {
  return {
    H80: { target: 'H80', kind: 'tcp', ip: hostAddress, port: PORT_ALLOWED },
    H81: { target: 'H81', kind: 'tcp', ip: hostAddress, port: PORT_DENIED },
    L: { target: 'L', kind: 'tcp', ip: cfg.lan.ip, port: cfg.lan.port },
    IT: { target: 'IT', kind: 'tcp', ip: cfg.internetTcp.ip, port: cfg.internetTcp.port },
    HTTPS: { target: 'HTTPS', kind: 'https', url: cfg.https }
  }
}

/** Per mode, each target's expected outcome. */
const EXPECT = Object.freeze({
  none: { H80: 'fail', L: 'fail', IT: 'fail', HTTPS: 'fail' },
  host: { H80: 'pass', H81: 'fail', L: 'fail', IT: 'fail', HTTPS: 'fail' },
  internet: { H80: 'fail', L: 'fail', IT: 'pass', HTTPS: 'pass' },
  'internet-lan': { L: 'pass', IT: 'pass', HTTPS: 'pass' }
})
/** For a target's negative rows: the same guest's mode where it must pass (H81 has none: its control is the outer VM's). */
const CONTROL_MODE = Object.freeze({ H80: 'host', L: 'internet-lan', IT: 'internet-lan', HTTPS: 'internet-lan' })

/**
 * Each row's verdict. results: { [`${os}|${mode}|${target}`]: probe }, outer: { [target]: probe } (the outer VM's own
 * reach, the positive control for every target), firewall: { h81Unclaimed: reason | null }. A negative row passes only
 * when its probe failed AND the outer VM reached the target AND (but for H81) the same guest reached it in its control
 * mode; without its controls it is unclaimed, never passed. A positive row passes when its probe succeeded.
 */
function classify(results, outer, { oses = OSES.map(o => o.key), firewall = {} } = {}) {
  const rows = []
  for (const o of oses) {
    for (const mode of MODES) {
      for (const [target, expect] of Object.entries(EXPECT[mode])) {
        const r = results[`${o}|${mode}|${target}`]
        const row = { os: o, mode, target, expect, ok: r ? !!r.ok : null, detail: r ? probeDetail(r) : 'not run' }
        // 18081 with a firewall that could let it through (or doesn't block by default): unclaimed whatever the probe saw,
        // so neither a reach (the environment's doing) nor a refusal (unproven isolation) is counted.
        if (r && target === 'H81' && firewall.h81Unclaimed) { row.verdict = 'unclaimed'; row.why = firewall.h81Unclaimed } else if (!r) { row.verdict = 'unclaimed'; row.why = 'not run' } else if (expect === 'pass') {
          // A miss when the outer VM itself couldn't reach the target is the environment's (a dead listener, no internet),
          // not the mode's: unclaimed, never failed. A reach is a pass whatever the control saw.
          if (r.ok) row.verdict = 'passed'
          else if (!outer[target]?.ok) { row.verdict = 'unclaimed'; row.why = 'positive control failed: the outer VM itself didn\'t reach it' } else { row.verdict = 'failed'; row.why = 'expected to reach the target' }
        } else if (r.ok) { row.verdict = 'failed'; row.why = 'reached a target it must not' } else {
          const outerOk = !!outer[target]?.ok
          const ctl = CONTROL_MODE[target] ? results[`${o}|${CONTROL_MODE[target]}|${target}`] : null
          const ctlOk = target === 'H81' ? true : !!ctl?.ok
          if (!outerOk) { row.verdict = 'unclaimed'; row.why = 'positive control failed: the outer VM itself didn\'t reach it' } else if (!ctlOk) { row.verdict = 'unclaimed'; row.why = `positive control failed: this guest didn't reach it in ${CONTROL_MODE[target]}` } else row.verdict = 'passed'
        }
        rows.push(row)
      }
    }
    // IPv6: no global IPv6 here, so no working cross-VM control: the Deny ::/0 rules are recorded, the row isn't passed.
    rows.push({ os: o, mode: 'all connected', target: 'IPv6', expect: 'fail', ok: null, verdict: 'unclaimed', why: 'Deny ::/0 ACLs read back (see the ACL rows); no end-to-end positive control possible here', detail: '' })
  }
  return rows
}
const probeDetail = r => (r.probe === 'https' ? `${r.url} -> ${r.address || 'no address'} code ${r.code}${r.err ? ` (${r.err})` : ''}${(r.tries || []).length > 1 ? ` (${r.tries.length} tries: ${r.tries.map(t => t.code || t.err || 0).join('; ')})` : ''}` : `${r.ip}:${r.port} ${r.ok ? 'connected' : 'no connection'}${r.err ? ` (${r.err})` : ''}`)

// ---------- the firewall around 18081 ----------

const v4in = (spec, ip) => {
  const s = String(spec).trim()
  if (/^any$/i.test(s) || s === '*') return true
  const range = /^([\d.]+)-([\d.]+)$/.exec(s)
  if (range) { const a = net.ip4(range[1]); const b = net.ip4(range[2]); const x = net.ip4(ip); return a !== null && b !== null ? x >= a && x <= b : true }
  if (net.ip4(s) !== null) return s === ip
  const c = net.cidr(s.includes('/') ? s : `${s}/32`)
  if (c) return net.overlaps(c, net.cidr(`${ip}/32`))
  if (/^[\d.]+\/[\d.]+$/.test(s)) return true // a dotted mask: not parsed, so counted as covering
  if (s.includes(':')) return false // IPv6
  return true // a keyword (LocalSubnet, Internet, ...): counted as covering, so a row is never passed on a guess
}
const portIn = (spec, port) => {
  const s = String(spec).trim()
  if (/^any$/i.test(s)) return true
  const m = /^(\d+)(?:-(\d+))?$/.exec(s)
  if (m) return port >= Number(m[1]) && port <= Number(m[2] ?? m[1])
  return /^(RPC|RPCEPMap|IPHTTPS|PlayToDiscovery|Teredo|mDNS)/i.test(s) ? false : true
}

/**
 * The enabled inbound Allow rules that could let a guest reach address:port on the given profile, through the listener
 * program nodePath. rules: [{ name, profile, protocol, localPort: [], localAddress: [], remoteAddress: [], program, service }].
 * Anything not understood counts as covering: a row is made unclaimed rather than passed on a guess.
 */
function broadAllows(rules, { port, address, guestAddress, profile, nodePath }) {
  return (rules || []).filter(r => {
    const prof = String(r.profile || 'Any')
    if (!/any/i.test(prof) && !prof.split(/,\s*/).some(p => p.toLowerCase() === String(profile).toLowerCase())) return false
    const proto = String(r.protocol || 'Any')
    if (!/^(any|tcp|6)$/i.test(proto)) return false
    if (!(r.localPort?.length ? r.localPort : ['Any']).some(p => portIn(p, port))) return false
    if (!(r.localAddress?.length ? r.localAddress : ['Any']).some(a => v4in(a, address))) return false
    if (!(r.remoteAddress?.length ? r.remoteAddress : ['Any']).some(a => v4in(a, guestAddress))) return false
    const prog = String(r.program || 'Any')
    if (!/^any$/i.test(prog) && !/^system$/i.test(prog) && prog.toLowerCase() !== String(nodePath).toLowerCase() && !/%/.test(prog)) return false
    if (!/^any$/i.test(String(r.service || 'Any'))) return false
    return true
  })
}

/** Why the 18081 rows can't be claimed, or null: the profile isn't blocking by default, or some allow rule covers it. */
function h81Unclaimed(fw, ctx) {
  if (!fw?.profile) return 'the host-mode interface\'s firewall profile couldn\'t be read'
  if (fw.profile.enabled !== true) return `the ${fw.profile.name} firewall profile is off`
  if (!/^(block|notconfigured)$/i.test(String(fw.profile.defaultInboundAction))) return `the ${fw.profile.name} profile's default inbound action is ${fw.profile.defaultInboundAction}`
  const covering = broadAllows(fw.rules, { ...ctx, port: PORT_DENIED, profile: fw.profile.name })
  return covering.length ? `an unrelated allow rule covers it: ${covering.map(r => r.name).join(', ')}` : null
}

const FIREWALL_PS = address => `$ip=Get-NetIPAddress -IPAddress '${address}' -ErrorAction Stop | Select-Object -First 1
$cp=Get-NetConnectionProfile -InterfaceIndex $ip.InterfaceIndex -ErrorAction SilentlyContinue
$cat=if ($cp) { [string]$cp.NetworkCategory } else { 'Public' }; $pn=if ($cat -eq 'DomainAuthenticated') { 'Domain' } else { $cat }
$p=Get-NetFirewallProfile -Name $pn
$pf=@{}; Get-NetFirewallPortFilter -All | ForEach-Object { $pf[$_.InstanceID]=$_ }
$af=@{}; Get-NetFirewallAddressFilter -All | ForEach-Object { $af[$_.InstanceID]=$_ }
$apf=@{}; Get-NetFirewallApplicationFilter -All | ForEach-Object { $apf[$_.InstanceID]=$_ }
$sf=@{}; Get-NetFirewallServiceFilter -All | ForEach-Object { $sf[$_.InstanceID]=$_ }
$rules=@(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow | ForEach-Object { $id=$_.InstanceID; @{ name=[string]$_.Name; display=[string]$_.DisplayName; profile=[string]$_.Profile; protocol=[string]$pf[$id].Protocol; localPort=@($pf[$id].LocalPort | ForEach-Object { [string]$_ }); localAddress=@($af[$id].LocalAddress | ForEach-Object { [string]$_ }); remoteAddress=@($af[$id].RemoteAddress | ForEach-Object { [string]$_ }); program=[string]$apf[$id].Program; service=[string]$sf[$id].Service } })
@{ category=$cat; profile=@{ name=$pn; enabled=[bool]($p.Enabled -eq 'True'); defaultInboundAction=[string]$p.DefaultInboundAction }; ownRule18081=[bool](Get-NetFirewallRule | Where-Object { $_.DisplayName -like '*18081*' }); rules=$rules } | ConvertTo-Json -Compress -Depth 5`

// ---------- SSH ----------

/** ssh's arguments for one account: pinned host key only, its own key only, no prompts. */
function sshArgs(cfg, role) {
  if (!USERS[role]) throw new Error(`no account for ${role}`)
  return ['-i', path.join(cfg.keyDir, `id_${role}`), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${path.join(cfg.keyDir, 'known_hosts')}`, '-o', `GlobalKnownHostsFile=${path.join(cfg.keyDir, 'known_hosts')}`,
    '-o', `HostKeyAlias=${HOST_ALIAS}`, '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30']
}
const encodePs = script => Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64')

/** The real remote: ssh/scp to the outer VM, every call logged. */
class SshRemote {
  constructor(cfg, log) { this.cfg = cfg; this.log = log; this.cp = require('child_process') }
  run(role, script, { input, timeoutMs = 30 * 60_000, raw = false } = {}) {
    const cmd = raw ? script : `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePs(script)}`
    const t0 = Date.now()
    const r = this.cp.spawnSync('ssh', [...sshArgs(this.cfg, role), `${USERS[role]}@${this.cfg.address}`, cmd], { input: input ?? '', encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    const res = { code: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error) : ''), ms: Date.now() - t0 }
    this.log({ kind: 'ssh', role, script, input: input ? '(input given)' : undefined, ...res })
    return res
  }
  copy(role, local, remote) {
    const t0 = Date.now()
    const r = this.cp.spawnSync('scp', [...sshArgs(this.cfg, role), local, `${USERS[role]}@${this.cfg.address}:${remote.replace(/\\/g, '/')}`], { encoding: 'utf8', windowsHide: true, timeout: 60 * 60_000 })
    const res = { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - t0 }
    this.log({ kind: 'scp', role, local, remote, ...res })
    return res
  }
  /** A session as proofuser: nested-inner.js bridging to server.js. Returns { call(tool, args), close() }. */
  session(env = {}) {
    const inner = `${this.cfg.repoDir}\\servers\\hyper-v\\test\\live\\nested-inner.js`
    const child = this.cp.spawn('ssh', [...sshArgs(this.cfg, 'user'), `${USERS.user}@${this.cfg.address}`, `"${GUEST_NODE}" "${inner}" ${Buffer.from(JSON.stringify(env)).toString('base64')}`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    return bridgeSession(child, this.log)
  }
}

/** The host side of nested-inner.js's line protocol: { id, tool, args } out, { id, text, isError } back. */
function bridgeSession(child, log) {
  const { createInterface } = require('readline')
  const pending = new Map()
  let id = 0
  let stderr = ''
  child.stderr.on('data', d => { stderr += d })
  createInterface({ input: child.stdout }).on('line', l => {
    let m
    try { m = JSON.parse(l) } catch { return }
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  })
  const exited = new Promise(res => child.on('exit', code => { for (const p of pending.values()) p({ text: `session ended (${code}): ${stderr.slice(-2000)}`, isError: true }); pending.clear(); res(code) }))
  return {
    call(tool, args = {}) {
      return new Promise(res => {
        const n = ++id
        pending.set(n, m => { log({ kind: 'tool', tool, args, isError: !!m.isError, text: m.text }); res({ text: m.text || '', isError: !!m.isError }) })
        child.stdin.write(JSON.stringify({ id: n, tool, args }) + '\n')
      })
    },
    async close() { child.stdin.end(JSON.stringify({ end: true }) + '\n'); return exited }
  }
}

// ---------- the guard and the steps ----------

/** Stops unless the remote is the outer VM (targetProblems); logs what it saw either way. */
function assertTarget(remote, expected, log, why) {
  const r = remote.run('admin', IDENTITY_PS)
  let observed = null
  try { observed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()) } catch { /* below */ }
  const problems = r.code === 0 && observed ? targetProblems(expected, observed) : [`identity read failed (exit ${r.code}): ${r.stderr.slice(0, 500)}`]
  log({ kind: 'assertTarget', before: why, observed, problems })
  if (problems.length) throw new Error(`Not the outer VM (before ${why}): ${problems.join('; ')}. Nothing more was done.`)
  return observed
}

const jsonOut = r => { if (r.code !== 0) throw new Error(`remote step failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 2000)}`); return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()) }

/**
 * The listeners on the outer VM's host-mode address: started as admin, pid and start time recorded, stopped by both.
 * Started through WMI (Win32_Process.Create), not Start-Process: Windows' sshd puts a session's processes in a job that
 * is killed when the session ends, which ended the first live run's listener 2 s after this step returned. A WMI-made
 * process is the WMI service's child, outside that job. LISTENERS_CHECK_PS confirms it from a later session.
 */
const LISTENERS_START_PS = (repoDir, address) => `$node='${GUEST_NODE}'; if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'node is not installed: run install-node' }
$cmd='"' + $node + '" "${repoDir}\\servers\\hyper-v\\test\\live\\nested-listener.js" ${address} ${PORT_ALLOWED} ${PORT_DENIED}'
$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine=$cmd; CurrentDirectory='${GUEST_ROOT}' }
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
$p=Get-Process -Id ([int]$r.ProcessId)
$rec=@{ pid=$p.Id; start=$p.StartTime.ToUniversalTime().ToString('o'); node=$node }
$rec | ConvertTo-Json -Compress | Set-Content -LiteralPath '${GUEST_LISTENER}'
Start-Sleep -Seconds 2
$p.Refresh(); if ($p.HasExited) { throw "the listener exited ($($p.ExitCode))" }
$rec | ConvertTo-Json -Compress`
/** From a new SSH session: the recorded listener still runs (that pid, that start time) and listens on both ports. */
const LISTENERS_CHECK_PS = address => `$rec=Get-Content -LiteralPath '${GUEST_LISTENER}' -Raw | ConvertFrom-Json
$q=Get-Process -Id $rec.pid -ErrorAction SilentlyContinue
$running=[bool]($q -and $q.StartTime.ToUniversalTime().ToString('o') -eq $rec.start)
$ports=@(Get-NetTCPConnection -State Listen -LocalAddress '${address}' -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $rec.pid } | ForEach-Object { [int]$_.LocalPort })
@{ running=$running; listening=@($ports | Sort-Object -Unique) } | ConvertTo-Json -Compress`
// Stops the recorded listener (only that pid with that start time), removes the named rule, then reads both back. The
// record is kept while the listener still runs, so a later cleanup can find it.
const LISTENERS_STOP_PS = `$out=@{ record=$null; listenerRunning=$false; rule=$false }
$mine={ param($r) $q=Get-Process -Id $r.pid -ErrorAction SilentlyContinue; $q -and $q.StartTime.ToUniversalTime().ToString('o') -eq $r.start }
if (Test-Path -LiteralPath '${GUEST_LISTENER}') { $rec=Get-Content -LiteralPath '${GUEST_LISTENER}' -Raw | ConvertFrom-Json; $out.record=$rec
  if (& $mine $rec) { Stop-Process -Id $rec.pid -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
  $out.listenerRunning=[bool](& $mine $rec)
  if (-not $out.listenerRunning) { Remove-Item -LiteralPath '${GUEST_LISTENER}' } }
if (Get-NetFirewallRule -DisplayName '${FW_RULE}' -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -DisplayName '${FW_RULE}' -ErrorAction SilentlyContinue }
$out.rule=[bool](Get-NetFirewallRule -DisplayName '${FW_RULE}' -ErrorAction SilentlyContinue)
$out | ConvertTo-Json -Compress -Depth 3`

/** What the user removes by hand when the driver's cleanup can't run or isn't verified (in the VM, admin). */
const manualCleanup = listener => `in the outer VM (admin): Remove-NetFirewallRule -DisplayName '${FW_RULE}'${listener?.pid ? `; and the listener: Get-Process -Id ${listener.pid} (only if its StartTime is ${listener.start}) | Stop-Process` : `; and any listener recorded in ${GUEST_LISTENER}`}`

/**
 * The listeners' and rule's cleanup, guarded and verified: identity first (no remote change on a target it can't
 * confirm), then the stop, then its readback. Returns { verified, why, manual } and never throws: a failure is reported
 * with what the user removes by hand, never as success.
 */
function guardedCleanup(remote, expected, log, listener) {
  let result
  try {
    assertTarget(remote, expected, log, 'cleaning up the listeners and the 18080 rule')
    const r = remote.run('admin', LISTENERS_STOP_PS)
    let back = null
    try { back = r.code === 0 ? JSON.parse(r.stdout.trim().split(/\r?\n/).pop()) : null } catch { /* below */ }
    if (!back) result = { verified: false, why: `the cleanup's call failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 500)}` }
    else if (back.listenerRunning || back.rule) result = { verified: false, why: `read back after the cleanup: ${[back.listenerRunning && 'the listener still runs', back.rule && 'the rule is still there'].filter(Boolean).join(', ')}` }
    else result = { verified: true, why: '' }
  } catch (e) { result = { verified: false, why: `not cleaned up: ${e.message}` } }
  if (!result.verified) result.manual = manualCleanup(listener)
  log({ kind: 'cleanup', listener: listener || null, ...result })
  return result
}
const FW_ADD_PS = (address, subnet) => `if (-not (Get-NetFirewallRule -DisplayName '${FW_RULE}' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -DisplayName '${FW_RULE}' -Direction Inbound -Protocol TCP -LocalPort ${PORT_ALLOWED} -LocalAddress ${address} -RemoteAddress ${subnet} -Action Allow | Out-Null }
@(Get-NetFirewallRule -DisplayName '${FW_RULE}' | ForEach-Object { @{ name=[string]$_.DisplayName; enabled=[string]$_.Enabled } }) | ConvertTo-Json -Compress`
const DEFAULT_SWITCH_PS = `$a=Get-NetIPAddress -InterfaceAlias 'vEthernet (Default Switch)' -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1
@{ gateway=[string]$a.IPAddress; prefix=[int]$a.PrefixLength } | ConvertTo-Json -Compress`

const vmFromAcquire = text => { const m = /Leased (\S+) \(lease/.exec(text); if (!m || !VM_RE.test(m[1])) throw new Error(`no VM in vm_acquire's reply: ${text.slice(0, 300)}`); return m[1] }

/**
 * The matrix. remote: SshRemote (or a test double with run/session); expected: the identity; cfg: lan, internetTcp, https,
 * repoDir, hostAddress, subnet. Returns { rows, acl, refusals } and always stops the listeners and removes the rule.
 */
async function matrix(remote, expected, cfg, log) {
  const hostAddress = cfg.hostAddress || '10.137.42.1'
  const subnet = cfg.subnet || '10.137.42.0/24'
  const T = targets(cfg, hostAddress)
  const results = {}
  const outer = {}
  const aclRows = []
  let firewall = {}
  let listener = null
  let failure = null
  // Nothing is started on a target never confirmed; the cleanup confirms it again itself (guardedCleanup).
  assertTarget(remote, expected, log, 'starting the listeners and adding the 18080 rule')
  try {
    listener = jsonOut(remote.run('admin', LISTENERS_START_PS(cfg.repoDir, hostAddress)))
    log({ kind: 'listener', listener })
    log({ kind: 'firewallRule', rule: jsonOut(remote.run('admin', FW_ADD_PS(hostAddress, subnet))) })
    const alive = jsonOut(remote.run('admin', LISTENERS_CHECK_PS(hostAddress)))
    log({ kind: 'listenerCheck', ...alive })
    const ports = (alive.listening || []).map(Number)
    if (!alive.running || !ports.includes(PORT_ALLOWED) || !ports.includes(PORT_DENIED)) throw new Error(`the listener isn't running and listening on ${hostAddress}:${PORT_ALLOWED} and ${PORT_DENIED} after its session ended (${JSON.stringify(alive)}): no guest was run`)
    // The outer VM's own reach: the positive control of every target (both listeners locally, the LAN, the internet).
    for (const p of parseProbes(remote.run('admin', Object.values(T).map(psProbe).join('\n')).stdout)) outer[p.target] = p
    if (!outer.H80?.ok || !outer.H81?.ok) throw new Error(`the outer VM can't reach its own listeners (18080: ${outer.H80 ? probeDetail(outer.H80) : 'no result'}; 18081: ${outer.H81 ? probeDetail(outer.H81) : 'no result'}): no guest was run`)
    const fw = jsonOut(remote.run('admin', FIREWALL_PS(hostAddress)))
    firewall = { h81Unclaimed: h81Unclaimed(fw, { address: hostAddress, guestAddress: '10.137.42.10', nodePath: listener.node }) }
    log({ kind: 'firewall', profile: fw.profile, category: fw.category, ownRule18081: fw.ownRule18081, h81Unclaimed: firewall.h81Unclaimed, coveringRules: broadAllows(fw.rules, { address: hostAddress, guestAddress: '10.137.42.10', nodePath: listener.node, port: PORT_DENIED, profile: fw.profile?.name }) })
    const dsw = jsonOut(remote.run('admin', DEFAULT_SWITCH_PS))
    for (const o of OSES) {
      assertTarget(remote, expected, log, `leasing the ${o.key} VM`)
      const s = remote.session()
      let released = false
      try {
        const acq = await s.call('vm_acquire', { minutes: 240, ...o.acquire })
        if (acq.isError) throw new Error(`vm_acquire (${o.key}) failed: ${acq.text}`)
        const vm = vmFromAcquire(acq.text)
        for (const mode of MODES) {
          const st = await s.call('vm_start', { network: mode })
          if (st.isError) { log({ kind: 'modeFailed', os: o.key, mode, text: st.text }); continue }
          const ctx = { hostAddress, gateway: dsw.gateway }
          aclRows.push({ os: o.key, mode, when: 'running', ...aclVerdict(mode, ctx, jsonOut(remote.run('admin', aclReadPs(vm)))) })
          const probes = Object.keys(EXPECT[mode]).map(k => T[k])
          const run = await s.call('vm_run', { command: probeScript(o.shell, probes), shell: o.shell, timeoutSec: 300 })
          for (const p of parseProbes(run.text)) results[`${o.key}|${mode}|${p.target}`] = p
        }
        const stop = await s.call('vm_stop')
        aclRows.push({ os: o.key, mode: '-', when: 'after vm_stop', stopText: stop.text, ...aclVerdict('none', {}, jsonOut(remote.run('admin', aclReadPs(vm))), { disconnected: true }) })
        const rel = await s.call('vm_release')
        released = !rel.isError
        aclRows.push({ os: o.key, mode: '-', when: 'after vm_release', releaseText: rel.text, ...aclVerdict('none', {}, jsonOut(remote.run('admin', aclReadPs(vm))), { disconnected: true }) })
      } finally {
        if (!released) await s.call('vm_release').catch(() => {})
        await s.close()
      }
    }
  } catch (e) { failure = e }
  const cleanup = guardedCleanup(remote, expected, log, listener)
  if (failure) throw new Error(`${failure.message}${cleanup.verified ? ' (the listeners and rule were cleaned up, verified)' : ` CLEANUP NOT VERIFIED: ${cleanup.why}. Remove by hand, ${cleanup.manual}`}`)
  return { rows: classify(results, outer, { firewall }), acl: aclRows, outer, cleanup }
}

/** One run asked above a cap: passes only when refused for that cap (the helper's "network X is above the pool's/policy's Y"). */
async function refusal(remote, expected, osKey, mode, cap, log) {
  const o = OSES.find(x => x.key === osKey)
  if (!o || !MODES.includes(mode) || !['pool', 'policy'].includes(cap)) throw new Error('refusal <windows|debian> <mode> <pool|policy>')
  assertTarget(remote, expected, log, `a ${cap} refusal check`)
  const s = remote.session()
  try {
    const acq = await s.call('vm_acquire', { minutes: 30, ...o.acquire })
    if (acq.isError) throw new Error(`vm_acquire failed: ${acq.text}`)
    const st = await s.call('vm_start', { network: mode })
    const refused = st.isError && new RegExp(`network ${mode.replace('-', '\\-')} is above the ${cap}'s`, 'i').test(st.text)
    return { os: osKey, mode, cap, verdict: refused ? 'passed' : 'failed', text: st.text }
  } finally { await s.call('vm_release').catch(() => {}); await s.close() }
}

/** The results as Markdown for the card: each row's verdict, why, and what the probe saw. */
function report(run) {
  const lines = [`Nested proof run ${run.id}: commit ${run.commit}, outer VM ${run.target?.hostname} (BIOS ${normGuid(run.target?.uuid)})`, '', '| OS | mode | target | expect | verdict | detail |', '|---|---|---|---|---|---|']
  for (const r of run.rows || []) lines.push(`| ${r.os} | ${r.mode} | ${r.target} | ${r.expect} | **${r.verdict}**${r.why ? ` (${r.why})` : ''} | ${r.detail} |`)
  lines.push('', '| OS | when | mode | ACLs | verdict |', '|---|---|---|---|---|')
  for (const a of run.acl || []) lines.push(`| ${a.os} | ${a.when} | ${a.mode} | ${a.actual.join('<br>') || '(none)'} | **${a.verdict}**${a.why ? ` (${a.why})` : ''} |`)
  for (const r of run.refusals || []) lines.push('', `Refusal ${r.os} ${r.mode} above the ${r.cap}: **${r.verdict}**: ${r.text.split('\n')[0]}`)
  if (run.cleanup) lines.push('', run.cleanup.verified ? 'Cleanup: the listeners stopped and the 18080 rule removed (read back).' : `**CLEANUP NOT VERIFIED**: ${run.cleanup.why}. Remove by hand, ${run.cleanup.manual}`)
  return lines.join('\n')
}

/** $pwsh: the outer VM's registered PowerShell 7 (HKLM), as the helper finds it; throws if there's none. */
const PWSH_PS = `$pwsh = @(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions' -ErrorAction SilentlyContinue | ForEach-Object { Join-Path ([string](Get-ItemProperty -LiteralPath $_.PSPath).InstallLocation) 'pwsh.exe' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) | Select-Object -Last 1
if (-not $pwsh) { throw 'PowerShell 7 is not installed in the outer VM: run install-pwsh' }`

/** The command line's other admin scripts, kept here so the tests can parse each one. */
const SCRIPTS = {
  preflight: `@{ elevated=[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); hyperv=[string](Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V).State; vmhost=[bool](Get-VMHost -ErrorAction SilentlyContinue); defaultSwitch=[bool](Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue); dsw=@(Get-NetIPAddress -InterfaceAlias 'vEthernet (Default Switch)' -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" }); v4=@(Get-NetIPAddress -AddressFamily IPv4 | ForEach-Object { "$($_.InterfaceAlias) $($_.IPAddress)/$($_.PrefixLength)" }); node=[string](Get-Item -LiteralPath '${GUEST_NODE}' -ErrorAction SilentlyContinue).VersionInfo.ProductVersion; ssh=[bool](Get-Command ssh -ErrorAction SilentlyContinue); freeGB=[math]::Round((Get-PSDrive C).Free/1GB) } | ConvertTo-Json -Compress`,
  deployPrepare: `New-Item -ItemType Directory '${GUEST_ROOT}\\upload' -Force | Out-Null; @{ ok=$true } | ConvertTo-Json -Compress`,
  deployUnpack: (commit, sha256, repoDir) => {
    if (!SHA_RE.test(commit) || !/^[0-9a-f]{64}$/.test(sha256) || repoDir !== `${GUEST_ROOT}\\repo-${commit.slice(0, 12)}`) throw new Error('bad deploy arguments')
    return `$z='${GUEST_ROOT}\\upload\\repo-${commit.slice(0, 12)}.zip'; if ((Get-FileHash -LiteralPath $z -Algorithm SHA256).Hash.ToLower() -ne '${sha256}') { throw 'the copied archive differs' }
if (Test-Path -LiteralPath '${repoDir}') { throw '${repoDir} exists' }
Expand-Archive -LiteralPath $z -DestinationPath '${repoDir}'; icacls '${repoDir}' /inheritance:r /grant 'Administrators:(OI)(CI)F' /grant 'SYSTEM:(OI)(CI)F' /grant 'Users:(OI)(CI)RX' | Out-Null
@{ repoDir='${repoDir}'; sha256='${sha256}' } | ConvertTo-Json -Compress`
  },
  /** A file uploaded to C:\hvnest-proof\upload: its SHA-256 must match the host's. */
  uploadCheck: (name, sha256) => {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(name) || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('bad upload arguments')
    return `$f='${GUEST_ROOT}\\upload\\${name}'; $h=(Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower(); if ($h -ne '${sha256}') { Remove-Item -LiteralPath $f; throw 'the copy differs from the host file: removed' }
@{ path=$f; sha256=$h; bytes=(Get-Item -LiteralPath $f).Length } | ConvertTo-Json -Compress`
  },
  /** Node from an uploaded MSI, only when Authenticode-signed by the OpenJS Foundation and valid. */
  installNode: name => {
    if (!/^node-v\d+\.\d+\.\d+-x64\.msi$/.test(name)) throw new Error('bad node msi name (node-vX.Y.Z-x64.msi)')
    return `$f='${GUEST_ROOT}\\upload\\${name}'; $s=Get-AuthenticodeSignature -LiteralPath $f
if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O="?OpenJS Foundation') { throw "the MSI's signature isn't a valid OpenJS Foundation one ($($s.Status), $($s.SignerCertificate.Subject)): not installed" }
$p=Start-Process msiexec.exe -ArgumentList @('/i', ('"' + $f + '"'), '/qn', '/norestart') -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "msiexec exited $($p.ExitCode)" }
@{ node=[string](Get-Item -LiteralPath '${GUEST_NODE}').VersionInfo.ProductVersion; signer=[string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`
  },
  /** MC-1575: PowerShell 7 from an uploaded MSI, only when Authenticode-signed by Microsoft and valid; its registration read back. */
  installPwsh: name => {
    if (!/^PowerShell-\d+\.\d+\.\d+-win-x64\.msi$/.test(name)) throw new Error('bad PowerShell msi name (PowerShell-X.Y.Z-win-x64.msi)')
    return `$f='${GUEST_ROOT}\\upload\\${name}'; $s=Get-AuthenticodeSignature -LiteralPath $f
if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw "the MSI's signature isn't a valid Microsoft one ($($s.Status), $($s.SignerCertificate.Subject)): not installed" }
$p=Start-Process msiexec.exe -ArgumentList @('/i', ('"' + $f + '"'), '/qn', '/norestart') -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "msiexec exited $($p.ExitCode)" }
${PWSH_PS}
@{ pwsh=$pwsh; version=[string](Get-Item -LiteralPath $pwsh).VersionInfo.ProductVersion; signer=[string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress`
  },
  /**
   * Setup inside the outer VM, by engine (MC-1575): 'launcher' is the user's own line (cmd /c call install.cmd, which
   * picks Windows PowerShell there); '7' runs install.ps1 under the registered PowerShell 7, so the service runs hv.ps1
   * under 7. Either way the engine setup recorded for the service is printed after.
   */
  setup: (repoDir, max, engine = 'launcher') => {
    if (!/^C:\\hvnest-proof\\repo-[0-9a-f]{12}$/.test(repoDir) || !['InternetLan', 'Host'].includes(max) || !['launcher', '7'].includes(engine)) throw new Error('bad setup arguments')
    const args = `-DiskFolder C:\\hyperv-mcp-disks -User '${HOST_ALIAS}\\${USERS.user}' -MaxNetwork ${max} -MaxCoresPerVm 2 -MaxVms 2`
    const run = engine === '7'
      ? `${PWSH_PS}\n& $pwsh -NoProfile -ExecutionPolicy Bypass -File '${repoDir}\\servers\\hyper-v\\setup\\install.ps1' ${args} *>&1 | Out-String -Width 400`
      : `cmd /c call "${repoDir}\\servers\\hyper-v\\setup\\install.cmd" ${args.replace(/'/g, '"')} *>&1 | Out-String -Width 400`
    return `${run}; "exit=$LASTEXITCODE"
"engine: " + [string](Get-Content -LiteralPath 'C:\\Program Files\\hyperv-mcp\\host.config' -ErrorAction SilentlyContinue | Where-Object { $_ -like 'powershell=*' })`
  }
}

/** The approve line a user types (MC-1575), run raw (sshd's shell is cmd), so through the launcher as a user's is. */
const approveLine = plan => {
  if (!PLAN_RE.test(plan || '')) throw new Error('approve <p-...>')
  return `cmd /c call "C:\\Program Files\\hyperv-mcp\\approve.cmd" -Plan ${plan}`
}

// ---------- the command line ----------

function loadConfig() {
  const file = path.join(KEY_DIR, 'proof.json')
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!cfg.address || !/^[A-Za-z0-9.-]+$/.test(cfg.address)) throw new Error(`${file}: address must be a host name or IPv4 address`)
  if (!cfg.token) throw new Error(`${file}: token (from V1's output) is missing`)
  cfg.lan = cfg.lan || { ip: '192.168.1.1', port: 80 }
  cfg.internetTcp = cfg.internetTcp || { ip: '1.1.1.1', port: 443 }
  cfg.https = cfg.https || 'https://www.microsoft.com/'
  cfg.keyDir = KEY_DIR
  return cfg
}

function newLog(name) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`
  const dir = path.join(LOG_ROOT, id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'calls.jsonl')
  const log = e => { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n'); if (e.kind !== 'ssh' && e.kind !== 'tool') process.stderr.write(`${e.kind}${e.before ? `: ${e.before}` : ''}${e.problems?.length ? ` PROBLEMS ${e.problems.join('; ')}` : ''}\n`) }
  return { id, dir, log }
}

async function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'keys') {
    fs.mkdirSync(KEY_DIR, { recursive: true })
    for (const role of Object.keys(USERS)) {
      const key = path.join(KEY_DIR, `id_${role}`)
      if (fs.existsSync(key)) throw new Error(`${key} exists: not replaced`)
      const r = require('child_process').spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `hvnest-proof ${role}`, '-f', key], { stdio: 'inherit' })
      if (r.status !== 0) throw new Error('ssh-keygen failed')
      console.log(`${role}: ${fs.readFileSync(key + '.pub', 'utf8').trim()}`)
    }
    return
  }
  if (cmd === 'pin') {
    const line = rest.join(' ').trim()
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$/.test(line)) throw new Error('give the host key line V2 printed (ssh-ed25519 AAAA...)')
    const kh = path.join(KEY_DIR, 'known_hosts')
    if (fs.existsSync(kh)) throw new Error(`${kh} exists: a pinned key is never replaced by the driver (delete it yourself if the VM was rebuilt)`)
    fs.writeFileSync(kh, `${HOST_ALIAS} ${line.split(' ').slice(0, 2).join(' ')}\n`)
    console.log(`pinned ${HOST_ALIAS} in ${kh}`)
    return
  }
  const cfg = loadConfig()
  const expected = { ...parseIdentityTxt(fs.readFileSync(path.join(HOST_ROOT, 'identity.txt'), 'utf8')), token: cfg.token }
  const { id, dir, log } = newLog(cmd || 'none')
  const remote = new SshRemote(cfg, log)
  cfg.repoDir = cfg.repoDir || (cfg.commit ? `${GUEST_ROOT}\\repo-${cfg.commit.slice(0, 12)}` : null)
  log({ kind: 'run', cmd, args: rest, commit: cfg.commit || null, expected: { biosGuid: expected.biosGuid, vmId: expected.vmId } })
  const target = assertTarget(remote, expected, log, cmd)
  const needRepo = () => { if (!cfg.repoDir) throw new Error('deploy first (proof.json then names the commit)') }

  if (cmd === 'preflight') {
    const r = remote.run('admin', SCRIPTS.preflight)
    const p = jsonOut(r)
    const clash = p.v4.filter(x => { const c = net.cidr(x.split(' ').pop()); return c && net.overlaps(c, net.cidr('10.137.42.0/24')) })
    console.log(JSON.stringify({ ...p, hostSubnetClash: clash }, null, 2))
    return
  }
  if (cmd === 'deploy') {
    const i = rest.indexOf('--commit')
    const commit = i >= 0 ? rest[i + 1] : require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (!SHA_RE.test(commit)) throw new Error('a full commit sha')
    const zip = path.join(dir, `repo-${commit.slice(0, 12)}.zip`)
    require('child_process').execFileSync('git', ['archive', '--format=zip', '-o', zip, commit], { cwd: path.join(__dirname, '..', '..', '..', '..') })
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
    const repoDir = `${GUEST_ROOT}\\repo-${commit.slice(0, 12)}`
    jsonOut(remote.run('admin', SCRIPTS.deployPrepare))
    if (remote.copy('admin', zip, `${GUEST_ROOT}\\upload\\repo-${commit.slice(0, 12)}.zip`).code !== 0) throw new Error('scp failed')
    assertTarget(remote, expected, log, 'unpacking the repo')
    console.log(JSON.stringify(jsonOut(remote.run('admin', SCRIPTS.deployUnpack(commit, sha256, repoDir)))))
    fs.writeFileSync(path.join(KEY_DIR, 'proof.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(KEY_DIR, 'proof.json'), 'utf8')), commit, repoDir }, null, 2))
    return
  }
  if (cmd === 'upload' || cmd === 'install-node' || cmd === 'install-pwsh') {
    const local = rest[0]
    if (!local || !fs.statSync(local).isFile()) throw new Error(`${cmd} <local file>`)
    const name = path.basename(local)
    const check = cmd === 'install-node' ? SCRIPTS.installNode(name) : cmd === 'install-pwsh' ? SCRIPTS.installPwsh(name) : null // validates the name before anything is sent
    const sha256 = await new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(local).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej) })
    jsonOut(remote.run('admin', SCRIPTS.deployPrepare))
    if (remote.copy('admin', local, `${GUEST_ROOT}\\upload\\${name}`).code !== 0) throw new Error('scp failed')
    assertTarget(remote, expected, log, `checking the upload of ${name}`)
    console.log(JSON.stringify(jsonOut(remote.run('admin', SCRIPTS.uploadCheck(name, sha256)))))
    if (check) { assertTarget(remote, expected, log, `installing ${cmd === 'install-pwsh' ? 'PowerShell 7' : 'node'}`); console.log(JSON.stringify(jsonOut(remote.run('admin', check)))) }
    return
  }
  if (cmd === 'setup') {
    needRepo()
    const i = rest.indexOf('--max-network')
    const max = i >= 0 ? rest[i + 1] : ''
    if (!['InternetLan', 'Host'].includes(max)) throw new Error('setup --max-network InternetLan|Host [--engine launcher|7]')
    const e = rest.indexOf('--engine')
    const script = SCRIPTS.setup(cfg.repoDir, max, e >= 0 ? rest[e + 1] : 'launcher') // validates before anything is sent
    assertTarget(remote, expected, log, 'setup')
    const r = remote.run('admin', script, { timeoutMs: 60 * 60_000 })
    console.log(r.stdout, r.stderr)
    return
  }
  if (cmd === 'approve') {
    const plan = rest[0]
    const line = approveLine(plan)
    assertTarget(remote, expected, log, `reading plan ${plan}`)
    const first = remote.run('admin', line, { raw: true, input: 'no\r\n' }) // cancels: only shows the plan and its digest
    const m = /Digest: ([0-9a-f]{64})/.exec(first.stdout)
    if (!m) throw new Error(`approve.ps1 showed no digest: ${(first.stdout + first.stderr).slice(-1500)}`)
    console.log(first.stdout)
    assertTarget(remote, expected, log, `approving plan ${plan}`)
    const second = remote.run('admin', line, { raw: true, input: `${m[1].slice(0, 6)}\r\n` })
    console.log(second.stdout, second.stderr)
    if (!/Approved plan/.test(second.stdout)) throw new Error('not approved')
    return
  }
  if (cmd === 'call') {
    needRepo()
    const [tool, json] = rest
    if (!/^(vm|pool)_[a-z_]+$/.test(tool || '')) throw new Error('call <tool> [json]')
    if (/^pool_(create|resize|remove|refresh|checkpoint)$/.test(tool)) assertTarget(remote, expected, log, tool)
    const s = remote.session()
    try { const r = await s.call(tool, json ? JSON.parse(json) : {}); console.log(r.text); if (r.isError) process.exitCode = 1 } finally { await s.close() }
    return
  }
  if (cmd === 'matrix') {
    needRepo()
    const out = await matrix(remote, expected, cfg, log)
    const run = { id, commit: cfg.commit, target, ...out }
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(run, null, 2))
    fs.writeFileSync(path.join(dir, 'results.md'), report(run))
    console.log(report(run))
    console.log(`\nlogs: ${dir}`)
    if (!run.cleanup?.verified) process.exitCode = 1
    return
  }
  if (cmd === 'refusal') {
    needRepo()
    const r = await refusal(remote, expected, rest[0], rest[1], rest[2], log)
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(r, null, 2))
    console.log(`${r.verdict}: ${r.text}`)
    return
  }
  if (cmd === 'cleanup') {
    const c = guardedCleanup(remote, expected, log, null)
    console.log(c.verified ? 'cleaned up: no listener running, no 18080 rule (read back)' : `CLEANUP NOT VERIFIED: ${c.why}. Remove by hand, ${c.manual}`)
    if (!c.verified) process.exitCode = 1
    return
  }
  throw new Error(`unknown command ${cmd}: see the header of ${__filename}`)
}

module.exports = {
  HOSTNAME, HOST_ROOT, FW_RULE, EXPECT, CONTROL_MODE, MODES, OSES,
  normGuid, parseIdentityTxt, targetProblems, expectedAcls, aclVerdict, aclReadPs, psProbe, bashProbe, probeScript,
  parseProbes, targets, classify, broadAllows, h81Unclaimed, sshArgs, assertTarget, matrix, refusal, report, bridgeSession,
  vmFromAcquire, SCRIPTS, approveLine, IDENTITY_PS, FIREWALL_PS, LISTENERS_START_PS, LISTENERS_CHECK_PS, LISTENERS_STOP_PS, FW_ADD_PS, DEFAULT_SWITCH_PS, guardedCleanup, VM_RE
}

if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1 })
