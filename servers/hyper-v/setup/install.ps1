# Sets up the hyper-v MCP server's helper. Run once, in an admin PowerShell (one line):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\servers\hyper-v\setup\install.ps1" -DiskFolder D:\hyperv-mcp
#
# Service mode (the default) installs:
#   - %ProgramFiles%\hyperv-mcp: the helper's code, approve.ps1, and HvMcpHost.exe (compiled here by the in-box csc.exe);
#   - the service HyperVMcp, on its virtual account NT SERVICE\HyperVMcp, the only account it adds to Hyper-V
#     Administrators, restarted by the Service Control Manager after a failure (3 times a day, then left stopped);
#   - the local group "Hyper-V MCP Users", with -User in it: members may open the helper's pipe;
#   - %ProgramData%\hyperv-mcp: the helper's state (only SYSTEM, Administrators and the service), with policy.json and
#     approvals\ writable only by Administrators and SYSTEM;
#   - the disk folder(s) for the pool's VMs (only SYSTEM, Administrators and the service).
# Direct mode (-Mode Direct) installs no service: it adds -User to Hyper-V Administrators instead, so any program you
# run, agents included, can drive Hyper-V without the server's rules. Read the README before choosing it.
#
# It is idempotent: run it again to update the helper or change the policy. It keeps an existing pool and its state.
# It never enables Windows features or restarts the PC: if Hyper-V is off, it says how to turn it on and stops.
param(
  [Parameter(Mandatory = $true)][string[]]$DiskFolder,
  [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
  [ValidateSet('Service', 'Direct')][string]$Mode = 'Service',
  [int]$MaxVms = 0,
  [int]$MaxCoresPerVm = 0,
  [int]$MaxMemoryGB = 0,
  [int]$MaxDiskGBPerVm = 128,
  [bool]$AllowNetwork = $true,
  [int]$MaxReservePercent = 100,
  [int]$MaxLeaseMinutes = 240,
  [int]$MaxBuildMB = 2048,
  [switch]$AllowUnpinnedIso
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Step($m) { Write-Host "- $m" }
# Whether the helper's pipe exists, by listing the pipes (opening one would count as a client).
function PipeOpen { return [bool]([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -ieq '\\.\pipe\hyperv-mcp' }) }

$me = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an admin PowerShell (Run as administrator).' }

$src = Split-Path -Parent $PSScriptRoot   # servers\hyper-v
$install = Join-Path $env:ProgramFiles 'hyperv-mcp'
$state = Join-Path $env:ProgramData 'hyperv-mcp'
$svc = 'HyperVMcp'
$svcAccount = "NT SERVICE\$svc"
$groupName = 'Hyper-V MCP Users'
$HVADMINS = 'S-1-5-32-578'

# 1. Hyper-V
if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue) -or -not (Get-Service vmms -ErrorAction SilentlyContinue)) {
  throw "Hyper-V or its PowerShell module isn't installed. Turn it on (in an admin PowerShell: Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All), restart, then run this again."
}
if ((Get-Service vmms).Status -ne 'Running') { throw 'The Hyper-V Virtual Machine Management service (vmms) is not running: start it, or restart the PC, then run this again.' }
Step 'Hyper-V is on.'

# 2. Node: must be admin-only writable, since the service runs it with Hyper-V rights.
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node (18 or later) is not on PATH.' }
function Assert-AdminOnly([string]$path) {
  $mask = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
  foreach ($p in @($path, (Split-Path -Parent $path))) {
    foreach ($ace in (Get-Acl -LiteralPath $p).Access) {
      if ($ace.AccessControlType -ne 'Allow' -or -not ([int64]$ace.FileSystemRights -band $mask)) { continue }
      $sid = try { $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $ace.IdentityReference.Value }
      if (@('S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464') -notcontains $sid) {
        throw "$($ace.IdentityReference) can write $p. The service would run this Node with Hyper-V rights: install Node for all users (under Program Files) and run this again."
      }
    }
  }
}
Assert-AdminOnly $node
Step "Node: $node ($(& $node -v))."

# 3. The group of users who may use the helper, with -User in it.
if (-not (Get-LocalGroup -Name $groupName -ErrorAction SilentlyContinue)) { New-LocalGroup -Name $groupName -Description 'May use the hyper-v MCP helper (its named pipe).' | Out-Null }
if (-not (Get-LocalGroupMember -Name $groupName -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $User })) { Add-LocalGroupMember -Name $groupName -Member $User }
$usersSid = (Get-LocalGroup -Name $groupName).SID.Value
Step "Group '$groupName' holds $User (sign out and in again for a new membership to count)."

# 4. The code, installed where only Administrators can write.
New-Item -ItemType Directory -Force -Path $install | Out-Null
foreach ($f in 'core.js', 'helper.js', 'hv.js', 'hv.ps1', 'images.js', 'iso.js', 'journal.js', 'paths.js', 'policy.js', 'unattend.js', 'approve.ps1') {
  Copy-Item -LiteralPath (Join-Path $src "helper\$f") -Destination (Join-Path $install $f) -Force
}
Copy-Item -LiteralPath (Join-Path $src 'meta.json') -Destination (Join-Path $install 'meta.json') -Force
Step "Helper code copied to $install."

if ($Mode -eq 'Service') {
  $existing = Get-Service $svc -ErrorAction SilentlyContinue
  if ($existing -and $existing.Status -ne 'Stopped') { Stop-Service $svc -Force; (Get-Service $svc).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)) }
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) { throw "The .NET Framework compiler is missing ($csc)." }
  $exe = Join-Path $install 'HvMcpHost.exe'
  $out = & $csc -nologo -target:exe -optimize "-out:$exe" -reference:System.ServiceProcess.dll -reference:System.Core.dll (Join-Path $src 'helper\host\HvMcpHost.cs') 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Compiling the service host failed:`n$($out -join "`n")" }
  Set-Content -LiteralPath (Join-Path $install 'host.config') -Encoding ASCII -Value @(
    "node=$node", "helper=$(Join-Path $install 'helper.js')", "stateDir=$state", 'pipe=hyperv-mcp', "usersSid=$usersSid")
  Step 'Service host compiled.'
  if (-not $existing) {
    & sc.exe create $svc binPath= "`"$exe`"" obj= $svcAccount start= auto DisplayName= 'Hyper-V MCP helper' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed ($LASTEXITCODE)." }
  }
  & sc.exe description $svc 'Runs the hyper-v MCP server''s pool of disposable test VMs, within its policy.' | Out-Null
  & sc.exe sidtype $svc unrestricted | Out-Null
  & sc.exe failure $svc reset= 86400 actions= restart/5000/restart/5000/restart/5000/""/0 | Out-Null
  Step "Service $svc on $svcAccount."
}
$runner = if ($Mode -eq 'Service') { $svcAccount } else { $User }

# 5. Rights: Hyper-V Administrators holds the service account (or, in direct mode, the user).
$hvMembers = @(Get-LocalGroupMember -SID $HVADMINS -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
if ($hvMembers -notcontains $runner) { Add-LocalGroupMember -SID $HVADMINS -Member $runner }
Step "$runner is in Hyper-V Administrators."

# 6. The state folder and the disk folders, with their ACLs.
function Set-Owned([string]$path, [string[]]$grants) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  $ia = @($path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F') + ($grants | ForEach-Object { '/grant:r'; $_ })
  $o = & icacls.exe @ia 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls $path failed: $o" }
  & icacls.exe $path /setowner '*S-1-5-32-544' 2>&1 | Out-Null
}
Set-Owned $state @("${runner}:(OI)(CI)M")
Set-Owned (Join-Path $state 'approvals') @("${runner}:(OI)(CI)RX")
$folders = @($DiskFolder | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })
foreach ($d in $folders) {
  if ([IO.Path]::GetPathRoot($d).TrimEnd('\') -eq $d) { throw "Disk folder $d is a drive root: name a folder, such as D:\hyperv-mcp." }
  Set-Owned $d @("${runner}:(OI)(CI)F")
}
Step "State in $state; VM disks in $($folders -join ', ')."

# 7. The policy: hard limits for every pool change, writable only by Administrators and SYSTEM.
$cs = Get-CimInstance Win32_ComputerSystem
$cpus = [int]$cs.NumberOfLogicalProcessors
$ramGB = [int][Math]::Floor($cs.TotalPhysicalMemory / 1GB)
$policy = [ordered]@{
  schema = 1; prefix = 'hvmcp'
  maxVms = $(if ($MaxVms) { $MaxVms } else { [Math]::Max(1, [Math]::Min(4, [Math]::Floor($cpus / 4))) })
  maxCoresPerVm = $(if ($MaxCoresPerVm) { $MaxCoresPerVm } else { [Math]::Max(1, [Math]::Min(8, [Math]::Floor($cpus / 4))) })
  maxMemoryMBTotal = $(if ($MaxMemoryGB) { $MaxMemoryGB * 1024 } else { [Math]::Max(4096, [Math]::Floor($ramGB / 2) * 1024) })
  maxDiskGBPerVm = $MaxDiskGBPerVm; diskFolders = $folders; allowNetwork = $AllowNetwork
  maxReservePercent = $MaxReservePercent; maxLeaseMinutes = $MaxLeaseMinutes; maxBuildMB = $MaxBuildMB
  allowUnpinnedIso = [bool]$AllowUnpinnedIso
}
$policyFile = Join-Path $state 'policy.json'
[IO.File]::WriteAllText($policyFile, ($policy | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding $false))
$o = & icacls.exe $policyFile /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "${runner}:RX" 2>&1
if ($LASTEXITCODE -ne 0) { throw "icacls $policyFile failed: $o" }
Step ("Policy: up to {0} VMs, {1} cores each, {2} GB memory in all, {3} GB disks; network {4}; unpinned ISOs {5}." -f $policy.maxVms, $policy.maxCoresPerVm, ($policy.maxMemoryMBTotal / 1024), $policy.maxDiskGBPerVm, $(if ($AllowNetwork) { 'allowed (internal switch only)' } else { 'not allowed' }), $(if ($AllowUnpinnedIso) { 'allowed' } else { 'refused' }))

# 8. Start.
if ($Mode -eq 'Service') {
  Start-Service $svc
  $t = (Get-Date).AddMinutes(5)
  while (-not (PipeOpen) -and (Get-Date) -lt $t) {
    if ((Get-Service $svc).Status -eq 'Stopped') { throw "The service stopped: see $state\host.log and $state\helper.log." }
    Start-Sleep 1
  }
  if (-not (PipeOpen)) { throw "The helper didn't open its pipe within 5 minutes: see $state\host.log and $state\helper.log." }
  Step 'The helper is running.'
}
Write-Host ''
Write-Host "Done ($Mode mode). Add the server to your MCP client with HYPERV_MCP_ENABLED=1$(if ($Mode -eq 'Direct') { ' and HYPERV_MCP_MODE=direct' }) (see the README), then ask an agent to plan a pool (pool_plan)." -ForegroundColor Green
