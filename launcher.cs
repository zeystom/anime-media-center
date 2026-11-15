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

                // Launch Electron first while the foreground activation token is fresh.
                ProcessStartInfo psi = new ProcessStartInfo(electronExe, "\"" + appDir + "\"")
                {
                    WorkingDirectory = appDir,
                    UseShellExecute = false,
                    CreateNoWindow = false
                };

                Process.Start(psi);

                // Ensure Desktop and Start Menu shortcuts exist without delaying launch.
                EnsureShortcuts(appDir);
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

        static void EnsureShortcuts(string appDir)
        {
            try
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string startMenu = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                string desktopLnk = string.IsNullOrEmpty(desktop) ? "" : Path.Combine(desktop, "Kaiko.lnk");
                string startMenuLnk = string.IsNullOrEmpty(startMenu) ? "" : Path.Combine(startMenu, "Kaiko.lnk");
                bool desktopExists = string.IsNullOrEmpty(desktopLnk) || File.Exists(desktopLnk);
                bool startMenuExists = string.IsNullOrEmpty(startMenuLnk) || File.Exists(startMenuLnk);
                if (desktopExists && startMenuExists)
                {
                    return;
                }

                // Create missing links asynchronously so Electron starts immediately with foreground focus.
                string scriptPath = Path.Combine(appDir, "install-shortcuts.ps1");
                if (File.Exists(scriptPath))
                {
                    ProcessStartInfo shortcutInfo = new ProcessStartInfo(
                        "powershell.exe",
                        "-NoProfile -ExecutionPolicy Bypass -File \"" + scriptPath + "\"")
                    {
                        WorkingDirectory = appDir,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    using (Process shortcutProcess = Process.Start(shortcutInfo))
                    {
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
