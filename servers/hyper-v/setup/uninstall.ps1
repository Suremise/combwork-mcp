# Removes the hyper-v MCP helper. Run in an admin PowerShell (one line):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\servers\hyper-v\setup\uninstall.ps1" -KeepPool
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\servers\hyper-v\setup\uninstall.ps1" -RemovePool
# For an install made by an older setup (no storage receipts), also name its disk folder: -LegacyDiskFolder D:\hyperv-mcp
# (you'll be shown exactly what it will delete, and asked to type DELETE).
#
#   -KeepPool   removes the service, its rights, the group and the code, and KEEPS the pool's VMs, the helper's state and
#               the disk folders, with their storage receipts: running setup again recognises them.
#   -RemovePool removes the pool first, through the helper's own journalled remove (you approve that plan as usual), then
#               the storage setup created (only folders it can verify as setup's: see teardown.ps1), then everything else.
# The steps and their order, the record that lets an interrupted uninstall be finished by running it again with the same
# options, and what may be deleted, are in teardown.ps1.
param([switch]$KeepPool, [switch]$RemovePool, [string]$LegacyDiskFolder, [ValidateSet('Service', 'Direct')][string]$Mode = 'Service', [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name)
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
if ($KeepPool -eq $RemovePool) { throw 'Choose -KeepPool or -RemovePool.' }
if ($LegacyDiskFolder) {
  $LegacyDiskFolder = [IO.Path]::GetFullPath($LegacyDiskFolder).TrimEnd('\')
  if ($LegacyDiskFolder -notmatch '^[A-Za-z]:\\[^\\]+$' -or (New-Object IO.DriveInfo $LegacyDiskFolder.Substring(0, 2)).DriveType -ne 'Fixed') { throw '-LegacyDiskFolder must be a top-level folder on a local fixed drive, such as D:\hyperv-mcp.' }
}
. (Join-Path $PSScriptRoot 'acl.ps1')
. (Join-Path $PSScriptRoot 'teardown.ps1')

$install = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'hyperv-mcp'
$state = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'hyperv-mcp'
$svc = 'HyperVMcp'
$svcAccount = "NT SERVICE\$svc"
$groupName = 'Hyper-V MCP Users'
$HVADMINS = 'S-1-5-32-578'
$SYSTEM = 'S-1-5-18'; $ADMINS = 'S-1-5-32-544'
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

Invoke-Teardown -Mode $(if ($RemovePool) { 'remove' } else { 'keep' }) -State $state -Install $install -LegacyDiskFolder $LegacyDiskFolder `
  -Root ([Microsoft.Win32.Registry]::LocalMachine) -KeyPath 'SOFTWARE\hyperv-mcp' `
  -Trusted @($SYSTEM, $ADMINS, $script:TrustedInstaller) -RootOwners @($SYSTEM, $ADMINS) -Who @($SYSTEM, $ADMINS, $runnerSid) -KeyOwner $ADMINS `
  -Ops $ops
Write-Host 'Done.' -ForegroundColor Green
