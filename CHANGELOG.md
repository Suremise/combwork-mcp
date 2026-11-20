# Changelog

What each release changed, by server. A release is one tag, `v<version>` ([RELEASING.md](RELEASING.md)); each server
keeps its own version in `servers/<name>/meta.json`. Releases before 1.8.0 are on the
[releases page](https://github.com/Suremise/combwork-mcp/releases).

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
- Disk folders at any depth; a storage folder's extra read-only or write grant is shown and removed on the admin's
  word (MC-1581).
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
