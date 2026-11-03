@echo off
title Anime Media Center Setup
cd /d "%~dp0"

echo ========================================================
echo         Anime Media Center - Setup & Shortcuts
echo ========================================================
echo.

if not exist "node_modules" (
    echo [1/4] Installing dependencies via npm install...
    call npm install
) else (
    echo [1/4] Dependencies found in node_modules.
)

if not exist "dist\index.html" (
    echo [2/4] Building production assets...
    call npm run build
) else (
    echo [2/4] Build assets ready.
)

if not exist "Anime Media Center.exe" (
    echo [3/4] Compiling launcher executable via csc.exe...
    if exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
        "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:winexe /win32icon:app-icon.ico /out:"Anime Media Center.exe" launcher.cs
    ) else if exist "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
        "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" /target:winexe /win32icon:app-icon.ico /out:"Anime Media Center.exe" launcher.cs
    ) else (
        echo [Notice] csc.exe compiler not found. Shortcuts will launch via electron.exe directly.
    )
) else (
    echo [3/4] Launcher executable already exists.
)

echo [4/4] Creating Desktop and Start Menu shortcuts...
powershell.exe -ExecutionPolicy Bypass -File "%~dp0install-shortcuts.ps1"

echo.
echo ========================================================
echo  All set! You can now launch "Anime Media Center" from:
echo   - Desktop shortcut
echo   - Start Menu
echo   - "Launch Anime Media Center.vbs" (silent launch)
echo   - Or by running "npm start" in terminal
echo ========================================================
echo.
pause
