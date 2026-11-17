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

# MC-1536: a restore, as one pure handler both restore ops use (the tests run it with mock io). Off after a turn-off
# is polled as a condition on a monotonic clock, every sleep capped to the time left and none after the deadline,
# within 20 s; else no restore is issued at all. Then the restore is issued, and that's all: MC-1537 found that this
# process's Hyper-V objects keep the VM's parent as it was when the process started, so the new parent is never judged
# here; core verifies it from fresh facts-vm calls (each its own process). Returns { ok, phase, timedOut, last,
# waitedMs }; the callers refuse any timedOut, whatever the facts read afterwards say.
$RestoreTo = {
  param($cpId, $io)
  $t0 = & $io.now
  $poll = {
    param($probe, $want, $limitMs)
    $start = & $io.now
    for (;;) {
      $v = & $probe
      if ([string]$v -eq [string]$want) { return @{ ok = $true; last = $v } }
      $left = $limitMs - ((& $io.now) - $start)
      if ($left -le 0) { return @{ ok = $false; last = $v } }
      & $io.sleep ([Math]::Max(1, [Math]::Min(500, [int]$left)))
    }
  }
  $st = & $io.state
  if ($st -eq 'Saved') { & $io.removeSaved } elseif ($st -ne 'Off') { & $io.turnOff }
  $off = & $poll $io.state 'Off' 20000
  if (-not $off.ok) { return @{ ok = $false; phase = 'off'; timedOut = $true; last = [string]$off.last; waitedMs = [int]((& $io.now) - $t0) } }
  & $io.restore
  @{ ok = $true; phase = 'restored'; timedOut = $false; last = 'Off'; waitedMs = [int]((& $io.now) - $t0) }
}

# MC-1536: the real io for $RestoreTo: Get-VM (for the state), Stop-VM, Remove-VMSavedState, Restore-VMSnapshot, Start-Sleep, a Stopwatch.
function RestoreIo($vm, $cp) {
  $id = $vm.Id
  $sw = [Diagnostics.Stopwatch]::StartNew()
  @{
    state = { [string](Get-VM -Id $id).State }.GetNewClosure()
    turnOff = { Stop-VM -VM (Get-VM -Id $id) -TurnOff -Force }.GetNewClosure()
    removeSaved = { Remove-VMSavedState -VM (Get-VM -Id $id) }.GetNewClosure()
    restore = { Restore-VMSnapshot -VMSnapshot $cp -Confirm:$false }.GetNewClosure()
    sleep = { param($ms) Start-Sleep -Milliseconds $ms }
    now = { $sw.Elapsed.TotalMilliseconds }.GetNewClosure()
  }
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

# MC-1547: each session-0 run in its own Job object, so a timeout's kill ends everything the run started, whenever it
# was created (taskkill /T, from a snapshot of parent PIDs, misses a child created as it runs). Compiled in the guest by
# Add-Type (passed in as text). Design:
# - The job is named (hvmcp-run-<n>-<16 hex>, random, so never reused) and made with a DACL for SYSTEM, Administrators
#   and its owner only, so the admin's kill call can open a standard user's run's job, and nobody else can.
# - Not kill-on-close: a run starts in one short PowerShell Direct call and outlives it, so the job must too. A run that
#   finishes still leaves its processes running, as before.
# - Its name lasts only while a handle to it is open (the kernel drops an object's name with its last handle, whatever
#   still references it). So the run's processes hold one: the job's handle is inheritable, the wrapper's cmd inherits
#   exactly that handle (an explicit handle list, nothing else of this process), and cmd's children inherit it from it.
#   The name lasts as long as any process of the run holding it; the kill finds no job only once they've all ended.
# - The wrapper's cmd is created suspended, put in the job, then resumed: nothing it starts is ever outside the job.
#   No breakaway is allowed (a program that asks for CREATE_BREAKAWAY_FROM_JOB gets access denied for that child). A
#   program that makes its own job gets a nested one (Windows 8 and later), inside ours: terminating ours ends it too.
# - Kill: open the job by name, TerminateJobObject, then confirm no process is left in it. No job by that name means its
#   processes have all ended. If the job can't be made, or opened at the kill, the PID-checked taskkill below remains.
$RunJob = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class HvMcpRunJob
{
    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, int rev, out IntPtr sd, IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(ref SECURITY_ATTRIBUTES sa, string name);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out ACCOUNTING info, int size, IntPtr ret);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);

    const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, EXTENDED_STARTUPINFO_PRESENT = 0x80000, JOB_TERMINATE = 0x8, JOB_QUERY = 0x4;
    static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x20002;
    const int ERROR_FILE_NOT_FOUND = 2, ERROR_ALREADY_EXISTS = 183;

    // Starts cmdLine suspended, in a new job of this name, then resumes it. Returns its PID; throws when it can't.
    public static int Start(string cmdLine, string jobName)
    {
        IntPtr sd;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)", 1, out sd, IntPtr.Zero)) throw new Win32Exception();
        // Inheritable: the run's processes hold it, so its name lasts while they do.
        var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = sd, bInheritHandle = true };
        IntPtr job = CreateJobObject(ref sa, jobName);
        int err = Marshal.GetLastWin32Error();
        LocalFree(sd);
        if (job == IntPtr.Zero) throw new Win32Exception(err);
        if (err == ERROR_ALREADY_EXISTS) { CloseHandle(job); throw new Win32Exception(err, "a job of that name already exists"); }
        IntPtr list = IntPtr.Zero, handles = IntPtr.Zero;
        try
        {
            // Inherit exactly the job's handle, nothing else of this process.
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            list = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception();
            handles = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(handles, job);
            if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            var si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.lpAttributeList = list;
            PROCESS_INFORMATION pi;
            if (!CreateProcess(null, new System.Text.StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref si, out pi)) throw new Win32Exception();
            try
            {
                if (!AssignProcessToJobObject(job, pi.hProcess)) { int e = Marshal.GetLastWin32Error(); TerminateProcess(pi.hProcess, 1); throw new Win32Exception(e); }
                ResumeThread(pi.hThread);
                return pi.dwProcessId;
            }
            finally { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
        }
        finally
        {
            if (list != IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            CloseHandle(job); // this process's own handle; the run's processes hold theirs (not kill-on-close)
        }
    }

    // Ends every process in the job of this name: 0 no such job (its processes have all ended), 1 terminated and
    // confirmed empty, 2 terminated but processes still listed after waitMs, -1 couldn't open or terminate it.
    public static int Kill(string jobName, int waitMs)
    {
        IntPtr job = OpenJobObject(JOB_TERMINATE | JOB_QUERY, false, jobName);
        if (job == IntPtr.Zero) return Marshal.GetLastWin32Error() == ERROR_FILE_NOT_FOUND ? 0 : -1;
        try
        {
            if (!TerminateJobObject(job, 1)) return -1;
            var deadline = DateTime.UtcNow.AddMilliseconds(waitMs);
            for (;;)
            {
                ACCOUNTING a;
                if (!QueryInformationJobObject(job, 1, out a, Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero)) return -1;
                if (a.ActiveProcesses == 0) return 1;
                if (DateTime.UtcNow > deadline) return 2;
                System.Threading.Thread.Sleep(50);
            }
        }
        finally { CloseHandle(job); }
    }
}
'@

# A session-0 run's start, as the run's own account (its admin, or its standard user in its own PowerShell Direct
# session): the files, then the wrapper, in the run's own job (MC-1547; $jobSource is $RunJob's text). Returns its PID,
# its creation time, read from the started process's own handle (a process that has already exited has none to read:
# the exit file then decides), and its job's name (null when the job couldn't be made: the run then starts as before,
# with Start-Process, and the kill falls back to taskkill).
$GuestRunStart = {
  param($j, $files, $jobSource)
  $ErrorActionPreference = 'Stop'
  $wrapper = & ([scriptblock]::Create($files)) $j ([string]$j.dir)
  $jobName = $null
  $p = $null
  if ($jobSource) {
    try {
      if (-not ('HvMcpRunJob' -as [type])) { Add-Type -TypeDefinition $jobSource }
      $name = 'hvmcp-run-{0}-{1}' -f [int]$j.n, ([guid]::NewGuid().ToString('N').Substring(0, 16))
      $runPid = [HvMcpRunJob]::Start("cmd.exe /d /c `"$wrapper`"", $name)
      $jobName = $name
      try { $p = [Diagnostics.Process]::GetProcessById($runPid) } catch { $p = $null; $id = $runPid }
    } catch { $jobName = $null; $p = $null }
  }
  if (-not $jobName) { $p = Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /c `"$wrapper`"" -PassThru -WindowStyle Hidden }
  if ($p) { $id = $p.Id }
  $started = $null
  if ($p) {
    try {
      try { [void]$p.Handle; $started = $p.StartTime.ToUniversalTime().ToString('o') } catch { }
    } finally { try { $p.Dispose() } catch { } }
  }
  # The PID and the creation time were read while the object still held the process (Windows PowerShell's Id is null
  # once it is disposed), then it was disposed.
  @{ pid = $id; started = $started; job = $jobName }
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
  param($j, $jobSource)
  # MC-1547: the run's job, when it has one: everything in it ends, whenever it was started. No job by that name means
  # every process of the run has ended. A job that can't be opened or terminated falls back to the PID path below.
  if ($j.job -and $jobSource -and ([string]$j.job -match '^hvmcp-run-\d{1,9}-[0-9a-f]{16}$')) {
    $r = -1
    try {
      if (-not ('HvMcpRunJob' -as [type])) { Add-Type -TypeDefinition $jobSource }
      $r = [HvMcpRunJob]::Kill([string]$j.job, 10000)
    } catch { $r = -1 }
    if ($r -eq 1) { return @{ killed = $true; via = 'job' } }
    if ($r -eq 0) { return @{ killed = $false; gone = $true } }
    if ($r -eq 2) { return @{ killed = $false; why = 'processes were still in its job 10 s after it was terminated' } }
  }
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
# VM is restored ("exit file or restore", decided on MC-1503).
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
  # MC-1522: a session-0 run outlives the PowerShell Direct session that started it (MC-1510). The evidence suggests,
  # but doesn't yet prove (MC-1521's trial does), that without this policy the User Profile Service force-unloads the
  # account's registry when that session ends, under the still-running run ("registry key marked for deletion",
  # 0x800703FA, seen in a run; .NET's LoadFile failing with E_UNEXPECTED). Read back for the check.
  New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Force | Out-Null
  Set-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -Name DisableForceUnload -Value 1 -Type DWord
  $dfu = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' -ErrorAction SilentlyContinue).DisableForceUnload
  @{ editionId = $cv.EditionID; build = $cv.CurrentBuild; ubr = $cv.UBR; disableForceUnload = $(if ($null -eq $dfu) { $null } else { [int]$dfu }) }
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
# MC-1520: an account's AppContainer profile counts from raw facts, pure so the tests run it. A location that is
# readable but absent counts 0 (a first profile may have none yet); an unloaded classes store, an unknown profile path or
# a failed enumeration is $null (unknown: the helper never takes it as quiet).
$ProfileCounts = {
  param($r)
  $mappings = $null
  if ($r.classesLoaded) { if ($r.mappingsKey -eq 'missing') { $mappings = 0 } elseif ($r.mappingsKey -eq 'present') { $mappings = [int]$r.mappingsCount } }
  $packages = $null
  if ($r.profilePath) { if ($r.packagesDir -eq 'missing') { $packages = 0 } elseif ($r.packagesDir -eq 'present') { $packages = [int]$r.packagesCount } }
  @{ mappings = $mappings; packagesDirs = $packages }
}

# MC-1528: whether App Readiness has finished the account's per-user queue (the AppContainer wave, MC-1525), pure so the
# tests run it. $events: AppReadiness Admin/Operational events of this boot (Id, TimeCreated, RecordId, Message), or
# $null when a log couldn't be read (then done is $null: never evidence). Done = a 211 ("completed tasks for <SID>")
# naming the SID, the latest 240/241 for the SID at "tasks: 0", and no 240 (a task added) for the SID after that 211.
# Also returned for the record: the task count, 216's "will resume at" and 217's resume, as UTC times.
$AppReadinessState = {
  param($events, $sid)
  if ($null -eq $events) { return @{ done = $null; tasks = $null; completedAt = $null; completionId = $null; suspendedUntil = $null; resumedAt = $null } }
  $s = [regex]::Escape($sid)
  $mine = @($events | Where-Object { [string]$_.Message -match "$s(\b|')" } | Sort-Object TimeCreated, RecordId)
  $iso = { param($t) if ($t) { $t.ToUniversalTime().ToString('o') } else { $null } }
  $done211 = @($mine | Where-Object { $_.Id -eq 211 }) | Select-Object -Last 1
  $counted = @($mine | Where-Object { ($_.Id -in @(240, 241)) -and ([string]$_.Message -match 'tasks:\s*(\d+)') }) | Select-Object -Last 1
  $tasks = $null
  if ($counted -and ([string]$counted.Message -match 'tasks:\s*(\d+)')) { $tasks = [int]$Matches[1] }
  # 211 and 240 are both Admin-log events: its record order catches a task added in the same second as the 211.
  $addedAfter = $done211 -and @($mine | Where-Object { $_.Id -eq 240 -and ($_.TimeCreated -gt $done211.TimeCreated -or ($_.TimeCreated -eq $done211.TimeCreated -and $_.RecordId -gt $done211.RecordId)) }).Count -gt 0
  $susp = @($mine | Where-Object { $_.Id -eq 216 }) | Select-Object -Last 1
  $until = $null
  if ($susp -and ([string]$susp.Message -match 'resume at\s+(.+?)\.?\s*$')) { $d = [datetime]::MinValue; if ([datetime]::TryParse((($Matches[1] -replace '[^0-9TZ:.\-]', '') -replace '(\.\d{7})\d+', '$1'), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$d)) { $until = $d.ToString('o') } }
  $res = @($mine | Where-Object { $_.Id -eq 217 }) | Select-Object -Last 1
  # completionId: the 211's Admin-log record id, the completion's generation (two in the same second still differ).
  $cid = if ($done211) { [long]$done211.RecordId } else { $null }
  @{ done = [bool]($done211 -and $tasks -eq 0 -and -not $addedAfter); tasks = $tasks; completedAt = (& $iso $done211.TimeCreated); completionId = $cid; suspendedUntil = $until; resumedAt = (& $iso $res.TimeCreated) }
}

# MC-1529: Hyper-V's jobs (CIM_ConcreteJob JobState) count as ended only in a documented terminal state: Completed (7),
# Terminated (8), Exception (10) or Completed with warnings (32768). Every other state, New (2), Starting (3), Running
# (4), Suspended (5), Shutting Down (6), Killed (9, its work may still be going), Service (11), or any unknown value,
# is not ended. Pure, so the tests run it. Returns { idle, pending }.
$JobsIdle = {
  param($states)
  $ended = @(7, 8, 10, 32768)
  $pending = @(@($states) | Where-Object { $null -ne $_ -and [int]$_ -notin $ended })
  @{ idle = ($pending.Count -eq 0); pending = $pending.Count }
}

$GuestProvisioned = {
  param($u, $quietMs, $countsText, $readinessText)
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
  # MC-1520: the account's own AppContainer profiles (its classes store by SID, its profile by SID: never this session's
  # HKCU), as CB1's census counts them for the logged-on user.
  $raw = @{ classesLoaded = $false; mappingsKey = 'error'; mappingsCount = 0; profilePath = $null; packagesDir = 'error'; packagesCount = 0 }
  try {
    $sid = [string](Get-CimInstance Win32_UserAccount -Filter "LocalAccount=True AND Name='$u'").SID
    if ($sid) {
      $classes = "Registry::HKEY_USERS\${sid}_Classes"
      $raw.classesLoaded = Test-Path -LiteralPath $classes
      $mk = "$classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings"
      try { if (Test-Path -LiteralPath $mk) { $raw.mappingsCount = @(Get-ChildItem -LiteralPath $mk -ErrorAction Stop).Count; $raw.mappingsKey = 'present' } else { $raw.mappingsKey = 'missing' } } catch { $raw.mappingsKey = 'error' }
      $raw.profilePath = [string](Get-CimInstance Win32_UserProfile -Filter "SID='$sid'").LocalPath
      if ($raw.profilePath) {
        $pd = Join-Path $raw.profilePath 'AppData\Local\Packages'
        try { if (Test-Path -LiteralPath $pd) { $raw.packagesCount = @(Get-ChildItem -LiteralPath $pd -Directory -Force -ErrorAction Stop).Count; $raw.packagesDir = 'present' } else { $raw.packagesDir = 'missing' } } catch { $raw.packagesDir = 'error' }
      }
    }
  } catch { }
  $counts = & ([scriptblock]::Create($countsText)) $raw
  # MC-1528: App Readiness's per-user queue for this account, from this boot's events (both logs readable, or $null).
  $ar = $null
  try {
    $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    $arSid = [string](Get-CimInstance Win32_UserAccount -Filter "LocalAccount=True AND Name='$u'").SID
    $evs = foreach ($log in 'Microsoft-Windows-AppReadiness/Admin', 'Microsoft-Windows-AppReadiness/Operational') {
      $info = Get-WinEvent -ListLog $log -ErrorAction Stop
      if (-not $info.IsEnabled) { throw "$log is disabled" }
      try { Get-WinEvent -FilterHashtable @{ LogName = $log; Id = 211, 216, 217, 240, 241; StartTime = $bootTime } -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }
    }
    if ($arSid) { $ar = & ([scriptblock]::Create($readinessText)) @($evs) $arSid }
  } catch { $ar = $null }
  if ($null -eq $ar) { $ar = & ([scriptblock]::Create($readinessText)) $null '' }
  @{ boot = $boot; user = ($procs.Count -gt 0); lastEvent = $last; count = $pk.Count; inventory = $inventory; busy = $busy; mappings = $counts.mappings; packagesDirs = $counts.packagesDirs; appReadiness = $ar }
}

# MC-1519 (the user's decision): the test work folders excluded from Defender's scanning (an ExclusionPath: real-time
# and scheduled scans), in the guest image only. The user's chosen mitigation for an intermittent load failure of a
# just-written large exe; Defender's part in it is suspected, not established. Defender stays on otherwise. It reads
# back the exclusions and Defender's state for the helper to check.
$GuestDefender = {
  param($paths)
  $ErrorActionPreference = 'Stop'
  Add-MpPreference -ExclusionPath ([string[]]$paths)
  $p = Get-MpPreference
  $s = Get-MpComputerStatus
  @{ exclusions = @($p.ExclusionPath | Where-Object { $_ }); realTime = [bool]$s.RealTimeProtectionEnabled; service = [bool]$s.AMServiceEnabled; tamper = [bool]$s.IsTamperProtected }
}

# MC-1520: events shaped to allowlisted fields only, pure so the tests run it: the last $cap of them, oldest first, as
# { id; s } (s = whole seconds after the boot). Never a message, a command line or any other field.
$DiagEvents = {
  param($events, $boot, $cap)
  @($events | Sort-Object TimeCreated | Select-Object -Last ([int]$cap) | ForEach-Object { @{ id = [int]$_.Id; s = [int][Math]::Floor(($_.TimeCreated - $boot).TotalSeconds) } })
}

# MC-1520: a read-only snapshot of a build-time logon, for the helper's record of a slow or failed attempt. Allowlisted
# fields only (event ids and seconds after the boot, process names and seconds, booleans, the fixed account name);
# never a password, LSA data, a command line or an event message. Each log is 'unavailable' when it is missing,
# disabled or its query fails, or a list (possibly empty) of its last 12 events of this boot, filtered to the account
# where the event names one.
$GuestLogonDiag = {
  param($u, $shapeText)
  $ErrorActionPreference = 'Stop'
  $shape = [scriptblock]::Create($shapeText)
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
  function Chan($log, $ids, $keep) {
    try {
      $l = Get-WinEvent -ListLog $log -ErrorAction Stop
      if (-not $l.IsEnabled) { return 'unavailable' }
      $f = @{ LogName = $log; StartTime = $boot }
      if ($ids) { $f.Id = $ids }
      $ev = @()
      try { $ev = @(Get-WinEvent -FilterHashtable $f -ErrorAction Stop) } catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } }
      if ($keep) { $ev = @($ev | Where-Object $keep) }
      ,@(& $shape $ev $boot 12)
    } catch { 'unavailable' }
  }
  $acct = [regex]::Escape($u)
  $logs = [ordered]@{
    lsm = Chan 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational' @(21, 22, 23, 24, 40) { $_.Message -match "\\$acct\b" }
    security = Chan 'Security' @(4624, 4647) { $_.Message -match "Account Name:\s+$acct\b" -and ($_.Id -eq 4647 -or $_.Message -match 'Logon Type:\s+2\b') }
    winlogon = Chan 'Microsoft-Windows-Winlogon/Operational' $null $null
    profile = Chan 'Microsoft-Windows-User Profile Service/Operational' $null $null
    shellCore = Chan 'Microsoft-Windows-Shell-Core/Operational' $null $null
    appReadinessAdmin = Chan 'Microsoft-Windows-AppReadiness/Admin' $null $null
    appReadinessOperational = Chan 'Microsoft-Windows-AppReadiness/Operational' $null $null
    cloudExperienceHost = Chan 'Microsoft-Windows-CloudExperienceHost/Operational' $null $null
  }
  $appx = 'unavailable'
  try { $e = Get-WinEvent -LogName 'Microsoft-Windows-AppXDeploymentServer/Operational' -MaxEvents 1 -ErrorAction Stop; $appx = [int][Math]::Floor(($e.TimeCreated - $boot).TotalSeconds) } catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $appx = $null } }
  $w = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  $watch = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.SessionId -ge 1 -and $_.CommandLine -match 'C:\\hvmcp\\agent\.ps1' -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $u })
  $procs = @(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ge 1 -and $_.UserName -like "*\$u" } | Sort-Object StartTime | Select-Object -First 25 | ForEach-Object { @{ name = [string]$_.Name; s = [int][Math]::Floor(($_.StartTime - $boot).TotalSeconds) } })
  @{
    uptime = [int][Math]::Floor(((Get-Date) - $boot).TotalSeconds); logs = $logs; appxLast = $appx
    autoAdminLogon = [string]$w.AutoAdminLogon; defaultUserIsAccount = ([string]$w.DefaultUserName -eq $u)
    watcher = ($watch.Count -gt 0); watcherS = $(if ($watch.Count) { [int][Math]::Floor(($watch[0].CreationDate - $boot).TotalSeconds) } else { $null })
    processes = $procs
  }
}

# The guest's boot time and the sessions (>= 1) in which the account's watcher runs: its interactive logon, ready for runs.
# Also (MC-1518) whether the account is logged on at all (any process of it in a session >= 1) and whether autologon is
# still armed (Winlogon clears AutoAdminLogon when the session is logged off): together, "logged on, then logged off".
# MC-1524: the account's logons (LSM 21) and logoffs (LSM 23) on this boot, pure so the tests run it: $events is the
# log's events (an empty list when it has none) or $null when it couldn't be read; then both counts are $null, never 0,
# so an unreadable log is never evidence. Only events at or after $boot whose message names the account count.
$LogonCounts = {
  param($events, $boot, $u)
  if ($null -eq $events) { return @{ logons = $null; logoffs = $null } }
  $acct = [regex]::Escape($u)
  $mine = @($events | Where-Object { $_.TimeCreated -ge $boot -and [string]$_.Message -match "\\$acct\b" })
  @{ logons = [int]@($mine | Where-Object { $_.Id -eq 21 }).Count; logoffs = [int]@($mine | Where-Object { $_.Id -eq 23 }).Count }
}

$GuestSession = {
  param($u, $countsText)
  $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
  $boot = $bootTime.ToUniversalTime().ToString('o')
  $ids = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
    $_.SessionId -ge 1 -and $_.CommandLine -match 'C:\\hvmcp\\agent\.ps1' -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $u } | ForEach-Object { [int]$_.SessionId })
  $user = [bool](@(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ge 1 -and $_.UserName -like "*\$u" }).Count)
  $armed = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -ErrorAction SilentlyContinue).AutoAdminLogon -eq '1'
  # MC-1524: a first logon Windows drops before any check sees it leaves only its LSM logon and logoff events.
  $ev = $null
  try { $ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-TerminalServices-LocalSessionManager/Operational'; Id = 21, 23; StartTime = $bootTime } -ErrorAction Stop) }
  catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { $ev = @() } }
  $c = & ([scriptblock]::Create($countsText)) $ev $bootTime $u
  @{ boot = $boot; sessions = $ids; user = $user; armed = $armed; logons = $c.logons; logoffs = $c.logoffs }
}

# MC-1501: a Linux VM's build COM1 pipe, by its random name: \\.\pipe\hvmcp-diag-<16 hex>.
$ComPipePath = {
  param([string]$name)
  if ($name -notmatch '^hvmcp-diag-[0-9a-f]{16}$') { throw 'bad pipe name' }
  '\\.\pipe\' + $name
}

# MC-1501: vhd-convert's paths, nothing but the helper's own: <folder>\convert-<12 hex>.vhd to <folder>\<SHA-256>.vhdx.
$ConvertPathsOk = {
  param([string]$vhd, [string]$vhdx)
  ($vhd -match '\\convert-[0-9a-f]{12}\.vhd$') -and ($vhdx -match '\\[0-9a-f]{64}\.vhdx$')
}

# MC-1501: reads HVMCP-DIAG lines from a stream (COM1's pipe) until the seed's last stage (stage=socket-up), the
# deadline, the stream's end, or 64 KB in all ($state.bytes, across reconnections). One read is pending at a time: a
# quiet spell only waits on it again, never starts another. Partial lines are kept, bounded by the same 64 KB; at most
# 64 lines are kept, and nothing but the part of a line from its HVMCP-DIAG marker. MC-1545: with $state.through, the
# seed's last stage doesn't end it (the guest's SSH connections are reported after it); a stop file the helper writes
# ($state.stopFile, checked at least every second) ends it instead, as the deadline does.
$ComReadStream = {
  param($stream, [DateTime]$deadline, $lines, $state)
  $buf = New-Object byte[] 4096
  $acc = ''
  $pending = $null
  while (-not $state.done) {
    if ($state.stopFile -and (Test-Path -LiteralPath $state.stopFile)) { $state.stopped = $true; $state.done = $true; break }
    $left = ($deadline - [DateTime]::UtcNow).TotalMilliseconds
    if ($left -le 0) { break }
    if ($null -eq $pending) { $pending = $stream.ReadAsync($buf, 0, $buf.Length) }
    $slice = if ($state.stopFile) { 1000 } else { 5000 }
    try { if (-not $pending.Wait([int][Math]::Max(1, [Math]::Min($left, $slice)))) { continue } } catch { break }
    $n = $pending.Result
    $pending = $null
    if ($n -le 0) { break }
    $state.bytes += $n
    if ($state.bytes -gt 65536) { $state.over = $true; $state.done = $true; break }
    $acc += [Text.Encoding]::ASCII.GetString($buf, 0, $n)
    $i = $acc.LastIndexOf("`n")
    if ($i -lt 0) { continue }
    foreach ($line in $acc.Substring(0, $i).Split("`n")) {
      $j = $line.IndexOf('HVMCP-DIAG ')
      if ($j -lt 0) { continue }
      $l = $line.Substring($j).TrimEnd("`r")
      if ($lines.Count -lt 64) { $lines.Add($l) }
      if ($l -match '(^| )stage=socket-up( |$)') { $state.stage = $true; if (-not $state.through) { $state.done = $true } }
    }
    $acc = $acc.Substring($i + 1)
  }
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
      if ($a.os -eq 'linux') {
        # MC-1501: a Linux VM is a copy of its image's verified base VHDX (the helper rechecked its hash), grown to the
        # plan's size (cloud-init grows the root file system at first boot), booted from disk with the Microsoft UEFI CA
        # template (Debian's and Ubuntu's shim are signed by it), and its cloud-init seed as a DVD. No TPM: nothing uses
        # one. The network adapter stays disconnected.
        Copy-Item -LiteralPath ([string]$a.baseVhdx) -Destination $vhd
        if ((Get-VHD -Path $vhd).Size -lt ([long]$a.diskGB * 1GB)) { Resize-VHD -Path $vhd -SizeBytes ([long]$a.diskGB * 1GB) }
        $vm = New-VM -Name ([string]$a.name) -Generation 2 -Path $folder -VHDPath $vhd -MemoryStartupBytes ([long]$a.memoryMB * 1MB)
        Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
        Set-VMProcessor -VM $vm -Count ([int]$a.cores) -Reserve 0
        Set-VM -VM $vm -AutomaticCheckpointsEnabled $false -CheckpointType Standard -AutomaticStartAction Nothing -AutomaticStopAction TurnOff
        Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority
        Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
        Add-VMDvdDrive -VM $vm -Path ([string]$a.seedIso) | Out-Null
        Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMHardDiskDrive -VM $vm | Select-Object -First 1)
        @{ vmId = $vm.Id.ToString() }
        break
      }
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
      if ($a.noKeys) { @{ started = $true }; break } # MC-1501: a Linux VM boots from its disk: no keys to press
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
      if (-not $cp) { throw "its $(if ($a.label) { [string]$a.label } else { 'clean' }) checkpoint (by id) is missing" }
      $r = & $RestoreTo $cp.Id.ToString() (RestoreIo $vm $cp)
      $f = Facts $vm
      $f.restore = $r
      $f
    }
    # MC-1529: a lease's own checkpoints. Each is a production checkpoint (disk-consistent through VSS in the guest, no
    # memory state), taken only while the VM runs, under its unique name hvmcp-lease-<opId>; the VM's checkpoint type is
    # put back whatever happens, and a production checkpoint that can't be made fails: never a standard one instead.
    'snapshots' {
      $vm = Get-OwnVm $a
      @{ snapshots = @(Get-VMSnapshot -VM $vm | ForEach-Object { @{ id = $_.Id.ToString(); name = [string]$_.Name; parentId = if ($_.ParentSnapshotId) { $_.ParentSnapshotId.ToString() } else { $null } } }) }
    }
    'lease-checkpoint' {
      $vm = Get-OwnVm $a
      if ($vm.State -ne 'Running') { throw "the VM is $($vm.State), not Running" }
      if ([string]$a.snapName -notmatch '^hvmcp-lease-[0-9a-f]{12}$') { throw 'bad checkpoint name' }
      $old = $vm.CheckpointType
      $cp = $null; $err = $null
      try {
        Set-VM -VM $vm -CheckpointType ProductionOnly
        # Checkpoint-VM runs Hyper-V's job to completion: an error here is that job's terminal failure, answered as such
        # (failed: true); only a call that dies or times out leaves the outcome unknown.
        try { $cp = Checkpoint-VM -VM $vm -SnapshotName ([string]$a.snapName) -Passthru -ErrorAction Stop } catch { $err = $_.Exception.Message }
      } finally { Set-VM -VM $vm -CheckpointType $old }
      $type = [string](Get-VM -Id $vm.Id).CheckpointType
      if ($err) { @{ failed = $true; error = $err; checkpointType = $type } }
      else { @{ checkpointId = $cp.Id.ToString(); checkpointType = $type } }
    }
    'jobs-idle' {
      # MC-1529: whether every Hyper-V job on this host has ended (host-wide, so conservative): a take whose call died is
      # settled as never made only then. The rule is $JobsIdle's.
      $states = @(Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ConcreteJob -ErrorAction Stop | ForEach-Object { [int]$_.JobState })
      & $JobsIdle $states
    }
    'lease-restore' {
      $vm = Get-OwnVm $a
      $cp = Get-VMSnapshot -VM $vm | Where-Object { $_.Id.ToString() -eq [string]$a.checkpointId -and [string]$_.Name -ceq [string]$a.snapName }
      if (-not $cp) { throw "checkpoint $($a.snapName) (by id) is missing on this VM" }
      $r = & $RestoreTo $cp.Id.ToString() (RestoreIo $vm $cp)
      $f = Facts $vm
      $f.restore = $r
      $f
    }
    # MC-1532: a pool checkpoint's steps. The guest is shut down cleanly (never turned off), its network disconnected only
    # (net-off would turn the VM off too), and the checkpoint taken of the Off VM, so it holds no runtime state.
    'net-disconnect' {
      $vm = Get-OwnVm $a
      Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
      Facts $vm
    }
    'guest-shutdown' {
      $vm = Get-OwnVm $a
      if ($vm.State -eq 'Running') { Stop-VM -VM $vm -Force -ErrorAction Stop }
      $t = (Get-Date).AddMinutes(5)
      while ((Get-VM -Id $vm.Id).State -ne 'Off' -and (Get-Date) -lt $t) { Start-Sleep 2 }
      Facts $vm
    }
    'pool-take' {
      $vm = Get-OwnVm $a
      if ($vm.State -ne 'Off') { throw "the VM is $($vm.State), not Off" }
      # MC-1501: a Linux lease checkpoint (hvmcp-lease-) is taken of the Off VM too (no VSS in the guest).
      if ([string]$a.snapName -notmatch '^hvmcp-(pool|clean|lease)-[0-9a-f]{12}$') { throw 'bad checkpoint name' }
      $cp = $null; $err = $null
      try { $cp = Checkpoint-VM -VM $vm -SnapshotName ([string]$a.snapName) -Passthru -ErrorAction Stop } catch { $err = $_.Exception.Message }
      if ($err) { @{ failed = $true; error = $err } } else { @{ checkpointId = $cp.Id.ToString() } }
    }
    'checkpoint-type' {
      # MC-1529: the VM's checkpoint type, read, or set and read back (an interrupted take's type is put back by this).
      $vm = Get-OwnVm $a
      if ($a.set) { Set-VM -VM $vm -CheckpointType ([string]$a.set) }
      @{ type = [string](Get-VM -Id $vm.Id).CheckpointType }
    }
    'facts-vm' {
      Facts (Get-OwnVm $a)
    }
    'snapshot-remove' {
      # Only the exact snapshot: this id and this name, on this VM. Absent already counts as removed.
      $vm = Get-OwnVm $a
      $cp = Get-VMSnapshot -VM $vm | Where-Object { $_.Id.ToString() -eq [string]$a.checkpointId -and [string]$_.Name -ceq [string]$a.snapName }
      if ($cp) { Remove-VMSnapshot -VMSnapshot $cp -Confirm:$false }
      $left = @(Get-VMSnapshot -VM $vm | Where-Object { $_.Id.ToString() -eq [string]$a.checkpointId })
      @{ removed = ($left.Count -eq 0) }
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
      } else {
        # MC-1529: network off means disconnected, whatever the restored checkpoint's adapter said.
        Get-VMNetworkAdapter -VM $vm | Disconnect-VMNetworkAdapter
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
    'guest-logon-diag' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestLogonDiag -ArgumentList ([string]$a.account), $DiagEvents.ToString()
    }
    'guest-logon-undo' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestLogonUndo -ArgumentList $HvLsaCs
    }
    'guest-provisioned' {
      $vm = Get-OwnVm $a
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestProvisioned -ArgumentList ([string]$a.account), ([int]$a.quietMs), $ProfileCounts.ToString(), $AppReadinessState.ToString()
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
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestSession -ArgumentList ([string]$a.account), $LogonCounts.ToString()
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
      Invoke-Command -VMId $vm.Id -Credential $as -ScriptBlock $GuestRunStart -ArgumentList $j, $RunFiles.ToString(), $RunJob
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
      Invoke-Command -VMId $vm.Id -Credential (Cred $a.cred) -ScriptBlock $GuestRunKill -ArgumentList @{ pid = [int]$a.pid; started = $a.started; job = $a.job }, $RunJob
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
    # MC-1501: a Linux VM's build diagnostics (design §4.2). COM1 goes to a named pipe of a random name for the build
    # only; com-read reads it as a client (Hyper-V serves the pipe while the VM runs), keeping only HVMCP-DIAG lines,
    # bounded in bytes and time, until the seed's last stage or its deadline; com-detach unsets the port, read back.
    'com-attach' {
      $vm = Get-OwnVm $a
      Set-VMComPort -VM $vm -Number 1 -Path (& $ComPipePath ([string]$a.pipe))
      @{ path = [string](Get-VMComPort -VM $vm -Number 1).Path }
    }
    'com-read' {
      # Connected again whenever the pipe closes (Hyper-V serves it per VM run); lines and bytes count across them.
      $null = & $ComPipePath ([string]$a.pipe)
      $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$a.ms)
      $lines = New-Object Collections.Generic.List[string]
      # MC-1545: through (read on past the seed's last stage) and its stop file, only the helper's own for this pipe.
      $stopFile = $null
      if ($a.stopFile) {
        if ([string]$a.stopFile -notmatch ('\\runs\\' + [regex]::Escape([string]$a.pipe) + '\.stop$')) { throw 'bad stop file' }
        $stopFile = [string]$a.stopFile
      }
      $state = @{ bytes = 0; done = $false; connected = $false; stage = $false; over = $false; through = [bool]$a.through; stopFile = $stopFile; stopped = $false }
      while (-not $state.done -and [DateTime]::UtcNow -lt $deadline) {
        if ($stopFile -and (Test-Path -LiteralPath $stopFile)) { $state.stopped = $true; break }
        $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', [string]$a.pipe, [IO.Pipes.PipeDirection]::In)
        try {
          try { $pipe.Connect(2000) } catch { Start-Sleep -Milliseconds 500; continue }
          $state.connected = $true
          & $ComReadStream $pipe $deadline $lines $state
        } finally { $pipe.Dispose() }
      }
      @{ lines = @($lines); connected = $state.connected; complete = $state.stage; overflow = $state.over; stopped = $state.stopped }
    }
    'com-detach' {
      $vm = Get-OwnVm $a
      Set-VMComPort -VM $vm -Number 1 -Path ''
      @{ path = [string](Get-VMComPort -VM $vm -Number 1).Path }
    }
    'vhd-convert' {
      # MC-1501: the helper's own VHD (from a verified qcow2 image) to the base VHDX, with Hyper-V's own cmdlet.
      if (-not (& $ConvertPathsOk ([string]$a.vhd) ([string]$a.vhdx))) { throw 'bad conversion paths' }
      if (Test-Path -LiteralPath ([string]$a.vhdx)) { throw 'the base VHDX already exists' }
      Convert-VHD -Path ([string]$a.vhd) -DestinationPath ([string]$a.vhdx) -VHDType Dynamic
      @{ vhdx = [string]$a.vhdx }
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
