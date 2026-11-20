# hyper-v: upgrading

What each release changed for an installed helper. Part of the [hyper-v docs](../README.md#more).

## Upgrading

**Upgrading from an earlier release:** run setup again (step 2, the same line) in an admin terminal before
using the new server: the helper's protocol and features changed, and an older helper refuses each newer feature with
"run setup again". The pool's VMs and images are kept, and so is every setting you don't pass (MC-1592: before it, a
rerun put the VM, core, memory, disk, lease and build limits and the build folders back to their defaults, and
dropped an admin's `timingCaps`, unless they were passed again). `-Mode` and `-User` are kept from this release on; an
older install that used `-Mode Direct` or another `-User` passes them on its first rerun.

**From 2.0.0 to 2.1.0 (Linux guests):**
- Without the rerun, 2.1.0 still serves Windows guests, and refuses Linux ones with "run setup again".
- The rerun copies the new helper, compiles `HvMcpVsock.exe` (the Hyper-V socket bridge) and registers vsock port 22's
  service id.
- For Linux guests, Windows' OpenSSH Client must be present: Settings, System, Optional features. Setup says if it's
  missing, and adds nothing.
- Then plan Linux VMs: `pool_plan` with `action: "resize"`, the new `vms` count and the image (from 4.0.0,
  `image: { file: "<path to the qcow2>" }`). Approve it, then call `pool_resize`.
- New in the server, with no rerun needed: slow tools reply within about 45 s, saying "still in progress … call
  vm_wait now", and the new `vm_wait` gives their result (see [Slow operations](tools.md#slow-operations), MC-1553).

**From 2.1.0 to 3.0.0 (network modes, timings, the live-proof fixes): the rerun is required.**
- Rerun setup before using the 3.0.0 server. A 2.1.0 helper doesn't understand 3.0.0's network modes: it takes every
  `vm_start` as asking for the network, even with `network` left out. So the 3.0.0 server refuses every `vm_start`,
  `vm_reset` and `pool_plan` network mode on a helper without the `network-modes` feature, with "run setup again",
  rather than risk a wrong network (MC-1570). Most fixes are in the helper too (MC-1555 to MC-1568).
- The rerun keeps the policy's network as it was (an older `-AllowNetwork $true` becomes `-MaxNetwork Host`); pass
  `-MaxNetwork Internet` or `InternetLan` to allow more, then resize the pool to that mode (see [Network modes](../README.md#network-modes)).
- New: the timings in the server's env (see [Timings](configuration.md#timings)), and an installed uninstaller with an Installed apps entry,
  which removes everything without agents or the repo (see [Uninstall](../README.md#uninstall); the rerun installs it).

**From 3.0.0 to 4.0.0 (your images, MC-1572): rerun setup to name your own image files.**
- The helper no longer downloads images, pins them or refuses ones it doesn't know: you name any local file for the
  VMs, and the plan you approve names it with its SHA-256 (see [The image](pool.md#the-image)). `image: { download }`, Linux's
  `{ distro }`/`{ pin }` and setup's `-AllowUnpinnedIso` are gone (setup accepts and ignores that switch).
- Without the rerun, the 4.0.0 server refuses `image: { iso }` and `{ file }` on a 3.0.0 helper with "run setup
  again" (it would refuse files it doesn't know). Images and VMs you already have are kept and stay usable.
- `vm_acquire`'s `distro` takes any `/etc/os-release` ID (`debian`, `ubuntu`, `fedora`...).

**From 4.1.0 to 4.2.0 (settings, not fixed limits, MC-1579): rerun setup for the helper's side.**
- Every setting is in the shipped `combwork-mcp.example.json`'s `env` with its default, so the MCP editor shows them all
  (see [Configuration](configuration.md#configuration-env)). A setting has a default and no range of its own: a cap is left only where a larger value breaks
  something, and its reason is given.
- `vm_run`'s `timeoutSec` loses its 3600 ceiling, and `HYPERV_MCP_GUEST_SCRIPT_MINUTES` its 1-360 range.
- The timings lose their ranges (e.g. restore at most 30 min, logon 30): any value above 0 is used, except
  `HYPERV_MCP_COPY_IDLE_MINUTES`, still at most 9 (PowerShell Direct's call limit). New: `HYPERV_MCP_OUTPUT_BYTES`,
  `vm_run`'s output per stream (default 16384, formerly fixed), up to 1 MB.
- The policy loses its own ceilings: leases and work sessions longer than 24 h, any number of projects, build roots and
  project images (formerly 16), and VMs, cores, memory and disk without a ceiling of setup's (Hyper-V refuses past its
  own). The checkpoint counts may go
  up to Hyper-V's 50 per VM (formerly 8 each), and setup takes them: `-MaxLeaseCheckpoints`, `-MaxCheckpointsPerVm`,
  `-MinFreeGBForCheckpoint`. Image files have no size cap (formerly 16 GB for an ISO, 4 GB for a qcow2).
- More than one VM per session (MC-1580): one agent can hold, say, a Windows and a Linux VM together, each counted
  against the same caps; every lease tool takes `vm`, the VM's name (see [More than one VM per session](tools.md#more-than-one-vm-per-session)). Naming a VM
  needs the 4.2.0 helper: the server refuses `vm` to an older one, with "run setup again", rather than send it.
- Without the rerun, the 4.1.0 helper keeps its ranges, and ignores `HYPERV_MCP_OUTPUT_BYTES` (16 KB).

**From 4.0.0 to 4.1.0 (any terminal, MC-1575): rerun setup to get the new lines.**
- Setup, approvals and the uninstaller each take one line that works the same in any admin terminal (cmd, Windows
  Terminal, Windows PowerShell or PowerShell 7), and they run under PowerShell 7 on a Windows without Windows PowerShell.
- Until the rerun, the 4.0.0 helper still gives the old `powershell -File ... approve.ps1` line, which still works.
- New builds add no guest tweaks of their own (MC-1577): no Defender exclusions and no `DisableForceUnload` policy. Put
  any you want in your own guest setup script, named in the plan (see [Guest setup script](pool.md#guest-setup-script)). VMs you already have keep
  what their clean checkpoint holds.
