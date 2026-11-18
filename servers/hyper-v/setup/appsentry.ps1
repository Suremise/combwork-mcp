# MC-1557: the Installed apps entry, its launcher, the retire phase and the uninstaller's temporary copy. Dot-sourced by
# install.ps1 and uninstall.ps1 after acl.ps1 and teardown.ps1; tested non-elevated by test\appsentry-check.ps1.
#
# The entry (HKLM\...\Uninstall\HyperVMcp) runs a fixed launcher, never a path from the registry:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand <the launcher>
# The launcher takes its paths from Windows' known folders and fixed names, elevates itself, then, in this order:
#   a. hyperv-mcp\uninstall\uninstall.ps1 exists: runs it (-Interactive). The normal route; it resumes any unfinished
#      uninstall.
#   b. all five retiring files (uninstall.retiring\: uninstall.ps1, teardown.ps1, acl.ps1, appsentry.ps1, Storage.cs)
#      exist: runs
#      that uninstall.ps1 -Retire.
#   c. otherwise it finishes the uninstaller's own leftovers, only when they are exactly that shape (the install folder
#      holding nothing but uninstall.retiring\ with some of those five files, no links, trusted owners, no service, no
#      unfinished uninstall): those files by name, then the two folders, each non-recursively. Anything else is left
#      untouched and the manual step printed.
#   d. then the entry's own key, only when nothing of the MCP is left (remove), or when a verified keep-pool record
#      (KeptPool, bound to this install's InstallId, in a key only SYSTEM and Administrators can write) says the kept
#      state is meant to stay (keep).
# Its only deletions are c's fixed files and folders and d's key.
#
# The retire phase (Invoke-Retire), after a finished teardown: R1 (the caller's live leftover check) -> R2 uninstall\
# renamed to uninstall.retiring\ in one step (verified first) -> R3a everything else in the install folder removed with
# the established routines -> R3b and R4: the launcher's own finish (c, d). An interruption anywhere is finished from
# Installed apps: before R2 by a, after R2 by b, inside R3b by c, after it by d.

$script:EntryKeyPath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\HyperVMcp'
$script:RetiringSet = @('uninstall.ps1', 'teardown.ps1', 'acl.ps1', 'appsentry.ps1', 'Storage.cs')

# The launcher's text. $Overrides (tests only): a hashtable of config values that replace the production ones (pf,
# state, hive, stateKey, entryKey, service, trusted, elevate, pause).
function Get-LauncherText([hashtable]$Overrides = @{}) {
  $over = if ($Overrides.Count) { ($Overrides | ConvertTo-Json -Compress -Depth 4) -replace "'", "''" } else { '' }
  return @'
$ErrorActionPreference = 'Stop'
$c = @{
  pf = [Environment]::GetFolderPath('ProgramFiles')
  state = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'hyperv-mcp'
  hive = 'LocalMachine'
  stateKey = 'SOFTWARE\hyperv-mcp'
  entryKey = 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\HyperVMcp'
  service = 'HyperVMcp'
  trusted = @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  elevate = $true
  pause = $true
}
$over = '__OVERRIDES__'
if ($over) { foreach ($p in ($over | ConvertFrom-Json).PSObject.Properties) { $c[$p.Name] = $p.Value } }
$finishOnly = $args.Count -gt 0 -and $args[0] -eq 'finish'
$expected = if ($finishOnly) { [string]$args[1] } else { $null }
if (-not $finishOnly) {
  $cl = [Environment]::GetCommandLineArgs()
  for ($i = 0; $i -lt $cl.Count - 1; $i++) { if ($cl[$i] -ieq '-EncodedCommand') { $expected = $cl[$i + 1] } }
}
function Close-Launcher([int]$code) {
  if ($finishOnly) { if ($code) { throw 'internal: finish' } else { return } }
  if ($c.pause) { [void](Read-Host 'Press Enter to close') }
  exit $code
}
function Stop-Launcher([string]$m) {
  if ($finishOnly) { throw $m }
  Write-Host $m -ForegroundColor Yellow
  Close-Launcher 1
}
$admin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $finishOnly -and $c.elevate -and -not $admin) {
  if (-not $expected) { Stop-Launcher 'Run this from Installed apps, or in an admin PowerShell.' }
  Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $expected)
  exit 0
}
$inst = Join-Path $c.pf 'hyperv-mcp'
$ret = Join-Path $inst 'uninstall.retiring'
$set = @('uninstall.ps1', 'teardown.ps1', 'acl.ps1', 'appsentry.ps1', 'Storage.cs')
$root = if ($c.hive -eq 'CurrentUser') { [Microsoft.Win32.Registry]::CurrentUser } else { [Microsoft.Win32.Registry]::LocalMachine }
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not $finishOnly) {
  $main = Join-Path $inst 'uninstall\uninstall.ps1'
  if (Test-Path -LiteralPath $main -PathType Leaf) { & $ps -NoProfile -ExecutionPolicy Bypass -File $main -Interactive; Close-Launcher $LASTEXITCODE }
  if (@($set | Where-Object { Test-Path -LiteralPath (Join-Path $ret $_) -PathType Leaf }).Count -eq $set.Count) { & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ret 'uninstall.ps1') -Retire; Close-Launcher $LASTEXITCODE }
}
function Test-OwnerOk([string]$p) { try { return $c.trusted -contains (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { return $false } }
function Test-Plain([string]$p) { return -not ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
$svcHere = [bool](Get-Service -Name $c.service -ErrorAction SilentlyContinue)
$sk = $root.OpenSubKey($c.stateKey)
$record = $false; $kp = $null; $iid = $null; $keyWhy = $null
if ($sk) {
  try {
    $record = $null -ne $sk.GetValue('Teardown'); $kp = $sk.GetValue('KeptPool'); $iid = $sk.GetValue('InstallId')
    $acl = $sk.GetAccessControl()
    if ($c.trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { $keyWhy = "$($c.stateKey) has an unexpected owner" }
    $write = [Security.AccessControl.RegistryRights]'SetValue, CreateSubKey, Delete, ChangePermissions, TakeOwnership, CreateLink'
    foreach ($r in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($r.AccessControlType -eq 'Allow' -and ($r.RegistryRights -band $write) -and $c.trusted -notcontains $r.IdentityReference.Value) { $keyWhy = "$($c.stateKey) can be written by $($r.IdentityReference.Value)" }
    }
  } finally { $sk.Dispose() }
}
$manual = "Run the uninstaller from the repo (servers\hyper-v\setup\uninstall.ps1, in an admin Windows PowerShell), or follow the manual steps in $(Join-Path $c.state 'inventory.txt') if it is still there."
# c: the uninstaller's own leftovers, only in exactly the shape it leaves them.
if (Test-Path -LiteralPath $inst) {
  $why = $null
  if (-not (Test-Path -LiteralPath $inst -PathType Container) -or -not (Test-Plain $inst) -or -not (Test-OwnerOk $inst)) { $why = "$inst is a link, isn't a folder, or has an unexpected owner" }
  else {
    $kids = @(Get-ChildItem -LiteralPath $inst -Force)
    $odd = @($kids | Where-Object { $_.Name -ne 'uninstall.retiring' -or -not $_.PSIsContainer })
    if ($odd.Count) { $why = "$inst holds $($odd[0].Name), which the uninstaller doesn't leave behind" }
    elseif ($kids.Count) {
      if (-not (Test-Plain $ret) -or -not (Test-OwnerOk $ret)) { $why = "$ret is a link or has an unexpected owner" }
      else {
        $bad = @(Get-ChildItem -LiteralPath $ret -Force | Where-Object { $set -notcontains $_.Name -or $_.PSIsContainer -or -not (Test-Plain $_.FullName) -or -not (Test-OwnerOk $_.FullName) })
        if ($bad.Count) { $why = "$ret holds $($bad[0].Name), which isn't one of the uninstaller's own files as it leaves them" }
      }
    }
  }
  if (-not $why -and $svcHere) { $why = "the service $($c.service) is still installed" }
  if (-not $why -and $record) { $why = 'an uninstall is unfinished' }
  if ($why) { Stop-Launcher "Nothing was removed: $why. $manual" }
  foreach ($n in $set) { $f = Join-Path $ret $n; if (Test-Path -LiteralPath $f) { [IO.File]::Delete($f) } }
  if (Test-Path -LiteralPath $ret) { [IO.Directory]::Delete($ret) }
  [IO.Directory]::Delete($inst)
  Write-Host "Removed $inst."
}
# d: the entry's own key.
if ($svcHere) { Stop-Launcher "The service $($c.service) is still installed, so the uninstall isn't finished. $manual" }
$kept = $false
if ($sk) {
  $m = if ($kp) { try { $kp | ConvertFrom-Json } catch { $null } } else { $null }
  if ($record) { Stop-Launcher "An uninstall is unfinished ($($c.stateKey) holds its record). $manual" }
  if ($keyWhy) { Stop-Launcher "The entry was kept: $keyWhy. $manual" }
  if (-not $m -or -not $iid -or [string]$m.installId -ne [string]$iid) { Stop-Launcher "The entry was kept: $($c.stateKey) is still there without a matching record of a finished keep-pool uninstall. $manual" }
  $kept = $true
} elseif (Test-Path -LiteralPath $c.state) { Stop-Launcher "The entry was kept: the helper's state folder $($c.state) is still there. $manual" }
$ek = $root.OpenSubKey($c.entryKey)
if ($ek) {
  $u = [string]$ek.GetValue('UninstallString'); $ek.Dispose()
  if (-not $expected -or $u.IndexOf($expected, [StringComparison]::Ordinal) -lt 0) { Stop-Launcher "The Installed apps entry $($c.entryKey) isn't the one setup writes: it was left in place. Remove it by hand if you're sure." }
  $root.DeleteSubKey($c.entryKey, $false)
  Write-Host 'Removed the Installed apps entry.'
}
if ($kept) { Write-Host "The hyper-v MCP helper is removed. Its pool, state ($($c.state)) and disk folders were kept: to remove them, run setup again (it restores the helper and this entry), then uninstall." -ForegroundColor Green }
else { Write-Host 'Nothing of the hyper-v MCP is left.' -ForegroundColor Green }
Close-Launcher 0
'@.Replace('__OVERRIDES__', $over)
}

# The UninstallString for a launcher text.
function Get-LauncherCommand([string]$Text) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Text))
  return [pscustomobject]@{ b64 = $b64; command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $b64" }
}

# Writes (or refreshes) the Installed apps entry. $Root/$Path: HKLM and $script:EntryKeyPath for setup; a test key in tests.
function Set-AppsEntry([Microsoft.Win32.RegistryKey]$Root, [string]$Path, [string]$Command, [string]$Version, [string]$InstallDir) {
  $k = $Root.CreateSubKey($Path)
  try {
    $k.SetValue('DisplayName', 'Hyper-V MCP helper and test VMs')
    $k.SetValue('Publisher', 'Combwork MCP servers')
    $k.SetValue('DisplayVersion', [string]$Version)
    $k.SetValue('InstallLocation', $InstallDir)
    $k.SetValue('UninstallString', $Command)
    $k.SetValue('NoModify', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
    $k.SetValue('NoRepair', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
  } finally { $k.Dispose() }
}

# A folder only $Owner and $Grants can use, under $Parent, holding copies of $Files: the uninstaller runs from it, so it
# can remove its own folder and no non-elevated process can change what runs. Verified before anything is copied in.
#  Setup's owner is Administrators (-SetOwner); a non-elevated test leaves itself the owner and names it in $Owners.
function New-ProtectedCopy([string]$Parent, [string[]]$Files, [string[]]$Owners, [string[]]$Grants, [switch]$SetOwner) {
  $dir = Join-Path $Parent "hvmcp-uninstall-$([guid]::NewGuid().ToString('n'))"
  New-Item -ItemType Directory -Path $dir | Out-Null
  Set-ExclusiveAcl $dir @($Grants | ForEach-Object { "$_=FullControl" }) -SetOwner:$SetOwner
  $bad = @(Test-ExclusiveAcl $dir -Allowed $Grants -Writers $Grants -Owners $Owners)
  if ($bad.Count) { Remove-Item -LiteralPath $dir -Recurse -Force; throw "The uninstaller's temporary folder isn't protected: $($bad -join '; ')" }
  foreach ($f in $Files) { Copy-Item -LiteralPath $f -Destination (Join-Path $dir (Split-Path -Leaf $f)) }
  return $dir
}

# The retire phase, after R1 passed (or from uninstall.retiring\, after R2). $Launcher: the launcher's text as a script
# block (the same text as the entry's); $Expected: its encoded command, which the entry must carry to be removed.
function Invoke-Retire([string]$ProgramFiles, [string[]]$Trusted, [string[]]$RootOwners, [scriptblock]$Launcher, [string]$Expected, [scriptblock]$Crash) {
  $boundary = { param($n) if ($Crash) { & $Crash $n } }
  $inst = Join-Path $ProgramFiles 'hyperv-mcp'
  $un = Join-Path $inst 'uninstall'
  $ret = Join-Path $inst 'uninstall.retiring'
  $pins = New-Object Collections.ArrayList
  try {
    if (Test-Path -LiteralPath $un) {
      if (Test-Path -LiteralPath $ret) { throw "Both $un and $ret exist: the uninstaller won't choose between them. Nothing was changed." }
      Open-TrustedAncestors $un $Trusted $pins
      $h = [HvMcpStorage]::Open($un)
      try { if ([HvMcpStorage]::Attributes($h) -band [HvMcpStorage]::FILE_ATTRIBUTE_REPARSE_POINT) { throw "$un is a link: it won't be used." } } finally { $h.Dispose() }
      if ($RootOwners -notcontains (Get-Acl -LiteralPath $un).GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw "$un has an unexpected owner: it won't be used." }
      Close-Pins $pins; $pins.Clear()
      [IO.Directory]::Move($un, $ret)
      & $boundary 'after:R2'
    }
    if (Test-Path -LiteralPath $inst) {
      Open-TrustedAncestors $inst $Trusted $pins
      $h = [HvMcpStorage]::Open($inst)
      try { if ([HvMcpStorage]::Attributes($h) -band [HvMcpStorage]::FILE_ATTRIBUTE_REPARSE_POINT) { throw "$inst is a link: it won't be deleted." } } finally { $h.Dispose() }
      foreach ($x in @(Get-ChildItem -LiteralPath $inst -Force | Where-Object { $_.Name -ne 'uninstall.retiring' })) { Remove-TreeNoFollow $x.FullName }
      Close-Pins $pins; $pins.Clear()
      & $boundary 'after:R3a'
    }
  } finally { Close-Pins $pins }
  & $Launcher 'finish' $Expected
}
