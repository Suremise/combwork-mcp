// MC-1563: hv.ps1's $GuestNet, the Windows guest's own network for a mode, run for real with Windows PowerShell 5.1
// against stand-in network cmdlets that return real CimInstances (as Get-NetAdapter does in a guest). The live proof
// (MC-1559) found every Windows start in host, internet or internet-lan failing: an if-expression unrolled the one
// matching adapter to a single CimInstance, whose .Count is $null in PowerShell 5.1, so "exactly one" never held.
// MC-1565: the stubs keep each adapter's DHCP state, addresses and default route, because what $GuestNet may do depends
// on them: found live, Set-NetIPInterface -Dhcp Enabled on an adapter already on DHCP drops its lease (APIPA, no new
// request for minutes), and removing NetMgmt default routes removes DHCP's own; an explicit renew brings it back.
//
// Safety: this runs on the developer's PC, so the block must never reach a real network cmdlet. Shadowing them with
// functions isn't enough (the first unstubbed NetTCPIP call autoloads that module, whose CDXML functions replace the
// shadows), so every network and CIM cmdlet name in the extracted block is rewritten to a stub's name, the test refuses
// to run if any is left or if the block calls ipconfig or netsh, and the stubs' interface indexes (40004 up) exist on
// no PC, besides.
'use strict'
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { T, scratch } = require('./helpers')
const { ps51Env } = require('../helper/hv')

const windows = process.platform === 'win32'
const HV = fs.readFileSync(path.join(__dirname, '..', 'helper', 'hv.ps1'), 'utf8')
const GUEST_NET = /^\$GuestNet = \{\r?\n[\s\S]*?\r?\n\}\r?\n/m.exec(HV)?.[0]
const NET_CMDLET = /\b(Get|Set|New|Remove|Enable|Disable|Rename|Restart|Reset|Invoke)-(Net|Dns|Cim|Wmi)[A-Za-z]+\b/g
const TOOLS = /\b(ipconfig|netsh|Invoke-WmiMethod|gwmi|wmic)\b/i
const STUBBED = ['Get-NetAdapter', 'Get-NetIPAddress', 'Remove-NetIPAddress', 'New-NetIPAddress', 'Get-NetRoute', 'Remove-NetRoute', 'Get-NetIPInterface', 'Set-NetIPInterface', 'Set-DnsClientServerAddress', 'Get-CimInstance', 'Invoke-CimMethod']
/** The block with each network and CIM cmdlet renamed to its stub; throws if one has no stub, so none can run for real. */
function stubbed(block) {
  if (TOOLS.test(block)) throw new Error(`$GuestNet calls a network tool the stubs can't stand in for: ${TOOLS.exec(block)[0]}`)
  const missing = [...new Set((block.match(NET_CMDLET) || []).filter(c => !STUBBED.includes(c)))]
  if (missing.length) throw new Error(`$GuestNet uses network cmdlets with no stub here: ${missing.join(', ')}: add stubs before running it`)
  const out = block.replace(NET_CMDLET, c => `Stub-${c}`)
  if (NET_CMDLET.test(out.replace(/Stub-[A-Za-z-]+/g, ''))) throw new Error('a real network cmdlet name is left in the block')
  return out
}

// The stubs: each adapter a client-only MSFT_NetAdapter CimInstance, the type a guest's Get-NetAdapter returns, with its
// state ($script:st, by interface index) read and changed by the other stubs; each change recorded, never made.
// A DHCP adapter's default route is NetMgmt, as in a real guest. A renew gives a DHCP address only when renewOk.
const STUBS = `
$script:calls = New-Object System.Collections.ArrayList
function Stub-Get-NetAdapter { foreach ($a in $script:adapters) { New-CimInstance -ClassName MSFT_NetAdapter -Namespace root/StandardCimv2 -ClientOnly -Property @{ Name = $a.name; MacAddress = $a.mac; ifIndex = [uint32]$a.ix } } }
function Stub-Get-NetIPAddress { param($InterfaceIndex, $AddressFamily, $ErrorAction)
  foreach ($a in $script:adapters) { if ($null -eq $InterfaceIndex -or $a.ix -eq $InterfaceIndex) { foreach ($x in $a.addrs) { [pscustomobject]@{ ifIndex = $a.ix; InterfaceAlias = $a.name; IPAddress = $x.ip; PrefixOrigin = $x.origin } } } } }
function Stub-Remove-NetIPAddress { param([Parameter(ValueFromPipeline = $true)]$InputObject, [switch]$Confirm) process { if ($InputObject) {
  $a = $script:adapters | Where-Object { $_.ix -eq $InputObject.ifIndex }; $a.addrs = @($a.addrs | Where-Object { $_.ip -ne $InputObject.IPAddress })
  [void]$script:calls.Add("Remove-NetIPAddress $($InputObject.ifIndex) $($InputObject.IPAddress)") } } }
function Stub-New-NetIPAddress { param($InterfaceIndex, $IPAddress, $PrefixLength) [void]$script:calls.Add("New-NetIPAddress $InterfaceIndex $IPAddress/$PrefixLength") }
function Stub-Get-NetRoute { param($InterfaceIndex, $DestinationPrefix, $ErrorAction)
  foreach ($a in $script:adapters) { if ($a.ix -eq $InterfaceIndex -and $a.gw) { [pscustomobject]@{ ifIndex = $a.ix; DestinationPrefix = '0.0.0.0/0'; NextHop = $a.gw; Protocol = 'NetMgmt' } } } }
function Stub-Remove-NetRoute { param([Parameter(ValueFromPipeline = $true)]$InputObject, [switch]$Confirm) process { if ($InputObject) {
  ($script:adapters | Where-Object { $_.ix -eq $InputObject.ifIndex }).gw = $null; [void]$script:calls.Add("Remove-NetRoute $($InputObject.ifIndex)") } } }
function Stub-Get-NetIPInterface { param($InterfaceIndex, $AddressFamily)
  foreach ($a in $script:adapters) { if ($null -eq $InterfaceIndex -or $a.ix -eq $InterfaceIndex) { [pscustomobject]@{ ifIndex = $a.ix; InterfaceAlias = $a.name; Dhcp = $a.dhcp } } } }
function Stub-Set-NetIPInterface { param($InterfaceIndex, $AddressFamily, $Dhcp, $RouterDiscovery)
  $a = $script:adapters | Where-Object { $_.ix -eq $InterfaceIndex }; if ($Dhcp) { $a.dhcp = $Dhcp }
  [void]$script:calls.Add("Set-NetIPInterface $InterfaceIndex $Dhcp $RouterDiscovery") }
function Stub-Set-DnsClientServerAddress { param($InterfaceIndex, [switch]$ResetServerAddresses) [void]$script:calls.Add("Set-DnsClientServerAddress $InterfaceIndex") }
function Stub-Get-CimInstance { param($ClassName, $Filter)
  if ($ClassName -ne 'Win32_NetworkAdapterConfiguration' -or $Filter -notmatch '^InterfaceIndex=(\\d+)$') { throw "unexpected CIM query: $ClassName $Filter" }
  $ix = [int]$Matches[1]; if ($script:adapters | Where-Object { $_.ix -eq $ix }) { [pscustomobject]@{ InterfaceIndex = $ix } } }
function Stub-Invoke-CimMethod { param($InputObject, $MethodName)
  if ($MethodName -ne 'RenewDHCPLease') { throw "unexpected CIM method $MethodName" }
  $a = $script:adapters | Where-Object { $_.ix -eq $InputObject.InterfaceIndex }
  [void]$script:calls.Add("RenewDHCPLease $($a.ix)")
  if ($script:renewOk) { $a.addrs = @(@{ ip = '172.30.161.168'; origin = 'Dhcp' }); $a.gw = '172.30.160.1'; [pscustomobject]@{ ReturnValue = [uint32]0 } } else { [pscustomobject]@{ ReturnValue = [uint32]83 } } }
`

const ps = v => `'${String(v).replace(/'/g, "''")}'`
function guestNet(adapters, mode, mac, address = '', { renewOk = true } = {}) {
  const file = path.join(scratch('guestnet-ps').dir, 'guestnet.ps1')
  const list = adapters.map(a => `[pscustomobject]@{ name = ${ps(a.name)}; mac = ${ps(a.mac)}; ix = ${a.ix}; dhcp = ${ps(a.dhcp || 'Enabled')}; gw = ${a.gw ? ps(a.gw) : '$null'}; addrs = @(${(a.addrs || []).map(x => `@{ ip = ${ps(x.ip)}; origin = ${ps(x.origin)} }`).join(', ')}) }`).join(', ')
  fs.writeFileSync(file, `${STUBS}\n$script:renewOk = $${renewOk}\n$script:adapters = @(${list})\n${stubbed(GUEST_NET)}\ntry { $r = & $GuestNet '${mode}' '${mac}' '${address}'; $out = @{ ok = $true; result = $r; calls = @($script:calls) } } catch { $out = @{ ok = $false; error = [string]$_.Exception.Message; calls = @($script:calls) } }\n$out.state = @($script:adapters | ForEach-Object { @{ ix = $_.ix; dhcp = $_.dhcp; gw = $_.gw; addrs = @($_.addrs | ForEach-Object { $_.ip + '/' + $_.origin }) } })\nConvertTo-Json -InputObject $out -Compress -Depth 5\n`)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', env: ps51Env(), timeout: T.spawnMs })
  const line = r.stdout.trim().split(/\r?\n/).at(-1)
  try { return JSON.parse(line) } catch { throw new Error(`no answer from $GuestNet: ${r.stdout}${r.stderr}`) }
}

const MAC = '00155D586D01'
// The clean checkpoint's state, read live: on DHCP; a lease with its NetMgmt default route once connected.
const ON_DHCP = { name: 'Ethernet', mac: '00-15-5D-58-6D-01', ix: 40004, dhcp: 'Enabled', gw: '172.30.160.1', addrs: [{ ip: '172.30.161.168', origin: 'Dhcp' }] }
const APIPA = { ...ON_DHCP, gw: null, addrs: [{ ip: '169.254.137.170', origin: 'WellKnown' }] }
const STATIC = { ...ON_DHCP, dhcp: 'Disabled', gw: '10.137.42.1', addrs: [{ ip: '10.137.42.10', origin: 'Manual' }] }

test('$GuestNet is in hv.ps1, and every network and CIM cmdlet it uses is stubbed here (none can run for real)', () => {
  assert.ok(GUEST_NET, 'the $GuestNet = { ... } block')
  const s = stubbed(GUEST_NET)
  assert.ok(s.includes('Stub-Get-NetAdapter') && s.includes('Stub-Set-NetIPInterface') && s.includes('Stub-Invoke-CimMethod'))
  assert.throws(() => stubbed('{ Get-NetAdapter; Disable-NetAdapter -Name x }'), /no stub here: Disable-NetAdapter/)
  assert.throws(() => stubbed('{ Get-CimInstance x; Remove-CimInstance y }'), /no stub here: Remove-CimInstance/)
  assert.throws(() => stubbed('{ ipconfig /renew Ethernet }'), /network tool .*ipconfig/)
})

test('$GuestNet, for real: host mode sets the one adapter with the VM\'s MAC (a single CimInstance, as in the guest)', { skip: !windows || !GUEST_NET }, () => {
  const r = guestNet([ON_DHCP], 'host', MAC, '10.137.42.10')
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.result, { set: true })
  assert.deepStrictEqual(r.calls, ['Set-NetIPInterface 40004 Disabled Disabled', 'Remove-NetIPAddress 40004 172.30.161.168', 'Remove-NetRoute 40004', 'New-NetIPAddress 40004 10.137.42.10/24', 'Set-DnsClientServerAddress 40004'])
})

test('MC-1565: internet mode leaves an adapter already on DHCP alone: its lease and DHCP default route kept, no renew', { skip: !windows || !GUEST_NET }, () => {
  const r = guestNet([ON_DHCP], 'internet', MAC)
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.result, { set: true })
  assert.deepStrictEqual(r.calls, ['Set-DnsClientServerAddress 40004'], 'no Set-NetIPInterface -Dhcp (it drops the lease) and no route removed')
  assert.deepStrictEqual(r.state, [{ ix: 40004, dhcp: 'Enabled', gw: '172.30.160.1', addrs: ['172.30.161.168/Dhcp'] }])
})

test('MC-1565: internet mode with no DHCP address yet (APIPA) asks for a lease now (RenewDHCPLease) and says so', { skip: !windows || !GUEST_NET }, () => {
  const r = guestNet([APIPA], 'internet', MAC)
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.result, { set: true, renewed: 0 })
  assert.deepStrictEqual(r.calls, ['Set-DnsClientServerAddress 40004', 'RenewDHCPLease 40004'])
  assert.deepStrictEqual(r.state[0].addrs, ['172.30.161.168/Dhcp'])
  // An unanswered renew isn't a failure here: its code is returned, and the helper's read-back decides.
  const no = guestNet([APIPA], 'internet', MAC, '', { renewOk: false })
  assert.strictEqual(no.ok, true, no.error)
  assert.deepStrictEqual(no.result, { set: true, renewed: 83 })
})

test('MC-1565: internet mode on a static adapter (host mode\'s): back to DHCP, its static address and route removed, then a renew', { skip: !windows || !GUEST_NET }, () => {
  const r = guestNet([STATIC], 'internet', MAC)
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.calls, ['Remove-NetIPAddress 40004 10.137.42.10', 'Remove-NetRoute 40004', 'Set-NetIPInterface 40004 Enabled ControlledByDHCP', 'Set-DnsClientServerAddress 40004', 'RenewDHCPLease 40004'])
  assert.deepStrictEqual(r.state, [{ ix: 40004, dhcp: 'Enabled', gw: '172.30.160.1', addrs: ['172.30.161.168/Dhcp'] }])
})

test('$GuestNet, for real: the right adapter among others; none or two with the MAC is refused, nothing changed', { skip: !windows || !GUEST_NET }, () => {
  const other = { ...STATIC, name: 'Ethernet 2', mac: '00-15-5D-00-00-09', ix: 40007 }
  const r = guestNet([other, ON_DHCP], 'host', MAC, '10.137.42.10')
  assert.strictEqual(r.ok, true, r.error)
  assert.ok(r.calls.length && r.calls.every(c => / 40004\b/.test(c)), r.calls.join('; '))
  for (const adapters of [[other], [ON_DHCP, { ...ON_DHCP, name: 'Ethernet 3', ix: 40009 }]]) {
    const bad = guestNet(adapters, 'host', MAC, '10.137.42.10')
    assert.strictEqual(bad.ok, false)
    assert.match(bad.error, /no single adapter with MAC 00155D586D01/)
    assert.deepStrictEqual(bad.calls, [])
  }
})

test('$GuestNet, for real: none puts every adapter back on DHCP, touching only those that aren\'t; no renew (it is disconnected)', { skip: !windows || !GUEST_NET }, () => {
  const r = guestNet([ON_DHCP], 'none', '')
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.result, { reset: true })
  assert.deepStrictEqual(r.calls, ['Set-DnsClientServerAddress 40004'])
  const two = guestNet([ON_DHCP, { ...STATIC, name: 'Ethernet 2', mac: '00-15-5D-00-00-09', ix: 40007 }], 'none', '')
  assert.strictEqual(two.ok, true, two.error)
  assert.deepStrictEqual(two.calls, ['Set-DnsClientServerAddress 40004', 'Remove-NetIPAddress 40007 10.137.42.10', 'Remove-NetRoute 40007', 'Set-NetIPInterface 40007 Enabled ControlledByDHCP', 'Set-DnsClientServerAddress 40007'])
  assert.deepStrictEqual(two.state.map(s => s.dhcp), ['Enabled', 'Enabled'])
})
