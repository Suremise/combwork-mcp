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
$set = $script:RetiringSet

# A fresh case: its own Program Files root, state folder and keys; the launcher's overrides for them.
function New-Case([hashtable]$Extra = @{}) {
  $script:n++
  $b = Join-Path $Dir "c$($script:n)"
  New-Item -ItemType Directory -Force (Join-Path $b 'pf') | Out-Null
  $base = "Software\hvmcp-apps-test-$([guid]::NewGuid().ToString('n'))"
  $o = @{ pf = (Join-Path $b 'pf'); state = (Join-Path $b 'state'); hive = 'CurrentUser'; stateKey = "$base\state"; entryKey = "$base\entry"; service = "hvmcp-no-such-service-$($script:n)"; trusted = @($me, $SYSTEM, $ADMINS); elevate = $false; pause = $false }
  foreach ($k in $Extra.Keys) { $o[$k] = $Extra[$k] }
  $cmd = Get-LauncherCommand (Get-LauncherText $o)
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
  $exe, $rest = $u.Split(' ', 2)
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
$r.prodCommand = $pc.command.StartsWith('powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ')
$r.prodLength = $pc.command.Length

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
$r.refuse = $refuse

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

$r | ConvertTo-Json -Compress -Depth 6
