@echo off
rem Pull the latest Zordon changes from GitHub and reinstall dependencies.
rem Close the Zordon window first; start it again afterwards with start-zordon.bat.
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
where git >nul 2>nul
if errorlevel 1 (echo Git is not installed: download the latest zip from GitHub and unzip it over this folder instead.) else (git pull)
call npm install
echo.
echo Zordon is up to date. Start it again with scripts\start-zordon.bat
pause
