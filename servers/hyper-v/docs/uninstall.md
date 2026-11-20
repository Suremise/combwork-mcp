# hyper-v: uninstall in full

The uninstaller, what it may delete, its order and resuming it. Part of the [hyper-v docs](../README.md#more).

## Removing everything without agents

You don't need an agent, or this repo, to put the PC back (MC-1557). Setup installs the uninstaller with the helper, and
it works out what to remove when it runs, from the helper's own records: the pool, VMs, checkpoints, images, switch,
service and folders as they are then, whoever made them. Nobody has to keep a script up to date.

- **Settings > Apps > Installed apps > "Hyper-V MCP helper and test VMs" > Uninstall.** It asks for admin rights,
  checks what is installed (changing nothing), then shows one screen of what goes and asks once: type `REMOVE` to
  remove everything, or `KEEP` to keep the pool and remove only the helper. Anything else cancels, with nothing
  changed (MC-1583).
- Or, in an admin terminal (cmd or PowerShell; one line), the installed copy:
  ```
  cmd /c call "C:\Program Files\hyperv-mcp\uninstall.cmd"
  ```
  Add `-RemovePool` or `-KeepPool` to choose up front (it still shows what goes, and asks you to type that word), or
  `-WhatIf` to see what each would remove, changing nothing (no record, no approval, no service change).
- **The one answer is the approval.** The VMs on that screen are the ones the helper's own remove plan names, by id,
  name and folder. Typing `REMOVE` approves that plan for exactly those VMs: there is no second approval step. If the
  pool changes before they go (a VM added or replaced, even one appearing in a pool that had none), nothing is
  removed: the new list is shown beside the one you confirmed, and you're asked again. A resumed uninstall checks the
  same way.
- **What is installed, in plain text:** `C:\ProgramData\hyperv-mcp\inventory.txt`, the helper's recorded inventory,
  rewritten after every change it makes. Each item has the command to remove it by hand, for when the uninstaller
  can't run. The uninstaller checks every item live before deleting anything; it never runs the file's text.
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
With neither option it asks (see above), once. The two choices:
- `-KeepPool` removes the service, its rights, the group and the code, and **keeps** the VMs, the helper's state (the
  journal, policy and guest credentials), the disk folders and their storage receipts. Running setup again recognises
  them by their receipts.
- `-RemovePool` removes the pool first, through the helper's own journalled remove (its plan approved by your one
  answer, for exactly the VMs shown). Then it removes the storage, then everything else.

**What it may delete:** only storage it verifies, before any change, as setup's own: exactly the folders that have
storage receipts. Each folder's identity must match its receipt, and its owners and permissions must be setup's.
Without receipts, nothing is deleted, and `policy.json` is never a source of what to delete.

**An install from before storage receipts** (MC-1583 retired the uninstaller's path for one). Every released hyper-v,
from 1.0.0 in combwork-mcp 1.3.0, writes receipts. Such an install could only come from the unreleased builds of
13 Nov. The uninstaller refuses one, changing nothing. Remove it by hand, in an admin PowerShell, following its
`C:\ProgramData\hyperv-mcp\inventory.txt` if there is one: the VMs (`Stop-VM`, `Remove-VM`), the service
(`sc.exe delete HyperVMcp`), the group (`Remove-LocalGroup 'Hyper-V MCP Users'`), `HKLM\SOFTWARE\hyperv-mcp`, the
install and state folders, and the disk folder you gave setup.

Nothing is ever deleted through a link. `-KeepPool` verifies the storage the same way, though it deletes nothing:
quiesce reads and writes the helper's state as admin, so anything it would refuse to delete, it also refuses to use.

**In what order:**
1. Verify everything, changing nothing. Then the one question, with the VMs as the helper's remove plan names them.
   Then write a record, holding your answer and those VMs.
2. Quiesce the helper and remove the pool: no new leases, every lease ended, every VM restored. The quiesce's own
   admin-written approval names its purpose: with `-KeepPool` no pool change is allowed after it; with `-RemovePool`
   only this uninstall's own approved remove. A fresh remove plan is approved (`approve.ps1 -Confirmed`, for a remove
   plan only) only if its VMs are exactly the confirmed ones; otherwise you're asked again first.
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
