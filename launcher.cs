using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

namespace AnimeMediaCenter
{
    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try
            {
                string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
                string exePath = Path.Combine(appDir, "Anime Media Center.exe");
                string iconPath = Path.Combine(appDir, "app-icon.ico");
                string electronExe = Path.Combine(appDir, @"node_modules\electron\dist\electron.exe");

                // Check if node_modules or electron exists
                if (!File.Exists(electronExe))
                {
                    DialogResult res = MessageBox.Show(
                        "Зависимости приложения еще не установлены (node_modules отсутствует).\n\nЗапустить автоматическую установку (npm install && npm run build)?",
                        "Anime Media Center — Первый запуск",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Information
                    );

                    if (res == DialogResult.Yes)
                    {
                        ProcessStartInfo npmInfo = new ProcessStartInfo("cmd.exe", "/c npm install && npm run build")
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

                if (!File.Exists(electronExe))
                {
                    MessageBox.Show(
                        "Не удалось найти electron.exe.\nПожалуйста, выполните команду 'npm install' в папке проекта.",
                        "Anime Media Center — Ошибка",
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
                MessageBox.Show("Ошибка запуска приложения:\n" + ex.Message, "Anime Media Center", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        static void EnsureShortcuts(string appDir, string exePath, string iconPath)
        {
            try
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                string startMenu = Environment.GetFolderPath(Environment.SpecialFolder.Programs);

                string desktopLnk = Path.Combine(desktop, "Anime Media Center.lnk");
                string startMenuLnk = Path.Combine(startMenu, "Anime Media Center.lnk");

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
                            sc.Description = "Anime Media Center & Whisper Studio";
                            sc.Save();
                        }

                        if (!File.Exists(startMenuLnk) && Directory.Exists(startMenu))
                        {
                            dynamic sc = shell.CreateShortcut(startMenuLnk);
                            sc.TargetPath = exePath;
                            sc.WorkingDirectory = appDir;
                            if (File.Exists(iconPath)) sc.IconLocation = iconPath + ",0";
                            sc.Description = "Anime Media Center & Whisper Studio";
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
