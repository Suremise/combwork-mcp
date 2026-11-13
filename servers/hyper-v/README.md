# hyper-v

An MCP server that gives agents **disposable Hyper-V test VMs** from a pool. An agent leases a VM, starts it from its
clean checkpoint with a build copied in, runs commands and gets their output, reads files back from one folder, and
stops it, which restores it. Several agents can each hold a VM at the same time. Optionally, a run can have its own
reserved CPU, for timed runs. For a work session, an agent can instead keep its VM running: `vm_sync` copies only the
files that changed into it, `vm_reset` gives a clean VM again on request, and `vm_renew` extends the lease within the
policy. Release still restores it. Commands run in session 0 by default. For programs that need a real logged-on desktop
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
- A **Windows 11 Enterprise evaluation ISO** for the pool's VMs (see "The image").
- Disk space: about 40 GB per VM, plus the ISO (7 GB).

## Safety at a glance

| The server (its helper) can | It can't |
|---|---|
| Act on VMs it created: names start with the pool prefix (`hvmcp-`) **and** the VM id is in its journal **and** the VM is in its own folder. All three are checked, twice: in the helper and again in `hv.ps1`. | Touch any other VM, checkpoint, disk or switch: start, stop, change, delete or even name it. A VM renamed into the prefix still doesn't match an id. |
| Create VMs, disks and one internal switch, **only** from a plan the user approved in an elevated prompt, and **within the policy** setup wrote (max VMs, cores per VM, total memory, disk per VM, disk folders, networking allowed). | Exceed the policy, whatever a plan or an approval says. Create an external switch or a NAT, or change any host setting: Hyper-V's settings, other switches, the firewall, Defender, features or services. |
| Write only to its state folder (`%ProgramData%\hyperv-mcp`: the journal, plans, per-run staging under `runs\`, guest credentials) and the disk folders named at setup. | Write anywhere else on the host. Files read back from a guest are returned as data, never written to the host. |
| Copy a build into a VM: the files of a folder that resolves, by real path, under your MCP roots or a build folder an admin named at setup, **copied** to `C:\build`. | Share or map any host folder into a guest: the guest never sees a live host path, so it can't change your files. Copy a build from outside your roots and the admin's build folders, or from your profile itself, its dot-folders (`~/.ssh`, `~/.claude`, …), `AppData` or its top folders, or anything under `AppData\Roaming`. Follow a link or junction in the build (they're skipped and named). |
| Connect one VM to the pool's **internal** switch for one run, only when `vm_start` asks (`network: true`) and the policy allows it. | Give a guest the internet or your LAN. It's off by default: the adapter is disconnected, and the restore at stop puts it back. |
| Reserve CPU for one run (`reserveCpu`, a percentage of the VM's cores), up to the policy's cap; reset at stop. | Reserve beyond the cap, or change a VM's CPU outside a run. |
| Restore the clean checkpoint **by id** before every start, unconditionally, and at every stop and release, then check that the VM is Off, at that checkpoint, disconnected, with no reserve. Keep a VM unrestored for inspection **only when asked**, until its lease ends. | Start a VM from anything but the clean checkpoint, or let one lease's changes reach the next. A VM that can't be confirmed clean is **quarantined**: never leased until a restore confirms it. |
| Keep a leased VM running for a **work session**: several runs in one guest, with `vm_sync` copying changed files into its `C:\build` (no restore between them), and the lease renewed up to the policy's `maxLeaseMinutes` at a time and `maxSessionMinutes` in all. | Carry anything past the lease: release, the deadline and the session's connection closing all restore and verify it as above. Write anywhere in the guest but `C:\build` and its own staging folder when syncing, or follow a link or junction there. |
| Run commands in a leased guest over PowerShell Direct, as its admin or its standard user, with passwords only the helper holds. On request, log one of those accounts on in the guest (autologon, then a guest restart) and run commands in its desktop session through a watcher started at logon (`hvuser` as a standard user, or `hvadmin` elevated); a run there that doesn't finish cleanly restores the VM. | Run any program on the host except `powershell.exe` with its own fixed script (and `node` for itself). An agent's text never reaches a host command line or script: it's passed as JSON on stdin and arrives in the guest as data. Leave a logon behind: autologon and its password live only inside the guest, and the next restore of the clean checkpoint removes them. |
| Download the evaluation ISO over HTTPS from a `microsoft.com` host, and check an ISO before anything runs it (see "The image"). | Use an image that fails its checks, or a local ISO that isn't a known Microsoft image, unless setup allowed that and the user approved it as "not authenticated". |

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

1. Turn on Hyper-V (see Requirements), and check `Get-Service vmms` says Running.
2. In an **admin PowerShell**, run setup once (one line). Name a folder for the VMs' disks on a drive with room:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\combwork-mcp\servers\hyper-v\setup\install.ps1" -DiskFolder D:\hyperv-mcp
   ```
   Run it with **Windows PowerShell 5.1** (`powershell`, as above), never PowerShell 7 (`pwsh`): setup's storage and ACL
   routines need .NET Framework. Started from PowerShell 7, setup (and `uninstall.ps1` and `approve.ps1`) stops before
   checking or changing anything, and prints the 5.1 line to run instead: run it with the same arguments.
   It reports each step and can be run again (to update the helper or change the policy). It installs:
   - the helper's code, `approve.ps1` and the service host (compiled there by the in-box .NET Framework compiler) in
     `%ProgramFiles%\hyperv-mcp`;
   - the service `HyperVMcp` on its virtual account `NT SERVICE\HyperVMcp`, which it adds to Hyper-V Administrators.
     The service is restarted after a failure (3 times a day, then left stopped);
   - the local group **Hyper-V MCP Users**, with you in it (`-User` to name someone else). Its members may open the
     helper's pipe. Your own account is also given the pipe directly, so you needn't sign in again. Other users you
     add to the group later must sign in again before their membership counts;
   - `%ProgramData%\hyperv-mcp` (the helper's state) and the disk folder, both readable only by SYSTEM,
     Administrators and the service. `policy.json` and `approvals\` in there are writable only by Administrators and
     SYSTEM. How setup makes them trustworthy is under "Storage" below;
   - `policy.json`, the pool's hard limits. By default they're derived from the host: up to a quarter of its logical
     CPUs per VM (at most 8), half its memory in all, up to 4 VMs, 128 GB disks, networking allowed (internal switch
     only), unpinned ISOs refused. Override any of them: `-MaxVms`, `-MaxCoresPerVm`, `-MaxMemoryGB`,
     `-MaxDiskGBPerVm`, `-AllowNetwork $false`, `-MaxReservePercent`, `-MaxLeaseMinutes`, `-MaxSessionMinutes`
     (a work session's cap for `vm_renew`: 5-1440 and at least `-MaxLeaseMinutes`; left out, 480 or
     `-MaxLeaseMinutes` if that is more), `-MaxBuildMB`, `-AllowUnpinnedIso`. `-BuildRoot` names folders builds may also
     come from (see "Build folders set by an admin"). `-ProjectsFile` names the projects that share the pool fairly (see
     "Sharing the pool between projects").

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
([this one](combwork-mcp.example.json)). Run setup from the unpacked folder's `setup\install.ps1`, then turn the server
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
   policy. It proposes the exact plan: VM names, cores, static memory, disk size and folder, the switch (only if you
   asked for networking) and the image. The plan changes nothing. The first plan also checks the image, which takes a
   few minutes (see "The image"); the agent then plans again.
2. **Approve.** The plan's reply holds one line for **you** to run in an **admin PowerShell** (one UAC prompt):
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\hyperv-mcp\approve.ps1" -Plan p-0123456789abcdef
   ```
   Check that the path is `C:\Program Files\hyperv-mcp\approve.ps1` before you run it.
   - It shows the plan from the helper's own record, never from the agent's text.
   - It asks for the first 6 characters of the plan's digest. That only confirms the plan on screen is the one you
     approve: it's not a password.
   - It writes a single-use approval that expires within 30 minutes and holds only for that exact plan.
3. **Change.** The agent calls `pool_create` (or `pool_resize`, `pool_remove`) with the plan id. The helper checks the
   approval and the policy again, then runs the change in the background (`pool_status` shows it). Creating a VM
   installs Windows unattended, with no network:
   - about 20–40 minutes each, one VM at a time, so the host's CPU isn't flooded;
   - then the guest set-up, a sanity check of the installed edition and build, and the clean checkpoint, taken with the
     VM off.

**Rebuilding.** An evaluation install expires 90 days after it was made, and `pool_status` warns 14 days before. Plan
a `remove`, then a new `create` from a fresh image, each approved the same way. **Teardown** is the same `remove`, and
only VMs with no lease can be removed.

### The image

The pool is built from the **Windows 11 Enterprise evaluation** ISO. Microsoft's
[Evaluation Center](https://www.microsoft.com/evalcenter/evaluate-windows-11-enterprise) offers it.

- **What authenticates it is where its bytes came from, and only that:**
  - **Pinned:** a SHA-256 in the server's table of known images. Today that's the 25H2 image,
    `26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso`, 7,092,807,680
    bytes, SHA-256 `A61ADEAB895EF5A4DB436E0A7011C92A2FF17BB0357F58B13BBC4062E535E7B9`, downloaded over HTTPS from
    Microsoft's server. Microsoft doesn't publish SHA-256 values for its evaluation ISOs, so the table records ones
    downloaded from Microsoft.
  - **Downloaded by the helper:** `image: { download: "<URL>" }`, an `https` URL on a `microsoft.com` host (redirects
    too), with certificate checks on. TLS authenticates the server, and the hash is recorded for later rebuilds.
  - **A local file that isn't pinned:** refused, unless setup was run with `-AllowUnpinnedIso`. Its plan then says
    "NOT AUTHENTICATED: a local file you chose to trust", and approving it is your decision.
- **No swaps.** The ISO is copied into the helper's own folder **while it is hashed**, and only that copy is used.
- **Before anything runs it**, the helper reads the copy itself, without mounting it (a small bounded UDF reader):
  - `setup.exe` and `sources\setup.exe` must have valid Authenticode signatures from Microsoft Corporation, chaining to
    a Microsoft root (Root Certificate Authority 2010 or 2011, by thumbprint);
  - `sources\install.wim`'s metadata must name one x64 `EnterpriseEval` image, with the build the pin expects.

  These are **consistency checks**: `install.wim` has no signature of its own, so they don't authenticate its
  contents. The hash and where it came from do.
- After the install, the guest's own report of its edition and build is a sanity check only.

## Tools

| Tool | What it does |
|---|---|
| `vm_acquire({ minutes=60, keepOnFailure=false, wait=false, os='windows', image? })` | Leases one VM of that OS (and image, when given) to this session (one VM per session) until `vm_release`, its deadline (at most the policy's `maxLeaseMinutes`), or this server exiting. Without `wait`, it refuses when none is free for this session's project, saying why (none free, the project's cap, a VM kept for another project), when the next lease ends, and where it would stand in line. With `wait: true` it waits in line about 20 s, and a repeat call within 2 minutes keeps its place (see "Sharing the pool between projects"). |
| `vm_start({ build?, network=false, reserveCpu=0, interactive=false })` | Restores the clean checkpoint (always), applies this run's network and CPU reserve, and starts the VM. It waits for the guest, then copies `build` in to `C:\build` and leaves an empty `C:\out`. With `interactive: 'user'` (the standard user) or `'admin'`, it first logs that account on interactively: autologon, one guest restart (tens of seconds), then it waits for the account's desktop session (see "The interactive session"). Refused on a VM kept for inspection: release it, and acquire again. |
| `vm_renew({ minutes=60 })` | Sets the lease's deadline to now + `minutes` (1 to the policy's `maxLeaseMinutes`), never past the work session's end: `maxSessionMinutes` after `vm_acquire` (`vm_status` shows both). Refused once the deadline has passed, even a moment before the helper ends the lease. |
| `vm_sync({ build?, full=false, delete=true })` | Copies only the files that changed in `build` (default: the folder last started or synced) into the **running** guest's `C:\build`, without a restore: `C:\out`, installed software and anything else the runs left stay. The server hashes the folder (same roots checks as `vm_start`, every time; links skipped); the helper compares that with what it placed in `C:\build` and takes only the new or changed files, hashing them itself as they arrive. Files gone from the folder are removed unless `delete` is false. Only what the helper copied is tracked: if your runs changed `C:\build` themselves, use `full: true` (clears `C:\build`, copies everything) or `vm_reset`. After a sync fails, only those two are accepted. |
| `vm_reset({ build?, network?, reserveCpu?, interactive? })` | A clean VM now: exactly `vm_start` (restore first, verified), with this session's last start's `network`, `reserveCpu` and `interactive` and its last build unless given. |
| `vm_run({ command, shell='cmd'\|'powershell', as='admin'\|'user', timeoutSec=120, cwd='C:\build', session='service'\|'interactive' })` | Runs in the guest. stdout and stderr go to `C:\out\.run-<n>.*`, and the reply has the exit code and 16 KB of each. `as: 'user'` runs as the standard user, for whom `C:\build` is read-only. `session: 'service'` (the default) runs in session 0 over PowerShell Direct; on a timeout, the command is killed inside by its PID (`taskkill /T /F`). `session: 'interactive'` runs in the desktop session `vm_start`'s `interactive` logged on, as that account (`as` must name it), through a watcher started in that session at logon (`hvadmin` elevated, `hvuser` a standard user). If it times out or doesn't finish cleanly, its output so far is returned and the VM is restored, which ends everything it started; `vm_start` or `vm_reset` goes on. |
| `vm_read_out({ paths?, glob?, maxBytes=256 KB, maxTotalBytes=1 MB, base64=false })` | Files from the guest's `C:\out`, read in the guest and capped while reading, returned as data. Paths are relative and checked before the call (no `..`, drives, UNC or device paths, streams or device names). `glob` is matched against a listing. Links are skipped. With neither, it lists. Text as text, PNG/JPEG as images. Read before `vm_stop`, which discards them. |
| `vm_stop({ keep=false })` | Turns the VM off and restores the clean checkpoint, then **verifies** it: Off, at the checkpoint (by id), adapter disconnected, reserve 0. It says "Reverted" only then. Otherwise **CLEANUP FAILED**, and the VM is quarantined. The lease stays. `keep` (or a failed run with `keepOnFailure`) leaves it as it is until release or the deadline. |
| `vm_release()` | Restores the VM (as `vm_stop`) and ends the lease. |
| `vm_status()` | The pool, every lease, your VM, any pool job, the policy, and where builds may come from. Works with the server turned off. |
| `pool_plan({ action='create'\|'resize'\|'remove', vms?, cores?, memoryGB?, diskGB?, location?, network?, image? })` | Plans a pool change and changes nothing (see "Building the pool"). `image` is a new ISO to check, or a verified image's SHA-256: build from it, or resize only its group (see "A pool from more than one image"). |
| `pool_create` / `pool_resize` / `pool_remove({ planId })` | Carries out an approved plan in the background. |
| `pool_status()` | The pool, the image, and any job or image check in progress. |

The server's MCP instructions tell agents to use the pool tools only when the user asks, and never to run the approve
line themselves.

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
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\combwork-mcp\servers\hyper-v\setup\install.ps1" -DiskFolder D:\hyperv-mcp -BuildRoot "C:\Users\you\AppData\Local\app-builds"
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
so none of them takes every VM, in a JSON file given to setup (one line, in an admin Windows PowerShell):

```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\combwork-mcp\servers\hyper-v\setup\install.ps1" -DiskFolder D:\hyperv-mcp -ProjectsFile D:\hyperv-projects.json
```

```json
[
  { "name": "app", "folders": ["D:\\src\\app", "D:\\src\\app.worktrees"], "maxVms": 2, "reserveVms": 1,
    "buildRoots": ["C:\\Users\\you\\AppData\\Local\\app-builds"] },
  { "name": "tools", "folders": ["D:\\src\\tools", "D:\\src\\tools.worktrees"], "maxVms": 1, "reserveVms": 1 }
]
```

- **Which project a session is in:** the one whose `folders` hold its MCP roots (checkouts and worktrees). A session
  whose roots are in no project, in several, or that sends none (an older server) is in **other**, which has no cap and
  no reservation: it shares what nobody reserved. One project's folder may not be inside, around or the same as another's.
- **`maxVms`** caps how many VMs the project holds at once. **`reserveVms`** keeps that many for it: a free VM goes to
  another project (or other) only while the free ones still cover every other project's unmet reservation. Both are
  **per OS**: a number means Windows, or give one per OS, such as `{ "windows": 2, "linux": 1 }`; the reservations of an
  OS can't add up to more than the policy's VMs. A cap of 0 for an OS means the project may not use it.
- **`images`** (optional) lists the images the project may use, by SHA-256. Left out, it may use every image of the OSes
  it may use.
- **`buildRoots`** are build folders for that project alone (beside its sessions' own roots). `-BuildRoot`'s folders stay
  everyone's. To move a folder from everyone to one project, update the agents' servers first: an older server sends no
  roots, so it only ever sees `-BuildRoot`'s.
- **The line:** `vm_acquire` with `wait: true` joins one first-come line for the whole pool and waits about 20 s per call
  (under a client's 60 s tool timeout). A VM that comes free (a release, a lease's deadline, a quarantine cleared, a pool
  job finished) goes to the first waiter it's allowed to: a waiter its project's cap or another project's reservation
  blocks keeps its place, and later ones are served past it. A call that ends without a VM says where it stands, and its
  place is kept for 2 minutes: the next call resumes it. A VM goes only to a session that is waiting right then, never
  to one that stopped calling. A newer call from the same session takes over an older one, and closing the session
  leaves the line. Without `wait`, `vm_acquire` never jumps the line: waiting sessions are served first.
- A lease keeps the project it was granted for, whatever its session's roots say later.
- `vm_status` shows each project's VMs against its cap and reservation, the line in order (and why each waiter is
  waiting), and the session's own project.

### A pool from more than one image

A pool can hold VMs built from several verified images, and so of several kinds: today Windows; Linux joins as an image
kind through MC-1500's guest driver, with no change to the pool.
- **Each VM records its image and OS** at its create. A VM made before that is given the image of the approved plan that
  made it, which the helper still has; if that can't be proved, its image is **unknown** (`vm_status` says so). An
  unknown-image VM is Windows: it serves a plain Windows `vm_acquire`, but never a request for an exact image, and no
  image's group counts it. It's never guessed.
- **Groups:** `pool_plan({ action: 'create' | 'resize', image: '<SHA-256 or its first 12+ hex digits>', vms })` builds
  from that verified image, or sets that image's group of VMs to `vms` (adding from it, or removing its unleased VMs),
  leaving the others alone. A `resize` without an image is the whole pool, as before.
- **`vm_acquire({ os = 'windows', image? })`** takes only VMs of that OS, and of that image when given. A request for an
  OS or image the session's project may not use is refused at once, never put in line. A waiter is only ever given a VM
  of its own kind.
- **Shares by OS:** caps and reservations count VMs of the request's OS. A reservation is covered by any usable free VM
  of its OS: the image only narrows which one is taken.
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

Test-only:
- `HYPERV_MCP_PS_STUB`, `HYPERV_MCP_STUB_STATE`: a fake `hv.ps1`;
- `HYPERV_MCP_CRASH_AT`: crash injection;
- `HYPERV_MCP_STATE_DIR`;
- timing: `HYPERV_MCP_POLL_MS`, `HYPERV_MCP_READY_WAIT_MS`, `HYPERV_MCP_INSTALL_WAIT_MS`, `HYPERV_MCP_RETRY_MS`,
  `HYPERV_MCP_MINUTE_MS`, `HYPERV_MCP_LOGON_STABLE_MS`, `HYPERV_MCP_WAIT_MS`, `HYPERV_MCP_KEEP_MS`;
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

The helper stays at protocol 3 for these features because hyper-v 1.2.0's server asks for exactly hyperv-mcp/3 before an
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
  untouched and reported. A start with networking also connects to the switch by its id, never its name;
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
    (`helper\guest-agent.ps1`, copied to `C:\hvmcp\agent.ps1`) that an HKLM `Run` entry starts at logon, in that
    account's own session.
  - `C:\hvmcp` is made admin-only (Users may read and run), so no user can change the watcher or a wrapper it starts.
    `C:\hvmcp\user` is where the standard user's session-0 runs stage their scripts, and the watcher never runs anything
    from there. `C:\hvmcp\req` is where runs are requested, writable by the logged-on account so its watcher can take
    them.
  - Then the helper waits, as the lease's, for a new boot with the account's watcher in a session of 1 or more, seen
    twice 10 s apart on the same boot: the guest may restart once more by itself after an autologon. That's a readiness
    check, not a guarantee. A later restart just means the next run isn't taken, and the VM is restored (below).
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

## Uninstall

In an admin PowerShell (one line):
```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\path\to\combwork-mcp\servers\hyper-v\setup\uninstall.ps1" -KeepPool
```
Choose one:
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
to run while an uninstall is unfinished. A finished `-KeepPool` leaves no record, so a later setup and `-RemovePool`
work as usual.

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
- Windows guests only. The evaluation expires after 90 days (see "Rebuilding").
- A sync tracks only what the helper copied into `C:\build`. A run that changes `C:\build` itself isn't seen; a
  file renamed only in case on the host keeps its old spelling in the guest. `full: true` or `vm_reset` puts either
  right. State across a guest reboot within a session isn't specially kept (a reboot is the guest's own business).

## Tests

From the repo root, `npm test` runs everything below. Hyper-V is never touched: `hv.ps1` is replaced by
`test\stub-hv.js`, a fake Hyper-V that keeps VMs, checkpoints and guest files in JSON. Each test runs the real
`helper.js` as a child process, the way the service host does. From this folder:

```powershell
node --test test\units.test.js test\leases.test.js test\sessions.test.js test\guest-sync.test.js test\guest-agent.test.js test\interactive.test.js test\projects.test.js test\images.test.js test\approvals.test.js test\recovery.test.js test\server.test.js test\host.test.js
```

- `units.test.js`:
  - the UDF/WIM reader against real UDF images (made with the in-box IMAPI2 through `hv.ps1`), and malformed ones
    (truncated, corrupt checksums, byte flips, a missing or bad WIM);
  - the image checks: pinned, downloaded, local and unpinned, signatures, edition and architecture, the helper's own
    folders, download URLs;
  - the policy, the journal (a torn last line cut off, then reopen → append → reopen keeping every record),
    canonical plans, the answer file's escaping, the evaluation-expiry warning;
  - setup's storage and ACL routines themselves, non-elevated on temp folders and a test registry key
    (`test\acl-check.ps1`):
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
    (`test\teardown-check.ps1`):
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
  - setup, `uninstall.ps1` and `approve.ps1` under PowerShell 7 (where `pwsh` is installed) refused before anything
    else, saying to run them under 5.1 with the same arguments, and setup under 5.1 going on past that check;
  - setup's helper file list holding every helper file (and the zip the whole helper folder), and its
    `-MaxSessionMinutes` check agreeing with the helper's.
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
  password never in a reply, the journal or a log; and a helper that predates the protocol refused before anything
  runs.
- `projects.test.js`, sharing the pool: one shared pool with no projects; caps and a reservation (never given to another
  project or other); the line, first come first served, a capped waiter passed over keeping its place, an abandoned
  wait never given a VM and its place expiring, a repeat call keeping its place, a disconnect leaving it, a resize
  serving the next waiter, and a newer call superseding an older one (in-process); a lease keeping its project; which
  project a session is in; through `server.js`, a project's own build folder refused to others, and a newer helper
  still serving this server; setup's projects check under Windows PowerShell 5.1; the policy's rules for projects.
- `images.test.js`, a pool from more than one image (a stub "linux" kind, made only in the journal): groups by image
  (a resize adding to or taking from one image's VMs only); `vm_acquire` by OS and image, one VM per session; VMs made
  before images were recorded, recovered through their plans, or unknown when that can't be proved (a plain Windows
  acquire takes one, an exact image never does, a group resize leaves them alone); shares by OS and the image list (a
  project at its Windows cap still gets Linux, a Linux reservation kept, a forbidden OS or image refused, never queued);
  a reservation covered by any free VM of its OS; a waiter never given another kind; and, through `server.js`, no
  acquire at all sent to a helper without `images` for an image or Linux.
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

**The trial** on a real host (not automated): setup, then `pool_plan` → approval → `pool_create` from the pinned 25H2
ISO, then:
- two VMs running at once, each restoring cleanly;
- a run killed mid-way and recovered (the server, the helper and the host each killed in turn);
- a sentinel written in one run and absent in the next, including after a keep and a guest shutdown;
- an interactive start, then a program that makes its own desktop and starts a child on it: it passes with
  `session: 'interactive'` and still fails in session 0;
- `C:\build` read-only for the user, and the host's build unchanged after the guest admin writes there;
- uninstall `-KeepPool`, then setup again, which recognises the pool.

Test scratch goes to `HYPERV_TEST_SCRATCH` (default `%LOCALAPPDATA%\combwork-mcp-tests\hyperv-mcp-tests`), never the
repo, and `npm test` clears earlier runs' folders first.

## Files

- `server.js`: the MCP server. `roots.js` is a copy of the repo's [`shared/roots.js`](../../shared/roots.js), and
  `client.js` is a small stdio client for scripts and the tests.
- `helper\`: the helper, installed by setup into `%ProgramFiles%\hyperv-mcp`:
  - `helper.js` (its entry under the host), `core.js` (the rules), `journal.js`, `policy.js`, `images.js`, `iso.js`,
    `unattend.js`, `paths.js`;
  - `hv.js` and `hv.ps1` (the only way it acts on Hyper-V), `guest-sync.ps1` (the guest side of `vm_sync`) and
    `guest-agent.ps1` (the interactive session's watcher), each run in the guest by `hv.ps1`;
  - `approve.ps1`;
  - `host\HvMcpHost.cs` (the service host's source).
- `setup\install.ps1`, `setup\uninstall.ps1`: the only elevated steps besides approvals. `setup\acl.ps1` holds
  setup's storage and ACL routines, with `setup\Storage.cs` for the Windows calls they need (both tested non-elevated
  by `test\acl-check.ps1`).
