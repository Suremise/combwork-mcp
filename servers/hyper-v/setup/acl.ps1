# ACL helpers for setup (dot-sourced by install.ps1; tested non-elevated by test\units.test.js on temp folders).
#
# Setup must not merely add its grants: icacls /grant:r replaces only the named trustees' grants and leaves any other
# explicit grant in place, so a folder that existed before setup could stay writable to ordinary users. So:
#   Set-ExclusiveAcl builds the folder's DACL from scratch (protected: nothing inherited from above; exactly the given
#   grants; with -SetOwner, owned by Administrators), then resets every existing child to inherit only that DACL, with
#   no explicit grants of its own. It refuses a folder that is, or sits under, or contains a link/junction (reparse
#   point), before changing anything.
#   Test-ExclusiveAcl lists every grant on the folder and everything under it whose SID isn't allowed (and, with
#   -Owners, every owner that isn't). install.ps1 refuses to go on unless it lists none.

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

# Sets one file's ACL exactly: protected, the given grants only, owned by Administrators with -SetOwner.
function Set-ExclusiveFileAcl([string]$Path, [string[]]$Grants, [switch]$SetOwner) {
  Assert-NoReparse $Path
  $sec = New-Object Security.AccessControl.FileSecurity
  $sec.SetAccessRuleProtection($true, $false)
  foreach ($g in $Grants) {
    $sid, $rights = $g.Split('=', 2)
    $sec.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), [Security.AccessControl.FileSystemRights]$rights, 'Allow')))
  }
  if ($SetOwner) { $sec.SetOwner((New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544')) }
  Set-Acl -LiteralPath $Path -AclObject $sec
}

# Problems: every Allow grant on $Path or anything under it whose SID isn't in $Allowed (or, for $Writers, any write
# right held by a SID not in $Writers), and every owner not in $Owners. Empty when the folder is as setup made it.
function Test-ExclusiveAcl([string]$Path, [string[]]$Allowed, [string[]]$Writers = $Allowed, [string[]]$Owners, [string]$AllowPattern) {
  $writeMask = 0x2 -bor 0x4 -bor 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
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
      if ($Allowed -notcontains $sid) { $out += "$($i.FullName): $($ace.IdentityReference) has $($ace.FileSystemRights)" }
      elseif (([int64]$ace.FileSystemRights -band $writeMask) -and $Writers -notcontains $sid) { $out += "$($i.FullName): $($ace.IdentityReference) can write" }
    }
    if ($Owners) {
      $owner = try { (New-Object Security.Principal.NTAccount $acl.Owner).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $acl.Owner }
      if ($Owners -notcontains $owner -and -not ($AllowPattern -and $owner -match $AllowPattern)) { $out += "$($i.FullName) is owned by $($acl.Owner)" }
    }
  }
  return $out
}

# Before setup changes anything: an existing folder whose contents the helper will trust (its journal, plans, approvals,
# secrets, verified images) must already be as setup leaves it. That's the only proof its bytes were written by setup or
# the helper, and not by someone who could write there before. Repairing its ACL would make forged contents look
# trusted, so a folder that fails is refused untouched. A folder that is missing, or exists but is empty, has no
# contents to trust: it is 'fresh', and setup may create or harden it. Returns 'fresh' or 'trusted'; throws otherwise.
function Assert-TrustedOrFresh([string]$Path, [string[]]$Allowed, [string[]]$Writers = $Allowed, [string[]]$Owners, [string]$AllowPattern) {
  Assert-NoReparse $Path
  if (-not (Test-Path -LiteralPath $Path)) { return 'fresh' }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Path exists but isn't a folder: move it aside, then run setup again." }
  if (-not @(Get-ChildItem -LiteralPath $Path -Force).Count) { return 'fresh' }
  $bad = @(Test-ExclusiveAcl $Path -Allowed $Allowed -Writers $Writers -Owners $Owners -AllowPattern $AllowPattern)
  if ($bad.Count) {
    throw "$Path already exists with contents setup didn't secure, so they can't be trusted ($($bad[0])$(if ($bad.Count -gt 1) { "; and $($bad.Count - 1) more" })). Nothing was changed. If it isn't yours, inspect it; then move it aside (any pool recorded in it can't be trusted) and run setup again."
  }
  return 'trusted'
}
