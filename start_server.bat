@echo off
REM ANGELS TWENTY - local dev server
REM ES Modules require http:// so open the game through this server.

cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found in PATH.
    echo Install Python or run any static file server in this folder.
    pause
    exit /b 1
)

echo Starting server on http://localhost:8187/
start "" http://localhost:8187/
python devserver.py 8187
