# hyper-v

An MCP server that gives agents **disposable Hyper-V test VMs** from a pool. An agent leases a VM, starts it from its
clean checkpoint with a build copied in, runs commands and gets their output, reads files back from one folder, and
stops it, which restores it. Several agents can each hold a VM at the same time. Optionally, a run can have its own
reserved CPU, for timed runs.

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
| Copy a build into a VM: the files of a folder that resolves, by real path, under your MCP roots, **copied** to `C:\build`. | Share or map any host folder into a guest: the guest never sees a live host path, so it can't change your files. Copy a build from outside your roots, or from your profile itself, its dot-folders (`~/.ssh`, `~/.claude`, …), `AppData` or its top folders, or anything under `AppData\Roaming`. Follow a link or junction in the build (they're skipped and named). |
| Connect one VM to the pool's **internal** switch for one run, only when `vm_start` asks (`network: true`) and the policy allows it. | Give a guest the internet or your LAN. It's off by default: the adapter is disconnected, and the restore at stop puts it back. |
| Reserve CPU for one run (`reserveCpu`, a percentage of the VM's cores), up to the policy's cap; reset at stop. | Reserve beyond the cap, or change a VM's CPU outside a run. |
| Restore the clean checkpoint **by id** before every start, unconditionally, and at every stop and release, then check that the VM is Off, at that checkpoint, disconnected, with no reserve. Keep a VM unrestored for inspection **only when asked**, until its lease ends. | Start a run from anything but the clean checkpoint, or let one run's changes reach the next. A VM that can't be confirmed clean is **quarantined**: never leased until a restore confirms it. |
| Run commands in a leased guest over PowerShell Direct, as its admin or its standard user, with passwords only the helper holds. | Run any program on the host except `powershell.exe` with its own fixed script (and `node` for itself). An agent's text never reaches a host command line or script: it's passed as JSON on stdin and arrives in the guest as data. |
| Download the evaluation ISO over HTTPS from a `microsoft.com` host, and check an ISO before anything runs it (see "The image"). | Use an image that fails its checks, or a local ISO that isn't a known Microsoft image, unless setup allowed that and the user approved it as "not authenticated". |

**Don't put real sign-ins, tokens or real CLIs in a VM.** It's for testing a build on a clean Windows. Use fake CLIs
and test accounts.

### What the confinement guarantees

- **Guaranteed**, whatever an agent or any program running as you sends to the pipe:
  - no VM, disk, checkpoint or switch outside the pool is touched;
  - nothing is written outside the helper's state folder and the setup's disk folders;
  - nothing exceeds the policy;
  - every run starts from the clean checkpoint;
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
     `-MaxDiskGBPerVm`, `-AllowNetwork $false`, `-MaxReservePercent`, `-MaxLeaseMinutes`, `-MaxBuildMB`,
     `-AllowUnpinnedIso`.

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
   or `HYPERV_MCP_ALLOWED_ROOTS` (see "Multiple projects"). The [top-level README](../../README.md#install) shows the
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
| `vm_acquire({ minutes=60, keepOnFailure=false })` | Leases one free VM to this session (one VM per session) until `vm_release`, its deadline (at most the policy's `maxLeaseMinutes`), or this server exiting. Refuses when none is free, saying when the next lease ends. |
| `vm_start({ build?, network=false, reserveCpu=0 })` | Restores the clean checkpoint (always), applies this run's network and CPU reserve, and starts the VM. It waits for the guest, then copies `build` in to `C:\build` and leaves an empty `C:\out`. Refused on a VM kept for inspection: release it, and acquire again. |
| `vm_run({ command, shell='cmd'\|'powershell', as='admin'\|'user', timeoutSec=120, cwd='C:\build' })` | Runs in the guest. stdout and stderr go to `C:\out\.run-<n>.*`, and the reply has the exit code and 16 KB of each. On a timeout, the command is killed inside by its PID (`taskkill /T /F`). `as: 'user'` runs as the standard user, for whom `C:\build` is read-only. |
| `vm_read_out({ paths?, glob?, maxBytes=256 KB, maxTotalBytes=1 MB, base64=false })` | Files from the guest's `C:\out`, read in the guest and capped while reading, returned as data. Paths are relative and checked before the call (no `..`, drives, UNC or device paths, streams or device names). `glob` is matched against a listing. Links are skipped. With neither, it lists. Text as text, PNG/JPEG as images. Read before `vm_stop`, which discards them. |
| `vm_stop({ keep=false })` | Turns the VM off and restores the clean checkpoint, then **verifies** it: Off, at the checkpoint (by id), adapter disconnected, reserve 0. It says "Reverted" only then. Otherwise **CLEANUP FAILED**, and the VM is quarantined. The lease stays. `keep` (or a failed run with `keepOnFailure`) leaves it as it is until release or the deadline. |
| `vm_release()` | Restores the VM (as `vm_stop`) and ends the lease. |
| `vm_status()` | The pool, every lease, your VM, any pool job, the policy, and where builds may come from. Works with the server turned off. |
| `pool_plan({ action='create'\|'resize'\|'remove', vms?, cores?, memoryGB?, diskGB?, location?, network?, image? })` | Plans a pool change and changes nothing (see "Building the pool"). |
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
  `HYPERV_MCP_MINUTE_MS`;
- `HYPERV_MCP_MIN_ISO_BYTES`.

The service's environment is set by its host, which users can't change.

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

**Guest credentials.** The answer file creates a guest admin (`hvadmin`) and a standard user (`hvuser`) with random
passwords. The passwords are kept in the helper's state folder and passed to `hv.ps1` on stdin. Setup's copies of the
answer file are deleted, on the host and in the guest.

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
- There's no interactive desktop or screenshots yet: commands run over PowerShell Direct, as the admin, or as the
  standard user in its own PowerShell Direct session. For that, the guest's admin adds the user to the guest's Remote
  Management Users group first, inside that throwaway guest only.
- Windows guests only. The evaluation expires after 90 days (see "Rebuilding").

## Tests

From the repo root, `npm test` runs everything below. Hyper-V is never touched: `hv.ps1` is replaced by
`test\stub-hv.js`, a fake Hyper-V that keeps VMs, checkpoints and guest files in JSON. Each test runs the real
`helper.js` as a child process, the way the service host does. From this folder:

```powershell
node --test test\units.test.js test\leases.test.js test\approvals.test.js test\recovery.test.js test\server.test.js test\host.test.js
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
  - `approve.ps1` refusing to run outside the install folder.
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
  - pool tools without approval;
  - the lease ending when the server exits;
  - service mode without the helper.
- `host.test.js`: `HvMcpHost.cs` compiled with the in-box `csc.exe` and run in console mode, with `server.js` over the
  real pipe:
  - the helper killed mid-run: its run's child (by its recorded PID) dies with the job object, the client is told, and
    the respawned helper restores the VM before the pipe reopens;
  - the host killed: its helper dies too;
  - a pipe name already taken is refused;
  - a client can't forge framing, and an over-long line closes only that connection.

**The trial** on a real host (not automated): setup, then `pool_plan` → approval → `pool_create` from the pinned 25H2
ISO, then:
- two VMs running at once, each restoring cleanly;
- a run killed mid-way and recovered (the server, the helper and the host each killed in turn);
- a sentinel written in one run and absent in the next, including after a keep and a guest shutdown;
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
  - `hv.js` and `hv.ps1` (the only way it acts on Hyper-V);
  - `approve.ps1`;
  - `host\HvMcpHost.cs` (the service host's source).
- `setup\install.ps1`, `setup\uninstall.ps1`: the only elevated steps besides approvals. `setup\acl.ps1` holds
  setup's storage and ACL routines, with `setup\Storage.cs` for the Windows calls they need (both tested non-elevated
  by `test\acl-check.ps1`).
