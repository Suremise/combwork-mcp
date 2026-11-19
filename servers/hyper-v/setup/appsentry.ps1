# MC-1557: the Installed apps entry, its launcher, the retire phase and the uninstaller's temporary copy. Dot-sourced by
# install.ps1 and uninstall.ps1 after acl.ps1 and teardown.ps1; tested non-elevated by test\appsentry-check.ps1.
#
# The entry (HKLM\...\Uninstall\HyperVMcp) runs a fixed launcher, never a path from the registry:
#   "<engine>" -NoProfile -ExecutionPolicy Bypass -EncodedCommand <the launcher>
# <engine> (MC-1575): Windows PowerShell 5.1's powershell.exe where it is installed, else PowerShell 7's pwsh.exe, each
# the one setup ran in when that is registered in HKLM (Get-SetupEngine). The launcher elevates and runs the uninstaller
# with that same engine, the one it is running in.
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
# state, regRoot, stateKey, entryKey, service, trusted, elevate, pause).
function Get-LauncherText([hashtable]$Overrides = @{}) {
  $over = if ($Overrides.Count) { ($Overrides | ConvertTo-Json -Compress -Depth 4) -replace "'", "''" } else { '' }
  return @'
$ErrorActionPreference = 'Stop'
$c = @{
  pf = [Environment]::GetFolderPath('ProgramFiles')
  state = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'hyperv-mcp'
  regRoot = 'LocalMachine'
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
# The engine this launcher runs in (the entry's own, from HKLM), for elevating and for the uninstaller (MC-1575).
$ps = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
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
  if (-not $expected) { Stop-Launcher 'Run this from Installed apps, or in an admin terminal.' }
  Start-Process -FilePath $ps -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $expected)
  exit 0
}
$inst = Join-Path $c.pf 'hyperv-mcp'
$ret = Join-Path $inst 'uninstall.retiring'
$set = @('uninstall.ps1', 'teardown.ps1', 'acl.ps1', 'appsentry.ps1', 'Storage.cs')
$root = if ($c.regRoot -eq 'CurrentUser') { [Microsoft.Win32.Registry]::CurrentUser } else { [Microsoft.Win32.Registry]::LocalMachine }
# Trust, for anything the launcher runs or deletes (MC-1557 round 1): it exists, isn't a link (reparse point), its owner
# is trusted, and no one else may write to, delete or re-permission it (inherit-only entries, which apply only to new
# children, aside).
function Test-OwnerOk([string]$p) { try { return $c.trusted -contains (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { return $false } }
function Test-Plain([string]$p) { return -not ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
function Get-TrustProblem([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return "$p is missing" }
  if (-not (Test-Plain $p)) { return "$p is a link" }
  if (-not (Test-OwnerOk $p)) { return "$p has an unexpected owner" }
  $write = 2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288 -bor 0x40000000 -bor 0x10000000
  foreach ($r in (Get-Acl -LiteralPath $p).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($r.AccessControlType -ne 'Allow' -or ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    if (([int]$r.FileSystemRights -band $write) -and $c.trusted -notcontains $r.IdentityReference.Value) { return "$p can be changed by $($r.IdentityReference.Value)" }
  }
  return $null
}
# A script folder the launcher may run from: its parents (Program Files and the install folder) and itself trusted, and
# holding exactly the uninstaller's files, each a trusted regular file.
function Get-SetProblem([string]$dir) {
  foreach ($p in @($c.pf, $inst, $dir)) { $w = Get-TrustProblem $p; if ($w) { return $w } }
  $names = @(Get-ChildItem -LiteralPath $dir -Force | ForEach-Object { $_.Name })
  $odd = @($names | Where-Object { $set -notcontains $_ }); if ($odd.Count) { return "$dir holds $($odd[0]), which setup doesn't put there" }
  foreach ($n in $set) {
    $f = Join-Path $dir $n
    if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { return "$f is missing" }
    $w = Get-TrustProblem $f; if ($w) { return $w }
  }
  return $null
}
if (-not $finishOnly) {
  $un = Join-Path $inst 'uninstall'
  if (Test-Path -LiteralPath $un) {
    $w = Get-SetProblem $un
    if ($w) { Stop-Launcher "Nothing was run or removed: $w. Run the uninstaller from the repo (servers\hyper-v\setup\uninstall.ps1, in an admin terminal)." }
    & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $un 'uninstall.ps1') -Interactive; Close-Launcher $LASTEXITCODE
  }
  if ((Test-Path -LiteralPath $ret) -and @($set | Where-Object { Test-Path -LiteralPath (Join-Path $ret $_) }).Count -eq $set.Count) {
    $w = Get-SetProblem $ret
    if ($w) { Stop-Launcher "Nothing was run or removed: $w. Run the uninstaller from the repo (servers\hyper-v\setup\uninstall.ps1, in an admin terminal)." }
    & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $ret 'uninstall.ps1') -Retire; Close-Launcher $LASTEXITCODE
  }
}
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
$manual = "Run the uninstaller from the repo (servers\hyper-v\setup\uninstall.ps1, in an admin terminal), or follow the manual steps in $(Join-Path $c.state 'inventory.txt') if it is still there."
# c: the uninstaller's own leftovers, only in exactly the shape it leaves them.
if (Test-Path -LiteralPath $inst) {
  $why = $null
  $why = $null
  foreach ($p in @($c.pf, $inst)) { if (-not $why) { $why = Get-TrustProblem $p } }
  if (-not $why -and -not (Test-Path -LiteralPath $inst -PathType Container)) { $why = "$inst isn't a folder" }
  if (-not $why) {
    $kids = @(Get-ChildItem -LiteralPath $inst -Force)
    $odd = @($kids | Where-Object { $_.Name -ne 'uninstall.retiring' -or -not $_.PSIsContainer })
    if ($odd.Count) { $why = "$inst holds $($odd[0].Name), which the uninstaller doesn't leave behind" }
    elseif ($kids.Count) {
      $why = Get-TrustProblem $ret
      if (-not $why) {
        foreach ($x in @(Get-ChildItem -LiteralPath $ret -Force)) {
          if ($set -notcontains $x.Name -or $x.PSIsContainer) { $why = "$ret holds $($x.Name), which isn't one of the uninstaller's own files as it leaves them"; break }
          $w = Get-TrustProblem $x.FullName; if ($w) { $why = $w; break }
        }
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

# MC-1575: the PowerShells registered in HKLM (admin-only), never found from PATH or the environment: Windows PowerShell
# 5.1's powershell.exe first, then each PowerShell 7's pwsh.exe, each only if the file is there. $Root, $Key51 and $Key7
# (tests only) name other keys.
function Get-PsEngines([Microsoft.Win32.RegistryKey]$Root = [Microsoft.Win32.Registry]::LocalMachine,
  [string]$Key51 = 'SOFTWARE\Microsoft\PowerShell\3\PowerShellEngine', [string]$Key7 = 'SOFTWARE\Microsoft\PowerShellCore\InstalledVersions') {
  $out = @()
  $k = $Root.OpenSubKey($Key51)
  if ($k) {
    try { $b = [string]$k.GetValue('ApplicationBase') } finally { $k.Dispose() }
    if ($b) { $exe = Join-Path $b 'powershell.exe'; if (Test-Path -LiteralPath $exe -PathType Leaf) { $out += $exe } }
  }
  $k = $Root.OpenSubKey($Key7)
  if ($k) {
    try {
      foreach ($n in $k.GetSubKeyNames()) {
        $v = $k.OpenSubKey($n); if (-not $v) { continue }
        try { $b = [string]$v.GetValue('InstallLocation') } finally { $v.Dispose() }
        if ($b) { $exe = Join-Path $b 'pwsh.exe'; if (Test-Path -LiteralPath $exe -PathType Leaf) { $out += $exe } }
      }
    } finally { $k.Dispose() }
  }
  return , $out
}

# The PowerShell to run elevated scripts with, as the .cmd launchers choose it: Windows PowerShell 5.1 where it is
# installed, else the last PowerShell 7 registered.
function Get-PsEngine([string[]]$Engines = (Get-PsEngines)) {
  if (-not $Engines.Count) { throw 'Neither Windows PowerShell nor PowerShell 7 is installed.' }
  if ($Engines[0] -match '\\powershell\.exe$') { return $Engines[0] }
  return $Engines[-1]
}

# Setup's: the PowerShell it runs in ($Current), when that is one registered in HKLM (so a copy anywhere else, such as one
# a user could replace, is never recorded for the service or the Installed apps entry); else Get-PsEngine's.
function Get-SetupEngine([string]$Current = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, [string[]]$Engines = (Get-PsEngines)) {
  foreach ($e in $Engines) { if ([IO.Path]::GetFullPath($e) -ieq [IO.Path]::GetFullPath($Current)) { return $e } }
  return (Get-PsEngine $Engines)
}

# The UninstallString for a launcher text, run by $Engine (default: Get-PsEngine's).
function Get-LauncherCommand([string]$Text, [string]$Engine = (Get-PsEngine)) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Text))
  return [pscustomobject]@{ b64 = $b64; command = "`"$Engine`" -NoProfile -ExecutionPolicy Bypass -EncodedCommand $b64" }
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

# MC-1567: an earlier run's protected copy, left when that run was interrupted (its window closed, so its finally never
# ran). Removed only when it is exactly what New-ProtectedCopy makes: a folder (not a link) directly under $Parent named
# hvmcp-uninstall-<32 hex>, owned by one of $Owners, only $Grants granted (on it and everything in it), holding only
# regular files with the RetiringSet's names. A copy a running process names on its command line (an uninstall still
# running from it) and $Skip are left. Each is removed by its file names, then the empty folder: never recursively.
# Anything else under $Parent is never touched. Returns one line per copy: removed, or left and why.
# Whether a copy is in use is known only from a whole process list: any error from the query, or a list without this
# process in it, leaves every copy (MC-1567 round 1). $ProcessQuery (tests only) replaces the query.
function Remove-StaleProtectedCopies([string]$Parent, [string[]]$Owners, [string[]]$Grants, [string]$Skip, [scriptblock]$ProcessQuery = { Get-CimInstance Win32_Process -ErrorAction Stop }) {
  $out = @()
  if (-not (Test-Path -LiteralPath $Parent -PathType Container)) { return $out }
  $cands = @(Get-ChildItem -LiteralPath $Parent -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^hvmcp-uninstall-[0-9a-f]{32}$' })
  if (-not $cands.Count) { return $out }
  $unknown = $null
  try {
    $procs = @(& $ProcessQuery)
    if (-not @($procs | Where-Object { [int]$_.ProcessId -eq $PID }).Count) { $unknown = 'the process list was incomplete' }
    $cmds = @($procs | ForEach-Object { [string]$_.CommandLine } | Where-Object { $_ })
  } catch { $unknown = "the process list couldn't be read: $($_.Exception.Message)" }
  foreach ($d in $cands) {
    $p = $d.FullName
    $why = $null
    if ($Skip -and $p -ieq $Skip.TrimEnd('\')) { continue }
    if ($unknown) { $why = "whether an uninstall still runs from it is unknown: $unknown" }
    elseif ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) { $why = 'it is a link' }
    elseif (-not $d.PSIsContainer) { $why = 'it is not a folder' }
    elseif (@($cmds | Where-Object { $_.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count) { $why = 'an uninstall is still running from it' }
    else {
      $owner = try { (Get-Acl -LiteralPath $p).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch { $null }
      if ($Owners -notcontains $owner) { $why = "it is owned by $owner" }
      else {
        # Its contents first (no folders or links inside, so the ACL check below reads only these files).
        $odd = @(Get-ChildItem -LiteralPath $p -Force | Where-Object { $_.PSIsContainer -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $script:RetiringSet -notcontains $_.Name })
        if ($odd.Count) { $why = "it holds $($odd[0].Name), which the uninstaller doesn't copy there" }
        else { $bad = @(Test-ExclusiveAcl $p -Allowed $Grants -Writers $Grants); if ($bad.Count) { $why = $bad[0] } }
      }
    }
    if ($why) { $out += "left $p ($why)"; continue }
    try {
      foreach ($n in $script:RetiringSet) { $f = Join-Path $p $n; if ([IO.File]::Exists($f)) { [IO.File]::Delete($f) } }
      [IO.Directory]::Delete($p)
      $out += "removed $p"
    } catch { $out += "left $p ($($_.Exception.Message))" }
  }
  return $out
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

# The uninstaller's top level (uninstall.ps1 wires the real actions in $X; test\appsentry-check.ps1 fakes them), so its
# decisions are tested as they run. $P: KeepPool, RemovePool, WhatIf, Retire. $X: Say, ServiceHere, StateHere, KeyHere,
# KeptMark, InstallHere, EntryHere, ShowInventory, ShowChoices, Ask ('remove' | 'keep' | 'list' | $null), Teardown
# (mode, whatIf), HostSwitches (count), RemoveHostSwitches, Leftovers (mode: the list), WriteKept, Retire. Returns the
# exit code.
# -WhatIf changes nothing on every path, -Retire included. Whatever a run was interrupted after (the teardown, the
# switch's removal), a rerun ends the same way: setup's host-mode switch removed, then the live leftover check for the
# mode, and only when it passes the kept-pool mark (keep) and the retire phase, which retires the recovery route last.
function Invoke-UninstallFlow([hashtable]$P, [hashtable]$X, [scriptblock]$Crash) {
  $boundary = { param($n) if ($Crash) { & $Crash $n } }
  $finish = {
    param($mode)
    if ([int](& $X.HostSwitches)) { & $boundary 'before:switch'; [void](& $X.RemoveHostSwitches); & $boundary 'after:switch' }
    $left = @(& $X.Leftovers $mode)
    if ($left.Count) {
      [void](& $X.Say "These are still there: $($left -join '; '). The Installed apps entry and the uninstaller stay: run it again once these are resolved (the manual steps are in the inventory).")
      return 1
    }
    if ($mode -eq 'keep' -and -not (& $X.KeptMark)) { [void](& $X.WriteKept); & $boundary 'after:kept' }
    & $boundary 'before:retire'
    [void](& $X.Retire)
    return 0
  }
  $kept = [bool](& $X.KeptMark)
  if ($P.Retire) {
    if ($P.WhatIf) { [void](& $X.Say 'Would finish the uninstall: setup''s host-mode switch if it is still there, the live check, then the uninstaller''s own files and the Installed apps entry. Nothing was changed (-WhatIf).'); return 0 }
    [void](& $X.Say 'Finishing the uninstall: the uninstaller''s own files and the Installed apps entry.')
    return (& $finish $(if ($kept) { 'keep' } else { 'remove' }))
  }
  # The leftover-only case (s9): nothing of the helper is installed (no service, state folder or registry records).
  if (-not (& $X.ServiceHere) -and -not (& $X.StateHere) -and -not (& $X.KeyHere)) {
    if (-not (& $X.InstallHere) -and -not (& $X.EntryHere) -and -not [int](& $X.HostSwitches)) { [void](& $X.Say 'Nothing of the hyper-v MCP is installed.'); return 0 }
    if ($P.WhatIf) { [void](& $X.Say 'Nothing of the helper is installed: would remove setup''s host-mode switch if it is still there, then what is left of the uninstaller and the Installed apps entry. Nothing was changed (-WhatIf).'); return 0 }
    [void](& $X.Say 'Nothing of the helper is installed: finishing with what is left (setup''s switch, the uninstaller and its Installed apps entry).')
    return (& $finish 'remove')
  }
  $whatIf = [bool]$P.WhatIf
  $choice = if ($P.RemovePool) { 'remove' } elseif ($P.KeepPool) { 'keep' } else { $null }
  if (-not $choice) {
    [void](& $X.ShowInventory); [void](& $X.ShowChoices)
    if ($whatIf) { $choice = 'remove' }
    else {
      $a = & $X.Ask
      if ($a -eq 'list') { $whatIf = $true; $choice = 'remove' } elseif ($a -eq 'remove' -or $a -eq 'keep') { $choice = $a } else { [void](& $X.Say 'Cancelled: nothing was changed.'); return 1 }
    }
  } elseif ($whatIf) { [void](& $X.ShowInventory) }
  if ($choice -eq 'remove' -and $kept -and -not (& $X.ServiceHere)) {
    throw 'An earlier uninstall kept the pool and removed the helper, which removes it: run setup again (from the repo) to restore the helper, then uninstall. Nothing was changed.'
  }
  [void](& $X.Teardown $choice $whatIf)
  if ($whatIf) { [void](& $X.Say 'Nothing was changed (-WhatIf).'); return 0 }
  & $boundary 'after:teardown'
  return (& $finish $choice)
}
