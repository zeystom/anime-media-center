@echo off
title Anime Media Center Setup
cd /d "%~dp0"

echo ========================================================
echo         Anime Media Center - Setup & Shortcuts
echo ========================================================
echo.

if not exist "node_modules" (
    echo [1/3] Installing dependencies via npm install...
    call npm install
) else (
    echo [1/3] Dependencies found in node_modules.
)

if not exist "dist\index.html" (
    echo [2/3] Building production assets...
    call npm run build
) else (
    echo [2/3] Build assets ready.
)

echo [3/3] Creating Desktop and Start Menu shortcuts...
powershell.exe -ExecutionPolicy Bypass -File "%~dp0install-shortcuts.ps1"

echo.
echo ========================================================
echo  All set! You can now launch "Anime Media Center" from:
echo   - Desktop shortcut
echo   - Start Menu
echo   - Or by running Anime Media Center.exe in this folder!
echo ========================================================
echo.
pause
