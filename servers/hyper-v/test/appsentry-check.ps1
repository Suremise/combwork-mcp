# MC-1557: exercises setup\appsentry.ps1 non-elevated, in a temp folder ($Dir): the Installed apps entry's real launcher,
# written to a test HKCU key by Set-AppsEntry, read back and run exactly as Windows runs an UninstallString (cmd /c), at
# every state an interrupted uninstall can leave; the retire phase with a crash hook; the protected temporary copy.
# The launcher's paths are a scratch Program Files root, a scratch state folder and HKCU keys, injected only through
# Get-LauncherText's test overrides; this user stands in for Administrators where a test says so. Nothing in the launcher
# refers to the repo, and this runs from a working folder outside it. Prints one JSON line of results for
# test\uninstall.test.js.
param([Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\setup\acl.ps1')
. (Join-Path $PSScriptRoot '..\setup\teardown.ps1')
. (Join-Path $PSScriptRoot '..\setup\appsentry.ps1')
Set-Location -LiteralPath $Dir
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$SYSTEM = 'S-1-5-18'; $ADMINS = 'S-1-5-32-544'
$HKCU = [Microsoft.Win32.Registry]::CurrentUser
$r = [ordered]@{}
$script:n = 0
$script:Engine = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$set = $script:RetiringSet

# A fresh case: its own Program Files root, state folder and keys; the launcher's overrides for them.
function New-Case([hashtable]$Extra = @{}) {
  $script:n++
  $b = Join-Path $Dir "c$($script:n)"
  New-Item -ItemType Directory -Force (Join-Path $b 'pf') | Out-Null
  $base = "Software\hvmcp-apps-test-$([guid]::NewGuid().ToString('n'))"
  $o = @{ pf = (Join-Path $b 'pf'); state = (Join-Path $b 'state'); regRoot = 'CurrentUser'; stateKey = "$base\state"; entryKey = "$base\entry"; service = "hvmcp-no-such-service-$($script:n)"; trusted = @($me, $SYSTEM, $ADMINS); elevate = $false; pause = $false }
  foreach ($k in $Extra.Keys) { $o[$k] = $Extra[$k] }
  # MC-1575: run by the engine this check runs in, as setup records its own (so each engine's run tests its own entry).
  $cmd = Get-LauncherCommand (Get-LauncherText $o) $script:Engine
  Set-AppsEntry $HKCU $o.entryKey $cmd.command '9.9.9' (Join-Path $o.pf 'hyperv-mcp')
  return [pscustomobject]@{ base = $b; o = $o; cmd = $cmd; inst = (Join-Path $o.pf 'hyperv-mcp'); rec = (Join-Path $b 'launched.txt'); keyBase = $base }
}
# Files the uninstaller leaves: $where is 'uninstall' or 'uninstall.retiring'; uninstall.ps1 is a fake that records how
# it was launched.
function Add-Files($c, [string]$where, [string[]]$names) {
  $d = Join-Path $c.inst $where
  New-Item -ItemType Directory -Force $d | Out-Null
  foreach ($f in $names) {
    $text = if ($f -eq 'uninstall.ps1') { "Set-Content -LiteralPath '$($c.rec)' -Value (`$args -join ' ')" } else { "# $f" }
    Set-Content -LiteralPath (Join-Path $d $f) -Value $text
  }
}
# Runs a command line as Windows starts an UninstallString: one CreateProcess with the whole line (not cmd.exe, whose
# 8191-character limit an encoded launcher exceeds; CreateProcess allows 32767).
function Invoke-Line([string]$u) {
  # The program is the first word, or (MC-1575: the entry names its engine's full path) a quoted first part.
  if ($u.StartsWith('"')) { $q = $u.IndexOf('"', 1); $exe = $u.Substring(1, $q - 1); $rest = $u.Substring($q + 1).TrimStart() }
  else { $exe, $rest = $u.Split(' ', 2) }
  $si = New-Object Diagnostics.ProcessStartInfo $exe, $rest
  $si.UseShellExecute = $false; $si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true; $si.WorkingDirectory = $Dir
  $p = [Diagnostics.Process]::Start($si)
  $err = $p.StandardError.ReadToEndAsync(); $out = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
  return [pscustomobject]@{ code = $p.ExitCode; out = (($out + $err.Result) -split "#< CLIXML")[0] }
}
function Invoke-Entry($c) {
  $k = $HKCU.OpenSubKey($c.o.entryKey); $u = [string]$k.GetValue('UninstallString'); $k.Dispose()
  return Invoke-Line $u
}
function Test-Entry($c) { $k = $HKCU.OpenSubKey($c.o.entryKey); if ($k) { $k.Dispose(); return $true }; return $false }
function Get-Launched($c) { if (Test-Path -LiteralPath $c.rec) { return (Get-Content -LiteralPath $c.rec -Raw).Trim() }; return $null }
function Remove-Case($c) { try { $HKCU.DeleteSubKeyTree($c.keyBase, $false) } catch { } }

# The production launcher: parses, takes no overrides, and its command decodes back to it.
$prod = Get-LauncherText
$errs = $null; [void][Management.Automation.Language.Parser]::ParseInput($prod, [ref]$null, [ref]$errs)
$pc = Get-LauncherCommand $prod
$r.prodParses = -not $errs
$r.prodNoOverrides = $prod.Contains("`$over = ''")
$r.prodRoundTrip = ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($pc.b64)) -eq $prod)
$r.prodCommand = $pc.command -ceq "`"$(Get-PsEngine)`" -NoProfile -ExecutionPolicy Bypass -EncodedCommand $($pc.b64)"
$r.prodLength = $pc.command.Length
$r.engine = $PSVersionTable.PSEdition

# MC-1575: the engine, from HKLM-style keys (fakes here, under HKCU): 5.1 first, else the last PowerShell 7; a file
# missing is skipped; setup's own engine only when it is one registered.
$eb = Join-Path $Dir 'engines'
foreach ($d in 'ps51', 'ps7a', 'ps7b') { New-Item -ItemType Directory -Force (Join-Path $eb $d) | Out-Null }
foreach ($f in 'ps51\powershell.exe', 'ps7a\pwsh.exe', 'ps7b\pwsh.exe') { Set-Content -LiteralPath (Join-Path $eb $f) -Value 'fake' }
$ek = "Software\hvmcp-engine-test-$([guid]::NewGuid().ToString('n'))"
$k = $HKCU.CreateSubKey("$ek\51"); $k.SetValue('ApplicationBase', (Join-Path $eb 'ps51')); $k.Dispose()
$k = $HKCU.CreateSubKey("$ek\gone51"); $k.SetValue('ApplicationBase', (Join-Path $eb 'nowhere')); $k.Dispose()
$k = $HKCU.CreateSubKey("$ek\7\a"); $k.SetValue('InstallLocation', (Join-Path $eb 'ps7a') + '\'); $k.Dispose()
$k = $HKCU.CreateSubKey("$ek\7\b"); $k.SetValue('InstallLocation', (Join-Path $eb 'ps7b')); $k.Dispose()
try {
  $all = Get-PsEngines $HKCU "$ek\51" "$ek\7"
  $no51 = Get-PsEngines $HKCU "$ek\none" "$ek\7"
  $gone = Get-PsEngines $HKCU "$ek\gone51" "$ek\7"
  $none = Get-PsEngines $HKCU "$ek\none" "$ek\none7"
  $r.engines = [ordered]@{
    all = @($all | ForEach-Object { $_.Substring($eb.Length + 1) })
    pick = (Get-PsEngine $all).Substring($eb.Length + 1)
    pickNo51 = (Get-PsEngine $no51).Substring($eb.Length + 1)
    pickGone51 = (Get-PsEngine $gone).Substring($eb.Length + 1)
    none = $(try { Get-PsEngine $none; 'picked' } catch { $_.Exception.Message })
    setupRegistered = (Get-SetupEngine (Join-Path $eb 'ps7a\pwsh.exe') $all).Substring($eb.Length + 1)
    setupElsewhere = (Get-SetupEngine 'C:\Users\Public\pwsh.exe' $all).Substring($eb.Length + 1)
    live = [bool](Get-PsEngines | Where-Object { $_ -ieq [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName })
  }
} finally { $HKCU.DeleteSubKeyTree($ek, $false) }

# The entry's values.
$c = New-Case
$k = $HKCU.OpenSubKey($c.o.entryKey)
$r.entry = [ordered]@{ name = $k.GetValue('DisplayName'); publisher = $k.GetValue('Publisher'); version = $k.GetValue('DisplayVersion'); noModify = $k.GetValue('NoModify'); noRepair = $k.GetValue('NoRepair'); location = $k.GetValue('InstallLocation') }
$k.Dispose(); Remove-Case $c

# a: the installed uninstaller is run, -Interactive.
$c = New-Case; Add-Files $c 'uninstall' $set; Set-Content (Join-Path $c.inst 'helper.js') 'js'
$x = Invoke-Entry $c
$r.a = [ordered]@{ launched = (Get-Launched $c); entry = (Test-Entry $c); helper = (Test-Path (Join-Path $c.inst 'helper.js')) }
Remove-Case $c

# b: all five retiring files: that uninstall.ps1 -Retire.
$c = New-Case; Add-Files $c 'uninstall.retiring' $set
$x = Invoke-Entry $c
$r.b = [ordered]@{ launched = (Get-Launched $c); entry = (Test-Entry $c); files = @(Get-ChildItem (Join-Path $c.inst 'uninstall.retiring')).Count }
Remove-Case $c

# c: every partial retiring set (each file missing in turn, then the first k gone, main script first and last), an empty
# uninstall.retiring\, an empty install folder: each finished by the launcher alone.
$partial = @()
$states = @()
foreach ($f in $set) { $states += , @($set | Where-Object { $_ -ne $f }) }
for ($k2 = 1; $k2 -lt $set.Count; $k2++) { $states += , @($set | Select-Object -Skip $k2); $states += , @($set | Select-Object -First ($set.Count - $k2)) }
$states += , @()
foreach ($st in $states) {
  $c = New-Case; Add-Files $c 'uninstall.retiring' $st
  if (-not $st.Count) { New-Item -ItemType Directory -Force (Join-Path $c.inst 'uninstall.retiring') | Out-Null }
  $x = Invoke-Entry $c
  $partial += [ordered]@{ left = ($st -join ','); launched = (Get-Launched $c); inst = (Test-Path -LiteralPath $c.inst); entry = (Test-Entry $c); code = $x.code }
  Remove-Case $c
}
$c = New-Case; New-Item -ItemType Directory -Force $c.inst | Out-Null
$x = Invoke-Entry $c
$partial += [ordered]@{ left = 'empty install folder'; launched = $null; inst = (Test-Path -LiteralPath $c.inst); entry = (Test-Entry $c); code = $x.code }
Remove-Case $c
$r.partial = $partial

# d (remove): nothing left at all; the InstallLocation names another folder, which is untouched.
$c = New-Case
$other = Join-Path $c.base 'other'; New-Item -ItemType Directory -Force $other | Out-Null; Set-Content (Join-Path $other 'keep.txt') 'x'
$k = $HKCU.OpenSubKey($c.o.entryKey, $true); $k.SetValue('InstallLocation', $other); $k.Dispose()
$x = Invoke-Entry $c
$r.d = [ordered]@{ entry = (Test-Entry $c); other = (Test-Path (Join-Path $other 'keep.txt')); code = $x.code; said = ($x.out -match 'Nothing of the hyper-v MCP is left') }
Remove-Case $c

# Refusals, each with the files and the entry intact.
function Get-Refusal($c, [string[]]$files) {
  $x = Invoke-Entry $c
  return [ordered]@{ code = $x.code; entry = (Test-Entry $c); intact = (@($files | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0); out = ($x.out -replace '\s+', ' ').Trim() }
}
$refuse = [ordered]@{}
$c = New-Case; Add-Files $c 'uninstall.retiring' @('acl.ps1', 'evil.txt')
$refuse.extraFile = Get-Refusal $c @((Join-Path $c.inst 'uninstall.retiring\evil.txt'), (Join-Path $c.inst 'uninstall.retiring\acl.ps1')); Remove-Case $c
$c = New-Case; Add-Files $c 'uninstall.retiring' @('acl.ps1'); New-Item -ItemType Directory -Force (Join-Path $c.inst 'stray') | Out-Null
$refuse.extraFolder = Get-Refusal $c @((Join-Path $c.inst 'stray'), (Join-Path $c.inst 'uninstall.retiring\acl.ps1')); Remove-Case $c
$c = New-Case; $target = Join-Path $c.base 'target'; New-Item -ItemType Directory -Force $target, $c.inst | Out-Null; Set-Content (Join-Path $target 'acl.ps1') 'x'
& cmd.exe /c mklink /J (Join-Path $c.inst 'uninstall.retiring') $target | Out-Null
$refuse.junction = Get-Refusal $c @((Join-Path $target 'acl.ps1')); Remove-Case $c
$c = New-Case @{ trusted = @($SYSTEM, $ADMINS) }; Add-Files $c 'uninstall.retiring' @('acl.ps1')
$refuse.untrustedOwner = Get-Refusal $c @((Join-Path $c.inst 'uninstall.retiring\acl.ps1')); Remove-Case $c
$c = New-Case @{ service = 'EventLog' }; Add-Files $c 'uninstall.retiring' @('acl.ps1')
$refuse.service = Get-Refusal $c @((Join-Path $c.inst 'uninstall.retiring\acl.ps1')); Remove-Case $c
$c = New-Case; $k = $HKCU.OpenSubKey($c.o.entryKey, $true); $k.SetValue('UninstallString', 'powershell.exe -File C:\elsewhere\x.ps1'); $k.Dispose()
$x = Invoke-Line $c.cmd.command
$refuse.otherEntry = [ordered]@{ code = $x.code; entry = (Test-Entry $c); out = ($x.out -replace '\s+', ' ').Trim() }; Remove-Case $c
$c = New-Case; New-Item -ItemType Directory -Force $c.o.state | Out-Null
$refuse.stateFolder = Get-Refusal $c @($c.o.state); Remove-Case $c
$c = New-Case; $k = $HKCU.CreateSubKey($c.o.stateKey); $k.SetValue('InstallId', 'abc'); $k.SetValue('Teardown', '{"phase":"stopped"}'); $k.Dispose()
$refuse.record = Get-Refusal $c @(); Remove-Case $c
# Round 1: nothing is run unless its folder, parents and files are trusted. A complete set behind a junction (for
# uninstall.retiring\, and for uninstall\), a folder or a file others may write: each refused, no script run, nothing
# removed.
function Get-NoRun($c, [string[]]$files) {
  $x = Invoke-Entry $c
  return [ordered]@{ code = $x.code; launched = (Get-Launched $c); entry = (Test-Entry $c); intact = (@($files | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0); out = ($x.out -replace '\s+', ' ').Trim() }
}
function Grant-Write([string]$p) {
  $acl = Get-Acl -LiteralPath $p
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'), 'Modify', 'Allow')))
  Set-Acl -LiteralPath $p -AclObject $acl
}
foreach ($where in @('uninstall.retiring', 'uninstall')) {
  $c = New-Case; $target = Join-Path $c.base 'outside'; New-Item -ItemType Directory -Force $target, $c.inst | Out-Null
  foreach ($f in $set) { Set-Content -LiteralPath (Join-Path $target $f) -Value $(if ($f -eq 'uninstall.ps1') { "Set-Content -LiteralPath '$($c.rec)' -Value (`$args -join ' ')" } else { "# $f" }) }
  & cmd.exe /c mklink /J (Join-Path $c.inst $where) $target | Out-Null
  $refuse["junctionComplete_$where"] = Get-NoRun $c @($set | ForEach-Object { Join-Path $target $_ }); Remove-Case $c
}
$c = New-Case; Add-Files $c 'uninstall.retiring' $set; Grant-Write (Join-Path $c.inst 'uninstall.retiring')
$refuse.writableFolder = Get-NoRun $c @($set | ForEach-Object { Join-Path $c.inst "uninstall.retiring\$_" }); Remove-Case $c
$c = New-Case; Add-Files $c 'uninstall' $set; Grant-Write (Join-Path $c.inst 'uninstall\uninstall.ps1')
$refuse.writableFile = Get-NoRun $c @($set | ForEach-Object { Join-Path $c.inst "uninstall\$_" }); Remove-Case $c
$c = New-Case; Add-Files $c 'uninstall' ($set + @('extra.ps1'))
$refuse.extraInSet = Get-NoRun $c @((Join-Path $c.inst 'uninstall\extra.ps1')); Remove-Case $c
$c = New-Case; Add-Files $c 'uninstall.retiring' @('acl.ps1'); Grant-Write (Join-Path $c.inst 'uninstall.retiring\acl.ps1')
$refuse.writablePartial = Get-NoRun $c @((Join-Path $c.inst 'uninstall.retiring\acl.ps1')); Remove-Case $c
$r.refuse = $refuse

# The uninstaller's top level (Invoke-UninstallFlow), with a fake world: what it decides and in what order, on every
# switch, an interruption after the teardown and after the switch, and -WhatIf (with -Retire too) changing nothing.
function New-World([hashtable]$w = @{}) {
  $s = @{ service = $true; state = $true; key = $true; kept = $false; install = $true; entry = $true; switch = $true; leftover = $null; ask = 'remove'; calls = New-Object Collections.ArrayList }
  foreach ($k in $w.Keys) { $s[$k] = $w[$k] }
  return $s
}
function New-X($s, [switch]$ReadOnly) {
  $mut = { param($n) if ($ReadOnly) { throw "WHATIF MUTATED $n" } }.GetNewClosure()
  return @{
    Say = { param($m) [void]$s.calls.Add("say:$m") }.GetNewClosure()
    ServiceHere = { $s.service }.GetNewClosure(); StateHere = { $s.state }.GetNewClosure(); KeyHere = { $s.key }.GetNewClosure()
    KeptMark = { $s.kept }.GetNewClosure(); InstallHere = { $s.install }.GetNewClosure(); EntryHere = { $s.entry }.GetNewClosure()
    ShowInventory = { [void]$s.calls.Add('inventory') }.GetNewClosure(); ShowChoices = { [void]$s.calls.Add('choices') }.GetNewClosure()
    Ask = { [void]$s.calls.Add('ask'); $s.ask }.GetNewClosure()
    Teardown = { param($m, $w) [void]$s.calls.Add("teardown:$m$(if ($w) { ':whatif' })"); if (-not $w) { & $mut 'teardown'; $s.service = $false; if ($m -eq 'remove') { $s.state = $false; $s.key = $false } } }.GetNewClosure()
    HostSwitches = { if ($s.switch) { 1 } else { 0 } }.GetNewClosure()
    RemoveHostSwitches = { & $mut 'switch'; [void]$s.calls.Add('switch'); $s.switch = $false }.GetNewClosure()
    Leftovers = { param($m) [void]$s.calls.Add("check:$m"); $l = @(); if ($s.switch) { $l += 'switch' }; if ($s.service) { $l += 'service' }; if ($m -eq 'remove' -and ($s.state -or $s.key)) { $l += 'state' }; if ($s.leftover) { $l += $s.leftover }; $l }.GetNewClosure()
    WriteKept = { & $mut 'kept'; [void]$s.calls.Add('kept'); $s.kept = $true }.GetNewClosure()
    Retire = { & $mut 'retire'; [void]$s.calls.Add('retire'); $s.install = $false; $s.entry = $false }.GetNewClosure()
  }
}
function Get-Flow($s, [hashtable]$p, [string]$crashAt, [switch]$ReadOnly) {
  $crash = { param($n) if ($n -eq $crashAt) { throw "CRASH $n" } }.GetNewClosure()
  $res = try { Invoke-UninstallFlow $p (New-X $s -ReadOnly:$ReadOnly) $crash } catch { $_.Exception.Message }
  return [ordered]@{ result = $res; calls = (@($s.calls | Where-Object { $_ -notlike 'say:*' }) -join ','); switch = $s.switch; install = $s.install; entry = $s.entry; kept = $s.kept }
}
$flow = [ordered]@{}
$flow.remove = Get-Flow (New-World) @{ RemovePool = $true }
$flow.keep = Get-Flow (New-World) @{ KeepPool = $true }
$flow.menuRemove = Get-Flow (New-World) @{}
$flow.menuCancel = Get-Flow (New-World @{ ask = $null }) @{}
$flow.menuList = Get-Flow (New-World @{ ask = 'list' }) @{} -ReadOnly
foreach ($at in @('after:teardown', 'before:switch', 'after:switch', 'before:retire')) {
  $s = New-World
  $first = Get-Flow $s @{ RemovePool = $true } $at
  [void]$s.calls.Clear()
  # The rerun, as the Installed apps entry starts it (the menu; a run that finds only leftovers needs no answer).
  $flow["resume_$at"] = [ordered]@{ first = $first.result; second = (Get-Flow $s @{}) }
}
$flow.leftover = Get-Flow (New-World @{ leftover = 'a VM' }) @{ RemovePool = $true }
$flow.whatIf = Get-Flow (New-World) @{ WhatIf = $true } -ReadOnly
$flow.whatIfRemove = Get-Flow (New-World) @{ RemovePool = $true; WhatIf = $true } -ReadOnly
$flow.retireWhatIf = Get-Flow (New-World @{ service = $false; state = $false; key = $false }) @{ Retire = $true; WhatIf = $true } -ReadOnly
$flow.leftoverOnlyWhatIf = Get-Flow (New-World @{ service = $false; state = $false; key = $false }) @{ WhatIf = $true } -ReadOnly
$flow.retireKeep = Get-Flow (New-World @{ service = $false; kept = $true; switch = $false }) @{ Retire = $true }
$flow.keptThenRemove = Get-Flow (New-World @{ service = $false; kept = $true }) @{ RemovePool = $true } -ReadOnly
$flow.nothing = Get-Flow (New-World @{ service = $false; state = $false; key = $false; install = $false; entry = $false; switch = $false }) @{} -ReadOnly
$r.flow = $flow

# d (keep): a verified KeptPool record bound to this InstallId; the state folder and key stay.
function New-Kept([hashtable]$Extra = @{}, [string]$marker = 'same', [switch]$Record) {
  $c = New-Case $Extra
  New-Item -ItemType Directory -Force $c.o.state | Out-Null; Set-Content (Join-Path $c.o.state 'journal.jsonl') '{}'
  $k = $HKCU.CreateSubKey($c.o.stateKey); $k.SetValue('InstallId', 'iid-1')
  if ($marker -eq 'same') { $k.SetValue('KeptPool', '{"installId":"iid-1","at":"x"}') } elseif ($marker -eq 'other') { $k.SetValue('KeptPool', '{"installId":"iid-2","at":"x"}') }
  if ($Record) { $k.SetValue('Teardown', '{"phase":"stopped"}') }
  $k.Dispose()
  return $c
}
$kept = [ordered]@{}
$c = New-Kept; $x = Invoke-Entry $c
$kept.ok = [ordered]@{ code = $x.code; entry = (Test-Entry $c); state = (Test-Path (Join-Path $c.o.state 'journal.jsonl')); key = [bool]$HKCU.OpenSubKey($c.o.stateKey); said = ($x.out -match 'pool, state .* were kept') }; Remove-Case $c
foreach ($v in @(@{ n = 'noMarker'; m = 'none' }, @{ n = 'otherInstall'; m = 'other' })) {
  $c = New-Kept -marker $v.m; $x = Invoke-Entry $c
  $kept[$v.n] = [ordered]@{ code = $x.code; entry = (Test-Entry $c); state = (Test-Path (Join-Path $c.o.state 'journal.jsonl')) }; Remove-Case $c
}
$c = New-Kept -Record; $x = Invoke-Entry $c; $kept.record = [ordered]@{ code = $x.code; entry = (Test-Entry $c) }; Remove-Case $c
$c = New-Kept @{ service = 'EventLog' }; $x = Invoke-Entry $c; $kept.service = [ordered]@{ code = $x.code; entry = (Test-Entry $c) }; Remove-Case $c
$r.kept = $kept

# The retire phase from the source, with a crash after R2 and after R3a: each time the entry relaunches what remains
# (the retiring uninstall.ps1 -Retire, all five files being there), and the phase run again finishes.
$retire = [ordered]@{}
foreach ($at in @('after:R2', 'after:R3a', 'none')) {
  $c = New-Case; Add-Files $c 'uninstall' $set; Set-Content (Join-Path $c.inst 'helper.js') 'js'; New-Item -ItemType Directory -Force (Join-Path $c.inst 'guests') | Out-Null; Set-Content (Join-Path $c.inst 'guests\linux.js') 'js'
  $sb = [scriptblock]::Create((Get-LauncherText $c.o))
  $crash = { param($n) if ($n -eq $at) { throw "CRASH $n" } }.GetNewClosure()
  $first = try { Invoke-Retire -ProgramFiles $c.o.pf -Trusted @($me, $SYSTEM, $ADMINS, $script:TrustedInstaller) -RootOwners @($me, $SYSTEM, $ADMINS) -Launcher $sb -Expected $c.cmd.b64 -Crash $crash; 'finished' } catch { $_.Exception.Message }
  $mid = [ordered]@{ first = $first; uninstall = (Test-Path (Join-Path $c.inst 'uninstall')); retiring = @(if (Test-Path (Join-Path $c.inst 'uninstall.retiring')) { Get-ChildItem (Join-Path $c.inst 'uninstall.retiring') }).Count; helper = (Test-Path (Join-Path $c.inst 'helper.js')); entry = (Test-Entry $c) }
  if ($at -ne 'none') {
    $x = Invoke-Entry $c
    $mid.launched = Get-Launched $c
    $second = try { Invoke-Retire -ProgramFiles $c.o.pf -Trusted @($me, $SYSTEM, $ADMINS, $script:TrustedInstaller) -RootOwners @($me, $SYSTEM, $ADMINS) -Launcher $sb -Expected $c.cmd.b64; 'finished' } catch { $_.Exception.Message }
    $mid.second = $second
  }
  $mid.instAfter = (Test-Path -LiteralPath $c.inst); $mid.entryAfter = (Test-Entry $c)
  $retire[$at] = $mid
  Remove-Case $c
}
# A junction in place of uninstall\ is refused before anything is renamed.
$c = New-Case; $target = Join-Path $c.base 'target'; New-Item -ItemType Directory -Force $target, $c.inst | Out-Null; Set-Content (Join-Path $target 'uninstall.ps1') 'x'
& cmd.exe /c mklink /J (Join-Path $c.inst 'uninstall') $target | Out-Null
$sb = [scriptblock]::Create((Get-LauncherText $c.o))
$retire.junction = [ordered]@{ result = $(try { Invoke-Retire -ProgramFiles $c.o.pf -Trusted @($me, $SYSTEM, $ADMINS, $script:TrustedInstaller) -RootOwners @($me, $SYSTEM, $ADMINS) -Launcher $sb -Expected $c.cmd.b64; 'finished' } catch { $_.Exception.Message }); target = (Test-Path (Join-Path $target 'uninstall.ps1')); entry = (Test-Entry $c) }
Remove-Case $c
$r.retire = $retire

# The protected temporary copy: only the named owner and grants, the files copied.
$src = Join-Path $Dir 'copy-src'; New-Item -ItemType Directory -Force $src | Out-Null
$files = @($set | ForEach-Object { $p = Join-Path $src $_; Set-Content $p "# $_"; $p })
$tmp = New-ProtectedCopy $Dir $files -Owners @($me) -Grants @($me, $SYSTEM)
$r.copy = [ordered]@{ files = @(Get-ChildItem $tmp | ForEach-Object { $_.Name } | Sort-Object); problems = @(Test-ExclusiveAcl $tmp -Allowed @($me, $SYSTEM) -Writers @($me, $SYSTEM) -Owners @($me)); protected = (Get-Acl $tmp).AreAccessRulesProtected }

# MC-1567: an interrupted run's copy is removed by a later run, only when it is exactly such a copy; nothing else is.
$sp = Join-Path $Dir 'stale-parent'; New-Item -ItemType Directory -Force $sp | Out-Null
$mk = { New-ProtectedCopy $sp $files -Owners @($me) -Grants @($me, $SYSTEM) }
$hex = { [guid]::NewGuid().ToString('n') }
$cases = [ordered]@{}
$cases.stale = & $mk
$cases.stale2 = & $mk
$cases.current = & $mk
$cases.inuse = & $mk
$cases.extra = & $mk; Set-Content (Join-Path $cases.extra 'notes.txt') 'x'
$cases.subfolder = & $mk; New-Item -ItemType Directory (Join-Path $cases.subfolder 'sub') | Out-Null
$cases.loose = Join-Path $sp "hvmcp-uninstall-$(& $hex)"; New-Item -ItemType Directory $cases.loose | Out-Null; Set-Content (Join-Path $cases.loose 'uninstall.ps1') 'x'
$cases.othername = Join-Path $sp 'hvmcp-uninstall-notacopy'; New-Item -ItemType Directory $cases.othername | Out-Null; Set-Content (Join-Path $cases.othername 'uninstall.ps1') 'x'
$cases.afile = Join-Path $sp "hvmcp-uninstall-$(& $hex)"; Set-Content $cases.afile 'x'
$cases.unrelated = Join-Path $sp 'other.txt'; Set-Content $cases.unrelated 'x'
$target = & $mk; $cases.linktarget = Join-Path $sp 'link-target'; [IO.Directory]::Move($target, $cases.linktarget)
$cases.link = Join-Path $sp "hvmcp-uninstall-$(& $hex)"; cmd /c mklink /J "$($cases.link)" "$($cases.linktarget)" | Out-Null
# A run still using a copy: a process naming it on its command line (stopped below by its own handle).
$busy = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile', '-Command', "Start-Sleep -Seconds 120 # $($cases.inuse)\uninstall.ps1") -WindowStyle Hidden -PassThru
try {
  $t = (Get-Date).AddSeconds(30)
  while (-not @(Get-CimInstance Win32_Process -Filter "ProcessId=$($busy.Id)" | Where-Object { $_.CommandLine -like "*$($cases.inuse)*" }).Count -and (Get-Date) -lt $t) { Start-Sleep -Milliseconds 200 }
  # The process list unreadable (an injected query error) or incomplete (this process missing): every copy left.
  $failLines = @(Remove-StaleProtectedCopies $sp -Owners @($me) -Grants @($me, $SYSTEM) -Skip $cases.current -ProcessQuery { throw 'Access denied (injected)' })
  $partLines = @(Remove-StaleProtectedCopies $sp -Owners @($me) -Grants @($me, $SYSTEM) -Skip $cases.current -ProcessQuery { @([pscustomobject]@{ ProcessId = 4; CommandLine = 'System' }) })
  $afterFail = [ordered]@{ stale = (Test-Path -LiteralPath $cases.stale); stale2 = (Test-Path -LiteralPath $cases.stale2) }
  # An owner other than the allowed one: left.
  $ownerLines = @(Remove-StaleProtectedCopies $sp -Owners @($SYSTEM) -Grants @($me, $SYSTEM) -Skip $cases.current)
  $lines = @(Remove-StaleProtectedCopies $sp -Owners @($me) -Grants @($me, $SYSTEM) -Skip $cases.current)
} finally { if (-not $busy.HasExited) { $busy.Kill() }; $busy.WaitForExit() }
$name = @{}; foreach ($k in $cases.Keys) { $name[$cases[$k]] = $k }
$label = { param($l) $m = [regex]::Match($l, '^(removed|left) (\S+)( \((.*)\))?$'); "$($m.Groups[1].Value) $($name[$m.Groups[2].Value]) $($m.Groups[4].Value)".Trim() }
$exists = [ordered]@{}; foreach ($k in $cases.Keys) { $exists[$k] = Test-Path -LiteralPath $cases[$k] }
$r.stale = [ordered]@{
  fail = @($failLines | ForEach-Object { & $label $_ } | Sort-Object)
  part = @($partLines | ForEach-Object { & $label $_ } | Sort-Object)
  afterFail = $afterFail
  owner = @($ownerLines | ForEach-Object { & $label $_ } | Sort-Object)
  lines = @($lines | ForEach-Object { & $label $_ } | Sort-Object)
  exists = $exists
  linkTargetFiles = @(Get-ChildItem $cases.linktarget | ForEach-Object { $_.Name } | Sort-Object)
}
cmd /c rmdir "$($cases.link)" | Out-Null

$r | ConvertTo-Json -Compress -Depth 6
