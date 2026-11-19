# Uninstall's teardown (design MC-1488/s66 + s68), dot-sourced by uninstall.ps1 after acl.ps1, and tested non-elevated by
# test\teardown-check.ps1 with fake outside actions and a crash hook at every boundary.
#
# What it may delete: only storage verified, before any change, as setup's own: exactly the folders with receipts
# (identity must match; owners and grants setup's). No receipts: refused, nothing changed. (MC-1583 retired the legacy
# path for installs from before receipts: every released hyper-v, from 1.0.0 in combwork-mcp 1.3.0, wrote them; such an
# install could only come from the unreleased builds of 13 Nov, and the README gives its manual steps.)
# In what order: verify (no change) → the one confirmation (MC-1583: what goes, from what was just verified and the
# helper's own remove plan; one answer) → record → pool (through the helper: quiesce, then a fresh remove plan, approved
# only if its VMs are exactly the confirmed ones, else asked again) → stop the service (it stays registered) → storage →
# the service, rights, group and install folder → receipts, InstallId, the record. The record (HKLM\SOFTWARE\hyperv-mcp,
# value Teardown) is bound to its install generation (InstallId), its mode, its targets' identities and the confirmed
# VMs; a rerun resumes it only with the same mode, at its phase. Every action checks the current state and does nothing
# when its work is done, so a rerun after a kill anywhere tolerates what was already removed. Errors are never
# swallowed: the record stays at the last completed phase.

$script:PHASES = @('verified', 'pool-removed', 'stopped', 'storage-removed', 'components-removed')

# Read-only: the key and its Storage subkey (when present) must be owned, and writable, only by $Trusted.
function Assert-KeyProtected([Microsoft.Win32.RegistryKey]$Root, [string]$KeyPath, [string[]]$Trusted) {
  $writeMask = 0x2 -bor 0x4 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
  foreach ($p in @($KeyPath, "$KeyPath\Storage")) {
    $k = $Root.OpenSubKey($p)
    if (-not $k) { continue }
    try {
      $sec = $k.GetAccessControl()
      $bad = @()
      $owner = $sec.GetOwner([Security.Principal.SecurityIdentifier]).Value
      if ($Trusted -notcontains $owner) { $bad += "owned by $owner" }
      foreach ($r in $sec.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($r.AccessControlType -eq 'Allow' -and $Trusted -notcontains $r.IdentityReference.Value -and ([int64]$r.RegistryRights -band $writeMask)) { $bad += "$($r.IdentityReference.Value) can write it" }
      }
      if ($bad.Count) { throw "The key $($k.Name) isn't protected ($($bad -join '; ')): its records can't be trusted. Nothing was changed." }
    } finally { $k.Dispose() }
  }
}

function Read-Teardown([Microsoft.Win32.RegistryKey]$Key) {
  $v = $Key.GetValue('Teardown')
  if (-not $v) { return $null }
  try { return $v | ConvertFrom-Json } catch { throw "The teardown record in $($Key.Name) is unreadable: nothing was changed. ($($_.Exception.Message))" }
}
function Write-Teardown([Microsoft.Win32.RegistryKey]$Key, $Record) { $Key.SetValue('Teardown', ($Record | ConvertTo-Json -Compress -Depth 5)); $Key.Flush() }

# Install's guard: no helper may start while a teardown is unfinished.
function Assert-NoTeardown([Microsoft.Win32.RegistryKey]$Root, [string]$KeyPath) {
  $k = $Root.OpenSubKey($KeyPath)
  if (-not $k) { return }
  try {
    $r = $k.GetValue('Teardown')
    if ($r) { $m = try { $r | ConvertFrom-Json } catch { $null }; throw "An uninstall is unfinished (mode $($m.mode), at $($m.phase)): finish it first, by running the uninstaller again. Nothing was changed." }
  } finally { $k.Dispose() }
}

# Deletes a tree without following links: files deleted, real folders recursed, reparse points removed as links (the
# link itself, never what it points to). A missing path is done.
function Remove-TreeNoFollow([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) { $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName, $false) } else { [IO.File]::Delete($item.FullName) }
    return
  }
  if ($item.PSIsContainer) {
    foreach ($c in @(Get-ChildItem -LiteralPath $item.FullName -Force)) { Remove-TreeNoFollow $c.FullName }
    [IO.Directory]::Delete($item.FullName, $false)
  } else { [IO.File]::Delete($item.FullName) }
}

function Get-Inventory([string]$Path) {
  $files = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue)
  $bytes = ($files | Measure-Object -Property Length -Sum).Sum
  return ('{0}: {1} file(s), {2:N1} GB' -f $Path, $files.Count, ([double]$bytes / 1GB))
}

# MC-1583: a set of VMs ({ vmId, name, folder }) as one comparable string: the same VMs in any order give the same key.
function Get-VmSetKey($Vms) {
  return (@($Vms | Where-Object { $_ } | ForEach-Object { "$($_.vmId)|$($_.name)|$($_.folder)".ToLowerInvariant() } | Sort-Object) -join "`n")
}

# Verifies one deletion target as it is now (its parents already pinned): not a link; owner in $RootOwners; contents
# with only $Who (and per-VM SIDs) as owners and grantees. Returns its identity, or $null when it is missing.
# The target's handle goes in $Pins (its own list, released just before the target is deleted).
# $AllowPattern: Hyper-V's own grantees, for a disk folder only (never the state folder).
function Test-Target([string]$Path, [string[]]$RootOwners, [string[]]$Who, [Collections.ArrayList]$Pins, [string]$AllowPattern) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $h = [HvMcpStorage]::Open($Path)
  [void]$Pins.Add($h)
  if ([HvMcpStorage]::Attributes($h) -band [HvMcpStorage]::FILE_ATTRIBUTE_REPARSE_POINT) { throw "$Path is a link or junction: refusing to delete through it. Nothing was changed." }
  $owner = Get-OwnerSid (Get-HandleSecurity $h)
  if ($RootOwners -notcontains $owner) { throw "$Path is owned by $owner, not Administrators or SYSTEM: it isn't setup's, so it won't be deleted. Nothing was changed." }
  # MC-1581: an extra account's read-only grant (Explorer's "Continue") doesn't stop it: a reader couldn't have changed
  # or added anything. A foreign owner, a link, or anyone else able to write still does.
  $bad = @(Test-ExclusiveAcl $Path -Allowed $Who -Owners $Who -AllowPattern $AllowPattern -IgnoreReadOnly)
  if ($bad.Count) { throw "$Path isn't as setup and the helper leave it ($($bad[0])$(if ($bad.Count -gt 1) { "; and $($bad.Count - 1) more" })), so it won't be deleted. Nothing was changed." }
  return [HvMcpStorage]::Identity($h)
}

function Invoke-Teardown {
  param(
    # MC-1583: 'ask' (no option given): the one confirmation chooses remove or keep.
    [ValidateSet('keep', 'remove', 'ask')][string]$Mode,
    [string]$State, [string]$Install,
    [Microsoft.Win32.RegistryKey]$Root, [string]$KeyPath,
    [string[]]$Trusted,     # may own/write the registry key and the parents: SYSTEM, Administrators, TrustedInstaller
    [string[]]$RootOwners,  # may own a deletion target: Administrators, SYSTEM
    [string[]]$Who,         # may own or hold grants inside a target: SYSTEM, Administrators, the helper's account
    # ServiceState, StopService, DeleteService, RemoveRights, RemoveGroup, HelperStatus, Quiesce, Say; MC-1583:
    # PlanRemove (the helper's remove plan: { planId, vms: { vmId, name, folder }[] }), Confirm ({ mode, vms, folders }:
    # 'remove', 'keep' or $null), ConfirmChange (the confirmed and the live VMs: true to go on), RemovePool (a plan id:
    # the VMs left).
    [hashtable]$Ops,
    [scriptblock]$Crash,    # test hook: run at every boundary with its name
    [switch]$WhatIf         # MC-1557: verify only and say what would happen; nothing written, stopped or removed
  )
  $boundary = { param($n) if ($Crash) { & $Crash $n } }
  $say = { param($m) if ($Ops.Say) { & $Ops.Say $m } }
  $stateFull = [IO.Path]::GetFullPath($State).TrimEnd('\')
  # Hyper-V's grantee pattern applies to disk folders only: anything but the state folder (and what it holds).
  $patternFor = { param($p) if ($p -eq $stateFull -or $p.ToLowerInvariant().StartsWith($stateFull.ToLowerInvariant() + '\')) { $null } else { $script:HyperVGrantees } }
  $pins = New-Object Collections.ArrayList   # parents: held for the whole run
  $targetPins = @{}                          # each target's own handles (and its nested targets'), by target path
  $key = $null
  try {
    # The key and its record, if any (protection checked before anything in it is read).
    $existing = $Root.OpenSubKey($KeyPath)
    if ($existing) { $existing.Dispose(); Assert-KeyProtected $Root $KeyPath $Trusted; $key = $Root.OpenSubKey($KeyPath, $true) }
    $rec = if ($key) { Read-Teardown $key } else { $null }
    $installId = if ($key) { $key.GetValue('InstallId') } else { $null }

    if ($rec) {
      # MC-1583: a resume takes the recorded mode when none was given; another mode is refused.
      if ($Mode -eq 'ask') { $Mode = $rec.mode }
      if ($rec.mode -ne $Mode) {
        throw "An unfinished uninstall was started with another choice (mode $($rec.mode)): run it again with that one. Nothing was changed."
      }
      # Its InstallId is deleted only in the last phase (after components-removed): then a missing one is this teardown's own doing.
      if ($rec.installId -ne $installId -and -not ($null -eq $installId -and $rec.phase -eq 'components-removed')) { throw 'The unfinished uninstall belongs to another installation (its InstallId differs): nothing was changed.' }
      if ($WhatIf) { & $say "An unfinished uninstall ($Mode) would be resumed at its '$($rec.phase)' phase; it would then remove: $(@($rec.targets | Where-Object { $_.identity -and $Mode -eq 'remove' } | ForEach-Object { $_.path }) -join ', ')"; return }
      & $say "Resuming the uninstall at its '$($rec.phase)' phase."
    } else {
      # The tail of a finished uninstall (killed after its record was deleted): no record, no InstallId, no receipts. Only
      # the empty key is left.
      if ($key -and -not $installId) {
        $rk = $key.OpenSubKey('Storage'); $n = if ($rk) { $rk.ValueCount } else { 0 }; if ($rk) { $rk.Dispose() }
        if (-not $n -and $key.ValueCount -eq 0) {
          if ($WhatIf) { & $say "The empty registry key $KeyPath left by a finished uninstall would be removed."; return }
          $key.Dispose(); $key = $null
          $Root.DeleteSubKeyTree($KeyPath, $false)
          & $say 'Removed the empty registry key left by a finished uninstall.'
          return
        }
      }
      # ---- Phase 1: verify, changing nothing. In both modes: keep mode deletes nothing, but the helper's state is
      # still read and written as admin (quiesce), so it must be the verified storage too. ----
      $targets = @()
      if ($true) {
        $noReceipts = 'so nothing is known to be setup''s: no storage will be used or deleted. Nothing was changed. (An install from before storage receipts, an unreleased build of 13 Nov, is removed by hand: see the README''s Uninstall.)'
        if (-not $key) { throw "There are no storage receipts (setup's records of the folders it created), $noReceipts" }
        $rk = $key.OpenSubKey('Storage')
        $receipts = @{}
        if ($rk) { foreach ($n in $rk.GetValueNames()) { $receipts[$n] = $rk.GetValue($n) }; $rk.Dispose() }
        if (-not $receipts.Count) { throw "The storage receipts key holds no receipts, $noReceipts" }
        $paths = @($receipts.Keys)
        # Deduplicate and drop targets nested in another (a state folder holds its approvals\).
        $full = @($paths | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') } | Sort-Object -Unique)
        $top = @($full | Where-Object { $p = $_; -not ($full | Where-Object { $_ -ne $p -and $p.ToLowerInvariant().StartsWith($_.ToLowerInvariant() + '\') }) })
        foreach ($p in $top) {
          Open-TrustedAncestors $p $Trusted $pins
          $targetPins[$p] = New-Object Collections.ArrayList
          $id = Test-Target $p $RootOwners $Who $targetPins[$p] (& $patternFor $p)
          $want = $receipts[$p.ToLowerInvariant()]
          if ($id -and $id -ne $want) { throw "$p isn't the folder setup created (its identity differs from its receipt): it won't be used or deleted. Nothing was changed." }
          $targets += [pscustomobject]@{ path = $p; identity = $id }
        }
        # A nested receipted target (approvals\) must match its receipt too, though it goes with its parent.
        foreach ($p in ($full | Where-Object { $top -notcontains $_ })) {
          if (Test-Path -LiteralPath $p) {
            $h = [HvMcpStorage]::Open($p)
            $holder = $top | Where-Object { $p.ToLowerInvariant().StartsWith($_.ToLowerInvariant() + '\') } | Select-Object -First 1
            [void]$targetPins[$holder].Add($h)
            if ([HvMcpStorage]::Identity($h) -ne $receipts[$p.ToLowerInvariant()]) { throw "$p isn't the folder setup created (its identity differs from its receipt). Nothing was changed." }
          }
        }
        # The state folder, which quiesce reads and writes as admin, must be one of the verified targets.
        $stateFull = [IO.Path]::GetFullPath($State).TrimEnd('\')
        if ((Test-Path -LiteralPath $stateFull) -and -not ($targets | Where-Object { $_.path -eq $stateFull -and $_.identity })) {
          throw "$stateFull isn't among the verified storage (no receipt for it): it won't be used. Nothing was changed."
        }
      }
      $helper = & $Ops.HelperStatus
      if ($helper -and $helper.job) { throw "A pool job is running ($($helper.job)): wait for it, then run this again. Nothing was changed." }
      # What would stop a remove (read-only): asked for one, it refuses now; asked to choose, the question says so.
      $removeWhy = $null
      if ($Mode -ne 'keep') {
        $vms = if ($helper) { [int]$helper.vms } else { $null }
        if ($null -eq $vms -and (Test-Path -LiteralPath $State)) { $removeWhy = 'The helper isn''t running, so its VMs can''t be confirmed removed: start it (Start-Service HyperVMcp) and run this again.' }
        foreach ($t in $targets) {
          if ($removeWhy) { break }
          $pool = Join-Path $t.path 'pool'
          $left = @(if (Test-Path -LiteralPath $pool) { Get-ChildItem -LiteralPath $pool -Force })
          if ($left.Count -and -not $vms) { $removeWhy = "$pool still holds $($left.Count) item(s) ($($left[0].FullName)) while the helper reports no VMs: inspect them first." }
        }
      }
      if ($Mode -eq 'remove' -and $removeWhy) { throw "$removeWhy Nothing was changed." }
      if ($WhatIf) {
        & $say "Verified. $(if ($Mode -ne 'keep') { "Would remove the pool$(if ($helper) { " ($($helper.vms) VM(s), through the helper's remove plan)" }), then these folders: $(@($targets | Where-Object { $_.identity } | ForEach-Object { $_.path }) -join ', ')" } else { "Would keep the pool and these folders: $(@($targets | Where-Object { $_.identity } | ForEach-Object { $_.path }) -join ', ')" }); then the service, its rights, the group and the install folder."
        return
      }
      # MC-1583: the one confirmation, from what was just verified: the VMs as the helper's own remove plan names them
      # (by id, name and folder; the plan changes nothing), and each folder with what it holds. One answer: remove or
      # keep (or, with a mode given, that one). Nothing has been written, quiesced or stopped before it.
      $planned = @()
      if ($Mode -ne 'keep' -and -not $removeWhy -and $helper -and [int]$helper.vms -gt 0) { $planned = @((& $Ops.PlanRemove).vms) }
      $folders = @($targets | Where-Object { $_.identity } | ForEach-Object { Get-Inventory $_.path })
      $choice = & $Ops.Confirm @{ mode = $Mode; vms = $planned; folders = $folders; removeWhy = $removeWhy }
      if ($choice -ne 'remove' -and $choice -ne 'keep') { & $say 'Cancelled: nothing was changed.'; return 'cancelled' }
      if ($Mode -ne 'ask' -and $choice -ne $Mode) { throw "internal: the answer ($choice) isn't the mode asked ($Mode)" }
      if ($choice -eq 'remove' -and $removeWhy) { throw "$removeWhy Nothing was changed." }
      $Mode = $choice
      if (-not $key) { throw 'internal: no key' }
      if (-not $installId) { throw 'The installation has no InstallId (it wasn''t made by setup): nothing was changed.' }
      # The record, written once (its mode, generation and targets never change; the confirmed VMs only on a new answer),
      # in the protected key.
      $rec = [pscustomobject]@{ id = [guid]::NewGuid().ToString('n'); installId = $installId; mode = $Mode; targets = $targets; pool = @(if ($Mode -eq 'remove') { $planned }); phase = 'verified' }
      Write-Teardown $key $rec
      & $boundary 'after:record'
      & $say "Verified; the uninstall record is written ($Mode)."
    }
    $phase = [array]::IndexOf($script:PHASES, $rec.phase)
    $advance = { param($p) $rec.phase = $p; Write-Teardown $key $rec; & $boundary "after:phase:$p" }

    # On a resumed run, phase 1 didn't run here: re-verify every recorded target that still exists (its parents pinned,
    # not a link, owners and grants setup's, the identity recorded) before anything acts on it, quiesce's state writes
    # included. A target that is gone is done.
    if ($targetPins.Count -eq 0) {
      foreach ($t in @($rec.targets)) {
        if (-not (Test-Path -LiteralPath $t.path)) { continue }
        if (-not $t.identity) { throw "$($t.path) appeared after the uninstall verified it as missing: it won't be used or deleted." }
        Open-TrustedAncestors $t.path $Trusted $pins
        $targetPins[$t.path] = New-Object Collections.ArrayList
        $id = Test-Target $t.path $RootOwners $Who $targetPins[$t.path] (& $patternFor $t.path)
        if ($id -ne $t.identity) { throw "$($t.path) isn't the folder the uninstall verified (its identity differs): it won't be used or deleted." }
      }
    }
    # The service must be stopped (or gone) before storage or components are touched, on every run: a record proves
    # earlier work, not the service's state now (a reboot, or Start-Service, may have started it again).
    $ensureStopped = {
      $s = & $Ops.ServiceState
      if ($s -eq 'running') { & $boundary 'before:stop'; & $Ops.StopService; & $boundary 'after:stop'; $s = & $Ops.ServiceState }
      if ($s -ne 'stopped' -and $s -ne 'missing') { throw "The service is $s, not stopped: the uninstall stopped." }
    }

    # ---- Phase 2: the pool, through the helper (quiesce; then the remove plan, approved only for the confirmed VMs). ----
    if ($phase -lt 1) {
      $helper = & $Ops.HelperStatus
      if ($helper) {
        & $boundary 'before:quiesce'
        & $Ops.Quiesce $(if ($Mode -eq 'remove') { 'remove-pool' } else { 'keep-pool' })
        & $boundary 'after:quiesce'
        if ($Mode -eq 'remove') {
          # MC-1583: a fresh remove plan (the helper's state may have moved on; a plan lasts 30 minutes), and its VMs
          # compared with the confirmed ones, always: an empty confirmation never covers a VM made since. Any difference
          # (one added, one replaced, the count alike or not) is asked again before anything is approved; a no stops
          # with the record kept, so a rerun asks again.
          $plan = if ([int]$helper.vms -gt 0) { & $Ops.PlanRemove } else { $null }
          $live = @(if ($plan) { $plan.vms })
          $confirmed = @(if ($rec.PSObject.Properties['pool']) { $rec.pool })
          if ((Get-VmSetKey $live) -ne (Get-VmSetKey $confirmed)) {
            if (-not (& $Ops.ConfirmChange $confirmed $live)) { throw 'The pool changed since you confirmed what goes: nothing more was approved or removed. Run the uninstaller again to decide on the pool as it is now.' }
            $rec | Add-Member -NotePropertyName pool -NotePropertyValue $live -Force
            Write-Teardown $key $rec
            & $boundary 'after:reconfirm'
          }
          if ($live.Count) {
            & $boundary 'before:remove-pool'
            $left = & $Ops.RemovePool $plan.planId
            if ([int]$left -ne 0) { throw "The helper still lists $left VM(s) after the remove: see pool_status. The uninstall stopped; run it again once that is resolved." }
            & $boundary 'after:remove-pool'
            & $say 'The pool is removed.'
          }
        }
      } elseif ($Mode -eq 'remove' -and (Test-Path -LiteralPath $State) -and @($rec.targets | Where-Object { $_.identity }).Count) {
        throw 'The helper isn''t running, so the pool can''t be confirmed removed: start it (Start-Service HyperVMcp) and run this again.'
      }
      & $advance 'pool-removed'
    }

    # ---- Phase 3: stop the service (it stays registered, and the install folder stays). ----
    if ($phase -lt 2) {
      & $ensureStopped
      & $advance 'stopped'
    }

    # ---- Phase 4: storage (remove mode): each recorded target, re-verified by identity, deleted without following links. ----
    if ($phase -lt 3) {
      & $ensureStopped # again, on every run: it may have been started since the phase was recorded
      if ($Mode -eq 'remove') {
        foreach ($t in $rec.targets) {
          if (-not (Test-Path -LiteralPath $t.path)) { continue } # done (or never there)
          if (-not $t.identity) { throw "$($t.path) appeared after the uninstall verified it as missing: it won't be deleted." }
          Open-TrustedAncestors $t.path $Trusted $pins
          $h = [HvMcpStorage]::Open($t.path)
          try {
            if ([HvMcpStorage]::Attributes($h) -band [HvMcpStorage]::FILE_ATTRIBUTE_REPARSE_POINT) { throw "$($t.path) is now a link: it won't be deleted." }
            if ([HvMcpStorage]::Identity($h) -ne $t.identity) { throw "$($t.path) isn't the folder the uninstall verified (its identity differs): it won't be deleted." }
          } finally { $h.Dispose() } # released just before its own deletion; its parents stay pinned
          $pool = Join-Path $t.path 'pool'
          $left = @(if (Test-Path -LiteralPath $pool) { Get-ChildItem -LiteralPath $pool -Force })
          if ($left.Count) { throw "$pool still holds $($left.Count) item(s) ($($left[0].FullName)): the uninstall stopped with the service only stopped. Inspect them (Start-Service HyperVMcp; pool_status), then run this again." }
          & $boundary "before:delete:$($t.path)"
          if ($targetPins.ContainsKey($t.path)) { Close-Pins $targetPins[$t.path] } # its own (and nested) handles, from phase 1
          Remove-TreeNoFollow $t.path
          & $boundary "after:delete:$($t.path)"
          & $say "Removed $($t.path)."
        }
      }
      & $advance 'storage-removed'
    }

    # ---- Phase 5: the service, its rights, the group, the install folder. ----
    if ($phase -lt 4) {
      & $ensureStopped # a running service is stopped before it is deleted
      $s = & $Ops.ServiceState
      if ($s -ne 'missing') { & $boundary 'before:delete-service'; & $Ops.DeleteService; & $boundary 'after:delete-service'; if ((& $Ops.ServiceState) -ne 'missing') { throw 'The service is still registered after its deletion: the uninstall stopped.' } }
      & $Ops.RemoveRights; & $boundary 'after:rights'
      & $Ops.RemoveGroup; & $boundary 'after:group'
      if (Test-Path -LiteralPath $Install) {
        Open-TrustedAncestors $Install $Trusted $pins
        $h = [HvMcpStorage]::Open($Install)
        try { if ([HvMcpStorage]::Attributes($h) -band [HvMcpStorage]::FILE_ATTRIBUTE_REPARSE_POINT) { throw "$Install is a link: it won't be deleted." } } finally { $h.Dispose() }
        # MC-1557: its uninstall\ (and an uninstall.retiring\) stays, the Installed apps entry's route, until the retire
        # phase (appsentry.ps1). An install without one (an older setup's) goes whole, as before.
        $keep = @('uninstall', 'uninstall.retiring')
        foreach ($x in @(Get-ChildItem -LiteralPath $Install -Force | Where-Object { $keep -notcontains $_.Name })) { Remove-TreeNoFollow $x.FullName }
        if (-not @(Get-ChildItem -LiteralPath $Install -Force).Count) { Remove-TreeNoFollow $Install }
        & $boundary 'after:install'
      }
      & $advance 'components-removed'
    }

    # ---- Phase 6: the records (remove: receipts of what is gone, and the InstallId); the record last; the key if empty. ----
    if ($Mode -eq 'remove') {
      $rk = $key.OpenSubKey('Storage', $true)
      if ($rk) {
        foreach ($n in @($rk.GetValueNames())) { if (-not (Test-Path -LiteralPath $n)) { $rk.DeleteValue($n); & $boundary "after:receipt:$n" } }
        $rk.Dispose()
      }
      if ($null -ne $key.GetValue('InstallId')) { $key.DeleteValue('InstallId'); & $boundary 'after:installid' }
    }
    $key.DeleteValue('Teardown')
    & $boundary 'after:record-deleted'
    $rk = $key.OpenSubKey('Storage')
    $emptyStorage = (-not $rk) -or ($rk.ValueCount -eq 0 -and $rk.SubKeyCount -eq 0)
    if ($rk) { $rk.Dispose() }
    $empty = $emptyStorage -and $key.ValueCount -eq 0 -and ($key.SubKeyCount -eq 0 -or ($key.SubKeyCount -eq 1 -and @($key.GetSubKeyNames()) -contains 'Storage'))
    $key.Dispose(); $key = $null
    if ($empty) { $Root.DeleteSubKeyTree($KeyPath, $false); & $say "Removed the registry key $KeyPath." }
    & $say "Uninstall finished ($Mode)."
    return $Mode # MC-1583: the mode chosen (the question's answer, or the recorded one on a resume)
  } finally {
    foreach ($l in $targetPins.Values) { Close-Pins $l }
    Close-Pins $pins
    if ($key) { $key.Dispose() }
  }
}
