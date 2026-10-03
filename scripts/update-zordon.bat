@echo off
rem Pull the latest Zordon changes from GitHub and reinstall dependencies.
rem Close the Zordon window first; start it again afterwards with start-zordon.bat.
cd /d "%~dp0.."
git pull
call npm install
echo.
echo Zordon is up to date. Start it again with scripts\start-zordon.bat
pause
