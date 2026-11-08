# Create Kaiko shortcuts with the same AppUserModelID used by Electron.
# Windows uses a matching Start Menu shortcut to identify the taskbar button.
$ErrorActionPreference = 'Stop'

$appDir = $PSScriptRoot
$appId = 'com.animemediacenter.app'
$exePath = Join-Path $appDir 'Kaiko.exe'
$electronExe = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$iconPath = Join-Path $appDir 'app-icon.ico'

if (Test-Path $exePath) {
    $targetPath = $exePath
    $arguments = ''
} elseif (Test-Path $electronExe) {
    $targetPath = $electronExe
    $arguments = '"' + $appDir + '"'
} else {
    throw 'Neither Kaiko.exe nor the local Electron runtime was found.'
}

$source = @'
using System;
using System.Runtime.InteropServices;

namespace Kaiko.Shortcuts {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    public class ShellLinkComObject {}

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    public interface IShellLinkW {
        void GetPath(IntPtr path, int cch, IntPtr findData, int flags);
        void GetIDList(out IntPtr pidl);
        void SetIDList(IntPtr pidl);
        void GetDescription(IntPtr name, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetWorkingDirectory(IntPtr directory, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments(IntPtr args, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int showCmd);
        void SetShowCmd(int showCmd);
        void GetIconLocation(IntPtr iconPath, int cch, out int iconIndex);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, int reserved);
        void Resolve(IntPtr hwnd, int flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0000010b-0000-0000-C000-000000000046")]
    public interface IPersistFile {
        void GetClassID(out Guid classId);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, int mode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PropertyKey { public Guid FormatId; public uint PropertyId; }

    [StructLayout(LayoutKind.Explicit)]
    public struct PropVariant {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr StringValue;
        [FieldOffset(8)] public long Size;
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99")]
    public interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    public static class ShortcutWriter {
        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant value);

        public static void Create(string linkPath, string target, string args, string workingDirectory, string iconPath, string appId) {
            var link = (IShellLinkW)new ShellLinkComObject();
            link.SetPath(target);
            link.SetArguments(args ?? "");
            link.SetWorkingDirectory(workingDirectory ?? "");
            link.SetDescription("Kaiko anime library and media center");
            if (!String.IsNullOrEmpty(iconPath)) link.SetIconLocation(iconPath, 0);

            var store = (IPropertyStore)link;
            var key = new PropertyKey { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), PropertyId = 5 };
            var value = new PropVariant { Type = 31, StringValue = Marshal.StringToCoTaskMemUni(appId) };
            try { store.SetValue(ref key, ref value); store.Commit(); }
            finally { PropVariantClear(ref value); }

            ((IPersistFile)link).Save(linkPath, true);
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

function New-KaikoShortcut([string]$linkPath) {
    $parent = Split-Path -Parent $linkPath
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [Kaiko.Shortcuts.ShortcutWriter]::Create($linkPath, $targetPath, $arguments, $appDir, $(if (Test-Path $iconPath) { $iconPath } else { '' }), $appId)

    # Verify the saved shortcut advertises exactly the same ID as the app window.
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace($parent)
    $item = $folder.ParseName((Split-Path -Leaf $linkPath))
    if ($item.ExtendedProperty('System.AppUserModel.ID') -ne $appId) {
        throw "Windows did not save Kaiko's taskbar identity to $linkPath"
    }
}

$startMenu = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
if ($startMenu -and (Test-Path $startMenu)) { New-KaikoShortcut (Join-Path $startMenu 'Kaiko.lnk') }
if ($desktop -and (Test-Path $desktop)) { New-KaikoShortcut (Join-Path $desktop 'Kaiko.lnk') }

Write-Host 'Kaiko shortcuts created with the matching Windows taskbar identity.'
