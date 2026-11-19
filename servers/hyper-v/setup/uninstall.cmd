@echo off
rem hyper-v MCP launcher (MC-1575). Run it, as one line, in an admin terminal (cmd, Windows Terminal, Windows PowerShell
rem or PowerShell 7), the same line in each:
rem   cmd /c call "<this file>" <arguments>
rem It runs its PowerShell script with these arguments under Windows PowerShell 5.1 where it is installed, otherwise
rem PowerShell 7. Each is found from its HKLM registration, never from PATH, the current folder or the environment
rem (only %SystemRoot%, for reg.exe), since this runs elevated. Exits with the script's exit code.
rem Arguments are read first by the shell the line is typed in and then by cmd: a %, ^ or & in a path can be changed
rem before this file sees it. A % or ^ still there is refused here, before anything runs (call would change it again).
setlocal DisableDelayedExpansion
set "HVMCP_SCRIPT=%~dp0uninstall.ps1"
if not exist "%HVMCP_SCRIPT%" set "HVMCP_SCRIPT=%~dp0uninstall\uninstall.ps1"
set "HVMCP_PS="
for /f "tokens=1,2,*" %%a in ('call "%SystemRoot%\System32\reg.exe" query "HKLM\SOFTWARE\Microsoft\PowerShell\3\PowerShellEngine" /v ApplicationBase 2^>nul') do if /i "%%a"=="ApplicationBase" if exist "%%c\powershell.exe" set "HVMCP_PS=%%c\powershell.exe"
if not defined HVMCP_PS for /f "tokens=1,2,*" %%a in ('call "%SystemRoot%\System32\reg.exe" query "HKLM\SOFTWARE\Microsoft\PowerShellCore\InstalledVersions" /s /v InstallLocation 2^>nul') do if /i "%%a"=="InstallLocation" if exist "%%c\pwsh.exe" set "HVMCP_PS=%%c\pwsh.exe"
if not defined HVMCP_PS (
  echo Neither Windows PowerShell nor PowerShell 7 is installed: nothing was run. 1>&2
  exit /b 1
)
set HVMCP_ARGS=%*
setlocal EnableDelayedExpansion
if defined HVMCP_ARGS (
  set "HVMCP_T=!HVMCP_ARGS:%%=!"
  if not "!HVMCP_T!"=="!HVMCP_ARGS!" goto :refuse
  set "HVMCP_T=!HVMCP_ARGS:^^=!"
  if not "!HVMCP_T!"=="!HVMCP_ARGS!" goto :refuse
)
endlocal
rem One line, read whole before the script runs: then (goto) ends this file without reading it again (an uninstall
rem removes it meanwhile), and a child cmd hands on the script's exit code; whatever called this goes on.
"%HVMCP_PS%" -NoProfile -ExecutionPolicy Bypass -File "%HVMCP_SCRIPT%" %* & (goto) 2>nul & call "%SystemRoot%\System32\cmd.exe" /d /c exit %%^errorlevel%%
:refuse
echo An argument holds %% or ^^, which cmd would change on the way: nothing was run. Use a path with neither. 1>&2
exit /b 1
