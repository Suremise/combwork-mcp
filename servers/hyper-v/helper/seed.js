/**
 * A Linux VM's cloud-init NoCloud seed (MC-1501; design §3, §4.1, §4.2): the files of the `cidata` ISO that the build's
 * first boot reads (hv.ps1 'make-iso' writes them into the ISO). Its user-data is JSON, which is valid YAML, after the
 * "#cloud-config" line: no YAML is written by hand, so nothing needs escaping by hand.
 *
 * What it makes the guest:
 * - users hvadmin and hvuser, passwords locked (cloud-init's default user is not created). hvadmin's only key is the
 *   helper's, restricted to the forced command (sudo of the dispatcher, the one thing sudoers allows it); hvuser has no
 *   key and no sudo;
 * - the host key the helper made (only that one: no other key types are generated), password logins off;
 * - sshd only from hvmcp-sshd.socket, on the transport's one endpoint (A: vsock port 22; B: the guest's address, port
 *   22), with its own config; the distro's ssh.service and ssh.socket disabled and masked;
 * - the dispatcher (guest.py), /build (root's, read-only to hvuser), /out (both may write), /hvmcp (root's);
 * - hv_sock loaded at every boot (A), and HVMCP-DIAG lines written to COM1 at each stage of the first boot (§4.2).
 */
const fs = require('fs')
const { join } = require('path')

const DISPATCH = '/usr/local/libexec/hvmcp/dispatch'
const FORCED = `sudo -n ${DISPATCH}`
const TRANSPORTS = ['hvsocket', 'internal-switch']
// The seed's first diagnostic (bootcmd, before the dispatcher exists): the image's sh, test and uname only; the kernel's
// name reduced to the diagnostics' alphabet; it can't fail.
const EARLY_DIAG = 'k=$(uname -r | tr -cd "A-Za-z0-9._+-"); v=absent; [ -d /sys/bus/vmbus ] && v=present; h=absent; [ -d /sys/bus/vmbus/drivers/hv_sock ] && h=present; ' +
  'echo "HVMCP-DIAG stage=seed-read vmbus=$v hv_sock_driver=$h kernel=$k" > /dev/ttyS0 2>/dev/null; true'

const SSHD_CONFIG = `# hyper-v MCP (MC-1501): sshd for the helper only, started per connection by hvmcp-sshd.socket.
HostKey /etc/ssh/ssh_host_ed25519_key
AuthorizedKeysFile .ssh/authorized_keys
AllowUsers hvadmin
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
UsePAM yes
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
GatewayPorts no
X11Forwarding no
PermitTunnel no
PermitTTY no
PermitUserRC no
PermitUserEnvironment no
PrintMotd no
LogLevel INFO
`

const socketUnit = listen => `[Unit]
Description=hyper-v MCP: sshd for the helper, on its one endpoint only

[Socket]
ListenStream=${listen}
Accept=yes

[Install]
WantedBy=sockets.target
`

// MC-1545: each connection's start and end, with how sshd ended, go to COM1 (the build reads it through its wait), from
// the image's sh only. "$$" is a literal "$" for systemd, so the shell expands it; "%i" is the connection's instance name,
// reduced to the diagnostics' alphabet. A "-" prefix: a failed report never fails the connection.
const SERVICE_UNIT = `[Unit]
Description=hyper-v MCP: sshd for one helper connection

[Service]
ExecStartPre=-/bin/sh -c 'n=$$(echo "%i" | tr -cd "A-Za-z0-9._+-" | cut -c1-64); echo "HVMCP-DIAG stage=conn-start n=$$n" > /dev/ttyS0 2>/dev/null; true'
ExecStartPre=/bin/mkdir -p -m 0755 /run/sshd
ExecStart=-/usr/sbin/sshd -i -f /etc/ssh/hvmcp_sshd_config
ExecStopPost=-/bin/sh -c 'echo "HVMCP-DIAG stage=conn-end result=$$SERVICE_RESULT code=$$EXIT_CODE status=$$EXIT_STATUS" > /dev/ttyS0 2>/dev/null; true'
StandardInput=socket
StandardError=journal
`

/**
 * The seed's files: { 'meta-data', 'user-data', 'network-config' }. keys: { client: { public }, host: { private,
 * public } }; transport: 'hvsocket' | 'internal-switch' (address: the guest's CIDR, e.g. 10.47.0.11/24, under B).
 */
function files({ instanceId, hostname, keys, transport = 'hvsocket', address = null, dispatcher }) {
  if (!TRANSPORTS.includes(transport)) throw new Error(`transport must be ${TRANSPORTS.join(' or ')}`)
  if (!/^[a-z0-9-]{1,63}$/.test(hostname)) throw new Error('a bad hostname')
  if (!/^i-[0-9a-f]{8,32}$/.test(instanceId)) throw new Error('a bad instance id')
  if (transport === 'internal-switch' && !/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(address || '')) throw new Error('the internal-switch transport needs the guest\'s address')
  const listen = transport === 'hvsocket' ? 'vsock::22' : `${address.split('/')[0]}:22`
  const diag = stage => [DISPATCH, '--diag', stage]
  const userData = {
    hostname,
    preserve_hostname: false,
    users: [
      { name: 'hvadmin', lock_passwd: true, shell: '/bin/bash', ssh_authorized_keys: [`restrict,command="${FORCED}" ${keys.client.public}`] },
      { name: 'hvuser', lock_passwd: true, shell: '/bin/bash' }
    ],
    disable_root: true,
    ssh_pwauth: false,
    ssh_deletekeys: true,
    ssh_genkeytypes: [],
    ssh_keys: { ed25519_private: keys.host.private, ed25519_public: keys.host.public },
    write_files: [
      { path: DISPATCH, owner: 'root:root', permissions: '0755', encoding: 'b64', content: Buffer.from(dispatcher).toString('base64') },
      { path: '/etc/ssh/hvmcp_sshd_config', owner: 'root:root', permissions: '0644', content: SSHD_CONFIG },
      { path: '/etc/systemd/system/hvmcp-sshd.socket', owner: 'root:root', permissions: '0644', content: socketUnit(listen) },
      { path: '/etc/systemd/system/hvmcp-sshd@.service', owner: 'root:root', permissions: '0644', content: SERVICE_UNIT },
      { path: '/etc/sudoers.d/hvmcp', owner: 'root:root', permissions: '0440', content: `hvadmin ALL=(root) NOPASSWD: ${DISPATCH} ""\n` },
      ...(transport === 'hvsocket' ? [{ path: '/etc/modules-load.d/hvmcp.conf', owner: 'root:root', permissions: '0644', content: 'hv_sock\n' }] : [])
    ],
    // bootcmd runs before write_files (cloud-init's init stage), so the dispatcher isn't there yet: this first
    // diagnostic uses only the image's own shell and files, and never fails (a failing bootcmd fails cloud-init).
    bootcmd: [['sh', '-c', EARLY_DIAG]],
    // runcmd runs after write_files. Steps that may rightly fail on one distro (no ssh.socket on Debian, no hv_sock
    // module) are made harmless, so cloud-init still reports done; the checks after it say what matters.
    runcmd: [
      diag('units-written'),
      ['install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', '/build'],
      ['install', '-d', '-o', 'root', '-g', 'hvuser', '-m', '0775', '/out'],
      ['install', '-d', '-o', 'root', '-g', 'root', '-m', '0711', '/hvmcp'],
      ['install', '-d', '-o', 'root', '-g', 'root', '-m', '0711', '/hvmcp/runs'],
      ['install', '-d', '-o', 'root', '-g', 'root', '-m', '0700', '/hvmcp/staging'],
      ...(transport === 'hvsocket' ? [['sh', '-c', 'modprobe hv_sock || true']] : []),
      ['sh', '-c', 'systemctl disable --now ssh.service ssh.socket 2>/dev/null || true'],
      ['systemctl', 'mask', 'ssh.service', 'ssh.socket'],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', '--now', 'hvmcp-sshd.socket'],
      diag('socket-up')
    ],
    final_message: 'hyper-v MCP: cloud-init finished'
  }
  const network = transport === 'hvsocket'
    ? { version: 2, ethernets: {} }
    : { version: 2, ethernets: { eth0: { match: { name: 'eth*' }, addresses: [address], dhcp4: false, dhcp6: false } } }
  return {
    'meta-data': `instance-id: ${instanceId}\nlocal-hostname: ${hostname}\n`,
    'user-data': `#cloud-config\n${JSON.stringify(userData, null, 1)}\n`,
    'network-config': `${JSON.stringify(network)}\n`
  }
}

/** Writes the seed's files into dir (made fresh), for hv.ps1 'make-iso' with the label cidata. */
function write(dir, opts) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files(opts))) fs.writeFileSync(join(dir, name), text, { flag: 'wx' })
}

/** The dispatcher's source, as installed in the guest. */
function dispatcher() { return fs.readFileSync(join(__dirname, 'guest.py'), 'utf8') }

module.exports = { files, write, dispatcher, SSHD_CONFIG, FORCED, DISPATCH, TRANSPORTS }
