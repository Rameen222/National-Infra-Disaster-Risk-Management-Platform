@echo off
setlocal enableextensions enabledelayedexpansion
title NIRRP - Install

echo.
echo  =====================================================
echo   NIRRP  ^|  National Infrastructure Risk Portal
echo   Install Script
echo  =====================================================
echo.

:: ── 1/4  .env ────────────────────────────────────────────────
if not exist "%~dp0.env" (
    if exist "%~dp0.env.example" (
        copy /Y "%~dp0.env.example" "%~dp0.env" >nul
        echo [1/4] Created .env from .env.example
        echo       ^> Edit .env with your server IPs before first run.
    ) else (
        echo [1/4] WARN: No .env.example found. Create .env manually.
    )
) else (
    echo [1/4] .env already exists — skipping.
)
if not exist "%~dp0pybackend\temp" mkdir "%~dp0pybackend\temp"
echo.

:: ── 2/4  Node.js client ──────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [2/4] Installing Node.js dependencies  (Node !NODE_VER!)...
pushd "%~dp0client"
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    popd & pause & exit /b 1
)
popd
echo       Done.
echo.

:: ── 3/4  Python backend ──────────────────────────────────────
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python not found. Install from https://www.python.org
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('python --version') do set PY_VER=%%v
echo [3/4] Installing Python dependencies  (!PY_VER!)...
python -m pip install --upgrade pip --quiet
python -m pip install -r "%~dp0pybackend\requirements.txt"
if %errorlevel% neq 0 (
    echo [ERROR] pip install failed.
    pause & exit /b 1
)
echo       Done.
echo.

:: ── 4/4  Public data folder ──────────────────────────────────
echo [4/4] Public data folder setup
echo.
if exist "%~dp0client\public\ndma.png" (
    echo       client\public\ already populated — skipping copy.
    goto :install_done
)

echo       The portal needs a 'public' data folder with maps and scenarios.
echo       Enter the full path to your existing public folder to copy it now,
echo       or press Enter to skip and copy manually later.
echo.
set /p "PUBLIC_SRC=  Source path (or blank to skip): "

if "!PUBLIC_SRC!"=="" (
    echo       Skipped. Copy data into  client\public\  before running.
    goto :install_done
)

if not exist "!PUBLIC_SRC!" (
    echo       Path not found — skipped. Copy data into client\public\ manually.
    goto :install_done
)

echo       Copying from !PUBLIC_SRC! ...
xcopy /E /I /Y /Q "!PUBLIC_SRC!" "%~dp0client\public\"
if %errorlevel% neq 0 (
    echo       WARN: Some files may not have copied. Check client\public\
) else (
    echo       Done.
)

:install_done
echo.
echo  =====================================================
echo   Installation complete!
echo   Run  start.bat  to launch the portal.
echo  =====================================================
echo.
pause
endlocal
