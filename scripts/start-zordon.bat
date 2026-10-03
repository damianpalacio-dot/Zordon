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
echo Node.js was not found.
echo Download the Windows .zip from https://nodejs.org/en/download and unzip it into this Zordon folder.
pause
exit /b 1
:havenode
rem Settings: Notepad sometimes saves ".env" as ".env.txt"; fix that.
if not exist .env if exist .env.txt ren .env.txt .env
rem Zordon finds the GEC2 OneDrive by itself; .env is only needed to override it.
if not exist .env copy .env.example .env >nul
if not exist node_modules (call npm install)
start "Zordon server" /min cmd /c "npm start"
timeout /t 3 /nobreak >nul
set URL=http://localhost:4000
where msedge >nul 2>nul && (start "" msedge --app=%URL% --start-maximized & goto :eof)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%URL% --start-maximized & goto :eof)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%URL% --start-maximized & goto :eof)
start "" %URL%
