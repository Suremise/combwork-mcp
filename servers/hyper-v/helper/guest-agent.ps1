# The interactive session's watcher (MC-1504). guest-logon copies it into the guest as C:\hvmcp\agent.ps1 and starts it
# at every logon through an HKLM Run entry, so it runs in the logged-on account's own session (elevated for an admin
# logon, where UAC's Admin Approval Mode is off). It does one thing: for each request <root>\req\<n>.go the helper
# publishes, it claims the request by creating <n>.claimed with CreateNew (only one claimant can ever win it; a rename
# wasn't enough: with two watchers, a test saw a request run twice), removes the .go, then starts <root>\wrap-<n>.cmd, the
# run's wrapper the helper wrote first. Nothing is kept in memory, so a restarted watcher never runs a request again: a
# claimed request keeps its .claimed, even if the watcher died before removing the .go. A claimed run that dies before
# its exit file is the helper's to handle: it times out and the helper restores the VM.
# <root> is this file's own folder.
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSCommandPath
$req = Join-Path $root 'req'
while ($true) {
  foreach ($f in @(Get-ChildItem -LiteralPath $req -Filter '*.go' -File -ErrorAction SilentlyContinue)) {
    $n = $f.BaseName
    if ($n -notmatch '^\d{1,9}$') { continue }
    # The claim: <n>.claimed made with CreateNew, which only one claimant can ever win; then the request is removed.
    try { [IO.File]::Open((Join-Path $req "$n.claimed"), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None).Dispose() } catch { continue }
    # Fail closed: a request that can't be removed isn't started (it keeps its .claimed, so it never runs; the helper
    # times out and restores the VM).
    try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop } catch { continue }
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /c `"$(Join-Path $root "wrap-$n.cmd")`"" -WindowStyle Minimized
  }
  Start-Sleep -Milliseconds 200
}
