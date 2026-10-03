@echo off
rem Start the Zordon Command Center and open it as a full-screen app window.
cd /d "%~dp0.."
if not exist node_modules (call npm install)
start "Zordon server" /min cmd /c "npm start"
timeout /t 3 /nobreak >nul
set URL=http://localhost:4000
where msedge >nul 2>nul && (start "" msedge --app=%URL% --start-maximized & goto :eof)
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=%URL% --start-maximized & goto :eof)
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=%URL% --start-maximized & goto :eof)
start "" %URL%
