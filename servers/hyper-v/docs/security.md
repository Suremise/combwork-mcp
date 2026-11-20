# hyper-v: security model

What the helper can and can't do, and why. Part of the [hyper-v docs](../README.md#more).

## Safety at a glance

| The server (its helper) can | It can't |
|---|---|
| Act on VMs it created: names start with the pool prefix (`hvmcp-`) **and** the VM id is in its journal **and** the VM is in its own folder. All three are checked, twice: in the helper and again in `hv.ps1`. | Touch any other VM, checkpoint, disk or switch: start, stop, change, delete or even name it. A VM renamed into the prefix still doesn't match an id. |
| Create VMs and disks, **only** from a plan the user approved in an elevated prompt, and **within the policy** setup wrote (max VMs, cores per VM, total memory, disk per VM, disk folders, the highest network mode). Each plan states the pool's cores, memory, disk and network mode for the user to confirm. | Exceed the policy, whatever a plan or an approval says. Create a switch, an external switch or a NAT, or change any host setting: Hyper-V's settings, other switches, the firewall, Defender, features or services. Setup (run by you, elevated) makes the one host-mode switch and its address. |
| Write only to its state folder (`%ProgramData%\hyperv-mcp`: the journal, plans, per-run staging under `runs\`, guest credentials) and the disk folders named at setup. | Write anywhere else on the host. Files read back from a guest are returned as data, never written to the host. |
| Copy a build into a VM: the files of a folder that resolves, by real path, under your MCP roots or a build folder an admin named at setup, **copied** to `C:\build`. | Share or map any host folder into a guest: the guest never sees a live host path, so it can't change your files. Copy a build from outside your roots and the admin's build folders, or from your profile itself, its dot-folders (`~/.ssh`, `~/.claude`, …), `AppData` or its top folders, or anything under `AppData\Roaming`. Follow a link or junction in the build (they're skipped and named). |
| Connect one VM for one run in the network mode `vm_start` asks for, at or below the mode you approved for the pool (see [Network modes](../README.md#network-modes)): **none** (the default), **host**, **internet** or **internet-lan**. | Use a mode above the pool's or the policy's. Connect a run any other way. Off is the default: the adapter is disconnected, and the restore at stop disconnects it again and removes its rules. A new VM also goes online once at build, through Windows' Default Switch, to activate Windows, when the plan you approved says so (see [Windows licences](pool.md#windows-licences)). |
| Reserve CPU for one run (`reserveCpu`, a percentage of the VM's cores), up to the policy's cap; reset at stop. | Reserve beyond the cap, or change a VM's CPU outside a run. |
| Restore the clean checkpoint **by id** before every start, unconditionally, and at every stop and release, then check that the VM is Off, at that checkpoint, disconnected, with no reserve. Keep a VM unrestored for inspection **only when asked**, until its lease ends. | Start a VM from anything but the clean checkpoint, or let one lease's changes reach the next. A VM that can't be confirmed clean is **quarantined**: never leased until a restore confirms it. |
| Keep a leased VM running for a **work session**: several runs in one guest, with `vm_sync` copying changed files into its `C:\build` (no restore between them), and the lease renewed up to the policy's `maxLeaseMinutes` at a time and `maxSessionMinutes` in all. | Carry anything past the lease: release, the deadline and the session's connection closing all restore and verify it as above. Write anywhere in the guest but `C:\build` and its own staging folder when syncing, or follow a link or junction there. |
| Run commands in a leased Linux guest over SSH on a Hyper-V socket (no network), through Windows' own `ssh.exe` with fixed arguments, the guest's forced command and a per-VM key only the helper holds (see [Linux guests](linux.md#linux-guests)). | Give an agent a key, an SSH endpoint or a shell in the guest other than the run it asked for. Run anything on the host but `powershell.exe` with its fixed script, `node` for itself, and, for Linux guests, `ssh.exe` from System32 and setup's own `HvMcpVsock.exe`, each with fixed arguments. |
| Run commands in a leased guest over PowerShell Direct, as its admin or its standard user, with passwords only the helper holds. On request, log one of those accounts on in the guest (autologon, then a guest restart) and run commands in its desktop session through a watcher started at logon (`hvuser` as a standard user, or `hvadmin` elevated); a run there that doesn't finish cleanly restores the VM. | Run any program on the host except `powershell.exe` with its own fixed script (and `node` for itself). An agent's text never reaches a host command line or script: it's passed as JSON on stdin and arrives in the guest as data. Leave a logon behind: autologon and its password live only inside the guest, and the next restore of the clean checkpoint removes them. |
| Build from the image file **you** name for these VMs (any x64 Windows ISO, a Windows disk you prepared or one of your own VMs, or a Linux qcow2 cloud image): copy it into its own folder while hashing it, read its edition and build, and show its path and SHA-256 in the plan you approve (see [The image](pool.md#the-image)). | Download an image, or choose one for you. Build from bytes other than the ones you approved: the copy is hashed again just before it is used. Install a converter or any other tool on the host. |

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
  - Anything at all against a determined agent, in **direct mode** (see [Direct mode](setup.md#direct-mode-no-service-weaker-read-this-first)).

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
  restored below, which disconnects it and removes them (see [Network modes](../README.md#network-modes));
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
lease; a persistent VM's lease has no session cap), and refused once the deadline has passed. A persistent VM (see
[Persistent VMs](tools.md#persistent-vms-a-vm-the-user-keeps-for-research-mc-1582)) is parked at those ends instead of restored. A sync:
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
