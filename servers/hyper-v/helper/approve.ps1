# Approves one hyper-v pool plan. The user runs it as one line in an admin terminal (cmd or PowerShell, the same line,
# MC-1575), from the installed copy, through its launcher:
#   cmd /c call "C:\Program Files\hyperv-mcp\approve.cmd" -Plan p-0123456789abcdef
#
# It shows the plan from the helper's own record (never from an agent's text), asks for the first 6 characters of its
# digest (a check that the plan on screen is the one approved: not a secret), and writes a single-use approval that
# only Administrators and SYSTEM can write: approvals\<plan>.json with the plan's digest, operation, expiry, the pool
# state's epoch and a random nonce. The helper accepts it once, before it expires, for that exact plan only.
#
# It runs only from %ProgramFiles%\hyperv-mcp (admin-only writable), dot-sources nothing and uses only in-box cmdlets.
param([Parameter(Mandatory = $true)][string]$Plan)
$ErrorActionPreference = 'Stop'
# Runs under Windows PowerShell 5.1 or PowerShell 7 (MC-1575). Under 5.1 started from a PowerShell 7 window, it
# inherits PS7's module folders and can't load its own Get-Acl: drop them (only under 5.1: they are 7's own).
if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '(?<!Windows)PowerShell\\(\d[^\\]*\\)?Modules\\?$' }) -join ';' }

$install = Join-Path $env:ProgramFiles 'hyperv-mcp'
if ((Split-Path -Parent $PSCommandPath).TrimEnd('\') -ne $install) { throw "Run approve.ps1 from $install, not from $(Split-Path -Parent $PSCommandPath)." }
$me = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an admin terminal (Run as administrator).' }
if ($Plan -notmatch '^p-[0-9a-f]{16}$') { throw "'$Plan' is not a plan id (p- and 16 hex digits)." }

$state = Join-Path $env:ProgramData 'hyperv-mcp'
$file = Join-Path $state "plans\$Plan.json"
if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "No plan $Plan (plans expire after 30 minutes: ask for a new one)." }
if ((Get-Item -LiteralPath $file -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The plan file is a link: refusing.' }
$bytes = [IO.File]::ReadAllBytes($file)
$digest = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
$p = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
$epochLine = Get-Content -LiteralPath (Join-Path $state 'journal.jsonl') -TotalCount 1
$epoch = ($epochLine | ConvertFrom-Json).epoch
$now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if ($p.id -ne $Plan) { throw 'The plan file names another plan: refusing.' }
if ($p.epoch -ne $epoch) { throw 'The plan is from an earlier pool state: ask for a new one.' }
if ($p.expires -le $now) { throw 'The plan has expired: ask for a new one.' }

Write-Host ''
Write-Host "Plan ${Plan}: $($p.op) the hyper-v pool" -ForegroundColor Cyan
foreach ($a in @($p.add)) { if ($a) { Write-Host ("  create {0}: {1} cores, {2} MB memory, {3} GB disk, in {4}" -f $a.name, $a.cores, $a.memoryMB, $a.diskGB, $a.folder) } }
foreach ($r in @($p.remove)) { if ($r) { Write-Host ("  remove {0} and its folder {1}" -f $r.name, $r.folder) } }
# MC-1531: a refresh plan.
foreach ($r in @($p.refresh)) { if ($r) { Write-Host ("  refresh the clean checkpoint of {0}: rerun the build's guest steps offline (registry policy and Defender; the accounts' profiles kept as built, not logged on: profile-setup fixes need a rebuild), take a new clean checkpoint, remove the old one (pool checkpoints kept; nothing goes online; its evaluation end unchanged)" -f $r.name) } }
# MC-1532: a pool-checkpoint plan.
if ($p.op -eq 'checkpoint') {
  foreach ($v in @($p.vms)) {
    if ($p.mode -eq 'remove') { Write-Host ("  remove the pool checkpoint ""{0}"" of {1} (owner {2})" -f $p.checkpoint, $v.name, $v.owner) }
    else { Write-Host ("  {0} the pool checkpoint ""{1}"" of {2} (owner {3}) from lease {4}'s prepared state, which every project's leases may then start from" -f $p.mode, $p.checkpoint, $v.name, $v.owner, $v.leaseId) }
  }
}
if ($p.switch) { Write-Host "  create the internal switch $($p.switch) (host and guests only)" }
if ($p.removeSwitch) { Write-Host "  remove the switch $($p.removeSwitch)" }
if ($p.image) {
  # MC-1572: the image is the file you chose; approving binds its SHA-256, and the build uses the helper's copy of exactly that.
  $from = if ($p.image.path) { "from $($p.image.path)" } else { 'checked earlier' }
  $what = if ($p.image.os -eq 'linux') { "Linux image $($p.image.name)" } else { "$($p.image.edition) build $($p.image.build)" }
  Write-Host ("  image: {0}, SHA-256 {1} ({2})" -f $what, $p.image.sha256, $from)
  if ($p.image.signature) { Write-Host ("  setup files: {0}" -f $(if ($p.image.signature.microsoft) { 'signed by Microsoft' } else { "not signed by Microsoft ($($p.image.signature.note)): information only" })) }
}
Write-Host ''
Write-Host 'The full plan, as the helper recorded it:' -ForegroundColor DarkGray
Write-Host ($p | ConvertTo-Json -Depth 6) -ForegroundColor DarkGray
Write-Host ''
Write-Host "Digest: $digest"
$typed = Read-Host 'To approve exactly this plan, type the first 6 characters of its digest (anything else cancels)'
if ($typed.Trim().ToLowerInvariant() -ne $digest.Substring(0, 6)) { Write-Host 'Not approved.' -ForegroundColor Yellow; exit 1 }

$dir = Join-Path $state 'approvals'
if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "$dir is missing: run setup again." }
# Tidy: approvals that have expired (the service can't delete them: it can only read this folder).
Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | ForEach-Object {
  try { if ([DateTimeOffset]::Parse((Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).expires).ToUnixTimeMilliseconds() -lt $now) { Remove-Item -LiteralPath $_.FullName -Force } } catch { Remove-Item -LiteralPath $_.FullName -Force }
}
$expires = [DateTimeOffset]::FromUnixTimeMilliseconds([Math]::Min([long]$p.expires, $now + 30 * 60 * 1000)).ToString('o')
$rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $nb = New-Object byte[] 16; $rng.GetBytes($nb)
$nonce = -join ($nb | ForEach-Object { $_.ToString('x2') })
$approval = [ordered]@{ planId = $Plan; digest = $digest; op = $p.op; expires = $expires; nonce = $nonce; epoch = $epoch } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $dir "$Plan.json"), $approval, (New-Object Text.UTF8Encoding $false))
Write-Host "Approved plan $Plan until $expires. The agent can now call pool_$($p.op)." -ForegroundColor Green
