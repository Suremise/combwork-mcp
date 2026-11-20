# hyper-v

An MCP server that gives agents **disposable Hyper-V test VMs** from a pool. An agent leases a VM, starts it from its
clean checkpoint with a build copied in, runs commands, reads files back, and stops it, which restores it. Several
agents can each hold VMs at once, Windows or Linux (from a qcow2 cloud image you choose). A work session can keep its
VM running (`vm_sync`, `vm_reset`, `vm_renew`); release still restores it. VMs are disposable by default; a pool may
also hold **persistent** VMs, built only when you ask, which keep their state and their checkpoints between leases
for research (see
[Persistent VMs](docs/tools.md#persistent-vms-a-vm-the-user-keeps-for-research-mc-1582)).

It's the catalogue's alternative to [`windows-sandbox`](../windows-sandbox/): Windows Sandbox runs one guest at a time,
this pool as many as you give it. It runs over stdio (`node server.js`) with Combwork or any MCP client, uses only Node
built-ins, and its version is in [meta.json](meta.json). MIT licence ([LICENSE](../../LICENSE)).

## How it fits together

```
agent ──stdio──> server.js (runs as you; no Hyper-V rights)
                   └── named pipe \\.\pipe\hyperv-mcp (the "Hyper-V MCP Users" group, Administrators, SYSTEM)
                        └──> service HyperVMcp (NT SERVICE\HyperVMcp, the only one in Hyper-V Administrators)
                               node helper.js: every rule about VMs, the pool and approvals; journals every change
                                 └──> powershell hv.ps1: one fixed script; arguments as JSON on stdin
```

**The helper is the security boundary.** It checks every rule itself, against a policy only an administrator can
write. Your account isn't in Hyper-V Administrators, so agents running as you can't drive Hyper-V directly.

## Requirements

- Windows 11 **Pro, Enterprise or Education** with **Hyper-V** on, and virtualisation on in the firmware.
- **Node 18+**, installed for all users (under `Program Files`). Setup checks it.
- An image you choose: a Windows x64 ISO (for example Microsoft's Windows 11 Enterprise evaluation), a Windows disk you
  prepared, one of your own VMs, or a Linux qcow2. The helper never downloads one.
- About 40 GB per VM. For Linux guests, Windows' in-box OpenSSH Client.

## Safety at a glance

- The helper acts **only on VMs it created** (prefix, journal id and folder, each checked twice), writes only to its
  state folder and the disk folders setup named, and never exceeds `policy.json`, whatever a plan says.
- A disposable VM (the default) restores its **clean checkpoint** at every start, and at every stop and release
  restores and verifies it. A VM that can't be confirmed clean is quarantined. A **persistent** VM (only when a plan you
  asked for builds one) is shut down and disconnected instead, and keeps what its leases left for the next lease that
  names it; it gives that guarantee up, and is restored only on request.
- No host folder is shared into a guest: builds are **copied** from your MCP roots (by real path, links skipped).
- **Network is off** unless a run asks for a mode at or below the pool's and the policy's.
- **Don't put real sign-ins, tokens or real CLIs in a VM.** Use fake CLIs and test accounts.

### What the confinement guarantees

- **Guaranteed**, whatever any program running as you sends to the pipe: nothing outside the pool is touched; nothing
  is written outside the helper's folders; nothing exceeds the policy; every lease of a disposable VM starts clean; no
  host folder is shared into a guest.
- **Not guaranteed:** that a build came from your roots, against a program running as you (it can send only files it
  could already read); that the **person** approved a change, if your account is an administrator and a program uses a
  UAC bypass; anything at all against a determined agent in **direct mode** (see [setup](docs/setup.md)).

The full model: [docs/security.md](docs/security.md).

## Setup

1. Turn on Hyper-V, and check `Get-Service vmms` says Running.
2. In an **admin terminal** (cmd, Windows Terminal, Windows PowerShell or PowerShell 7), one line, naming a folder for
   the VMs' disks:
   ```
   cmd /c call "C:\path\to\combwork-mcp\servers\hyper-v\setup\install.cmd" -DiskFolder D:\hyperv-mcp
   ```
   It installs the helper service, the group **Hyper-V MCP Users** (with you in it), the state folder and
   `policy.json`, the pool's limits. They default from the host; set any with `-MaxVms`, `-MaxCoresPerVm`,
   `-MaxMemoryGB`, `-MaxDiskGBPerVm`, `-MaxNetwork None|Host|Internet|InternetLan`, `-MaxLeaseMinutes` and the rest
   ([every option](docs/setup.md)). `-ApprovePoolChanges WithinCaps|Each` chooses which pool changes need your
   approval (below). It never enables a Windows feature or restarts the PC. Run it again to update or change the
   policy: a rerun keeps every setting you don't pass, the disk folder included, and changes only those you do. Its
   output lists which it kept and which it changed. Host defaults apply only on a first install.
3. Add the server to your client, with `HYPERV_MCP_ENABLED=1`:
   ```json
   { "mcpServers": { "hyper-v": { "command": "node",
       "args": ["C:\\path\\to\\combwork-mcp\\servers\\hyper-v\\server.js"], "env": { "HYPERV_MCP_ENABLED": "1" } } } }
   ```
   For a client that sends no MCP roots, add `"HYPERV_MCP_ROOTS_FROM_CWD": "1"` or `HYPERV_MCP_ALLOWED_ROOTS`. Every
   setting is in `combwork-mcp.example.json` with its default ([configuration](docs/configuration.md)).
4. Ask an agent to plan a pool (next section).

**Upgrading:** run setup again before using a new server. `install.cmd` with no options is enough: a rerun keeps your settings,
`-Mode` and `-User` included. The one exception is an install from before this release that used `-Mode Direct` or
another `-User`: pass those once, since its policy didn't record them. An older helper refuses
newer features with "run setup again"; the pool's VMs and images are kept. What each release changed:
[docs/upgrading.md](docs/upgrading.md).

## Building the pool

Ask an agent, for example "plan a hyper-v pool of 2 VMs from D:\Downloads\Win11_Eval.iso". It calls `pool_plan`,
which changes nothing and returns the exact plan: VM names, cores, memory, disk, the image (its path and SHA-256) and
the pool's network mode. The first plan checks the image (a few minutes); the agent then plans again.

**Which changes need your approval** is setup's `-ApprovePoolChanges`:
- **`WithinCaps`** (the default): a plan within the policy applies when the agent calls it: the VM count, sizes, network
  mode, removals, refreshes, pool checkpoints, and more VMs from an image you already approved. A **new image**, a
  **guest setup script** or a **ready-made disk** still needs your approval, and the plan says so.
- **`Each`**: every plan needs your approval.

To approve, run the plan's one line in an **admin terminal**:
```
cmd /c call "C:\Program Files\hyperv-mcp\approve.cmd" -Plan p-0123456789abcdef
```
It shows the plan from the helper's own record and asks for the first 6 characters of its digest. Never let an agent
run it. Then the agent calls `pool_create` (or `pool_resize`, `pool_remove`); `pool_status` follows the build, about
20-40 minutes per Windows VM, offline.

More: the build, guest setup scripts, licences, images and ready-made disks in [docs/pool.md](docs/pool.md); Linux
guests in [docs/linux.md](docs/linux.md).

## Tools

| Tool | What it does |
|---|---|
| `vm_acquire` | Leases a VM (`os`, `distro`, `image` or a named `vm`), with `wait` to queue for one. |
| `vm_start` | Restores clean (a persistent VM only when asked), applies the run's `network` and `reserveCpu`, starts it, copies `build` to `C:\build`; `interactive` logs an account on. |
| `vm_run` | Runs a command (cmd, powershell, bash, sh) as admin or user; returns its exit code and output. |
| `vm_read_out` | Reads files from the guest's `C:\out`. |
| `vm_sync` / `vm_reset` | In a work session: copy only changed files in / a clean VM again. |
| `vm_checkpoint` / `vm_restore` | Checkpoints within your lease. |
| `vm_stop` / `vm_release` | Restore and verify clean (a persistent VM: shut down, keeping its state); release also ends the lease. |
| `vm_renew`, `vm_status`, `vm_wait` | Extend the lease; the pool and your leases; a slow tool's result. |
| `pool_plan` | Plans a create, resize, remove, refresh or pool checkpoint; changes nothing. |
| `pool_create` / `pool_resize` / `pool_remove` / `pool_refresh` / `pool_checkpoint` | Applies a plan, once. |
| `pool_status` | The pool, the image and any job in progress. |

Every argument, sessions with several VMs, slow operations, checkpoints, persistent VMs and sharing the pool between
projects: [docs/tools.md](docs/tools.md).

## Network modes

Setup's `-MaxNetwork` is the highest any pool may have; the plan sets the pool's; each run asks for one at or below it.

| Mode | The VM reaches |
|---|---|
| `none` (default) | nothing: the adapter is disconnected |
| `host` | only this PC, on the ports its firewall allows (setup's switch `hvmcp-host`; setup changes no firewall rule) |
| `internet` | the internet, not your LAN (Windows' Default Switch) |
| `internet-lan` | the internet and your LAN |

The clean checkpoint is always offline, and every stop disconnects the VM. Details: [docs/network.md](docs/network.md).

## Uninstall

**Settings > Apps > Installed apps > "Hyper-V MCP helper and test VMs" > Uninstall**, or in an admin terminal:
```
cmd /c call "C:\Program Files\hyperv-mcp\uninstall.cmd"
```
It checks what is installed, shows what goes, and asks once: type `REMOVE` to remove everything (the pool too) or
`KEEP` to keep the pool and remove only the helper. `-RemovePool`, `-KeepPool` or `-WhatIf` choose up front. It
deletes only storage it verifies as setup's own, never through a link, and an interrupted run finishes when run again.
`C:\ProgramData\hyperv-mcp\inventory.txt` lists what is installed, with the command to remove each item by hand.

An install from before storage receipts (only the unreleased builds of 13 Nov) is refused: remove it by hand, in an
admin PowerShell, following its `inventory.txt` if there is one: the VMs (`Stop-VM`, `Remove-VM`), the service
(`sc.exe delete HyperVMcp`), the group (`Remove-LocalGroup 'Hyper-V MCP Users'`), `HKLM\SOFTWARE\hyperv-mcp`, the
install and state folders, and the disk folder you gave setup. The order, resuming, and the last phase:
[docs/uninstall.md](docs/uninstall.md).

## More

- [Setup in full](docs/setup.md): every option, storage and how setup trusts it, direct mode, the installed files.
- [Upgrading](docs/upgrading.md): what each release changed.
- [Building the pool](docs/pool.md): approvals, the build, guest setup scripts, Windows licences, images, ready-made disks.
- [The tools](docs/tools.md): every argument, several VMs per session, slow operations, refreshing, pool checkpoints,
  lease checkpoints, persistent VMs, multiple projects and build folders.
- [Network modes](docs/network.md), [Linux guests](docs/linux.md).
- [Configuration and limits](docs/configuration.md): the env settings, timings, versions, limits.
- [Security model](docs/security.md), [Uninstall in full](docs/uninstall.md), [Tests](docs/tests.md).
- Design notes: [Linux guests (MC-1500)](docs/linux-guests.md).
