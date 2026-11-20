# hyper-v: setup in full

Setup's options, its storage rules, direct mode and the installed files. Part of the [hyper-v docs](../README.md#more).

## Setup

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
     SYSTEM. How setup makes them trustworthy is under [Storage](#storage-where-it-may-be-and-how-setup-trusts-it) below;
   - `policy.json`, the pool's hard limits. On a first install they're derived from the host: up to a quarter of its
     logical CPUs per VM (at most 8), half its memory in all, up to 4 VMs, 128 GB disks, network mode up to none.
     **A rerun keeps every value you don't pass** (MC-1592), `-DiskFolder` and `-BuildRoot` included (so a rerun
     needs no options at all), and its output lists the values it kept, the ones your options changed (old -> new),
     and any it set now because the policy didn't hold them yet. The checkpoint settings and `-MaxSessionMinutes` are
     left to the helper's defaults until you set them; `-1` (`0` for `-MaxSessionMinutes`) puts one back to the
     helper's default, and `-BuildRoot none` clears the build folders. Override any of them: `-MaxVms`,
     `-MaxCoresPerVm`, `-MaxMemoryGB`, `-MaxDiskGBPerVm`, `-MaxNetwork None|Host|Internet|InternetLan` (with
     `-HostSubnet`; see [Network modes](../README.md#network-modes)), `-MaxReservePercent`, `-MaxLeaseMinutes`, `-MaxSessionMinutes`
     (a work session's cap for `vm_renew`: at least `-MaxLeaseMinutes`, with no upper limit; left out, 480 or
     `-MaxLeaseMinutes` if that is more), `-MaxBuildMB`, and the checkpoint settings `-MaxLeaseCheckpoints` (default
     3), `-MaxCheckpointsPerVm` (default 4) and `-MinFreeGBForCheckpoint` (default 20; see "Checkpoints within a
     lease" and "Pool checkpoints"). None has a ceiling of setup's own (see "Limits that are settings"). (`-AllowUnpinnedIso` is no
     longer needed, from 4.0.0: setup accepts it and ignores it.) `-BuildRoot` names folders builds may also
     come from (see [Build folders set by an admin](tools.md#build-folders-set-by-an-admin)). `-ProjectsFile` names the projects that share the pool fairly (see
     [Sharing the pool between projects](tools.md#sharing-the-pool-between-projects)). `-ProductKeyFile` names a file holding a Windows product key for VMs built
     from your own (non-evaluation) image (see [Windows licences](pool.md#windows-licences)); a rerun without it keeps the key, and
     `-ProductKeyFile none` removes it. `-LinuxTransport` is `HvSocket`, the default and only value today (Linux guests: see
     [Linux guests](linux.md#linux-guests)); for it, setup also compiles `HvMcpVsock.exe` and registers vsock port 22's service id under
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
   or `HYPERV_MCP_ALLOWED_ROOTS` (see [Multiple projects](tools.md#multiple-projects-mcp-roots)), or have an admin name its build folders at setup. The [top-level README](../../../README.md#install) shows the
   entry for each client's format.
4. Build the pool: ask an agent to plan one (see [Building the pool](pool.md#building-the-pool)).

### Storage: where it may be, and how setup trusts it

The helper trusts what is in its state folder (the journal, plans, approvals, guest credentials) and its disk folders
(the verified images). So setup must know those bytes were written only by itself and the helper:

- **Supported locations.**
  - The state folder is `%ProgramData%\hyperv-mcp`, and the code goes in `%ProgramFiles%\hyperv-mcp`. Both are found
    through Windows' known-folder API, not environment variables.
  - A disk folder may be **any folder on a local fixed drive** (not a drive root), such as `D:\hyperv-mcp` or
    `D:\VMs\hyperv-mcp` (MC-1581). Its parents must pass the check below. On a fresh drive, a folder you make under the
    drive root usually lets Authenticated Users modify it (Windows' default), which fails that check: put the disk
    folder at the top level, or tighten that parent's permissions first.
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

  A folder without a receipt is refused untouched: one made by someone else, by an older setup, or whose creation was
  interrupted. So is one whose identity differs (deleted and made again), or with another owner. To use that
  location, remove the folder (and any pool in it, first), then run setup again.
- **An extra account's access can be removed (MC-1581).** When a folder matches its receipt but another account was
  given access to it, setup lists each account, its rights and where, and removes that access only if you type
  `REMOVE`, then checks the folder again:
  - **read-only access**, on any storage folder: nobody could have changed anything with it;
  - **access that can write**, on a **disk folder** only, with a warning: while it was there, programs running as that
    account (agents included) could have changed what's in it. The helper hashes each image again before every
    build, and a VM's disks are the agents' own to change anyway. If you think something was tampered with, answer no,
    remove the pool and the folder, and run setup again;
  - the **state folder** with another account able to write is still refused: a forged approval or journal there
    would matter. Remove the pool and the state folder, then run setup again.

  Uninstall lets read-only access through, and refuses access that can write (run setup first to remove it).
- **Files setup writes** (`policy.json`) are created with their final permissions under a temporary name, then renamed
  into place.
- `uninstall.ps1 -KeepPool` keeps the folders and their receipts. `-RemovePool` removes both.
- **Don't open these folders in Explorer.** Its "You don't currently have permission to access this folder" prompt,
  if you click Continue, gives your account Full Control of the folder and everything in it (Microsoft's KB 950934).
  Then agents running as you could write there. Setup then offers to remove that access from a disk folder (above),
  but refuses the state folder. To look inside, use an admin PowerShell (`Get-ChildItem D:\hyperv-mcp -Recurse`).

**In Combwork:** pack it (`node scripts\pack.mjs hyper-v` at the repo root) and add `dist\hyper-v.zip` with **Add MCP
Server from File** in the MCP view. Its definition goes in as `combwork-mcp.example.json`
([this one](../combwork-mcp.example.json)). Run setup from the unpacked folder's `setup\install.cmd`, then turn the server
on, and only in a dedicated testing project (see [Who gets it](security.md#security-model)).

### Direct mode (no service): weaker, read this first

With `-Mode Direct`, setup installs no service. It adds **your own account** to Hyper-V Administrators, and the server
runs the helper in-process (`HYPERV_MCP_MODE=direct` in the client's `env`). The tools are the same, but **any program
you run, every agent included, can then skip this server and drive Hyper-V directly**, and Hyper-V Administrators is
close to full control of the machine. The server's rules then guard only against an agent's mistakes, not against a
determined agent. Use the default service mode unless you accept that.

## Files

- `server.js`: the MCP server. `roots.js` is a copy of the repo's [`shared/roots.js`](../../../shared/roots.js), and
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
  `%ProgramFiles%\hyperv-mcp\uninstall`. `helper\inventory.js` renders the helper's recorded inventory. `helper\timing.js` holds the timings' keys and defaults, and the most a value can be where more breaks (MC-1558, MC-1579). `setup\acl.ps1` holds
  setup's storage and ACL routines, with `setup\Storage.cs` for the Windows calls they need (both tested non-elevated
  by `test\acl-check.ps1`).
- `test\live\`: the nested live proof (MC-1559, [Live proof in a nested VM](tests.md#live-proof-in-a-nested-vm)). `nested-proof.js` is the host-side
  driver (ssh and scp only); `nested-inner.js` bridges it to one server.js session inside the outer VM;
  `nested-listener.js` is the host-mode test listener. Dev-only: not packed.
