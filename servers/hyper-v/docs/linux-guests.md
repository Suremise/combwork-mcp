# MC-1500 design: Linux guests (Debian, Ubuntu) behind the same hyper-v tools

One server, one pool, one helper. Linux plugs in as a new image kind on MC-1502's pool model (images tagged by OS,
`vm_acquire({ os })`, per-OS caps). It also adds a **guest driver** per OS for the two things that differ: install and
talking to the guest. The helper service, approvals, trusted storage, leases, the journal, the line, checkpoints, warm
sessions and build roots don't change.

## 1. The guest-driver boundary

`helper/guests/windows.js` and `helper/guests/linux.js` export the same interface. core.js picks one by `osOf(vm)` and
never branches on the OS itself, except to refuse something a driver says it doesn't support.

| Driver call | Windows (today's code, moved unchanged) | Linux |
|---|---|---|
| `diskFrom(image, plan)` | empty VHDX + the ISO + answer-file ISO | copies the image's verified base VHDX, `Resize-VHD` to the plan's size, plus a NoCloud seed ISO (§3) |
| `firmware` | Gen 2, Secure Boot `MicrosoftWindows` | Gen 2, Secure Boot `MicrosoftUEFICertificateAuthority` (Debian and Ubuntu boot through Microsoft's signed shim) |
| `install(vm)` | unattended setup, guest setup, licence, profiles, Defender | first boot from the seed, cloud-init finishes, then the guest steps (§3) |
| `guestSteps(vm)` (build and refresh-clean) | guest setup, registry policy, Defender | reinstall and verify the fixed guest scripts, units and sshd config (§3) |
| `ready(vm)` | heartbeat, then PowerShell Direct | heartbeat (hv_utils), then an SSH `ready` |
| `runStart / runPoll / runKill` | `guest-run-*` over PowerShell Direct | SSH to the guest dispatcher (§4) |
| `copyIn / syncIn` | `Copy-Item -ToSession` + guest-sync.ps1 | a stream into the guest dispatcher's `sync` (§5) |
| `list / read` | guest-list / guest-read | dispatcher `list` / `read` |
| `shutdown` | Stop-VM (graceful) | Stop-VM (graceful, hv_utils' shutdown service); SSH `poweroff` as the fallback |
| `logonUndo` | today's verified undo | nothing to undo (no logon exists): a no-op that still reports "verified" |
| `licence` | evaluation / own copy | none: "Linux, no licence to track", no expiry |
| `leaseCheckpointMode` | `production` (VSS) | `off`: shut down, standard checkpoint of the Off VM, start again (§6) |
| `supports` | everything | not `interactive` / `session: 'interactive'` (refused: "Linux guests have no desktop session"), not `shell: cmd/powershell` |

hv.ps1 keeps the actions that don't depend on the OS (facts, find-vm, create-vm with a `firmware` and `disks` argument,
start, restore, snapshots, net-*, configure-start, pool-take, remove-vm, make-iso). It gains `vhd-convert` (§2) and
`checkpoint-off`. Every `guest-*` action stays Windows-only. The Linux driver never goes through hv.ps1 to reach the
guest: it uses `helper/ssh.js` (§4).

**The rules behind the boundary stay the OS-agnostic ones:** the three-way ownership check, the restore before every
start and its fresh-read verification (MC-1536/1537), quarantine, the journal, leases and the line.

## 2. Image trust

**Format.** Hyper-V takes VHD or VHDX. Debian 13 publishes no VHD (its `azure` tar.xz is raw, and Node has no xz).
Ubuntu 26.04 LTS has no Azure VHD in its release folder (24.04 still did). Both publish **qcow2**:
`debian-13-genericcloud-amd64.qcow2` (328 MB) and `ubuntu-26.04-server-cloudimg-amd64.img` (qcow2, 822 MB). So one
path serves both:

1. **Download** over HTTPS (certificate checks on, redirects only within the same allowed host) from
   `cloud.debian.org` or `cloud-images.ubuntu.com`, nowhere else. Only a **dated** build folder is used, never `latest/`
   or `current/` (e.g. Ubuntu `releases/26.04/release-20261108/`, Debian `images/cloud/trixie/<serial>/`), copied into
   the helper's folder **while hashed**, as the ISO is today.
2. **Verify, all of these, before anything reads the image:**
   - **pinned:** the file's name, size and hash are in the server's pinned table (`PINNED_LINUX` beside today's
     `PINNED`), with the distro, release, build serial and URL. **Anything not in the table is refused, whether
     local or downloaded, with no policy override for Linux.** `-AllowUnpinnedIso` stays Windows-only;
   - **the distro's published checksums agree:** the helper also fetches that folder's checksum file and checks that
     its line for the file equals the pin. Ubuntu: `SHA256SUMS`. Debian: `SHA512SUMS` (Debian's pins record SHA-512,
     and SHA-256 too for the image's identity);
   - **signature (Ubuntu):** `SHA256SUMS.gpg` is a detached OpenPGP signature. The helper verifies it itself, in Node
     with no gpg: a small bounded OpenPGP v4 signature-packet parser plus `crypto.verify` (RSA PKCS#1 v1.5,
     SHA-256/512), against the **UEC Image Automatic Signing Key**, pinned in code by its key material and fingerprint.
     A bad or missing signature is refused;
   - **Debian has no signature to check:** `cloud.debian.org` publishes `SHA512SUMS` with no signature in its cloud
     folders. Debian's trust is then the pin plus TLS to Debian's host, the same as the Windows evaluation ISO today
     (Microsoft publishes no hash either). The plan says so in a line: "Debian publishes no signature for cloud images:
     authenticated by the pinned hash and HTTPS from cloud.debian.org."
3. **Convert, read-only and bounded:** a small qcow2 reader in Node (`helper/qcow2.js`, in the style of iso.js) handles
   v2/v3, L1/L2 tables and zlib-compressed clusters. It refuses backing files, encryption, external data files,
   extended L2, zstd compression, a virtual size over the policy's disk cap, and any table or offset out of bounds. It
   writes a **dynamic VHD**, skipping zero blocks, then hv.ps1 `vhd-convert` (`Convert-VHD`) makes the base VHDX in the
   disk folder's `images\`. Its SHA-256 is recorded with the image. A create copies that base, rechecking its hash
   first.
4. **Sanity after the first boot, never verification:** the guest's `/etc/os-release` (`ID`, `VERSION_ID`) and its
   build serial (Ubuntu's `/etc/cloud/build.info`, Debian's image serial in its `/etc/` image metadata, whichever the
   trial shows is reliable) must match the pin, or the build fails, as Windows' edition and build check does today.

**Pins and staleness.** A pin is a server release (MC-1501 fills the table once downloads are allowed). Distros
eventually prune dated folders: an old pin then can't be downloaded, but an image already verified and stored keeps
serving. A new serial is a new pin in a new release. Guests are offline and restored after every lease, so lagging
security updates matter less here than on a server.

`pool_plan` names the image as "Debian 13 (trixie) genericcloud amd64, build <serial>, SHA-256 <12 hex>, pinned;
checksums: SHA512SUMS (unsigned) / SHA256SUMS signed by Ubuntu's image key". `vm_status` and `pool_status` show each
VM's OS, distro, release and serial.

## 3. Install: cloud-init NoCloud and SSH keys

**Per VM, generated by the helper at create** (Node `crypto.generateKeyPairSync('ed25519')`, written in OpenSSH's
`openssh-key-v1` format by a few lines of our own, so no ssh-keygen):
- a **client key**: the helper's key for that VM's `hvadmin`;
- a **host key**: the guest's sshd host key, generated on the host, so the helper's `known_hosts` entry for the VM is
  pinned before first boot (no trust on first use).

Both private keys go in the helper's secrets folder, beside the guest passwords: readable only by SYSTEM,
Administrators and the service. They're never in a reply, plan, journal, log or the stub's calls (tests assert it).
**Agents never get a key or an SSH endpoint:** every guest action goes through the helper, as PowerShell Direct does
today.

**The seed:** `make-iso` (today's IMAPI2 action) builds a `cidata`-labelled ISO holding `meta-data` (a random
instance-id), `network-config` (`version: 2`, no addresses: the guest stays off the network) and `user-data`:
- users: `hvadmin` (sudo only for the dispatcher, below) and `hvuser` (no sudo), both with **locked passwords**;
- `ssh_keys:` the generated host key; `ssh_pwauth: false`; and `disable_root: true`;
- `write_files:` the fixed guest files (below), and `runcmd:` to enable the units.

**Locked down in the guest:**
- `hvadmin`'s `authorized_keys` holds only the helper's key, as
  `restrict,command="/usr/local/libexec/hvmcp/dispatch"`: a **forced command**, with no pty, forwarding, agent or X11.
  A leaked key reaches nothing but the dispatcher;
- sudoers allows `hvadmin` exactly `/usr/local/libexec/hvmcp/dispatch`, as root, with no password. `hvuser` has no
  key and no sudo;
- sshd runs only on the Hyper-V socket (§4): our `hvmcp-sshd.socket` (`ListenStream=vsock::22`, `Accept=yes`) starts
  `sshd -i -f /etc/ssh/hvmcp_sshd_config`. That config allows only public-key auth for `AllowUsers hvadmin`, with no
  passwords, no keyboard-interactive and no forwarding. The distro's own `ssh.service` and `ssh.socket` are disabled
  and masked, so nothing listens on TCP, even with `network: true`;
- `/build` is owned by root and read-only to `hvuser`, as `C:\build` is. `/out` is writable by both, and `/hvmcp`
  (staging, runs) is root's.

**The build's steps, all offline:** boot from the seed. Wait for SSH `ready`, then for `cloud-init status --wait` to say
done with no errors (bounded: 15 minutes). Then:
1. verify what matters: the units, the masked distro sshd, no TCP listener (`ss -ltn` empty), no IP address, the keys,
   the sudoers line, the os-release sanity check;
2. `touch /etc/cloud/cloud-init.disabled`, so later boots never rerun cloud-init or regenerate keys;
3. shut down, detach and delete the seed ISO (it held the host key), and take the clean checkpoint Off and
   disconnected, as Windows does.

Nothing goes online at build: no activation step, no package installs. Everything we need is already in both images:
openssh-server, systemd, sudo, bash and python3 (cloud-init itself needs it).

**The guest scripts** are one fixed Python 3 file, `helper/guest.py`, installed as the dispatcher (stdlib only,
root:root 0755). It reads one JSON request on stdin, plus a framed byte stream for `sync`, and answers JSON. Its
actions: `ready`, `verify`, `run-start`, `run-poll`, `run-kill`, `sync`, `list`, `read` and `poweroff`. It's the Linux
counterpart of guest-sync.ps1 and the `guest-*` blocks, and is tested the same way, for real, against temp trees.

## 4. Talking to the guest: SSH over a Hyper-V socket (recommended), or the internal switch

The card's agreed shape was SSH over the pool's internal switch. Looking closer, there is a better transport, and it's
**a choice for the user**:

**A. Hyper-V socket, AF_HYPERV ↔ AF_VSOCK (recommended).** PowerShell Direct itself runs over Hyper-V sockets. Linux
has the same channel (`hv_sock`): a guest listener on vsock port 22 is reached from the host by VM id and the service
GUID `00000016-facb-11e6-bd58-64006a7986d3`.
- **No network at all:** the guest has no IP path to the host or to other guests, so "network off" holds for Linux
  exactly as for Windows, and `network: true` keeps its present meaning (the internal switch, for one run).
- **Host side:** a bridge, `HvMcpVsock.exe <vmId> <port>`, piping stdio to an AF_HYPERV socket. It's compiled by setup,
  like HvMcpHost.exe, from `helper/host/HvMcpVsock.cs` into Program Files (admin-only). The helper runs
  `%SystemRoot%\System32\OpenSSH\ssh.exe` with **fixed arguments**, `shell: false`, and these options: `-F none`,
  `-i <vm key>`, `-o IdentitiesOnly=yes`, `-o BatchMode=yes`, `-o StrictHostKeyChecking=yes`,
  `-o UserKnownHostsFile=<state>\ssh\<vmId>.known_hosts`, `-o ProxyCommand=<HvMcpVsock.exe> <vmId> 22`,
  `hvadmin@hvmcp`. The request goes on stdin. The remote command is the forced one, so an agent's text is never in an
  argument, on either side.
- **Setup:** registers the service GUID under
  `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices` (admin, once, removed
  at uninstall). It checks that the in-box **OpenSSH Client** is present, and if it isn't, says how to add it (it
  never adds features itself).
- **Risk:** the guest kernel must have `hv_sock` (`CONFIG_HYPERV_VSOCKETS`). Debian's `cloud-amd64` and Ubuntu's
  generic kernels are built with Hyper-V support, but whether hv_sock ships in the cloud image (rather than in
  Ubuntu's `linux-modules-extra`) is **the trial's first check**. If it's missing, B below, with no change to the rest.

**B. Internal switch (the card's original shape).** The guest gets a static address from the seed's `network-config`,
always connected to the pool's internal switch. Setup gives the host's vEthernet adapter for that switch a static
address. The VM's adapter gets **port ACLs** (`Add-VMNetworkAdapterExtendedAcl`: only TCP 22 from the host's address
in, everything else denied), so guests can't reach each other. Setup also adds a host firewall rule blocking
everything inbound from that subnet. The costs:
- a permanent IP path from every Linux guest to the host's network stack, held shut by ACLs and a firewall rule;
- two more host settings changed (an adapter address and a firewall rule), where today the README promises none;
- `network: true` then means nothing new for Linux.

**Either way:** `helper/ssh.js` (the Linux driver's transport) bounds each call's time and output, and kills the
ssh.exe child by its handle on timeout. The README's "runs no program but powershell.exe and node" becomes "...and
`ssh.exe` from System32 and its own `HvMcpVsock.exe`, each with fixed arguments; an agent's text only ever on stdin".

## 5. Runs, sync, read-out, reset and warm sessions on Linux

**`vm_run`:** `shell` is `bash` (the default on a Linux lease) or `sh`. `cmd` and `powershell` are refused, and so is
`bash` on Windows. `as` is `admin` (root, through the dispatcher) or `user` (`hvuser`). `cwd` defaults to `/build`.
- **Start:** the command arrives as JSON data and is written to `/hvmcp/runs/<n>/cmd.sh` (0644). It's started as
  `systemd-run --unit=hvmcp-run-<n> --uid=<root|hvuser> --working-directory=<cwd> --collect`
  `-p StandardOutput=file:/out/.run-<n>.out -p StandardError=file:/out/.run-<n>.err /bin/bash /hvmcp/runs/<n>/cmd.sh`.
  A wrapper writes the exit code aside and renames it into place, as on Windows.
- **Poll:** with short SSH calls, as on Windows: the same start-then-poll shape and the same deadline. There's no
  10-minute limit on SSH, but one shape keeps the server and the tests the same, and survives a dropped call.
- **Timeout:** `systemctl kill` then `stop` on the run's own unit kills its **whole cgroup**, so no PID reuse question.
  A command that daemonised inside its unit dies with it.
- **The reply is the same:** the exit code and 16 KB of each stream.

**`vm_start` / `vm_sync` / `copyIn`:** the server-side manifest, hashing, roots checks, plans, generations and
untrusted-until-full-sync rules don't change; they're the helper's, not the guest's. Only the last hop differs. The
helper streams the plan's staged files into `dispatch sync` over SSH stdin, as a framed stream of our own (a JSON
header per file with path, size and SHA-256, then the bytes). guest.py checks everything before it changes anything,
with guest-sync.ps1's rules in POSIX terms:
- every path component is opened with `O_NOFOLLOW`, relative to its parent's directory fd (`openat`): a symlink on the
  way, or as `/build` itself, is refused;
- each file is staged under `/hvmcp/staging/<gen>`, its size and hash checked, then `rename`d into place;
- deletes never follow a link (`unlink`, and `rmdir` after a no-follow walk);
- `delete: false` blockers are refused with nothing changed.

**Why not scp or rsync:** rsync isn't on Windows hosts, and scp's remote side parses paths. A fixed dispatcher keeps
exactly the checks Windows has.

Two Linux-specific rules:
- **Execute bits:** Windows files carry none. A file is made 0755 if it starts with `#!` or is an ELF binary, and 0644
  otherwise; folders are 0755, all owned by root.
- **Case:** the guest is case-sensitive, but the helper's record stays keyed by Windows identity (the host's builds
  come from NTFS). So a host rename that changes only case keeps its old spelling in the guest, exactly as today, and
  `full: true` puts it right.

**`vm_read_out`:** `dispatch read` and `list` under `/out` use the same no-follow walk, with the same caps applied
while reading. The data comes back base64 in JSON, and the server's path checks are unchanged (Windows' extra ones
are harmless here).

**`vm_reset`, `vm_stop`, release, the deadline, a disconnect:** unchanged. They're Hyper-V operations on the VM
(restore clean by id, verified Off, at the checkpoint, disconnected, reserve 0). A warm session works as today: one
running guest, with syncs between runs.

## 6. Checkpoints on Linux (MC-1529, MC-1531, MC-1532)

- **Lease checkpoints (`vm_checkpoint`):** Windows uses production (VSS) checkpoints. Linux could only do the same with
  `hv_vss_daemon` (hyperv-daemons), which isn't in either image and can't be installed offline. So Linux takes them
  **Off**:
  1. the guest is shut down gracefully;
  2. a standard checkpoint is taken of the Off VM, under the same journalled `hvmcp-lease-<id>` name and the same
     unconfirmed-take rules (hv.ps1 `checkpoint-off`);
  3. the VM is started again and awaited.

  **The promise is the same:** files, installed software and configuration, no memory, no running programs. It costs
  one guest reboot, about 10 s on these images. `/build` stays confirmed across it, since the disk is unchanged. We
  never fall back from Off to a standard checkpoint of a running VM.
- **`vm_restore`, pool checkpoints and refresh-clean** already work on an Off VM. Pool checkpoints' logon undo is a
  no-op, and the rest (disconnect, shutdown, checkpoint Off, publish) is the same. Refresh-clean reruns the Linux
  driver's `guestSteps` (reinstall and verify guest.py, the units and the sshd config), with no cloud-init rerun.
- **OS on every record**, as today: `vm_acquire({ checkpoint, os })` disambiguates a name used on both kinds.

## 7. Tools: what agents see

The same tools, with nothing new:
- `vm_acquire({ os: 'linux', image? })`. A plain `os: 'linux'` takes any Linux image; to choose a distro, give `image`
  (a SHA-256 prefix), or use the new `distro: 'debian' | 'ubuntu'` filter. **That filter is a choice for the user:** it's
  convenient, but it's one more argument. Without it, `image` covers it;
- `vm_status` and `pool_status` show OS, distro, release and serial;
- `pool_plan({ image: { distro: 'debian' } })` picks the newest pinned Debian; or give a pin's SHA-256.

There's still **one VM per session**: two VMs in one session stays out unless a real need shows up (MC-1502's note).

**Protocol:** a helper feature `linux` (protocol 3, like `images`). The server sends no Linux `vm_acquire` and no
Linux `pool_plan` to a helper without it, and says "run setup again".

## 8. Setup changes

- Registers the hv_sock service GUID (A), or the adapter address, firewall rule and port ACLs (B). Either way it's
  undone by uninstall, recorded, and shown in setup's report.
- Compiles `HvMcpVsock.exe` (A), and checks for the OpenSSH Client.
- Installs the new helper files (`guests/*.js`, `ssh.js`, `qcow2.js`, `openpgp.js`, `guest.py`). Setup's helper file
  list and its test pick them up.
- Adds no new policy fields. Per-OS caps in the projects file already exist.
- Changes no Windows feature and doesn't restart the PC. It still never changes the firewall or adapters under A.

## 9. Other Debian-family distros

| Distro | Official cloud images with cloud-init? | Worth supporting? |
|---|---|---|
| Debian 13 (stable) | yes (genericcloud qcow2) | **yes, now** |
| Ubuntu 26.04 LTS | yes (cloudimg qcow2, signed sums) | **yes, now** |
| Debian 12 (oldstable, LTS to 2028) | yes, same layout | later, as pins only: no code |
| Ubuntu 24.04 LTS | yes (it also has an Azure VHD) | later, as pins only: still widely targeted |
| Kali | publishes VM and cloud-marketplace images, but not as a pinned, checksummed generic cloud-init image in the same way | no |
| Devuan | no official cloud images, and no systemd (our units need it) | no |
| Linux Mint, Pop!_OS, Zorin, elementary, MX, Raspberry Pi OS | desktop ISOs only, or ARM-only | no |

So the driver is "Debian family with systemd and cloud-init". A new release of Debian or Ubuntu is a pin, not code.

## 10. Tests (MC-1501, on the stub)

- The stub gains a Linux kind (it already fakes one in the journal) and a fake guest dispatcher, the same Python file
  run for real against a temp root with real symlinks.
- New suites:
  - `linux-image.test.js`: pins, checksum lines, the OpenPGP verify against a test key plus tampered and
    other-key signatures, the qcow2 reader's malformed cases, and conversion;
  - `linux-guest.test.js`: install verification, no keys in replies or logs, forced command, runs, timeouts by unit,
    sync's no-follow rules and exec bits, read-out, Off lease checkpoints, refusals (interactive, cmd), and the
    feature gate;
  - existing suites run once per OS where the behaviour is shared (leases, sessions, checkpoints, pool checkpoints,
    recovery).

## 11. The real trial (only with the Assistant's go: the CLI team holds both Windows VMs)

Trial steps:
1. **Prerequisites:** setup rerun; pins filled from downloads the Assistant allows; one approved plan adding **one
   Debian and one Ubuntu VM** (2 cores, 4 GB, 32 GB each) beside the two Windows VMs, within `maxVms` 4.
2. **Transport first:** `lsmod | grep hv_sock` on each, then the SSH-over-vsock ready check. If hv_sock is missing, stop
   and switch to B.
3. **Build and test, side by side:** two sessions in one project, one leasing Debian and one leasing the Windows VM the
   CLI team frees (or a timed window). Then:
   - the same small Node project built on the host, its tests run in both guests at once, with a pinned Node linux-x64
     tarball carried in the build (guests are offline; tools come in the build);
   - `vm_sync` of one edit, then a rerun;
   - `vm_checkpoint`, then `vm_restore`, and `vm_reset`;
   - a pool checkpoint "node" published from the Debian lease, then a second lease acquired from it with no reinstall.
4. **Confinement checks:**
   - no address on eth0 and no TCP listener;
   - a sentinel gone after release;
   - the forced command refusing a shell;
   - no key anywhere an agent can read (replies, logs, `%ProgramData%` as the user);
   - the host's build unchanged after root writes `/build`;
   - the helper and host each killed mid-run and recovered.
5. Ubuntu repeats steps 3 and 4 (shorter). Then release everything and confirm the CLI team's VMs were never touched.

## Choices for the user

1. **Transport:** A, the Hyper-V socket (recommended: no network path at all, the same channel PowerShell Direct uses,
   one registry key at setup), or B, the internal switch (as first agreed: a standing IP path held shut by ACLs and a
   firewall rule, and two host settings changed).
2. **Debian's trust:** pin plus HTTPS only, since Debian doesn't sign its cloud image sums. Accept, or Ubuntu only
   until Debian signs? Recommend accept: it's the same as the Windows evaluation ISO.
3. **`vm_acquire({ distro })`:** add the convenience filter, or `image` only. Recommend `distro`.
