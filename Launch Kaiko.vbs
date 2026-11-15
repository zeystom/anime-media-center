Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = appDir & "\Kaiko.exe"
brandedElectronExe = appDir & "\node_modules\electron\dist\Kaiko.exe"
electronExe = appDir & "\node_modules\electron\dist\electron.exe"
WshShell.CurrentDirectory = appDir

If fso.FileExists(exePath) Then
    WshShell.Run """" & exePath & """", 1, False
ElseIf fso.FileExists(brandedElectronExe) Then
    WshShell.Run """" & brandedElectronExe & """ """ & appDir & """", 1, False
ElseIf fso.FileExists(electronExe) Then
    WshShell.Run """" & electronExe & """ """ & appDir & """", 1, False
Else
    WshShell.Run "cmd /c npm start", 0, False
End If
