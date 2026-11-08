param(
  [Parameter(Mandatory = $true)][string]$AppData,
  [Parameter(Mandatory = $true)][string]$Documents,
  [Parameter(Mandatory = $true)][string]$DeleteUserData,
  [Parameter(Mandatory = $true)][string]$DeleteLibrary
)

$ErrorActionPreference = 'Stop'

function Get-KaikoDataDirectories {
  $names = @('Kaiko', 'Anime Media Center', 'anime-media-center')
  foreach ($name in $names) {
    $candidate = Join-Path $AppData $name
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }

    $hasKaikoData = @('settings.json', 'history.json', 'user-library.json', 'season-rules.json', 'downloads.json') |
      Where-Object { Test-Path -LiteralPath (Join-Path $candidate $_) -PathType Leaf } |
      Select-Object -First 1

    if ($hasKaikoData) { $candidate }
  }
}

function Get-ConfiguredLibraryRoots {
  $roots = [System.Collections.Generic.List[string]]::new()
  foreach ($directory in (Get-KaikoDataDirectories)) {
    $settingsPath = Join-Path $directory 'settings.json'
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { continue }

    try {
      $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
      foreach ($root in @($settings.libraryFolders) + @($settings.defaultLibraryRoot)) {
        if ($root -is [string] -and -not [string]::IsNullOrWhiteSpace($root)) {
          $fullPath = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($root.Trim()))
          if (-not $roots.Contains($fullPath)) { $roots.Add($fullPath) }
        }
      }
    } catch {
      Write-Warning "Could not read Kaiko settings in $directory"
    }
  }
  return $roots.ToArray()
}

function Test-PathAtOrBelow {
  param([string]$Candidate, [string]$Protected)
  $base = [System.IO.Path]::GetFullPath($Protected).TrimEnd('\')
  $path = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  return $path.Equals($base, [System.StringComparison]::OrdinalIgnoreCase) -or
    $path.StartsWith($base + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-SafeLibraryRoot {
  param([string]$Root)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $false }

  $item = Get-Item -LiteralPath $Root -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }

  $fullPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $driveRoot = [System.IO.Path]::GetPathRoot($fullPath).TrimEnd('\')
  if ($fullPath.Equals($driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }

  $protected = @(
    $env:WINDIR,
    $env:ProgramFiles,
    ${env:ProgramFiles(x86)},
    $env:ProgramData,
    $env:APPDATA,
    $env:LOCALAPPDATA,
    [Environment]::GetFolderPath('MyDocuments'),
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:USERPROFILE 'Downloads')
  ) | Where-Object { $_ -and $_.Trim() }

  if ($fullPath.Equals($env:USERPROFILE.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  foreach ($protectedPath in $protected) {
    if (Test-PathAtOrBelow -Candidate $fullPath -Protected $protectedPath) { return $false }
  }
  return $true
}

function Remove-FolderContentsSafely {
  param([string]$Folder)
  foreach ($entry in (Get-ChildItem -LiteralPath $Folder -Force -ErrorAction Stop)) {
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      # Leave junctions and symbolic links untouched; never follow them outside the selected root.
      continue
    }

    if ($entry.PSIsContainer) {
      Remove-FolderContentsSafely -Folder $entry.FullName
      Remove-Item -LiteralPath $entry.FullName -Force -ErrorAction Stop
    } else {
      Remove-Item -LiteralPath $entry.FullName -Force -ErrorAction Stop
    }
  }
}

if ($DeleteLibrary -eq '1') {
  Add-Type -AssemblyName System.Windows.Forms
  $roots = @(Get-ConfiguredLibraryRoots)
  $safeRoots = @($roots | Where-Object { Test-SafeLibraryRoot -Root $_ })

  if ($safeRoots.Count -eq 0) {
    [void][System.Windows.Forms.MessageBox]::Show(
      'No safe, configured library folders were found. No media files were removed.',
      'Kaiko uninstall',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    )
  } else {
    $shownRoots = $safeRoots | Select-Object -First 8
    $folderList = $shownRoots -join "`r`n"
    if ($safeRoots.Count -gt 8) { $folderList += "`r`n…and $($safeRoots.Count - 8) more folder(s)" }
    $message = "This permanently deletes all files and subfolders inside these library folders:`r`n`r`n$folderList`r`n`r`nThe selected folder itself and any links inside it will be left in place. Continue?"
    $answer = [System.Windows.Forms.MessageBox]::Show(
      $message,
      'Confirm anime library deletion',
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning,
      [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )

    if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
      foreach ($root in $safeRoots) {
        try {
          Remove-FolderContentsSafely -Folder $root
        } catch {
          Write-Warning "Could not completely clear library folder ${root}: $($_.Exception.Message)"
        }
      }
    }
  }
}

if ($DeleteUserData -eq '1') {
  foreach ($directory in (Get-KaikoDataDirectories)) {
    try {
      $item = Get-Item -LiteralPath $directory -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        Remove-Item -LiteralPath $directory -Recurse -Force -ErrorAction Stop
      }
    } catch {
      Write-Warning "Could not remove Kaiko data folder ${directory}: $($_.Exception.Message)"
    }
  }

  $backupDirectory = Join-Path $Documents 'AnimeCenter'
  $backupFile = Join-Path $backupDirectory 'user_library_backup.json'
  if (Test-Path -LiteralPath $backupFile -PathType Leaf) {
    try {
      Remove-Item -LiteralPath $backupFile -Force -ErrorAction Stop
      if ((Get-ChildItem -LiteralPath $backupDirectory -Force | Measure-Object).Count -eq 0) {
        Remove-Item -LiteralPath $backupDirectory -Force -ErrorAction Stop
      }
    } catch {
      Write-Warning "Could not remove the Kaiko backup ${backupFile}: $($_.Exception.Message)"
    }
  }
}

exit 0
