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
# projects"): each { name, folders, maxVms?, images?, buildRoots? }. It is checked by the helper's own policy code
# before anything changes, and copied into policy.json. Left out, a rerun keeps the current list; -ProjectsFile none
# clears it.
# -ProductKeyFile names a file holding a Windows product key (XXXXX-XXXXX-XXXXX-XXXXX-XXXXX) for VMs built from a
# non-evaluation image (README, "The image"): checked here, then stored in the state's secrets folder, readable only by
# SYSTEM, Administrators and the helper; it goes only into such a build's answer file. A file, so the key is never on
# a command line. Left out, a rerun keeps the current key; -ProductKeyFile none removes it.
# -MaxNetwork (MC-1556) is the highest network mode a pool may be planned with (the user then picks the pool's mode in
# each plan they approve): None (the default for a new install), Host (a VM reaches only this PC, on the ports its
# firewall allows), Internet (also the internet, through Windows' Default Switch; not the LAN) or InternetLan (the
# internet and the LAN). Left out, a rerun keeps the current value (an older install's -AllowNetwork $true reads as
# Host, $false as None; -AllowNetwork still works and means the same). Host or above makes setup's internal switch
# hvmcp-host and gives this PC a static address on -HostSubnet (default 10.137.42.0/24; this PC is .1, VMs .10 up),
# refused if anything on this PC already uses that range. Setup changes no firewall rule: it prints the lines that would
# let host-mode VMs reach a service, for you to run if you want. Lowering it below Host removes that switch.
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
  [bool]$AllowNetwork = $false,
  [ValidateSet('', 'None', 'Host', 'Internet', 'InternetLan')][string]$MaxNetwork = '',
  [string]$HostSubnet = '',
  [int]$MaxReservePercent = 100,
  [int]$MaxLeaseMinutes = 240,
  [int]$MaxSessionMinutes = 0,
  [int]$MaxBuildMB = 2048,
  [switch]$AllowUnpinnedIso,
  [string[]]$BuildRoot = @(),
  [string]$ProjectsFile = '',
  [string]$ProductKeyFile = '',
  [string]$LinuxTransport = 'HvSocket'
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
. (Join-Path $PSScriptRoot 'appsentry.ps1') # MC-1557: the Installed apps entry and its launcher
# No install while an uninstall is unfinished (no helper may start during one).
Assert-NoTeardown ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\hyperv-mcp'
# MC-1557: a finished keep-pool uninstall's record (KeptPool) ends here: this setup restores the helper for that pool.
$kpKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\hyperv-mcp')
if ($kpKey) {
  $hadKp = $null -ne $kpKey.GetValue('KeptPool'); $kpKey.Dispose()
  if ($hadKp) {
    Assert-KeyProtected ([Microsoft.Win32.Registry]::LocalMachine) 'SOFTWARE\hyperv-mcp' @('S-1-5-18', 'S-1-5-32-544', $script:TrustedInstaller)
    $kpKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\hyperv-mcp', $true); $kpKey.DeleteValue('KeptPool', $false); $kpKey.Dispose()
    Step 'The pool an earlier uninstall kept is taken over again.'
  }
}
# MC-1567: an interrupted uninstall's protected temporary copy, only when it is exactly one (appsentry.ps1).
foreach ($l in @(Remove-StaleProtectedCopies (Join-Path $env:SystemRoot 'Temp') -Owners @('S-1-5-32-544') -Grants @('S-1-5-18', 'S-1-5-32-544'))) { Step "An earlier uninstall's temporary copy: $l." }
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
# The product key (MC-1513): read and checked here, before anything changes; written in step 7. Never printed.
$productKey = $null
if ($ProductKeyFile -and $ProductKeyFile -ne 'none') {
  try { $productKey = (Get-Content -Raw -LiteralPath $ProductKeyFile).Trim().ToUpperInvariant() } catch { throw "-ProductKeyFile $ProductKeyFile can't be read: $($_.Exception.Message)" }
  if ($productKey -notmatch '^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$') { throw "-ProductKeyFile $ProductKeyFile doesn't hold one product key (five groups of five letters or digits, joined by hyphens)." }
}
# The pool's VM limit, worked out here (read-only), before anything changes: -MaxVms, or a quarter of the host's
# logical CPUs (1-4). Step 7 writes this same value.
$poolMaxVms = $(if ($MaxVms) { $MaxVms } else { [Math]::Max(1, [Math]::Min(4, [Math]::Floor(([int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors) / 4))) })
# A project's cap or reservation for the report: a number (Windows), or one per OS, never cast.
function Format-Share($v) {
  if ($null -eq $v) { return 'none' }
  if ($v -is [ValueType]) { return "$v" }
  return (@($v.PSObject.Properties) | ForEach-Object { "$($_.Name) $($_.Value)" }) -join ', '
}
$projectsLine = 'none (one shared pool, first come first served)'
if ($projects.Count) {
  $nodeCheck = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeCheck) { throw 'Node (18 or later) is not on PATH.' }
  $why = (ConvertTo-Json -InputObject @($projects) -Depth 6 -Compress) | & $nodeCheck -e "const p = require(process.argv[1]); let t = ''; process.stdin.on('data', d => t += d).on('end', () => { const w = p.projectProblems(JSON.parse(t)); process.stdout.write(w.join('; ')) })" (Join-Path $src 'helper\policy.js')
  if ($LASTEXITCODE) { throw 'The projects check (node) failed.' }
  if ($why) { throw "The projects can't be used: $why. Nothing was changed." }
  $projectsLine = ($projects | ForEach-Object { "$($_.name) (cap $(Format-Share $_.maxVms)$(if ($_.images) { ", images $(@($_.images).Count)" }))" }) -join '; '
}
# The helper refuses a policy whose session cap is below one lease (helper/policy.js): refuse it here first.
if ($MaxSessionMinutes -and ($MaxSessionMinutes -lt 5 -or $MaxSessionMinutes -gt 1440 -or $MaxSessionMinutes -lt $MaxLeaseMinutes)) { throw "-MaxSessionMinutes must be 5-1440 and at least -MaxLeaseMinutes ($MaxLeaseMinutes)." }
# MC-1556: the network ceiling, and host mode's subnet, worked out and checked here (read-only), before anything changes.
if ($MaxNetwork -and $PSBoundParameters.ContainsKey('AllowNetwork')) { throw 'Give -MaxNetwork, or the older -AllowNetwork, not both. Nothing was changed.' }
$curPolicy = $null
$curPolicyFile = Join-Path $state 'policy.json'
if (Test-Path -LiteralPath $curPolicyFile) { try { $curPolicy = Get-Content -Raw -LiteralPath $curPolicyFile | ConvertFrom-Json } catch { $curPolicy = $null } }
$netMode = if ($MaxNetwork) { @{ None = 'none'; Host = 'host'; Internet = 'internet'; InternetLan = 'internet-lan' }[$MaxNetwork] }
  elseif ($PSBoundParameters.ContainsKey('AllowNetwork')) { if ($AllowNetwork) { 'host' } else { 'none' } }
  elseif ($curPolicy -and $curPolicy.maxNetwork) { [string]$curPolicy.maxNetwork }
  elseif ($curPolicy -and $null -ne $curPolicy.allowNetwork) { if ($curPolicy.allowNetwork) { 'host' } else { 'none' } }
  else { 'none' }
if ($netMode -notin 'none', 'host', 'internet', 'internet-lan') { throw "The current policy's network ceiling ($netMode) isn't one this setup knows: give -MaxNetwork." }
$wantHost = $netMode -ne 'none' # every mode above none includes host
$subnet = if ($HostSubnet) { $HostSubnet } elseif ($curPolicy -and $curPolicy.hostNetwork) { [string]$curPolicy.hostNetwork.subnet } else { '10.137.42.0/24' }
$hostSwName = 'hvmcp-host'
$hostSw = @(Get-VMSwitch -Name $hostSwName -ErrorAction SilentlyContinue | Where-Object { $_.Name -ceq $hostSwName })
$ourHostSw = @($hostSw | Where-Object { $_.SwitchType -eq 'Internal' -and [string]$_.Notes -match '^hvmcp:host:[0-9a-f]{32}$' }) | Select-Object -First 1
if ($hostSw.Count -and -not $ourHostSw) { throw "A switch named $hostSwName exists that setup didn't make (it isn't internal, or its Notes aren't setup's): rename or remove it, then run this again. Nothing was changed." }
# This PC's adapter for a switch (by the switch's id), or $null.
function Get-HostAdapter($switchId) {
  $m = Get-VMNetworkAdapter -ManagementOS -ErrorAction SilentlyContinue | Where-Object { ([string]$_.SwitchId).ToLower() -eq ([string]$switchId).ToLower() } | Select-Object -First 1
  if (-not $m) { return $null }
  Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object { ($_.MacAddress -replace '-', '') -eq [string]$m.MacAddress } | Select-Object -First 1
}
if ($wantHost) {
  $nodeNet = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeNet) { throw 'Node (18 or later) is not on PATH.' }
  $ourIx = if ($ourHostSw) { $a0 = Get-HostAdapter $ourHostSw.Id; if ($a0) { $a0.ifIndex } else { -1 } } else { -1 }
  $seen = @{
    others = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceIndex -ne $ourIx } | ForEach-Object { @{ alias = [string]$_.InterfaceAlias; ip = [string]$_.IPAddress; prefix = [int]$_.PrefixLength } })
    routes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.ifIndex -ne $ourIx } | ForEach-Object { @{ alias = [string]$_.InterfaceAlias; prefix = [string]$_.DestinationPrefix } })
  }
  # The helper's own rules (helper/net.js): a /24 in 10/8 or 192.168/16, overlapping nothing on another interface.
  $why = (ConvertTo-Json -InputObject $seen -Depth 4 -Compress) | & $nodeNet -e "const n = require(process.argv[1]); let t = ''; process.stdin.on('data', d => t += d).on('end', () => { const r = JSON.parse(t); process.stdout.write(n.subnetProblem(process.argv[2]) || n.clashProblem(process.argv[2], r.others || [], r.routes || []) || '') })" (Join-Path $src 'helper\net.js') $subnet
  if ($LASTEXITCODE) { throw 'The host-subnet check (node) failed.' }
  if ($why) { throw "Host mode can't use $subnet`: $why. Give another -HostSubnet (a.b.c.0/24), or -MaxNetwork None. Nothing was changed." }
}
$hostAddr = $subnet -replace '\.0/24$', '.1'
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
if ($existing -and $existing.Status -ne 'Stopped') { Stop-Service $svc -Force; (Get-Service $svc).WaitForStatus('Stopped', [TimeSpan]::FromMinutes(5)); Step "Service $svc stopped for the update." } # MC-1558: up to 5 min, the helper may be mid-operation
Set-ExclusiveAcl $install @("$SYSTEM=FullControl", "$ADMINS=FullControl", "$USERS=ReadAndExecute") -SetOwner
$bad = @(Test-ExclusiveAcl $install -Allowed $SYSTEM, $ADMINS, $USERS -Writers $SYSTEM, $ADMINS -Owners $SYSTEM, $ADMINS)
if ($bad.Count) { throw "$install isn't admin-only after setting its ACL: $($bad -join '; ')" }
# Nothing earlier in it is kept: every file the service runs is copied fresh below (a stray file could be loaded instead).
Get-ChildItem -LiteralPath $install -Force | Remove-Item -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $install 'guests') -Force | Out-Null
foreach ($f in 'core.js', 'helper.js', 'hv.js', 'hv.ps1', 'guest-sync.ps1', 'guest-agent.ps1', 'images.js', 'iso.js', 'journal.js', 'net.js', 'paths.js', 'policy.js', 'inventory.js', 'timing.js', 'unattend.js', 'approve.ps1', 'linux-images.js', 'openpgp.js', 'qcow2.js', 'seed.js', 'ssh.js', 'sshkeys.js', 'guest.py', 'guests\linux.js') {
  Copy-Item -LiteralPath (Join-Path $src "helper\$f") -Destination (Join-Path $install $f) -Force
}
Copy-Item -LiteralPath (Join-Path $src 'meta.json') -Destination (Join-Path $install 'meta.json') -Force
Step "Helper code copied to $install (only Administrators and SYSTEM can write there)."
# MC-1557: the uninstaller, installed with the helper (no repo needed to remove everything), and its Installed apps
# entry, whose launcher is fixed text (appsentry.ps1): neither needs updating when the pool changes, since the uninstaller
# reads what to remove from the helper's records when it runs.
New-Item -ItemType Directory -Path (Join-Path $install 'uninstall') -Force | Out-Null
foreach ($f in $script:RetiringSet) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $f) -Destination (Join-Path $install "uninstall\$f") -Force }
$appsVersion = (Get-Content -LiteralPath (Join-Path $src 'meta.json') -Raw | ConvertFrom-Json).version
Set-AppsEntry ([Microsoft.Win32.Registry]::LocalMachine) $script:EntryKeyPath (Get-LauncherCommand (Get-LauncherText)).command $appsVersion $install
Step "Uninstaller copied to $install\uninstall; Installed apps lists 'Hyper-V MCP helper and test VMs' (its Uninstall removes everything, or keeps the pool)."

# MC-1501: Linux guests. The helper reaches a Linux guest by SSH (Windows' in-box OpenSSH Client) over a Hyper-V
# socket: HvMcpVsock.exe, compiled here, is ssh.exe's ProxyCommand, and the vsock port 22's service id is registered as
# a guest communication service. Nothing is turned on or installed: without the OpenSSH Client, only Linux guests are
# unavailable, and setup says how to add it.
if ($LinuxTransport -ne 'HvSocket') { throw "-LinuxTransport $LinuxTransport isn't provided by this release: Linux guests use the Hyper-V socket (HvSocket). The internal switch is only on the user's decision after the trial (docs\linux-guests.md, 4.1)." }
$cscL = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $cscL)) { throw "The .NET Framework compiler is missing ($cscL)." }
$outL = & $cscL -nologo -target:exe -optimize "-out:$(Join-Path $install 'HvMcpVsock.exe')" (Join-Path $src 'helper\host\HvMcpVsock.cs') 2>&1
if ($LASTEXITCODE -ne 0) { throw "Compiling the Hyper-V socket bridge failed:`n$($outL -join "`n")" }
$gcs = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\00000016-facb-11e6-bd58-64006a7986d3'
if (-not (Test-Path $gcs)) { New-Item -Path $gcs -Force | Out-Null }
Set-ItemProperty -Path $gcs -Name ElementName -Value 'hyper-v MCP: SSH to Linux guests (vsock port 22)'
$sshExe = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
Step $(if (Test-Path $sshExe) { "Linux guests: SSH over the Hyper-V socket (HvMcpVsock.exe compiled; vsock port 22 registered); Windows' OpenSSH Client is present." } else { "Linux guests: HvMcpVsock.exe compiled and vsock port 22 registered, but Windows' OpenSSH Client is missing, so Linux guests can't be reached: add it in Settings, System, Optional features (OpenSSH Client), then run setup again. Setup doesn't add it." })

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

# 6b. MC-1556: host mode's switch and this PC's address on it, when the ceiling is Host or above (the service is stopped,
# so no run is using it). The switch is recognised by its name and the Notes setup wrote, never by its name alone; this
# PC's adapter on it gets exactly the subnet's .1, nothing else. Below Host, setup's switch is removed.
$hostNetwork = $null
if ($wantHost) {
  if (-not $ourHostSw) {
    $tok = -join ((1..16) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
    $ourHostSw = New-VMSwitch -Name $hostSwName -SwitchType Internal -Notes "hvmcp:host:$tok"
  }
  $hif = $null
  $t = (Get-Date).AddSeconds(30)
  while (-not ($hif = Get-HostAdapter $ourHostSw.Id) -and (Get-Date) -lt $t) { Start-Sleep 1 }
  if (-not $hif) { throw "This PC's adapter on $hostSwName didn't appear: run setup again." }
  $have = @(Get-NetIPAddress -InterfaceIndex $hif.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue)
  if (-not ($have.Count -eq 1 -and $have[0].IPAddress -eq $hostAddr -and $have[0].PrefixLength -eq 24)) {
    Set-NetIPInterface -InterfaceIndex $hif.ifIndex -AddressFamily IPv4 -Dhcp Disabled
    $have | Remove-NetIPAddress -Confirm:$false
    New-NetIPAddress -InterfaceIndex $hif.ifIndex -IPAddress $hostAddr -PrefixLength 24 | Out-Null
  }
  $have = @(Get-NetIPAddress -InterfaceIndex $hif.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue)
  if (-not ($have.Count -eq 1 -and $have[0].IPAddress -eq $hostAddr -and $have[0].PrefixLength -eq 24)) { throw "This PC's address on $hostSwName isn't exactly $hostAddr/24 after setting it: run setup again." }
  $hostNetwork = [ordered]@{ switchId = $ourHostSw.Id.ToString(); switchName = $hostSwName; subnet = $subnet; hostAddress = $hostAddr }
  Step "Host mode: internal switch $hostSwName; this PC is $hostAddr on $subnet (VMs get .10 upwards when they start in host mode)."
} elseif ($ourHostSw) {
  Remove-VMSwitch -VMSwitch $ourHostSw -Force
  Step "Host mode: off. Setup's switch $hostSwName (and this PC's address on it) removed."
}

# 7. The policy: hard limits for every pool change, writable only by Administrators and SYSTEM. Written with its final
# ACL from the moment it exists (a new file, then renamed over the old one).
$cs = Get-CimInstance Win32_ComputerSystem
$cpus = [int]$cs.NumberOfLogicalProcessors
$ramGB = [int][Math]::Floor($cs.TotalPhysicalMemory / 1GB)
$policy = [ordered]@{
  schema = 1; prefix = 'hvmcp'
  maxVms = $poolMaxVms
  maxCoresPerVm = $(if ($MaxCoresPerVm) { $MaxCoresPerVm } else { [Math]::Max(1, [Math]::Min(8, [Math]::Floor($cpus / 4))) })
  maxMemoryMBTotal = $(if ($MaxMemoryGB) { $MaxMemoryGB * 1024 } else { [Math]::Max(4096, [Math]::Floor($ramGB / 2) * 1024) })
  maxDiskGBPerVm = $MaxDiskGBPerVm; diskFolders = $folders; maxNetwork = $netMode
  maxReservePercent = $MaxReservePercent; maxLeaseMinutes = $MaxLeaseMinutes; maxBuildMB = $MaxBuildMB
  allowUnpinnedIso = [bool]$AllowUnpinnedIso
  buildRoots = @($buildRoots)
  linuxTransport = 'hvsocket'
}
if ($projects.Count) { $policy.projects = @($projects) } # checked, against this maxVms, before anything changed
if ($MaxSessionMinutes) { $policy.maxSessionMinutes = $MaxSessionMinutes }
if ($hostNetwork) { $policy.hostNetwork = $hostNetwork } # MC-1556
$policyFile = Join-Path $state 'policy.json'
Write-SecureFile $policyFile ($policy | ConvertTo-Json -Depth 4) @("$SYSTEM=FullControl", "$ADMINS=FullControl", "$runnerSid=ReadAndExecute") $ADMINS
$keyFile = Join-Path (Join-Path $state 'secrets') 'product-key.json'
if ($productKey) {
  New-Item -ItemType Directory -Force -Path (Join-Path $state 'secrets') | Out-Null
  Write-SecureFile $keyFile (ConvertTo-Json -InputObject @{ key = $productKey } -Compress) @("$SYSTEM=FullControl", "$ADMINS=FullControl", "$runnerSid=ReadAndExecute") $ADMINS
} elseif ($ProductKeyFile -eq 'none' -and (Test-Path -LiteralPath $keyFile)) { Remove-Item -LiteralPath $keyFile -Force }
$keyLine = $(if (Test-Path -LiteralPath $keyFile) { 'set (used only for VMs built from a non-evaluation image)' } else { 'none' })
$defaultSwitch = [bool](Get-VMSwitch -Id 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444' -ErrorAction SilentlyContinue)

# The result, checked: only SYSTEM, Administrators and the helper's account have any access to the state; only the
# first two can write policy.json and approvals\; the disk folders also allow Hyper-V's per-VM SIDs.
$bad = @(Test-ExclusiveAcl $state -Allowed $SYSTEM, $ADMINS, $runnerSid -Owners $SYSTEM, $ADMINS, $runnerSid) +
  @(Test-ExclusiveAcl $approvals -Allowed $SYSTEM, $ADMINS, $runnerSid -Writers $SYSTEM, $ADMINS -Owners $SYSTEM, $ADMINS) +
  @(Test-ExclusiveAcl $policyFile -Allowed $SYSTEM, $ADMINS, $runnerSid -Writers $SYSTEM, $ADMINS -Owners $SYSTEM, $ADMINS)
foreach ($d in $folders) { $bad += @(Test-ExclusiveAcl $d -Allowed $SYSTEM, $ADMINS, $runnerSid -AllowPattern $script:HyperVGrantees) }
if ($bad.Count) { throw "The helper's folders aren't as setup made them: $($bad -join '; ')" }
Step "State in $state; VM disks in $($folders -join ', '); ACLs checked."
Step "Build folders set by an admin (beside each client's MCP roots): $(if ($buildRoots.Count) { $buildRoots -join '; ' } else { 'none' })."
Step "Projects sharing the pool: $projectsLine."
Step "Product key (-ProductKeyFile): $keyLine."
Step $(if ($defaultSwitch) { "Default Switch: present. Each evaluation VM goes online through it once, when it is built, to activate Windows (about 90 days from then); runs use it only in the internet modes, when a plan the user approved allows them." } else { "Default Switch: absent. Evaluation VMs can't be activated here, so pools need a non-evaluation image (an own copy, built offline), and the internet modes can't be used." })
Step ("Policy: up to {0} VMs, {1} cores each, {2} GB memory in all, {3} GB disks; network {4}; unpinned ISOs {5}; leases up to {6} min, work sessions up to {7} min." -f $policy.maxVms, $policy.maxCoresPerVm, ($policy.maxMemoryMBTotal / 1024), $policy.maxDiskGBPerVm, "up to $netMode (each pool's mode is chosen in the plan you approve)", $(if ($AllowUnpinnedIso) { 'allowed' } else { 'refused' }), $MaxLeaseMinutes, $(if ($MaxSessionMinutes) { $MaxSessionMinutes } else { [Math]::Max($MaxLeaseMinutes, 480) }))

# 8. Start.
if ($Mode -eq 'Service') {
  Start-Service $svc
  # MC-1558: as long as the host allows the helper to get ready (30 min: it restores every VM first), saying so after 5.
  $t0 = Get-Date; $said = $false
  while (-not (PipeOpen) -and ((Get-Date) - $t0).TotalMinutes -lt 30) {
    if ((Get-Service $svc).Status -eq 'Stopped') { throw "The service stopped: see $state\host.log and $state\helper.log." }
    if (-not $said -and ((Get-Date) - $t0).TotalMinutes -ge 5) { Step 'The helper is still starting (it restores every pool VM first): waiting up to 30 minutes in all.'; $said = $true }
    Start-Sleep 1
  }
  if (-not (PipeOpen)) { throw "The helper didn't open its pipe within 30 minutes: see $state\host.log and $state\helper.log." }
  Step 'The helper is running.'
}
# The pool's licences (MC-1513), read from the journal without writing it, by the helper's own code.
$licScript = @'
const fs = require('fs'), path = require('path')
const [inst, st] = process.argv.slice(1)
const file = path.join(st, 'journal.jsonl')
if (!fs.existsSync(file)) { console.log('no pool yet'); process.exit(0) }
const { Journal } = require(path.join(inst, 'journal.js'))
const { expiry } = require(path.join(inst, 'core.js'))
const j = new Journal(st)
j.records = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const vms = [...j.state().vms.values()].filter(v => v.ready)
console.log(vms.length ? vms.map(v => v.vmName + expiry(v, Date.now())).join(' | ') : 'no VMs yet')
'@
try { $lic = (& $node -e $licScript $install $state 2>&1) -join ' ' } catch { $lic = "couldn't be read ($($_.Exception.Message))" }
Step "The pool's VMs and their Windows licences: $lic"
} finally {
  # Every handle setup opened (the pinned parents and storage folders), and the receipts key, on every path out.
  Close-Pins $pins
  if ($receipts) { $receipts.Dispose() }
}
if ($hostNetwork) {
  # MC-1556: never run by setup. Printed so the user can choose what host-mode VMs may reach on this PC.
  Write-Host ''
  Write-Host "Host mode: a VM reaches only this PC, at $hostAddr, and only on ports this PC's firewall allows. Setup changed no firewall rule."
  Write-Host 'To let host-mode VMs reach a service here, for example Ollama on port 11434, you can run this yourself in an admin PowerShell:'
  Write-Host "  New-NetFirewallRule -DisplayName 'hyper-v MCP host mode: TCP 11434' -Direction Inbound -Protocol TCP -LocalPort 11434 -LocalAddress $hostAddr -RemoteAddress $subnet -Action Allow"
  Write-Host "and make the service listen beyond localhost (for Ollama: set OLLAMA_HOST to $hostAddr`:11434, or 0.0.0.0:11434, then restart it)."
  Write-Host "To undo: Remove-NetFirewallRule -DisplayName 'hyper-v MCP host mode: TCP 11434'"
}
Write-Host ''
Write-Host "Done ($Mode mode). Add the server to your MCP client with HYPERV_MCP_ENABLED=1$(if ($Mode -eq 'Direct') { ' and HYPERV_MCP_MODE=direct' }) (see the README), then ask an agent to plan a pool (pool_plan)." -ForegroundColor Green
