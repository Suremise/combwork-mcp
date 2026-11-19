# Storage and ACL helpers for setup (dot-sourced by install.ps1; tested non-elevated by test\acl-check.ps1 through
# test\units.test.js, on temp folders).
#
#   Set-ExclusiveAcl builds a folder's DACL from scratch (protected: nothing inherited from above; exactly the given
#   grants; with -SetOwner, owned by Administrators), then resets every existing child to inherit only that DACL. Setup
#   uses it only for %ProgramFiles%\hyperv-mcp, whose contents it replaces entirely (never trusts). icacls /grant:r would
#   not do: it replaces only the named trustees' grants and leaves any other explicit grant in place.
#   Test-ExclusiveAcl lists every grant on a folder and everything under it whose SID isn't allowed (and, with -Owners,
#   every owner that isn't).
#   The trusted-storage routines below (Use-StorageFolder and the rest) hold what the helper trusts.

function Assert-NoReparse([string]$Path) {
  $p = [IO.Path]::GetFullPath($Path)
  while ($p) {
    if (Test-Path -LiteralPath $p) {
      if ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "$p is a link or junction: refusing to trust or change $Path through it." }
    }
    $parent = [IO.Path]::GetDirectoryName($p)
    if ($parent -eq $p) { break }
    $p = $parent
  }
  if (Test-Path -LiteralPath $Path -PathType Container) {
    $links = @(Get-ChildItem -LiteralPath $Path -Recurse -Force -Attributes ReparsePoint -ErrorAction Stop)
    if ($links.Count) { throw "$Path holds links or junctions ($($links[0].FullName)): remove them, then run setup again." }
  }
}

# $Grants: 'SID=Rights' strings, e.g. 'S-1-5-18=FullControl', 'S-1-5-32-545=ReadAndExecute'. Inherited by subfolders
# and files. Children are reset to inherit only (icacls /reset), unless -ChildKeep is given: then each child keeps its
# inheritance and only its explicit grants whose SID matches -ChildKeep (a regex) or is one of $Grants' SIDs; every
# other explicit grant is removed. Disk folders need that: Hyper-V grants each VM's own SID (S-1-5-83-1-...) access to
# its files, and a VM can't start without it.
function Set-ExclusiveAcl([string]$Path, [string[]]$Grants, [switch]$SetOwner, [string]$ChildKeep) {
  Assert-NoReparse $Path
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $sec = New-Object Security.AccessControl.DirectorySecurity
  $sec.SetAccessRuleProtection($true, $false)
  foreach ($g in $Grants) {
    $sid, $rights = $g.Split('=', 2)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), [Security.AccessControl.FileSystemRights]$rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $sec.AddAccessRule($rule)
  }
  if ($SetOwner) { $sec.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544')) }
  Set-Acl -LiteralPath $Path -AclObject $sec
  if (@(Get-ChildItem -LiteralPath $Path -Force).Count) {
    if ($ChildKeep) {
      $grantSids = @($Grants | ForEach-Object { $_.Split('=', 2)[0] })
      foreach ($c in Get-ChildItem -LiteralPath $Path -Recurse -Force) {
        $acl = Get-Acl -LiteralPath $c.FullName
        $changed = $false
        if ($acl.AreAccessRulesProtected) { $acl.SetAccessRuleProtection($false, $false); $changed = $true }
        foreach ($ace in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
          $sid = $ace.IdentityReference.Value
          if ($grantSids -contains $sid -or $sid -match $ChildKeep) { continue }
          [void]$acl.RemoveAccessRuleSpecific($ace); $changed = $true
        }
        if ($changed) { Set-Acl -LiteralPath $c.FullName -AclObject $acl }
      }
    } else {
      $o = & icacls.exe (Join-Path $Path '*') /reset /T /C /Q 2>&1
      if ($LASTEXITCODE -ne 0) { throw "resetting the ACLs under $Path failed: $o" }
    }
    if ($SetOwner) {
      $o = & icacls.exe (Join-Path $Path '*') /setowner '*S-1-5-32-544' /T /C /Q 2>&1
      if ($LASTEXITCODE -ne 0) { throw "setting the owner under $Path failed: $o" }
    }
  }
}


# Problems: every Allow grant on $Path or anything under it whose SID isn't in $Allowed (or, for $Writers, any write
# right held by a SID not in $Writers), and every owner not in $Owners. Empty when the folder is as setup made it.
# -IgnoreReadOnly (MC-1581): a grant to a SID not in $Allowed that holds no write right (Explorer's "Continue" adds one
# for the user) isn't counted here: Get-ExtraReaders lists those, for the caller to show and remove.
$script:WriteMask = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
function Test-ExclusiveAcl([string]$Path, [string[]]$Allowed, [string[]]$Writers = $Allowed, [string[]]$Owners, [string]$AllowPattern, [switch]$IgnoreReadOnly) {
  $writeMask = $script:WriteMask
  $out = @()
  $items = @(Get-Item -LiteralPath $Path -Force) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction Stop)
  foreach ($i in $items) {
    if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { $out += "$($i.FullName) is a link"; continue }
    $acl = Get-Acl -LiteralPath $i.FullName
    foreach ($ace in $acl.Access) {
      if ($ace.AccessControlType -ne 'Allow') { continue }
      $sid = try { $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $ace.IdentityReference.Value }
      if ($sid -eq 'S-1-3-0') { continue } # CREATOR OWNER: applies to whoever creates a child, who must already be allowed
      if ($AllowPattern -and $sid -match $AllowPattern) { continue } # e.g. Hyper-V's per-VM SIDs on a VM's own files
      if ($Allowed -notcontains $sid) {
        if ($IgnoreReadOnly -and -not ([int64]$ace.FileSystemRights -band $writeMask)) { continue }
        $out += "$($i.FullName): $($ace.IdentityReference) has $($ace.FileSystemRights)"
      }
      elseif (([int64]$ace.FileSystemRights -band $writeMask) -and $Writers -notcontains $sid) { $out += "$($i.FullName): $($ace.IdentityReference) can write" }
    }
    if ($Owners) {
      $owner = try { (New-Object Security.Principal.NTAccount $acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $acl.Owner }
      if ($Owners -notcontains $owner -and -not ($AllowPattern -and $owner -match $AllowPattern)) { $out += "$($i.FullName) is owned by $($acl.Owner)" }
    }
  }
  return $out
}

# MC-1581: the read-only grants on $Path and everything under it to SIDs outside $Allowed (and $AllowPattern): one entry
# per SID, { sid, name, rights (each distinct), where (how many items carry it), first (one of them) }. A grant with any
# write right isn't listed (Test-ExclusiveAcl refuses it).
function Get-ExtraReaders([string]$Path, [string[]]$Allowed, [string]$AllowPattern) {
  $by = [ordered]@{}
  $items = @(Get-Item -LiteralPath $Path -Force) + @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction Stop)
  foreach ($i in $items) {
    if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    foreach ($ace in (Get-Acl -LiteralPath $i.FullName).Access) {
      if ($ace.AccessControlType -ne 'Allow') { continue }
      $sid = try { $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $ace.IdentityReference.Value }
      if ($sid -eq 'S-1-3-0' -or $Allowed -contains $sid -or ($AllowPattern -and $sid -match $AllowPattern)) { continue }
      if ([int64]$ace.FileSystemRights -band $script:WriteMask) { continue }
      if (-not $by.Contains($sid)) { $by[$sid] = [pscustomobject]@{ sid = $sid; name = [string]$ace.IdentityReference; rights = @(); where = 0; first = $i.FullName } }
      $e = $by[$sid]
      if ($e.rights -notcontains [string]$ace.FileSystemRights) { $e.rights += [string]$ace.FileSystemRights }
      $e.where++
    }
  }
  return @($by.Values)
}

# MC-1581: removes $Sids' grants from $Path and everything under it (icacls /remove:g, explicit ones on each item; the
# inherited copies go with the folder's own). Only after the caller has shown them and the admin has agreed.
function Remove-ExtraReaders([string]$Path, [string[]]$Sids) {
  foreach ($sid in $Sids) {
    $o = & icacls.exe $Path /remove:g "*$sid" /T /C /Q 2>&1
    if ($LASTEXITCODE -ne 0) { throw "removing $sid's grant from $Path failed: $o" }
  }
}

# ---------- trusted storage (design MC-1488/s52) ----------
#
# The state folder, its approvals\ and the disk folders hold what the helper trusts (journal, plans, approvals, secrets,
# verified images). Setup never changes the owner or ACL of any of them once they exist (MC-1581's one exception: an
# extra account's read-only grant, removed when the admin agrees after seeing it), and trusts one only if:
#   - it created it itself, with CreateDirectoryW and its final security descriptor in that one call (so nobody else could
#     ever write there or hold a handle into it), and recorded a receipt of its identity (volume serial + file id) in a
#     registry key only Administrators and SYSTEM can write; or
#   - it exists, and its receipt matches its identity, and it and everything in it still have only the allowed owners and
#     grants.
# Anything else (no receipt: made by someone else, by an older setup, or a creation interrupted before its receipt;
# another identity; a failed check) is refused untouched. Every ancestor is checked first, through handles that also pin
# it (no one can rename, delete or replace it while setup runs), and refused if anyone but a trusted principal could
# replace what is under it. Setup changes no parent's permissions.

if (-not ('HvMcpStorage' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'Storage.cs') }

# What Hyper-V itself grants on a pool's files, measured on a real pool (MC-1488 trial): the Virtual Machines group
# (S-1-5-83-0), each VM's own account (S-1-5-83-1-..., which can also own a file), and a capability SID
# (S-1-15-3-1024-2268835264-..., FullControl, set on the VM folders and inherited). A grant to a capability SID (S-1-15-3-)
# only ever matches an AppContainer process holding that capability, and Windows then also requires the process's own
# user or groups to be granted: it can't give access to anyone who isn't already granted it. So these are accepted in
# disk folders; any other grantee is not.
$script:HyperVGrantees = '^S-1-5-83-|^S-1-15-3-'

$script:TrustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
# Rights on an ancestor that would let their holder replace what is under it: DELETE_CHILD, DELETE (the ancestor itself
# can be renamed away; ignored on a volume root, which can't be), WRITE_DAC, WRITE_OWNER, GENERIC_ALL. GENERIC_WRITE maps
# to FILE_GENERIC_WRITE (add files and folders, write attributes): none of these.
$script:ReplaceRights = 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000

function Get-HandleSecurity($Handle) {
  $s = New-Object Security.AccessControl.DirectorySecurity
  $s.SetSecurityDescriptorBinaryForm([HvMcpStorage]::SecurityBytes($Handle))
  return $s
}

function Get-OwnerSid($Security) { return $Security.GetOwner([Security.Principal.SecurityIdentifier]).Value }

# Opens (pins) and checks every ancestor of $Path, from the volume root down to its parent. $Trusted: the SIDs that may
# own an ancestor or hold rights to replace what is under it. Adds each handle to $Pins (the caller disposes them).
function Open-TrustedAncestors([string]$Path, [string[]]$Trusted, [Collections.ArrayList]$Pins) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $chain = @()
  $p = [IO.Path]::GetDirectoryName($full)
  while ($p) { $chain = @($p) + $chain; $p = [IO.Path]::GetDirectoryName($p) }
  foreach ($a in $chain) {
    $h = [HvMcpStorage]::Open($a)
    [void]$Pins.Add($h)
    if ([HvMcpStorage]::Attributes($h) -band [HvMcpStorage]::FILE_ATTRIBUTE_REPARSE_POINT) { throw "$a is a link or junction: refusing to keep storage under it. Nothing was changed." }
    $sec = Get-HandleSecurity $h
    $owner = Get-OwnerSid $sec
    if ($Trusted -notcontains $owner) { throw "$a is owned by $owner, who could change who may replace what is under it. Setup changes no parent's permissions: choose a location under folders owned by Administrators, SYSTEM or TrustedInstaller. Nothing was changed." }
    $isRoot = [IO.Path]::GetPathRoot($a).TrimEnd('\') -eq $a.TrimEnd('\')
    foreach ($r in $sec.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
      if ($r.AccessControlType -ne 'Allow' -or $Trusted -contains $r.IdentityReference.Value) { continue }
      if ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue } # not on $a itself
      $mask = [int64]$r.FileSystemRights -band $script:ReplaceRights
      if ($isRoot) { $mask = $mask -band (-bnot 0x10000) }
      if ($mask) { throw ("{0}: {1} holds rights 0x{2:x} there, so they could replace what setup puts under it. Setup changes no parent's permissions: fix them, or choose another location. Nothing was changed." -f $a, $r.IdentityReference.Value, $mask) }
    }
  }
}

# Opens (creating it when missing, with this security) the receipts key and checks it: its owner and every grant that can
# write it must be in $Trusted. Production: HKLM\SOFTWARE\hyperv-mcp\Storage; the tests use a key under HKCU.
function Open-ReceiptKey([Microsoft.Win32.RegistryKey]$Root, [string]$SubKey, [string[]]$Trusted, [string]$OwnerSid) {
  $parentName = $SubKey.Substring(0, $SubKey.LastIndexOf('\'))
  $rs = New-Object Security.AccessControl.RegistrySecurity
  $rs.SetAccessRuleProtection($true, $false)
  foreach ($g in @('S-1-5-18', 'S-1-5-32-544', $OwnerSid) | Select-Object -Unique) {
    $rs.AddAccessRule((New-Object Security.AccessControl.RegistryAccessRule((New-Object Security.Principal.SecurityIdentifier $g), 'FullControl', 'ContainerInherit', 'None', 'Allow')))
  }
  $rs.AddAccessRule((New-Object Security.AccessControl.RegistryAccessRule((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-545'), 'ReadKey', 'ContainerInherit', 'None', 'Allow')))
  $rs.SetOwner((New-Object Security.Principal.SecurityIdentifier $OwnerSid))
  $parent = $Root.OpenSubKey($parentName, $true)
  if (-not $parent) { $parent = $Root.CreateSubKey($parentName, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $rs) }
  $key = $null
  try {
    $key = $parent.OpenSubKey('Storage', $true)
    if (-not $key) { $key = $parent.CreateSubKey('Storage', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree) }
    $writeMask = 0x2 -bor 0x4 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000 # SetValue, CreateSubKey, Delete, WRITE_DAC, WRITE_OWNER, GENERIC_ALL/WRITE
    foreach ($k in @($parent, $key)) {
      $sec = $k.GetAccessControl()
      $owner = $sec.GetOwner([Security.Principal.SecurityIdentifier]).Value
      $bad = @()
      if ($Trusted -notcontains $owner) { $bad += "owned by $owner" }
      foreach ($r in $sec.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($r.AccessControlType -eq 'Allow' -and $Trusted -notcontains $r.IdentityReference.Value -and ([int64]$r.RegistryRights -band $writeMask)) { $bad += "$($r.IdentityReference.Value) can write it" }
      }
      if ($bad.Count) { throw "The storage receipts key $($k.Name) isn't protected ($($bad -join '; ')): its receipts can't be trusted. Nothing was changed." }
    }
    $ok = $key; $key = $null
    return $ok
  } finally {
    if ($key) { $key.Dispose() }
    $parent.Dispose()
  }
}

# The one way setup gets a storage folder it may trust. Returns 'created' or 'trusted'; throws (refusing, unchanged)
# otherwise. Its ancestors must already be checked and pinned (Open-TrustedAncestors). $Grants: 'SID=Rights' for a new
# folder (inherited by everything in it), owned by $OwnerSid. $BeforeCreate: a test hook, run after setup found the path
# missing and before it creates it (the boundary where someone else could create it first).
function Use-StorageFolder {
  param([string]$Path, [string[]]$Grants, [string]$OwnerSid, [Microsoft.Win32.RegistryKey]$Receipts,
    [string[]]$Allowed, [string[]]$Writers, [string[]]$Owners, [string]$AllowPattern, [Collections.ArrayList]$Pins, [scriptblock]$BeforeCreate,
    [scriptblock]$Confirm)
  if (-not $Writers) { $Writers = $Allowed }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $name = $full.ToLowerInvariant()
  if (-not (Test-Path -LiteralPath $full)) {
    if ($BeforeCreate) { & $BeforeCreate $full }
    $sec = New-Object Security.AccessControl.DirectorySecurity
    $sec.SetAccessRuleProtection($true, $false)
    foreach ($g in $Grants) {
      $sid, $rights = $g.Split('=', 2)
      $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), [Security.AccessControl.FileSystemRights]$rights, 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    }
    $sec.SetOwner((New-Object Security.Principal.SecurityIdentifier $OwnerSid))
    if ([HvMcpStorage]::CreateSecure($full, $sec.GetSecurityDescriptorBinaryForm())) {
      $h = [HvMcpStorage]::Open($full)
      [void]$Pins.Add($h)
      $got = Get-HandleSecurity $h
      $want = $sec.GetSecurityDescriptorSddlForm('Owner, Access')
      if ($got.GetSecurityDescriptorSddlForm('Owner, Access') -ne $want) {
        throw "$full was created, but its security isn't what setup asked for ($($got.GetSecurityDescriptorSddlForm('Owner, Access'))). No receipt was written, so it won't be trusted: remove it and run setup again."
      }
      $Receipts.SetValue($name, [HvMcpStorage]::Identity($h))
      $Receipts.Flush()
      return 'created'
    }
    # It exists after all: someone made it after setup looked. Never fresh: it is judged as existing, below.
  }
  $h = [HvMcpStorage]::Open($full)
  [void]$Pins.Add($h)
  if ([HvMcpStorage]::Attributes($h) -band [HvMcpStorage]::FILE_ATTRIBUTE_REPARSE_POINT) { throw "$full is a link or junction: refused. Nothing was changed." }
  $receipt = $Receipts.GetValue($name)
  if (-not $receipt) {
    throw "$full exists, but setup has no receipt for it: it wasn't created by this setup (or its creation was interrupted), so its contents can't be trusted. Nothing was changed. Inspect it, then remove it (removing any pool recorded in it first) and run setup again."
  }
  if ($receipt -ne [HvMcpStorage]::Identity($h)) {
    throw "$full isn't the folder setup created (its identity differs from the receipt), so its contents can't be trusted. Nothing was changed."
  }
  $owner = Get-OwnerSid (Get-HandleSecurity $h)
  $bad = @(Test-ExclusiveAcl $full -Allowed $Allowed -Writers $Writers -Owners $Owners -AllowPattern $AllowPattern -IgnoreReadOnly)
  if ($Owners -notcontains $owner) { $bad = @("$full is owned by $owner") + $bad }
  if ($bad.Count) {
    throw "$full has its receipt, but its contents aren't as setup and the helper leave them ($($bad[0])$(if ($bad.Count -gt 1) { "; and $($bad.Count - 1) more" })). Nothing was changed."
  }
  # MC-1581: its identity matches and only setup's accounts can write it, but another account was given read access
  # (opening it in Explorer and clicking Continue does that). Nobody else could have changed what's in it, so it stays
  # trusted once that grant is gone: shown, then removed only if the admin agrees ($Confirm), and checked again.
  $readers = @(Get-ExtraReaders $full $Allowed $AllowPattern)
  if (-not $readers.Count) { return 'trusted' }
  if (-not $Confirm -or -not (& $Confirm $full $readers)) {
    throw "$full has its receipt, but $(@($readers | ForEach-Object { $_.name }) -join ', ') can read it, and the grant wasn't removed. Nothing was changed: run setup again and agree to remove it, or remove it yourself."
  }
  Remove-ExtraReaders $full @($readers | ForEach-Object { $_.sid })
  $bad = @(Test-ExclusiveAcl $full -Allowed $Allowed -Writers $Writers -Owners $Owners -AllowPattern $AllowPattern)
  if ($bad.Count) { throw "$full still isn't as setup leaves it after removing the extra read access ($($bad[0])). It won't be used." }
  return 'trusted (extra read access removed)'
}

# MC-1581: setup's question before Remove-ExtraReaders: the folder, each extra account and what it can do. True only
# when the admin types REMOVE.
function Confirm-RemoveReaders([string]$Path, $Readers) {
  Write-Host ''
  Write-Host "$Path is setup's own folder (its identity matches its receipt), and only setup's accounts can change it, but" -ForegroundColor Yellow
  Write-Host 'these accounts were also given read access (opening it in Explorer and clicking Continue does this):' -ForegroundColor Yellow
  foreach ($r in $Readers) { Write-Host "  $($r.name) ($($r.sid)): $($r.rights -join ', '), on $($r.where) item(s), e.g. $($r.first)" }
  Write-Host 'They could read what is in it while the grant was there, but not change it. Setup can remove that access and go on.'
  return ((Read-Host 'Type REMOVE to remove it (anything else stops, with nothing changed)') -ceq 'REMOVE')
}

# Writes a file with exactly this security from the moment it exists: a new file under a temporary name (CreateNew, with
# its security descriptor, through Storage.cs: the same call under Windows PowerShell 5.1 and PowerShell 7, MC-1575),
# then renamed over the old one, keeping its own security.
function Write-SecureFile([string]$Path, [string]$Text, [string[]]$Grants, [string]$OwnerSid) {
  $fs = New-Object Security.AccessControl.FileSecurity
  $fs.SetAccessRuleProtection($true, $false)
  foreach ($g in $Grants) {
    $sid, $rights = $g.Split('=', 2)
    $fs.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), [Security.AccessControl.FileSystemRights]$rights, 'Allow')))
  }
  $fs.SetOwner((New-Object Security.Principal.SecurityIdentifier $OwnerSid))
  $tmp = "$Path.new-$([guid]::NewGuid().ToString('n'))"
  $stream = [HvMcpStorage]::CreateSecureFile($tmp, $fs.GetSecurityDescriptorBinaryForm())
  try { $b = (New-Object Text.UTF8Encoding $false).GetBytes($Text); $stream.Write($b, 0, $b.Length) } finally { $stream.Dispose() }
  [HvMcpStorage]::RenameOver($tmp, $Path)
}

function Close-Pins([Collections.ArrayList]$Pins) { foreach ($h in $Pins) { try { $h.Dispose() } catch { } }; $Pins.Clear() }
