// MC-1563: hv.ps1's $GuestNet, the Windows guest's own network for a mode, run for real with Windows PowerShell 5.1
// against stand-in network cmdlets that return real CimInstances (as Get-NetAdapter does in a guest). The live proof
// (MC-1559) found every Windows start in host, internet or internet-lan failing: an if-expression unrolled the one
// matching adapter to a single CimInstance, whose .Count is $null in PowerShell 5.1, so "exactly one" never held.
//
// Safety: this runs on the developer's PC, so the block must never reach a real network cmdlet. Shadowing them with
// functions isn't enough (the first unstubbed NetTCPIP call autoloads that module, whose CDXML functions replace the
// shadows), so every network cmdlet name in the extracted block is rewritten to a stub's name, and the test refuses to
// run if any real Net*/Dns* cmdlet name is left. The stubs' interface indexes (40004 up) exist on no PC, besides.
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
const NET_CMDLET = /\b(Get|Set|New|Remove|Enable|Disable|Rename|Restart|Reset)-(Net|Dns)[A-Za-z]+\b/g
const STUBBED = ['Get-NetAdapter', 'Get-NetIPAddress', 'Remove-NetIPAddress', 'New-NetIPAddress', 'Get-NetRoute', 'Remove-NetRoute', 'Get-NetIPInterface', 'Set-NetIPInterface', 'Set-DnsClientServerAddress']
/** The block with each network cmdlet renamed to its stub; throws if one has no stub, so none can run for real. */
function stubbed(block) {
  const missing = [...new Set((block.match(NET_CMDLET) || []).filter(c => !STUBBED.includes(c)))]
  if (missing.length) throw new Error(`$GuestNet uses network cmdlets with no stub here: ${missing.join(', ')}: add stubs before running it`)
  const out = block.replace(NET_CMDLET, c => `Stub-${c}`)
  if (NET_CMDLET.test(out.replace(/Stub-[A-Za-z-]+/g, ''))) throw new Error('a real network cmdlet name is left in the block')
  return out
}

// The stubs: each adapter a client-only MSFT_NetAdapter CimInstance, the type a guest's Get-NetAdapter returns; each
// change recorded, never made. Pipeline-input stubs take and drop their input.
const STUBS = `
$script:calls = New-Object System.Collections.ArrayList
function Stub-Get-NetAdapter { foreach ($a in $script:adapters) { New-CimInstance -ClassName MSFT_NetAdapter -Namespace root/StandardCimv2 -ClientOnly -Property @{ Name = $a.name; MacAddress = $a.mac; ifIndex = [uint32]$a.ix } } }
function Stub-Get-NetIPAddress { param($InterfaceIndex, $AddressFamily, $ErrorAction) }
function Stub-Remove-NetIPAddress { param([Parameter(ValueFromPipeline = $true)]$InputObject, [switch]$Confirm) process { if ($InputObject) { [void]$script:calls.Add('Remove-NetIPAddress') } } }
function Stub-New-NetIPAddress { param($InterfaceIndex, $IPAddress, $PrefixLength) [void]$script:calls.Add("New-NetIPAddress $InterfaceIndex $IPAddress/$PrefixLength") }
function Stub-Get-NetRoute { param($InterfaceIndex, $DestinationPrefix, $ErrorAction) }
function Stub-Remove-NetRoute { param([Parameter(ValueFromPipeline = $true)]$InputObject, [switch]$Confirm) process { if ($InputObject) { [void]$script:calls.Add('Remove-NetRoute') } } }
function Stub-Get-NetIPInterface { param($AddressFamily) }
function Stub-Set-NetIPInterface { param($InterfaceIndex, $AddressFamily, $Dhcp, $RouterDiscovery) [void]$script:calls.Add("Set-NetIPInterface $InterfaceIndex $Dhcp") }
function Stub-Set-DnsClientServerAddress { param($InterfaceIndex, [switch]$ResetServerAddresses) [void]$script:calls.Add("Set-DnsClientServerAddress $InterfaceIndex") }
`

function guestNet(adapters, mode, mac, address = '') {
  const file = path.join(scratch('guestnet-ps').dir, 'guestnet.ps1')
  const list = adapters.map(a => `@{ name = '${a.name}'; mac = '${a.mac}'; ix = ${a.ix} }`).join(', ')
  fs.writeFileSync(file, `${STUBS}\n$script:adapters = @(${list})\n${stubbed(GUEST_NET)}\ntry { $r = & $GuestNet '${mode}' '${mac}' '${address}'; $out = @{ ok = $true; result = $r; calls = @($script:calls) } } catch { $out = @{ ok = $false; error = [string]$_.Exception.Message; calls = @($script:calls) } }\nConvertTo-Json -InputObject $out -Compress -Depth 4\n`)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', env: ps51Env(), timeout: T.spawnMs })
  const line = r.stdout.trim().split(/\r?\n/).at(-1)
  try { return JSON.parse(line) } catch { throw new Error(`no answer from $GuestNet: ${r.stdout}${r.stderr}`) }
}

const NIC = { name: 'Ethernet', mac: '00-15-5D-58-6D-01', ix: 40004 }
const MAC = '00155D586D01'

test('$GuestNet is in hv.ps1, and every network cmdlet it uses is stubbed here (none can run for real)', () => {
  assert.ok(GUEST_NET, 'the $GuestNet = { ... } block')
  const s = stubbed(GUEST_NET)
  assert.ok(s.includes('Stub-Get-NetAdapter') && s.includes('Stub-Set-NetIPInterface'))
  assert.throws(() => stubbed('{ Get-NetAdapter; Disable-NetAdapter -Name x }'), /no stub here: Disable-NetAdapter/)
})

test('$GuestNet, for real: host mode sets the one adapter with the VM\'s MAC (a single CimInstance, as in the guest)', { skip: !windows || !GUEST_NET }, () => {
  const r = guestNet([NIC], 'host', MAC, '10.137.42.10')
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.result, { set: true })
  assert.deepStrictEqual(r.calls, ['Set-NetIPInterface 40004 Disabled', 'New-NetIPAddress 40004 10.137.42.10/24', 'Set-DnsClientServerAddress 40004'])
})

test('$GuestNet, for real: internet mode puts the one adapter on DHCP', { skip: !windows || !GUEST_NET }, () => {
  const r = guestNet([NIC], 'internet', MAC)
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.calls, ['Set-NetIPInterface 40004 Enabled', 'Set-DnsClientServerAddress 40004'])
})

test('$GuestNet, for real: the right adapter among others; none or two with the MAC is refused, nothing changed', { skip: !windows || !GUEST_NET }, () => {
  const other = { name: 'Ethernet 2', mac: '00-15-5D-00-00-09', ix: 40007 }
  const r = guestNet([other, NIC], 'host', MAC, '10.137.42.10')
  assert.strictEqual(r.ok, true, r.error)
  assert.ok(r.calls.length && r.calls.every(c => / 40004\b/.test(c)), r.calls.join('; '))
  for (const adapters of [[other], [NIC, { ...NIC, name: 'Ethernet 3', ix: 40009 }]]) {
    const bad = guestNet(adapters, 'host', MAC, '10.137.42.10')
    assert.strictEqual(bad.ok, false)
    assert.match(bad.error, /no single adapter with MAC 00155D586D01/)
    assert.deepStrictEqual(bad.calls, [])
  }
})

test('$GuestNet, for real: none resets a single adapter to DHCP', { skip: !windows || !GUEST_NET }, () => {
  const r = guestNet([NIC], 'none', '')
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.result, { reset: true })
  assert.deepStrictEqual(r.calls, ['Set-NetIPInterface 40004 Enabled', 'Set-DnsClientServerAddress 40004'])
})
