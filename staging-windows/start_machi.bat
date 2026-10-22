@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

:: Set production environment
set NODE_ENV=production
set PORT=3000

:: Start Machi standalone server in the background
start /B "" "%~dp0node.exe" "%~dp0server.cjs"

:: Allow background server to initialize
timeout /t 2 /nobreak >nul

:: Launch default browser directly to Machi assistant
start "" "http://localhost:3000"

exit /b 0
