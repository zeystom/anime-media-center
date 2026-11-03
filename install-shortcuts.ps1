# Install Anime Media Center Desktop and Start Menu shortcuts
$ErrorActionPreference = "Stop"

$appDir = $PSScriptRoot
if (-not $appDir) {
    $appDir = (Get-Location).Path
}
$exePath = Join-Path $appDir "Anime Media Center.exe"
$iconPath = Join-Path $appDir "app-icon.ico"

$WshShell = New-Object -ComObject WScript.Shell

# 1. Start Menu Shortcut
$startMenuDir = [Environment]::GetFolderPath('Programs')
if ($startMenuDir -and (Test-Path $startMenuDir)) {
    $startMenuShortcutPath = Join-Path $startMenuDir "Anime Media Center.lnk"
    $startShortcut = $WshShell.CreateShortcut($startMenuShortcutPath)
    $startShortcut.TargetPath = $exePath
    $startShortcut.WorkingDirectory = $appDir
    $startShortcut.IconLocation = "$iconPath,0"
    $startShortcut.Description = "Anime Media Center & Whisper Studio"
    $startShortcut.Save()
    Write-Host "Created Start Menu shortcut: $startMenuShortcutPath"
}

# 2. Desktop Shortcut
$desktopDir = [Environment]::GetFolderPath('Desktop')
if ($desktopDir -and (Test-Path $desktopDir)) {
    $desktopShortcutPath = Join-Path $desktopDir "Anime Media Center.lnk"
    $desktopShortcut = $WshShell.CreateShortcut($desktopShortcutPath)
    $desktopShortcut.TargetPath = $exePath
    $desktopShortcut.WorkingDirectory = $appDir
    $desktopShortcut.IconLocation = "$iconPath,0"
    $desktopShortcut.Description = "Anime Media Center & Whisper Studio"
    $desktopShortcut.Save()
    Write-Host "Created Desktop shortcut: $desktopShortcutPath"
}

Write-Host "SUCCESS: Anime Media Center shortcuts installed successfully!"
