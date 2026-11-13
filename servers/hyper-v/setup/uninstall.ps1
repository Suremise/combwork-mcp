# Removes the hyper-v MCP helper. Run in an admin PowerShell (one line):
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\servers\hyper-v\setup\uninstall.ps1" -KeepPool
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\servers\hyper-v\setup\uninstall.ps1" -RemovePool
#
# With a pool present it refuses unless you choose:
#   -KeepPool   removes the service, the group, the rights and the code, and KEEPS the pool's VMs, %ProgramData%\hyperv-mcp
#               (journal, policy, guest credentials) and the disk folders, with their ACLs. Running setup again
#               recognises the pool (the service's SID comes from its name, so the ACLs still hold).
#   -RemovePool removes the pool first, through the helper's own journalled remove (only its own VMs, by id; you approve
#               the plan here), then everything, state last.
# Either way, it first asks the helper to quiesce: no new leases, every lease ended, every VM restored. A VM that
# can't be restored stops the uninstall, named. Each step can be run again: an interrupted uninstall is finished by
# running it again.
param([switch]$KeepPool, [switch]$RemovePool, [ValidateSet('Service', 'Direct')][string]$Mode = 'Service', [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name)
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "- $m" }
# Whether the helper's pipe exists, by listing the pipes (opening one would count as a client).
function PipeOpen { return [bool]([IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -ieq '\\.\pipe\hyperv-mcp' }) }

$me = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an admin PowerShell (Run as administrator).' }
if ($KeepPool -and $RemovePool) { throw 'Choose -KeepPool or -RemovePool, not both.' }

$install = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'hyperv-mcp'
$state = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'hyperv-mcp'
$svc = 'HyperVMcp'
$svcAccount = "NT SERVICE\$svc"
$groupName = 'Hyper-V MCP Users'
$HVADMINS = 'S-1-5-32-578'

# One request to the helper over its pipe (Administrators may open it).
function Invoke-Helper([string]$op, $hvArgs = @{}) {
  $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', 'hyperv-mcp', [IO.Pipes.PipeDirection]::InOut)
  $pipe.Connect(10000)
  try {
    $w = New-Object IO.StreamWriter($pipe, (New-Object Text.UTF8Encoding $false)); $w.AutoFlush = $true; $w.NewLine = "`n"
    $r = New-Object IO.StreamReader($pipe, [Text.Encoding]::UTF8)
    $w.WriteLine((@{ id = 1; op = $op; args = $hvArgs } | ConvertTo-Json -Compress -Depth 5))
    $ans = $r.ReadLine() | ConvertFrom-Json
    if (-not $ans.ok) { throw "helper: $($ans.error)" }
    return $ans.result
  } finally { $pipe.Dispose() }
}
function Epoch { (Get-Content -LiteralPath (Join-Path $state 'journal.jsonl') -TotalCount 1 | ConvertFrom-Json).epoch }

$running = (Get-Service $svc -ErrorAction SilentlyContinue).Status -eq 'Running' -and (PipeOpen)
if ($Mode -eq 'Service' -and $running) {
  $st = Invoke-Helper 'status'
  $vms = [int]$st.data.vms
  Step "The helper is running; the pool has $vms VM(s)."
  if ($vms -gt 0 -and -not $KeepPool -and -not $RemovePool) { throw "The pool has $vms VM(s): run again with -KeepPool (keep them, for a later setup) or -RemovePool (remove them first). Nothing was changed." }
  if ($st.data.job) { throw "A pool job is running ($($st.data.job)): wait for it (pool_status), then run this again. Nothing was changed." }
  # Quiesce, authorised by an approval only Administrators can write. Its purpose: with -RemovePool the helper then
  # still allows exactly one change, this uninstall's own approved remove; otherwise none.
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $nb = New-Object byte[] 16; $rng.GetBytes($nb)
  $purpose = if ($RemovePool) { 'remove-pool' } else { 'keep-pool' }
  $q = [ordered]@{ nonce = (-join ($nb | ForEach-Object { $_.ToString('x2') })); epoch = (Epoch); expires = [DateTimeOffset]::UtcNow.AddMinutes(10).ToString('o'); purpose = $purpose } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText((Join-Path $state 'approvals\quiesce.json'), $q, (New-Object Text.UTF8Encoding $false))
  $res = Invoke-Helper 'quiesce'
  Remove-Item -LiteralPath (Join-Path $state 'approvals\quiesce.json') -Force
  if ($res.isError) { throw "$($res.text) Uninstall stopped: fix or remove that VM, then run this again." }
  Step $res.text
  if ($RemovePool -and $vms -gt 0) {
    $plan = Invoke-Helper 'pool_plan' @{ action = 'remove' }
    Write-Host $plan.text
    & (Join-Path $install 'approve.ps1') -Plan $plan.data.planId
    if ($LASTEXITCODE -ne 0) { throw 'The remove plan was not approved: nothing was removed.' }
    $job = Invoke-Helper 'pool_remove' @{ planId = $plan.data.planId }
    Step $job.text
    do { Start-Sleep 3; $st = Invoke-Helper 'status' } while ($st.data.job)
    if ([int]$st.data.vms -gt 0) { throw "The pool still has $($st.data.vms) VM(s) after its remove job: see pool_status and $state\helper.log. Run this again to retry." }
    Step 'The pool is removed.'
  }
} elseif (Test-Path (Join-Path $state 'journal.jsonl')) {
  if (-not $KeepPool -and -not $RemovePool) { throw "The helper isn't running, so the pool can't be checked: start it (Start-Service $svc) and run this again, or pass -KeepPool to keep whatever pool there is." }
  if ($RemovePool) { throw "-RemovePool needs the helper running (it removes only its own VMs, by its journal): Start-Service $svc, then run this again." }
}

# The service, its rights and its group. The state (and the pool) stay unless the pool was removed above.
if (Get-Service $svc -ErrorAction SilentlyContinue) {
  Stop-Service $svc -Force -ErrorAction SilentlyContinue
  & sc.exe delete $svc | Out-Null
  Step "Service $svc removed."
}
foreach ($m in @($svcAccount) + $(if ($Mode -eq 'Direct') { @($User) } else { @() })) {
  if (Get-LocalGroupMember -SID $HVADMINS -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $m }) { Remove-LocalGroupMember -SID $HVADMINS -Member $m; Step "$m removed from Hyper-V Administrators." }
}
if (Get-LocalGroup -Name $groupName -ErrorAction SilentlyContinue) { Remove-LocalGroup -Name $groupName; Step "Group '$groupName' removed." }
if (Test-Path $install) { Remove-Item -LiteralPath $install -Recurse -Force; Step "$install removed." }

if ($RemovePool -and (Test-Path $state)) {
  $policy = Get-Content -LiteralPath (Join-Path $state 'policy.json') -Raw | ConvertFrom-Json
  $disks = @($policy.diskFolders | ForEach-Object { [IO.Path]::GetFullPath([string]$_).TrimEnd('\') })
  # The pool's VMs were removed above (by id, through the helper's journal): their folders must be gone. Anything left in
  # pool\ is refused, not deleted blindly.
  foreach ($d in $disks) {
    $pool = Join-Path $d 'pool'
    $left = @(if (Test-Path -LiteralPath $pool) { Get-ChildItem -LiteralPath $pool -Force })
    if ($left.Count) { throw "$pool still holds $($left.Count) item(s) ($($left[0].FullName)) after the pool's removal: inspect them (pool_status, $state\helper.log), then run this again. Nothing more was removed." }
  }
  foreach ($d in $disks) {
    foreach ($sub in 'pool', 'images') {
      $p = Join-Path $d $sub
      if (Test-Path -LiteralPath $p) {
        $n = @(Get-ChildItem -LiteralPath $p -Recurse -Force -File)
        Remove-Item -LiteralPath $p -Recurse -Force
        Step "Removed $p ($($n.Count) file(s): $(($n | ForEach-Object { $_.Name }) -join ', '))."
      }
    }
    if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force; Step "Removed $d (empty)." }
    elseif (Test-Path -LiteralPath $d) { Step "Kept ${d}: it holds other things ($((Get-ChildItem -LiteralPath $d -Force | ForEach-Object { $_.Name }) -join ', '))." }
  }
  Remove-Item -LiteralPath $state -Recurse -Force
  Step "Removed $state (the helper's journal, policy and guest credentials)."
  # Their receipts (setup's records of the folders it created) go with them; a folder kept above keeps its receipt.
  $rk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\hyperv-mcp\Storage', $true)
  if ($rk) {
    foreach ($p in @($state, (Join-Path $state 'approvals')) + $disks) {
      if (-not (Test-Path -LiteralPath $p) -and $null -ne $rk.GetValue($p.ToLowerInvariant())) { $rk.DeleteValue($p.ToLowerInvariant()); Step "Removed the storage receipt for $p." }
    }
    $empty = $rk.ValueCount -eq 0
    $rk.Dispose()
    if ($empty) { [Microsoft.Win32.Registry]::LocalMachine.DeleteSubKeyTree('SOFTWARE\hyperv-mcp', $false); Step 'Removed HKLM\SOFTWARE\hyperv-mcp.' }
  }
} elseif (Test-Path $state) {
  Step "Kept: $state and the pool's disk folders (run setup again to use the pool, or uninstall again with -RemovePool after setup)."
}
Write-Host 'Done.' -ForegroundColor Green
