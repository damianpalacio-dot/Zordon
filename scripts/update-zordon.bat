@echo off
rem Update Zordon to the latest version from GitHub, then start it again.
rem Keeps your data, settings (.env) and Node. Works with or without Git.
rem Run from a temporary copy: the update replaces this very file.
if not "%~1"=="--run" (
  copy /y "%~f0" "%TEMP%\zordon-update-run.bat" >nul
  "%TEMP%\zordon-update-run.bat" --run "%~dp0.."
  exit /b
)
cd /d "%~2"
rem Use an installed Node.js, or a portable copy unzipped next to Zordon (no installer needed):
rem   Zordon\node\node.exe, Zordon\node-v22...-win-x64\node.exe, or %USERPROFILE%\node\node.exe
where node >nul 2>nul && goto :havenode
for /d %%D in ("%CD%\node" "%CD%\node-v*-win-x64" "%USERPROFILE%\node" "%USERPROFILE%\node-v*-win-x64") do (
  if exist "%%~D\node.exe" (set "PATH=%%~D;%PATH%" & goto :havenode)
  for /d %%E in ("%%~D\node-v*-win-x64") do if exist "%%~E\node.exe" (set "PATH=%%~E;%PATH%" & goto :havenode)
)
echo Node.js was not found.
echo Download the Windows .zip from https://nodejs.org/en/download and unzip it into this Zordon folder.
pause
exit /b 1
:havenode
rem Close a running Zordon so its files can be replaced.
taskkill /fi "WINDOWTITLE eq Zordon server*" /t /f >nul 2>nul
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>nul
if exist .git (
  git pull
) else (
  rem No Git: download the latest version from GitHub and copy it over this folder.
  rem Your data, settings (.env), Node and installed packages are kept.
  echo Downloading the latest Zordon...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $z=Join-Path $env:TEMP 'zordon-update.zip'; $d=Join-Path $env:TEMP 'zordon-update'; Invoke-WebRequest 'https://github.com/damianpalacio-dot/Zordon/archive/refs/heads/main.zip' -OutFile $z -UseBasicParsing; if (Test-Path $d) { Remove-Item $d -Recurse -Force }; Expand-Archive $z $d -Force"
  if errorlevel 1 (echo Download failed. Check the internet connection and try again. & pause & exit /b 1)
  robocopy "%TEMP%\zordon-update\Zordon-main" "%CD%" /E /XD data node_modules node-v* /XF .env /NFL /NDL /NJH /NJS /NP >nul
)
call npm install
echo.
echo Zordon is up to date. Starting it again...
call "%CD%\scripts\start-zordon.bat"
