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
# -BuildRoot names folders builds may also come from, beside each client's MCP roots (e.g. a folder a project stages
# builds in): recorded in policy.json, so agents can't add to them. Give each as a literal path, not %LOCALAPPDATA%,
# which in an admin prompt can be another account's. A rerun replaces the list: leave -BuildRoot out to clear it.
# Direct mode (-Mode Direct) installs no service: it adds -User to Hyper-V Administrators instead, so any program you
# run, agents included, can drive Hyper-V without the server's rules. Read the README before choosing it.
#
# -ProjectsFile names a JSON file listing projects that share the pool fairly (README, "Sharing the pool between
# projects"): each { name, folders, maxVms?, reserveVms?, buildRoots? }. It is checked by the helper's own policy code
# before anything changes, and copied into policy.json. Left out, a rerun keeps the current list; -ProjectsFile none
# clears it.
# -MaxSessionMinutes caps a work session (vm_renew can extend a lease up to it, from vm_acquire): 5-1440 and at least
# -MaxLeaseMinutes. Left out, the helper uses 480 (or -MaxLeaseMinutes, if that is more).
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
  [int]$MaxSessionMinutes = 0,
  [int]$MaxBuildMB = 2048,
  [switch]$AllowUnpinnedIso,
  [string[]]$BuildRoot = @(),
  [string]$ProjectsFile = ''
)
# Windows PowerShell 5.1 only (MC-1506), refused before any check or change:
# setup's storage and ACL routines use .NET Framework calls that PowerShell 7
# doesn't have.
# Run from PowerShell 7, an earlier setup stopped the service, then failed part-way. The refusal says how to run it
# under 5.1, with the arguments used (they aren't rebuilt here: -File can't carry every type).
if ($PSVersionTable.PSEdition -ne 'Desktop') {
  [Console]::Error.WriteLine("This needs Windows PowerShell 5.1, not PowerShell $($PSVersionTable.PSVersion): nothing was checked or changed. Run it again in an admin Windows PowerShell, as one line, with the same arguments you used:`n  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" <the same arguments>")
  exit 1
}
$ErrorActionPreference = 'Stop'
# Started from a PowerShell 7 window, this 5.1 inherits PS7's module folders and can't load its own Get-Acl: drop them.
$env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '(?<!Windows)PowerShell\\(\d[^\\]*\\)?Modules\\?$' }) -join ';'
$ProgressPreference = 'SilentlyContinue'
function Step($m) { Write-Host "- $m" }
# Whether the helper's pipe exists, by listing the pipes (opening one would count as a client).
function PipeOpen { return [bool]([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -ieq '\\.\pipe\hyperv-mcp' }) }

$me = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an admin PowerShell (Run as administrator).' }

. (Join-Path $PSScriptRoot 'acl.ps1')     # trusted storage (Use-StorageFolder, receipts, ancestors) and ACL checks
. (Join-Path $PSScriptRoot 'teardown.ps1') # Assert-NoTeardown
# No install while an uninstall is unfinished (no helper may start during one).
Assert-NoTeardown ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\hyperv-mcp'
$src = Split-Path -Parent $PSScriptRoot   # servers\hyper-v
# Locations from Windows' known-folder API, not from environment variables.
$install = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'hyperv-mcp'
$state = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'hyperv-mcp'
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

# 1b. Storage, before any other change (design MC-1488/s52; acl.ps1 says how). The state folder, its approvals\ and
# each disk folder are either created here with their final security (and a receipt), or taken only if their receipt
# matches; anything else stops setup with nothing changed. Every parent is checked and pinned first. The helper's account
# SID comes from sc.exe showsid, which works before the service exists.
$SYSTEM = 'S-1-5-18'; $ADMINS = 'S-1-5-32-544'; $USERS = 'S-1-5-32-545'
$runnerSid = if ($Mode -eq 'Service') {
  $line = (& sc.exe showsid $svc) | Where-Object { $_ -match 'SERVICE SID:\s*(S-1-5-80-[\d-]+)' } | Select-Object -First 1
  if (-not $line) { throw "sc.exe showsid $svc gave no service SID." }
  $Matches[1]
} else { (New-Object Security.Principal.NTAccount $User).Translate([Security.Principal.SecurityIdentifier]).Value }
# Disk folders: a top-level folder on a local fixed drive (X:\name), the supported location. Its only parent is the
# volume root, which can't be renamed or replaced.
$folders = @($DiskFolder | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })
foreach ($d in $folders) {
  if ($d -notmatch '^[A-Za-z]:\\[^\\]+$') { throw "Disk folder $d must be a top-level folder on a local drive, such as D:\hyperv-mcp." }
  if ((New-Object IO.DriveInfo $d.Substring(0, 2)).DriveType -ne 'Fixed') { throw "Disk folder $d must be on a local fixed drive." }
}
# Build roots: absolute local folders, not a drive root, with no link or junction on the way (the server refuses one
# that has: it must resolve to the very path named). Checked before anything changes; one that doesn't exist yet is kept.
$buildRoots = @($BuildRoot | Where-Object { $_ } | ForEach-Object {
  if ($_ -notmatch '^[A-Za-z]:\\' -or $_ -match '(^|\\)\.\.(\\|$)') { throw "Build root $_ must be an absolute local folder (X:\...) with no '..'." }
  $b = [IO.Path]::GetFullPath($_).TrimEnd('\')
  if ($b -notmatch '^[A-Za-z]:\\[^\\]') { throw "Build root $b must be a folder, not a drive root." }
  for ($p = $b; $p -and $p.Length -gt 3; $p = Split-Path -Parent $p) {
    $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    if ($i -and ($i.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Build root $b can't be used: $p is a link or junction." }
  }
  if (-not (Test-Path -LiteralPath $b -PathType Container)) { Write-Warning "Build root $b doesn't exist yet: it is recorded, and used once it exists." }
  $b
} | Select-Object -Unique)
# The helper's policy check allows at most 16 (helper/policy.js): refuse more here, before anything changes.
if ($buildRoots.Count -gt 16) { throw "At most 16 build roots: $($buildRoots.Count) were given." }
# Projects (MC-1502): -ProjectsFile's list, checked by the helper's own policy.js (with node, which setup needs anyway)
# before anything changes; left out, the current policy's list is kept; 'none' clears it.
$projects = @()
if ($ProjectsFile -eq 'none') { $projects = @() }
elseif ($ProjectsFile) {
  # Unrolled: Windows PowerShell's ConvertFrom-Json passes a JSON array on as one object.
  try { $projects = @((Get-Content -Raw -LiteralPath $ProjectsFile | ConvertFrom-Json) | ForEach-Object { $_ }) } catch { throw "-ProjectsFile $ProjectsFile can't be read as JSON: $($_.Exception.Message)" }
} else {
  $current = Join-Path $state 'policy.json'
  if (Test-Path -LiteralPath $current) { try { $projects = @((Get-Content -Raw -LiteralPath $current | ConvertFrom-Json).projects | Where-Object { $_ }) } catch { $projects = @() } }
}
if ($projects.Count) {
  $nodeCheck = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeCheck) { throw 'Node (18 or later) is not on PATH.' }
  $why = (ConvertTo-Json -InputObject @($projects) -Depth 6 -Compress) | & $nodeCheck -e "const p = require(process.argv[1]); let t = ''; process.stdin.on('data', d => t += d).on('end', () => { const w = p.projectProblems(JSON.parse(t)); process.stdout.write(w.join('; ')) })" (Join-Path $src 'helper\policy.js')
  if ($LASTEXITCODE) { throw 'The projects check (node) failed.' }
  if ($why) { throw "The projects can't be used: $why. Nothing was changed." }
}
# The helper refuses a policy whose session cap is below one lease (helper/policy.js): refuse it here first.
if ($MaxSessionMinutes -and ($MaxSessionMinutes -lt 5 -or $MaxSessionMinutes -gt 1440 -or $MaxSessionMinutes -lt $MaxLeaseMinutes)) { throw "-MaxSessionMinutes must be 5-1440 and at least -MaxLeaseMinutes ($MaxLeaseMinutes)." }
$pins = New-Object Collections.ArrayList
$receipts = $null
try {
$trusted = @($SYSTEM, $ADMINS, $script:TrustedInstaller)
foreach ($p in @($state, $install) + $folders) { Open-TrustedAncestors $p $trusted $pins }
$receipts = Open-ReceiptKey ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\hyperv-mcp\Storage' @($SYSTEM, $ADMINS) $ADMINS
$who = @($SYSTEM, $ADMINS, $runnerSid)
$stateIs = Use-StorageFolder $state @("$SYSTEM=FullControl", "$ADMINS=FullControl", "$runnerSid=Modify") $ADMINS $receipts -Allowed $who -Owners $who -Pins $pins
$approvals = Join-Path $state 'approvals'
$apprIs = Use-StorageFolder $approvals @("$SYSTEM=FullControl", "$ADMINS=FullControl", "$runnerSid=ReadAndExecute") $ADMINS $receipts -Allowed $who -Writers $SYSTEM, $ADMINS -Owners $SYSTEM, $ADMINS -Pins $pins
$diskIs = foreach ($d in $folders) { "$d $(Use-StorageFolder $d @("$SYSTEM=FullControl", "$ADMINS=FullControl", "$runnerSid=FullControl") $ADMINS $receipts -Allowed $who -Owners $who -AllowPattern $script:HyperVGrantees -Pins $pins)" }
Step "Storage: state $stateIs, approvals $apprIs, disks $($diskIs -join ', ') (parents checked and held while setup runs)."
# This installation's generation: an uninstall's record is bound to it.
$ik = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\hyperv-mcp', $true)
try { $ik.SetValue('InstallId', [guid]::NewGuid().ToString('n')); $ik.Flush() } finally { $ik.Dispose() }

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
$userSid = (New-Object Security.Principal.NTAccount $User).Translate([Security.Principal.SecurityIdentifier]).Value
# The pipe admits the group and, directly, -User: a new group membership only counts after signing in again.
$usersSid = "$((Get-LocalGroup -Name $groupName).SID.Value);$userSid"
Step "Group '$groupName' holds $User; $User may also open the pipe directly (no need to sign in again)."

# 4. The code, installed where only Administrators can write. The service is stopped first (a running helper's VMs are
# restored by the next one's recovery), and the folder's ACL is made exclusive, and checked, before any code goes in.
$existing = Get-Service $svc -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') { Stop-Service $svc -Force; (Get-Service $svc).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(60)); Step "Service $svc stopped for the update." }
Set-ExclusiveAcl $install @("$SYSTEM=FullControl", "$ADMINS=FullControl", "$USERS=ReadAndExecute") -SetOwner
$bad = @(Test-ExclusiveAcl $install -Allowed $SYSTEM, $ADMINS, $USERS -Writers $SYSTEM, $ADMINS -Owners $SYSTEM, $ADMINS)
if ($bad.Count) { throw "$install isn't admin-only after setting its ACL: $($bad -join '; ')" }
# Nothing earlier in it is kept: every file the service runs is copied fresh below (a stray file could be loaded instead).
Get-ChildItem -LiteralPath $install -Force | Remove-Item -Recurse -Force
foreach ($f in 'core.js', 'helper.js', 'hv.js', 'hv.ps1', 'guest-sync.ps1', 'guest-agent.ps1', 'images.js', 'iso.js', 'journal.js', 'paths.js', 'policy.js', 'unattend.js', 'approve.ps1') {
  Copy-Item -LiteralPath (Join-Path $src "helper\$f") -Destination (Join-Path $install $f) -Force
}
Copy-Item -LiteralPath (Join-Path $src 'meta.json') -Destination (Join-Path $install 'meta.json') -Force
Step "Helper code copied to $install (only Administrators and SYSTEM can write there)."

if ($Mode -eq 'Service') {
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

# 6. The storage was created or verified in step 1b, and is never re-permissioned here.
if ((New-Object Security.Principal.NTAccount $runner).Translate([Security.Principal.SecurityIdentifier]).Value -ne $runnerSid) { throw "$runner's SID isn't the one checked in step 1b." }

# 7. The policy: hard limits for every pool change, writable only by Administrators and SYSTEM. Written with its final
# ACL from the moment it exists (a new file, then renamed over the old one).
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
  buildRoots = @($buildRoots)
}
if ($projects.Count) {
  $reserved = ($projects | ForEach-Object { [int]$_.reserveVms } | Measure-Object -Sum).Sum
  if ($reserved -gt $policy.maxVms) { throw "The projects reserve $reserved VMs in all, over the policy's maxVms ($($policy.maxVms))." }
  $policy.projects = @($projects)
}
if ($MaxSessionMinutes) { $policy.maxSessionMinutes = $MaxSessionMinutes }
$policyFile = Join-Path $state 'policy.json'
Write-SecureFile $policyFile ($policy | ConvertTo-Json -Depth 4) @("$SYSTEM=FullControl", "$ADMINS=FullControl", "$runnerSid=ReadAndExecute") $ADMINS

# The result, checked: only SYSTEM, Administrators and the helper's account have any access to the state; only the
# first two can write policy.json and approvals\; the disk folders also allow Hyper-V's per-VM SIDs.
$bad = @(Test-ExclusiveAcl $state -Allowed $SYSTEM, $ADMINS, $runnerSid -Owners $SYSTEM, $ADMINS, $runnerSid) +
  @(Test-ExclusiveAcl $approvals -Allowed $SYSTEM, $ADMINS, $runnerSid -Writers $SYSTEM, $ADMINS -Owners $SYSTEM, $ADMINS) +
  @(Test-ExclusiveAcl $policyFile -Allowed $SYSTEM, $ADMINS, $runnerSid -Writers $SYSTEM, $ADMINS -Owners $SYSTEM, $ADMINS)
foreach ($d in $folders) { $bad += @(Test-ExclusiveAcl $d -Allowed $SYSTEM, $ADMINS, $runnerSid -AllowPattern $script:HyperVGrantees) }
if ($bad.Count) { throw "The helper's folders aren't as setup made them: $($bad -join '; ')" }
Step "State in $state; VM disks in $($folders -join ', '); ACLs checked."
Step "Build folders set by an admin (beside each client's MCP roots): $(if ($buildRoots.Count) { $buildRoots -join '; ' } else { 'none' })."
Step "Projects sharing the pool: $(if ($projects.Count) { ($projects | ForEach-Object { "$($_.name) (cap $(if ($null -ne $_.maxVms) { $_.maxVms } else { 'none' }), reserve $([int]$_.reserveVms))" }) -join '; ' } else { 'none (one shared pool, first come first served)' })."
Step ("Policy: up to {0} VMs, {1} cores each, {2} GB memory in all, {3} GB disks; network {4}; unpinned ISOs {5}; leases up to {6} min, work sessions up to {7} min." -f $policy.maxVms, $policy.maxCoresPerVm, ($policy.maxMemoryMBTotal / 1024), $policy.maxDiskGBPerVm, $(if ($AllowNetwork) { 'allowed (internal switch only)' } else { 'not allowed' }), $(if ($AllowUnpinnedIso) { 'allowed' } else { 'refused' }), $MaxLeaseMinutes, $(if ($MaxSessionMinutes) { $MaxSessionMinutes } else { [Math]::Max($MaxLeaseMinutes, 480) }))

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
} finally {
  # Every handle setup opened (the pinned parents and storage folders), and the receipts key, on every path out.
  Close-Pins $pins
  if ($receipts) { $receipts.Dispose() }
}
Write-Host ''
Write-Host "Done ($Mode mode). Add the server to your MCP client with HYPERV_MCP_ENABLED=1$(if ($Mode -eq 'Direct') { ' and HYPERV_MCP_MODE=direct' }) (see the README), then ask an agent to plan a pool (pool_plan)." -ForegroundColor Green
