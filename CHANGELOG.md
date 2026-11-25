# Changelog

What each release changed, by server. A release is one tag, `v<version>` ([RELEASING.md](RELEASING.md)); each server
keeps its own version in `servers/<name>/meta.json`. Releases before 1.8.0 are on the
[releases page](https://github.com/Suremise/combwork-mcp/releases).

## Unreleased

### hyper-v

- `vm_read_out` no longer sends a reply bigger than an MCP client takes: Claude Code dropped the server when one passed
  16 MB, and the session lost its VM tools and its lease. Each reply is filled up to about 12 MB measured as sent
  (JSON escaping included); a file that doesn't fit stops there and says the offset to read on from, and the new
  `offset` reads on in that one file. `maxTotalBytes` is now at most 12 MB (formerly about 85 MB). Any other reply past
  15 MB is sent as an error instead. A Linux VM built before this reads from an offset up to 96 MB into a file; past
  that, rebuild it (MC-1597).
- `vm_status` names the PowerShell the helper runs `hv.ps1` under (edition, version and path), beside the server's
  version and mode. A helper from before this says it doesn't report it: run setup again (MC-1596).
- README: setup's PowerShell 7 line is in step 2 beside `install.cmd`, which prefers Windows PowerShell 5.1; and a
  realistic build time, about 50 minutes per Windows VM, mostly Windows' own first sign-ins (MC-1596).
- `vm_start`, `vm_wait` and the server's instructions say a session runs one slow operation at a time, even across
  VMs: start the second VM after `vm_wait` gives the first one's result. No change to behaviour (MC-1596).

## 1.9.0

### hyper-v 5.1.0 (from 5.0.0)

A minor version: new features for persistent VMs, nothing you must do. Rerun setup (`setup\install.cmd`, the same
line, in an admin terminal) to get them: without it, the 5.1.0 server still does everything 5.0.0 did, and refuses
`pool_persistence` and `vm_checkpoint`'s `remove` with "run setup again". See
[upgrading.md](servers/hyper-v/docs/upgrading.md) ("From 5.0.0 to 5.1.0").

- A persistent VM's checkpoints are the VM's, not the lease's: kept when the lease ends, listed in `vm_status`,
  restorable by a later lease that names it, and removed only when you ask (`vm_checkpoint` with `remove: true`), all
  within the policy's `maxCheckpointsPerVm` (MC-1589).
- An existing pool VM can be made persistent, or disposable again (its clean checkpoint restored and verified first),
  by a plan: `pool_plan` with `action: "persistence"`, applied with the new `pool_persistence` (MC-1591).
- An interactive start works on a persistent VM: the logon is undone and verified before every park, UAC put back as
  the guest had it, or the VM is quarantined (MC-1590).
- The tests' stub helper keeps its state behind one lock and merges its saves, so parallel test calls don't lose each
  other's changes; tests only, no change to the server or helper (MC-1594).

ollama, trilium and windows-sandbox are unchanged (1.4.0, 1.2.0, 1.3.0).

## 1.8.0

### hyper-v 5.0.0 (from 4.0.0)

A major version: upgrading needs you to act. Rerun setup (`setup\install.cmd`, in an admin terminal) before using the
new server, and check two things that changed under you:
- **Approvals:** an existing policy now takes the new default, `WithinCaps`: a plan within the policy's caps applies
  when the agent calls it, with no approval prompt, unless it brings a new image, a guest setup script or a ready-made
  disk. To keep approving every plan, rerun setup with `-ApprovePoolChanges Each`.
- **Guest tweaks:** new builds no longer add Defender exclusions or the `DisableForceUnload` policy. If your runs
  relied on them, put them in a guest setup script named in the plan. VMs you already have keep what they hold.

See [upgrading.md](servers/hyper-v/docs/upgrading.md) ("From 4.0.0 to 5.0.0"). 4.1.0 and 4.2.0 were steps on the way and were
never released on their own.

- Setup, approvals and the uninstaller run from any admin terminal (cmd, Windows PowerShell or PowerShell 7), and under
  PowerShell 7 on a Windows without Windows PowerShell; set up from PowerShell 7, the service runs `hv.ps1` under 7
  (MC-1575).
- You choose how pool changes are approved, `WithinCaps` (the default) or `Each`; uninstall's pool removal always
  needs its approval (MC-1576).
- Guest tweaks come from your own guest setup script (`.ps1`, `.cmd`, `.bat` or `.sh`), named in the plan, not from
  the helper (MC-1577).
- Pool VMs from a ready-made Windows disk or one of your own VMs (MC-1578).
- Every setting is in `combwork-mcp.example.json`'s `env` with its default; fixed limits became settings, with caps
  only where a larger value breaks something (MC-1579).
- More than one VM per session, e.g. a Windows and a Linux VM together; every lease tool takes `vm` (MC-1580).
- Disk folders at any depth. Setup shows another account's extra grant on a disk folder, read-only or able to write,
  and removes it only when the admin types REMOVE; the state folder still refuses any other account's write grant
  (MC-1581).
- A persistent VM you keep, for research (MC-1582).
- Uninstall asks once, showing what goes, its answer bound to the exact VMs (MC-1583).
- A short README; the detail moves to `docs/`, linked (MC-1584).
- `docs/linux-guests.md` section 11 no longer names a team (MC-1585).
- The nested proof's comment no longer names a team's pool (MC-1587).
- The command, guest-script and `vm_read_out` size caps settled: `HYPERV_MCP_COMMAND_CHARS` and the rest are settings
  (MC-1588).
- A setup rerun keeps every setting it isn't passed (limits, folders, `timingCaps`, `-Mode`, `-User`), and says which
  it kept and which it changed (MC-1592).

### ollama 1.4.0, trilium 1.2.0, windows-sandbox 1.3.0

- Every setting is in each server's `combwork-mcp.example.json` with its default; fixed limits became settings, with
  caps only where a larger value breaks something. ollama: `OLLAMA_MAX_FILE_MB`, `OLLAMA_MAX_INPUT_CHARS`,
  `OLLAMA_TIMEOUT_SECONDS`, no folder depth limit. trilium: the read, outline, children, index and search limits and
  `TRILIUM_TIMEOUT_SECONDS`. windows-sandbox: its start and ready waits and the rest (MC-1586). No setting was removed
  or renamed.
