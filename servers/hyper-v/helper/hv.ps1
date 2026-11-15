# The helper's only way to act on Hyper-V: one fixed script, run by hv.js as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File hv.ps1
# with { op, args } as one JSON object on stdin. Every value is used as data: nothing is ever built into script text or
# a host command line. The answer is one line, "HVJSON:" + { result } or { error }.
#
# Before acting on a VM, Get-OwnVm re-checks that the id the helper passes still names a VM with the expected name,
# inside the expected (pool-only) folder: the helper's journal is the first check, this is the second.
# Guest commands run over PowerShell Direct (Invoke-Command -VMId), with credentials passed in on stdin.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Answer($obj) { [Console]::Out.WriteLine('HVJSON:' + (ConvertTo-Json -InputObject $obj -Depth 8 -Compress)) }

function Norm([string]$p) { return ([IO.Path]::GetFullPath($p)).TrimEnd('\').ToLowerInvariant() }

function Get-OwnVm($a) {
  $vm = Get-VM -Id ([guid]$a.vmId) -ErrorAction SilentlyContinue
  if (-not $vm) { throw "VM $($a.vmId) does not exist" }
  if ($vm.Name -cne [string]$a.name) { throw "VM $($a.vmId) is named '$($vm.Name)', not '$($a.name)': not the pool's" }
  $folder = Norm $a.folder
  $loc = Norm $vm.ConfigurationLocation
  if ($loc -ne $folder -and -not $loc.StartsWith($folder + '\')) { throw "VM $($a.name) is not in its pool folder: not the pool's" }
  return $vm
}

function Cred($c) {
  $sec = ConvertTo-SecureString -String ([string]$c.password) -AsPlainText -Force
  return New-Object Management.Automation.PSCredential ([string]$c.user, $sec)
}

function Facts($vm) {
  $vm = Get-VM -Id $vm.Id
  $nic = @(Get-VMNetworkAdapter -VM $vm)
  $sw = ($nic | Where-Object { $_.SwitchName } | Select-Object -First 1).SwitchName
  return @{
    vmId = $vm.Id.ToString(); state = $vm.State.ToString()
    parentCheckpointId = if ($vm.ParentCheckpointId) { $vm.ParentCheckpointId.ToString() } else { $null }
    checkpointIds = @(Get-VMSnapshot -VM $vm | ForEach-Object { $_.Id.ToString() })
    switchName = if ($sw) { $sw } else { $null }
    reserve = [int](Get-VMProcessor -VM $vm).Reserve
  }
}

# Writes an IMAPI2 image stream to a file (IStream isn't readable from PowerShell directly).
function Write-ImageStream($stream, [string]$path) {
  if (-not ('HvMcpIsoWriter' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes;
public static class HvMcpIsoWriter {
  public static void Write(object o, string path) {
    IStream s = (IStream)o; byte[] buf = new byte[65536]; IntPtr p = Marshal.AllocHGlobal(4);
    try { using (FileStream f = new FileStream(path, FileMode.CreateNew)) {
      while (true) { s.Read(buf, buf.Length, p); int n = Marshal.ReadInt32(p); if (n <= 0) break; f.Write(buf, 0, n); } } }
    finally { Marshal.FreeHGlobal(p); }
  }
}
'@
  }
  [HvMcpIsoWriter]::Write($stream, $path)
}

# vm_run (MC-1510): a run is started in one short PowerShell Direct call and then polled with short calls, never held
# in one call: since the September 2025 updates PowerShell Direct ends any single call after 10 minutes ("The Hyper-V
# socket target process has ended"; PowerShell issue #26176). A process started from a call outlives it (checked on the
# pool's guests, as the admin and the standard user). The command reaches the guest as data, written to a script file.
# The wrapper redirects stdout and stderr to C:\out\.run-<n>.*, then writes the exit code aside and moves it into
# place, so it is read whole or not at all.
$RunFiles = {
  param($j, $dir)
  $n = [int]$j.n
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $base = "$(if ($j.out) { [string]$j.out } else { 'C:\out' })\.run-$n" # $j.out: the tests' own folder; the helper never sets it
  $ext = if ($j.shell -eq 'powershell') { 'ps1' } else { 'cmd' }
  $script = "$dir\run-$n.$ext"
  [IO.File]::WriteAllText($script, [string]$j.command, (New-Object Text.UTF8Encoding $false))
  $inner = if ($ext -eq 'ps1') { "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`"" } else { "cmd.exe /d /c `"$script`"" }
  foreach ($f in "$base.exit", "$base.exit.tmp") { Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue }
  # The exit code is written with the redirection first: "echo 0> file" would redirect handle 0 (cmd treats a digit
  # before > as a handle number) and leave the file empty.
  [IO.File]::WriteAllText("$dir\wrap-$n.cmd", "@echo off`r`ncd /d `"$($j.cwd)`" 2>nul`r`n$inner > `"$base.stdout.txt`" 2> `"$base.stderr.txt`"`r`n> `"$base.exit.tmp`" echo %ERRORLEVEL%`r`nmove /y `"$base.exit.tmp`" `"$base.exit`" >nul`r`n", (New-Object Text.ASCIIEncoding))
  "$dir\wrap-$n.cmd"
}

# A session-0 run's start, as the run's own account (its admin, or its standard user in its own PowerShell Direct
# session): the files, then the wrapper with Start-Process. Returns its PID and its creation time, read from the started
# process's own handle; a process that has already exited has no creation time to read: the exit file then decides.
$GuestRunStart = {
  param($j, $files)
  $ErrorActionPreference = 'Stop'
  $wrapper = & ([scriptblock]::Create($files)) $j ([string]$j.dir)
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /c `"$wrapper`"" -PassThru -WindowStyle Hidden
  # The PID and the creation time are read while the object still holds the process (Windows PowerShell's Id is null
  # once it is disposed), then it is disposed.
  $id = $p.Id
  $started = $null
  try {
    try { [void]$p.Handle; $started = $p.StartTime.ToUniversalTime().ToString('o') } catch { }
  } finally { try { $p.Dispose() } catch { } }
  @{ pid = $id; started = $started }
}

# A run's poll, as the guest's admin: the capped output so far, and the exit file, read whole: done with its exit code,
# or still running (and, for an interactive run, whether its request still waits for the session's watcher).
$GuestRunPoll = {
  param($j)
  $n = [int]$j.n
  $base = "$(if ($j.out) { [string]$j.out } else { 'C:\out' })\.run-$n"
  $code = $null
  try { $t = [IO.File]::ReadAllText("$base.exit").Trim(); if ($t -match '^-?\d{1,10}$') { $code = [int]$t } } catch { }
  $read = {
    param($f)
    if (-not (Test-Path -LiteralPath $f)) { return @('', $false) }
    $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite')
    try { $len = [Math]::Min($fs.Length, [long]$j.cap); $b = New-Object byte[] $len; [void]$fs.Read($b, 0, $len); return @([Text.Encoding]::UTF8.GetString($b), ($fs.Length -gt $len)) } finally { $fs.Close() }
  }
  # The output so far either way: a run that times out or is restored still shows what it wrote.
  $o = & $read "$base.stdout.txt"; $e = & $read "$base.stderr.txt"
  $out = @{ stdout = $o[0]; stdoutCut = $o[1]; stderr = $e[0]; stderrCut = $e[1] }
  if ($null -eq $code) { return $out + @{ done = $false; pending = (Test-Path -LiteralPath "C:\hvmcp\req\$n.go") } }
  $out + @{ done = $true; exitCode = $code }
}

# A session-0 run's kill at its timeout, as the guest's admin. The process is opened and its native handle taken first,
# and kept until the end: while it is open, the PID can't be reused. Only a process whose creation time is the one its
# start recorded is killed (its tree, by taskkill), and the kill is confirmed on that handle. A process already gone,
# or with another creation time (exited and its PID reused), or with no recorded identity, is never killed: the exit
# file decides.
$GuestRunKill = {
  param($j)
  $p = $null
  try { $p = [Diagnostics.Process]::GetProcessById([int]$j.pid) } catch { return @{ killed = $false; gone = $true } }
  try {
    try { [void]$p.Handle } catch { return @{ killed = $false; gone = $true } }
    if (-not $j.started) { return @{ killed = $false; why = 'its identity was never recorded' } }
    $now = $null
    try { $now = $p.StartTime.ToUniversalTime().ToString('o') } catch { return @{ killed = $false; gone = $true } }
    if ($now -ne [string]$j.started) { return @{ killed = $false; why = "PID $($j.pid) is no longer the run's process (it exited and the PID was reused)" } }
    & cmd.exe /d /c "taskkill /T /F /PID $([int]$j.pid) >nul 2>&1"
    @{ killed = $p.WaitForExit(10000) }
  } finally { $p.Dispose() }
}

# An interactive run's publish (MC-1503, MC-1504), as the guest's admin: the files in C:\hvmcp, then the request
# req\<n>.go, renamed from a finished .tmp, for the logged-on session's watcher (guest-agent.ps1), which claims it and
# starts the wrapper in its session. The helper then polls for the exit file; no exit file by the deadline means the
# VM is restored (Darren's "exit file or restore").
$GuestRunPublish = {
  param($j, $files)
  $ErrorActionPreference = 'Stop'
  if (-not (Test-Path -LiteralPath 'C:\hvmcp\agent.ps1')) { throw 'no interactive logon in this guest (no watcher)' }
  [void](& ([scriptblock]::Create($files)) $j 'C:\hvmcp')
  $n = [int]$j.n
  [IO.File]::WriteAllText("C:\hvmcp\req\$n.tmp", 'run')
  [IO.File]::Move("C:\hvmcp\req\$n.tmp", "C:\hvmcp\req\$n.go")
  @{ published = $true }
}

# Lists C:\out (files only; links and other reparse points skipped, never followed).
$GuestList = {
  $root = 'C:\out'; $files = @(); $skipped = @()
  $stack = New-Object Collections.Stack; $stack.Push(@($root, 0))
  while ($stack.Count -and $files.Count -lt 1000) {
    $d = $stack.Pop()
    foreach ($i in Get-ChildItem -LiteralPath $d[0] -Force -ErrorAction SilentlyContinue) {
      $rel = $i.FullName.Substring($root.Length + 1).Replace('\', '/')
      if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { $skipped += $rel; continue }
      if ($i.PSIsContainer) { if ($d[1] -lt 16) { $stack.Push(@($i.FullName, $d[1] + 1)) } }
      else { $files += @{ path = $rel; size = $i.Length } }
    }
  }
  @{ files = $files; skipped = $skipped }
}

# Reads files from C:\out, capped while reading; each must resolve inside C:\out and not be a reparse point.
$GuestRead = {
  param($j)
  $root = 'C:\out'; $total = 0; $out = @()
  foreach ($p in $j.paths) {
    $full = [IO.Path]::GetFullPath((Join-Path $root ([string]$p).Replace('/', '\')))
    if (-not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
    $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    if (-not $item -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    $left = [long]$j.maxTotalBytes - $total; if ($left -le 0) { break }
    $fs = [IO.File]::Open($full, 'Open', 'Read', 'ReadWrite')
    try {
      $len = [Math]::Min([Math]::Min($fs.Length, [long]$j.maxBytes), $left)
      $b = New-Object byte[] $len; $got = 0
      while ($got -lt $len) { $r = $fs.Read($b, $got, $len - $got); if ($r -le 0) { break }; $got += $r }
      $total += $got
      $out += @{ path = [string]$p; size = $fs.Length; cut = ($fs.Length -gt $got); data = [Convert]::ToBase64String($b, 0, $got) }
    } finally { $fs.Close() }
  }
  @{ files = $out }
}

$GuestSetup = {
  param($userName)
  $ErrorActionPreference = 'Stop'
  foreach ($d in 'C:\out', 'C:\build', 'C:\hvmcp') { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  # C:\build: read-only for the standard user (the guest admin can still write it: it is the guest's own copy).
  & icacls.exe C:\build /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  & icacls.exe C:\out /grant "${userName}:(OI)(CI)M" | Out-Null
  Remove-Item 'C:\Windows\Panther\unattend*.xml', 'C:\Windows\Panther\Unattend\*.xml' -Force -ErrorAction SilentlyContinue
  $cv = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
  @{ editionId = $cv.EditionID; build = $cv.CurrentBuild; ubr = $cv.UBR }
}

# The guest's LSA secret helper (MC-1503): Store sets the autologon password; Remove (MC-1516) deletes it again. Passed
# as text into the guest blocks that need it.
$HvLsaCs = @'
using System; using System.Runtime.InteropServices;
public static class HvLsa {
  [StructLayout(LayoutKind.Sequential)] struct LSA_STRING { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory, ObjectName; public int Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref LSA_OBJECT_ATTRIBUTES attrs, uint access, out IntPtr policy);
  [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr policy, ref LSA_STRING key, ref LSA_STRING data);
  [DllImport("advapi32.dll", EntryPoint = "LsaStorePrivateData")] static extern uint LsaDeletePrivateData(IntPtr policy, ref LSA_STRING key, IntPtr data);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
  [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
  static LSA_STRING Str(string s) { LSA_STRING r = new LSA_STRING(); r.Buffer = Marshal.StringToHGlobalUni(s); r.Length = (ushort)(s.Length * 2); r.MaximumLength = (ushort)(s.Length * 2 + 2); return r; }
  public static void Store(string key, string value) {
    LSA_OBJECT_ATTRIBUTES a = new LSA_OBJECT_ATTRIBUTES(); a.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));
    IntPtr h; uint st = LsaOpenPolicy(IntPtr.Zero, ref a, 0x20 /* POLICY_CREATE_SECRET */, out h);
    if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st), "LsaOpenPolicy");
    LSA_STRING k = Str(key), d = Str(value);
    try { st = LsaStorePrivateData(h, ref k, ref d); if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st), "LsaStorePrivateData"); }
    finally { Marshal.FreeHGlobal(k.Buffer); Marshal.ZeroFreeGlobalAllocUnicode(d.Buffer); LsaClose(h); }
  }
  // Deletes the secret (LsaStorePrivateData with no data); true once it is gone, also when it never existed.
  public static bool Remove(string key) {
    LSA_OBJECT_ATTRIBUTES a = new LSA_OBJECT_ATTRIBUTES(); a.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));
    IntPtr h; uint st = LsaOpenPolicy(IntPtr.Zero, ref a, 0x20 /* POLICY_CREATE_SECRET */, out h);
    if (st != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(st), "LsaOpenPolicy");
    LSA_STRING k = Str(key);
    try { st = LsaDeletePrivateData(h, ref k, IntPtr.Zero); return st == 0 || st == 0xC0000034 /* STATUS_OBJECT_NAME_NOT_FOUND */; }
    finally { Marshal.FreeHGlobal(k.Buffer); LsaClose(h); }
  }
}
'@

# The guest's Winlogon Userinit list with the session's watcher added (MC-1518), from its current value; pure, so the
# tests run it. Only Windows' own list is accepted (userinit.exe alone, any case, trailing comma or not): anything else,
# missing included, is refused, and $GuestLogon works this out before it changes anything. Winlogon starts each listed
# program in the new session at logon, as the account; the watcher by absolute paths, in the admin-only C:\hvmcp.
$UserinitValue = {
  param($current)
  $canonical = 'C:\Windows\system32\userinit.exe'
  if (-not ($current -is [string]) -or ($current.Trim().TrimEnd(',').Trim() -ine $canonical)) { throw "unexpected Userinit in the guest ('$current'): only Windows' own is changed" }
  "$canonical,C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\hvmcp\agent.ps1,"
}

# vm_start's interactive logon (MC-1503, MC-1504): Winlogon autologon of one guest account at the next boot, its password
# as the LSA secret DefaultPassword (readable only by SYSTEM and admins; not the registry value, which Users can read),
# the first-logon animation and privacy questions off, and the session's watcher (guest-agent.ps1, as C:\hvmcp\agent.ps1)
# started at logon from Winlogon's Userinit list ($UserinitValue, MC-1518: before and apart from Explorer, whose Run
# entries wait for a new desktop to settle, minutes on a first logon). C:\hvmcp is made admin-only (Users read and
# execute) so no user can change the watcher or a wrapper it starts; C:\hvmcp\user is where a standard user's session-0
# runs stage their scripts; req is where requests are published, writable by the logged-on account only so its watcher
# can claim them. For an admin logon ($elevated), UAC's Admin Approval Mode is turned off (EnableLUA 0), so the admin's
# session, and its watcher, are elevated. Then a restart. All of it is inside the throwaway guest: the next restore of
# the clean checkpoint takes it away.
$GuestLogon = {
  param($u, $p, $elevated, $agent, $userinitText, $lsaCs)
  $ErrorActionPreference = 'Stop'
  if (-not ('HvLsa' -as [type])) { Add-Type -TypeDefinition $lsaCs }
  $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  # The watcher's start at logon (MC-1518), worked out first: an unexpected Userinit refuses before anything changes.
  $userinit = & ([scriptblock]::Create($userinitText)) (Get-ItemProperty -Path $wl -Name Userinit -ErrorAction SilentlyContinue).Userinit
  Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value '1'
  Set-ItemProperty -Path $wl -Name DefaultUserName -Value $u
  Set-ItemProperty -Path $wl -Name DefaultDomainName -Value $env:COMPUTERNAME
  Remove-ItemProperty -Path $wl -Name DefaultPassword -ErrorAction SilentlyContinue
  [HvLsa]::Store('DefaultPassword', $p)
  Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableFirstLogonAnimation -Value 0 -Type DWord
  New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE' -Force | Out-Null
  Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE' -Name DisablePrivacyExperience -Value 1 -Type DWord
  if ($elevated) { Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -Value 0 -Type DWord }
  $icacls = { param($path) $out = & icacls.exe @args 2>&1; if ($LASTEXITCODE) { throw "icacls $path failed: $out" } }
  New-Item -ItemType Directory -Force -Path 'C:\hvmcp', 'C:\hvmcp\user', 'C:\hvmcp\req' | Out-Null
  & $icacls C:\hvmcp C:\hvmcp /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX'
  & $icacls C:\hvmcp\user C:\hvmcp\user /grant '*S-1-5-32-545:(OI)(CI)M'
  & $icacls C:\hvmcp\req C:\hvmcp\req /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "${u}:(OI)(CI)M"
  [IO.File]::WriteAllText('C:\hvmcp\agent.ps1', [string]$agent, (New-Object Text.UTF8Encoding $false))
  Set-ItemProperty -Path $wl -Name Userinit -Value $userinit
  Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name hvmcp-agent -ErrorAction SilentlyContinue
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
  # A short delay, so this call returns before the guest goes down.
  & shutdown.exe /r /t 3 /f /d p:4:1 | Out-Null
  @{ boot = $boot }
}

# The guest's Windows licence (MC-1513): with $activate, Activate() first, retried while the network comes up (about
# 4 minutes in all), then the licence read back: LicenseStatus (1 = licensed), GracePeriodRemaining (minutes; for a
# timebased evaluation, what is left of it) and EvaluationEndDate (when Windows reports one).
$GuestLicence = {
  param($activate)
  $q = "ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL"
  $err = $null
  if ($activate) {
    for ($i = 0; $i -lt 5; $i++) {
      try { Invoke-CimMethod -InputObject (Get-CimInstance SoftwareLicensingProduct -Filter $q | Select-Object -First 1) -MethodName Activate -ErrorAction Stop | Out-Null; $err = $null; break }
      catch { $err = $_.Exception.Message; Start-Sleep 45 }
    }
  }
  $p = Get-CimInstance SoftwareLicensingProduct -Filter $q | Select-Object -First 1
  $end = $null
  if ($p.EvaluationEndDate -and $p.EvaluationEndDate.Year -gt 1601) { $end = $p.EvaluationEndDate.ToUniversalTime().ToString('o') }
  @{ status = [int]$p.LicenseStatus; graceMinutes = [int]$p.GracePeriodRemaining; evalEnd = $end; channel = [string]$p.ProductKeyChannel; error = $err }
}

# MC-1516: what a build-time logon left, undone before the next logon and before the clean checkpoint: autologon off
# and its LSA password deleted, UAC's Admin Approval Mode back on, Windows' own Userinit list, and C:\hvmcp recreated
# empty as guest-setup left it (no explicit ACEs, inherited only), so no earlier account's req grant survives. The
# profiles (C:\Users) are kept. It reads every value back for the helper to check.
$GuestLogonUndo = {
  param($lsaCs)
  $ErrorActionPreference = 'Stop'
  if (-not ('HvLsa' -as [type])) { Add-Type -TypeDefinition $lsaCs }
  $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty -Path $wl -Name AutoAdminLogon -Value '0'
  foreach ($n in 'DefaultUserName', 'DefaultDomainName', 'DefaultPassword') { Remove-ItemProperty -Path $wl -Name $n -ErrorAction SilentlyContinue }
  $secretRemoved = [HvLsa]::Remove('DefaultPassword')
  Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -Name EnableLUA -Value 1 -Type DWord
  Set-ItemProperty -Path $wl -Name Userinit -Value 'C:\Windows\system32\userinit.exe,'
  Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name hvmcp-agent -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath 'C:\hvmcp') { Remove-Item -LiteralPath 'C:\hvmcp' -Recurse -Force }
  New-Item -ItemType Directory -Path 'C:\hvmcp' | Out-Null
  $w = Get-ItemProperty -Path $wl
  $acl = Get-Acl -LiteralPath 'C:\hvmcp'
  @{
    autoAdminLogon = [string]$w.AutoAdminLogon; defaultUserName = [string]$w.DefaultUserName; secretRemoved = [bool]$secretRemoved
    enableLUA = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System').EnableLUA
    userinit = [string]$w.Userinit; hvmcpEmpty = (@(Get-ChildItem -LiteralPath 'C:\hvmcp' -Force).Count -eq 0)
    hvmcpExplicitAces = @($acl.Access | Where-Object { -not $_.IsInherited }).Count; hvmcpProtected = [bool]$acl.AreAccessRulesProtected
  }
}

# MC-1516: one sample of an account's first-logon work at build, for the helper's quiet test: the boot, whether the
# account is logged on, the newest AppX deployment event, its installed packages (a hash of their names and status),
# and its busy first-logon workers (OneDriveSetup, or a SystemApps, UserOOBEBroker or WebView2 process that started
# within the quiet window). Any failed query throws: the helper takes it as unknown, never as idle.
$GuestProvisioned = {
  param($u, $quietMs)
  $ErrorActionPreference = 'Stop'
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
  $last = $null
  try { $last = (Get-WinEvent -LogName 'Microsoft-Windows-AppXDeploymentServer/Operational' -MaxEvents 1 -ErrorAction Stop).TimeCreated.ToUniversalTime().ToString('o') }
  catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }
  $pk = @(Get-AppxPackage -User $u | Sort-Object PackageFullName | ForEach-Object { "$($_.PackageFullName)|$($_.Status)" })
  $sha = [Security.Cryptography.SHA256]::Create()
  $inventory = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($pk -join "`n")) | ForEach-Object { $_.ToString('x2') })
  $procs = @(Get-Process -IncludeUserName | Where-Object { $_.SessionId -ge 1 -and $_.UserName -like "*\$u" })
  $since = (Get-Date).AddMilliseconds(-[int]$quietMs)
  $busy = @($procs | Where-Object { $_.Name -eq 'OneDriveSetup' -or ((($_.Path -like 'C:\Windows\SystemApps\*') -or ($_.Name -in 'UserOOBEBroker', 'msedgewebview2')) -and $_.StartTime -gt $since) } | ForEach-Object { $_.Name })
  @{ boot = $boot; user = ($procs.Count -gt 0); lastEvent = $last; count = $pk.Count; inventory = $inventory; busy = $busy }
}

# MC-1519 (the user's decision): the test work folders excluded from Defender's real-time scanning, in the guest image
# only (a just-written large exe sometimes failed to load while it was scanned). Defender stays on otherwise. It reads
# back the exclusions and Defender's state for the helper to check.
$GuestDefender = {
  param($paths)
  $ErrorActionPreference = 'Stop'
  Add-MpPreference -ExclusionPath ([string[]]$paths)
  $p = Get-MpPreference
  $s = Get-MpComputerStatus
  @{ exclusions = @($p.ExclusionPath | Where-Object { $_ }); realTime = [bool]$s.RealTimeProtectionEnabled; service = [bool]$s.AMServiceEnabled; tamper = [bool]$s.IsTamperProtected }
}

# The guest's boot time and the sessions (>= 1) in which the account's watcher runs: its interactive logon, ready for runs.
# Also (MC-1518) whether the account is logged on at all (any process of it in a session >= 1) and whether autologon is
# still armed (Winlogon clears AutoAdminLogon when the session is logged off): together, "logged on, then logged off".
$GuestSession = {
  param($u)
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
  $ids = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $_.SessionId -ge 1 -and $_.CommandLine -match 'C:\\hvmcp\\agent\.ps1' -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $u } | ForEach-Object { [int]$_.SessionId })
  $user = [bool](@(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ge 1 -and $_.UserName -like "*\$u" }).Count)
  $armed = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue).AutoAdminLogon -eq '1'
  @{ boot = $boot; sessions = $ids; user = $user; armed = $armed }
}

# Windows' built-in NAT switch (fixed id). Used only by a build's one approved online step (guest-activate) and by
# net-off; no start ever connects it (configure-start takes only the pool's internal switch).
$DEFAULT_SWITCH = 'c08cb7b8-9b3c-408e-8e30-5e16a3aeb444'

$MS_ROOTS = @('3B1EFD3A66EA28B16697394703A72CA340A05BD5', '8F43288AD272F3103B6FB1428485EA3014C0BCFE') # Microsoft Root CA 2010, 2011
$ADMIN_SIDS = @('S-1-5-18', 'S-1-5-32-544') # SYSTEM, Administrators

try {
  $in = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $a = $in.args
  $r = switch ([string]$in.op) {
    'facts' {
      $cs = Get-CimInstance Win32_ComputerSystem
      $folders = @(foreach ($f in $a.folders) {
        $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot([string]$f))
        @{ folder = [string]$f; freeGB = [int][Math]::Floor($drive.AvailableFreeSpace / 1GB) }
      })
      @{
        hyperv = [bool](Get-Command Get-VM -ErrorAction SilentlyContinue) -and ((Get-Service vmms -ErrorAction SilentlyContinue).Status -eq 'Running')
        logicalCpus = [int]$cs.NumberOfLogicalProcessors; memoryMB = [int]($cs.TotalPhysicalMemory / 1MB); folders = $folders
        defaultSwitch = [bool](Get-VMSwitch -Id $DEFAULT_SWITCH -ErrorAction SilentlyContinue)
      }
    }
    'find-vm' {
      $folder = Norm $a.folder
      $hits = @(Get-VM | Where-Object { $_.Name -ceq [string]$a.name } | Where-Object { $l = Norm $_.ConfigurationLocation; $l -eq $folder -or $l.StartsWith($folder + '\') })
      if ($hits.Count -gt 1) { throw "more than one VM named $($a.name) in its folder" }
      @{ vmId = if ($hits.Count) { $hits[0].Id.ToString() } else { $null } }
    }
    'create-vm' {
      $folder = [string]$a.folder
      $vhd = Join-Path $folder 'disk.vhdx'
      New-VHD -Path $vhd -SizeBytes ([long]$a.diskGB * 1GB) -Dynamic | Out-Null
      $vm = New-VM -Name ([string]$a.name) -Generation 2 -Path $folder -VHDPath $vhd -MemoryStartupBytes ([long]$a.memoryMB * 1MB)
      Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
      Set-VMProcessor -VM $vm -Count ([int]$a.cores) -Reserve 0
      Set-VM -VM $vm -AutomaticCheckpointsEnabled $false -CheckpointType Standard -AutomaticStartAction Nothing -AutomaticStopAction TurnOff
      Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
      Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
      Enable-VMTPM -VM $vm
      Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
      $dvd = Add-VMDvdDrive -VM $vm -Path ([string]$a.iso) -Passthru
      Add-VMDvdDrive -VM $vm -Path ([string]$a.unattendIso) | Out-Null
      Set-VMFirmware -VM $vm -FirstBootDevice $dvd
      @{ vmId = $vm.Id.ToString() }
    }
    'start-vm' {
      $vm = Get-OwnVm $a
      Start-VM -VM $vm
      # Gen 2 DVD boot waits for "Press any key to boot from CD or DVD": press Enter a few times.
      $cs = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "Name='$($vm.Id)'"
      $kb = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_Keyboard
      for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 500; Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = 13 } -ErrorAction SilentlyContinue | Out-Null }
      @{ started = $true }
    }
    'guest-ready' {
      $vm = Get-OwnVm $a
      if ($vm.State -ne 'Running') { @{ ready = $false } }
      else { $x = Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock { 'ok' } -ErrorAction Stop; @{ ready = ($x -eq 'ok') } }
    }
    'guest-setup' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestSetup -ArgumentList ([string]$a.userName)
    }
    'make-clean' {
      $vm = Get-OwnVm $a
      if ($vm.State -ne 'Off') { Stop-VM -VM $vm -Force; $t = (Get-Date).AddMinutes(10); while ((Get-VM -Id $vm.Id).State -ne 'Off' -and (Get-Date) -lt $t) { Start-Sleep 2 } }
      if ((Get-VM -Id $vm.Id).State -ne 'Off') { throw 'the guest did not shut down' }
      Get-VMDvdDrive -VM $vm | Remove-VMDvdDrive
      Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMHardDiskDrive -VM $vm | Select-Object -First 1)
      Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
      Set-VMProcessor -VM $vm -Reserve 0
      Get-VMSnapshot -VM $vm | Remove-VMSnapshot
      $cp = Checkpoint-VM -VM $vm -SnapshotName 'clean' -Passthru
      @{ checkpointId = $cp.Id.ToString() }
    }
    'restore' {
      $vm = Get-OwnVm $a
      $cp = Get-VMSnapshot -VM $vm | Where-Object { $_.Id.ToString() -eq [string]$a.checkpointId }
      if (-not $cp) { throw 'its clean checkpoint (by id) is missing' }
      if ($vm.State -eq 'Saved') { Remove-VMSavedState -VM $vm }
      elseif ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
      Restore-VMSnapshot -VMSnapshot $cp -Confirm:$false
      Facts $vm
    }
    'configure-start' {
      $vm = Get-OwnVm $a
      if ($vm.State -ne 'Off') { throw 'the VM is not Off after its restore' }
      if ($a.switchName) {
        # The pool's switch by its journalled id, never by name alone.
        if (-not $a.switchId) { throw "no recorded id for switch $($a.switchName)" }
        $sw = Get-VMSwitch -Id ([guid]$a.switchId) -ErrorAction SilentlyContinue
        if (-not $sw -or $sw.Name -cne [string]$a.switchName -or $sw.SwitchType -ne 'Internal') { throw "switch $($a.switchName) (id $($a.switchId)) is missing, renamed or not internal" }
        Get-VMNetworkAdapter -VM $vm | Connect-VMNetworkAdapter -VMSwitch $sw
      }
      Set-VMProcessor -VM $vm -Reserve ([int]$a.reserve)
      Start-VM -VM $vm
      @{ started = $true }
    }
    'copy-in' {
      $vm = Get-OwnVm $a
      $t0 = Get-Date
      $s = New-PSSession -VMId $vm.Id -Credential (Cred $a.cred)
      try {
        Invoke-Command -Session $s -ScriptBlock { Get-ChildItem -LiteralPath C:\build -Force | Remove-Item -Recurse -Force }
        $items = @(Get-ChildItem -LiteralPath ([string]$a.source) -Force)
        if ($items.Count) { Copy-Item -ToSession $s -Path $items.FullName -Destination 'C:\build' -Recurse -Force }
      } finally { Remove-PSSession $s }
      @{ ms = [int]((Get-Date) - $t0).TotalMilliseconds }
    }
    'sync-in' {
      # vm_sync: into the running guest's C:\build without a restore. The staged files go to a fresh guest staging
      # folder (PowerShell Direct, no share); guest-sync.ps1, a fixed file beside this one, checks every path and moves
      # them into place, never following a link. Only C:\build and the staging under C:\hvmcp are touched.
      $vm = Get-OwnVm $a
      if ($vm.State -ne 'Running') { throw 'the VM is not running' }
      if ([string]$a.guestStage -notmatch '^C:\\hvmcp\\sync-\d{1,9}$') { throw 'bad guest staging folder' }
      $sync = [scriptblock]::Create([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'guest-sync.ps1')))
      $t0 = Get-Date
      $s = New-PSSession -VMId $vm.Id -Credential (Cred $a.cred)
      try {
        $files = @(@($a.files) | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
        if ($files.Count) {
          [void](Invoke-Command -Session $s -ScriptBlock $sync -ArgumentList @{ action = 'prepare'; stage = [string]$a.guestStage })
          $items = @(Get-ChildItem -LiteralPath ([string]$a.source) -Force)
          if ($items.Count) { Copy-Item -ToSession $s -Path $items.FullName -Destination ([string]$a.guestStage) -Recurse -Force }
        }
        $j = @{ action = 'apply'; root = 'C:\build'; stage = [string]$a.guestStage; files = $files; remove = @(@($a.remove) | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ }); full = [bool]$a.full; delete = [bool]$a.delete }
        $r = Invoke-Command -Session $s -ScriptBlock $sync -ArgumentList $j
      } finally { Remove-PSSession $s }
      @{ ms = [int]((Get-Date) - $t0).TotalMilliseconds; copied = [int]$r.copied; removed = [int]$r.removed }
    }
    'guest-logon' {
      $vm = Get-OwnVm $a
      $agent = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'guest-agent.ps1'))
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestLogon -ArgumentList ([string]$a.logon.user), ([string]$a.logon.password), ([bool]$a.elevated), $agent, $UserinitValue.ToString(), $HvLsaCs
    }
    'guest-logon-undo' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestLogonUndo -ArgumentList $HvLsaCs
    }
    'guest-provisioned' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestProvisioned -ArgumentList ([string]$a.account), ([int]$a.quietMs)
    }
    'guest-defender' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestDefender -ArgumentList (,[string[]]@($a.paths))
    }
    'guest-licence' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestLicence -ArgumentList $false
    }
    'guest-activate' {
      # The build's one online step (MC-1513): the adapter on the Default Switch only for this call, disconnected in the
      # finally; disconnected is reported only once no adapter shows a switch. If this process is killed first, the
      # helper's net-off does it.
      $vm = Get-OwnVm $a
      $sw = Get-VMSwitch -Id $DEFAULT_SWITCH -ErrorAction SilentlyContinue
      if (-not $sw) { throw "this host has no Default Switch (id $DEFAULT_SWITCH): Windows can't be activated online from here" }
      $r = $null
      try {
        Get-VMNetworkAdapter -VM $vm | Connect-VMNetworkAdapter -VMSwitch $sw
        $r = Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestLicence -ArgumentList $true
      } finally {
        Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
      }
      $left = @(Get-VMNetworkAdapter -VM $vm | Where-Object { $_.SwitchName -or ($_.SwitchId -and $_.SwitchId -ne [guid]::Empty) })
      @{ status = $r.status; graceMinutes = $r.graceMinutes; evalEnd = $r.evalEnd; channel = $r.channel; error = $r.error; disconnected = ($left.Count -eq 0) }
    }
    'net-off' {
      # After a failed or killed online step: the guest off, then every adapter disconnected, verified.
      $vm = Get-OwnVm $a
      if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force -ErrorAction SilentlyContinue }
      Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
      $left = @(Get-VMNetworkAdapter -VM $vm | Where-Object { $_.SwitchName -or ($_.SwitchId -and $_.SwitchId -ne [guid]::Empty) })
      if ($left.Count) { throw 'its network adapter is still connected' }
      @{ offline = $true }
    }
    'guest-session' {
      $vm = Get-OwnVm $a
      if ($vm.State -ne 'Running') { throw 'the VM is not running' }
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestSession -ArgumentList ([string]$a.account)
    }
    'guest-run-start' {
      # A session-0 run, started (MC-1510): as the admin, or as the standard user in its own PowerShell Direct session,
      # which (like any remote session) needs the account in Remote Management Users (S-1-5-32-580): added here, as the
      # guest's admin, inside this disposable guest only; a restore takes it away again.
      $vm = Get-OwnVm $a
      $j = @{ n = [int]$a.n; command = [string]$a.command; shell = [string]$a.shell; cwd = [string]$a.cwd; dir = $(if ($a.runAs) { 'C:\hvmcp\user' } else { 'C:\hvmcp' }) }
      $as = Cred $a.cred
      if ($a.runAs) {
        $user = [string]$a.runAs.user
        Invoke-Command -VMId $vm.Id -Credential $as -ScriptBlock {
          param($u)
          if (-not (Get-LocalGroupMember -SID 'S-1-5-32-580' | Where-Object { $_.Name -like "*\$u" })) { Add-LocalGroupMember -SID 'S-1-5-32-580' -Member $u }
        } -ArgumentList $user
        $as = Cred $a.runAs
      }
      Invoke-Command -VMId $vm.Id -Credential $as -ScriptBlock $GuestRunStart -ArgumentList $j, $RunFiles.ToString()
    }
    'guest-run-publish' {
      $vm = Get-OwnVm $a
      $j = @{ n = [int]$a.n; command = [string]$a.command; shell = [string]$a.shell; cwd = [string]$a.cwd }
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestRunPublish -ArgumentList $j, $RunFiles.ToString()
    }
    'guest-run-poll' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestRunPoll -ArgumentList @{ n = [int]$a.n; cap = [int]$a.cap }
    }
    'guest-run-kill' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestRunKill -ArgumentList @{ pid = [int]$a.pid; started = $a.started }
    }
    'guest-list' { $vm = Get-OwnVm $a; Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestList }
    'guest-read' {
      $vm = Get-OwnVm $a
      $j = @{ paths = @($a.paths); maxBytes = [long]$a.maxBytes; maxTotalBytes = [long]$a.maxTotalBytes }
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestRead -ArgumentList $j
    }
    'remove-vm' {
      $vm = Get-VM -Id ([guid]$a.vmId) -ErrorAction SilentlyContinue
      if (-not $vm) { @{ gone = $true } }
      else {
        $vm = Get-OwnVm $a
        if ($vm.State -eq 'Saved') { Remove-VMSavedState -VM $vm }
        elseif ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
        Remove-VM -VM $vm -Force
        @{ removed = $true }
      }
    }
    'new-switch' {
      if ([string]$a.token -notmatch '^[0-9a-f]{32}$') { throw 'a switch needs its ownership token' }
      if (Get-VMSwitch -Name ([string]$a.name) -ErrorAction SilentlyContinue) { throw "a switch named $($a.name) already exists" }
      # The token in its Notes, set as it is created, marks it as the pool's even before its id is journalled.
      $sw = New-VMSwitch -Name ([string]$a.name) -SwitchType Internal -Notes "hvmcp:$($a.token)"
      @{ switchId = $sw.Id.ToString() }
    }
    'remove-switch' {
      # Only the pool's own switch: matched by its journalled id, or by the token in its Notes. Never by name alone: a
      # same-named switch that matches neither is someone else's and is left untouched (reported as foreign).
      $mine = @(Get-VMSwitch -ErrorAction SilentlyContinue | Where-Object {
        $_.SwitchType -eq 'Internal' -and (
          ($a.switchId -and $_.Id.ToString() -eq [string]$a.switchId) -or
          ([string]$a.token -match '^[0-9a-f]{32}$' -and $_.Notes -ceq "hvmcp:$($a.token)"))
      })
      if ($mine.Count -gt 1) { throw "more than one switch matches the pool's id or token" }
      if ($mine.Count -eq 1) { Remove-VMSwitch -VMSwitch $mine[0] -Force; @{ removed = $true } }
      else {
        $named = @(Get-VMSwitch -Name ([string]$a.name) -ErrorAction SilentlyContinue | Where-Object { $_.Name -ceq [string]$a.name })
        @{ gone = $true; foreign = ($named.Count -gt 0) }
      }
    }
    'make-iso' {
      $fsi = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
      $fsi.FileSystemsToCreate = if ($a.fileSystems -eq 'udf') { 4 } else { 3 }
      $fsi.VolumeName = [string]$a.label
      $fsi.Root.AddTree([string]$a.source, $false)
      Write-ImageStream $fsi.CreateResultImage().ImageStream ([string]$a.out)
      @{ out = [string]$a.out }
    }
    'signatures' {
      @{ files = @(foreach ($f in $a.files) {
        $s = Get-AuthenticodeSignature -LiteralPath ([string]$f)
        $why = $null
        if ($s.Status -ne 'Valid') { $why = "signature $($s.Status)" }
        elseif ($s.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') { $why = "signed by $($s.SignerCertificate.Subject)" }
        else {
          $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
          [void]$chain.Build($s.SignerCertificate)
          $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint
          if ($MS_ROOTS -notcontains $root) { $why = "chains to $root, not a Microsoft root" }
        }
        @{ file = [string]$f; ok = (-not $why); why = $why }
      }) }
    }
    'approval-acl' {
      $why = $null
      foreach ($p in @([string]$a.dir, [string]$a.file)) {
        $item = Get-Item -LiteralPath $p -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $why = "$p is a link"; break }
        $acl = Get-Acl -LiteralPath $p
        $owner = (New-Object Security.Principal.NTAccount $acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value
        if ($ADMIN_SIDS -notcontains $owner) { $why = "$p is owned by $($acl.Owner)"; break }
        # WriteData/CreateFiles, AppendData, DeleteChild, Delete, WriteDAC, WriteOwner, GENERIC_ALL, GENERIC_WRITE
        $writeMask = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
        foreach ($ace in $acl.Access) {
          if ($ace.AccessControlType -ne 'Allow' -or -not ([int64]$ace.FileSystemRights -band $writeMask)) { continue }
          $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
          if ($ADMIN_SIDS -notcontains $sid -and $sid -ne 'S-1-3-0') { $why = "$($ace.IdentityReference) can write $p"; break }
        }
        if ($why) { break }
      }
      @{ ok = (-not $why); why = $why }
    }
    default { throw "unknown operation '$($in.op)'" }
  }
  Answer @{ result = $r }
} catch {
  Answer @{ error = $_.Exception.Message }
}
