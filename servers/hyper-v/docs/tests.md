# hyper-v: tests

What the test suite covers, and the live proof in a nested VM. Part of the [hyper-v docs](../README.md#more).

## Tests

From the repo root, `npm test` runs everything below. Hyper-V is never touched: `hv.ps1` is replaced by
`test\stub-hv.js`, a fake Hyper-V that keeps VMs, checkpoints and guest files in JSON. Each test runs the real
`helper.js` as a child process, the way the service host does. From this folder:

```powershell
node --test test\units.test.js test\leases.test.js test\sessions.test.js test\guest-sync.test.js test\guest-agent.test.js test\interactive.test.js test\licence.test.js test\provision.test.js test\provision-clock.test.js test\provision-readiness.test.js test\provision-budget.test.js test\projects.test.js test\images.test.js test\named.test.js test\checkpoints.test.js test\poolcheckpoints.test.js test\refresh.test.js test\restorewait.test.js test\runs.test.js test\caps.test.js test\persistent.test.js test\approvals.test.js test\recovery.test.js test\server.test.js test\host.test.js test\linux-image.test.js test\linux-guest-files.test.js test\linux.test.js test\linux-ps.test.js test\bridge.test.js test\network.test.js test\guestnet.test.js test\uninstall.test.js test\timing.test.js test\nested-proof.test.js
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
    - MC-1581: another account's read-only grant shown, kept on a no, removed on a yes from the folder and everything
      in it (contents untouched), then trusted; on a disk folder, Explorer's Full Control grant shown as able to write,
      removed on a yes with Hyper-V's own grants kept; the same write grant refused without the disk folder's repair
      (the state folder's case), even with a yes; uninstall passing a read-only grant and refusing a write one; the
      `-DiskFolder` check taking deeper folders and refusing a drive root;
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
    - storage without receipts (an install from before them) refused untouched, pointing to the manual steps;
    - MC-1583's one confirmation: the VMs shown are the remove plan's; one question, and the plan approved with no
      second one; a cancel writing, quiescing, stopping and removing nothing; keep chosen at the question; a VM added,
      one replaced (same count), or one appearing in a pool confirmed empty, each asked again with nothing removed on a
      no and the record kept, and a yes going on; a resume against a changed set (an empty one included) asked again,
      and against the same set not; none confirmed and none now, no plan;
  - `approve.ps1` refusing to run outside the install folder;
  - setup and `uninstall.ps1` running under 5.1 and under 7 on to their own checks, changing nothing; the module-path
    fix applied under 5.1 only;
  - setup's helper file list holding every helper file (and the zip the whole helper folder), and its `-BuildRoot`
    and `-MaxSessionMinutes` checks agreeing with the helper's, under 5.1 and 7.
- `ready.test.js` (MC-1578): pool VMs from a ready-made disk or one of your own VMs, against the stub:
  - the plan naming the source, its SHA-256 and its admin, with no install, activation or first-logon lines;
  - the build's steps in order: the disk's admin for its first answer and the account step only, hvadmin for every
    later step, none of the ISO path's steps;
  - accounts by the helper's names already in the disk (hvuser an administrator, both disabled), autologon and an LSA
    password inherited: made right, undone and verified; the disk's admin itself named hvuser;
  - a wrong read-back, an undo that doesn't verify, a wrong password, a generalized disk: each failing the build,
    rolled back;
  - the password: refused when missing or bound to another plan, digest, disk or account; deleted on success, on
    failure, when its approval expires unused (an unexpired one kept), and at start-up after a helper stopped
    mid-build; never in the journal, a plan or the status;
  - the disk copy changed after approval refused at create; `activate`, a bad path, a bad account name, both shapes at
    once refused;
  - a source VM: its disk read into a copy; a running, Generation 1, two-disk, missing or pool VM refused, and a failed
    conversion; every outside VM's record and its disk unchanged;
  - `server.test.js`: the `ready-images` feature gate.
- `approval-mode.test.js` (MC-1576): approvals within the caps:
  - a checked image needing approval until an approved plan builds from it, then resizes applying as planned, also
    after a restart;
  - a plan applying once, also applied twice at once, after a restart, and after a failure;
  - the decision made at apply: a policy switched to Each, a lowered cap or network ceiling;
  - a guest script still needing approval; a refresh, a removal, a pool checkpoint's publish and removal applying;
  - the upgrade: the images of VMs then in the pool counted as approved, once, and a checked-only one not.
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
- `multivm.test.js` (MC-1580, more than one VM per session): one connection holds two VMs, starts and runs in each
  by `vm` and releases both; `vm` left out with several is refused naming them; a second lease counts toward the
  project's cap; a disconnect ends both; a staged build is never copied into another VM. Through `server.js`: the
  implied VM follows the helper's live leases (both held, one started: ambiguous; one released or ended by its
  deadline: the other, with its own defaults; a VM acquired anew has none); a helper without `multi-vm` is never sent
  `vm` (start, run and release naming one are refused with nothing sent).
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
  (a resize adding to or taking from one image's VMs only); `vm_acquire` by OS and image, and a Linux and a Windows VM in one session; VMs made
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
- `caps.test.js` (MC-1588): a `vm_run` command held to `HYPERV_MCP_COMMAND_CHARS` (default 8000), the lease keeping
  its value; a long one sent to a Windows guest in 1 MB pieces as the account that runs it, run byte for byte, and a
  staging the guest doesn't confirm whole never started; `vm_read_out` reading a Windows guest's files in calls of at
  most 2 MB, going on from an offset, cut by the call's total; its ceilings (`maxTotalBytes` at what one reply can hold,
  `maxBytes` none); and `hv.ps1`'s `$GuestRunStage`, `$RunFiles` and `$GuestRead`, run with Windows PowerShell 5.1:
  a 2.5 MB `.ps1` staged, moved into place and run as UTF-8, a short staging refused, a read from an offset.
  `linux.test.js` has the Linux side (bytes after the request line; a dispatcher built before MC-1588 refusing them, the
  reply saying why), `guest_unit_check.py` `guest.py`'s, and `provision.test.js` a 2.5 MB guest setup script staged at
  build.
- `persistent.test.js` (MC-1582): a persistent VM's plan and journal (only the VMs it builds), its approval text and
  `vm_status`; plain acquires never get it, a named one does, with no work-session cap but `maxLeaseMinutes` per
  renewal; its state kept through stop, a plain start, release and the next lease, each a park and never a restore;
  an explicit clean start and `vm_reset` restoring it; a disconnect, a helper restart, a failed start's cleanup and a
  quarantine retry each parking it; interactive starts and refresh refused; and, through `server.js`, `vm_reset`
  sending `reset` (`vm_start` never), and an older helper without the `persistent` feature never sent a persistent plan.
  MC-1589: a persistent VM's checkpoint kept at release and through a helper restart (journalled `lcp-keep`, still in
  Hyper-V), listed in `vm_status`, restored by a later named lease and removed only on request; a take Hyper-V
  completes after its call failed kept once the release finds it; `maxCheckpointsPerVm` across leases and
  `maxLeaseCheckpoints` per lease; and a disposable VM's checkpoints still removed with its lease.
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
- `timing.test.js` (MC-1558, MC-1579): the timings' defaults, the ceilings left only where a value breaks (copy idle,
  the output, Node's timer limit), with no floors, and the derived call bounds; an invalid `timingCaps`
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
