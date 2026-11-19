# Exercises setup\acl.ps1 non-elevated, in a temp folder ($Dir): pre-existing explicit grants to Users are removed from
# a folder and everything already in it; -ChildKeep keeps Hyper-V's per-VM grants and removes the rest; links in a
# folder, or as an ancestor of it, are refused before anything changes. Prints one JSON line of results for
# test\units.test.js. (No -SetOwner: setting the owner to Administrators needs elevation; the real setup does that.)
param([Parameter(Mandatory = $true)][string]$Dir)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\setup\acl.ps1')
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$SYSTEM = 'S-1-5-18'; $USERS = 'S-1-5-32-545'; $VM = 'S-1-5-83-1-111-222-333-444'
$r = [ordered]@{}
function Has($path, $sid) { [bool](@((Get-Acl -LiteralPath $path).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) | Where-Object { $_.IdentityReference.Value -eq $sid }) }

# 1. Users:Modify granted beforehand on the folder and on a file and a subfolder already in it.
$a = Join-Path $Dir 'a'; New-Item -ItemType Directory -Force (Join-Path $a 'sub') | Out-Null
Set-Content (Join-Path $a 'file.txt') 'x'; Set-Content (Join-Path $a 'sub\deep.txt') 'y'
& icacls.exe $a /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
& icacls.exe (Join-Path $a 'file.txt') /grant '*S-1-5-32-545:M' | Out-Null
& icacls.exe (Join-Path $a 'sub\deep.txt') /grant '*S-1-5-32-545:M' | Out-Null
$r.usersBefore = (Has $a $USERS) -and (Has (Join-Path $a 'file.txt') $USERS)
Set-ExclusiveAcl $a @("$SYSTEM=FullControl", "$me=FullControl")
$r.usersAfter = @($a, (Join-Path $a 'file.txt'), (Join-Path $a 'sub'), (Join-Path $a 'sub\deep.txt')) | Where-Object { Has $_ $USERS }
$r.problems = @(Test-ExclusiveAcl $a -Allowed $SYSTEM, $me)
$r.protected = (Get-Acl -LiteralPath $a).AreAccessRulesProtected
# Test-ExclusiveAcl notices a grant added afterwards.
& icacls.exe (Join-Path $a 'file.txt') /grant '*S-1-5-32-545:M' | Out-Null
$r.detected = @(Test-ExclusiveAcl $a -Allowed $SYSTEM, $me).Count -gt 0

# 2. -ChildKeep: a VM's own grant stays on its file; Users' goes.
$b = Join-Path $Dir 'b'; New-Item -ItemType Directory -Force $b | Out-Null
$vhd = Join-Path $b 'disk.vhdx'; Set-Content $vhd 'v'
$acl = Get-Acl -LiteralPath $vhd # icacls won't grant an unmapped SID such as this made-up VM's; Set-Acl will
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $VM), 'FullControl', 'Allow')))
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $USERS), 'Modify', 'Allow')))
Set-Acl -LiteralPath $vhd -AclObject $acl
$r.vhdBefore = (Has $vhd $VM) -and (Has $vhd $USERS)
Set-ExclusiveAcl $b @("$SYSTEM=FullControl", "$me=FullControl") -ChildKeep '^S-1-5-83-'
$r.vmKept = Has $vhd $VM
$r.usersOnVhd = Has $vhd $USERS
$r.vmProblems = @(Test-ExclusiveAcl $b -Allowed $SYSTEM, $me -AllowPattern '^S-1-5-83-')

# 3. Links: inside the folder, and as an ancestor of it. Refused, and nothing changed.
$c = Join-Path $Dir 'c'; New-Item -ItemType Directory -Force $c | Out-Null
$target = Join-Path $Dir 'target'; New-Item -ItemType Directory -Force $target | Out-Null
& cmd.exe /c mklink /J (Join-Path $c 'jump') $target | Out-Null
& icacls.exe $c /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
try { Set-ExclusiveAcl $c @("$SYSTEM=FullControl", "$me=FullControl"); $r.innerLink = 'accepted' } catch { $r.innerLink = $_.Exception.Message }
$r.innerUnchanged = Has $c $USERS
$via = Join-Path $Dir 'via'
& cmd.exe /c mklink /J $via $target | Out-Null
try { Set-ExclusiveAcl (Join-Path $via 'x') @("$SYSTEM=FullControl"); $r.ancestorLink = 'accepted' } catch { $r.ancestorLink = $_.Exception.Message }
$r.ancestorUnchanged = -not (Test-Path (Join-Path $target 'x'))


# 4. Trusted storage (design MC-1488/s52), through setup's own routines: Open-TrustedAncestors, Open-ReceiptKey,
# Use-StorageFolder, Write-SecureFile. Non-elevated, so this user stands in for Administrators (owner and trusted
# principal) and the receipts key lives under HKCU; setup uses HKLM and Administrators.
$base = Join-Path $Dir 'storage'; New-Item -ItemType Directory -Force $base | Out-Null
$trusted = @($SYSTEM, 'S-1-5-32-544', $script:TrustedInstaller, $me)
$grants = @("$SYSTEM=FullControl", "$me=FullControl")
$keyName = "Software\hyperv-mcp-test-$([guid]::NewGuid().ToString('n'))\Storage"
$pins = New-Object Collections.ArrayList
$receipts = $null
try {
  Open-TrustedAncestors (Join-Path $base 'x') $trusted $pins
  $r.ancestorsOk = $pins.Count -gt 0
  $receipts = Open-ReceiptKey ([Microsoft.Win32.Registry]::CurrentUser) $keyName $trusted $me
  $use = { param($p, $hook) Use-StorageFolder $p $grants $me $receipts -Allowed $trusted -Owners $trusted -Pins $pins -BeforeCreate $hook }

  # Created with its final security, and trusted by its receipt on the next run (unchanged).
  $new = Join-Path $base 'new'
  $r.created = & $use $new $null
  $sddl1 = (Get-Acl -LiteralPath $new).GetSecurityDescriptorSddlForm('Owner, Access')
  $r.createdProtected = (Get-Acl -LiteralPath $new).AreAccessRulesProtected
  $r.createdUsers = Has $new $USERS
  $r.receipt = [bool]$receipts.GetValue($new.ToLowerInvariant())
  Set-Content (Join-Path $new 'journal.jsonl') '{}'
  $r.again = & $use $new $null
  $r.againUnchanged = (Get-Acl -LiteralPath $new).GetSecurityDescriptorSddlForm('Owner, Access') -eq $sddl1

  # A disk folder as Hyper-V leaves it (measured on a real pool): its files granted to the Virtual Machines group, a VM's
  # own account and Hyper-V's capability SID. Trusted with $HyperVGrantees; a Users grant on top is still refused.
  $disk = Join-Path $base 'disk'
  [void](Use-StorageFolder $disk $grants $me $receipts -Allowed $trusted -Owners $trusted -AllowPattern $script:HyperVGrantees -Pins $pins)
  $vhdx = Join-Path $disk 'disk.vhdx'; Set-Content $vhdx 'v'
  $acl = Get-Acl -LiteralPath $vhdx
  foreach ($g in @('S-1-15-3-1024-2268835264-3721307629-241982045-173645152-1490879176-104643441-2915960892-1612460704', 'S-1-5-83-0', 'S-1-5-83-1-1377819372-1242569354-2268980144-1388075343')) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $g), 'FullControl', 'Allow')))
  }
  Set-Acl -LiteralPath $vhdx -AclObject $acl
  $r.hyperVGrants = & { try { Use-StorageFolder $disk $grants $me $receipts -Allowed $trusted -Owners $trusted -AllowPattern $script:HyperVGrantees -Pins $pins } catch { $_.Exception.Message } }
  $acl = Get-Acl -LiteralPath $vhdx
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $USERS), 'Modify', 'Allow')))
  Set-Acl -LiteralPath $vhdx -AclObject $acl
  $r.hyperVPlusUsers = & { try { Use-StorageFolder $disk $grants $me $receipts -Allowed $trusted -Owners $trusted -AllowPattern $script:HyperVGrantees -Pins $pins } catch { $_.Exception.Message } }
  # MC-1581: without -WriteRepair (the state folder's case), write access by another account is still refused, even
  # when the admin would agree to a removal.
  $r.writeWithYes = & { try { Use-StorageFolder $disk $grants $me $receipts -Allowed $trusted -Owners $trusted -AllowPattern $script:HyperVGrantees -Pins $pins -Confirm { $true } } catch { $_.Exception.Message } }

  # MC-1581 (Darren's decision B): a disk folder (-WriteRepair) after Explorer's "Continue", which gives the user Full
  # Control of it and everything in it (KB 950934): shown as able to write, removed only on a yes, Hyper-V's own grants
  # kept, then trusted again.
  $dx = Join-Path $base 'disk-explored'
  [void](Use-StorageFolder $dx $grants $me $receipts -Allowed $trusted -Owners $trusted -AllowPattern $script:HyperVGrantees -Pins $pins)
  $dvhd = Join-Path $dx 'pool\disk.vhdx'
  New-Item -ItemType Directory -Force (Split-Path $dvhd) | Out-Null; Set-Content $dvhd 'v'
  & icacls.exe $dvhd /grant '*S-1-5-83-0:(F)' /Q | Out-Null
  & icacls.exe $dx /grant "*${USERS}:(OI)(CI)F" /Q | Out-Null
  $useDisk = { param($c) Use-StorageFolder $dx $grants $me $receipts -Allowed $trusted -Owners $trusted -AllowPattern $script:HyperVGrantees -Pins $pins -WriteRepair -Confirm $c }
  $r.diskWriterNoQuestion = & { try { & $useDisk $null } catch { $_.Exception.Message } }
  $script:shownW = $null
  $r.diskWriterNo = & { try { & $useDisk { param($p, $x) $script:shownW = $x; $false } } catch { $_.Exception.Message } }
  $r.diskWriterShown = @($script:shownW | ForEach-Object { [ordered]@{ sid = $_.sid; write = $_.write } })
  $r.diskWriterKeptOnNo = Has $dvhd $USERS
  $r.diskWriterYes = & { try { & $useDisk { $true } } catch { $_.Exception.Message } }
  $r.diskWriterGone = -not ((Has $dx $USERS) -or (Has $dvhd $USERS))
  $r.diskHyperVKept = Has $dvhd 'S-1-5-83-0'
  $r.diskWriterAfter = & { try { & $useDisk $null } catch { $_.Exception.Message } }

  # MC-1581: an extra account's read-only grant (as Explorer's "Continue" adds: inherited by everything in it) on a
  # folder whose identity matches its receipt: shown, and removed only when the admin agrees; then trusted again.
  $exp = Join-Path $base 'explored'
  [void](& $use $exp $null)
  New-Item -ItemType Directory -Force (Join-Path $exp 'pool') | Out-Null
  Set-Content (Join-Path $exp 'pool\disk.vhdx') 'v'
  & icacls.exe $exp /grant "*${USERS}:(OI)(CI)RX" /Q | Out-Null
  $r.readerBefore = (Has $exp $USERS) -and (Has (Join-Path $exp 'pool\disk.vhdx') $USERS)
  $r.readerNoQuestion = & { try { Use-StorageFolder $exp $grants $me $receipts -Allowed $trusted -Owners $trusted -Pins $pins } catch { $_.Exception.Message } }
  $script:shown = $null
  $r.readerNo = & { try { Use-StorageFolder $exp $grants $me $receipts -Allowed $trusted -Owners $trusted -Pins $pins -Confirm { param($p, $rd) $script:shown = $rd; $false } } catch { $_.Exception.Message } }
  $r.readerKeptOnNo = Has $exp $USERS
  $r.readerShown = @($script:shown | ForEach-Object { [ordered]@{ sid = $_.sid; rights = ($_.rights -join ','); where = $_.where } })
  $r.readerYes = & { try { Use-StorageFolder $exp $grants $me $receipts -Allowed $trusted -Owners $trusted -Pins $pins -Confirm { $true } } catch { $_.Exception.Message } }
  $r.readerGone = -not ((Has $exp $USERS) -or (Has (Join-Path $exp 'pool') $USERS) -or (Has (Join-Path $exp 'pool\disk.vhdx') $USERS))
  $r.readerAfter = & $use $exp $null
  $r.readerDataKept = (Get-Content -LiteralPath (Join-Path $exp 'pool\disk.vhdx') -Raw).Trim() -eq 'v'

  # MC-1581: uninstall's teardown lets a read-only grant through (a reader can't have changed anything), not a write one.
  . (Join-Path $PSScriptRoot '..\setup\teardown.ps1')
  & icacls.exe $exp /grant "*${USERS}:(OI)(CI)RX" /Q | Out-Null
  $tp = New-Object Collections.ArrayList
  try { $r.teardownReader = [bool](Test-Target $exp $trusted $trusted $tp $null) } catch { $r.teardownReader = $_.Exception.Message } finally { Close-Pins $tp }
  & icacls.exe $exp /grant "*${USERS}:(W)" /Q | Out-Null
  try { $r.teardownWriter = [bool](Test-Target $exp $trusted $trusted $tp $null) } catch { $r.teardownWriter = $_.Exception.Message } finally { Close-Pins $tp }

  # The injected boundary: after setup found the path missing, someone creates it first and plants a forged journal.
  $race = Join-Path $base 'race'
  $forged = '{"t":"switch","phase":"removing","name":"foreign-internal","switchId":"foreign-switch-id"}'
  $hook = { param($p) New-Item -ItemType Directory $p | Out-Null; Set-Content -LiteralPath (Join-Path $p 'journal.jsonl') -Value $forged -NoNewline }
  try { & $use $race $hook; $r.race = 'accepted' } catch { $r.race = $_.Exception.Message }
  $r.raceForgedUntouched = (Get-Content -LiteralPath (Join-Path $race 'journal.jsonl') -Raw) -eq $forged
  $r.raceNoReceipt = $null -eq $receipts.GetValue($race.ToLowerInvariant())

  # Legacy: secured as an older setup did (exclusive ACL, contents), but no receipt.
  $legacy = Join-Path $base 'legacy'
  Set-ExclusiveAcl $legacy $grants
  Set-Content (Join-Path $legacy 'journal.jsonl') '{}'
  try { & $use $legacy $null; $r.legacy = 'accepted' } catch { $r.legacy = $_.Exception.Message }

  # An interrupted creation: made securely, but its receipt never written. Fails closed.
  $cut = Join-Path $base 'interrupted'
  $sec = New-Object Security.AccessControl.DirectorySecurity; $sec.SetAccessRuleProtection($true, $false)
  $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $me), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
  $sec.SetOwner((New-Object Security.Principal.SecurityIdentifier $me))
  $r.rawCreate = [HvMcpStorage]::CreateSecure($cut, $sec.GetSecurityDescriptorBinaryForm())
  $r.rawCreateAgain = [HvMcpStorage]::CreateSecure($cut, $sec.GetSecurityDescriptorBinaryForm()) # exists: false, never reused
  try { & $use $cut $null; $r.interrupted = 'accepted' } catch { $r.interrupted = $_.Exception.Message }

  # A receipt for a folder that was deleted and made again (same path, another identity).
  $swap = Join-Path $base 'swap'
  [void](& $use $swap $null)
  Close-Pins $pins # release the pin on it, to let it be deleted (as nothing could while setup ran)
  Remove-Item -LiteralPath $swap -Recurse -Force
  [void][HvMcpStorage]::CreateSecure($swap, $sec.GetSecurityDescriptorBinaryForm())
  try { & $use $swap $null; $r.swap = 'accepted' } catch { $r.swap = $_.Exception.Message }

  # A file with its final ACL from the start, renamed over the old one.
  $pf = Join-Path $new 'policy.json'
  Set-Content $pf 'old'
  & icacls.exe $pf /grant '*S-1-5-32-545:M' | Out-Null
  Write-SecureFile $pf '{"schema":1}' @("$SYSTEM=FullControl", "$me=ReadAndExecute") $me
  $r.fileText = [IO.File]::ReadAllText($pf)
  $r.fileUsers = Has $pf $USERS
  $r.fileProtected = (Get-Acl -LiteralPath $pf).AreAccessRulesProtected
  $r.fileTemps = @(Get-ChildItem -LiteralPath $new -Filter 'policy.json.new-*').Count
} finally {
  Close-Pins $pins
  if ($receipts) { $receipts.Dispose() }
}

# Parents: one granting Users DeleteChild is refused; one that is a junction is refused; a pinned one can't be renamed.
$weak = Join-Path $base 'weak'; New-Item -ItemType Directory -Force $weak | Out-Null
$acl = Get-Acl -LiteralPath $weak
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $USERS), 'DeleteSubdirectoriesAndFiles', 'Allow')))
Set-Acl -LiteralPath $weak -AclObject $acl
$p2 = New-Object Collections.ArrayList
try { Open-TrustedAncestors (Join-Path $weak 'x') $trusted $p2; $r.weakParent = 'accepted' } catch { $r.weakParent = $_.Exception.Message } finally { Close-Pins $p2 }
$jt = Join-Path $base 'jtarget'; New-Item -ItemType Directory -Force $jt | Out-Null
$jn = Join-Path $base 'jn'; & cmd.exe /c mklink /J $jn $jt | Out-Null
try { Open-TrustedAncestors (Join-Path $jn 'x') $trusted $p2; $r.junctionParent = 'accepted' } catch { $r.junctionParent = $_.Exception.Message } finally { Close-Pins $p2 }
$pin = Join-Path $base 'pinme'; New-Item -ItemType Directory -Force $pin | Out-Null
Open-TrustedAncestors (Join-Path $pin 'child') $trusted $p2
try { [IO.Directory]::Move($pin, "$pin-moved"); $r.pinnedRename = 'moved' } catch { $r.pinnedRename = $_.Exception.GetType().Name }
Close-Pins $p2
try { [IO.Directory]::Move($pin, "$pin-moved"); $r.unpinnedRename = 'moved' } catch { $r.unpinnedRename = $_.Exception.Message }

# A receipts key that lets Users write it is refused.
$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyName, $true)
$ks = $k.GetAccessControl()
$ks.AddAccessRule((New-Object Security.AccessControl.RegistryAccessRule((New-Object Security.Principal.SecurityIdentifier $USERS), 'SetValue', 'Allow')))
$k.SetAccessControl($ks); $k.Dispose()
try { $kk = Open-ReceiptKey ([Microsoft.Win32.Registry]::CurrentUser) $keyName $trusted $me; $kk.Dispose(); $r.weakKey = 'accepted' } catch { $r.weakKey = $_.Exception.Message }
[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($keyName.Substring(0, $keyName.LastIndexOf('\')), $false)

[Console]::Out.WriteLine('RESULT:' + (ConvertTo-Json $r -Compress -Depth 4))
