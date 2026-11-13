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

# Runs one command inside the guest, as whichever guest account the session belongs to (its admin, or its standard user:
# see 'guest-run'), with
# stdout and stderr redirected to C:\out\.run-<n>.*; on a timeout, kills its process tree by PID. Fixed text: the
# command reaches the guest as data and is written to a script file there.
$GuestRun = {
  param($j)
  $ErrorActionPreference = 'Stop'
  $n = [int]$j.n
  $dir = 'C:\hvmcp'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $base = "C:\out\.run-$n"
  $ext = if ($j.shell -eq 'powershell') { 'ps1' } else { 'cmd' }
  $script = "$dir\run-$n.$ext"
  [IO.File]::WriteAllText($script, [string]$j.command, (New-Object Text.UTF8Encoding $false))
  $inner = if ($ext -eq 'ps1') { "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`"" } else { "cmd.exe /d /c `"$script`"" }
  $wrapper = "$dir\wrap-$n.cmd"
  # The exit code is written with the redirection first: "echo 0> file" would redirect handle 0 (cmd treats a digit
  # before > as a handle number) and leave the file empty.
  [IO.File]::WriteAllText($wrapper, "@echo off`r`ncd /d `"$($j.cwd)`" 2>nul`r`n$inner > `"$base.stdout.txt`" 2> `"$base.stderr.txt`"`r`n> `"$base.exit`" echo %ERRORLEVEL%`r`n", (New-Object Text.ASCIIEncoding))
  Remove-Item "$base.exit" -ErrorAction SilentlyContinue
  $exitCode = {
    try { $t = [IO.File]::ReadAllText("$base.exit").Trim() } catch { return $null }
    if ($t -match '^-?\d{1,10}$') { return [int]$t } else { return $null }
  }
  $timedOut = $false; $killed = $false; $procId = $null
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /c `"$wrapper`"" -PassThru -WindowStyle Hidden
  $procId = $p.Id
  if (-not $p.WaitForExit([int]$j.timeoutSec * 1000)) {
    $timedOut = $true
    # Through cmd, so taskkill's own messages can't become PowerShell errors; killed only once the process is gone.
    & cmd.exe /d /c "taskkill /T /F /PID $procId >nul 2>&1"
    $killed = $p.WaitForExit(10000)
  }
  $read = {
    param($f)
    if (-not (Test-Path -LiteralPath $f)) { return @('', $false) }
    $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite')
    try { $len = [Math]::Min($fs.Length, [long]$j.cap); $b = New-Object byte[] $len; [void]$fs.Read($b, 0, $len); return @([Text.Encoding]::UTF8.GetString($b), ($fs.Length -gt $len)) } finally { $fs.Close() }
  }
  $o = & $read "$base.stdout.txt"; $e = & $read "$base.stderr.txt"
  $code = & $exitCode
  @{ exitCode = $code; timedOut = $timedOut; killed = $killed; stdout = $o[0]; stdoutCut = $o[1]; stderr = $e[0]; stderrCut = $e[1] }
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
    'guest-run' {
      $vm = Get-OwnVm $a
      $j = @{ n = [int]$a.n; command = [string]$a.command; shell = [string]$a.shell; cwd = [string]$a.cwd; timeoutSec = [int]$a.timeoutSec; cap = [int]$a.cap }
      $as = Cred $a.cred
      if ($a.runAs) {
        # As the guest's standard user: its own PowerShell Direct session, which (like any remote session) needs the
        # account in Remote Management Users (S-1-5-32-580). Added here, as the guest's admin, inside this disposable guest
        # only; a restore takes it away again.
        $user = [string]$a.runAs.user
        Invoke-Command -VMId $vm.Id -Credential $as -ScriptBlock {
          param($u)
          if (-not (Get-LocalGroupMember -SID 'S-1-5-32-580' | Where-Object { $_.Name -like "*\$u" })) { Add-LocalGroupMember -SID 'S-1-5-32-580' -Member $u }
        } -ArgumentList $user
        $as = Cred $a.runAs
      }
      Invoke-Command -VMId $vm.Id -Credential $as -ScriptBlock $GuestRun -ArgumentList $j
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
