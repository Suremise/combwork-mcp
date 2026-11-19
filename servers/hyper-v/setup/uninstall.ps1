# Removes the hyper-v MCP helper. Settings > Apps > Installed apps > "Hyper-V MCP helper and test VMs" > Uninstall runs
# it (MC-1557), or one line in an admin terminal (cmd or PowerShell, the same line, MC-1575), from the installed copy
# (no repo needed) or the repo's:
#   cmd /c call "C:\Program Files\hyperv-mcp\uninstall.cmd"
#   cmd /c call "<repo>\servers\hyper-v\setup\uninstall.cmd" -KeepPool
#   cmd /c call "<repo>\servers\hyper-v\setup\uninstall.cmd" -RemovePool
# MC-1583: it verifies first, changing nothing, then shows what goes (the VMs as the helper's own remove plan names them,
# each folder with what it holds, the service, group, install folder and Installed apps entry) and asks once: REMOVE to
# remove everything, KEEP to keep the pool (with -RemovePool or -KeepPool, only that one). That answer is the approval of
# the helper's remove plan, for exactly the VMs shown: if the pool changes before they go, it asks again. -WhatIf says
# what would go and changes nothing (no record, no approval, no service change). An install from before storage receipts
# (only the unreleased builds of 13 Nov) is refused: the README's Uninstall gives its manual steps.
#
#   -KeepPool   removes the service, its rights, the group and the code, and KEEPS the pool's VMs, the helper's state and
#               the disk folders, with their storage receipts: running setup again recognises them.
#   -RemovePool removes the pool first, through the helper's own journalled remove, then the storage setup created (only
#               folders it can verify as setup's: see teardown.ps1), then everything else.
# The steps and their order, the record that lets an interrupted uninstall be finished by running it again with the same
# options, and what may be deleted, are in teardown.ps1. The Installed apps entry, its launcher and the last phase that
# retires the uninstaller itself are in appsentry.ps1.
#   -Interactive the question (the default with neither option); -Retire only the last phase (the entry's launcher runs
#   it from uninstall.retiring\); -FromCopy internal: run from the protected temporary copy of an installed uninstaller.
param([switch]$KeepPool, [switch]$RemovePool, [switch]$Interactive, [switch]$WhatIf, [switch]$Retire, [ValidateSet('Service', 'Direct')][string]$Mode = 'Service', [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name, [string]$FromCopy)
$ErrorActionPreference = 'Stop'
# Runs under Windows PowerShell 5.1 or PowerShell 7 (MC-1575). Under 5.1 started from a PowerShell 7 window, it
# inherits PS7's module folders and can't load its own Get-Acl: drop them (only under 5.1: they are 7's own).
if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '(?<!Windows)PowerShell\\(\d[^\\]*\\)?Modules\\?$' }) -join ';' }
function Step($m) { Write-Host "- $m" }
function PipeOpen { return [bool]([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -ieq '\\.\pipe\hyperv-mcp' }) }

$me = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an admin terminal (Run as administrator).' }
if ($KeepPool -and $RemovePool) { throw 'Choose -KeepPool or -RemovePool, not both.' }
. (Join-Path $PSScriptRoot 'acl.ps1')
. (Join-Path $PSScriptRoot 'teardown.ps1')
. (Join-Path $PSScriptRoot 'appsentry.ps1')

$install = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'hyperv-mcp'
$state = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'hyperv-mcp'
$svc = 'HyperVMcp'
$svcAccount = "NT SERVICE\$svc"
$groupName = 'Hyper-V MCP Users'
$HVADMINS = 'S-1-5-32-578'
$SYSTEM = 'S-1-5-18'; $ADMINS = 'S-1-5-32-544'

# MC-1557: an installed uninstaller (under the install folder) runs from a protected temporary copy, so it can remove
# its own folder and nothing holds it open: the same arguments, then the copy is removed.
$here = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
# MC-1567: an interrupted run's copy (its window closed before its finally) is removed by the next run, only when it is
# exactly such a copy and no uninstall is still running from it (appsentry.ps1, Remove-StaleProtectedCopies).
if (-not $FromCopy -and -not $WhatIf) {
  foreach ($l in @(Remove-StaleProtectedCopies (Join-Path $env:SystemRoot 'Temp') -Owners @($ADMINS) -Grants @($SYSTEM, $ADMINS))) { Step "An earlier run's temporary copy: $l." }
}
if (-not $FromCopy -and $here.ToLowerInvariant().StartsWith($install.ToLowerInvariant() + '\')) {
  $tmp = New-ProtectedCopy (Join-Path $env:SystemRoot 'Temp') @($script:RetiringSet | ForEach-Object { Join-Path $here $_ }) -Owners @($ADMINS) -Grants @($SYSTEM, $ADMINS) -SetOwner
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tmp 'uninstall.ps1'))
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [Management.Automation.SwitchParameter]) { if ($kv.Value.IsPresent) { $argList += "-$($kv.Key)" } } else { $argList += "-$($kv.Key)"; $argList += [string]$kv.Value }
  }
  $argList += @('-FromCopy', $here)
  Push-Location -LiteralPath $tmp
  try { & (Get-PsEngine) @argList; $code = $LASTEXITCODE } finally { Pop-Location; Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  exit $code
}
$runnerSid = if ($Mode -eq 'Service') {
  $line = (& sc.exe showsid $svc) | Where-Object { $_ -match 'SERVICE SID:\s*(S-1-5-80-[\d-]+)' } | Select-Object -First 1
  if (-not $line) { throw "sc.exe showsid $svc gave no service SID." }
  $Matches[1]
} else { (New-Object Security.Principal.NTAccount $User).Translate([Security.Principal.SecurityIdentifier]).Value }

# One request to the helper over its pipe (Administrators may open it).
function Invoke-Helper([string]$op, $hvArgs = @{}) {
  $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', 'hyperv-mcp', [IO.Pipes.PipeDirection]::InOut)
  $pipe.Connect(10000)
  try {
    $w = New-Object IO.StreamWriter($pipe, (New-Object Text.UTF8Encoding $false)); $w.AutoFlush = $true; $w.NewLine = "`n"
    $r = New-Object IO.StreamReader($pipe, [Text.Encoding]::UTF8)
    $w.WriteLine((@{ id = 1; op = $op; args = $hvArgs } | ConvertTo-Json -Compress -Depth 5))
    $ans = $r.ReadLine() | ConvertFrom-Json
    if (-not $ans.ok) { throw "helper: $($ans.error)" }
    return $ans.result
  } finally { $pipe.Dispose() }
}

# The service's state: 'running', 'stopped' or 'missing'. Anything else, or a query that fails for another reason, is
# an error, never 'missing'.
function Get-ServiceState {
  $out = & sc.exe query $svc 2>&1
  if ($LASTEXITCODE -eq 1060) { return 'missing' } # ERROR_SERVICE_DOES_NOT_EXIST
  if ($LASTEXITCODE -ne 0) { throw "sc.exe query $svc failed ($LASTEXITCODE): $out" }
  $st = ($out | Where-Object { $_ -match 'STATE\s*:\s*\d+\s+(\w+)' } | Select-Object -First 1)
  if (-not $st) { throw "sc.exe query $svc gave no state: $out" }
  switch ($Matches[1]) { 'RUNNING' { 'running' } 'STOPPED' { 'stopped' } default { throw "The service is $($Matches[1]): wait for it to settle, then run this again." } }
}

$ops = @{
  Say = { param($m) Step $m }
  ServiceState = { if ($Mode -eq 'Direct') { 'missing' } else { Get-ServiceState } }
  StopService = {
    Stop-Service $svc -Force
    (Get-Service $svc).WaitForStatus('Stopped', [TimeSpan]::FromMinutes(5)) # MC-1558: the helper may be mid-operation
    Step "Service $svc stopped."
  }
  DeleteService = {
    & sc.exe delete $svc | Out-Null
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1072) { throw "sc.exe delete $svc failed ($LASTEXITCODE)." } # 1072: marked for deletion
    $t = (Get-Date).AddSeconds(30)
    while ((Get-ServiceState) -ne 'missing' -and (Get-Date) -lt $t) { Start-Sleep 1 }
    Step "Service $svc removed."
  }
  RemoveRights = {
    foreach ($m in @($svcAccount) + $(if ($Mode -eq 'Direct') { @($User) } else { @() })) {
      if (Get-LocalGroupMember -SID $HVADMINS -ErrorAction Stop | Where-Object { $_.Name -eq $m }) { Remove-LocalGroupMember -SID $HVADMINS -Member $m; Step "$m removed from Hyper-V Administrators." }
    }
    # MC-1501: setup's registration of the Linux guests' vsock port 22, only if it is still setup's (its ElementName).
    $gcs = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\00000016-facb-11e6-bd58-64006a7986d3'
    if ((Get-ItemProperty -Path $gcs -ErrorAction SilentlyContinue).ElementName -eq 'hyper-v MCP: SSH to Linux guests (vsock port 22)') { Remove-Item -Path $gcs -Force; Step 'The Linux guests'' vsock port registration removed.' }
  }
  RemoveGroup = { if (Get-LocalGroup -Name $groupName -ErrorAction SilentlyContinue) { Remove-LocalGroup -Name $groupName; Step "Group '$groupName' removed." } }
  HelperStatus = {
    if ($Mode -eq 'Direct' -or -not (PipeOpen)) { return $null }
    $st = Invoke-Helper 'status'
    return [pscustomobject]@{ vms = [int]$st.data.vms; job = $st.data.job }
  }
  Quiesce = {
    param($purpose)
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $nb = New-Object byte[] 16; $rng.GetBytes($nb)
    $epoch = (Get-Content -LiteralPath (Join-Path $state 'journal.jsonl') -TotalCount 1 | ConvertFrom-Json).epoch
    $q = [ordered]@{ nonce = (-join ($nb | ForEach-Object { $_.ToString('x2') })); epoch = $epoch; expires = [DateTimeOffset]::UtcNow.AddMinutes(10).ToString('o'); purpose = $purpose } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $state 'approvals\quiesce.json'), $q, (New-Object Text.UTF8Encoding $false))
    try { $res = Invoke-Helper 'quiesce' } finally { Remove-Item -LiteralPath (Join-Path $state 'approvals\quiesce.json') -Force -ErrorAction SilentlyContinue }
    if ($res.isError) { throw "$($res.text) Uninstall stopped: fix or remove that VM, then run this again." }
    Step $res.text
  }
  # MC-1583: the helper's remove plan (it changes nothing), and its VMs as the plan file it wrote names them.
  PlanRemove = {
    $plan = Invoke-Helper 'pool_plan' @{ action = 'remove' }
    $id = [string]$plan.data.planId
    if ($id -notmatch '^p-[0-9a-f]{16}$') { throw "The helper gave no remove plan: $($plan.text)" }
    $p = [IO.File]::ReadAllText((Join-Path $state "plans\$id.json"), [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($p.id -ne $id -or $p.op -ne 'remove') { throw "The helper's plan $id isn't a remove plan." }
    [pscustomobject]@{ planId = $id; vms = @($p.remove | Where-Object { $_ } | ForEach-Object { [pscustomobject]@{ vmId = [string]$_.vmId; name = [string]$_.name; folder = [string]$_.folder } }) }
  }
  # MC-1583: the one question, after verification: what goes and what stays, then REMOVE or KEEP.
  Confirm = {
    param($info)
    Write-Host ''
    if ($info.mode -ne 'keep') {
      Write-Host 'Remove everything (REMOVE):' -ForegroundColor Yellow
      if ($info.removeWhy) { Write-Host "  not possible now: $($info.removeWhy)" }
      else {
        $vms = @($info.vms)
        Write-Host "  the pool's $($vms.Count) VM(s), with their checkpoints$(if (-not $vms.Count) { ' (none)' })"
        foreach ($v in $vms) { Write-Host "    $($v.name) (id $($v.vmId)) in $($v.folder)" }
        foreach ($f in @($info.folders)) { Write-Host "  the folder $f" }
        Write-Host '  setup''s host-mode switch, the service, its rights, the group, the install folder, the registry records and the Installed apps entry'
      }
    }
    if ($info.mode -ne 'remove') {
      Write-Host 'Keep the pool (KEEP):' -ForegroundColor Yellow
      Write-Host '  keeps the VMs, their checkpoints, cached images, the disk folders and the helper''s state, with their records (setup recognises them when run again);'
      Write-Host '  removes the service, its rights, the group, the vsock registration, setup''s host-mode switch (setup makes it again), the install folder and the Installed apps entry'
    }
    $ask = switch ($info.mode) { 'remove' { 'Type REMOVE to go ahead' } 'keep' { 'Type KEEP to go ahead' } default { 'Type REMOVE to remove everything, or KEEP to keep the pool' } }
    $a = (Read-Host "$ask (anything else cancels, with nothing changed)").Trim()
    if ($a -ceq 'REMOVE' -and $info.mode -ne 'keep') { 'remove' } elseif ($a -ceq 'KEEP' -and $info.mode -ne 'remove') { 'keep' } else { $null }
  }
  # MC-1583: the pool changed since the answer: the new VMs beside the confirmed ones, and the question again.
  ConfirmChange = {
    param($was, $now)
    Write-Host ''
    Write-Host 'The pool changed since you confirmed what goes:' -ForegroundColor Yellow
    Write-Host "  you confirmed $(@($was).Count) VM(s): $((@($was) | ForEach-Object { "$($_.name) ($($_.vmId))" }) -join ', ')"
    Write-Host "  it now has $(@($now).Count): $((@($now) | ForEach-Object { "$($_.name) ($($_.vmId)) in $($_.folder)" }) -join ', ')"
    ((Read-Host 'Type REMOVE to remove the pool as it is now (anything else stops: nothing more is removed)').Trim() -ceq 'REMOVE')
  }
  # The confirmed plan approved (approve.ps1 -Confirmed: every check but the digest question, for a remove plan only),
  # then run through the helper.
  RemovePool = {
    param($planId)
    & (Join-Path $install 'approve.ps1') -Plan $planId -Confirmed
    if ($LASTEXITCODE -ne 0) { throw 'The remove plan was not approved: no VM was removed. Run this again.' }
    $job = Invoke-Helper 'pool_remove' @{ planId = $planId }
    Step $job.text
    do { Start-Sleep 3; $st = Invoke-Helper 'status' } while ($st.data.job)
    if ($st.data.lastJob -and -not $st.data.lastJob.ok) { throw "The remove job failed: $($st.data.lastJob.note)" }
    return [int]$st.data.vms
  }
}

$HKLM = [Microsoft.Win32.Registry]::LocalMachine
$keyPath = 'SOFTWARE\hyperv-mcp'
$trustedKey = @($SYSTEM, $ADMINS, $script:TrustedInstaller)
$launcherText = Get-LauncherText
$launcher = [scriptblock]::Create($launcherText)
$expected = (Get-LauncherCommand $launcherText).b64
$inventoryFile = Join-Path $state 'inventory.txt'
function Get-KeyValue([string]$name) { $k = $HKLM.OpenSubKey($keyPath); if (-not $k) { return $null }; try { return $k.GetValue($name) } finally { $k.Dispose() } }
function Test-KeyHere { $k = $HKLM.OpenSubKey($keyPath); if ($k) { $k.Dispose(); return $true }; return $false }
function Get-HostSwitch { @(Get-VMSwitch -Name 'hvmcp-host' -ErrorAction SilentlyContinue | Where-Object { $_.Name -ceq 'hvmcp-host' -and $_.SwitchType -eq 'Internal' -and [string]$_.Notes -match '^hvmcp:host:[0-9a-f]{32}$' }) }
function Show-Inventory {
  if (Test-Path -LiteralPath $inventoryFile) { Write-Host ''; Get-Content -LiteralPath $inventoryFile | ForEach-Object { Write-Host "  $_" }; Write-Host '' }
  else { Step "No recorded inventory ($inventoryFile isn't there)." }
}
# What keep and remove each mean, as -WhatIf and the leftover check judge them.
function Show-Choices {
  Write-Host 'Remove everything (R): the pool''s VMs and their checkpoints, cached images, the disk folders, the helper''s state, setup''s host-mode switch, the service, its rights, the group, the install folder, the registry records and this Installed apps entry.'
  Write-Host 'Keep the pool (K): keeps the VMs and their checkpoints, cached images, the disk folders and the helper''s state with their records (setup recognises them when run again); removes the service, its rights, the group, the vsock registration, setup''s host-mode switch (setup makes it again), the install folder and this Installed apps entry.'
}
# R1: what is still there that the chosen mode removes (or, for keep, what it should have kept and didn't), read live.
function Get-Leftovers([string]$m, [string[]]$diskFolders) {
  $left = @()
  if (Get-Service $svc -ErrorAction SilentlyContinue) { $left += "the service $svc" }
  if (Get-LocalGroup -Name $groupName -ErrorAction SilentlyContinue) { $left += "the group '$groupName'" }
  if (@(Get-LocalGroupMember -SID $HVADMINS -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $svcAccount }).Count) { $left += "$svcAccount in Hyper-V Administrators" }
  if ((Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\00000016-facb-11e6-bd58-64006a7986d3' -ErrorAction SilentlyContinue).ElementName -eq 'hyper-v MCP: SSH to Linux guests (vsock port 22)') { $left += 'the Linux guests'' vsock port registration' }
  if ((Get-HostSwitch).Count) { $left += 'setup''s host-mode switch hvmcp-host' }
  if (Test-Path -LiteralPath $install) { $odd = @(Get-ChildItem -LiteralPath $install -Force | Where-Object { @('uninstall', 'uninstall.retiring') -notcontains $_.Name }); if ($odd.Count) { $left += "$install still holds $($odd[0].Name)" } }
  if ($m -eq 'remove') {
    if (Test-Path -LiteralPath $state) { $left += "the state folder $state" }
    foreach ($d in $diskFolders) { if (Test-Path -LiteralPath $d) { $left += "the disk folder $d" } }
    $vms = @(try { Get-VM -ErrorAction Stop | Where-Object { $p = [string]$_.Path; @($diskFolders | Where-Object { $p.ToLowerInvariant().StartsWith($_.ToLowerInvariant().TrimEnd('\') + '\') }).Count } } catch { @() })
    foreach ($v in $vms) { $left += "the VM $($v.Name) ($($v.Id)) in $($v.Path)" }
    if (Test-KeyHere) { $left += "the registry key HKLM\$keyPath" }
  } else {
    if (-not (Test-Path -LiteralPath $state)) { $left += "(kept) the state folder $state is missing" }
    if (-not (Get-KeyValue 'InstallId')) { $left += "(kept) HKLM\$keyPath has no InstallId" }
  }
  return $left
}
function Invoke-RetirePhase { Invoke-Retire -ProgramFiles ([Environment]::GetFolderPath('ProgramFiles')) -Trusted $trustedKey -RootOwners @($SYSTEM, $ADMINS) -Launcher $launcher -Expected $expected }

$receipts = @()
$rk = $HKLM.OpenSubKey("$keyPath\Storage"); if ($rk) { $receipts = @($rk.GetValueNames()); $rk.Dispose() }
$diskFolders = @($receipts | Where-Object { $_ -ne $state.ToLowerInvariant() -and -not $_.StartsWith($state.ToLowerInvariant() + '\') })
# The decisions are Invoke-UninstallFlow's (appsentry.ps1); these are the real actions it takes.
$X = @{
  Say = { param($m) Step $m }
  ServiceHere = { [bool](Get-Service $svc -ErrorAction SilentlyContinue) }
  StateHere = { Test-Path -LiteralPath $state }
  KeyHere = { Test-KeyHere }
  KeptMark = { [bool](Get-KeyValue 'KeptPool') }
  InstallHere = { Test-Path -LiteralPath $install }
  EntryHere = { $e = $HKLM.OpenSubKey($script:EntryKeyPath); if ($e) { $e.Dispose(); $true } else { $false } }
  ShowInventory = { Show-Inventory }
  ShowChoices = { Show-Choices }
  Teardown = {
    param($m, $w)
    Invoke-Teardown -Mode $m -State $state -Install $install -Root $HKLM -KeyPath $keyPath `
      -Trusted $trustedKey -RootOwners @($SYSTEM, $ADMINS) -Who @($SYSTEM, $ADMINS, $runnerSid) -Ops $ops -WhatIf:$w
  }
  # MC-1556: setup's host-mode switch (its name and the Notes setup wrote, never the name alone), with this PC's address
  # on it, in both modes (setup makes it again).
  HostSwitches = { (Get-HostSwitch).Count }
  RemoveHostSwitches = { foreach ($x in (Get-HostSwitch)) { Remove-VMSwitch -VMSwitch $x -Force; Step "Host-mode switch hvmcp-host removed (and this PC's address on it)." } }
  Leftovers = { param($m) Get-Leftovers $m $diskFolders }
  WriteKept = {
    Assert-KeyProtected $HKLM $keyPath $trustedKey
    $k = $HKLM.OpenSubKey($keyPath, $true)
    try { $k.SetValue('KeptPool', (@{ installId = [string]$k.GetValue('InstallId'); at = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress)) } finally { $k.Dispose() }
    if (Test-Path -LiteralPath $inventoryFile) { Add-Content -LiteralPath $inventoryFile -Value "`r`n$([DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm')): helper removed by uninstall -KeepPool; the pool, its state and disk folders are kept (setup recognises them). To remove this kept pool later, run setup again (it restores the helper and the Installed apps entry), then uninstall." }
  }
  Retire = { Invoke-RetirePhase }
}
$code = Invoke-UninstallFlow @{ KeepPool = [bool]$KeepPool; RemovePool = [bool]$RemovePool; WhatIf = [bool]$WhatIf; Retire = [bool]$Retire } $X
if ($code -eq 0 -and -not $WhatIf) { Write-Host 'If you set anything up beside the MCP (Ollama''s settings, a firewall rule for host mode named ''hyper-v MCP host mode: *''), undo it as you were told when it was made.' }
exit $code
