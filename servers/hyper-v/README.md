# hyper-v

An MCP server that gives agents **disposable Hyper-V test VMs** from a pool. An agent leases a VM, starts it from its
clean checkpoint with a build copied in, runs commands and gets their output, reads files back from one folder, and
stops it, which restores it. Several agents can each hold a VM at the same time. Optionally, a run can have its own
reserved CPU, for timed runs. For a work session, an agent can instead keep its VM running: `vm_sync` copies only the
files that changed into it, `vm_reset` gives a clean VM again on request, and `vm_renew` extends the lease within the
policy. Release still restores it. The pool can also hold **Linux** VMs (from a qcow2 cloud image you choose; Debian and
Ubuntu so far) behind the same tools: see "Linux guests". Commands run in session 0 by default. For programs that need a real logged-on desktop
(their own desktops or windows), a start can log a guest account on, and runs can then go into that session.

It's the catalogue's alternative to [`windows-sandbox`](../windows-sandbox/), for any project. Windows Sandbox runs
one guest at a time on the whole machine, whereas this pool runs as many as you give it. It runs over stdio
(`node server.js`), with Combwork or any other MCP client.

It uses only Node built-ins: no dependencies, no `npm install`. Its version is in [meta.json](meta.json), which it
reports to MCP clients. MIT licence ([LICENSE](../../LICENSE)).

## How it fits together

```
agent ──stdio──> server.js (runs as you; no Hyper-V rights)
                   │  build folders from your MCP roots, by real path; streams the build
                   └── named pipe \\.\pipe\hyperv-mcp (only the "Hyper-V MCP Users" group, Administrators, SYSTEM)
                        └──> service HyperVMcp, account NT SERVICE\HyperVMcp (the only one in Hyper-V Administrators)
                               HvMcpHost.exe: answers the Service Control Manager, owns the pipe, supervises the helper
                               node helper.js: every rule about VMs, the pool, approvals; journals every pool change
                                 └──> powershell.exe hv.ps1: one fixed script; arguments as JSON on stdin
```

**The helper is the security boundary.** Anything running as you can open the pipe without going through `server.js`,
so the helper checks every rule itself, against a policy that only an administrator can write. Your account isn't in
Hyper-V Administrators, so agents running as you can't drive Hyper-V directly.

## Requirements

- Windows 11 **Pro, Enterprise or Education**, with **Hyper-V** turned on (*Turn Windows features on or off* →
  **Hyper-V**, then restart) and virtualisation on in the firmware.
- **Node 18+**, installed for all users (under `Program Files`): the service runs it, so it must be a copy only
  administrators can change. Setup checks this.
- A **Windows x64 ISO** of your choice for the pool's VMs, for example Microsoft's Windows 11 Enterprise evaluation,
  or your own copy with its product key (see "The image"). You download it; the helper never does.
- Disk space: about 40 GB per VM, plus the ISO (7 GB).
- For Linux guests only: Windows' in-box **OpenSSH Client** (Settings, System, Optional features; present by default on
  Windows 11). Setup checks it and says if it's missing; it never adds it.

## Safety at a glance

| The server (its helper) can | It can't |
|---|---|
| Act on VMs it created: names start with the pool prefix (`hvmcp-`) **and** the VM id is in its journal **and** the VM is in its own folder. All three are checked, twice: in the helper and again in `hv.ps1`. | Touch any other VM, checkpoint, disk or switch: start, stop, change, delete or even name it. A VM renamed into the prefix still doesn't match an id. |
| Create VMs and disks, **only** from a plan the user approved in an elevated prompt, and **within the policy** setup wrote (max VMs, cores per VM, total memory, disk per VM, disk folders, the highest network mode). Each plan states the pool's cores, memory, disk and network mode for the user to confirm. | Exceed the policy, whatever a plan or an approval says. Create a switch, an external switch or a NAT, or change any host setting: Hyper-V's settings, other switches, the firewall, Defender, features or services. Setup (run by you, elevated) makes the one host-mode switch and its address. |
| Write only to its state folder (`%ProgramData%\hyperv-mcp`: the journal, plans, per-run staging under `runs\`, guest credentials) and the disk folders named at setup. | Write anywhere else on the host. Files read back from a guest are returned as data, never written to the host. |
| Copy a build into a VM: the files of a folder that resolves, by real path, under your MCP roots or a build folder an admin named at setup, **copied** to `C:\build`. | Share or map any host folder into a guest: the guest never sees a live host path, so it can't change your files. Copy a build from outside your roots and the admin's build folders, or from your profile itself, its dot-folders (`~/.ssh`, `~/.claude`, …), `AppData` or its top folders, or anything under `AppData\Roaming`. Follow a link or junction in the build (they're skipped and named). |
| Connect one VM for one run in the network mode `vm_start` asks for, at or below the mode you approved for the pool (see "Network modes"): **none** (the default), **host**, **internet** or **internet-lan**. | Use a mode above the pool's or the policy's. Connect a run any other way. Off is the default: the adapter is disconnected, and the restore at stop disconnects it again and removes its rules. A new VM also goes online once at build, through Windows' Default Switch, to activate Windows, when the plan you approved says so (see "Windows licences"). |
| Reserve CPU for one run (`reserveCpu`, a percentage of the VM's cores), up to the policy's cap; reset at stop. | Reserve beyond the cap, or change a VM's CPU outside a run. |
| Restore the clean checkpoint **by id** before every start, unconditionally, and at every stop and release, then check that the VM is Off, at that checkpoint, disconnected, with no reserve. Keep a VM unrestored for inspection **only when asked**, until its lease ends. | Start a VM from anything but the clean checkpoint, or let one lease's changes reach the next. A VM that can't be confirmed clean is **quarantined**: never leased until a restore confirms it. |
| Keep a leased VM running for a **work session**: several runs in one guest, with `vm_sync` copying changed files into its `C:\build` (no restore between them), and the lease renewed up to the policy's `maxLeaseMinutes` at a time and `maxSessionMinutes` in all. | Carry anything past the lease: release, the deadline and the session's connection closing all restore and verify it as above. Write anywhere in the guest but `C:\build` and its own staging folder when syncing, or follow a link or junction there. |
| Run commands in a leased Linux guest over SSH on a Hyper-V socket (no network), through Windows' own `ssh.exe` with fixed arguments, the guest's forced command and a per-VM key only the helper holds (see "Linux guests"). | Give an agent a key, an SSH endpoint or a shell in the guest other than the run it asked for. Run anything on the host but `powershell.exe` with its fixed script, `node` for itself, and, for Linux guests, `ssh.exe` from System32 and setup's own `HvMcpVsock.exe`, each with fixed arguments. |
| Run commands in a leased guest over PowerShell Direct, as its admin or its standard user, with passwords only the helper holds. On request, log one of those accounts on in the guest (autologon, then a guest restart) and run commands in its desktop session through a watcher started at logon (`hvuser` as a standard user, or `hvadmin` elevated); a run there that doesn't finish cleanly restores the VM. | Run any program on the host except `powershell.exe` with its own fixed script (and `node` for itself). An agent's text never reaches a host command line or script: it's passed as JSON on stdin and arrives in the guest as data. Leave a logon behind: autologon and its password live only inside the guest, and the next restore of the clean checkpoint removes them. |
| Build from the image file **you** name for these VMs (any x64 Windows ISO, or a Linux qcow2 cloud image): copy it into its own folder while hashing it, read its edition and build, and show its path and SHA-256 in the plan you approve (see "The image"). | Download an image, or choose one for you. Build from bytes other than the ones you approved: the copy is hashed again just before it is used. Install a converter or any other tool on the host. |

**Don't put real sign-ins, tokens or real CLIs in a VM.** It's for testing a build on a clean Windows. Use fake CLIs
and test accounts.

### What the confinement guarantees

- **Guaranteed**, whatever an agent or any program running as you sends to the pipe:
  - no VM, disk, checkpoint or switch outside the pool is touched;
  - nothing is written outside the helper's state folder and the setup's disk folders;
  - nothing exceeds the policy;
  - every lease starts from the clean checkpoint, and every start restores it (a work session's runs between syncs
    share one guest, by design: `vm_reset` is the clean start in between);
  - no host folder is shared into a guest.
- **Not guaranteed:**
  - Against a program running as you, that a build came from your roots: such a program can send any file it can read.
    It can only send files it could already read itself.
  - That the **person** approved a pool change, if your account is an administrator and a program running as you uses
    a UAC bypass. Microsoft doesn't treat UAC as a security boundary between a user and the same user's elevated
    processes. Within the policy, then, the approval is only as strong as UAC. Everything else above still holds.
  - Anything at all against a determined agent, in **direct mode** (below).

## Setup

**Upgrading from an earlier release:** run setup again (step 2, the same line) in an admin terminal before
using the new server: the helper's protocol and features changed, and an older helper refuses each newer feature with
"run setup again". The pool's VMs and images are kept; pass the same options you used before (`-DiskFolder`,
`-BuildRoot` and the rest), since a rerun replaces them.

**From 2.0.0 to 2.1.0 (Linux guests):**
- Without the rerun, 2.1.0 still serves Windows guests, and refuses Linux ones with "run setup again".
- The rerun copies the new helper, compiles `HvMcpVsock.exe` (the Hyper-V socket bridge) and registers vsock port 22's
  service id.
- For Linux guests, Windows' OpenSSH Client must be present: Settings, System, Optional features. Setup says if it's
  missing, and adds nothing.
- Then plan Linux VMs: `pool_plan` with `action: "resize"`, the new `vms` count and the image (from 4.0.0,
  `image: { file: "<path to the qcow2>" }`). Approve it, then call `pool_resize`.
- New in the server, with no rerun needed: slow tools reply within about 45 s, saying "still in progress … call
  vm_wait now", and the new `vm_wait` gives their result (see "Slow operations", MC-1553).

**From 2.1.0 to 3.0.0 (network modes, timings, the live-proof fixes): the rerun is required.**
- Rerun setup before using the 3.0.0 server. A 2.1.0 helper doesn't understand 3.0.0's network modes: it takes every
  `vm_start` as asking for the network, even with `network` left out. So the 3.0.0 server refuses every `vm_start`,
  `vm_reset` and `pool_plan` network mode on a helper without the `network-modes` feature, with "run setup again",
  rather than risk a wrong network (MC-1570). Most fixes are in the helper too (MC-1555 to MC-1568).
- The rerun keeps the policy's network as it was (an older `-AllowNetwork $true` becomes `-MaxNetwork Host`); pass
  `-MaxNetwork Internet` or `InternetLan` to allow more, then resize the pool to that mode (see "Network modes").
- New: the timings in the server's env (see "Timings"), and an installed uninstaller with an Installed apps entry,
  which removes everything without agents or the repo (see "Uninstall"; the rerun installs it).

**From 3.0.0 to 4.0.0 (your images, MC-1572): rerun setup to name your own image files.**
- The helper no longer downloads images, pins them or refuses ones it doesn't know: you name any local file for the
  VMs, and the plan you approve names it with its SHA-256 (see "The image"). `image: { download }`, Linux's
  `{ distro }`/`{ pin }` and setup's `-AllowUnpinnedIso` are gone (setup accepts and ignores that switch).
- Without the rerun, the 4.0.0 server refuses `image: { iso }` and `{ file }` on a 3.0.0 helper with "run setup
  again" (it would refuse files it doesn't know). Images and VMs you already have are kept and stay usable.
- `vm_acquire`'s `distro` takes any `/etc/os-release` ID (`debian`, `ubuntu`, `fedora`...).

**From 4.0.0 to 4.1.0 (any terminal, MC-1575): rerun setup to get the new lines.**
- Setup, approvals and the uninstaller each take one line that works the same in any admin terminal (cmd, Windows
  Terminal, Windows PowerShell or PowerShell 7), and they run under PowerShell 7 on a Windows without Windows PowerShell.
- Until the rerun, the 4.0.0 helper still gives the old `powershell -File ... approve.ps1` line, which still works.
- New builds add no guest tweaks of their own (MC-1577): no Defender exclusions and no `DisableForceUnload` policy. Put
  any you want in your own guest setup script, named in the plan (see "Guest setup script"). VMs you already have keep
  what their clean checkpoint holds.

1. Turn on Hyper-V (see Requirements), and check `Get-Service vmms` says Running.
2. In an **admin terminal** (cmd, Windows Terminal, Windows PowerShell or PowerShell 7), run setup once (one line,
   the same in each). Name a folder for the VMs' disks on a drive with room:
   ```
   cmd /c call "C:\path\to\combwork-mcp\servers\hyper-v\setup\install.cmd" -DiskFolder D:\hyperv-mcp
   ```
   `install.cmd` runs setup under Windows PowerShell where it is installed, otherwise PowerShell 7. The service then
   runs its Hyper-V script (`hv.ps1`) under the same PowerShell. **To use PowerShell 7 where both are installed**, run
   setup with PowerShell 7 itself instead (one line, again the same in any admin terminal):
   ```
   cmd /c call "C:\Program Files\PowerShell\7\pwsh.exe" -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\combwork-mcp\servers\hyper-v\setup\install.ps1" -DiskFolder D:\hyperv-mcp
   ```
   Setup records the PowerShell it runs in only when that is one Windows has registered (a normal PowerShell 7 install
   is). Otherwise it records the one `install.cmd` would choose. Its "Service host compiled" step names the one it
   recorded. To switch back, run setup again with the `install.cmd` line.
   It reports each step and can be run again (to update the helper or change the policy). It installs:
   - the helper's code, `approve.cmd` and `approve.ps1`, and the service host (compiled there by the in-box .NET
     Framework compiler) in `%ProgramFiles%\hyperv-mcp`;
   - the service `HyperVMcp` on its virtual account `NT SERVICE\HyperVMcp`, which it adds to Hyper-V Administrators.
     The service is restarted after a failure (3 times a day, then left stopped);
   - the local group **Hyper-V MCP Users**, with you in it (`-User` to name someone else). Its members may open the
     helper's pipe. Your own account is also given the pipe directly, so you needn't sign in again. Other users you
     add to the group later must sign in again before their membership counts;
   - `%ProgramData%\hyperv-mcp` (the helper's state) and the disk folder, both readable only by SYSTEM,
     Administrators and the service. `policy.json` and `approvals\` in there are writable only by Administrators and
     SYSTEM. How setup makes them trustworthy is under "Storage" below;
   - `policy.json`, the pool's hard limits. By default they're derived from the host: up to a quarter of its logical
     CPUs per VM (at most 8), half its memory in all, up to 4 VMs, 128 GB disks, network mode up to none (a new
     install; a rerun keeps the current value). Override any of them: `-MaxVms`,
     `-MaxCoresPerVm`, `-MaxMemoryGB`, `-MaxDiskGBPerVm`, `-MaxNetwork None|Host|Internet|InternetLan` (with
     `-HostSubnet`; see "Network modes"), `-MaxReservePercent`, `-MaxLeaseMinutes`, `-MaxSessionMinutes`
     (a work session's cap for `vm_renew`: 5-1440 and at least `-MaxLeaseMinutes`; left out, 480 or
     `-MaxLeaseMinutes` if that is more), `-MaxBuildMB`. (`-AllowUnpinnedIso` is no
     longer needed, from 4.0.0: setup accepts it and ignores it.) `-BuildRoot` names folders builds may also
     come from (see "Build folders set by an admin"). `-ProjectsFile` names the projects that share the pool fairly (see
     "Sharing the pool between projects"). `-ProductKeyFile` names a file holding a Windows product key for VMs built
     from your own (non-evaluation) image (see "Windows licences"); a rerun without it keeps the key, and
     `-ProductKeyFile none` removes it. `-LinuxTransport` is `HvSocket`, the default and only value today (Linux guests: see
     "Linux guests"); for it, setup also compiles `HvMcpVsock.exe` and registers vsock port 22's service id under
     `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices` (uninstall removes it).

   It never enables a Windows feature or restarts the PC. If Hyper-V is off, it says how to turn it on and stops.
3. Add the server to your client, with `HYPERV_MCP_ENABLED=1`:
   ```json
   {
     "mcpServers": {
       "hyper-v": {
         "command": "node",
         "args": ["C:\\path\\to\\combwork-mcp\\servers\\hyper-v\\server.js"],
         "env": { "HYPERV_MCP_ENABLED": "1" }
       }
     }
   }
   ```
   For a client that sends no MCP roots (Codex and the Copilot CLI today), add `"HYPERV_MCP_ROOTS_FROM_CWD": "1"`
   or `HYPERV_MCP_ALLOWED_ROOTS` (see "Multiple projects"), or have an admin name its build folders at setup. The [top-level README](../../README.md#install) shows the
   entry for each client's format.
4. Build the pool: ask an agent to plan one (next section).

### Storage: where it may be, and how setup trusts it

The helper trusts what is in its state folder (the journal, plans, approvals, guest credentials) and its disk folders
(the verified images). So setup must know those bytes were written only by itself and the helper:

- **Supported locations.**
  - The state folder is `%ProgramData%\hyperv-mcp`, and the code goes in `%ProgramFiles%\hyperv-mcp`. Both are found
    through Windows' known-folder API, not environment variables.
  - A disk folder must be a **top-level folder on a local fixed drive**, such as `D:\hyperv-mcp`. Anything deeper is
    refused.
- **Parents are checked, never changed.** Before anything else, setup checks every folder above each of these, from
  the drive root down:
  - no link or junction;
  - owned by Administrators, SYSTEM or TrustedInstaller;
  - nobody else may delete or rename inside it, change its permissions, or take it over.

  An insecure parent stops setup with nothing changed: fix its permissions yourself, or choose another location.
  While setup runs it holds every parent and storage folder open in a way that stops anyone renaming, deleting or
  replacing them.
- **Created secure, with a receipt.** A missing storage folder is created with its final permissions in the same call
  that creates it, so nobody else can ever have written there. Setup then records the folder's identity (its volume
  and file id) in `HKLM\SOFTWARE\hyperv-mcp\Storage`, a key only Administrators and SYSTEM can write.
- **Existing storage is trusted only by its receipt.** A folder that already exists is used only if:
  - its receipt matches its identity;
  - it and everything in it still have only the expected owners and permissions.

  Setup never repairs or re-permissions an existing folder. A folder without a receipt is refused untouched: one made
  by someone else, by an older setup, or whose creation was interrupted. So is one whose identity differs (deleted and
  made again). To use that location, remove the folder (and any pool in it, first), then run setup again.
- **Files setup writes** (`policy.json`) are created with their final permissions under a temporary name, then renamed
  into place.
- `uninstall.ps1 -KeepPool` keeps the folders and their receipts. `-RemovePool` removes both.
- **Don't open these folders in Explorer.** Its "You don't currently have permission to access this folder" prompt,
  if you click Continue, grants your account access to the folder and everything in it. Then agents running as you
  could write there, and setup and uninstall will refuse to trust the folder. To look inside, use an admin
  PowerShell (`Get-ChildItem D:\hyperv-mcp -Recurse`).

**In Combwork:** pack it (`node scripts\pack.mjs hyper-v` at the repo root) and add `dist\hyper-v.zip` with **Add MCP
Server from File** in the MCP view. Its definition goes in as `combwork-mcp.example.json`
([this one](combwork-mcp.example.json)). Run setup from the unpacked folder's `setup\install.cmd`, then turn the server
on, and only in a dedicated testing project (see "Who gets it").

### Direct mode (no service): weaker, read this first

With `-Mode Direct`, setup installs no service. It adds **your own account** to Hyper-V Administrators, and the server
runs the helper in-process (`HYPERV_MCP_MODE=direct` in the client's `env`). The tools are the same, but **any program
you run, every agent included, can then skip this server and drive Hyper-V directly**, and Hyper-V Administrators is
close to full control of the machine. The server's rules then guard only against an agent's mistakes, not against a
determined agent. Use the default service mode unless you accept that.

## Building the pool

Pools are planned with you, not built by a fixed script: hardware and needs differ. Every change goes **plan → your
approval → change**:

1. **Plan.** Ask an agent for a pool, for example "plan a hyper-v pool of 2 VMs from
   D:\Downloads\Win11_Eval.iso". It calls `pool_plan`, which reads the host (CPUs, memory, free disk, Hyper-V) and the
   policy. It proposes the exact plan: VM names, cores, static memory, disk size and folder, the image, the VMs it
   keeps, and the pool's network mode (none unless you choose another; the agent describes the options, see "Network
   modes"). The plan changes nothing. The first plan also checks the image, which takes a few minutes (see "The
   image"); the agent then plans again.
2. **Approve.** The plan's reply holds one line for **you** to run in an **admin terminal** (cmd or PowerShell, the
   same line in each):
   ```
   cmd /c call "C:\Program Files\hyperv-mcp\approve.cmd" -Plan p-0123456789abcdef
   ```
   Check that the path is `C:\Program Files\hyperv-mcp\approve.cmd` before you run it.
   - It shows the plan from the helper's own record, never from the agent's text.
   - It asks for the first 6 characters of the plan's digest. That only confirms the plan on screen is the one you
     approve: it's not a password.
   - It writes a single-use approval that expires within 30 minutes and holds only for that exact plan.
3. **Change.** The agent calls `pool_create` (or `pool_resize`, `pool_remove`) with the plan id. The helper checks the
   approval and the policy again, then runs the change in the background (`pool_status` shows it). Creating a VM
   installs Windows unattended, with no network:
   - about 20–40 minutes each, one VM at a time, so the host's CPU isn't flooded;
   - then the guest set-up, a sanity check of the installed edition and build, Windows' activation when the plan says
     so (see "Windows licences");
   - then **the test accounts' profiles**, still offline: `hvadmin`, then `hvuser`, each logged on interactively once,
     exactly as an interactive start does, and left until Windows' first-logon work (AppX provisioning, OneDrive
     setup, the user setup screens, the per-user AppContainer profiles) is observed quiet: four minutes of samples in
     a row with no new AppX deployment event, an unchanged package inventory, unchanged counts of the account's
     AppContainer mappings (read from its own classes store, by its SID) and `AppData\Local\Packages` folders, and no
     busy first-logon worker, with the account still logged on. A sample that fails, can't read a count, or is busy
     starts the four minutes over; a lost logon is retried once; each account has 30 minutes for all of it (MC-1520),
     or the build fails. On a freshly installed guest, Windows logs hvadmin's first-ever logon off again within
     seconds, often before the helper's first check (MC-1521; what starts it is unknown). The check sees that from the
     boot's own session-manager logon and logoff events for the account, with the account gone and autologon off, and
     the retry starts at once (MC-1524). A first logon can also never begin at all (MC-1525's trial: no logon event,
     no session, for the whole attempt). So an attempt whose account has no logon event 3 minutes after its new boot
     was first seen (by the host's clock) ends and is retried at once (MC-1526). The 15 minutes are the ceiling for
     an attempt that has begun. Unreadable events and failed checks never count; a further restart starts the 3
     minutes over. The job's note then says the first logon was dropped by Windows, or didn't begin, and was retried;
     any other failed attempt, or either case with no successful retry, is reported in full. Each account's wave of
     about 39 AppContainer profiles can come after an earlier quiet (MC-1525: an account accepted at 61 mappings went
     to 100 in an interactive start's first 11 minutes), so quiet alone isn't enough. The wave is Windows' App
     Readiness service working through the account's per-user queue (one install task per app); when it's done,
     App Readiness logs event 211 "completed tasks for <SID>", with the queue at "tasks: 0" (MC-1528's evidence). So
     the build waits for that, for the account's SID, on the logon's boot, with no task added after it, then needs the
     4 minutes of observed quiet after it; a new completion, or a sample where App Readiness isn't done or can't be
     read, starts the quiet over. Unreadable or disabled App Readiness logs are never taken as done. If it doesn't
     finish within the account's 30 minutes, the build fails, and its reason gives App Readiness's state (tasks left,
     a "resume at" deferral). That deferral isn't charged to the 30 minutes (MC-1562): right after an account's first
     logon, Windows suspends part of its app setup for a fixed time (event 216, "will resume at", 16 minutes on 26200),
     which took most of the budget, so the quiet after it didn't fit in a slower build. Each suspension's length, from
     its own 216 on the guest's clock, moves the account's deadline on, by one budget at most; the job's note says how
     long it was, and a late failure says what was credited. The job's note gives each account's settled counts. This replaces MC-1527's 13-minute
     floor: it's Windows' own marker, not a timing, though it's so far confirmed on one Windows build only. A build's
     logon attempt waits up to 15 minutes (a start's waits 10). One still waiting at 10 minutes
     gets a read-only snapshot of the guest, and a failed one a snapshot before its undo (MC-1520). The snapshot keeps
     allowlisted fields only: event ids and seconds after boot from the session-manager, Security, Winlogon, User
     Profile, Shell-Core, AppReadiness and CloudExperienceHost logs (a missing or disabled log is "unavailable"), the
     autologon state, the watcher, and the account's process names. It never holds a message, a command line or a
     password. It's kept with the attempt in the build's record and summed up in one line in the job's note, which
     `pool_status` shows. After each logon, a verified undo turns autologon off, deletes its password, turns UAC back on, puts
     back Windows' own `Userinit` and recreates `C:\hvmcp` empty with inherited permissions only, so the next logon
     starts clean and the checkpoint keeps none of it. The profiles stay, so an interactive start doesn't replay
     first-logon work (it took 2–5 minutes, and sometimes failed);
   - then **your guest setup script**, if the plan names one (below);
   - and the clean checkpoint, taken with the VM off and its adapter disconnected.

### Guest setup script

A plain build adds nothing to the guest beyond what the helper itself needs: its two accounts and its folders
(`C:\build`, `C:\out`, `C:\hvmcp`; on Linux `/build`, `/out`, `/hvmcp`). Anything else you want in every VM (Defender
exclusions, a registry policy, tools, settings) goes in your own script, which the plan names (MC-1577):

```
pool_plan({ action: "create", vms: 2, image: { iso: "D:\\Downloads\\Win11_Eval.iso" }, guestScript: "D:\\vm-setup\\guest.ps1" })
```

- **Windows guests** take a `.ps1` (run by Windows PowerShell), `.cmd` or `.bat`. **Linux guests** take a `.sh`
  (run by bash). The file may be UTF-8 (with or without its BOM) or UTF-16 with its BOM (as Windows PowerShell's
  `Out-File` writes it); the helper decodes it, and a `.ps1` reaches the guest marked UTF-8, so non-ASCII text survives.
- The helper reads the file when you plan, keeps its own copy, and the plan shows its path, size and SHA-256. You
  approve those exact bytes: a later change to your file doesn't change what runs (plan again to use it).
- It runs once in each VM the plan builds, as the guest's admin (root on Linux), offline, in `C:\build` (`/build`),
  after the build's own steps and before the clean checkpoint. So what it does is in every lease's clean start.
- It has `HYPERV_MCP_GUEST_SCRIPT_MINUTES` (default 30) to finish. A non-zero exit, or no exit in time, fails that
  VM's build, and the job's note gives the end of its output. Its own command and output files are removed before the
  checkpoint.
- At most 1 MB: the whole script goes to the guest in one call. Have it fetch nothing: the guest is offline.
- A resize names it again for the VMs it adds; without one, they're built plain. `pool_refresh` doesn't rerun it:
  what it did is already in the clean checkpoint it refreshes from.

For example, the work folders out of Defender's scanning, and the registry of a user who logs off kept loaded for a
session-0 run that outlives the session that started it (the build's own tweaks before MC-1577):

```
Add-MpPreference -ExclusionPath 'C:\build', 'C:\out', 'C:\hvmcp'
New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Name DisableForceUnload -Value 1 -Type DWord
```

**Rebuilding.** An evaluation VM lasts about 90 days from its activation at build; `vm_status` and `pool_status` show
the days left and warn 14 days before. Plan a `remove`, then a new `create`, each approved the same way. **Teardown** is
the same `remove`, and only VMs with no lease can be removed.

### Windows licences

Each VM records its Windows licence when it is built, and `vm_status`, `pool_status` and setup show it.

- **An evaluation edition** (Windows 11 Enterprise evaluation, or any edition whose ID ends in `Eval`). Unactivated, it lasts only about a day: after that, Windows logs any
  interactive user off within seconds and shuts the guest down every hour. So each evaluation VM is **activated online
  once, as it is built**:
  - its plan says so, and your approval covers it: "each new VM goes online once, through Windows' Default Switch, to
    activate Windows";
  - only for that step: the adapter is connected to the Default Switch (Windows' own NAT switch, so nothing new on the
    host's network), Windows is activated, and the adapter is disconnected and checked before the clean checkpoint;
  - the build fails unless Windows comes back licensed with at least 85 days left; the end date it reports is recorded,
    and never recomputed or extended (no re-arm, no clock changes);
  - if the step fails, the VM is turned off and disconnected, then removed; if that fails too, `pool_status` warns that
    it may still be online, and the helper retries every few minutes and at its next start;
  - a run uses the Default Switch only in an internet mode, and only when the plan you approved for the pool allows it
    (see "Network modes").
  A host without the Default Switch can't build evaluation VMs (setup says whether it has one). Within an hour of its
  end, a VM is no longer leased, and leases and renewals never run past it. VMs built before licences were recorded
  show "licence unknown": rebuild them to record it.
- **Your own copy**: any other x64 edition (Pro, Enterprise, Education, Home, Server...), for a project that has a
  licence. Its product key comes from setup's `-ProductKeyFile` (a file, so it's never on a command line): it's stored in the
  helper's secrets folder, readable only by SYSTEM, Administrators and the helper, and written only into that build's
  answer file, which is deleted after the build. It is never in a reply, a plan, the journal or the log. Such a VM stays
  offline unless its plan asks for the activation step (`pool_plan({ ..., activate: true })`); either way its licence
  is shown, and it has no expiry to track.
- **Both in one pool:** the licence belongs to the image, and each VM records its image (see "A pool from more than one
  image"), so evaluation and own-copy VMs can share a pool, and each project's `images` list decides which it may use.

### The image

**You choose the image, and the plan you approve is the trust decision** (MC-1572). The helper never downloads an image,
keeps no list of "known" images and has no override to set: it builds from the file you name, and only from the bytes
you approved.

1. **You name the file** when you ask for VMs, for example "plan 2 VMs from D:\ISOs\Win11_Eval.iso". The agent calls
   `pool_plan({ ..., image: { iso: "D:\\ISOs\\Win11_Eval.iso" } })`, or `image: { file: "<path to a .qcow2>" }` for a
   Linux cloud image (see "Linux guests"). Any local file: download it yourself, from wherever you like. For example,
   Microsoft's [Evaluation Center](https://www.microsoft.com/evalcenter/evaluate-windows-11-enterprise) offers the
   Windows 11 Enterprise evaluation (an `.iso`; whichever build Microsoft serves today).
2. **The helper copies it into its own folder while hashing it** (SHA-256), then reads the copy without mounting it (a
   small bounded UDF reader): `sources\install.wim`'s editions and build. It also reads whether `setup.exe` and
   `sources\setup.exe` carry valid Authenticode signatures from Microsoft Corporation (chaining to Microsoft Root
   Certificate Authority 2010 or 2011): **information for you, never a refusal**. `pool_status` shows the check's
   progress, then "ready" (or why the file can't be used); the agent plans again.
3. **The plan names it:** its edition and build, the full SHA-256, the path it came from, and the signature line. The
   approve line binds that hash, so approving is your decision to build from exactly those bytes.
4. **The build uses only the helper's copy,** and hashes it again just before attaching it (hv.ps1 `create-vm`; a
   Linux image's base VHDX before each copy): a file changed after you approved is refused, with nothing created. An
   agent can't change an approved plan's image: another image is another plan, and another approval.

- **Reusing one:** a checked image is recorded with its hash. A later plan can name it by its SHA-256 (or its first 12+
  hex digits), or leave `image` out to use the newest one. Each project's `images` list in the policy (see "Sharing
  the pool between projects") still limits which images a project may use.
- **One edition per ISO** (MC-1513): an ISO holding several x64 editions needs `image: { iso, edition: "<edition ID>" }`
  on its first check (the reply lists them). The record keeps that edition and its index, the build installs exactly
  that one, and asking for another edition of the same ISO is refused.
- **Images checked before 4.0.0** stay usable by their hash; plans for them say "checked earlier".
- After the install, the guest's own report of its edition and build is compared with the image, as a sanity check.

**What the build can build: limits, not gates.**

- **x64 only:** an x64 Hyper-V host doesn't run ARM guests, so an ISO with no x64 image is refused, saying so.
- **Windows** needs `sources\install.wim` (an ISO with only `install.esd` isn't read) and an edition the unattended
  install can drive: a Generation 2 VM with Secure Boot and a vTPM, `autounattend.xml` (UEFI partitions, two local
  accounts, OOBE skipped) and PowerShell Direct for the guest steps. It has been run on Windows 11
  (Enterprise evaluation 25H2). Windows 10 and Windows Server 2019 or later use the same steps but haven't been tried:
  a step that can't work fails by name, and the build stops there.
- **Linux** needs a qcow2 cloud image of at most 4 GB with cloud-init, systemd, OpenSSH and the `hv_sock` module (see
  "Linux guests"). It has been run on Debian 13 and Ubuntu 26.04.

## Tools

| Tool | What it does |
|---|---|
| `vm_acquire({ minutes=60, keepOnFailure=false, wait=false, os='windows', distro?, image?, vm? })` | Leases one VM of that OS (`distro`, an `/etc/os-release` ID such as `debian` or `ubuntu`, for a Linux VM of that distro; and image, when given; or the VM named by `vm`, for trials, see "One VM by name") to this session (one VM per session) until `vm_release`, its deadline (at most the policy's `maxLeaseMinutes`), or this server exiting. Without `wait`, it refuses when none is free for this session's project, saying why (none free, the project's cap, a VM kept for another project), when the next lease ends, and where it would stand in line. With `wait: true` it waits in line about 20 s, and a repeat call within 2 minutes keeps its place (see "Sharing the pool between projects"). |
| `vm_start({ build?, network='none', reserveCpu=0, interactive=false })` | Restores the clean checkpoint (always), applies this run's network mode (`none`, `host`, `internet` or `internet-lan`, at or below the pool's; see "Network modes") and CPU reserve, and starts the VM. It waits for the guest, then copies `build` in to `C:\build` and leaves an empty `C:\out`. With `interactive: 'user'` (the standard user) or `'admin'`, it first logs that account on interactively: autologon, one guest restart, then it waits up to 10 minutes for the account's desktop session (often 2–4 minutes on a first logon; see "The interactive session"). Refused on a VM kept for inspection: release it, and acquire again. |
| `vm_renew({ minutes=60 })` | Sets the lease's deadline to now + `minutes` (1 to the policy's `maxLeaseMinutes`), never past the work session's end: `maxSessionMinutes` after `vm_acquire` (`vm_status` shows both). Refused once the deadline has passed, even a moment before the helper ends the lease. |
| `vm_sync({ build?, full=false, delete=true })` | Copies only the files that changed in `build` (default: the folder last started or synced) into the **running** guest's `C:\build`, without a restore: `C:\out`, installed software and anything else the runs left stay. The server hashes the folder (same roots checks as `vm_start`, every time; links skipped); the helper compares that with what it placed in `C:\build` and takes only the new or changed files, hashing them itself as they arrive. Files gone from the folder are removed unless `delete` is false. Only what the helper copied is tracked: if your runs changed `C:\build` themselves, use `full: true` (clears `C:\build`, copies everything) or `vm_reset`. After a sync fails, only those two are accepted. |
| `vm_reset({ build?, network?, reserveCpu?, interactive? })` | A clean VM now: exactly `vm_start` (restore first, verified), with this session's last start's `network`, `reserveCpu` and `interactive` and its last build unless given. |
| `vm_run({ command, shell='cmd'\|'powershell'\|'bash'\|'sh', as='admin'\|'user', timeoutSec=120, cwd='C:\build', session='service'\|'interactive' })` | Runs in the guest (on Linux: bash by default, in `/build`, as root or `hvuser`, killed with everything it started on a timeout; see "Linux guests"). stdout and stderr go to `C:\out\.run-<n>.*`, and the reply has the exit code and 16 KB of each. `as: 'user'` runs as the standard user, for whom `C:\build` is read-only. `session: 'service'` (the default) runs in session 0; on a timeout, everything the run started is killed inside: each run starts in its own Job object (MC-1547), so the kill ends every process in it, whenever it was created (taskkill /T's snapshot missed a child created as it ran). A run that can't be put in its job isn't started (the reply says why), and a job kill that can't be confirmed restores the VM instead, which ends everything the run started: a run is never chased process by process. (A run started without a job, by an older helper, is still killed by its PID with `taskkill /T /F`, only while that PID is still the run's process.) A run's program can't break away from the job; one that makes its own job gets a nested one, which ends with it. A run is started in one short PowerShell Direct call and its exit file then polled with short calls (see "Long runs"), so it may take as long as `timeoutSec` allows. `session: 'interactive'` runs in the desktop session `vm_start`'s `interactive` logged on, as that account (`as` must name it), through a watcher started in that session at logon (`hvadmin` elevated, `hvuser` a standard user). If it times out or doesn't finish cleanly, its output so far is returned and the VM is restored, which ends everything it started; `vm_start` or `vm_reset` goes on. |
| `vm_read_out({ paths?, glob?, maxBytes=256 KB, maxTotalBytes=1 MB, base64=false })` | Files from the guest's `C:\out`, read in the guest and capped while reading, returned as data. Paths are relative and checked before the call (no `..`, drives, UNC or device paths, streams or device names). `glob` is matched against a listing. Links are skipped. With neither, it lists. Text as text, PNG/JPEG as images. Read before `vm_stop`, which discards them. |
| `vm_stop({ keep=false })` | Turns the VM off and restores the clean checkpoint, then **verifies** it: Off, at the checkpoint (by id), adapter disconnected, reserve 0. It says "Reverted" only then. Otherwise **CLEANUP FAILED**, and the VM is quarantined. The lease stays. `keep` (or a failed run with `keepOnFailure`) leaves it as it is until release or the deadline. |
| `vm_checkpoint({ name })` | Takes a named checkpoint of your leased VM as it runs now: files, installed software and the registry (a production checkpoint, disk only: not running programs or a logon session). Yours only, removed when the lease ends. See "Checkpoints within a lease". |
| `vm_restore({ name })` | Restores one of your lease's checkpoints and starts the VM from it, with the lease's current network and CPU reserve. No one is logged on interactively afterwards, and C:\build is unconfirmed until a full `vm_sync`. |
| `pool_refresh({ planId })` | Carries out an approved refresh-clean plan: reruns the build's guest setup on each VM (profiles kept as built) and makes that its new clean checkpoint, keeping its pool checkpoints and evaluation days. See "Refreshing a VM's clean checkpoint in place". |
| `pool_checkpoint({ planId })` | Carries out an approved pool-checkpoint plan: publishes (or replaces, or removes) a named checkpoint of each VM a lease prepared. See "Pool checkpoints". |
| `vm_release()` | Restores the VM (as `vm_stop`) and ends the lease. |
| `vm_status()` | The pool, every lease, your VM, any pool job, the policy, and where builds may come from. Works with the server turned off. |
| `vm_wait()` | Waits for this session's slow operation and gives its result (MC-1553, see "Slow operations"). Each call waits up to 45 s, `HYPERV_MCP_REPLY_MS`. |
| `pool_plan({ action='create'\|'resize'\|'remove', vms?, cores?, memoryGB?, diskGB?, location?, network?, image?, activate? })` | Plans a pool change and changes nothing (see "Building the pool"). `network` is the pool's network mode, the highest a run may use (default `none` for a create, the current mode for a resize; a resize may change only this; see "Network modes"). `image` is the file the user names, to check (`{ iso, edition? }` for Windows, `{ file }` for a Linux qcow2; never downloaded), or a checked image's SHA-256: build from it, or resize only its group (see "A pool from more than one image"). An evaluation image's plan always activates Windows online once per new VM; `activate: true` asks the same for your own copy (see "Windows licences"). |
| `pool_create` / `pool_resize` / `pool_remove({ planId })` | Carries out an approved plan in the background. |
| `pool_status()` | The pool, the image, and any job or image check in progress. |

The server's MCP instructions tell agents to use the pool tools only when the user asks, and never to run the approve
line themselves.

### Slow operations

Clients don't wait for ever for a tool call: some give up after 60 s by default. A start with an interactive sign-in
can take up to 10 minutes, and a run lasts up to its `timeoutSec`. When the client gave up first, the operation went on
unseen and the agent was left idle with nothing to wake it (MC-1553). So:
- `vm_start`, `vm_reset`, `vm_restore`, `vm_checkpoint`, `vm_run` and `vm_sync` each reply within about 45 s
  (`HYPERV_MCP_REPLY_MS`), with their result or "still in progress … call vm_wait now". Don't end your turn while one
  is in progress.
- `vm_wait` waits up to the same time again, and gives the result once the operation settles: "<tool> finished (N s
  after it was called):" and its usual reply, an error included.
- While one is in progress, only `vm_wait`, `vm_status`, `pool_status`, `vm_renew` and `vm_release` run in that
  session. `vm_release` ends the operation, as it always has. Other tools say to call `vm_wait` first.
- A result nobody waited for comes with the session's next call.
- The operation, the lease and its deadline are unchanged, and the server exiting still ends the lease.

### Refreshing a VM's clean checkpoint in place

When a fix changes what the build's guest setup puts in the guest (its folders and their permissions),
`pool_plan({ action: 'refresh-clean', targets: [vm, ...] })` and, after the user's approve line, `pool_refresh({ planId })`
(MC-1531) apply it to existing VMs without a rebuild. It's a pool job, like a create. Each VM is handled on its own
while it's free, and isn't leased meanwhile.

- **What it does:** restores the VM's clean checkpoint, starts it offline, and reruns the build's guest steps (the
  guest setup: its folders and their permissions; not your guest setup script, whose work is already in the clean
  checkpoint). No account logs on: the test accounts' profiles are
  carried unchanged in the clean checkpoint (MC-1539). It reads the licence for the record, shuts the guest down, and takes a new checkpoint of the
  Off VM, verified. Only then does it make that the VM's clean checkpoint (a journalled commit) and remove the old one.
  Nothing goes online, Windows isn't re-activated, and the VM's evaluation end stays as recorded, whatever the guest
  says.
- **Pool checkpoints are kept:** they hang off the old clean checkpoint, and Hyper-V merges a removed checkpoint into
  its children, so they (and the new clean) survive with their contents.
- **If it fails** before the commit, the old clean checkpoint is restored and verified, the new checkpoint (if any) is
  found and removed, and the VM is left as it was. If that cleanup can't be confirmed, or the old checkpoint's removal
  fails after the commit, the VM stays quarantined and the helper retries until it can. A crash at any point is
  settled the same way at the next start. One refresh per VM at a time: another is refused until it's resolved.
- **Profiles are kept as built:** a refresh never logs the accounts on. An already-provisioned account's re-logon makes
  App Readiness log nothing at all (MC-1535's trial), so the build's first-logon wait could never complete; and an
  offline re-logon would add nothing. **Its limit:** fixes to the build's profile setup (the provisioning logons, the
  App Readiness wait) need a rebuild of the VM, not a refresh.

### Pool checkpoints: a prepared state any lease can start from

A pool checkpoint (MC-1532) is a named state one lease prepared (an OS set up, a suite of tools installed) that
later leases, in any project, start from with no reinstall. Publishing, replacing and removing one each need the
user's approve line, because they change what later leases start from.

- **Publishing:** prepare the state in a lease, then `pool_plan({ action: 'checkpoint', name, targets: [vm, ...] })`.
  Each listed VM must be leased now by your project, which owns the checkpoint. After approval,
  `pool_checkpoint({ planId })` handles each VM on its own (the reply lists each outcome). It undoes the guest's
  logon (no autologon, no saved password, UAC back on, `C:\hvmcp` emptied, all verified), disconnects its network
  (read back), shuts the guest down cleanly and checkpoints it Off, so the checkpoint holds no runtime state. Only
  then is it published. If a step fails nothing is published, and the reply says what had already changed. A VM that
  was shut down is started again from its current disk (no restore), so what you prepared is still there. Your lease
  goes on, now starting from the new checkpoint.
- **Using one:** `vm_acquire({ checkpoint: 'tools' })` takes a free VM that has it (in the same fair line, with the
  same project caps and image lists). Give `os` if the name is on VMs of more than one OS, and `vm` or `image` to
  narrow it. The lease then starts from it: `vm_start` and `vm_reset` restore it by default.
  `vm_start({ checkpoint: 'clean' })` gives clean, and another name the VM has gives that one. A name the VM doesn't
  have is refused, never replaced by clean. A lease keeps the exact checkpoint it started from. `vm_release` always
  returns the VM to clean.
- **Replacing and removing:** only the owning project, by plan (`replace: true`, or
  `action: 'checkpoint-remove'`). A replace is published from its own lease, and the old checkpoint is never offered
  again. Removal is the same: retired at once (never offered again); a lease already using it keeps it, and it's
  removed when that lease ends (Hyper-V merges it into its children, so a replacement built on it survives).
- **What a name promises:** each VM's checkpoint is its own (Hyper-V checkpoints belong to one VM). vm_status lists
  each with its owner, OS, image, when it was taken and from which lease. The same name on two VMs doesn't promise
  identical contents.
- **Limits:** at most the policy's `maxCheckpointsPerVm` (default 4) per VM, counting ones being retired or taken,
  and the free-space floor `minFreeGBForCheckpoint`. A checkpoint never changes the VM's evaluation end.
- **Crashes:** until it's published, a checkpoint being taken is journalled as its lease's, and removed with it
  (as in "Checkpoints within a lease"). Once published it survives restarts. A retired one is removed at the VM's next
  free restore, or the VM stays quarantined until it is.

### Checkpoints within a lease

`vm_checkpoint` and `vm_restore` (MC-1529) let one lease try something and roll back: set up tools, checkpoint,
test, restore, set up something else, and so on. No approval is needed, because nothing a later lease starts from
changes: the checkpoints are the lease's alone, and `vm_release` (or the deadline) always returns the VM to clean and
removes them. A lease's own `vm_start`, `vm_reset` and `vm_stop` keep them. Shared checkpoints that other leases and
projects start from (MC-1532) and refreshing the clean checkpoint in place (MC-1531) are separate.

- **What a checkpoint holds:** files, installed software and the registry. It's a Hyper-V *production* checkpoint,
  taken through VSS inside the guest, so it's consistent on disk and holds **no memory**: running programs and any
  logon session are not kept. If Windows can't make a production checkpoint, the take fails; it never falls back to
  a standard one.
- **Taking one:** only of a running VM, not one kept for inspection, and with C:\build confirmed (not straight after
  a copy or sync that didn't finish, nor after a restore: run a full `vm_sync` or `vm_reset` first). At most the
  policy's `maxLeaseCheckpoints` (default 3) per lease, and the VM folder's drive must keep `minFreeGBForCheckpoint`
  (default 20 GB) free. Names are 1 to 40 letters, digits, spaces, dots, dashes or underscores; `clean` is reserved.
- **Restoring one:** the checkpoint is checked to be this lease's on this VM, restored (Off, as production
  checkpoints restore), then started like `vm_start` with the lease's current network (off means disconnected,
  whatever the checkpoint's adapter said) and CPU reserve, the guest awaited, and all of it read back. Every restore (this one, clean, a pool checkpoint, a refresh's) waits for the VM to be Off (20 s, or nothing is restored), and then its new parent is read fresh, from separate calls each in its own PowerShell process, until it is the checkpoint (45 s, read time included): the restoring process's own Hyper-V objects keep the parent it started with, so it never judges its own restore. A wait that runs out is refused, whatever is read afterwards (MC-1536, MC-1537). No one is
  logged on interactively afterwards; `vm_start` or `vm_reset` with `interactive` restore clean, so they discard the
  restored state. C:\build is as the checkpoint left it but unconfirmed until a full `vm_sync`. Run numbers keep
  rising, so nothing from before can be taken for a later run's.
- **Removal:** when the lease ends, after clean is restored and verified, the lease's checkpoints are removed, a child
  before its parent, each confirmed gone. If one can't be removed, the VM is quarantined ("lease checkpoint cleanup
  pending") and isn't leased again until they're all gone, even though clean itself verified; the helper retries.
- **Crashes:** each take is journalled before it starts, under a unique Hyper-V name (`hvmcp-lease-<id>`), with the
  VM's checkpoint type before it, and again once confirmed; each removal likewise. A take Hyper-V itself reports
  as failed is settled at once (no standard checkpoint is taken instead). A take whose call died or timed out is
  never assumed not to have happened: found by its name it's kept as the lease's; not found it stays "unconfirmed"
  and holds its slot, and at the lease's end it's settled as never made only when every Hyper-V job on the host
  (WMI's Msvm_ConcreteJob) is in a documented terminal state (Completed, Terminated, Exception, Completed with
  warnings: not New, Suspended, Killed or any other), followed by a fresh look for it; until then the VM stays quarantined, and a take that finishes later is found
  and removed. Removal matches a confirmed checkpoint by
  its id (the same id under another name is left alone and keeps the VM quarantined) and an unconfirmed one by its
  name; the checkpoint type is put back from the journal before each is forgotten. Any other checkpoint on a pool VM
  (neither clean nor one of these, a same-named one with another id included) is left alone and listed in
  `vm_status`.
- **Limits:** a checkpoint never moves the lease's deadline or the VM's evaluation end, which come from the host's own
  records, not the guest's clock.

## Network modes

Each run has a network mode (MC-1556). There are two caps, as with CPUs, memory and disk:
- **setup's policy**, the highest mode any pool may have: `-MaxNetwork None|Host|Internet|InternetLan`. A new install
  is `None`; a rerun keeps the current value (an older install's `-AllowNetwork $true` becomes `Host`);
- **the pool's mode**, chosen in the plan you approve (`pool_plan`'s `network`). An agent describes the options when
  the pool is planned; every create and resize plan states it, and changing it is a resize you approve.

A run asks for a mode at or below the pool's (`vm_start` or `vm_reset`'s `network`, default `none`). A run already
going when the pool's mode is lowered keeps its mode until its next start, reset or restore, which is checked against
both caps then and refused above either. A Linux checkpoint restarts the VM: above a cap, it restarts with network
`none` and says so.

| Mode | The VM reaches | How |
|---|---|---|
| `none` (default) | nothing | the adapter is disconnected |
| `host` | only this PC, at its host-mode address, and only on the ports this PC's firewall allows | setup's internal switch `hvmcp-host` on `-HostSubnet` (default `10.137.42.0/24`: this PC is `.1`, VMs `.10` up). The helper gives the guest its address at start; the adapter's rules allow only this PC's address and block everything else, other VMs and IPv6 included |
| `internet` | the internet; not your LAN | Windows' Default Switch (its own NAT: nothing new on your network). The guest's traffic leaves this PC under its address. The adapter's rules block private address ranges (except the switch's gateway, which the guest needs for DHCP and DNS) and IPv6 |
| `internet-lan` | the internet and your LAN | the Default Switch; only IPv6 is blocked |

In every connected mode the order is fixed: the VM is off and disconnected, its rules are added and read back, and only
then is it connected and started. Then the guest's network is read back until it holds steady: the address on the
VM's own adapter (host: exactly its address, no gateway; internet: a DHCP address, a default route, DNS and one lookup
that answers). If any step fails, the VM is restored to clean and the start fails. Stop, release and recovery
disconnect the VM, then remove its rules. The clean checkpoint is always offline.

**Host mode and your firewall.** Setup makes the switch and this PC's address on it, and refuses a subnet that
overlaps anything else on this PC (a VPN, another network). A host-mode start checks the same again. Setup changes no
firewall rule: a VM can reach a service on this PC only if you let it. Setup prints the lines, for example for Ollama:
```
New-NetFirewallRule -DisplayName 'hyper-v MCP host mode: TCP 11434' -Direction Inbound -Protocol TCP -LocalPort 11434 -LocalAddress 10.137.42.1 -RemoteAddress 10.137.42.0/24 -Action Allow
```
and the service must listen beyond localhost (for Ollama, `OLLAMA_HOST` set to `10.137.42.1:11434` or `0.0.0.0:11434`).
Open a port only for a service you're happy for test code to call.

**Internet modes.** Test code in the VM can download things and talk to any internet service, as you could from this
PC. Use them for builds that need it, and still keep real sign-ins and tokens out of the VM.

Linux guests get their address from a fixed script of the helper's own, run as root through the same path as a run:
systemd-networkd, when it runs, is given a runtime network file for the VM's adapter; otherwise `ip` (host mode) or
the image's DHCP client (internet modes). Nothing of it survives a restore.

## Linux guests

A pool can hold **Debian 13** and **Ubuntu 26.04 LTS** VMs beside Windows ones, from 2.1.0 (MC-1500's design,
[docs/linux-guests.md](docs/linux-guests.md); built in MC-1501, proven in MC-1542), behind the same tools: an agent asks
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
  Windows (see "The image"), the helper copies it while hashing it, and the plan you approve names its path and
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
- **One VM per session**, as before: a project that needs Windows and Linux together uses two sessions.
- Needs a helper with the `linux` feature: the server asks no Linux VM of an older helper, and says to run setup again.

## Multiple projects (MCP roots)

One install serves every project, and every agent shares one pool through the helper's leases. A build folder must
be inside the calling agent's project. The rules are windows-sandbox's, with this server's names:
- **MCP roots:** at each `vm_start` with a build, the server asks the client for its current roots, and the build must
  resolve (realpath, so junctions count where they lead) under one of them.
- **No roots:** a client that sends none is refused, unless `HYPERV_MCP_ROOTS_FROM_CWD=1` (the folder the client
  started the server in, never a drive root) or `HYPERV_MCP_ALLOWED_ROOTS` (a `;`-separated list) is set.
  `HYPERV_MCP_ALLOWED_ROOTS` with roots **narrows** them.
- **A client that declares roots but doesn't answer** within 5 s is refused.
- **Whatever the roots say**, your profile itself, its dot-folders, `AppData` and its top folders, and anything under
  `AppData\Roaming` are refused.

### Build folders set by an admin

Some projects stage builds outside their own folder, e.g. in `%LOCALAPPDATA%\<project>`. Rather than change each
client's settings (Claude Code's `additionalDirectories`, Codex's `HYPERV_MCP_ALLOWED_ROOTS`), an admin can name such
folders at setup:

```
cmd /c call "C:\path\to\combwork-mcp\servers\hyper-v\setup\install.cmd" -DiskFolder D:\hyperv-mcp -BuildRoot "C:\Users\you\AppData\Local\app-builds"
```

- A build may then come from your MCP roots **or** from inside one of these folders, for every client, with no client
  settings. `HYPERV_MCP_ALLOWED_ROOTS` narrows only the client's roots, not these.
- They're kept in `policy.json`, which only Administrators and SYSTEM can write, so an agent can't add to them or widen
  them. The helper tells the server what they are (the server can't read `policy.json`).
- Each must resolve, by real path, to the very folder named: one that is (or passes through) a link or junction isn't
  used, so it can't be pointed somewhere else later. Your profile, its dot-folders, `AppData` and its top folders, and
  `AppData\Roaming` are refused here too; a folder **inside** `AppData\Local` is fine. One that doesn't exist yet is
  recorded and used once it exists. The build itself is checked by real path, and links in it are skipped, as usual.
- Give each folder as a literal path, not `%LOCALAPPDATA%`: in an admin prompt run as another account, that's the other
  account's folder. Setup refuses a drive root, a UNC path, `..`, and a link or junction on the way.
- To change them, run setup again with the new list. A rerun replaces it: leave `-BuildRoot` out to clear it.
- `vm_status` lists them, and says why any isn't used. A helper from before them reports none: run setup again.

### Sharing the pool between projects

With nothing set up, every project shares one pool, first come first served. An admin can name the projects that use it,
so none of them takes every VM, in a JSON file given to setup (one line, in an admin terminal):

```
cmd /c call "C:\path\to\combwork-mcp\servers\hyper-v\setup\install.cmd" -DiskFolder D:\hyperv-mcp -ProjectsFile D:\hyperv-projects.json
```

```json
[
  { "name": "app", "folders": ["D:\\src\\app", "D:\\src\\app.worktrees"], "maxVms": 2,
    "buildRoots": ["C:\\Users\\you\\AppData\\Local\\app-builds"] },
  { "name": "tools", "folders": ["D:\\src\\tools", "D:\\src\\tools.worktrees"], "maxVms": { "windows": 1, "linux": 1 } }
]
```

- **Which project a session is in:** the one whose `folders` hold its MCP roots (checkouts and worktrees). A session
  whose roots are in no project, in several, or that sends none (an older server) is in **other**, which has no cap.
  One project's folder may not be inside, around or the same as another's.
- **`maxVms`** caps how many VMs the project holds at once, **per OS**: a number means Windows, or give one per OS, such
  as `{ "windows": 2, "linux": 1 }`. A cap of 0 for an OS means the project may not use it. There are no reserved VMs:
  the caps and the line keep projects from starving each other (a `reserveVms` field is refused).
- **`images`** (optional) lists the images the project may use, by SHA-256. Left out, it may use every image of the OSes
  it may use.
- **`buildRoots`** are build folders for that project alone (beside its sessions' own roots). `-BuildRoot`'s folders stay
  everyone's. To move a folder from everyone to one project, update the agents' servers first: an older server sends no
  roots, so it only ever sees `-BuildRoot`'s.
- **The line:** `vm_acquire` with `wait: true` joins one first-come line for the whole pool and waits about 20 s per call
  (under a client's 60 s tool timeout). A VM that comes free (a release, a lease's deadline, a quarantine cleared, a pool
  job finished) goes to the first waiter it's allowed to: a waiter its project's cap blocks keeps its place, and later ones are served past it. A call that ends without a VM says where it stands, and its
  place is kept for 2 minutes: the next call resumes it. A VM goes only to a session that is waiting right then, never
  to one that stopped calling. A newer call from the same session takes over an older one, and closing the session
  leaves the line. Without `wait`, `vm_acquire` never jumps the line: waiting sessions are served first.
- **One VM by name (MC-1523):** `vm_acquire({ vm: 'hvmcp-…' })` asks for that VM only. It is for trials and censuses on
  a specific VM (a newly built one, say), not for normal use: leave it out and the pool picks. The request takes that
  VM's own OS and image (an `os` or `image` given as well must agree, or it's refused), and keeps every rule above: the
  project's cap and image list (a VM the project may never have is refused at once, never queued), and the line. A
  named VM that isn't free is refused with its state (leased until when, quarantined, being created or removed, in its
  evaluation's last hour); with `wait: true` the request stands in line like any other, is granted only that VM, and
  an earlier waiter still gets it first. It never falls back to another VM. Needs a helper with the `named` feature
  (setup updates it).
- A lease keeps the project it was granted for, whatever its session's roots say later.
- `vm_status` shows each project's VMs against its caps, the line in order (and why each waiter is
  waiting), and the session's own project.

### A pool from more than one image

A pool can hold VMs built from several verified images, and so of several kinds: Windows, and Linux (MC-1501, see
"Linux guests").
- **Each VM records its image and OS** at its create (Linux: see "Linux guests"). A VM made before that is given the image of the approved plan that
  made it, which the helper still has; if that can't be proved, its image is **unknown** (`vm_status` says so). An
  unknown-image VM is Windows: it serves a plain Windows `vm_acquire`, but never a request for an exact image, and no
  image's group counts it. It's never guessed.
- **Groups:** `pool_plan({ action: 'create' | 'resize', image: '<SHA-256 or its first 12+ hex digits>', vms })` builds
  from that verified image, or sets that image's group of VMs to `vms` (adding from it, or removing its unleased VMs),
  leaving the others alone. A `resize` without an image is the whole pool, as before.
- **`vm_acquire({ os = 'windows', image? })`** takes only VMs of that OS, and of that image when given. A request for an
  OS or image the session's project may not use is refused at once, never put in line. A waiter is only ever given a VM
  of its own kind.
- **Caps by OS:** a project's cap for an OS counts its VMs of that OS.
- **One VM per session**, as before: a project that needs Windows and Linux together uses two sessions (two agents).
- Setup checks the file with the helper's own policy code before changing anything. A rerun without `-ProjectsFile`
  keeps the list; `-ProjectsFile none` clears it.
- **It's advisory, like the roots it comes from:** it keeps honest agents from starving each other, not a determined one
  (any program running as you can name any roots).

## Configuration (`env`)

| Variable | Meaning |
|---|---|
| `HYPERV_MCP_ENABLED` | Must be `1`, or every tool refuses (`vm_status` still answers). A kill switch, not authentication. |
| `HYPERV_MCP_MODE` | `direct` for direct mode (see above); otherwise service mode. |
| `HYPERV_MCP_ALLOWED_ROOTS`, `HYPERV_MCP_ROOTS_FROM_CWD` | Where builds may come from, for clients that send no roots (see "Multiple projects"). |
| `HYPERV_MCP_MAX_BUILD_MB` | Optional. A cap this server applies before streaming a build (default 2048). The policy's `maxBuildMB` is the helper's own cap. |
| `HYPERV_MCP_PIPE` | Optional. The pipe's name (default `hyperv-mcp`). |
| `HYPERV_MCP_REPLY_MS` | Optional. How long a slow tool, or `vm_wait`, waits before replying "still in progress" (default 45000, at least 1000; see "Slow operations"). Keep it under your MCP client's tool-call timeout. |
| `HYPERV_MCP_*_MINUTES`, `HYPERV_MCP_*_SECONDS` | Optional. How long the helper waits for slow work (see "Timings" below). |

### Timings

How long the helper waits before it gives up on slow work (MC-1558). The defaults are generous, sized for a slow or busy
PC rather than a fast one. Change one only if your PC needs it: in Combwork, add the key to this server's `env` (the MCP
editor, `.combwork/mcp/hyper-v.json`). This server sends them to the helper each time it connects, and the helper keeps
each within its range and within setup's caps (below). vm_status shows the values in effect for your connection.

| Key | Default | Range | What it bounds |
|---|---|---|---|
| `HYPERV_MCP_GUEST_READY_MINUTES` | 10 | 2-60 | a started or restored guest answering (and a new Linux VM's first boot) |
| `HYPERV_MCP_RESTORE_MINUTES` | 10 | 2-30 | a checkpoint restore once the VM is off |
| `HYPERV_MCP_OFF_WAIT_SECONDS` | 120 | 20-600 | a VM reaching Off before a restore. The restore's call allows this plus the restore |
| `HYPERV_MCP_RESTORE_VERIFY_SECONDS` | 180 | 30-900 | a restored VM's new checkpoint showing, read fresh after the restore |
| `HYPERV_MCP_CHECKPOINT_MINUTES` | 10 | 2-60 | taking a checkpoint, or removing one (removing merges its disk) |
| `HYPERV_MCP_QUEUE_KEEP_MINUTES` | 10 | 2-60 | a place in vm_acquire's line between two calls |
| `HYPERV_MCP_LOGON_MINUTES` | 10 | 5-30 | an interactive logon at vm_start |
| `HYPERV_MCP_SHUTDOWN_MINUTES` | 5 | 2-30 | a guest shutting down cleanly (its call allows 1 min more; the clean checkpoint's, 10) |
| `HYPERV_MCP_INSTALL_MINUTES` | 90 | 30-360 | Windows setup in a new pool VM |
| `HYPERV_MCP_PROVISION_MINUTES` | 30 | 15-120 | each account's first-logon provisioning at build |
| `HYPERV_MCP_CLOUD_INIT_MINUTES` | 15 | 5-60 | cloud-init in a new Linux VM |
| `HYPERV_MCP_COPY_IDLE_MINUTES` | 5 | 1-9 | a Windows build copy or vm_sync with no 32 MB part or file finished (below) |
| `HYPERV_MCP_NETWORK_SECONDS` | 90 | 30-600 | a connected start's guest network: read back until it is right (a DHCP address, its route and DNS; or host mode's static address) and has held, then it goes on at once. This is only the ceiling (MC-1566) |
| `HYPERV_MCP_GUEST_SCRIPT_MINUTES` | 30 | 1-360 | the guest setup script a plan names, in each VM it builds (see "Guest setup script") |

- **Whose values apply.** A lease keeps the values its connection had when it was acquired: for everything done for it,
  its restore at release, disconnect or deadline included (which then runs to its own bound, but never runs guest work
  after the lease ended). A pool job keeps the values of the connection that applied it. Work with no client behind it
  (start-up recovery, retrying a quarantined VM) uses the defaults. A place in line uses the waiting connection's.
- **Setup's caps.** policy.json may hold `timingCaps`, `{ key: highest value }` with the keys above in their camelCase
  form (`guestReadyMinutes`, `offWaitSeconds`, ...), each within its range. A cap lowers the default too. An invalid one
  stops the helper from starting, saying why. policy.json is only writable by Administrators.
- **Windows copies.** A build's copy-in and vm_sync go in calls of at most 64 MB and 500 files, a file over 32 MB as 32 MB
  parts, each appended in the guest at once. The copy fails only when a call finishes no part or file within
  `HYPERV_MCP_COPY_IDLE_MINUTES`: a large copy at a slow but steady rate never meets a whole-copy limit. A call cut off
  after finishing some goes on with only what the guest hasn't committed, never resending the rest; one that finished
  nothing new fails. Each append is marked before it starts, so one cut off inside a part is rolled back to the part's
  start rather than resumed half-way. Progress is counted in whole parts or files, not bytes. The cap
  of 9 minutes stays under PowerShell Direct's own limit of about 10 minutes per call.
- **Linux copies** go over SSH, which has no such limit, in one call bounded by size, not progress: 30 minutes plus one
  per 100 MB.
- **Fixed waits**, the same for every client: the service host kills a helper that doesn't answer its heartbeat for 5
  minutes (every lease then ends); a VM's turn-off after a failed online step 3 min; a run's poll at least 30 s and its
  kill's cleanup 60 s; removing a VM 10 min; the client's roots/list answer 30 s; setup waits up to 30 min for the helper
  to start (saying so after 5) and 5 min for the service to stop. The build's guest setup is one call of up to 8
  minutes, retried once after a timeout or a lost connection (its script can run twice), never after another error.
  The build presses Enter for 60 s for the "Press any key to boot from CD or DVD" prompt: a fixed window, not a check
  that the VM booted.

Test-only:
- `HYPERV_MCP_PS_STUB`, `HYPERV_MCP_STUB_STATE`: a fake `hv.ps1`;
- `HYPERV_MCP_CRASH_AT`: crash injection;
- `HYPERV_MCP_STATE_DIR`;
- timing: the `HYPERV_MCP_*_MS` variables in `test\timing.json` (its defaults, narrow values and named profiles; each
  replaces a default, below its range), plus
  `HYPERV_MCP_MINUTE_MS`, `HYPERV_MCP_COPY_PART_BYTES` and the service host's `HYPERV_MCP_HOST_HEARTBEAT_MS`;
- `HYPERV_MCP_MIN_ISO_BYTES`.

The service's environment is set by its host, which users can't change.

### Server and helper versions

The server and the helper speak a numbered protocol, and since protocol 3 the helper also names its added features
(`vm_status` shows the helper's protocol). A server uses a feature when the helper speaks **at least** its protocol, or
names it, so a newer helper keeps serving older servers:
- protocol 2: `vm_renew`, `vm_sync`, `vm_reset`;
- protocol 3: `vm_start`'s `interactive` and `vm_run`'s `session`;
- feature `projects` (protocol 3): projects, `vm_acquire`'s `wait` and a project's own build folders;
- feature `images` (protocol 3): image groups, `vm_acquire`'s `os` and `image`, shares by OS, a project's image list.
  The server sends no `vm_acquire` at all for an `image`, or an OS other than Windows, to a helper without it.
- feature `network-modes` (protocol 3): the network modes as strings (`none`, `host`, `internet`, `internet-lan`) in
  `vm_start`, `vm_reset` and `pool_plan`. A helper without it would read any of them, `none` included, as networking
  on, so the server refuses each with "run setup again" and sends nothing; the old booleans (`true` host, `false`
  none) still go to it as before (MC-1570).

The helper stays at protocol 3 for these features because an earlier server (MC-1503's) asks for exactly hyperv-mcp/3 before an
interactive run: it keeps working with this helper. An older helper refuses each newer feature with "run setup again"
rather than quietly ignoring it. A newer feature also needs the newer server: an agent's server loads at its start, so
update the server (and restart the agent) as well as the helper.

## Security model

**Who gets it.** An MCP server can't tell its callers apart, so give this one only to agents that test. In Combwork,
turn it on only in a dedicated testing project. The helper's leases keep agents from colliding, not from each other.

**Approvals.** Each pool change needs `approvals\<plan>.json`, written by the elevated `approve.ps1`, before the helper
acts. The helper accepts it only if all of these hold:
- its digest is the SHA-256 of the plan file (canonical JSON the helper wrote, which can't change after approval
  without breaking the digest);
- its operation matches;
- its epoch matches the pool state's (an approval from before a state reset never counts again);
- it hasn't expired (30 minutes at most);
- its nonce is unused. The helper journals the nonce as used before its first side effect.

The helper also checks, through `hv.ps1`, that only Administrators and SYSTEM can write the folder and the file, and
that they own them. The service account can only read there.

`approve.ps1` itself:
- runs only from `%ProgramFiles%\hyperv-mcp`, never from the repository or a downloaded script, so approving never
  runs code an agent could have edited;
- checks the plan id is an opaque `p-` and 16 hex digits before touching a file;
- reads only the helper's own record.

**The one-line launchers (MC-1575).** Setup, approvals and the uninstaller are each one line,
`cmd /c call "<launcher>.cmd" <arguments>`, and the same line works in cmd, Windows Terminal, Windows PowerShell and
PowerShell 7. (`call` keeps every quoted path's quotes, which `cmd /c` alone strips once a second argument is quoted.)
- The launcher runs its `.ps1` under Windows PowerShell 5.1 where it is installed, otherwise PowerShell 7. It finds
  each one from its HKLM registration, and `reg.exe` and `cmd.exe` by their full paths under `%SystemRoot%`. It never
  looks in PATH or the current folder, which a non-elevated program could plant things in. With neither installed, it
  says so and runs nothing. The scripts themselves run the same under either engine.
- The service runs `hv.ps1` with the PowerShell setup ran in, recorded in `host.config` only if it is one registered in
  HKLM (otherwise HKLM's default, as above). The Installed apps entry names the same engine by its full path.
- Paths are read first by the shell the line is typed in and then by cmd, so keep `%`, `^`, `&`, `!` and `$` out of
  the folder and file names you pass. A `%` or `^` that is still there when the launcher runs is refused before
  anything runs. What the typing shell has already changed (a `%NAME%` or `$name` it expanded) can't be seen, so
  avoid those characters rather than rely on the refusal.

Even a forged approval can only do what the policy allows.

**The journal and recovery.** `%ProgramData%\hyperv-mcp\journal.jsonl` is append-only, and each record is flushed
before the side effect it announces:
- a create records its intent (a random VM name and its own folder) before `New-VM`, and the VM's id right after;
- a switch is recorded with a random token before `New-VMSwitch`, which writes that token into the switch's Notes as
  it creates it; its id is recorded right after;
- a remove marks its VMs before removing them;
- only one pool job runs at a time, and pool jobs and leases share one lock, so a remove can't race an acquire.

At every start, before it serves anyone, the helper replays the journal. A half-written last record (a crash
mid-write) is cut off the file first, so nothing is ever appended onto it. Then:
- an unfinished create is rolled back. Its VM is found only by its exact random name **and** its exact folder, never
  by the prefix, so nothing else is ever adopted;
- an unfinished remove is finished;
- an unfinished switch change is finished, on the pool's switch only. That's the one with its recorded id or its token
  in its Notes, never a switch that merely has the same name: a same-named switch of someone else's is left
  untouched and reported. (Only pools from before MC-1556 have such a switch: runs no longer use it.) A connected
  start connects by switch id, never by name;
- a run's network change needs no journal record: the adapter's rules go on before it connects, and every VM is
  restored below, which disconnects it and removes them (see "Network modes");
- open jobs are closed;
- every VM is restored, and every lease from before is void.

**Process supervision.** The service host runs `node helper.js` in a job object that kills everything inside it when
it closes, so the helper and every PowerShell it started die together. The host closes every client connection,
ends the job, and starts a new helper when the helper:
- exits;
- closes its output;
- misses its heartbeats (a ping every 10 s, no answer within 30 s).

The new helper recovers before the pipe opens again, so no old operation carries on during recovery or a new lease.
After 3 starts within 10 minutes, the host exits and leaves the restart to the Service Control Manager. If the host
itself dies, its job closes and the helper dies with it. The host refuses to start if its pipe name already exists,
since another program may have created it first.

**Warm sessions.** A lease can stay running across runs. Nothing about its end changes: release, the deadline and a
disconnect restore and verify the VM, and kill whatever is in flight, a sync included. Renewals are bounded by the
policy (each up to `maxLeaseMinutes`, all within `maxSessionMinutes` of the acquire, which setup refuses below one
lease), and refused once the deadline has passed. A sync:
- is planned against the helper's record of the files it placed in `C:\build` (by canonical Windows identity: case
  and slashes don't count). A manifest naming one file twice, or a file and something inside it, is refused. The
  manifest goes to the helper in batches of at most 1 MB, whatever the build's size, and `server.js` never sends a
  request line over the service host's 4 MB limit (one over it would close the connection, and with it the lease);
- is bound to its lease and a generation that moves on at every start, reset, sync and the lease's end, so a replaced,
  used or stale plan is refused, and rechecked inside the VM's lock. Its staging must be exactly the plan's files,
  each once, with the size and SHA-256 the plan has: the helper hashes them as they arrive;
- marks `C:\build` untrusted before its first change. If it doesn't finish, only a full sync or a reset is accepted
  next. A start that fails does the same;
- is applied in the guest by `helper\guest-sync.ps1`, a fixed script run over PowerShell Direct. It checks
  everything before it changes anything: `C:\build` and every existing folder on the way to each file or removal
  must be real folders (a link or junction is refused), and in the way of a file or a folder is removed (or, with
  `delete: false`, refused). It deletes without ever entering a link, and moves each file into place from a fresh
  staging folder under `C:\hvmcp`.

What a guest process does to `C:\build` while a sync runs, or between syncs, only touches the guest's own disposable
disk, and isn't tracked: a sync copies what changed on the host, not what changed in the guest (`full: true` puts it
right).

**Files in and out.**
- **In:** the server walks the build after the roots checks, skips links, and streams it over the pipe. The helper
  checks every name and writes the build to a private staging folder (`runs\<lease>\staging`, deleted after the copy and
  swept at every start), then copies it into the guest with PowerShell Direct (`Copy-Item -ToSession`).
  - This is a copy, so the host's build files can't be changed from the guest.
  - Inside the guest, `C:\build` is read-only for the standard user only: the guest's admin can still write its own
    copy.
  - Why not a share, a VHDX or `Copy-VMFile`: a share stays open; attaching a VHDX needs mounting on the host (admin);
    `Copy-VMFile` needs Guest Services, one file per call; and the service account can't (and shouldn't) read your
    profile.
- **Out:** `vm_read_out` reads in the guest, in bounded chunks, and returns the bytes as data. Nothing is written to
  host disk, so there's no host-side link to follow.
- **Between runs:** PowerShell Direct sessions are per call, and Guest Services stays off, so no channel stays open.
  A sync is a copy too, by the same route: no share is opened for a warm session, so none can be left open.

**Guest credentials.** The answer file creates a guest admin (`hvadmin`) and a standard user (`hvuser`) with random
passwords. The passwords are kept in the helper's state folder and passed to `hv.ps1` on stdin. Setup's copies of the
answer file are deleted, on the host and in the guest. An interactive start adds no credential on the host: it gives
the account's existing password to the guest only, as the LSA secret `DefaultPassword` (readable only by SYSTEM and the
guest's admins, not the Winlogon registry value, which users can read), and the next restore removes it.

**The interactive session.** Session 0, where PowerShell Direct runs commands, is the services' session: its window
station isn't interactive, there's no desktop and no shell, and a program that makes its own desktop on `winsta0` fails
there (0x8007045A, `ERROR_DLL_INIT_FAILED`). A logged-on user's session (1 or more) has the interactive window station
`WinSta0` with its desktops and the user's profile loaded. So:
- `vm_start({ interactive })` logs one account on, and restarts the guest once:
  - `'user'`: **`hvuser`, a standard user** with UAC on, the realistic case. It can't do what needs elevation (a test
    that starts a child under another token, for example).
  - `'admin'`: **`hvadmin`, elevated.** UAC's Admin Approval Mode is turned off in the guest (`EnableLUA` 0), so the
    admin's session gets a full token with no prompt. That guest has UAC off until its next restore.
  - Winlogon autologon of that account (the first-logon animation and privacy questions off), and a **watcher**
    (`helper\guest-agent.ps1`, copied to `C:\hvmcp\agent.ps1`) that Winlogon starts at logon, in that account's own
    session, from its `Userinit` list. Windows' own list (`C:\Windows\system32\userinit.exe,`) gets exactly the
    watcher added, by absolute paths; any other list is refused before anything changes. (An HKLM `Run` entry, used
    before, waits for a new desktop to settle: minutes on a first logon.)
  - `C:\hvmcp` is made admin-only (Users may read and run), so no user can change the watcher or a wrapper it starts.
    `C:\hvmcp\user` is where the standard user's session-0 runs stage their scripts, and the watcher never runs anything
    from there. `C:\hvmcp\req` is where runs are requested, writable by the logged-on account so its watcher can take
    them.
  - Then the helper waits, as the lease's, up to 10 minutes, for a new boot with the account's watcher in a session of
    1 or more, seen twice 10 s apart on the same boot: the guest may restart once more by itself after an autologon.
    That's a readiness check, not a guarantee. A later restart just means the next run isn't taken, and the VM is
    restored (below). If the account logs on and Windows then logs the session off again (and so turns autologon off),
    the start fails at once and says so, even when that happened before the first check (seen from that boot's own
    logon and logoff events for the account, MC-1524; unreadable events never count, nor a logoff while autologon is
    still armed); one that logs on but whose watcher never starts says that instead. One whose logon never begins (no
    logon event for the account 3 minutes after the new boot was first seen, MC-1526) fails then, rather than after
    the full 10 minutes. Either
    marks the VM's start as failed, so `vm_acquire` gives another free VM first.
  - A restart keeps the guest's disk, so a work session's sync record stays right. The clean checkpoint isn't changed:
    every start without `interactive` is as before, and a restore (stop, release, the deadline, `vm_reset`) logs nobody
    on and turns UAC back on.
- `vm_run({ session: 'interactive' })` can't use PowerShell Direct, which can't place a process in another session, and
  Task Scheduler wouldn't start one there on the first autologon (it reports the user as not logged on). So the helper
  (as the guest's admin, over PowerShell Direct) writes the run's script and wrapper in `C:\hvmcp`, then publishes a
  request, `req\<n>.go`, by renaming a finished `req\<n>.tmp`. The watcher takes it (it creates `<n>.claimed`, which
  only one taker can do, and removes the request, starting nothing if either step fails) and starts the wrapper in its
  session. The wrapper writes the exit code aside and moves it into place, so it's read whole or not at all.
  - **A clean finish** is that exit file within `timeoutSec`: the reply has the exit code and the output. Processes
    the command left running carry on, as they do after a session-0 run.
  - **Anything else** (a timeout, a run no watcher took, an error on the way) isn't chased process by process. The
    output so far is read, then the helper **restores the VM**, which ends everything the run started and removes the
    logon. The reply says so, and `vm_start` or `vm_reset` goes on (a reset logs the account on again). It costs a
    restore and a restart, and keeps the rule simple: nothing from an unfinished interactive run can outlive it.
  - A watcher keeps nothing in memory: a restarted one never runs a request again.

## Removing everything without agents

You don't need an agent, or this repo, to put the PC back (MC-1557). Setup installs the uninstaller with the helper, and
it works out what to remove when it runs, from the helper's own records: the pool, VMs, checkpoints, images, switch,
service and folders as they are then, whoever made them. Nobody has to keep a script up to date.

- **Settings > Apps > Installed apps > "Hyper-V MCP helper and test VMs" > Uninstall.** It asks for admin rights, shows
  what is installed, and asks: remove everything (the default), keep the pool and remove only the helper, or list only.
- Or, in an admin terminal (cmd or PowerShell; one line), the installed copy:
  ```
  cmd /c call "C:\Program Files\hyperv-mcp\uninstall.cmd"
  ```
  Add `-RemovePool` or `-KeepPool` to skip the question, or `-WhatIf` to see what each would remove, changing nothing
  (no record, no approval, no service change).
- **What is installed, in plain text:** `C:\ProgramData\hyperv-mcp\inventory.txt`, the helper's recorded inventory,
  rewritten after every change it makes. Each item has the command to remove it by hand, for when the uninstaller
  can't run. The uninstaller shows it first, and checks every item live before deleting anything; it never runs the
  file's text.
- **Interrupted?** Run the Installed apps entry again: it finishes what's left, down to its own files and itself.

Remove everything takes the pool's VMs and their checkpoints, the cached images, the disk folders, the helper's state,
setup's host-mode switch, the service, its rights, the group, the install folder, the registry records and the entry.
Keep the pool keeps the VMs, their checkpoints, the images, the disk folders and the helper's state with their records,
and removes the rest, the entry included. To remove a kept pool later, run setup again (it restores the helper and
the entry), then uninstall.

It doesn't undo what was set up beside the MCP, such as Ollama's settings or a firewall rule you added for host mode:
undo those as you were told when they were made. Its last line reminds you.

## Uninstall

From Installed apps, or in an admin terminal (one line), with the installed copy or the repo's:
```
cmd /c call "C:\Program Files\hyperv-mcp\uninstall.cmd" -KeepPool
cmd /c call "C:\path\to\combwork-mcp\servers\hyper-v\setup\uninstall.cmd" -KeepPool
```
An installed copy runs itself from a protected temporary copy (only SYSTEM and Administrators), so it can remove its own
folder. If a run is interrupted (its window closed), the next uninstall or setup removes that run's copy, only when it
is exactly such a copy (`C:\Windows\Temp\hvmcp-uninstall-<32 hex>`, no links, owned by Administrators, only SYSTEM and
Administrators granted, only the uninstaller's files) and no uninstall still runs from it; nothing else there is touched.
With neither option it asks (see above). Choose one:
- `-KeepPool` removes the service, its rights, the group and the code, and **keeps** the VMs, the helper's state (the
  journal, policy and guest credentials), the disk folders and their storage receipts. Running setup again recognises
  them by their receipts.
- `-RemovePool` removes the pool first, through the helper's own journalled remove (you approve that plan as usual).
  Then it removes the storage, then everything else.

**What it may delete:** only storage it verifies, before any change, as setup's own:
- for an install made by this setup, exactly the folders that have storage receipts. Each folder's identity must
  match its receipt, and its owners and permissions must be setup's;
- for an install made by an older setup (no receipts), only the state folder and the disk folder you name with
  `-LegacyDiskFolder D:\hyperv-mcp`. Each is checked (owned by Administrators or SYSTEM, permissions only for the
  expected accounts, no links, safe parents). Then you're shown exactly what will be deleted, and asked to type
  DELETE. Their present permissions prove nothing about their history, so your confirmation is the authority;
- without that evidence, nothing is deleted. `policy.json` is never a source of what to delete.

Nothing is ever deleted through a link. `-KeepPool` verifies the storage the same way, though it deletes nothing:
quiesce reads and writes the helper's state as admin, so anything it would refuse to delete, it also refuses to use.

**In what order:**
1. Verify everything, changing nothing, and write a record.
2. Quiesce the helper and remove the pool: no new leases, every lease ended, every VM restored. The quiesce's own
   admin-written approval names its purpose: with `-KeepPool` no pool change is allowed after it; with `-RemovePool`
   only this uninstall's own approved remove.
3. Stop the service. It stays registered, and the code stays.
4. Delete the storage. A leftover in `pool\` stops here, with the service only stopped.
5. Remove the service, its rights, the group and the code.

Every run, including a resumed one, re-checks the recorded storage before acting on it. It also confirms (or makes)
the service stopped right before steps 4 and 5: the record proves earlier work, not that the service hasn't been
started again since.
6. Remove the receipts, the install's id and the record.

**Interrupted?** Run it again with the same options: it resumes from its record (`HKLM\SOFTWARE\hyperv-mcp`). That
record is bound to this installation and to the options it started with, and a rerun with other options is refused.
Every step does nothing when its work is already done, so no rerun needs anything an earlier run removed. Setup refuses
to run while an uninstall is unfinished. A finished `-KeepPool` leaves only its `KeptPool` mark, bound to this
installation: a later setup clears it and takes the pool over, and `-RemovePool` then works as usual.

**The last phase (MC-1557): the uninstaller's own files and the Installed apps entry.** Step 5 leaves the install
folder's `uninstall\`, the entry's route. Setup's host-mode switch is removed next, on every run that gets this far,
including a rerun after an interruption. Once everything else is checked gone (for `-KeepPool`: the helper's parts
gone, the kept ones present), `uninstall\` is renamed to `uninstall.retiring\` in one step, the rest of the install
folder is removed, then its last files and the entry. The entry runs a fixed launcher (an encoded PowerShell command
with its paths from Windows' known folders, never from the registry), so whichever point an interruption leaves, the
entry finishes it: it runs the uninstaller while its files are whole and trusted (the folder, its parents and each
file not a link, owned by Administrators, SYSTEM or TrustedInstaller, and writable by no one else; anything else is
refused and nothing runs); otherwise it removes the uninstaller's own
leftovers itself, but only when they are exactly what it leaves (no links, nothing else in the folder, owned by
Administrators, SYSTEM or TrustedInstaller, no service and no unfinished uninstall); then its own registry key, only
when nothing of the MCP is left, or a verified `KeptPool` mark says the kept state is meant to stay. Anything else
is left untouched, with the manual step printed. Only the uninstaller's fixed folder and key are targets here: never a
path from the registry or the inventory.

## Limits

- A cold start of a VM boots Windows: tens of seconds. A start from a checkpoint taken while running would be faster,
  but the clean baseline is taken powered off, so that "clean" is exact.
- Output is capped at 16 KB per stream for `vm_run`, and `vm_read_out` at 256 KB per file and 1 MB per call by default.
  Write big results to a file in `C:\out` and read it in parts.
- Commands run over PowerShell Direct in session 0, as the admin, or as the standard user in its own PowerShell Direct
  session. For that, the guest's admin adds the user to the guest's Remote Management Users group first, inside that
  throwaway guest only. A desktop session needs `vm_start`'s `interactive`: one guest restart, and only the account it
  logged on can run there. There are no screenshots.
- An interactive run that times out restores the VM (see "The interactive session"): give such runs a generous
  `timeoutSec`.
- **Long runs:** since the September 2025 Windows updates, PowerShell Direct ends any single call after 10 minutes, with
  "The Hyper-V socket target process has ended" ([PowerShell #26176](https://github.com/PowerShell/PowerShell/issues/26176)).
  So no run holds a call open: it is started (or, in the interactive session, published to the session's watcher) in
  one short call, then its exit file is polled with short calls (every second at first, then every few seconds) until
  it's there or `timeoutSec` passes. A poll that fails is retried within that same deadline. A process started from a
  call goes on after the call ends. Windows copies (`vm_start`'s build copy and `vm_sync`) go in bounded calls of at most
  64 MB each (MC-1558, see "Timings"), so a big build on a slow host never meets that limit; a copy that stops making
  progress fails, and `C:\build` is then untrusted until a full sync or a reset. `maxBuildMB` limits bytes, not time.
- Windows guests from an x64 ISO with `sources\install.wim`, run so far on Windows 11; Linux guests from a qcow2 cloud
  image with cloud-init, systemd, OpenSSH and `hv_sock`, run so far on Debian 13 and Ubuntu 26.04 (see "The image" and
  "Linux guests"). An evaluation VM lasts about 90 days from its activation at build (see "Windows licences").
  Building from a ready-made VHDX isn't supported: an own copy comes from an ISO.
- A sync tracks only what the helper copied into `C:\build`. A run that changes `C:\build` itself isn't seen; a
  file renamed only in case on the host keeps its old spelling in the guest. `full: true` or `vm_reset` puts either
  right. State across a guest reboot within a session isn't specially kept (a reboot is the guest's own business).

## Tests

From the repo root, `npm test` runs everything below. Hyper-V is never touched: `hv.ps1` is replaced by
`test\stub-hv.js`, a fake Hyper-V that keeps VMs, checkpoints and guest files in JSON. Each test runs the real
`helper.js` as a child process, the way the service host does. From this folder:

```powershell
node --test test\units.test.js test\leases.test.js test\sessions.test.js test\guest-sync.test.js test\guest-agent.test.js test\interactive.test.js test\licence.test.js test\provision.test.js test\provision-clock.test.js test\provision-readiness.test.js test\provision-budget.test.js test\projects.test.js test\images.test.js test\named.test.js test\checkpoints.test.js test\poolcheckpoints.test.js test\refresh.test.js test\restorewait.test.js test\runs.test.js test\approvals.test.js test\recovery.test.js test\server.test.js test\host.test.js test\linux-image.test.js test\linux-guest-files.test.js test\linux.test.js test\linux-ps.test.js test\bridge.test.js test\network.test.js test\guestnet.test.js test\uninstall.test.js test\timing.test.js test\nested-proof.test.js
```

- `units.test.js`:
  - the UDF/WIM reader against real UDF images (made with the in-box IMAPI2 through `hv.ps1`), and malformed ones
    (truncated, corrupt checksums, byte flips, a missing or bad WIM);
  - the image checks (MC-1572): any local ISO copied while hashed with its path, any x64 edition and build (Home,
    Server, Windows 10, a newer evaluation build), signatures as information (unsigned, unread), ARM and missing
    editions refused as limits, the helper's own folders, every download shape refused; hv.ps1's `create-vm` refusing an
    ISO copy whose hash isn't the approved one, before anything is created;
  - the policy, the journal (a torn last line cut off, then reopen → append → reopen keeping every record),
    canonical plans, the answer file's escaping, the evaluation-expiry warning;
  - setup's storage and ACL routines themselves, non-elevated on temp folders and a test registry key
    (`test\acl-check.ps1`), under Windows PowerShell 5.1 and PowerShell 7 each (MC-1575):
    - a folder created with its final security and its receipt, then trusted unchanged on the next run;
    - the injected boundary: a folder created, with a forged journal, between "missing" and the create, refused and
      left untouched, with no receipt minted;
    - a legacy folder (exclusive, but no receipt) refused, and an interrupted creation (no receipt) failing closed;
    - a folder deleted and made again (another identity) refused;
    - a parent granting Users DeleteChild refused, and a junction parent refused;
    - a pinned parent that can't be renamed while setup holds it;
    - a receipts key that Users can write, refused;
    - a file written with its own ACL, not the old file's;
    - for the install folder: earlier grants removed, VM grants kept, links refused before any change;
  - uninstall's teardown (`setup\teardown.ps1`), non-elevated with strict fakes for its outside actions
    (`test\teardown-check.ps1`), under 5.1 and 7 each, including `-WhatIf` changing nothing (no outside action, no record, files and key as
    they were) and the install folder's `uninstall\` kept for the last phase:
    - a crash at each of 25 points (before and after every action and every record write), then a rerun to
      completion, without asking any action to redo what was undone;
    - a forged `policy.json`, with and without a journal, refused, nothing deleted;
    - an identity mismatch, a target replaced by a junction, or a link inside a target, all refused with nothing
      changed; a link slipped in after verification removed as a link, never followed;
    - a leftover in `pool\` refused;
    - a cancelled approval, a remove that leaves a VM, and a failing `sc delete`, each stopping at its phase, then a
      rerun;
    - KeepPool, then reinstall, then RemovePool; a resume with other options refused; setup refused during a
      teardown;
    - legacy storage refused unless admin-owned, unchanged unless confirmed, removed when confirmed;
  - `approve.ps1` refusing to run outside the install folder;
  - setup and `uninstall.ps1` running under 5.1 and under 7 on to their own checks, changing nothing; the module-path
    fix applied under 5.1 only;
  - setup's helper file list holding every helper file (and the zip the whole helper folder), and its `-BuildRoot`
    and `-MaxSessionMinutes` checks agreeing with the helper's, under 5.1 and 7.
- `launchers.test.js` (MC-1575): `install.cmd`, `uninstall.cmd` and `approve.cmd`, each run for real by its one line
  typed in cmd, Windows PowerShell 5.1 and PowerShell 7, beside a stub script:
  - spaced paths for every path option, arriving exactly; exit codes 0 and 7 reaching each caller;
  - Windows PowerShell 5.1 where it is registered; a copy whose 5.1 key is renamed running PowerShell 7 (the fallback,
    exercised on this PC); with neither, nothing run and the reason given;
  - fake `powershell`, `pwsh`, `reg`, `findstr` and `where` in PATH and the current folder, never run;
  - a `%` or `^` still in an argument refused before anything runs; a `%NAME%` that cmd has already expanded arriving
    expanded (the documented limit, not claimed as caught);
  - the installed `uninstall.cmd` running `uninstall\uninstall.ps1` and ending cleanly when the uninstall removes it;
    typed directly in a cmd session or called from a batch file, the caller goes on, with the exit code;
  - the three launchers one text, apart from the script each runs;
  - `hv.js`'s engine choice from `reg.exe` output, and `hv.ps1` run under each engine through `HYPERV_MCP_POWERSHELL`.
- `leases.test.js`:
  - leases across connections; a connection closing, the deadline, keep and `keepOnFailure`;
  - the restore before every start;
  - keep, then a guest shutdown, then a new start: the run's sentinel file is gone;
  - restores that leave the adapter, a reserve or a running VM, which are caught and quarantined, then retried;
  - a checkpoint replaced under its name;
  - ownership: a renamed VM, and a foreign VM with the prefix never touched;
  - networking and the reserve cap; staging limits; runs (as user, timeout, caps); `read_out`;
  - protocol abuse, and that an agent's command never reaches a host command line;
  - a lease that is ending: its connection refused at once; an operation already queued for the VM's lock when the
    lease ended (start, run) refused inside the lock; the VM handed on only once restored.
- `sessions.test.js` (warm work sessions):
  - one VM held across several runs through `server.js`: a sync with nothing changed copies nothing; an edited and an
    added file are the only ones copied; a removed one is removed; `C:\out` and the run's state stay; no restore until
    `vm_reset`, which restores, recopies and keeps syncing; release restores to the verified baseline;
  - the build folder checked at every sync and reset (outside the roots, the profile, a junction, a root the client
    dropped); links in the build skipped;
  - the record: `delete: false` then `delete: true`; a full sync replacing it outright; file and folder transitions;
  - manifests: unsafe paths, the same file twice by Windows identity, a file and its descendant; sent in parts
    (bound to the lease and generation, taken once, capped per batch and in all); a request line over 4 MB refused
    by `server.js` before it is sent;
  - plans: replaced, used and stale (after a reset) refused; staging exactly the needed files (not another, not twice,
    not another size or content, none missing); a start never taking a plan's staging as its build;
  - a failed sync, a failed full sync and a failed start leaving `C:\build` untrusted until a full sync or a reset;
  - the guest's own change to `C:\build` untracked until a full sync;
  - sync refused on a stopped or kept VM; a disconnect mid-sync killing it and restoring the VM;
  - renewal with an injected clock and mocked timers: `maxLeaseMinutes`, the session cap exactly, refused at the
    deadline before its timer fires, the policy's `maxSessionMinutes` check, one timer per lease however often it is
    renewed, and the renewed deadline ending and restoring the lease.
- `guest-sync.test.js`: `helper\guest-sync.ps1` itself, run with Windows PowerShell 5.1 on temp trees with real
  junctions (`mklink /J`, no elevation): a junction as the root, on the way, inside a removed folder and in a full
  clear, never entered; file and folder transitions; escapes, odd names, duplicates by identity and a file with its
  descendant refused; `delete: false` blockers refused with nothing changed.
- `guest-agent.test.js`: `helper\guest-agent.ps1`, the interactive session's watcher, run with Windows PowerShell 5.1
  from a temp folder: a request runs once; a restarted watcher replays neither a finished request nor a claimed one
  (nor one whose request file was left beside its claim); two watchers at once run each request once; only
  `<digits>.go` is a request. Later requests are the barriers, never fixed sleeps.
- `interactive.test.js`, through `server.js`: an interactive start (one restart, the disk kept) and runs in its session
  beside session-0 runs; the admin logon, elevated, and the user's, not, with service runs as both beside them; the
  logon waiting out the guest's own extra restart; a watcher that has gone (the run isn't taken, and the VM is
  restored); refusals (nobody logged on, another account, bad values, a logon that never
  appears); `vm_reset` keeping `interactive`, a stop logging nobody on, a sync across the logon; an interactive run that
  times out, never starts or fails restoring the VM after its output is read (a session-0 timeout still doesn't); the
  password never in a reply, the journal or a log; a helper that predates the protocol refused before anything
  runs; and a VM whose start just failed leased last (another free VM first; a note when all have failed; cleared by a
  good start).
- `licence.test.js`, Windows licences: an evaluation build online once (journalled), disconnected before its
  checkpoint, its end recorded and kept across restarts, starts and resets, and no start using the Default Switch; a
  failed, short or still-connected activation (net-off, then the rollback); a failed cleanup left flagged and finished
  by recovery or the retry; no Default Switch; an own copy built offline with its bound edition, or with the product key
  only in its answer file (never in a reply, plan, journal, log or the stub's calls); a plan made before activation
  refused; leases and renewals capped at an evaluation's end, and none in its last hour; an older VM's licence unknown.
- `provision.test.js`, the test accounts' profiles at build: hvadmin then hvuser logged on once each, their
  first-logon work waited out, a verified undo after each (hvuser's logon with UAC on and Windows' own Userinit, which
  the stub enforces like the guest), the checkpoint without any of it; quiet started over by a failed or busy sample;
  never quiet fails the build; a lost logon retried once after an undo, twice failing; a first logon Windows drops
  before any check (MC-1524) retried straight after its diagnosis and undo, noted as expected, twice failing in full;
  a first logon that never begins (MC-1526) retried after the sign window, noted as expected, twice failing in full;
  an undo that doesn't verify
  (an explicit ACE left on `C:\hvmcp`, UAC still off) failing the build. The guest setup script (MC-1577): a plain build
  with no Defender step, registry policy or script (the plan says "none"); a named script shown in the plan by path,
  size and SHA-256, run once as the admin after the profiles, its run cleared, then the checkpoint (which keeps what it
  did); the helper's copy running, whatever the user's file becomes after the plan, and a changed copy refusing the
  plan; a non-zero exit or a timeout (the run killed) failing the build with its output, rolled back; a relative,
  missing, wrong-kind, empty or over-1 MB file refused at plan time. `linux.test.js` runs a `.sh` as root after the
  guest's checks and before cloud-init is turned off, its run folder gone at finish; `server.test.js` refuses a
  `guestScript` on a helper without the `guest-script` feature.
- `provision-readiness.test.js`, the wait for App Readiness (MC-1528) on a fake clock: no acceptance while it's
  pending, even when everything else is unchanged; the quiet counted only after it finishes, and started over by new
  work, a new completion or an unreadable sample; unknown (or a probe without it) never accepted; never finishing
  failing late with its state; every call bounded; App Readiness's own suspension (MC-1562) credited once, by one
  budget at most, and none for a backwards, unreadable or older-probe one. `provision.test.js` checks it through the stub (the post-wave counts
  and the allowlisted state in the record; never finishing, or unreadable, rolled back with no ready record), and
  `interactive.test.js` runs hv.ps1's own App Readiness parser on synthetic events worded as Windows words them.
- `provision-clock.test.js`, the real provisioning and logon methods on a fake clock: one provisioning deadline per
  account over its logon, quiet wait and retry, so a session lost near it gets no new allowance; every call bounded by
  the time left; nothing accepted that returns after the deadline (a logon's readiness, a quiet probe); a start's logon,
  with no deadline, keeps its own wait and timeouts; a slow build logon's snapshot at the threshold kept with the attempt
  that then succeeds, and an unavailable one changing nothing (MC-1520); a dropped first logon (MC-1524) and a silent
  one (MC-1526) ending on their evidence, the silent one timed from the new boot's first sighting (never the old
  boot's), started over by a restart, not reset by a failed probe, never ended by unreadable counts, a logon event or
  the user seen, and the retry with its full quiet inside the deadline. `provision.test.js` also covers a failed build
  logon diagnosed before its undo, its reason and allowlisted snapshot in the record and the job note (fields such as
  messages, command lines and passwords dropped), and an unavailable diagnosis; quiet waiting for the AppContainer
  counts to stop changing (recorded), and an unknown count never quiet; `interactive.test.js` runs hv.ps1's
  event-shaping and count blocks for real.
- `provision-budget.test.js`, the 30-minute per-account budget at its proportions on a fake clock: a first attempt that
  times out still leaves the retry its logon and full quiet window; a count change late in the window starts quiet
  over; counts that never settle exhaust the budget, with nothing running past it.
- `projects.test.js`, sharing the pool: one shared pool with no projects; caps (one project at its cap refused while
  another still gets its VM); the line, first come first served, a capped waiter passed over keeping its place, an abandoned
  wait never given a VM and its place expiring, a repeat call keeping its place, a disconnect leaving it, a resize
  serving the next waiter, and a newer call superseding an older one (in-process); a lease keeping its project; which
  project a session is in; through `server.js`, a project's own build folder refused to others, and a newer helper
  still serving this server; setup's projects check under Windows PowerShell 5.1 and PowerShell 7, before any change (caps per OS
  formatted, never cast; `reserveVms` refused); the policy's rules for projects.
- `images.test.js`, a pool from more than one image (a stub "linux" kind, made only in the journal): groups by image
  (a resize adding to or taking from one image's VMs only); `vm_acquire` by OS and image, one VM per session; VMs made
  before images were recorded, recovered through their plans, or unknown when that can't be proved (a plain Windows
  acquire takes one, an exact image never does, a group resize leaves them alone); caps by OS and the image list (a
  project at its Windows cap still gets Linux, a forbidden OS or image refused, never queued); a waiter never given
  another kind; and, through `server.js`, no
  acquire at all sent to a helper without `images` for an image or Linux.
- `restorewait.test.js`, a restore's waits (MC-1536, MC-1537): hv.ps1's own restore handler, run for real with mock Hyper-V calls on a fake clock (a late Off, a saved state, never Off with no restore issued, and no parent read in that process); core's fresh-read verification on a fake clock (stale reads polled past, an explicit failed report never verified, the budget including each read's time, a late match refused, a failing read named, an ending lease stopping it); and the callers through the stub, whose restore replies carry the stale parent (a lease restore verified only through fresh reads, a timed-out Off refused though the facts match, a restore that never lands refused and never started).
- `refresh.test.js`, refreshing a clean checkpoint (MC-1531): with a pool checkpoint present (the new clean carrying the fix, the old one removed, the pool checkpoint kept and startable, the evaluation end unchanged, never online); a repeat refresh keeping the sibling pool checkpoint; failures before the commit (a guest step, a failed take, a take made despite its call failing) abandoning with only the old clean left; a removal failing after the commit, quarantined until a retry; crashes before and after the commit; a leased VM skipped and a refreshing VM never leased while another is; an aged evaluation with a guest claiming more days; a second refresh refused while one is unresolved; and the feature gate.
- `poolcheckpoints.test.js`, pool checkpoints (MC-1532):
  - published from a lease, then another project starting from it, clean on demand and released to clean;
  - binding and ownership refusals, and an ended lease publishing nothing;
  - failures at the undo, the shutdown and the take, each publishing nothing and saying what changed (the take's
    failure leaving the VM running again with the prepared file);
  - replacing from its own lease (the old one retiring, then removed with the new child kept) and removing on a
    leased VM (pinned until that lease ends);
  - acquire by checkpoint (unknown name, a `vm` that lacks it, image, a waiter served), and a name on Windows and
    Linux VMs needing `os`;
  - a lease ending during the take, with another VM leased meanwhile;
  - the cap; a two-VM plan's partial success; a lease checkpoint on a pool checkpoint; the evaluation end unchanged;
  - recovery at each journal boundary;
  - the feature gate.
- `checkpoints.test.js`, a lease's own checkpoints (MC-1529) against the stub's snapshot tree: a then b, restoring
  each (a file's state follows), kept across the lease's own reset, removed child-first at release; the refusals (not
  running, reserved or bad name, duplicate, cap, disk floor, unknown name, unconfirmed C:\build after a restore); the
  lease's current network and reserve reapplied after a restore; a production checkpoint that can't be made failing
  with no fallback, and one made despite a failed call kept and removed with the lease; a take whose outcome can't be
  read holding its slot; a failed removal quarantining the VM until it succeeds, across restarts; recovery removing a
  take journalled without its id (by name) and leaving an unknown snapshot alone; a lease ending during a take; the
  deadline unchanged; and the feature gate.
- `named.test.js`, `vm_acquire({ vm })` (MC-1523): that VM leased rather than the pool's pick; an unknown name, a
  leased VM (with its deadline), the project's cap and contradictory `os`/`image` refused; a legacy VM refused at once
  to a project with an image list (never queued); the VM's own OS when `os` is left out, plain acquires still Windows;
  with `wait: true`, the release granting it, an earlier unnamed waiter served first, and a later one served past a
  named waiter, which never falls back; the named VM's states (quarantined, being created or removed, its evaluation's
  last hour, gone) said without throwing; and, through `server.js`, no acquire sent to a helper without `named`.
- `runs.test.js`, runs started then polled: a run spanning many polls; one that finished before its start could read
  its creation time (finished, not a failed start); a timeout killed by PID, and a reused PID never killed; failed polls
  retried within the one deadline; nothing sent to the guest once the lease ends. And `hv.ps1`'s own kill, run with
  Windows PowerShell 5.1 on this machine's processes: the run's own process killed and confirmed, a process with
  another creation time or no recorded identity never killed, one already gone reported gone.
- `approvals.test.js`:
  - unapproved plans;
  - forged approvals: another digest, operation or epoch, expired, a malformed nonce, another plan's id, a writable
    folder;
  - a plan changed after approval; single use; opaque plan ids;
  - the policy as the hard limit, even with a forged plan;
  - one pool job at a time; remove against a leased VM; acquire racing remove;
  - quiesce and its purposes. Uninstall `-RemovePool` end to end (quiesce, plan, approve, remove: only that change
    allowed), and interrupted mid-remove, then run again.
- `recovery.test.js`:
  - the helper crashing before and after each side effect of a create, a remove and a switch change (ten points in a
    create), then restarting: everything rolled back or completed, and nothing that merely shares a name adopted;
  - a restart restores every VM and voids every lease;
  - the switch, by id or token only:
    - a foreign switch with its name survives a failed create, a crash and recovery;
    - an unjournalled switch of ours is found by its token;
    - a same-named replacement is refused at start.
- `server.test.js`: `server.js` over stdio in direct mode:
  - the tools and the kill switch;
  - a build copied in, with links skipped, then read back, including images;
  - builds outside the roots, through a junction, or in the profile, refused;
  - build folders set by an admin: used with no client roots and beside other roots; a root that is a junction, in
    `AppData\Roaming` or missing isn't used; a junction out of one, and a folder outside both, refused; a helper from
    before them;
  - pool tools without approval;
  - the lease ending when the server exits;
  - service mode without the helper.
- `host.test.js`: `HvMcpHost.cs` compiled with the in-box `csc.exe` and run in console mode, with `server.js` over the
  real pipe:
  - the helper killed mid-run: its run's child (by its recorded PID) dies with the job object, the client is told, and
    the respawned helper restores the VM before the pipe reopens;
  - the host killed: its helper dies too;
  - a pipe name already taken is refused;
  - a client can't forge framing, and an over-long line closes only that connection;
  - a `vm_sync` of 18000 files (a 4.6 MB manifest) through the real pipe: batched, the warm session and its lease
    intact.

- `linux-image.test.js` (MC-1501):
  - the qcow2 reader and its VHD, read back exactly (data, compressed, zero and unallocated clusters, version 2, odd
    sizes), and every refusal;
  - `linux-images.prepare` with the user's own file (MC-1572): any qcow2 copied while hashed, converted and recorded
    with its path; a relative path, a folder, the helper's own folders and a non-qcow2 file refused; the guest's
    report compared only with an image recorded with a distro.
- `linux-guest-files.test.js`:
  - the helper's ed25519 keys read by Windows' own ssh-keygen;
  - the seed for each transport;
  - the dispatcher run for real (`guest_py_check.py`, real symlinks) under a Linux Python, which needs WSL with python3
    or `HYPERV_TEST_LINUX_PYTHON`. It's skipped, and says so, where there's none: the trial runs it inside a Linux VM;
  - the dispatcher's run files and the build's finish executed on any host Python 3, Windows' included
    (`guest_unit_check.py`, MC-1551). systemd, accounts and process calls are mocked, and files go to a temp folder.
    It checks the files' flags, modes and owners for admin and user runs, that start and poll name the same files,
    capped output, and the cached seed removed with links unfollowed. `HYPERV_TEST_PYTHON` picks the Python; the test
    is skipped where there's none.
- `linux.test.js`, through the stub guest (`stub-guest.js`, in place of `ssh.exe`):
  - the build, step by step: no private key anywhere but the secrets folder, allowlisted diagnostics, no seed or COM
    port left;
  - builds that fail: conclusive, inconclusive and failed checks, each rolled back with no other transport tried;
  - a Windows and a Linux lease at once;
  - a Linux lease through `server.js`: build, runs, refusals, read-out, sync, reset and release;
  - a timeout killed by its unit; a lease checkpoint taken Off;
  - the helper killed mid-run and recovered;
  - pool checkpoints and refresh-clean on Linux, and the feature gate;
  - a host-mode run, its address set by the helper's own script, and a checkpoint restart after the pool's mode was
    lowered, which goes on with network `none`.
- `linux-ps.test.js`: hv.ps1's Linux actions run for real under Windows PowerShell 5.1 and PowerShell 7 each (the
  service runs hv.ps1 under the one setup ran in; `restorewait.test.js`'s `$RestoreTo` and `checkpoints.test.js`'s
  `$JobsIdle`, its other host-side blocks, run under each too), with the Hyper-V cmdlets
  mocked:
  - `com-attach` and `com-detach` (the exact `\\.\pipe\<name>` path, read back) and `vhd-convert`'s path checks;
  - `com-read` on a real named pipe: a quiet spell longer than its wait, a line split across writes, the pipe coming
    back after a guest restart, 64 KB without a newline, and a silent guest until the deadline.
- `bridge.test.js` (MC-1549): the real in-box `ssh.exe` with a test build of `HvMcpVsock.exe` as its ProxyCommand
  (compiled with `HVMCP_TEST`, TCP to a local fake SSH server instead of a VM). The client's KEXINIT and ECDH init reach
  the server, and the bridge's byte counts show it. The build setup ships has no TCP mode. ssh runs in the kill-on-close
  job of `jobrun.exe`.
- `network.test.js` (MC-1556), the network modes:
  - the rules: the modes' order and caps, each mode's port ACLs, the host-mode checks (switch by id, the host's
    address, subnet clashes), guest address allocation, the guest read-backs, the Linux scripts, the policy;
  - plans: the mode in every create and resize (default `none`), the policy's cap, a network-only resize, the kept
    VMs' sizes, the journal record, no host network or no Default Switch;
  - runs in each mode: the switch, the ACLs added and read back before the connect, the guest's network read back
    until steady; refused above the pool's mode, also after it's lowered; fail-closed when the ACLs don't read back, a
    host check fails, or the guest's network never settles (restored to clean, disconnected);
  - crashes after the ACLs, the connect and the guest's network, and a call dying between connect and start: the next
    helper restores the VM disconnected with no ACLs; leftover ACLs at a release quarantine the VM.
- `guestnet.test.js` (MC-1563, MC-1565): hv.ps1's own `$GuestNet` (a Windows guest's network for a mode) run with
  Windows PowerShell 5.1 against stub network cmdlets that return real CimInstances and keep each adapter's DHCP state,
  addresses and default route:
  - host and internet set exactly the one adapter with the VM's MAC, also among other adapters;
  - none or two adapters with that MAC are refused with nothing changed;
  - internet leaves an adapter already on DHCP alone (no `Set-NetIPInterface -Dhcp`, which drops its lease, and no
    route removed: DHCP's default route is NetMgmt too), asks for a lease (`RenewDHCPLease`) when it has no DHCP
    address (APIPA), and puts a static adapter back on DHCP first;
  - none puts only adapters that aren't on DHCP back on it.

  Every network and CIM cmdlet name in the block is renamed to a stub before it runs, and the test refuses to run on one
  it doesn't stub or on a call to ipconfig or netsh, so nothing reaches the PC's real network settings.
- `timing.test.js` (MC-1558): the timings' defaults, floors, caps and derived call bounds; an invalid `timingCaps`
  refusing the start; values per connection, kept by a lease through its cleanup after a disconnect and by a pool job,
  defaults for recovery, the queue place's, what server.js sends; the restore call holding the off-wait; a Windows copy
  in parts, past one call's bound, stalled, resumed and cancelled; guest-setup retried once after a timeout or a lost
  connection and never after another error, at build and at refresh; and no literal waits in the test files, which all
  read `test\timing.json`. MC-1566: the guest network's wait (`networkSeconds`) as a timing like the others, and on a
  fake clock: accepted as soon as the read-back holds, given up at the lease's own ceiling with the setting named.
- `uninstall.test.js` (MC-1557), removing everything without agents:
  - the recorded inventory: its label, each item's manual step (a quote in a path doubled), what's out of scope; the
    helper writing it at start and rewriting it after a create, resize and remove, never torn;
  - setup copying the uninstaller's files and writing the entry, and clearing a kept-pool mark;
  - the Installed apps entry, run for real under Windows PowerShell 5.1 and PowerShell 7 each (the entry names its
    engine by full path, found from HKLM; fake registrations test the choice) as Windows runs an UninstallString, with a
    scratch Program Files and HKCU keys (`test\appsentry-check.ps1`): the uninstaller launched while its files are
    whole; every partial set of its last files, an empty `uninstall.retiring\` and an empty install folder finished by
    the launcher alone; the entry removed when nothing is left, or on a verified kept-pool mark; refusals (an extra
    file or folder, a junction, an untrusted owner, a service still installed, the state folder, an unfinished
    uninstall, an entry that isn't setup's, a missing or other install's mark), each with everything left in place; an
    InstallLocation pointing elsewhere never a target; the last phase crashed after its rename and after removing the
    rest, each finished by relaunching the entry; a junction for `uninstall\` refused; the protected temporary copy, and an interrupted run's copy
    removed later only when it is exactly one (not the current run's, one in use, a link, another owner, a looser ACL or
    extra contents);
  - nothing run unless trusted: a complete set behind a junction (either folder), a folder or file others may write,
    an extra file in the set, each refused with no script run;
  - the uninstaller's top level (`Invoke-UninstallFlow`) with a fake world: remove, keep (the mark after the check,
    before the retire), the menu (remove, list, cancel); interrupted after the teardown, before and after the switch's
    removal and before the retire, each rerun removing the switch, checking, then retiring; a leftover keeping the
    route; `-WhatIf` changing nothing on every path, `-Retire -WhatIf` included; a remove after a finished keep refused.

**The trial** on a real host (not automated): setup, then `pool_plan` → approval → `pool_create` from the Windows 11
Enterprise evaluation 25H2 ISO, then:
- two VMs running at once, each restoring cleanly;
- a run killed mid-way and recovered (the server, the helper and the host each killed in turn);
- a sentinel written in one run and absent in the next, including after a keep and a guest shutdown;
- an interactive start, then a program that makes its own desktop and starts a child on it: it passes with
  `session: 'interactive'` and still fails in session 0;
- `C:\build` read-only for the user, and the host's build unchanged after the guest admin writes there;
- uninstall `-KeepPool`, then setup again, which recognises the pool;
- Linux (MC-1501, with the Assistant's go):
  - a Debian and an Ubuntu VM built beside the Windows ones, each build's diagnostics showing hv_sock;
  - a build and its tests run in a Linux VM and a Windows VM at once;
  - `vm_sync`, `vm_checkpoint`, `vm_restore`, `vm_reset` and a pool checkpoint;
  - `guest_py_check.py` run inside the Linux VM, as `hvuser`;
  - the confinement checks: no address, no listener, the forced command refusing a shell, no key an agent can read.

Test scratch goes to `HYPERV_TEST_SCRATCH` (default `%LOCALAPPDATA%\combwork-mcp-tests\hyperv-mcp-tests`), never the
repo, and `npm test` clears earlier runs' folders first.

- `nested-proof.test.js` (MC-1559): the nested live proof's driver, offline, with a fake outer VM:
  - the identity guard before every remote change and the cleanup, a mismatch stopping the run; the cleanup read back,
    never claimed when unverified; pool VM names in the helper's real format;
  - pinned SSH;
  - the exact ACL sets;
  - bounded, validated probes;
  - verdicts: a negative passes only with its positive controls, else it is unclaimed;
  - the 18081 firewall check;
  - the refusals;
  - every PowerShell script it sends, parsed by Windows PowerShell's parser.

### Live proof in a nested VM

`test\live\nested-proof.js` proves the merged code on a real Hyper-V host **without touching this PC's installed
helper or pool** (MC-1559; MC-1560 and MC-1561 reuse it). It runs inside one hand-made VM, `hvnest-proof`, with nested
virtualization: setup, the service, approvals, pools, the network modes and (later) the uninstaller, all inside that
VM.

**What it proves:** the merged code, end to end, on an isolated Windows host that is slower than this PC.
**What it doesn't prove:** this PC's own installed service after an upgrade, which gets a short check at the upgrade.

**Pool VMs can't be used.** The tools can't expose virtualization extensions on them, and a lease restores them to
clean. A separate VM also has its own lifetime and leaves the pool alone.

**Who runs what.** The user runs every host line in an admin PowerShell (Windows PowerShell or PowerShell 7), and every in-VM line in the VM's
console. The driver runs on the host as the user, with no admin rights. It only uses `ssh` and `scp` to the VM, and
never acts on this PC's Hyper-V.

**Before each change** (deploy, setup, each approval, each pool change, the listeners, the firewall rule, the matrix),
it checks the target is the VM:
- the guest's BIOS GUID equals the one in `C:\hvnest-proof\identity.txt` on the host (written by H1);
- the guest's marker holds the same GUID, and the token the user copied from V1;
- the model is `Virtual Machine` and the name is `HVNEST-PROOF`.

SSH only accepts the host key pinned from V2's output (`StrictHostKeyChecking=yes`, its own `known_hosts`). Logs go to
`%USERPROFILE%\hvnest-proof-logs\<run>\` as each call returns. They hold the target's identity, the commit, and each
command with its exit code and output, outside every folder the uninstaller removes.

**Resources:**
- the outer VM: 6 vCPUs, 16 GB static memory, a 200 GB dynamic disk in `C:\hvnest-proof`;
- inside it, one Windows VM (2 vCPUs, 4 GB, 64 GB) and one Debian VM (2 vCPUs, 2 GB, 64 GB).

H1 refuses with under 20 GB of host memory free. Start it when the pool is quiet; don't shrink the pool for it.

**H1, create the VM** (one line; set `$iso` to the Windows 11 Enterprise evaluation ISO). Every check runs first and
stops it, nothing created, if it fails. The VM's id goes into `identity.txt` right after `New-VM`.
```
$ErrorActionPreference='Stop'; $iso='<ISO>'; $d='C:\hvnest-proof'; $o=Get-CimInstance Win32_OperatingSystem; if ([int]$o.BuildNumber -lt 22621) { throw "host build $($o.BuildNumber) < 22621: nothing created" }; if ($o.FreePhysicalMemory/1MB -lt 20) { throw ("only {0:N1} GB free (need 20): nothing created" -f ($o.FreePhysicalMemory/1MB)) }; $ver=(Get-VMHostSupportedVersion -Default).Version; if ($ver -lt [version]'9.3') { throw "VM configuration version $ver < 9.3: nothing created" }; if (-not (Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue)) { throw 'no Default Switch: nothing created' }; if (Get-VM -Name hvnest-proof -ErrorAction SilentlyContinue) { throw 'a VM named hvnest-proof exists: nothing created' }; if (Test-Path -LiteralPath $d) { throw "$d exists: nothing created" }; if (-not (Test-Path -LiteralPath $iso -PathType Leaf)) { throw "no ISO at ${iso}: nothing created" }; if ((Get-PSDrive C).Free -lt 250GB) { throw 'under 250 GB free on C: nothing created' }; New-Item -ItemType Directory $d | Out-Null; $vm=New-VM -Name hvnest-proof -Generation 2 -Version $ver -MemoryStartupBytes 16GB -NewVHDPath "$d\hvnest-proof.vhdx" -NewVHDSizeBytes 200GB -Path $d -SwitchName 'Default Switch'; "vmId=$($vm.Id)`nfolder=$d" | Set-Content "$d\identity.txt"; Set-VM -VM $vm -ProcessorCount 6 -StaticMemory -AutomaticCheckpointsEnabled $false; Set-VMProcessor -VM $vm -ExposeVirtualizationExtensions $true; Set-VMKeyProtector -VM $vm -NewLocalKeyProtector; Enable-VMTPM -VM $vm; $dvd=Add-VMDvdDrive -VM $vm -Path $iso -Passthru; Set-VMFirmware -VM $vm -FirstBootDevice $dvd -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows; $bios=(Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemSettingData -Filter "VirtualSystemIdentifier='$($vm.Id)' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'").BIOSGUID.Trim('{}').ToLower(); Add-Content "$d\identity.txt" "biosGuid=$bios"; Get-Content "$d\identity.txt"; Start-VM $vm
```
**If H1 stops part-way:**
- `identity.txt` has a `vmId=` line: run H9a to see what exists, then H9b and H9c.
- It doesn't: run `Get-ChildItem -LiteralPath C:\hvnest-proof -Force` and `Get-VM -Name hvnest-proof` and stop there.
  Clean up by hand only what they show. Nothing here widens a deletion to fit.

**H2, install Windows** over the VM's console:
- a local admin account `proofadmin` ("Domain join instead");
- then a standard account `proofuser`, signed in once so its profile exists.

**V1** (in the VM, admin Windows PowerShell): renames it, turns on Hyper-V and OpenSSH, writes the marker, restarts.
```
$ErrorActionPreference='Stop'; Rename-Computer -NewName hvnest-proof; Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All -NoRestart; Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0; Set-Service sshd -StartupType Automatic; New-Item -ItemType Directory C:\ProgramData\hvnest-proof -Force | Out-Null; @{ biosGuid=(Get-CimInstance Win32_ComputerSystemProduct).UUID.Trim('{}').ToLower(); token=[guid]::NewGuid().Guid } | ConvertTo-Json | Set-Content C:\ProgramData\hvnest-proof\identity.json; Get-Content C:\ProgramData\hvnest-proof\identity.json; Restart-Computer
```
**Keys, on the host (no admin):** `node test\live\nested-proof.js keys` makes one key per account in
`%USERPROFILE%\.ssh\hvnest-proof\` and prints their public halves for V2.

**V2** (after the restart; the two public keys pasted in): adds the keys and starts sshd. It prints the marker and the
host key: copy them back.
```
$ErrorActionPreference='Stop'; if ($env:COMPUTERNAME -ne 'HVNEST-PROOF') { throw 'not renamed: rerun V1' }; Set-Content C:\ProgramData\ssh\administrators_authorized_keys '<key-admin>'; icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'; $p='C:\Users\proofuser\.ssh'; New-Item -ItemType Directory $p -Force | Out-Null; Set-Content "$p\authorized_keys" '<key-user>'; icacls "$p\authorized_keys" /inheritance:r /grant 'proofuser:F' /grant 'SYSTEM:F'; Start-Service sshd; Get-NetFirewallRule -Name OpenSSH-Server-In-TCP | Select Enabled,Profile; Get-Content C:\ProgramData\hvnest-proof\identity.json; Get-Content C:\ProgramData\ssh\ssh_host_ed25519_key.pub
```
**Then, on the host:**
1. `nested-proof.js pin "<the host key line>"`.
2. Write `%USERPROFILE%\.ssh\hvnest-proof\proof.json`:
   ```
   { "address": "hvnest-proof.mshome.net", "token": "<V1's token>", "lan": { "ip": "192.168.1.1", "port": 80 } }
   ```
   The address is the Default Switch's name for the VM, or its IP from the console. The LAN endpoint is one the user
   agrees on; it must answer from the VM itself.

**Inside the VM, with the user's permission for that VM only**, the driver runs these in order:
- `preflight` (read-only: elevation, Hyper-V, the Default Switch, a clash with 10.137.42.0/24, node, free space);
- `install-node <node-vX.Y.Z-x64.msi>` (downloaded from nodejs.org on the host; installed only if Authenticode-valid
  and signed by the OpenJS Foundation) and `upload <the Windows ISO>`, each checked by SHA-256;
- `deploy` (a `git archive` of a commit, checked by SHA-256);
- `setup --max-network InternetLan`, by the user's own line (`install.cmd`). For the PowerShell 7 proof (MC-1575):
  `install-pwsh <PowerShell-X.Y.Z-win-x64.msi>` (from Microsoft's GitHub releases; installed only if Authenticode-valid
  and signed by Microsoft), then `setup --max-network InternetLan --engine 7`, after which the service runs `hv.ps1`
  under PowerShell 7 (the setup output's `engine:` line says which);
- `call pool_plan ...` with `approve <plan>`, which types the digest approve.ps1 shows (through the user's
  `approve.cmd` line); then `call pool_create ...`
  for one Windows VM and one Debian VM, at pool network `internet-lan`. If approve.ps1 can't read the digest over SSH,
  or the user prefers it, the user runs the approve line in the VM's console instead;
- `matrix`;
- `refusal ...`;
- `cleanup`.

**The matrix:**
- **Listeners:** the driver starts node listeners (`nested-listener.js`) on the VM's host-mode address, ports 18080
  and 18081, and records each pid and start time. It starts them through WMI (`Win32_Process.Create`), because
  Windows' sshd kills a session's processes when the session ends. A later session then confirms the listener still
  runs and listens on both ports, and the VM reaches both itself; otherwise the run stops before any guest. It adds the
  one firewall rule, for 18080, in the VM. Afterwards it
  checks the VM's identity again, stops the listeners (only that pid with that start time) and removes the rule by its
  exact name, then reads both back. If the identity can't be confirmed, or the readback still shows either, it changes
  nothing more, says **CLEANUP NOT VERIFIED** with the lines to remove them by hand, and exits non-zero. `cleanup` on
  its own does the same.
- **Controls:** the VM's own reach (both listeners locally, the LAN endpoint, 1.1.1.1:443 and an HTTPS page) is every
  target's positive control.
- **Probes:** each guest probes in each mode, with bounded probes:
  - Windows: `TcpClient.ConnectAsync(...).Wait(5000)` and `Invoke-WebRequest -TimeoutSec 15`;
  - Debian: `timeout 5 bash -c '</dev/tcp/...'` and python3 `urlopen(timeout=15)`.

  Each records its destination address and result. An HTTPS probe tries twice, recording both attempts: a reach on
  either counts, and a block needs both to fail.
- **Verdicts:**
  - A positive row that missed while the VM itself couldn't reach that target is unclaimed, not failed.
  - A negative row passes only when its probe failed, the VM itself reached the target, and the same guest reached
    it in its control mode (host for 18080; internet-lan for the LAN, internet and HTTPS).
  - 18081's control is the VM's own connection. An allow rule that could cover 18081, or a profile that doesn't
    block, leaves its rows unclaimed.
  - IPv6 is always unclaimed (no working control here): the Deny ::/0 rules are recorded.
  - A row is never passed on a guess.
- **ACLs:** `Get-VMNetworkAdapterAcl` reads back the exact set for each mode, and none, disconnected, after `vm_stop`
  and after `vm_release`.
- **Refusals:** `refusal <os> <mode> pool|policy` passes only when the run is refused for that cap.

Results go to `results.md` and `results.json` beside the log.

**At the end** (host, admin), H9a to H9c, each run separately:
- **H9a**, read-only, shows what will go:
  ```
  $id=(Select-String -LiteralPath C:\hvnest-proof\identity.txt -Pattern '^vmId=').Line.Substring(5); $vm=Get-VM -Id $id; $vm | Select Name,Id,State,Path,ConfigurationLocation; Get-VMHardDiskDrive -VM $vm | Select Path; Get-ChildItem -LiteralPath C:\hvnest-proof -Recurse -Force | Select FullName,Length
  ```
- **H9b** removes the VM by id, only if its name, folder and disks are where H1 put them. `New-VM -Path C:\hvnest-proof`
  puts the VM's own files in a subfolder named after it, so its `Path` and `ConfigurationLocation` are
  `C:\hvnest-proof\hvnest-proof` (the check also accepts `C:\hvnest-proof` itself, as the run on 19 Nov did); its disk
  stays `C:\hvnest-proof\hvnest-proof.vhdx`, as H1 named it:
  ```
  $ErrorActionPreference='Stop'; $id=(Select-String -LiteralPath C:\hvnest-proof\identity.txt -Pattern '^vmId=').Line.Substring(5); $vm=Get-VM -Id $id; $ok='C:\hvnest-proof','C:\hvnest-proof\hvnest-proof'; if ($vm.Name -ne 'hvnest-proof' -or $vm.Path.TrimEnd('\') -notin $ok -or $vm.ConfigurationLocation.TrimEnd('\') -notin $ok -or @(Get-VMHardDiskDrive -VM $vm | ? { $_.Path -notlike 'C:\hvnest-proof\*' }).Count) { throw 'identity or location mismatch: nothing removed' }; Stop-VM -VM $vm -TurnOff -Force; Remove-VM -VM $vm -Force
  ```
- **H9c** deletes the fixed folder, once the listing was read and the VM is gone:
  ```
  $ErrorActionPreference='Stop'; if (Get-VM | ? { $_.Path -like 'C:\hvnest-proof*' }) { throw 'a VM still lives in C:\hvnest-proof: nothing deleted' }; Remove-Item -LiteralPath C:\hvnest-proof -Recurse -Force
  ```

Then delete `%USERPROFILE%\.ssh\hvnest-proof\`. No host firewall rule, switch or service was changed.

## Files

- `server.js`: the MCP server. `roots.js` is a copy of the repo's [`shared/roots.js`](../../shared/roots.js), and
  `client.js` is a small stdio client for scripts and the tests.
- `helper\`: the helper, installed by setup into `%ProgramFiles%\hyperv-mcp`:
  - `helper.js` (its entry under the host), `core.js` (the rules), `journal.js`, `policy.js`, `images.js`, `iso.js`,
    `unattend.js`, `paths.js`;
  - Linux guests (MC-1501): `guests\linux.js` (the guest driver), `linux-images.js` (the user's qcow2, copied while
    hashed), `qcow2.js` (the converter), `seed.js` (the cloud-init seed), `sshkeys.js`, `ssh.js` (the
    transport), `guest.py` (the guest's dispatcher), and `host\HvMcpVsock.cs` (the Hyper-V socket bridge, compiled by setup);
  - `hv.js` and `hv.ps1` (the only way it acts on Hyper-V), `guest-sync.ps1` (the guest side of `vm_sync`) and
    `guest-agent.ps1` (the interactive session's watcher), each run in the guest by `hv.ps1`;
  - `approve.ps1`, and `approve.cmd`, its one-line launcher for any terminal (MC-1575);
  - `host\HvMcpHost.cs` (the service host's source).
- `setup\install.ps1`, `setup\uninstall.ps1`: the only elevated steps besides approvals, each run by its launcher
  (`install.cmd`, `uninstall.cmd`; setup installs `uninstall.cmd` beside `approve.cmd`). `setup\teardown.ps1` is
  uninstall's teardown, and `setup\appsentry.ps1` the Installed apps entry, its launcher and the last phase (MC-1557);
  setup copies `uninstall.ps1`, `teardown.ps1`, `acl.ps1`, `appsentry.ps1` and `Storage.cs` into
  `%ProgramFiles%\hyperv-mcp\uninstall`. `helper\inventory.js` renders the helper's recorded inventory. `helper\timing.js` holds the timings' keys, defaults, ranges and caps (MC-1558). `setup\acl.ps1` holds
  setup's storage and ACL routines, with `setup\Storage.cs` for the Windows calls they need (both tested non-elevated
  by `test\acl-check.ps1`).
- `test\live\`: the nested live proof (MC-1559, "Live proof in a nested VM"). `nested-proof.js` is the host-side
  driver (ssh and scp only); `nested-inner.js` bridges it to one server.js session inside the outer VM;
  `nested-listener.js` is the host-mode test listener. Dev-only: not packed.
