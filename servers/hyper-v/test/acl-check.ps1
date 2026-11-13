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

[Console]::Out.WriteLine('RESULT:' + (ConvertTo-Json $r -Compress -Depth 4))
