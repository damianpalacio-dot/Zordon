@echo off
rem Start the Zordon Command Center and open it as a full-screen app window.
cd /d "%~dp0.."
rem Use an installed Node.js, or a portable copy unzipped next to Zordon (no installer needed):
rem   Zordon\node\node.exe, Zordon\node-v22...-win-x64\node.exe, or %USERPROFILE%\node\node.exe
where node >nul 2>nul && goto :havenode
for /d %%D in ("%CD%\node" "%CD%\node-v*-win-x64" "%USERPROFILE%\node" "%USERPROFILE%\node-v*-win-x64") do (
  if exist "%%~D\node.exe" (set "PATH=%%~D;%PATH%" & goto :havenode)
  for /d %%E in ("%%~D\node-v*-win-x64") do if exist "%%~E\node.exe" (set "PATH=%%~E;%PATH%" & goto :havenode)
)
rem No Node.js anywhere: download the portable copy (no install, no admin rights) into this folder, once.
echo Getting Node.js (one time, about 35 MB)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $v='v22.20.0'; $z=Join-Path $env:TEMP 'zordon-node.zip'; Invoke-WebRequest \"https://nodejs.org/dist/$v/node-$v-win-x64.zip\" -OutFile $z -UseBasicParsing; Expand-Archive $z '%CD%' -Force"
if exist "%CD%\node-v22.20.0-win-x64\node.exe" (set "PATH=%CD%\node-v22.20.0-win-x64;%PATH%" & goto :havenode)
echo Could not download Node.js. Download the Windows .zip from https://nodejs.org/en/download
echo and unzip it into this Zordon folder, then start Zordon again.
pause
exit /b 1
:havenode
rem Settings: Notepad sometimes saves ".env" as ".env.txt"; fix that.
if not exist .env if exist .env.txt ren .env.txt .env
rem Zordon finds the GEC2 OneDrive by itself; .env is only needed to override it.
if not exist .env copy .env.example .env >nul
if not exist node_modules (call npm install)
set URL=http://localhost:4000
rem Already running? Just open the window.
curl -s -o nul %URL%/api/health && goto :up
start "Zordon server" /min cmd /c "npm start"
rem Wait until Zordon answers (up to 90 seconds) so the window never opens on a blank page.
echo Starting Zordon, one moment...
set /a TRIES=0
:wait
timeout /t 1 /nobreak >nul
set /a TRIES+=1
curl -s -o nul %URL%/api/health && goto :up
if %TRIES% lss 90 goto :wait
:up
where msedge >nul 2>nul && (start "" msedge --app=%URL% --start-maximized & goto :eof)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%URL% --start-maximized & goto :eof)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%URL% --start-maximized & goto :eof)
start "" %URL%
