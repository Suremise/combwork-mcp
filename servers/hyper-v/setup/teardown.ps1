# Uninstall's teardown (design MC-1488/s66 + s68), dot-sourced by uninstall.ps1 after acl.ps1, and tested non-elevated by
# test\teardown-check.ps1 with fake outside actions and a crash hook at every boundary.
#
# What it may delete: only storage verified, before any change, as setup's own.
#   - A receipted install: exactly the folders with receipts (identity must match; owners and grants setup's).
#   - A legacy install (an older setup's, no receipts): the state folder and the disk folder the admin names, each
#     checked (owned by Administrators/SYSTEM, grants only for the expected accounts, no links, safe parents) and then
#     confirmed by the admin typing DELETE for the printed inventory. That check proves present access control only, not
#     history: the authority for a legacy deletion is the admin's confirmation. Old policy or journal bytes never add a
#     target, and never become receipts.
#   - No trust evidence: refused, nothing changed.
# In what order: verify (no change) → record → pool (through the helper: quiesce, the approved remove plan) → stop the
# service (it stays registered) → storage → the service, rights, group and install folder → receipts, InstallId, the
# record. The record (HKLM\SOFTWARE\hyperv-mcp, value Teardown) is bound to its install generation (InstallId), its mode,
# its legacy folder and its targets' identities; a rerun resumes it only with the same options, at its phase. Every action
# checks the current state and does nothing when its work is done, so a rerun after a kill anywhere tolerates what was
# already removed. Errors are never swallowed: the record stays at the last completed phase.

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
    if ($r) { $m = try { $r | ConvertFrom-Json } catch { $null }; throw "An uninstall is unfinished (mode $($m.mode), at $($m.phase)): finish it first, by running uninstall.ps1 again with its recorded options$(if ($m.legacyDiskFolder) { " (-LegacyDiskFolder $($m.legacyDiskFolder))" }). Nothing was changed." }
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

# Verifies one deletion target as it is now (its parents already pinned): not a link; owner in $RootOwners; contents
# with only $Who (and per-VM SIDs) as owners and grantees. Returns its identity, or $null when it is missing.
# The target's handle goes in $Pins (its own list, released just before the target is deleted).
function Test-Target([string]$Path, [string[]]$RootOwners, [string[]]$Who, [Collections.ArrayList]$Pins) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $h = [HvMcpStorage]::Open($Path)
  [void]$Pins.Add($h)
  if ([HvMcpStorage]::Attributes($h) -band [HvMcpStorage]::FILE_ATTRIBUTE_REPARSE_POINT) { throw "$Path is a link or junction: refusing to delete through it. Nothing was changed." }
  $owner = Get-OwnerSid (Get-HandleSecurity $h)
  if ($RootOwners -notcontains $owner) { throw "$Path is owned by $owner, not Administrators or SYSTEM: it isn't setup's, so it won't be deleted. Nothing was changed." }
  $bad = @(Test-ExclusiveAcl $Path -Allowed $Who -Owners $Who -AllowPattern '^S-1-5-83-')
  if ($bad.Count) { throw "$Path isn't as setup and the helper leave it ($($bad[0])$(if ($bad.Count -gt 1) { "; and $($bad.Count - 1) more" })), so it won't be deleted. Nothing was changed." }
  return [HvMcpStorage]::Identity($h)
}

function Invoke-Teardown {
  param(
    [ValidateSet('keep', 'remove')][string]$Mode,
    [string]$State, [string]$Install, [string]$LegacyDiskFolder,
    [Microsoft.Win32.RegistryKey]$Root, [string]$KeyPath,
    [string[]]$Trusted,     # may own/write the registry key and the parents: SYSTEM, Administrators, TrustedInstaller
    [string[]]$RootOwners,  # may own a deletion target: Administrators, SYSTEM
    [string[]]$Who,         # may own or hold grants inside a target: SYSTEM, Administrators, the helper's account
    [string]$KeyOwner,      # owner of a key created for a legacy teardown (Administrators)
    [hashtable]$Ops,        # ServiceState, StopService, DeleteService, RemoveRights, RemoveGroup, HelperStatus, Quiesce, RemovePool, ConfirmInventory, Say
    [scriptblock]$Crash     # test hook: run at every boundary with its name
  )
  $boundary = { param($n) if ($Crash) { & $Crash $n } }
  $say = { param($m) if ($Ops.Say) { & $Ops.Say $m } }
  $legacy = [bool]$LegacyDiskFolder
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
      if ($rec.mode -ne $Mode -or [string]$rec.legacyDiskFolder -ne [string]$LegacyDiskFolder) {
        throw "An unfinished uninstall was started with other options (mode $($rec.mode)$(if ($rec.legacyDiskFolder) { ", -LegacyDiskFolder $($rec.legacyDiskFolder)" })): run it again with those. Nothing was changed."
      }
      # Its InstallId is deleted only in the last phase (after components-removed): then a missing one is this teardown's own doing.
      if ($rec.installId -ne $installId -and -not ($null -eq $installId -and $rec.phase -eq 'components-removed')) { throw 'The unfinished uninstall belongs to another installation (its InstallId differs): nothing was changed.' }
      & $say "Resuming the uninstall at its '$($rec.phase)' phase."
    } else {
      # The tail of a finished uninstall (killed after its record was deleted): no record, no InstallId, no receipts. Only
      # the empty key is left.
      if ($key -and -not $installId) {
        $rk = $key.OpenSubKey('Storage'); $n = if ($rk) { $rk.ValueCount } else { 0 }; if ($rk) { $rk.Dispose() }
        if (-not $n -and $key.ValueCount -eq 0 -and -not $legacy) {
          $key.Dispose(); $key = $null
          $Root.DeleteSubKeyTree($KeyPath, $false)
          & $say 'Removed the empty registry key left by a finished uninstall.'
          return
        }
      }
      # ---- Phase 1: verify, changing nothing. ----
      $targets = @()
      if ($Mode -eq 'remove') {
        $paths = @()
        if ($legacy) {
          $paths = @($State, $LegacyDiskFolder) # its location policy (a top-level folder on a fixed drive) is uninstall.ps1's
        } else {
          if (-not $key) { throw 'There are no storage receipts (setup''s records of the folders it created), so nothing is known to be setup''s: no storage will be deleted. For an install made by an older setup, name its disk folder with -LegacyDiskFolder. Nothing was changed.' }
          $rk = $key.OpenSubKey('Storage')
          $receipts = @{}
          if ($rk) { foreach ($n in $rk.GetValueNames()) { $receipts[$n] = $rk.GetValue($n) }; $rk.Dispose() }
          if (-not $receipts.Count) { throw 'The storage receipts key holds no receipts: no storage is known to be setup''s. Nothing was changed.' }
          $paths = @($receipts.Keys)
        }
        # Deduplicate and drop targets nested in another (a state folder holds its approvals\).
        $full = @($paths | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') } | Sort-Object -Unique)
        $top = @($full | Where-Object { $p = $_; -not ($full | Where-Object { $_ -ne $p -and $p.ToLowerInvariant().StartsWith($_.ToLowerInvariant() + '\') }) })
        foreach ($p in $top) {
          Open-TrustedAncestors $p $Trusted $pins
          $targetPins[$p] = New-Object Collections.ArrayList
          $id = Test-Target $p $RootOwners $Who $targetPins[$p]
          if (-not $legacy) {
            $want = $receipts[$p.ToLowerInvariant()]
            if ($id -and $id -ne $want) { throw "$p isn't the folder setup created (its identity differs from its receipt): it won't be deleted. Nothing was changed." }
          }
          $targets += [pscustomobject]@{ path = $p; identity = $id }
        }
        # A nested receipted target (approvals\) must match its receipt too, though it goes with its parent.
        if (-not $legacy) {
          foreach ($p in ($full | Where-Object { $top -notcontains $_ })) {
            if (Test-Path -LiteralPath $p) {
              $h = [HvMcpStorage]::Open($p)
              $holder = $top | Where-Object { $p.ToLowerInvariant().StartsWith($_.ToLowerInvariant() + '\') } | Select-Object -First 1
              [void]$targetPins[$holder].Add($h)
              if ([HvMcpStorage]::Identity($h) -ne $receipts[$p.ToLowerInvariant()]) { throw "$p isn't the folder setup created (its identity differs from its receipt). Nothing was changed." }
            }
          }
        }
      }
      $helper = & $Ops.HelperStatus
      if ($Mode -eq 'remove') {
        $vms = if ($helper) { [int]$helper.vms } else { $null }
        $stateHere = Test-Path -LiteralPath $State
        if ($null -eq $vms -and $stateHere) { throw 'The helper isn''t running, so its VMs can''t be confirmed removed: start it (Start-Service HyperVMcp) and run this again. Nothing was changed.' }
        if ($helper -and $helper.job) { throw "A pool job is running ($($helper.job)): wait for it, then run this again. Nothing was changed." }
        foreach ($t in $targets) {
          $pool = Join-Path $t.path 'pool'
          $left = @(if (Test-Path -LiteralPath $pool) { Get-ChildItem -LiteralPath $pool -Force })
          if ($left.Count -and -not $vms) { throw "$pool still holds $($left.Count) item(s) ($($left[0].FullName)) while the helper reports no VMs: inspect them first. Nothing was changed." }
        }
      } elseif ($helper -and $helper.job) { throw "A pool job is running ($($helper.job)): wait for it, then run this again. Nothing was changed." }
      # A legacy transaction (deleting, or keeping, an older setup's storage) is the admin's explicit decision on the
      # printed inventory; only then may a record and an InstallId be written for it.
      if ($legacy) {
        $inv = if ($Mode -eq 'remove') { @($targets | Where-Object { $_.identity } | ForEach-Object { "DELETE $(Get-Inventory $_.path)" }) }
          else { @(@($State, $LegacyDiskFolder) | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { "KEEP $(Get-Inventory $_)" }) }
        if (-not (& $Ops.ConfirmInventory $inv)) { throw 'The inventory was not confirmed: nothing was changed.' }
      }
      # The record, written once (its mode, options, generation and targets never change), in the protected key.
      if (-not $key) {
        if (-not $legacy -and $Mode -eq 'remove') { throw 'internal: no key' }
        $rk = Open-ReceiptKey $Root "$KeyPath\Storage" $Trusted $KeyOwner; $rk.Dispose()
        $key = $Root.OpenSubKey($KeyPath, $true)
      }
      if (-not $installId) {
        if (-not $legacy) { throw 'The installation has no InstallId (it wasn''t made by this setup): for an older install, name its disk folder with -LegacyDiskFolder. Nothing was changed.' }
        $installId = [guid]::NewGuid().ToString('n') # bootstrapped only inside the confirmed legacy transaction
        $key.SetValue('InstallId', $installId)
      }
      $rec = [pscustomobject]@{ id = [guid]::NewGuid().ToString('n'); installId = $installId; mode = $Mode; legacyDiskFolder = [string]$LegacyDiskFolder; targets = $targets; phase = 'verified' }
      Write-Teardown $key $rec
      & $boundary 'after:record'
      & $say "Verified; the uninstall record is written ($Mode)."
    }
    $phase = [array]::IndexOf($script:PHASES, $rec.phase)
    $advance = { param($p) $rec.phase = $p; Write-Teardown $key $rec; & $boundary "after:phase:$p" }

    # ---- Phase 2: the pool, through the helper (quiesce; the approved exact-plan remove). ----
    if ($phase -lt 1) {
      $helper = & $Ops.HelperStatus
      if ($helper) {
        & $boundary 'before:quiesce'
        & $Ops.Quiesce $(if ($Mode -eq 'remove') { 'remove-pool' } else { 'keep-pool' })
        & $boundary 'after:quiesce'
        if ($Mode -eq 'remove' -and [int]$helper.vms -gt 0) {
          & $boundary 'before:remove-pool'
          $left = & $Ops.RemovePool
          if ([int]$left -ne 0) { throw "The helper still lists $left VM(s) after the remove: see pool_status. The uninstall stopped; run it again once that is resolved." }
          & $boundary 'after:remove-pool'
          & $say 'The pool is removed.'
        }
      } elseif ($Mode -eq 'remove' -and (Test-Path -LiteralPath $State) -and @($rec.targets | Where-Object { $_.identity }).Count) {
        throw 'The helper isn''t running, so the pool can''t be confirmed removed: start it (Start-Service HyperVMcp) and run this again.'
      }
      & $advance 'pool-removed'
    }

    # ---- Phase 3: stop the service (it stays registered, and the install folder stays). ----
    if ($phase -lt 2) {
      $s = & $Ops.ServiceState
      if ($s -eq 'running') { & $boundary 'before:stop'; & $Ops.StopService; & $boundary 'after:stop'; $s = & $Ops.ServiceState }
      if ($s -ne 'stopped' -and $s -ne 'missing') { throw "The service is $s, not stopped: the uninstall stopped." }
      & $advance 'stopped'
    }

    # ---- Phase 4: storage (remove mode): each recorded target, re-verified by identity, deleted without following links. ----
    if ($phase -lt 3) {
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
      $s = & $Ops.ServiceState
      if ($s -ne 'missing') { & $boundary 'before:delete-service'; & $Ops.DeleteService; & $boundary 'after:delete-service'; if ((& $Ops.ServiceState) -ne 'missing') { throw 'The service is still registered after its deletion: the uninstall stopped.' } }
      & $Ops.RemoveRights; & $boundary 'after:rights'
      & $Ops.RemoveGroup; & $boundary 'after:group'
      if (Test-Path -LiteralPath $Install) {
        Open-TrustedAncestors $Install $Trusted $pins
        $h = [HvMcpStorage]::Open($Install)
        try { if ([HvMcpStorage]::Attributes($h) -band [HvMcpStorage]::FILE_ATTRIBUTE_REPARSE_POINT) { throw "$Install is a link: it won't be deleted." } } finally { $h.Dispose() }
        Remove-TreeNoFollow $Install
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
  } finally {
    foreach ($l in $targetPins.Values) { Close-Pins $l }
    Close-Pins $pins
    if ($key) { $key.Dispose() }
  }
}
