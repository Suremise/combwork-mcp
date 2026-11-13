# Exercises setup\teardown.ps1's Invoke-Teardown (uninstall's logic) non-elevated, in a temp folder ($Dir), with fake
# outside actions that are strict (asking one to undo what is already undone is an error) and a crash hook at every
# boundary. Storage is created by setup's own Use-StorageFolder with receipts in a test HKCU key; this user stands in for
# Administrators. Prints one JSON line of results for test\units.test.js.
param([Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\setup\acl.ps1')
. (Join-Path $PSScriptRoot '..\setup\teardown.ps1')
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$SYSTEM = 'S-1-5-18'; $ADMINS = 'S-1-5-32-544'
$trusted = @($SYSTEM, $ADMINS, $script:TrustedInstaller, $me)
$who = @($SYSTEM, $ADMINS, $me)
$HKCU = [Microsoft.Win32.Registry]::CurrentUser
$r = [ordered]@{}
$script:n = 0

# A fresh fixture: an installed helper (as fakes), storage made by setup with receipts, a pool of $vms VMs.
function New-Fixture([int]$vms = 2) {
  $script:n++
  $b = Join-Path $Dir "t$($script:n)"
  New-Item -ItemType Directory -Force $b | Out-Null
  $f = [pscustomobject]@{
    base = $b; state = (Join-Path $b 'state'); disk = (Join-Path $b 'disk'); install = (Join-Path $b 'install')
    keyPath = "Software\hyperv-mcp-test-$([guid]::NewGuid().ToString('n'))"
    sys = @{ service = 'running'; rights = $true; group = $true; helper = $true; vms = $vms; job = $null; approve = $true; removeLeft = 0; deleteFail = $false; confirm = $true; strict = @(); calls = New-Object Collections.ArrayList }
  }
  $pins = New-Object Collections.ArrayList
  $rk = Open-ReceiptKey $HKCU "$($f.keyPath)\Storage" $trusted $me
  try {
    foreach ($p in @($f.state, (Join-Path $f.state 'approvals'), $f.disk)) { [void](Use-StorageFolder $p @("$SYSTEM=FullControl", "$me=FullControl") $me $rk -Allowed $who -Owners $who -Pins $pins) }
  } finally { Close-Pins $pins; $rk.Dispose() }
  $k = $HKCU.OpenSubKey($f.keyPath, $true); $k.SetValue('InstallId', [guid]::NewGuid().ToString('n')); $k.Dispose()
  Set-Content (Join-Path $f.state 'journal.jsonl') '{"t":"epoch"}'
  New-Item -ItemType Directory -Force (Join-Path $f.disk 'images') | Out-Null; Set-Content (Join-Path $f.disk 'images\x.iso') 'iso'
  for ($i = 1; $i -le $vms; $i++) { New-Item -ItemType Directory -Force (Join-Path $f.disk "pool\i-$i") | Out-Null; Set-Content (Join-Path $f.disk "pool\i-$i\disk.vhdx") 'vhd' }
  New-Item -ItemType Directory -Force $f.install | Out-Null; Set-Content (Join-Path $f.install 'helper.js') 'js'
  return $f
}

function New-Ops($f) {
  $s = $f.sys
  $strict = { param($m) $s.strict += $m; throw "STRICT: $m" }.GetNewClosure()
  return @{
    Say = { param($m) }
    ServiceState = { [void]$s.calls.Add('state'); $s.service }.GetNewClosure()
    StopService = { if ($s.service -ne 'running') { & $strict 'stop when not running' }; $s.service = 'stopped'; $s.helper = $false; [void]$s.calls.Add('stop') }.GetNewClosure()
    DeleteService = { if ($s.service -eq 'missing') { & $strict 'delete when missing' }; if ($s.deleteFail) { throw 'sc.exe delete failed (fake)' }; $s.service = 'missing'; [void]$s.calls.Add('delete-service') }.GetNewClosure()
    RemoveRights = { $s.rights = $false; [void]$s.calls.Add('rights') }.GetNewClosure()
    RemoveGroup = { $s.group = $false; [void]$s.calls.Add('group') }.GetNewClosure()
    HelperStatus = { if ($s.helper) { [pscustomobject]@{ vms = $s.vms; job = $s.job } } else { $null } }.GetNewClosure()
    Quiesce = { param($purpose) if (-not $s.helper) { & $strict 'quiesce without a helper' }; [void]$s.calls.Add("quiesce:$purpose") }.GetNewClosure()
    RemovePool = {
      if (-not $s.helper) { & $strict 'remove without a helper' }
      if (-not $s.approve) { throw 'The remove plan was not approved (fake).' }
      if (-not $s.removeLeft) { Get-ChildItem -LiteralPath (Join-Path $f.disk 'pool') -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force }
      $s.vms = $s.removeLeft
      [void]$s.calls.Add('remove-pool')
      return $s.removeLeft
    }.GetNewClosure()
    ConfirmInventory = { param($lines) $s.inventory = $lines; return $s.confirm }.GetNewClosure()
  }
}

function Run($f, [string]$mode = 'remove', [string]$crashAt, [string]$legacy, [string[]]$rootOwners = $who) {
  $script:crashAt = $crashAt
  $crash = {
    param($b)
    if ($script:hookAt -and $b -eq $script:hookAt) { $script:hookAt = $null; & $script:hookDo }
    if ($script:crashAt -and $b -eq $script:crashAt) { $script:crashAt = $null; throw "CRASH:$b" }
  }
  Invoke-Teardown -Mode $mode -State $f.state -Install $f.install -LegacyDiskFolder $legacy -Root $HKCU -KeyPath $f.keyPath `
    -Trusted $trusted -RootOwners $rootOwners -Who $who -KeyOwner $me -Ops (New-Ops $f) -Crash $crash
}
function Try-Run($f, [string]$mode = 'remove', [string]$crashAt, [string]$legacy, [string[]]$rootOwners = $who) {
  try { Run $f $mode $crashAt $legacy $rootOwners; return 'ok' } catch { return $_.Exception.Message }
}
function Gone($f) { -not (Test-Path $f.state) -and -not (Test-Path $f.disk) -and -not (Test-Path $f.install) -and -not $HKCU.OpenSubKey($f.keyPath) -and $f.sys.service -eq 'missing' -and -not $f.sys.rights -and -not $f.sys.group -and -not $f.sys.strict.Count }
function Phase($f) { $k = $HKCU.OpenSubKey($f.keyPath); if (-not $k) { return $null }; try { $v = $k.GetValue('Teardown'); if ($v) { ($v | ConvertFrom-Json).phase } } finally { $k.Dispose() } }

# 1. The whole remove, then a crash at every boundary followed by a rerun to completion.
$f = New-Fixture
$r.full = Try-Run $f
$r.fullGone = Gone $f
$r.fullOrder = ($f.sys.calls | Where-Object { $_ -ne 'state' }) -join ','
$names = @('after:record', 'before:quiesce', 'after:quiesce', 'before:remove-pool', 'after:remove-pool', 'after:phase:pool-removed', 'before:stop', 'after:stop', 'after:phase:stopped',
  'before:delete:STATE', 'after:delete:STATE', 'before:delete:DISK', 'after:delete:DISK', 'after:phase:storage-removed', 'before:delete-service', 'after:delete-service', 'after:rights', 'after:group', 'after:install', 'after:phase:components-removed',
  'after:receipt:STATE', 'after:receipt:APPROVALS', 'after:receipt:DISK', 'after:installid', 'after:record-deleted')
$crashes = [ordered]@{}
foreach ($nm in $names) {
  $f = New-Fixture
  $b = $nm.Replace('STATE', [IO.Path]::GetFullPath($f.state)).Replace('APPROVALS', [IO.Path]::GetFullPath((Join-Path $f.state 'approvals')).ToLowerInvariant()).Replace('DISK', [IO.Path]::GetFullPath($f.disk))
  if ($nm -like 'after:receipt:*') { $b = 'after:receipt:' + $b.Substring(14).ToLowerInvariant() }
  $first = Try-Run $f 'remove' $b
  $second = Try-Run $f
  $crashes[$nm] = [ordered]@{ first = ($first -like "CRASH:*"); second = $second; gone = (Gone $f); strict = ($f.sys.strict -join ';') }
}
$r.crashes = $crashes

# 2. Fail closed: a forged policy.json (with and without a journal) and no receipts: refused, nothing deleted.
$fs = Join-Path $Dir 'forged'; $victim = Join-Path $Dir 'victim'
New-Item -ItemType Directory -Force (Join-Path $fs 'state'), (Join-Path $victim 'images') | Out-Null
Set-Content (Join-Path $victim 'images\keep.txt') 'keep'
Set-Content (Join-Path $fs 'state\policy.json') ('{"diskFolders":["' + $victim.Replace('\', '\\') + '"]}')
$ff = [pscustomobject]@{ state = (Join-Path $fs 'state'); disk = $victim; install = (Join-Path $fs 'install'); keyPath = "Software\hyperv-mcp-test-$([guid]::NewGuid().ToString('n'))"; sys = (New-Fixture 0).sys }
$r.forgedNoJournal = Try-Run $ff
Set-Content (Join-Path $fs 'state\journal.jsonl') '{"t":"epoch"}'
$r.forgedJournal = Try-Run $ff
$r.victimSurvives = Test-Path (Join-Path $victim 'images\keep.txt')
$r.forgedNoKey = -not $HKCU.OpenSubKey($ff.keyPath)

# 3. Identity mismatch (the disk folder deleted and made again), and a target replaced by a junction: refused, nothing changed.
$f = New-Fixture
Remove-Item -LiteralPath $f.disk -Recurse -Force
$sec = New-Object Security.AccessControl.DirectorySecurity; $sec.SetAccessRuleProtection($true, $false)
$sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $me), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))); $sec.SetOwner((New-Object Security.Principal.SecurityIdentifier $me))
[void][HvMcpStorage]::CreateSecure($f.disk, $sec.GetSecurityDescriptorBinaryForm())
$r.mismatch = Try-Run $f
$r.mismatchUnchanged = (Test-Path $f.state) -and $null -eq (Phase $f) -and $f.sys.service -eq 'running'
$f = New-Fixture
Remove-Item -LiteralPath $f.disk -Recurse -Force
$elsewhere = Join-Path $f.base 'elsewhere'; New-Item -ItemType Directory -Force $elsewhere | Out-Null; Set-Content (Join-Path $elsewhere 'keep.txt') 'keep'
& cmd.exe /c mklink /J $f.disk $elsewhere | Out-Null
$r.reparseTarget = Try-Run $f
$r.reparseKept = Test-Path (Join-Path $elsewhere 'keep.txt')

# 4. A junction inside a target: refused at verification (nothing changed); one slipped in after verification is removed as
# a link, never followed.
$f = New-Fixture
$out = Join-Path $f.base 'outside'; New-Item -ItemType Directory -Force $out | Out-Null; Set-Content (Join-Path $out 'keep.txt') 'keep'
& cmd.exe /c mklink /J (Join-Path $f.disk 'images\escape') $out | Out-Null
$r.innerJunction = Try-Run $f
$r.innerJunctionUnchanged = (Test-Path $f.disk) -and $null -eq (Phase $f)
$f = New-Fixture
$out2 = Join-Path $f.base 'outside'; New-Item -ItemType Directory -Force $out2 | Out-Null; Set-Content (Join-Path $out2 'keep.txt') 'keep'
$script:hookAt = 'after:phase:stopped'; $script:hookDo = { & cmd.exe /c mklink /J (Join-Path $f.disk 'images\escape') $out2 | Out-Null }.GetNewClosure()
$r.lateJunction = Try-Run $f
$r.lateJunctionKept = Test-Path (Join-Path $out2 'keep.txt')
$r.lateJunctionGone = Gone $f

# 5. A leftover in pool\ while the helper reports no VMs: refused at phase 1, nothing changed.
$f = New-Fixture 0
New-Item -ItemType Directory -Force (Join-Path $f.disk 'pool\stray') | Out-Null
$r.leftover = Try-Run $f
$r.leftoverUnchanged = $null -eq (Phase $f) -and $f.sys.service -eq 'running' -and (Test-Path $f.disk)

# 6. Cancelled approval; a remove job that leaves a VM; a failing sc delete: each stops, and a rerun completes.
$f = New-Fixture; $f.sys.approve = $false
$r.cancelled = Try-Run $f; $r.cancelledPhase = Phase $f
$f.sys.approve = $true; $r.cancelledRerun = Try-Run $f; $r.cancelledGone = Gone $f
$f = New-Fixture; $f.sys.removeLeft = 1
$r.vmLeft = Try-Run $f; $r.vmLeftPhase = Phase $f
$f.sys.removeLeft = 0; $f.sys.vms = 2; $r.vmLeftRerun = Try-Run $f; $r.vmLeftGone = Gone $f
$f = New-Fixture; $f.sys.deleteFail = $true
$r.scFail = Try-Run $f; $r.scFailPhase = Phase $f; $r.scFailServiceStopped = $f.sys.service -eq 'stopped'
$f.sys.deleteFail = $false; $r.scFailRerun = Try-Run $f; $r.scFailGone = Gone $f

# 7. KeepPool → reinstall → RemovePool; a mismatched resume; install refused during a teardown.
$f = New-Fixture
$r.keep = Try-Run $f 'keep'
$r.keepStorageKept = (Test-Path $f.state) -and (Test-Path (Join-Path $f.disk 'pool\i-1')) -and $null -eq (Phase $f) -and $f.sys.service -eq 'missing'
$k = $HKCU.OpenSubKey("$($f.keyPath)\Storage"); $r.keepReceiptsKept = $k.ValueCount; $k.Dispose()
$k = $HKCU.OpenSubKey($f.keyPath, $true); $k.SetValue('InstallId', [guid]::NewGuid().ToString('n')); $k.Dispose() # reinstall
$f.sys.service = 'running'; $f.sys.helper = $true; $f.sys.rights = $true; $f.sys.group = $true
New-Item -ItemType Directory -Force $f.install | Out-Null
$r.keepThenRemove = Try-Run $f; $r.keepThenRemoveGone = Gone $f
$f = New-Fixture
$r.keepCrash = Try-Run $f 'keep' 'after:phase:stopped'
$r.mismatchMode = Try-Run $f 'remove'
$r.mismatchLegacy = Try-Run $f 'keep' $null ($f.disk)
try { Assert-NoTeardown $HKCU $f.keyPath; $r.installDuring = 'allowed' } catch { $r.installDuring = $_.Exception.Message }
$r.keepFinish = Try-Run $f 'keep'
try { Assert-NoTeardown $HKCU $f.keyPath; $r.installAfter = 'allowed' } catch { $r.installAfter = $_.Exception.Message }

# 8. Legacy: no receipts. Not admin-owned → refused; confirmed → removed (InstallId bootstrapped, then gone); not confirmed → nothing changed.
function New-Legacy {
  $script:n++
  $b = Join-Path $Dir "legacy$($script:n)"
  $f = [pscustomobject]@{ base = $b; state = (Join-Path $b 'state'); disk = (Join-Path $b 'disk'); install = (Join-Path $b 'install'); keyPath = "Software\hyperv-mcp-test-$([guid]::NewGuid().ToString('n'))"; sys = (New-Fixture 0).sys }
  foreach ($p in $f.state, $f.disk) { Set-ExclusiveAcl $p @("$SYSTEM=FullControl", "$me=FullControl") }
  Set-Content (Join-Path $f.state 'journal.jsonl') '{"t":"epoch"}'
  New-Item -ItemType Directory -Force $f.install | Out-Null
  return $f
}
$f = New-Legacy
$r.legacyNotAdmin = Try-Run $f 'remove' $null $f.disk @($SYSTEM, $ADMINS)
$r.legacyNotAdminNoKey = -not $HKCU.OpenSubKey($f.keyPath)
$f = New-Legacy; $f.sys.confirm = $false
$r.legacyDeclined = Try-Run $f 'remove' $null $f.disk
$r.legacyDeclinedUnchanged = (Test-Path $f.state) -and -not $HKCU.OpenSubKey($f.keyPath)
$f = New-Legacy
$r.legacyConfirmed = Try-Run $f 'remove' $null $f.disk
$r.legacyInventory = $f.sys.inventory -join ' | '
$r.legacyGone = Gone $f

# 9. The service started again after 'stopped' (a reboot, or Start-Service), then a rerun: it is stopped again before
# the first deletion. And after 'storage-removed': stopped before it is deleted.
$f = New-Fixture
$r.restartCrash = Try-Run $f 'remove' 'after:phase:stopped'
$f.sys.service = 'running'; $f.sys.helper = $true
$mark = $f.sys.calls.Count
$script:hookAt = 'before:delete:' + [IO.Path]::GetFullPath($f.state); $script:hookDo = { [void]$f.sys.calls.Add('deleting') }.GetNewClosure()
$r.restartRerun = Try-Run $f
$later = @($f.sys.calls | Select-Object -Skip $mark | Where-Object { $_ -ne 'state' })
$r.restartOrder = $later -join ','
$r.restartGone = Gone $f
$f = New-Fixture
$r.restart2Crash = Try-Run $f 'remove' 'after:phase:storage-removed'
$f.sys.service = 'running'
$mark = $f.sys.calls.Count
$r.restart2Rerun = Try-Run $f
$r.restart2Order = (@($f.sys.calls | Select-Object -Skip $mark | Where-Object { $_ -ne 'state' })) -join ','
$r.restart2Gone = Gone $f

# 10. Keep mode verifies the storage too, and acts on nothing it refuses: an untrusted legacy owner, a junction in the
# state folder, a receipt mismatch. No side-effect callback runs.
$sideEffects = { param($f) @($f.sys.calls | Where-Object { $_ -ne 'state' }).Count }
$f = New-Legacy
$r.keepLegacyNotAdmin = Try-Run $f 'keep' $null $f.disk @($SYSTEM, $ADMINS)
$r.keepLegacyNotAdminQuiet = (& $sideEffects $f) -eq 0 -and -not $HKCU.OpenSubKey($f.keyPath)
$f = New-Fixture
$jt = Join-Path $f.base 'jt'; New-Item -ItemType Directory -Force $jt | Out-Null
& cmd.exe /c mklink /J (Join-Path $f.state 'approvals\escape') $jt | Out-Null
$r.keepJunction = Try-Run $f 'keep'
$r.keepJunctionQuiet = (& $sideEffects $f) -eq 0 -and $null -eq (Phase $f)
$f = New-Fixture
Remove-Item -LiteralPath $f.state -Recurse -Force
[void][HvMcpStorage]::CreateSecure($f.state, $sec.GetSecurityDescriptorBinaryForm())
$r.keepMismatch = Try-Run $f 'keep'
$r.keepMismatchQuiet = (& $sideEffects $f) -eq 0 -and $null -eq (Phase $f)

# 11. A resumed run re-verifies before acting: a junction slipped into the state folder after the record is refused
# before quiesce writes there.
$f = New-Fixture
$r.resumeCrash = Try-Run $f 'keep' 'after:record'
$jt2 = Join-Path $f.base 'jt2'; New-Item -ItemType Directory -Force $jt2 | Out-Null
& cmd.exe /c mklink /J (Join-Path $f.state 'approvals\escape') $jt2 | Out-Null
$r.resumeTampered = Try-Run $f 'keep'
$r.resumeTamperedQuiet = (& $sideEffects $f) -eq 0 -and (Phase $f) -eq 'verified'

[Console]::Out.WriteLine('RESULT:' + (ConvertTo-Json $r -Compress -Depth 6))
