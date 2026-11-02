# Install Anime Media Center Desktop and Start Menu shortcuts
$ErrorActionPreference = "Stop"

$appDir = "C:\Users\gogoh\.gemini\antigravity\scratch\anime-media-center"
$exePath = Join-Path $appDir "Anime Media Center.exe"
$iconPath = Join-Path $appDir "app-icon.ico"

$WshShell = New-Object -ComObject WScript.Shell

# 1. Start Menu Shortcut
$startMenuDir = [Environment]::GetFolderPath('Programs')
if (-not $startMenuDir -or -not (Test-Path $startMenuDir)) {
    $startMenuDir = "C:\Users\gogoh\AppData\Roaming\Microsoft\Windows\Start Menu\Programs"
}

$startMenuShortcutPath = Join-Path $startMenuDir "Anime Media Center.lnk"
$startShortcut = $WshShell.CreateShortcut($startMenuShortcutPath)
$startShortcut.TargetPath = $exePath
$startShortcut.WorkingDirectory = $appDir
$startShortcut.IconLocation = "$iconPath,0"
$startShortcut.Description = "Anime Media Center & Whisper Studio"
$startShortcut.Save()
Write-Host "Created Start Menu shortcut: $startMenuShortcutPath"

# 2. Desktop Shortcut
$desktopDir = [Environment]::GetFolderPath('Desktop')
if (-not $desktopDir -or -not (Test-Path $desktopDir)) {
    $desktopDir = "C:\Users\gogoh\Desktop"
}
if (-not (Test-Path $desktopDir)) {
    $oneDriveDesktop = "C:\Users\gogoh\OneDrive\Desktop"
    if (Test-Path $oneDriveDesktop) {
        $desktopDir = $oneDriveDesktop
    }
}

$desktopShortcutPath = Join-Path $desktopDir "Anime Media Center.lnk"
$desktopShortcut = $WshShell.CreateShortcut($desktopShortcutPath)
$desktopShortcut.TargetPath = $exePath
$desktopShortcut.WorkingDirectory = $appDir
$desktopShortcut.IconLocation = "$iconPath,0"
$desktopShortcut.Description = "Anime Media Center & Whisper Studio"
$desktopShortcut.Save()
Write-Host "Created Desktop shortcut: $desktopShortcutPath"

Write-Host "SUCCESS: Anime Media Center shortcuts installed successfully!"
