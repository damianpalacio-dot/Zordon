@echo off
rem Start Zordon fresh: clears the board, tasks and demo data on this computer, then reloads your team and jobs
rem from OneDrive (Zordon/zordon-roster.json). Your OneDrive files are never touched.
cd /d "%~dp0.."
echo This clears Zordon's board on this computer (tasks, meetings, demo data).
echo Your OneDrive files and folders are NOT touched.
set /p OK=Type YES to start fresh: 
if /i not "%OK%"=="YES" (echo Cancelled. & pause & exit /b 0)
taskkill /fi "WINDOWTITLE eq Zordon server*" /t /f >nul 2>nul
timeout /t 2 /nobreak >nul
if not exist data\backups mkdir data\backups
for %%F in (zordon.db zordon.db-wal zordon.db-shm) do if exist data\%%F move /y data\%%F data\backups\%%F.%RANDOM% >nul
echo Done. Starting Zordon...
call "%~dp0start-zordon.bat"
