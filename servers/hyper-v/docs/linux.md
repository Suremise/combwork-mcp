# hyper-v: Linux guests

Linux VMs from a qcow2 cloud image, behind the same tools. Part of the [hyper-v docs](../README.md#more).

## Linux guests

A pool can hold **Debian 13** and **Ubuntu 26.04 LTS** VMs beside Windows ones, from 2.1.0 (MC-1500's design,
[docs/linux-guests.md](../docs/linux-guests.md); built in MC-1501, proven in MC-1542), behind the same tools: an agent asks
for one with `vm_acquire({ distro: 'debian' })` or `({ distro: 'ubuntu' })`, and reaches it by SSH over the Hyper-V
socket, with no network path. It needs Windows' OpenSSH Client. Everything that doesn't depend on the OS is the same: the helper and its
approvals, the policy, trusted storage, leases and the line, the journal, the restore before every start, quarantine,
warm sessions, lease and pool checkpoints. Each OS has a small **guest driver** inside the helper for the two things that
differ: how a VM is built, and how the helper talks to its guest.

- **Which distros:** any qcow2 cloud image you choose that the build can drive: cloud-init (a NoCloud seed), systemd,
  OpenSSH and the `hv_sock` module. Debian 13's `genericcloud` and Ubuntu 26.04's `server-cloudimg` images have been
  run. Others with those pieces should work the same way: one without them fails at the build step that needs it, by
  name. Hyper-V can't run macOS.
- **The images:** `pool_plan({ action: 'create' | 'resize', image: { file: "<path to the .qcow2>" } })`, a file you
  downloaded yourself (from the distro's own cloud image pages; checking its published checksums is your step). As for
  Windows (see [The image](pool.md#the-image)), the helper copies it while hashing it, and the plan you approve names its path and
  SHA-256: that approval is the trust. The helper downloads nothing and fetches no checksums.
  - **Converted with nothing installed.** The distros ship qcow2. The helper's own bounded reader writes a VHD, which
    refuses backing files, encryption, snapshots, unknown features and anything out of bounds. Hyper-V's own
    `Convert-VHD` then makes the base VHDX. Its hash is recorded and checked again before each VM is copied from it.
- **The build** (offline, about a minute or two per VM; the plan lists it):
  1. The VM is a copy of the base VHDX, grown to the plan's size, with Secure Boot (Microsoft's UEFI CA, which signs the
     distros' shim).
  2. It gets a cloud-init NoCloud seed:
     - users `hvadmin` and `hvuser` with locked passwords;
     - an SSH host key and a client key, both made by the helper, so the host key is pinned before the first boot;
     - `hvadmin`'s only key is the helper's, restricted to a forced command, `sudo` of the guest's fixed dispatcher
       (`helper/guest.py`) and nothing else. `hvuser` has no key and no sudo;
     - sshd only on the Hyper-V socket, the distro's own sshd masked;
     - systemd-resolved's LLMNR and mDNS responders off (a drop-in, MC-1550), since Debian's cloud image otherwise
       answers LLMNR on port 5355 on every address;
     - the wait-online units masked (MC-1551), since the guest has no network. Ubuntu's otherwise held every boot for
       2 minutes.
  3. Its first boot writes allowlisted diagnostics to COM1, a pipe for the build only.
  4. The build waits for the authenticated round trip to the dispatcher, then for cloud-init to finish.
  5. It checks the guest: its distro and release, the keys, the sudoers rule, the units, no address and nothing listening
     beyond loopback.
  6. It turns cloud-init off for good and removes cloud-init's cached copy of the seed (MC-1551), the seed and the COM
     port (verified), then takes the clean checkpoint Off.

  A guest that never answers fails the build, saying why from its diagnostics (for example "no hv_sock driver"), or
  that the cause is unknown. Either way the VM is rolled back, and nothing switches to another transport: that's the
  user's decision. The reason also carries the last SSH attempt's error (MC-1544), and says where the connection
  stopped (MC-1545):
  - "connect never completed (host side)";
  - "connected, guest saw no connection";
  - "guest started sshd, which exited …";
  - "guest started sshd, no SSH banner".

  It knows from HvMcpVsock.exe's own lines, the build's verbose ssh attempts (their last 10 lines, cleaned), and the
  guest's report of each connection on COM1, which is read through the whole wait.
- **Keeping a failed build, for debugging only** (MC-1545, off by default):
  - `pool_plan({ action: 'create' | 'resize', image, debugKeepFailedBuild: true })`, for a Linux plan, and only when the
    user asks; the plan says so, and the user's approval covers it.
  - A failed build then keeps its VM: put in that state and read back as running and disconnected, flagged KEPT FOR
    DEBUG, never leased or restored. If that state can't be confirmed, it's rolled back as usual, and the reason says
    so. Its seed, which holds its host key, stays with it.
  - **No new access comes with it.** The guest's accounts stay locked, and SSH stays the helper's forced command
    only. An administrator can still:
    - watch its console in Hyper-V Manager (boot and kernel messages);
    - open its COM1 pipe (`Get-VMComPort -VMName <vm> -Number 1` in an admin PowerShell shows its name) to see the
      guest's diagnostics, each connection included;
    - run `HvMcpVsock.exe <vmId> 22` in an admin PowerShell, to retry the Hyper-V socket from the host and see whether
      it connects and whether sshd's banner comes back.
  - A resize plan with no image and `vms` equal to the number of other VMs in the pool (`pool_plan` with
    `action: "resize"`) removes it and nothing else. Any other create or resize removes it too, along with the changes
    it asks for. A remove plan removes the whole pool, kept VM and all (MC-1549).
- **Talking to the guest** is SSH over a **Hyper-V socket**, the channel PowerShell Direct uses, so a Linux guest has no
  network path at all.
  - The helper runs Windows' in-box `ssh.exe` with fixed arguments: no config file, the VM's own key and pinned
    `known_hosts`, batch mode. Its ProxyCommand is setup's `HvMcpVsock.exe`, which connects to the VM's vsock port 22.
  - The bridge reads and writes ssh.exe's pipes with overlapped I/O (MC-1549). ssh.exe hands its ProxyCommand
    overlapped pipes, and synchronous reads on them passed only ssh's first write. A host-only test runs the real
    ssh.exe through a test build of the bridge against a local fake SSH server.
  - Each request goes on stdin, as JSON, and the remote command is always the forced one.
  - The keys stay in the helper's secrets folder: never in a reply, plan, journal or log.
- **The tools on Linux:**
  - `vm_acquire({ os: 'linux' })` or `({ distro })`;
  - the build goes to `/build` (root's, read-only to `hvuser`; a file is executable if it starts with `#!` or is an ELF
    binary), and runs write to `/out`;
  - `vm_run` takes `bash` (the default) or `sh`, as root or `hvuser`. Each run is its own systemd unit: a timeout kills its
    whole cgroup. Its command and captured output stay in its own run folder, readable only by the run's account
    (MC-1551), so `/out` holds only what runs write there, and a user run can't read an admin run's command or output;
  - `vm_sync` streams only the changed files to the dispatcher, which checks each file's size and hash, never follows a
    symlink (an `openat` walk with `O_NOFOLLOW`), and keeps `vm_sync`'s rules;
  - `vm_read_out`, `vm_reset`, `vm_stop` and `vm_release` behave as for Windows;
  - `interactive` and `session: 'interactive'` are refused: there's no desktop.
- **Checkpoints:**
  - A lease checkpoint of a Linux VM is taken with the guest shut down (no VSS in the images), then the VM starts again.
    It's the same promise as Windows': files and installed software, no running programs.
  - Pool checkpoints work as for Windows; there's no logon to undo.
  - A refresh-clean checks the guest again. A change to its seeded files needs a rebuild.
- **Windows and Linux together:** one session may hold both (see [More than one VM per session](tools.md#more-than-one-vm-per-session)).
- Needs a helper with the `linux` feature: the server asks no Linux VM of an older helper, and says to run setup again.
