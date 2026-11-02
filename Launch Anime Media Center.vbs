Set WshShell = CreateObject("WScript.Shell")
appDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
exePath = appDir & "\Anime Media Center.exe"
WshShell.CurrentDirectory = appDir
WshShell.Run """" & exePath & """", 0, False
