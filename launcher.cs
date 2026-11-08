using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace Kaiko
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try
            {
                string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
                string exePath = Path.Combine(appDir, "Kaiko.exe");
                string iconPath = Path.Combine(appDir, "app-icon.ico");
                string electronExe = Path.Combine(appDir, @"node_modules\electron\dist\electron.exe");

                // The root Kaiko.exe is a project launcher, so it relies on
                // the local Electron runtime and external main-process modules.
                // electron.exe alone is not enough: a pruned node_modules can
                // open the splash and then fail while importing the main app.
                bool hasRuntimeDependencies = HasRuntimeDependencies(appDir);
                if (!File.Exists(electronExe) || !hasRuntimeDependencies)
                {
                    DialogResult res = MessageBox.Show(
                        "Не найдены все зависимости Kaiko. Возможно, папка node_modules неполная.\n\nВосстановить зависимости автоматически (npm install)?",
                        "Kaiko — Первый запуск",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Information
                    );

                    if (res == DialogResult.Yes)
                    {
                        ProcessStartInfo npmInfo = new ProcessStartInfo("cmd.exe", "/c npm install")
                        {
                            WorkingDirectory = appDir,
                            UseShellExecute = true
                        };
                        Process npmProc = Process.Start(npmInfo);
                        if (npmProc != null)
                        {
                            npmProc.WaitForExit();
                        }
                    }
                    else
                    {
                        return;
                    }
                }

                if (!File.Exists(electronExe) || !HasRuntimeDependencies(appDir))
                {
                    MessageBox.Show(
                        "Не удалось восстановить зависимости Kaiko.\nПроверьте подключение к интернету и выполните 'npm install' в папке проекта.",
                        "Kaiko — Ошибка",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return;
                }

                // Check if dist/index.html exists (needs build)
                string distHtml = Path.Combine(appDir, @"dist\index.html");
                if (!File.Exists(distHtml))
                {
                    ProcessStartInfo buildInfo = new ProcessStartInfo("cmd.exe", "/c npm run build")
                    {
                        WorkingDirectory = appDir,
                        UseShellExecute = true
                    };
                    Process bProc = Process.Start(buildInfo);
                    if (bProc != null)
                    {
                        bProc.WaitForExit();
                    }
                }

                // Ensure Desktop and Start Menu shortcuts are created
                EnsureShortcuts(appDir, exePath, iconPath);

                // Launch Electron with appDir
                ProcessStartInfo psi = new ProcessStartInfo(electronExe, "\"" + appDir + "\"")
                {
                    WorkingDirectory = appDir,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };

                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Ошибка запуска приложения:\n" + ex.Message, "Kaiko", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        static bool HasRuntimeDependencies(string appDir)
        {
            string[] requiredPackages = { "fast-xml-parser", "webtorrent" };
            foreach (string packageName in requiredPackages)
            {
                string packageJson = Path.Combine(appDir, "node_modules", packageName, "package.json");
                if (!File.Exists(packageJson)) return false;
            }
            return true;
        }

        static void EnsureShortcuts(string appDir, string exePath, string iconPath)
        {
            try
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string startMenu = Environment.GetFolderPath(Environment.SpecialFolder.Programs);

                string desktopLnk = Path.Combine(desktop, "Kaiko.lnk");
                string startMenuLnk = Path.Combine(startMenu, "Kaiko.lnk");

                if ((!File.Exists(desktopLnk) && Directory.Exists(desktop)) ||
                    (!File.Exists(startMenuLnk) && Directory.Exists(startMenu)))
                {
                    Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                    if (shellType != null)
                    {
                        dynamic shell = Activator.CreateInstance(shellType);

                        if (!File.Exists(desktopLnk) && Directory.Exists(desktop))
                        {
                            dynamic sc = shell.CreateShortcut(desktopLnk);
                            sc.TargetPath = exePath;
                            sc.WorkingDirectory = appDir;
                            if (File.Exists(iconPath)) sc.IconLocation = iconPath + ",0";
                            sc.Description = "Kaiko anime library and media center";
                            sc.Save();
                        }

                        if (!File.Exists(startMenuLnk) && Directory.Exists(startMenu))
                        {
                            dynamic sc = shell.CreateShortcut(startMenuLnk);
                            sc.TargetPath = exePath;
                            sc.WorkingDirectory = appDir;
                            if (File.Exists(iconPath)) sc.IconLocation = iconPath + ",0";
                            sc.Description = "Kaiko anime library and media center";
                            sc.Save();
                        }
                    }
                }
            }
            catch
            {
                // Ignore shortcut creation failures silently
            }
        }
    }
}
