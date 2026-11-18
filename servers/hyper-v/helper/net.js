/**
 * MC-1556: a run's network modes, and the pure rules around them (no Hyper-V, no guest): the modes in order, the
 * host-mode checks against what hv.ps1 reads of the host, each mode's port ACLs, the guest's network read back, and
 * the fixed scripts a Linux guest runs as root to set and read its network.
 *
 * Modes, in order (a run asks for one at or below the pool's, which is at or below the policy's):
 *   none          the adapter disconnected (no ACLs);
 *   host          the setup-made internal switch; the guest gets a static address on its subnet and reaches only the
 *                 host's address there (ACLs: allow the host's /32, deny all other IPv4, deny all IPv6);
 *   internet      Windows' Default Switch (its NAT); DHCP; private ranges denied except the switch's gateway, which
 *                 the guest needs for DHCP and DNS; all IPv6 denied;
 *   internet-lan  the Default Switch with only IPv6 denied (the user's fourth option: the LAN too).
 */
const MODES = Object.freeze(['none', 'host', 'internet', 'internet-lan'])
const DEFAULT_SWITCH_ID = 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444'
const DEFAULT_HOST_SUBNET = '10.137.42.0/24'
const GUEST_FIRST = 10 // guests get .10 upwards; .1 is the host
const GUEST_LAST = 250
const PRIVATE_V4 = Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10'])
const LOOKUP_NAME = 'dns.msftncsi.com' // Windows' own connectivity-check name: the one lookup an internet start makes

/** One plain line per mode, for plans, tool descriptions and status. */
const DESCRIBE = Object.freeze({
  none: 'no network: the VM\'s adapter is disconnected',
  host: 'host only: the VM reaches only this PC, on the ports its firewall allows (e.g. a local model server); no LAN, no internet',
  internet: 'internet: the VM reaches the internet through Windows\' Default Switch (its traffic leaves this PC); not the LAN',
  'internet-lan': 'internet and LAN: the VM reaches the internet and your local network through Windows\' Default Switch'
})

const rank = m => MODES.indexOf(m)
const isMode = m => MODES.includes(m)
const defaultSwitch = m => m === 'internet' || m === 'internet-lan'

/** A tool's network argument as a mode: the old booleans still work (true is host, false none). Throws on anything else. */
function modeOf(v, fallback = 'none') {
  if (v === undefined || v === null) return fallback
  if (v === true) return 'host'
  if (v === false) return 'none'
  if (isMode(v)) return v
  throw new Error(`network must be one of ${MODES.join(', ')}`)
}

/** Why a mode is above a cap (the pool's, the policy's), or null. */
function above(mode, cap, whose) {
  return rank(mode) > rank(cap) ? `network ${mode} is above ${whose}'s ${cap}` : null
}

// ---------- IPv4 arithmetic ----------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
function ip4(s) {
  const m = IPV4_RE.exec(String(s))
  if (!m) return null
  const o = m.slice(1).map(Number)
  if (o.some(x => x > 255)) return null
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3]
}
const str4 = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
const mask = p => p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0
/** 'a.b.c.d/p' as { net, prefix } (the network address, host bits cleared), or null. */
function cidr(s) {
  const [a, p, ...rest] = String(s).split('/')
  const n = ip4(a)
  const prefix = Number(p)
  if (rest.length || n === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32 || p === '' || p === undefined) return null
  return { net: (n & mask(prefix)) >>> 0, prefix }
}
const contains = (c, n) => ((n & mask(c.prefix)) >>> 0) === c.net
const overlaps = (a, b) => { const p = Math.min(a.prefix, b.prefix); return ((a.net & mask(p)) >>> 0) === ((b.net & mask(p)) >>> 0) }

/** Why a host-mode subnet isn't usable as setup's (a /24 inside 10/8 or 192.168/16 with no host bits), or null. */
function subnetProblem(s) {
  const c = cidr(s)
  if (!c || c.prefix !== 24 || `${str4(c.net)}/24` !== s) return 'the host subnet must be a /24 written as a.b.c.0/24'
  if (contains(cidr('172.16.0.0/12'), c.net)) return 'the host subnet must not be in 172.16.0.0/12, where Windows puts the Default Switch'
  if (!contains(cidr('10.0.0.0/8'), c.net) && !contains(cidr('192.168.0.0/16'), c.net)) return 'the host subnet must be in 10.0.0.0/8 or 192.168.0.0/16'
  return null
}
/** The host's address on a subnet (.1). */
const hostAddressOf = s => str4(cidr(s).net + 1)

/** Why policy.hostNetwork isn't usable, or null. */
function hostNetworkProblem(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return 'hostNetwork must be an object'
  if (typeof h.switchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(h.switchId)) return 'hostNetwork.switchId must be a switch id (a GUID)'
  if (typeof h.switchName !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(h.switchName)) return 'hostNetwork.switchName must be 1-40 letters, digits and -'
  const why = subnetProblem(h.subnet)
  if (why) return `hostNetwork: ${why}`
  if (h.hostAddress !== hostAddressOf(h.subnet)) return `hostNetwork.hostAddress must be ${hostAddressOf(h.subnet)}`
  return null
}

/**
 * Why host mode can't be used now, from hv.ps1's 'net-host' read, or null. r: { switch: { id, name, type } | null,
 * hostAddrs: [{ ip, prefix }] (the switch's vEthernet), others: [{ alias, ip, prefix }] (every other interface's IPv4),
 * routes: [{ alias, prefix: 'a.b.c.d/p', ours }] }.
 */
function hostProblem(r, h) {
  const rerun = 'rerun setup (its host-network step puts it back)'
  if (!r?.switch) return `the host-mode switch ${h.switchName} (id ${h.switchId}) is missing: ${rerun}`
  if (String(r.switch.id).toLowerCase() !== h.switchId.toLowerCase() || r.switch.name !== h.switchName || r.switch.type !== 'Internal') return `the host-mode switch ${h.switchName} was renamed or isn't internal: ${rerun}`
  const mine = (r.hostAddrs || []).filter(a => ip4(a.ip) !== null)
  if (mine.length !== 1 || mine[0].ip !== h.hostAddress || Number(mine[0].prefix) !== 24) return `the host's address on ${h.switchName} isn't exactly ${h.hostAddress}/24 (it has ${mine.map(a => `${a.ip}/${a.prefix}`).join(', ') || 'none'}): ${rerun}`
  return clashProblem(h.subnet, r.others, r.routes)
}

/**
 * Why a host subnet clashes with this PC's other networks, or null: another interface's IPv4 address range, or a route
 * that isn't ours (a VPN's), overlapping it. Setup checks it before making the switch; each host-mode start again.
 * others: [{ alias, ip, prefix }]; routes: [{ alias, prefix: 'a.b.c.d/p', ours }]. The default route never clashes.
 */
function clashProblem(subnet, others, routes) {
  const sub = cidr(subnet)
  for (const o of others || []) {
    const c = cidr(`${o.ip}/${o.prefix}`)
    if (c && overlaps(c, sub)) return `${o.alias} has ${o.ip}/${o.prefix}, which overlaps the host subnet ${subnet} (a VPN or another network?): rerun setup with another -HostSubnet`
  }
  for (const rt of routes || []) {
    if (rt.ours) continue
    const c = cidr(rt.prefix)
    if (c && c.prefix > 0 && overlaps(c, sub)) return `a route to ${rt.prefix} on ${rt.alias} overlaps the host subnet ${subnet}: rerun setup with another -HostSubnet`
  }
  return null
}

/** The lowest free guest address on the subnet, given those in use; null when none is left. */
function allocate(subnet, used) {
  const base = cidr(subnet).net
  const taken = new Set(used)
  for (let i = GUEST_FIRST; i <= GUEST_LAST; i++) { const a = str4(base + i); if (!taken.has(a)) return a }
  return null
}

/**
 * The Default Switch's facts for an internet start, from hv.ps1's 'net-default' read ({ present, ip, prefix }), or
 * why it can't be used.
 */
function defaultFacts(r) {
  if (!r?.present) return { why: 'this host has no Default Switch, so internet modes can\'t be used here' }
  const c = cidr(`${r.ip}/${r.prefix}`)
  if (!c || c.prefix < 8 || c.prefix > 30) return { why: `the Default Switch's host address (${r.ip}/${r.prefix}) can't be read: try again in a minute (Windows sets it up after a restart)` }
  return { gateway: r.ip, subnet: `${str4(c.net)}/${c.prefix}` }
}

// ---------- port ACLs ----------

/**
 * A mode's complete ACL set: [{ action: 'Allow'|'Deny', remote: 'a.b.c.d/p' | '::/0' }], each for both directions.
 * Hyper-V's port ACLs: the most specific matching address wins, and an address no entry matches is allowed.
 */
function aclsFor(mode, { hostAddress, gateway } = {}) {
  if (mode === 'none') return []
  const v6 = { action: 'Deny', remote: '::/0' }
  if (mode === 'host') return [{ action: 'Allow', remote: `${hostAddress}/32` }, { action: 'Deny', remote: '0.0.0.0/0' }, v6]
  if (mode === 'internet') return [{ action: 'Allow', remote: `${gateway}/32` }, ...PRIVATE_V4.map(remote => ({ action: 'Deny', remote })), v6]
  if (mode === 'internet-lan') return [v6]
  throw new Error(`unknown network mode ${mode}`)
}

const normRemote = r => {
  const s = String(r).trim().toLowerCase()
  if (s === '::' || s === '::/0' || s === '0::/0') return '::/0'
  if (!s.includes('/')) return ip4(s) !== null ? `${s}/32` : s
  const c = cidr(s)
  return c ? `${str4(c.net)}/${c.prefix}` : s
}
/** An ACL list as a sorted set of 'Action|Direction|remote' keys, Both expanded to Inbound and Outbound. */
function aclKeys(list) {
  const out = new Set()
  for (const e of list || []) {
    const dirs = !e.direction || e.direction === 'Both' ? ['Inbound', 'Outbound'] : [e.direction]
    for (const d of dirs) out.add(`${e.action}|${d}|${normRemote(e.remote)}`)
  }
  return [...out].sort()
}
/** Why a read-back ACL set isn't exactly the wanted one, or null. */
function aclProblem(read, want) {
  const a = aclKeys(read)
  const b = aclKeys(want)
  const missing = b.filter(k => !a.includes(k))
  const extra = a.filter(k => !b.includes(k))
  if (!missing.length && !extra.length) return null
  return `its port ACLs aren't the mode's exact set (${[missing.length ? `missing ${missing.join(', ')}` : '', extra.length ? `extra ${extra.join(', ')}` : ''].filter(Boolean).join('; ')})`
}

// ---------- the guest's network, read back ----------

const normMac = m => String(m || '').replace(/[^0-9a-f]/gi, '').toLowerCase()

/**
 * Why the guest's network isn't what the mode needs, or null. read (Windows and Linux alike): { nics: [{ mac, name,
 * ipv4: [{ ip, prefix }] }], routes: [{ dest, gateway, mac }] (IPv4 and IPv6 default routes and any others), dns:
 * [addresses] (the NIC's), lookup: true | false | null }. want: { mode, mac, address?, subnet?, gateway? }.
 */
function guestProblem(read, want) {
  if (!read || !Array.isArray(read.nics)) return 'its network couldn\'t be read'
  const mac = normMac(want.mac)
  const nic = read.nics.find(n => normMac(n.mac) === mac)
  if (!nic) return `no network adapter with the VM's MAC (${want.mac}) in the guest`
  const v4 = (nic.ipv4 || []).filter(a => ip4(a.ip) !== null && !String(a.ip).startsWith('127.'))
  const elsewhere = read.nics.filter(n => n !== nic).flatMap(n => (n.ipv4 || []).filter(a => ip4(a.ip) !== null && !String(a.ip).startsWith('127.') && !String(a.ip).startsWith('169.254.')).map(a => `${n.name || n.mac} ${a.ip}`))
  if (elsewhere.length) return `another interface has an address (${elsewhere.join(', ')})`
  const defaults = (read.routes || []).filter(r => r.dest === '0.0.0.0/0' || r.dest === '::/0' || r.dest === 'default')
  if (want.mode === 'host') {
    if (v4.length !== 1 || v4[0].ip !== want.address || Number(v4[0].prefix) !== 24) return `its adapter has ${v4.map(a => `${a.ip}/${a.prefix}`).join(', ') || 'no IPv4 address'}, not exactly ${want.address}/24`
    if (defaults.length) return `it has a default route (${defaults.map(r => `${r.dest} via ${r.gateway || 'on-link'}`).join(', ')})`
    const sub = cidr(want.subnet)
    const beyond = (read.routes || []).filter(r => { const c = cidr(r.dest); return c && c.prefix < 32 && !(c.prefix >= 24 && contains(sub, c.net)) && !String(r.dest).startsWith('224.') && !String(r.dest).startsWith('255.') && !String(r.dest).startsWith('169.254.') })
    if (beyond.length) return `it has a route beyond the host subnet (${beyond.map(r => r.dest).join(', ')})`
    return null
  }
  // internet, internet-lan
  const sub = cidr(want.subnet)
  const leased = v4.filter(a => !String(a.ip).startsWith('169.254.') && contains(sub, ip4(a.ip)))
  if (!leased.length) return `no DHCP address from the Default Switch yet (it has ${v4.map(a => `${a.ip}/${a.prefix}`).join(', ') || 'no IPv4 address'})`
  if (!defaults.some(r => r.dest !== '::/0' && r.gateway === want.gateway)) return `no default route via the Default Switch (${want.gateway}) yet`
  if (!(read.dns || []).length) return 'no DNS server set yet'
  if (read.lookup !== true) return `a DNS lookup of ${LOOKUP_NAME} didn't answer`
  return null
}

// ---------- Linux: the fixed scripts the helper runs as root ----------

const SH_SAFE = /^[0-9a-f:./]+$/i
const q = s => { if (!SH_SAFE.test(String(s))) throw new Error('unsafe value in a network script'); return String(s) }

/**
 * The script that sets a Linux guest's network for a mode (host or an internet mode). Nothing in it comes from an
 * agent: the MAC is Hyper-V's, the address the helper's. systemd-networkd, when it runs, is given a runtime .network
 * for the NIC (so it owns the address instead of fighting it); otherwise the address is set with ip, and
 * NetworkManager must not be running. /run is tmpfs: nothing survives a restore.
 */
function linuxSetScript(mode, { mac, address }) {
  const m = q(String(mac).toLowerCase().replace(/[^0-9a-f]/g, '').match(/../g).join(':'))
  const lines = [
    '# hvmcp-net set (MC-1556)',
    'set -eu',
    `MAC=${m}`,
    'NIC=$(for d in /sys/class/net/*; do [ "$(cat "$d/address" 2>/dev/null)" = "$MAC" ] && basename "$d"; done | head -n1)',
    '[ -n "$NIC" ] || { echo "no NIC with MAC $MAC" >&2; exit 3; }'
  ]
  if (mode === 'host') {
    const a = q(address)
    lines.push(
      'if systemctl is-active --quiet systemd-networkd; then',
      '  mkdir -p /run/systemd/network',
      `  printf '[Match]\\nMACAddress=%s\\n\\n[Network]\\nAddress=%s/24\\nDHCP=no\\nLinkLocalAddressing=no\\nIPv6AcceptRA=no\\n' "$MAC" "${a}" > /run/systemd/network/10-hvmcp.network`,
      '  networkctl reload',
      '  networkctl reconfigure "$NIC"',
      'else',
      '  if systemctl is-active --quiet NetworkManager; then echo "NetworkManager is running" >&2; exit 4; fi',
      '  ip link set "$NIC" up',
      '  ip -4 addr flush dev "$NIC"',
      `  ip addr add ${a}/24 dev "$NIC"`,
      'fi'
    )
  } else {
    lines.push(
      'if systemctl is-active --quiet systemd-networkd; then',
      '  mkdir -p /run/systemd/network',
      `  printf '[Match]\\nMACAddress=%s\\n\\n[Network]\\nDHCP=ipv4\\nLinkLocalAddressing=no\\nIPv6AcceptRA=no\\n' "$MAC" > /run/systemd/network/10-hvmcp.network`,
      '  networkctl reload',
      '  networkctl reconfigure "$NIC"',
      'elif command -v dhclient >/dev/null 2>&1; then ip link set "$NIC" up; dhclient -4 -nw "$NIC"',
      'elif command -v dhcpcd >/dev/null 2>&1; then ip link set "$NIC" up; dhcpcd -4 -b "$NIC"',
      'else echo "no DHCP client in this image (systemd-networkd, dhclient or dhcpcd)" >&2; exit 5',
      'fi'
    )
  }
  lines.push('echo ok')
  return lines.join('\n') + '\n'
}

/**
 * The script that reads a Linux guest's network as one JSON line (python3 is in every pool image: the dispatcher is
 * Python). lookup: also resolve LOOKUP_NAME (internet modes).
 */
function linuxReadScript({ lookup = false } = {}) {
  return [
    '# hvmcp-net read (MC-1556)',
    `python3 - ${lookup ? '1' : '0'} <<'PY'`,
    'import json, socket, subprocess, sys',
    'def j(*a):',
    '    try: return json.loads(subprocess.run(list(a), stdout=subprocess.PIPE, timeout=20).stdout or b"[]")',
    '    except Exception: return []',
    'links = {l.get("ifname"): l.get("address") for l in j("ip", "-j", "link")}',
    'nics = []',
    'for l in j("ip", "-j", "addr"):',
    '    if l.get("ifname") == "lo": continue',
    '    nics.append({"name": l.get("ifname"), "mac": links.get(l.get("ifname")), "ipv4": [{"ip": a.get("local"), "prefix": a.get("prefixlen")} for a in l.get("addr_info", []) if a.get("family") == "inet"]})',
    'routes = []',
    'for fam, flag in (("4", "-4"), ("6", "-6")):',
    '    for r in j("ip", flag, "-j", "route"):',
    '        d = r.get("dst", "")',
    '        if d == "default": d = "0.0.0.0/0" if fam == "4" else "::/0"',
    '        elif fam == "4" and "/" not in d: d += "/32"',
    '        if fam == "6" and d != "::/0": continue',
    '        routes.append({"dest": d, "gateway": r.get("gateway"), "dev": r.get("dev")})',
    'dns = []',
    'try:',
    '    for line in open("/etc/resolv.conf"):',
    '        p = line.split()',
    '        if len(p) >= 2 and p[0] == "nameserver" and not p[1].startswith("127."): dns.append(p[1])',
    'except OSError: pass',
    'if not dns:',
    '    try:',
    '        out = subprocess.run(["resolvectl", "dns"], stdout=subprocess.PIPE, timeout=10).stdout.decode()',
    '        for line in out.splitlines(): dns += [w for w in line.split(":", 1)[-1].split() if w and not w.startswith("127.")]',
    '    except Exception: pass',
    'lookup = None',
    'if sys.argv[1] == "1":',
    '    socket.setdefaulttimeout(15)',
    `    try: lookup = bool(socket.getaddrinfo("${LOOKUP_NAME}", 80, socket.AF_INET))`,
    '    except Exception: lookup = False',
    'print("HVNET:" + json.dumps({"nics": nics, "routes": routes, "dns": dns, "lookup": lookup}))',
    'PY'
  ].join('\n') + '\n'
}

/** The JSON a read script printed (its HVNET: line), or null. */
function parseRead(stdout) {
  const line = String(stdout || '').split(/\r?\n/).reverse().find(l => l.startsWith('HVNET:'))
  if (!line) return null
  try { return JSON.parse(line.slice(6)) } catch { return null }
}

module.exports = {
  clashProblem,
  MODES, DESCRIBE, DEFAULT_SWITCH_ID, DEFAULT_HOST_SUBNET, LOOKUP_NAME, PRIVATE_V4,
  rank, isMode, modeOf, above, defaultSwitch,
  ip4, cidr, overlaps, subnetProblem, hostAddressOf, hostNetworkProblem, hostProblem, allocate, defaultFacts,
  aclsFor, aclKeys, aclProblem, normMac, guestProblem, linuxSetScript, linuxReadScript, parseRead
}
