@echo off
setlocal enableextensions enabledelayedexpansion
title NIRRP Portal

echo.
echo  =====================================================
echo   NIRRP  ^|  National Infrastructure Risk Portal
echo  =====================================================
echo.

:: ── Guard: .env must exist ───────────────────────────────────
if not exist "%~dp0.env" (
    echo [ERROR] .env not found. Run install.bat first.
    pause & exit /b 1
)

:: ── Guard: public folder check ───────────────────────────────
if not exist "%~dp0client\public\ndma.png" (
    echo [WARN] client\public\ data folder missing or incomplete.
    echo        The portal may not display maps correctly.
    echo        Copy your public folder now or continue anyway.
    echo.
    choice /M "Continue without public data?"
    if %errorlevel%==2 exit /b 0
)

:: ── Read ports from .env ─────────────────────────────────────
set CLIENT_PORT=7541
set PYBACKEND_PORT=7543
for /f "usebackq tokens=1,2 delims==" %%a in ("%~dp0.env") do (
    set "K=%%a"
    set "V=%%b"
    if /i "!K!"=="CLIENT_PORT"    set CLIENT_PORT=!V!
    if /i "!K!"=="PYBACKEND_PORT" set PYBACKEND_PORT=!V!
)

:: ── Detect LAN IP ────────────────────────────────────────────
for /f "tokens=2 delims=:" %%I in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "169.254"') do (
    for /f "tokens=1" %%J in ("%%I") do set LOCAL_IP=%%J
)

:: ── 1/2  Python backend (new window, stays open) ────────────
if exist "%~dp0pybackend.log" del /f /q "%~dp0pybackend.log" 2>nul
start "NIRRP Python Backend" powershell -NoExit -Command "cd '%~dp0pybackend'; python app.py 2>&1 | Tee-Object -FilePath '%~dp0pybackend.log'"
echo [1/2] Python backend starting on port %PYBACKEND_PORT%...
echo       (logs: pybackend.log)

:: Give Flask a moment to bind
timeout /t 3 /nobreak >nul

:: ── Open browser ─────────────────────────────────────────────
start "" "http://localhost:!CLIENT_PORT!"

:: ── 2/2  Vite dev server (this window) ──────────────────────
echo [2/2] Starting Vite client on port !CLIENT_PORT!...
echo.
echo  =====================================================
echo   Portal is live!
echo   Local  : http://localhost:!CLIENT_PORT!
if defined LOCAL_IP echo   Network: http://!LOCAL_IP!:!CLIENT_PORT!
echo.
echo   Close this window (or Ctrl+C) to stop the client.
echo   Close the Python window to stop the backend.
echo  =====================================================
echo.

cd /d "%~dp0client"
npm run dev

endlocal
