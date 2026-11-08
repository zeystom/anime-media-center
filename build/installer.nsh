!include "LogicLib.nsh"

!macro customUnInstall
  ; Silent uninstall and upgrades always preserve personal files.
  ${IfNot} ${Silent}
    StrCpy $0 "0"
    StrCpy $1 "0"

    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Remove Kaiko's saved data? This deletes settings, anime lists and watch history, including the backup in Documents\AnimeCenter. Your video files are kept." \
      IDNO +2
    StrCpy $0 "1"

    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
      "Remove the contents of Kaiko's configured anime library folders? This permanently deletes all files in those folders, including files not downloaded by Kaiko. The folder itself is kept. A second confirmation will show the exact folders." \
      IDNO +2
    StrCpy $1 "1"

    ${If} $0 == "1"
    ${OrIf} $1 == "1"
      File /oname=$PLUGINSDIR\KaikoUninstallCleanup.ps1 "${BUILD_RESOURCES_DIR}\KaikoUninstallCleanup.ps1"
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\KaikoUninstallCleanup.ps1" -AppData "$APPDATA" -Documents "$DOCUMENTS" -DeleteUserData "$0" -DeleteLibrary "$1"'
      Pop $2
      ${If} $2 != 0
        MessageBox MB_OK|MB_ICONEXCLAMATION "Kaiko could not remove some selected data. Check permissions and remove it manually if needed. The application will still be uninstalled."
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
