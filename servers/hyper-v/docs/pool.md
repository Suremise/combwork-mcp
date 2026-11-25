# hyper-v: building the pool

Plans, approvals, the build, guest setup scripts, licences and images. Part of the [hyper-v docs](../README.md#more).

## Building the pool

Pools are planned with you, not built by a fixed script: hardware and needs differ. A change goes **plan → your
approval → change**, or, within the caps you set at setup, **plan → change** (see [Which changes need your approval](#which-changes-need-your-approval-mc-1576)).

### Which changes need your approval (MC-1576)

Setup's `-ApprovePoolChanges` chooses. It's kept in `policy.json`, which only setup (as admin) can write, so no agent
can change it; a rerun without it keeps the current choice.

- **`WithinCaps`, the default** (also for a policy from before this option): a plan within the policy's caps applies
  when the agent calls it, with no approval. That covers:
  - the VM count, cores, memory, disk size and disk folder;
  - the network mode, up to setup's `-MaxNetwork`;
  - removing VMs, refreshing a clean checkpoint, and publishing, replacing or removing a pool checkpoint;
  - building more VMs from an image a plan **you approved** has built from.

  These still need your approval, because each puts new content into the clean state every lease starts from:
  - an image no plan you approved has built from (checking an image, or naming one by its SHA-256, isn't approving it);
  - a guest setup script;
  - a ready-made disk or VM (you type its admin password when you approve).

  The plan's reply says which, and why. Images of VMs already in the pool when you upgrade count as approved (they
  were all built under your approval).
- **`Each`:** every plan needs your approval, as before.

Either way, the caps are checked again when a plan applies, and a plan applies once. Whether it needs approval is
decided then too: from the policy the helper loaded when it started (setup restarts it, so a rerun's choice applies
to every plan from then on, including plans made before) and the plans you've approved, not from what the plan's reply
said. While uninstall has quiesced the helper, its own removal of the pool always needs its approval.

The steps, for a plan that needs your approval:

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
   - about 50 minutes each (CL-362: 2 VMs of 2 cores and 6 GB, Windows 11 25H2, about 101 minutes), one VM at a time,
     so the host's CPU isn't flooded. Most of it is the wait for each account's first sign-in to settle (below), about
     20 minutes each, mostly Windows' own App Readiness pause of about 16 minutes;
   - then the guest set-up, a sanity check of the installed edition and build, Windows' activation when the plan says
     so (see [Windows licences](#windows-licences));
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
- Up to about 512 MB (MC-1588; formerly 1 MB): the helper reads it as text, and Node holds a string of at most
  536870888 characters. It reaches a Windows guest in 1 MB pieces, and a Linux guest as bytes after its request, so
  no one guest call carries it whole. Have it fetch nothing: the guest is offline.
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
    (see [Network modes](../README.md#network-modes)).
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
   Linux cloud image (see [Linux guests](linux.md#linux-guests)). Any local file: download it yourself, from wherever you like. For example,
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

#### A ready-made disk, or one of your own VMs (MC-1578)

Instead of an ISO, name a Windows you have already installed and set up, as you want every pool VM to start:

```
pool_plan({ ..., image: { vhdx: "D:\\VMs\\win11-dev.vhdx", admin: "Administrator" } })
pool_plan({ ..., image: { vm: "win11-dev", admin: "Administrator" } })
```

- **What it must be:** an installed Windows (Windows 10, Windows Server 2016 or later, for PowerShell Direct) that
  starts to its logon screen, **not generalized** (not sysprepped), with `admin` a local administrator account in
  it. A VM named by name or id must be one of yours outside the pool: off, Generation 2, one disk (checkpoints are
  fine). Its disk is **only read**: flattened (Convert-VHD) into the helper's copy. The VM itself is never started,
  changed or owned.
- **The copy and its hash:** as for an ISO, the helper copies it into its own folder while hashing it. The plan
  names the source and SHA-256, and each build checks the copy against that hash first.
- **The password:** approve.cmd asks you for `admin`'s password. It's never asked of or passed by an agent, and never
  on a command line. It's kept in the helper's secrets folder (SYSTEM, Administrators and the helper only), bound to
  that approval, and deleted when the plan's builds end, when the approval expires unused, or when the helper next
  starts. Another plan for the same disk (a resize) asks again. To use another administrator in the same disk (or to
  correct a mistyped name), plan with `{ vhdx | vm, admin: "<the other>" }` again: later plans use that name, and
  plans already made keep theirs.
- **Its size:** the disk's own size (recorded with the image, shown in the plan) is the floor. Each VM's disk is
  at least that, grown to the plan's `diskGB` if that's larger, and never shrunk. A smaller `diskGB` is refused, and the
  policy's `maxDiskGBPerVm` is checked against the size the VMs will have. A disk bigger than the plan's size is
  refused at create.
- **Its licence:** read as it is. An evaluation part way through its period is fine, and its end is recorded for the
  usual expiry warnings. One already over is refused. The fresh ISO build's 85-day minimum doesn't apply.
- **Each VM's build, offline:**
  1. A copy of the disk, grown to the plan's size, with Secure Boot and a vTPM.
  2. `admin` is used once, to make the helper's own accounts: `hvadmin` (an administrator) and `hvuser` (a standard
     user). Accounts by those names in your disk are reset to that, and each is read back and signed in as.
  3. The guest setup and your guest setup script, if the plan names one.
  4. The licence is read (nothing is activated).
  5. Autologon, its stored password, UAC and Windows' Userinit are set back to Windows' own (verified), so nothing of
     the disk's own logon set-up becomes the pool's clean state.
  6. The clean checkpoint.

  Nothing else of yours in the disk is changed.
- **Skipped:** the unattended install, activation, the product key and the first-logon wait. So an interactive start's
  first logon in these VMs does Windows' first-logon work then (it took 2-5 minutes before MC-1516). Runs in
  session 0 aren't affected.
- **Not included:** a generalized (sysprepped) disk, a Linux `.vhdx` (Linux's ready-made image is the qcow2 path), and
  a VM with more than one disk.

**What the build can build: limits, not gates.**

- **x64 only:** an x64 Hyper-V host doesn't run ARM guests, so an ISO with no x64 image is refused, saying so.
- **Windows** needs `sources\install.wim` (an ISO with only `install.esd` isn't read) and an edition the unattended
  install can drive: a Generation 2 VM with Secure Boot and a vTPM, `autounattend.xml` (UEFI partitions, two local
  accounts, OOBE skipped) and PowerShell Direct for the guest steps. It has been run on Windows 11
  (Enterprise evaluation 25H2). Windows 10 and Windows Server 2019 or later use the same steps but haven't been tried:
  a step that can't work fails by name, and the build stops there.
- **Linux** needs a qcow2 cloud image (of any file size; its disk's virtual size is held to `maxDiskGBPerVm`) with cloud-init, systemd, OpenSSH and the `hv_sock` module (see
  [Linux guests](linux.md#linux-guests)). It has been run on Debian 13 and Ubuntu 26.04.
