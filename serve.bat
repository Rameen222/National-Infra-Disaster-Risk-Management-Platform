@echo off
setlocal enableextensions enabledelayedexpansion
title NIRRP Portal - Production Server

echo.
echo  ============================================================
echo   NIRRP Portal  ^|  Production Server Mode
echo   Heavy processing runs HERE. Clients connect via browser.
echo  ============================================================
echo.

:: ── Load ports from project-root .env ────────────────────────
set CLIENT_PORT=7541
set SERVER_PORT=7542
set PYBACKEND_PORT=7543
if exist "%~dp0.env" (
    for /f "usebackq tokens=1,2 delims==" %%a in ("%~dp0.env") do (
        set "K=%%a"
        set "V=%%b"
        if /i "!K!"=="CLIENT_PORT"    set CLIENT_PORT=!V!
        if /i "!K!"=="SERVER_PORT"    set SERVER_PORT=!V!
        if /i "!K!"=="PYBACKEND_PORT" set PYBACKEND_PORT=!V!
    )
)

:: ── Step 1: Build the React frontend ─────────────────────────
echo [1/3] Building frontend bundle (first run takes ~30s)...
pushd "%~dp0client"
call npm run build
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Frontend build failed. See output above.
    popd
    pause
    exit /b 1
)
popd
echo [OK] Frontend built  →  client\dist\
echo.

:: ── Step 2: Start Express API server in background ───────────
if exist "%~dp0server.log" del /f /q "%~dp0server.log" 2>nul
start /B cmd /c "cd /d "%~dp0server" && npm run dev > "%~dp0server.log" 2>&1"
echo [2/3] Express API server starting on port %SERVER_PORT%...
echo       Logs: %~dp0server.log
echo.
timeout /t 2 /nobreak > nul

:: ── Detect network IP for display ────────────────────────────
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "169.254"') do (
    for /f "tokens=1" %%J in ("%%I") do set LOCAL_IP=%%J
)

:: ── Step 3: Launch Flask (waitress) in production mode ───────
echo [3/3] Starting production server on port %PYBACKEND_PORT%...
echo.
echo  ============================================================
echo   NIRRP Portal is LIVE
echo   ----------------------------------------------------------
echo   This machine   :  http://localhost:%PYBACKEND_PORT%
if defined LOCAL_IP (
echo   Network clients:  http://%LOCAL_IP%:%PYBACKEND_PORT%
echo.
echo   Share the "Network clients" URL with anyone on the LAN.
)
echo   Press Ctrl+C to stop the server.
echo  ============================================================
echo.

cd /d "%~dp0pybackend"
set NIRRP_MODE=production
set SERVER_PORT=%SERVER_PORT%
python app.py

endlocal
