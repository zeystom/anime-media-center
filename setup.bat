@echo off
title Kaiko Setup
cd /d "%~dp0"

echo ========================================================
echo                     Kaiko - Setup & Shortcuts
echo ========================================================
echo.

if not exist "node_modules" (
    echo [1/4] Installing dependencies via npm install...
    call npm install
) else (
    echo [1/4] Dependencies found in node_modules.
)

echo [2/4] Refreshing production assets...
call npm run build
if errorlevel 1 (
    echo [Error] Build failed. Kaiko was not updated.
    pause
    exit /b 1
)

echo [3/4] Refreshing Kaiko launcher and icon...
if exist "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" (
    "%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /target:winexe /win32icon:app-icon.ico /out:"Kaiko.exe" launcher.cs
) else if exist "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" (
    "%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe" /target:winexe /win32icon:app-icon.ico /out:"Kaiko.exe" launcher.cs
) else (
    echo [Notice] csc.exe compiler not found. Shortcuts will launch via electron.exe directly.
)

echo [4/4] Creating Desktop and Start Menu shortcuts...
powershell.exe -ExecutionPolicy Bypass -File "%~dp0install-shortcuts.ps1"

echo.
echo ========================================================
echo  All set! You can now launch "Kaiko" from:
echo   - Desktop shortcut
echo   - Start Menu
echo   - "Launch Kaiko.vbs" (silent launch)
echo   - Or by running "npm start" in terminal
echo ========================================================
echo.
pause
