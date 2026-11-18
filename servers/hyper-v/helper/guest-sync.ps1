# The guest side of vm_sync (design MC-1497/s9): run inside the guest over PowerShell Direct by hv.ps1's 'sync-in', as a
# script block made from this fixed file; its input is one object of data. Windows PowerShell 5.1, .NET only. Tests run
# it on host temp trees (root and stage are parameters), so its path checks are proved on a real file system.
#
# $j.action:
#   prepare: makes $j.stage a fresh, empty folder (its parent must be a real folder, not a link or junction), and
#            $j.parts too when given; other sync-<n> stages beside it (left by a failed or cancelled copy) are removed.
#   append:  MC-1558: each item { rel, part, offset, length } of $j.items: the part file (in $j.parts) is appended to the
#            file rel in the stage, only at that file's committed length. Each append is recorded first: a mark (in
#            $j.parts\marks, named by the path's hash) holds the length it starts from, and goes once the append is done.
#            A mark left by an interrupted append rolls the file back to that length before anything else, so a part is
#            never half-there: a file already past the part's end is skipped (a killed call's item it had finished), a
#            file at the part's offset gets it, any other length is refused. Folders are made one level at a time, never
#            through a link. Returns { appended, skipped }.
#   lengths: MC-1558: { lengths: { rel: committed bytes, or -1 if absent } } for $j.rels in the stage: an unfinished
#            append's mark gives the length it started from, not the partial one.
#   apply:   brings $j.root (C:\build) up to date from $j.stage:
#     1. checks first, changing nothing: the root and the stage are real folders (no reparse point); every path is a
#        plain relative path (no "..", ":", drive or root) whose canonical identity (segments joined by "\", upper-cased
#        invariant: the same as the helper's) is unique, and no file is the ancestor of another; no existing ancestor of
#        a removal or a destination is a link or junction; each staged file is a plain file. Blockers are found: a file
#        or link where a folder must go, a folder or link where a file must go. With delete false a blocker is refused.
#     2. full: the root's contents are cleared, never following a link (a link is removed itself, never entered).
#        Otherwise: the removals, each link-safely, then the folders they leave empty (up to the root); then blockers.
#     3. each file is moved from the stage into place, its folders made one level at a time and each checked again.
#     4. the stage is removed.
# A guest process changing C:\build during an apply can only damage the guest's own disposable disk: the helper treats
# C:\build as untrusted until an apply finishes.
param($j)
$ErrorActionPreference = 'Stop'

$REPARSE = [IO.FileAttributes]::ReparsePoint
$DIR = [IO.FileAttributes]::Directory
$RO = [IO.FileAttributes]::ReadOnly

function Attr([string]$p) {
  try { return [IO.File]::GetAttributes($p) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
}

function RealFolder([string]$p, [string]$what) {
  $at = Attr $p
  if ($null -eq $at) { throw "$what '$p' does not exist" }
  if ($at -band $REPARSE) { throw "$what '$p' is a link or junction: refused" }
  if (-not ($at -band $DIR)) { throw "$what '$p' is not a folder" }
}

# Deletes a path without ever following a link: a link (to a folder or a file) is removed itself; a real folder is
# emptied entry by entry, then removed.
function RemoveSafe([string]$p) {
  $at = Attr $p
  if ($null -eq $at) { return }
  if ($at -band $RO) { [IO.File]::SetAttributes($p, $at -band -bnot $RO); $at = $at -band -bnot $RO }
  if ($at -band $REPARSE) {
    if ($at -band $DIR) { [IO.Directory]::Delete($p, $false) } else { [IO.File]::Delete($p) }
    return
  }
  if ($at -band $DIR) {
    foreach ($c in @([IO.Directory]::GetFileSystemEntries($p))) { RemoveSafe $c }
    [IO.Directory]::Delete($p, $false)
    return
  }
  [IO.File]::Delete($p)
}

# A relative path's segments, or a refusal: the same rules as the helper's paths.js, as far as the guest needs them.
function Parts([string]$p) {
  if (-not $p -or $p.Length -gt 400) { throw "path refused: '$p' (empty or too long)" }
  if ($p -match '[\x00-\x1f:*?"<>|]') { throw "path refused: '$p' (characters not allowed)" }
  if ($p -match '^[\\/]') { throw "path refused: '$p' (not relative)" }
  $parts = @($p -split '[\\/]+' | Where-Object { $_ -and $_ -ne '.' })
  if (-not $parts.Count) { throw "path refused: '$p' (empty)" }
  foreach ($s in $parts) { if ($s -match '^\.\.+$' -or $s -match '[. ]$') { throw "path refused: '$p' (segment '$s')" } }
  return , $parts
}
function KeyOf($parts) { return ($parts -join '\').ToUpperInvariant() }

# MC-1558: an append's mark: the path of the file holding the committed length of the staged file $parts.
function MarkOf([string]$pd, $parts) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $h = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes((KeyOf $parts))) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
  return "$pd\marks\$h"
}
# Rolls a staged file back to its mark's committed length, if an append was interrupted; returns the committed length
# (-1 when the file is absent).
function Settle([string]$dst, [string]$mark) {
  if (Test-Path -LiteralPath $mark -PathType Leaf) {
    $want = [long]([IO.File]::ReadAllText($mark).Trim())
    $at = Attr $dst
    if ($null -ne $at -and -not ($at -band $REPARSE) -and -not ($at -band $DIR)) {
      $fs = New-Object IO.FileStream($dst, [IO.FileMode]::Open, [IO.FileAccess]::Write)
      try { if ($fs.Length -gt $want) { $fs.SetLength($want) } } finally { $fs.Dispose() }
    }
    [IO.File]::Delete($mark)
  }
  $at = Attr $dst
  if ($null -eq $at -or ($at -band $REPARSE) -or ($at -band $DIR)) { return -1 }
  return (New-Object IO.FileInfo $dst).Length
}

# Joins segments under a base, and checks the result really is strictly inside it.
function Under([string]$base, $parts) {
  $full = [IO.Path]::GetFullPath($base + '\' + ($parts -join '\'))
  if (-not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "path refused: '$($parts -join '\')' leaves '$base'" }
  return $full
}

# Walks the existing ancestors of a path below base (not the path itself). A link or junction on the way is refused; the
# first one that is a file (a file where a folder must go) is returned; $null when none is.
function AncestorBlocker([string]$base, $parts) {
  $p = $base
  for ($i = 0; $i -lt $parts.Count - 1; $i++) {
    $p = $p + '\' + $parts[$i]
    $at = Attr $p
    if ($null -eq $at) { return $null }
    if ($at -band $REPARSE) { throw "'$p' is a link or junction: refused" }
    if (-not ($at -band $DIR)) { return $p }
  }
  return $null
}

# Removes the folders a removal left empty, from the removed path's parent up to (not including) the root.
function Prune([string]$root, [string]$full) {
  $d = [IO.Path]::GetDirectoryName($full)
  while ($d.Length -gt $root.Length -and $d.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
    $at = Attr $d
    if ($null -eq $at -or ($at -band $REPARSE) -or -not ($at -band $DIR)) { return }
    if (@([IO.Directory]::GetFileSystemEntries($d)).Count) { return }
    [IO.Directory]::Delete($d, $false)
    $d = [IO.Path]::GetDirectoryName($d)
  }
}

$action = [string]$j.action
if ($action -eq 'prepare') {
  $stage = [IO.Path]::GetFullPath([string]$j.stage).TrimEnd('\')
  $parent = [IO.Path]::GetDirectoryName($stage)
  if ($null -eq (Attr $parent)) { [void][IO.Directory]::CreateDirectory($parent) }
  RealFolder $parent 'the staging folder'
  # MC-1558: stale stages (a failed or cancelled copy's) go; never through a link (RemoveSafe).
  foreach ($old in @([IO.Directory]::GetFileSystemEntries($parent))) {
    $leaf = [IO.Path]::GetFileName($old)
    if ($leaf -match '^sync-\d{1,9}(-parts)?$' -and $old -ne $stage -and $old -ne [string]$j.parts) { RemoveSafe $old }
  }
  RemoveSafe $stage
  [void][IO.Directory]::CreateDirectory($stage)
  if ($j.parts) { $pd = [IO.Path]::GetFullPath([string]$j.parts).TrimEnd('\'); RemoveSafe $pd; [void][IO.Directory]::CreateDirectory($pd) }
  return @{ prepared = $true }
}
if ($action -eq 'append') {
  $stage = [IO.Path]::GetFullPath([string]$j.stage).TrimEnd('\')
  RealFolder $stage 'the staging folder'
  $pd = [IO.Path]::GetFullPath([string]$j.parts).TrimEnd('\')
  RealFolder $pd 'the parts folder'
  $appended = 0; $skipped = 0
  foreach ($it in @($j.items)) {
    $parts = Parts ([string]$it.rel)
    $dst = Under $stage $parts
    $part = [IO.Path]::GetFullPath([string]$it.part)
    if (-not $part.StartsWith($pd + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "part '$part' is outside the parts folder" }
    $p = $stage
    for ($i = 0; $i -lt $parts.Count - 1; $i++) {
      $p = $p + '\' + $parts[$i]
      $at = Attr $p
      if ($null -eq $at) { [void][IO.Directory]::CreateDirectory($p); $at = Attr $p }
      if (($at -band $REPARSE) -or -not ($at -band $DIR)) { throw "'$p' in the stage is a link or a file: refused" }
    }
    $at = Attr $dst
    if ($null -ne $at -and (($at -band $REPARSE) -or ($at -band $DIR))) { throw "the staged file '$($it.rel)' is a link or a folder: refused" }
    $mark = MarkOf $pd $parts
    $cur = Settle $dst $mark
    $off = [long]$it.offset; $len = [long]$it.length
    if ($cur -ge 0 -and $cur -ge $off + $len) { $skipped++; RemoveSafe $part; continue }
    if ([Math]::Max($cur, 0) -ne $off) { throw "the staged file '$($it.rel)' is $([Math]::Max($cur, 0)) bytes, not the $off this part follows" }
    $in = [IO.File]::OpenRead($part)
    try {
      if ($in.Length -ne $len) { throw "part of '$($it.rel)' is $($in.Length) bytes, not $len" }
      [void][IO.Directory]::CreateDirectory("$pd\marks")
      [IO.File]::WriteAllText($mark, [string]$off) # recorded before the first byte goes in
      $out = New-Object IO.FileStream($dst, [IO.FileMode]::Append, [IO.FileAccess]::Write)
      try { $in.CopyTo($out); $out.Flush($true) } finally { $out.Dispose() }
      [IO.File]::Delete($mark) # committed
    } finally { $in.Dispose() }
    RemoveSafe $part
    $appended++
  }
  return @{ appended = $appended; skipped = $skipped }
}
if ($action -eq 'lengths') {
  $stage = [IO.Path]::GetFullPath([string]$j.stage).TrimEnd('\')
  RealFolder $stage 'the staging folder'
  $pd = [IO.Path]::GetFullPath([string]$j.parts).TrimEnd('\')
  RealFolder $pd 'the parts folder'
  $out = @{}
  foreach ($r in @($j.rels)) {
    $parts = Parts ([string]$r)
    $out[[string]$r] = Settle (Under $stage $parts) (MarkOf $pd $parts)
  }
  return @{ lengths = $out }
}
if ($action -ne 'apply') { throw "unknown action '$action'" }

$root = [IO.Path]::GetFullPath([string]$j.root).TrimEnd('\')
$full = [bool]$j.full
$delete = [bool]$j.delete
RealFolder $root 'the build folder'
$files = @(@($j.files) | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
$removes = @(@($j.remove) | Where-Object { $null -ne $_ } | ForEach-Object { [string]$_ })
$stage = $null
if ($files.Count) { $stage = [IO.Path]::GetFullPath([string]$j.stage).TrimEnd('\'); RealFolder $stage 'the staging folder' }

# 1. Checks, before any change.
$fileKeys = @{}
$plan = @()
foreach ($f in $files) {
  $parts = Parts $f
  $k = KeyOf $parts
  if ($fileKeys.ContainsKey($k)) { throw "path refused: '$f' is listed twice (as '$($fileKeys[$k])')" }
  $fileKeys[$k] = $f
  $plan += , @{ path = $f; parts = $parts; key = $k }
}
foreach ($e in $plan) {
  for ($i = 1; $i -lt $e.parts.Count; $i++) {
    $a = KeyOf $e.parts[0..($i - 1)]
    if ($fileKeys.ContainsKey($a)) { throw "path refused: '$($fileKeys[$a])' is a file and also a folder of '$($e.path)'" }
  }
}
$removeKeys = @{}
$removePaths = @()
foreach ($r in $removes) {
  $parts = Parts $r
  $k = KeyOf $parts
  if ($removeKeys.ContainsKey($k)) { continue }
  $removeKeys[$k] = $true
  $removePaths += , @{ parts = $parts; full = (Under $root $parts) }
  if (-not $full) { [void](AncestorBlocker $root $parts) } # throws on a link on the way
}
$blockers = New-Object Collections.Generic.List[string]
foreach ($e in $plan) {
  $e.dst = Under $root $e.parts
  $e.src = Under $stage $e.parts
  $sat = Attr $e.src
  if ($null -eq $sat -or ($sat -band $REPARSE) -or ($sat -band $DIR)) { throw "the staged file '$($e.path)' is missing or not a plain file" }
  if ($null -ne (AncestorBlocker $stage $e.parts)) { throw "the staged file '$($e.path)' is under a file" }
  if ($full) { continue }
  $b = AncestorBlocker $root $e.parts
  if ($null -ne $b) { if (-not $blockers.Contains($b)) { $blockers.Add($b) }; continue }
  $at = Attr $e.dst
  if ($null -ne $at -and (($at -band $REPARSE) -or ($at -band $DIR))) { if (-not $blockers.Contains($e.dst)) { $blockers.Add($e.dst) } }
}
if (-not $delete -and -not $full) {
  # A blocker that a removal takes away anyway isn't one; with delete false there are no removals.
  if ($blockers.Count) { throw "with delete false, these are in the way and were left alone (nothing was changed): $(($blockers | ForEach-Object { $_.Substring($root.Length + 1) }) -join ', ')" }
}

# 2. Clear, or remove and unblock.
$removed = 0
if ($full) {
  foreach ($c in @([IO.Directory]::GetFileSystemEntries($root))) { RemoveSafe $c; $removed++ }
} else {
  foreach ($r in $removePaths) {
    if ($null -ne (AncestorBlocker $root $r.parts)) { continue } # under a file: nothing there to remove
    if ($null -ne (Attr $r.full)) { RemoveSafe $r.full; $removed++ }
    Prune $root $r.full
  }
  foreach ($b in $blockers) { RemoveSafe $b }
}

# 3. Into place: folders one level at a time, each checked again as it is reached.
$copied = 0
foreach ($e in $plan) {
  $p = $root
  for ($i = 0; $i -lt $e.parts.Count - 1; $i++) {
    $p = $p + '\' + $e.parts[$i]
    $at = Attr $p
    if ($null -eq $at) { [void][IO.Directory]::CreateDirectory($p); $at = Attr $p }
    if (($at -band $REPARSE) -or -not ($at -band $DIR)) { throw "'$p' changed during the sync (now a link or a file): stopped" }
  }
  $at = Attr $e.dst
  if ($null -ne $at) {
    if (($at -band $REPARSE) -or ($at -band $DIR)) { throw "'$($e.dst)' changed during the sync (now a link or a folder): stopped" }
    if ($at -band $RO) { [IO.File]::SetAttributes($e.dst, $at -band -bnot $RO) }
    [IO.File]::Delete($e.dst)
  }
  [IO.File]::Move($e.src, $e.dst)
  $copied++
}

# 4. The stage goes (and MC-1558's parts folder beside it).
if ($stage) { RemoveSafe $stage }
if ($j.parts) { RemoveSafe ([IO.Path]::GetFullPath([string]$j.parts).TrimEnd('')) }
return @{ copied = $copied; removed = $removed; blockersRemoved = $blockers.Count }
