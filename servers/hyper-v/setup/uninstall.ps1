# Removes the hyper-v MCP helper. Settings > Apps > Installed apps > "Hyper-V MCP helper and test VMs" > Uninstall runs
# it (MC-1557), or in an admin PowerShell (one line), from the installed copy (no repo needed) or the repo's:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\hyperv-mcp\uninstall\uninstall.ps1"
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\servers\hyper-v\setup\uninstall.ps1" -KeepPool
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\servers\hyper-v\setup\uninstall.ps1" -RemovePool
# With neither option it shows the helper's recorded inventory and asks: remove everything (the default), keep the pool,
# or list only. -WhatIf lists what each would remove and changes nothing (no record, no approval, no service change).
# For an install made by an older setup (no storage receipts), also name its disk folder: -LegacyDiskFolder D:\hyperv-mcp
# (you'll be shown exactly what it will delete, and asked to type DELETE).
#
#   -KeepPool   removes the service, its rights, the group and the code, and KEEPS the pool's VMs, the helper's state and
#               the disk folders, with their storage receipts: running setup again recognises them.
#   -RemovePool removes the pool first, through the helper's own journalled remove (you approve that plan as usual), then
#               the storage setup created (only folders it can verify as setup's: see teardown.ps1), then everything else.
# The steps and their order, the record that lets an interrupted uninstall be finished by running it again with the same
# options, and what may be deleted, are in teardown.ps1. The Installed apps entry, its launcher and the last phase that
# retires the uninstaller itself are in appsentry.ps1.
#   -Interactive the menu (the default with neither option); -Retire only the last phase (the entry's launcher runs it
#   from uninstall.retiring\); -FromCopy internal: run from the protected temporary copy of an installed uninstaller.
param([switch]$KeepPool, [switch]$RemovePool, [switch]$Interactive, [switch]$WhatIf, [switch]$Retire, [string]$LegacyDiskFolder, [ValidateSet('Service', 'Direct')][string]$Mode = 'Service', [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name, [string]$FromCopy)
# Windows PowerShell 5.1 only (MC-1506), refused before any check or change:
# it uses setup's storage and ACL routines, which need .NET Framework calls
# that PowerShell 7 doesn't have.
# Run from PowerShell 7, an earlier setup stopped the service, then failed part-way. The refusal says how to run it
# under 5.1, with the arguments used (they aren't rebuilt here: -File can't carry every type).
if ($PSVersionTable.PSEdition -ne 'Desktop') {
  [Console]::Error.WriteLine("This needs Windows PowerShell 5.1, not PowerShell $($PSVersionTable.PSVersion): nothing was checked or changed. Run it again in an admin Windows PowerShell, as one line, with the same arguments you used:`n  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" <the same arguments>")
  exit 1
}
$ErrorActionPreference = 'Stop'
# Started from a PowerShell 7 window, this 5.1 inherits PS7's module folders and can't load its own Get-Acl: drop them.
$env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '(?<!Windows)PowerShell\\(\d[^\\]*\\)?Modules\\?$' }) -join ';'
function Step($m) { Write-Host "- $m" }
function PipeOpen { return [bool]([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -ieq '\\.\pipe\hyperv-mcp' }) }

$me = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an admin PowerShell (Run as administrator).' }
if ($KeepPool -and $RemovePool) { throw 'Choose -KeepPool or -RemovePool, not both.' }
if ($LegacyDiskFolder) {
  $LegacyDiskFolder = [IO.Path]::GetFullPath($LegacyDiskFolder).TrimEnd('\')
  if ($LegacyDiskFolder -notmatch '^[A-Za-z]:\\[^\\]+$' -or (New-Object IO.DriveInfo $LegacyDiskFolder.Substring(0, 2)).DriveType -ne 'Fixed') { throw '-LegacyDiskFolder must be a top-level folder on a local fixed drive, such as D:\hyperv-mcp.' }
}
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
if (-not $FromCopy -and $here.ToLowerInvariant().StartsWith($install.ToLowerInvariant() + '\')) {
  $tmp = New-ProtectedCopy (Join-Path $env:SystemRoot 'Temp') @($script:RetiringSet | ForEach-Object { Join-Path $here $_ }) -Owners @($ADMINS) -Grants @($SYSTEM, $ADMINS) -SetOwner
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $tmp 'uninstall.ps1'))
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Value -is [Management.Automation.SwitchParameter]) { if ($kv.Value.IsPresent) { $argList += "-$($kv.Key)" } } else { $argList += "-$($kv.Key)"; $argList += [string]$kv.Value }
  }
  $argList += @('-FromCopy', $here)
  Push-Location -LiteralPath $tmp
  try { & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @argList; $code = $LASTEXITCODE } finally { Pop-Location; Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
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
    (Get-Service $svc).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60))
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
  RemovePool = {
    $plan = Invoke-Helper 'pool_plan' @{ action = 'remove' }
    Write-Host $plan.text
    & (Join-Path $install 'approve.ps1') -Plan $plan.data.planId
    if ($LASTEXITCODE -ne 0) { throw 'The remove plan was not approved: no VM was removed. Run this again to approve it.' }
    $job = Invoke-Helper 'pool_remove' @{ planId = $plan.data.planId }
    Step $job.text
    do { Start-Sleep 3; $st = Invoke-Helper 'status' } while ($st.data.job)
    if ($st.data.lastJob -and -not $st.data.lastJob.ok) { throw "The remove job failed: $($st.data.lastJob.note)" }
    return [int]$st.data.vms
  }
  ConfirmInventory = {
    param($lines)
    $word = if (@($lines | Where-Object { $_ -like 'DELETE *' }).Count) { 'DELETE' } else { 'KEEP' }
    Write-Host ''
    Write-Host 'This uninstall will act on these folders, made by an older setup (they have no storage receipts):' -ForegroundColor Yellow
    foreach ($l in $lines) { Write-Host "  $l" }
    Write-Host 'Their present owners and permissions were checked; that is no proof of their history, so this is your decision.'
    return ((Read-Host "Type $word to go ahead (anything else stops, with nothing changed)") -ceq $word)
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
# What keep and remove each mean, as the menu, -WhatIf and the leftover check judge them.
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
  Ask = {
    $a = Read-Host 'Remove everything (R, the default), keep the pool (K), list only (L), anything else cancels'
    switch -Regex ($a) { '^\s*[Rr]?\s*$' { 'remove' } '^\s*[Kk]\s*$' { 'keep' } '^\s*[Ll]\s*$' { 'list' } default { $null } }
  }
  Teardown = {
    param($m, $w)
    Invoke-Teardown -Mode $m -State $state -Install $install -LegacyDiskFolder $LegacyDiskFolder -Root $HKLM -KeyPath $keyPath `
      -Trusted $trustedKey -RootOwners @($SYSTEM, $ADMINS) -Who @($SYSTEM, $ADMINS, $runnerSid) -KeyOwner $ADMINS -Ops $ops -WhatIf:$w
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
