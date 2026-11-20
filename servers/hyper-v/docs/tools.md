# hyper-v: the tools in full

Every tool, sessions, checkpoints, persistent VMs, projects and builds. Part of the [hyper-v docs](../README.md#more).

## Tools

| Tool | What it does |
|---|---|
| `vm_acquire({ minutes=60, keepOnFailure=false, wait=false, os='windows', distro?, image?, vm? })` | Leases one VM of that OS (`distro`, an `/etc/os-release` ID such as `debian` or `ubuntu`, for a Linux VM of that distro; and image, when given; or the VM named by `vm`, for trials, see [One VM by name](#sharing-the-pool-between-projects)) to this session until `vm_release`, its deadline (at most the policy's `maxLeaseMinutes`), or this server exiting. Without `wait`, it refuses when none is free for this session's project, saying why (none free, the project's cap, a VM kept for another project), when the next lease ends, and where it would stand in line. With `wait: true` it waits in line about 20 s, and a repeat call within 2 minutes keeps its place (see [Sharing the pool between projects](#sharing-the-pool-between-projects)). |
| `vm_start({ build?, network='none', reserveCpu=0, interactive=false })` | Restores the clean checkpoint (always, for a disposable VM; a persistent VM only when `checkpoint` is given, otherwise it starts from its disk as its last lease left it: see [Persistent VMs](#persistent-vms-a-vm-the-user-keeps-for-research-mc-1582)), applies this run's network mode (`none`, `host`, `internet` or `internet-lan`, at or below the pool's; see [Network modes](../README.md#network-modes)) and CPU reserve, and starts the VM. It waits for the guest, then copies `build` in to `C:\build` and leaves an empty `C:\out`. With `interactive: 'user'` (the standard user) or `'admin'`, it first logs that account on interactively: autologon, one guest restart, then it waits up to 10 minutes for the account's desktop session (often 2–4 minutes on a first logon; see [The interactive session](security.md#security-model)). Refused on a VM kept for inspection: release it, and acquire again. |
| `vm_renew({ minutes=60 })` | Sets the lease's deadline to now + `minutes` (1 to the policy's `maxLeaseMinutes`), never past the work session's end: `maxSessionMinutes` after `vm_acquire` (`vm_status` shows both; a persistent VM's lease has no session cap, see [Persistent VMs](#persistent-vms-a-vm-the-user-keeps-for-research-mc-1582)). Refused once the deadline has passed, even a moment before the helper ends the lease. |
| `vm_sync({ build?, full=false, delete=true })` | Copies only the files that changed in `build` (default: the folder last started or synced) into the **running** guest's `C:\build`, without a restore: `C:\out`, installed software and anything else the runs left stay. The server hashes the folder (same roots checks as `vm_start`, every time; links skipped); the helper compares that with what it placed in `C:\build` and takes only the new or changed files, hashing them itself as they arrive. Files gone from the folder are removed unless `delete` is false. Only what the helper copied is tracked: if your runs changed `C:\build` themselves, use `full: true` (clears `C:\build`, copies everything) or `vm_reset`. After a sync fails, only those two are accepted. |
| `vm_reset({ build?, network?, reserveCpu?, interactive? })` | A clean VM now: exactly `vm_start` (restore first, verified), with this session's last start's `network`, `reserveCpu` and `interactive` and its last build unless given. |
| `vm_run({ command, shell='cmd'\|'powershell'\|'bash'\|'sh', as='admin'\|'user', timeoutSec=120, cwd='C:\build', session='service'\|'interactive' })` | Runs in the guest (on Linux: bash by default, in `/build`, as root or `hvuser`, killed with everything it started on a timeout; see [Linux guests](linux.md#linux-guests)). stdout and stderr go to `C:\out\.run-<n>.*`, and the reply has the exit code and 16 KB of each (`HYPERV_MCP_OUTPUT_BYTES`). `as: 'user'` runs as the standard user, for whom `C:\build` is read-only. `session: 'service'` (the default) runs in session 0; on a timeout, everything the run started is killed inside: each run starts in its own Job object (MC-1547), so the kill ends every process in it, whenever it was created (taskkill /T's snapshot missed a child created as it ran). A run that can't be put in its job isn't started (the reply says why), and a job kill that can't be confirmed restores the VM instead, which ends everything the run started: a run is never chased process by process. (A run started without a job, by an older helper, is still killed by its PID with `taskkill /T /F`, only while that PID is still the run's process.) A run's program can't break away from the job; one that makes its own job gets a nested one, which ends with it. A run is started in one short PowerShell Direct call and its exit file then polled with short calls (see [Long runs](configuration.md#other-limits)), so it may take as long as `timeoutSec` allows. `session: 'interactive'` runs in the desktop session `vm_start`'s `interactive` logged on, as that account (`as` must name it), through a watcher started in that session at logon (`hvadmin` elevated, `hvuser` a standard user). If it times out or doesn't finish cleanly, its output so far is returned and the VM is restored, which ends everything it started; `vm_start` or `vm_reset` goes on. |
| `vm_read_out({ paths?, glob?, maxBytes=256 KB, maxTotalBytes=1 MB, base64=false })` | Files from the guest's `C:\out`, read in the guest and capped while reading, returned as data. `maxBytes` has no cap of its own; `maxTotalBytes` at most about 85 MB (see [Limits](configuration.md#limits)). A Windows guest's files come back in calls of at most 2 MB. Paths are relative and checked before the call (no `..`, drives, UNC or device paths, streams or device names). `glob` is matched against a listing. Links are skipped. With neither, it lists. Text as text, PNG/JPEG as images. Read before `vm_stop`, which discards them. |
| `vm_stop({ keep=false })` | A disposable VM: turns it off and restores the clean checkpoint, then **verifies** it (a persistent VM is shut down and disconnected instead, keeping its state: see [Persistent VMs](#persistent-vms-a-vm-the-user-keeps-for-research-mc-1582)): Off, at the checkpoint (by id), adapter disconnected, reserve 0. It says "Reverted" only then. Otherwise **CLEANUP FAILED**, and the VM is quarantined. The lease stays. `keep` (or a failed run with `keepOnFailure`) leaves it as it is until release or the deadline. |
| `vm_checkpoint({ name })` | Takes a named checkpoint of your leased VM as it runs now: files, installed software and the registry (a production checkpoint, disk only: not running programs or a logon session). Yours only, removed when the lease ends. See [Checkpoints within a lease](#checkpoints-within-a-lease). |
| `vm_restore({ name })` | Restores one of your lease's checkpoints and starts the VM from it, with the lease's current network and CPU reserve. No one is logged on interactively afterwards, and C:\build is unconfirmed until a full `vm_sync`. |
| `pool_refresh({ planId })` | Carries out an approved refresh-clean plan: reruns the build's guest setup on each VM (profiles kept as built) and makes that its new clean checkpoint, keeping its pool checkpoints and evaluation days. See [Refreshing a VM's clean checkpoint in place](#refreshing-a-vms-clean-checkpoint-in-place). |
| `pool_checkpoint({ planId })` | Carries out an approved pool-checkpoint plan: publishes (or replaces, or removes) a named checkpoint of each VM a lease prepared. See [Pool checkpoints](#pool-checkpoints-a-prepared-state-any-lease-can-start-from). |
| `vm_release()` | Restores the VM (as `vm_stop`; a persistent VM is parked, keeping its state) and ends the lease. |
| `vm_status()` | The pool, every lease, your VM, any pool job, the policy, and where builds may come from. Works with the server turned off. |
| `vm_wait()` | Waits for this session's slow operation and gives its result (MC-1553, see [Slow operations](#slow-operations)). Each call waits up to 45 s, `HYPERV_MCP_REPLY_MS`. |
| `pool_plan({ action='create'\|'resize'\|'remove', vms?, cores?, memoryGB?, diskGB?, location?, network?, image?, activate?, persistent? })` | `persistent: true` (MC-1582, only when the user asks): the VMs it builds are kept, never restored at release; see [Persistent VMs](#persistent-vms-a-vm-the-user-keeps-for-research-mc-1582). Plans a pool change and changes nothing (see [Building the pool](../README.md#building-the-pool)). `network` is the pool's network mode, the highest a run may use (default `none` for a create, the current mode for a resize; a resize may change only this; see [Network modes](../README.md#network-modes)). `image` is the file the user names, to check (`{ iso, edition? }` for Windows, `{ file }` for a Linux qcow2; never downloaded), or a checked image's SHA-256: build from it, or resize only its group (see [A pool from more than one image](#a-pool-from-more-than-one-image)). An evaluation image's plan always activates Windows online once per new VM; `activate: true` asks the same for your own copy (see [Windows licences](pool.md#windows-licences)). |
| `pool_create` / `pool_resize` / `pool_remove({ planId })` | Carries out an approved plan in the background. |
| `pool_status()` | The pool, the image, and any job or image check in progress. |

The server's MCP instructions tell agents to use the pool tools only when the user asks, and never to run the approve
line themselves.

### More than one VM per session

A session may hold several VMs at once (MC-1580), for example a Windows and a Linux VM for a test that needs both:
call `vm_acquire` once for each (with `os`, `distro` or `image` as usual). Each lease is like any other: it counts
toward the project's cap for its OS and the pool's, waits in the same line, and has its own deadline, network and
checkpoints.
- Every lease tool (`vm_start`, `vm_reset`, `vm_run`, `vm_read_out`, `vm_sync`, `vm_stop`, `vm_checkpoint`,
  `vm_restore`, `vm_renew`, `vm_release`) takes `vm`, the VM's name from `vm_acquire`'s reply or `vm_status` (which
  marks each of yours). With one VM held, `vm` may be left out, as before. With several, a tool without it is refused,
  naming them: a tool never guesses.
- Which VMs the session holds is read from the helper each time (a lease ended by its deadline is gone at once), never
  from what the server remembers. `vm_reset`'s and `vm_sync`'s defaults (the last start's options and build folder)
  are kept per VM, and dropped when that VM is released, no longer held, or acquired anew: one VM's build is never
  copied into another.
- A disconnect ends every lease the session holds; one lease's release or deadline leaves the others.
- One slow operation at a time per session, as before (`vm_wait`): commands in two VMs run one after the other.

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
  (as in [Checkpoints within a lease](#checkpoints-within-a-lease)). Once published it survives restarts. A retired one is removed at the VM's next
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

### Persistent VMs: a VM the user keeps, for research (MC-1582)

Every pool VM is disposable by default: restored to its clean checkpoint at every start and release. When the user asks
for a VM to keep, for research, a create or resize plan can build persistent ones instead: `pool_plan({ action:
'resize', vms: <n>, persistent: true })`. Every VM that plan builds is persistent. The plan says so, the approval shows
it, and its digest binds it. An existing VM isn't converted: remove it and add a persistent one.

**What a persistent VM gives up: the clean restore.** It is never restored at release, at its deadline, when its
session disconnects, at a helper restart, after a cleanup failure, or at a plain `vm_start`. It is **parked** instead:
the guest shut down (turned off if it doesn't within `HYPERV_MCP_SHUTDOWN_MINUTES`), its network adapter disconnected
with no port ACLs, CPU reserve 0, all verified, with its disk as the lease left it. So whatever a run did stays for the
next lease: installed software, files, settings, `C:\out`'s contents, anything malicious a test ran, and changes an
agent made by mistake. Any agent that acquires it by name sees all of it. Nothing checks that it is "clean", because
it isn't meant to be.

**What it keeps:**
- Network is off unless a start asks for a mode, never above the pool's approved mode, and disconnected at every
  stop and release.
- The policy's caps (VMs, cores, memory, disk), the pool boundary (the helper touches only its own VMs), its
  quarantine (a park that doesn't verify takes it out of use until a retry parks it).
- Its clean checkpoint. `vm_start({ checkpoint: 'clean' })`, a pool checkpoint's name, or `vm_reset` restores it,
  discarding what it kept: an explicit choice, never a side effect.

**How it is used:**
- Plain acquires (by OS, image, distro or pool checkpoint) never get it: it holds earlier leases' state, so only
  `vm_acquire({ vm: '<its name>' })` does. `vm_status` marks it PERSISTENT.
- A plain `vm_start` parks it and starts it from its disk, with the start's network and CPU reserve; a build, if
  given, is copied into `C:\build` as usual. `vm_stop` parks it.
- Its leases have no work-session cap (`maxSessionMinutes`): each acquire and `vm_renew` is still at most
  `maxLeaseMinutes`, renewed as often as needed. A Windows evaluation's end still ends it.
- Its lease checkpoints (`vm_checkpoint`) are still the lease's, removed when it ends.
- Not offered on it yet: an interactive start (the logon's changes would stay with no restore to undo them) and a
  clean-checkpoint refresh (it restores first). A resize that shrinks the pool removes disposable VMs before persistent
  ones; a remove plan names each persistent VM it removes.

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
[Linux guests](linux.md#linux-guests)).
- **Each VM records its image and OS** at its create (Linux: see [Linux guests](linux.md#linux-guests)). A VM made before that is given the image of the approved plan that
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
- **More than one VM per session:** each of a session's leases counts toward its project's cap for that VM's OS (see
  [More than one VM per session](#more-than-one-vm-per-session)).
- Setup checks the file with the helper's own policy code before changing anything. A rerun without `-ProjectsFile`
  keeps the list; `-ProjectsFile none` clears it.
- **It's advisory, like the roots it comes from:** it keeps honest agents from starving each other, not a determined one
  (any program running as you can name any roots).
