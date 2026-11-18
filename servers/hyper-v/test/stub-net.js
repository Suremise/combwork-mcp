/**
 * MC-1556: the stub's guest network, shared by stub-hv.js (a Windows guest, PowerShell Direct) and stub-guest.js (a
 * Linux guest's root scripts). A guest's network follows what was set on it and the switch its adapter is on:
 *   host mode on the host-mode switch: the static address; internet on the Default Switch: a DHCP lease from
 *   state.defaultSwitch (default 172.20.16.1/20), a default route via it, its DNS and a lookup that answers.
 * Knobs: netSetFails (setting it fails), netRead (fields the read reports instead), netUnsteady: n (the next n reads
 * after a good one lose the address: a network manager undoing it), netNeverReady (DHCP never answers).
 * And the invariant every test of a run checks: a VM is never Running on a switch without its mode's exact port ACLs
 * (state.violations lists each time it was).
 */
const net = require('../helper/net')

const dflt = s => s.defaultSwitch ?? { ip: '172.20.16.1', prefix: 20 }
const macOf = vm => vm.mac || ('00155D' + vm.id.replace(/-/g, '').slice(0, 6)).toUpperCase()

function setGuestNet(s, vm, mode, address) {
  if (s.netSetFails) throw new Error('injected: setting the guest network failed')
  vm.guestNet = mode === 'none' ? null : { mode, address: address || null }
  vm.netSets = [...(vm.netSets || []), { mode, address: address || null }]
}

function readGuestNet(s, vm, lookup) {
  const sw = vm.switchName
  const hostSw = s.hostNet?.switchName
  const ipv4 = []
  const routes = []
  const dns = []
  let ok = null
  const g = vm.guestNet
  if (g?.mode === 'host' && g.address) { ipv4.push({ ip: g.address, prefix: 24 }); routes.push({ dest: `${g.address.replace(/\.\d+$/, '.0')}/24`, gateway: null }) }
  if (g?.mode === 'internet' && sw === 'Default Switch' && !s.netNeverReady) {
    const d = dflt(s)
    ipv4.push({ ip: d.ip.replace(/\.\d+$/, '.77'), prefix: d.prefix })
    routes.push({ dest: '0.0.0.0/0', gateway: d.ip })
    dns.push(d.ip)
    ok = lookup ? true : null
  } else if (lookup) ok = false
  if (s.netUnsteady > 0 && vm.netGood) { s.netUnsteady--; ipv4.length = 0 }
  const read = { nics: [{ name: 'Ethernet', mac: macOf(vm), ipv4 }], routes, dns, lookup: ok, ...(s.netRead || {}) }
  vm.netGood = !s.netRead && ipv4.length > 0
  return read
}

/** Records a violation if the VM is Running on a switch without its mode's exact ACL set. */
function checkInvariant(s, vm, op) {
  if (vm.state !== 'Running' || !vm.switchName) return
  const acls = vm.acls || []
  let ok
  if (vm.switchName === s.hostNet?.switchName) ok = !net.aclProblem(acls, net.aclsFor('host', { hostAddress: s.hostNet.hostAddress }))
  else if (vm.switchName === 'Default Switch') {
    const gateway = dflt(s).ip
    ok = !net.aclProblem(acls, net.aclsFor('internet', { gateway })) || !net.aclProblem(acls, net.aclsFor('internet-lan', { gateway }))
  } else ok = true // an old pool switch, or the build's activation step: not a run's
  if (!ok) s.violations = [...(s.violations || []), `${vm.name} Running on ${vm.switchName} with ACLs ${JSON.stringify(acls)} (after ${op})`]
}

module.exports = { setGuestNet, readGuestNet, checkInvariant, macOf, dflt }
