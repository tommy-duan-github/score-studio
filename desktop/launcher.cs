// ScoreStudio.exe: starts the bundled runtime (runtime\python\pythonw.exe app\desktop\main.py) and exits.
// Built by desktop/build.py with the .NET Framework compiler that ships with Windows (csc.exe), so the
// portable folder needs nothing installed besides the WebView2 runtime (part of Windows 10/11).
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Score Studio")]
[assembly: System.Reflection.AssemblyProduct("Score Studio")]
[assembly: System.Reflection.AssemblyCompany("Tommy Duan")]

static class Launcher
{
    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string python = Path.Combine(root, "runtime", "python", "pythonw.exe");
        string main = Path.Combine(root, "app", "desktop", "main.py");
        if (!File.Exists(python) || !File.Exists(main))
        {
            MessageBox.Show("Score Studio is incomplete: the 'runtime' and 'app' folders must stay next to ScoreStudio.exe.",
                            "Score Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        var info = new ProcessStartInfo(python, "\"" + main + "\"");
        info.UseShellExecute = false;
        info.WorkingDirectory = root;
        // isolate the bundled Python from any system Python configuration
        info.EnvironmentVariables.Remove("PYTHONHOME");
        info.EnvironmentVariables.Remove("PYTHONPATH");
        info.EnvironmentVariables["PYTHONNOUSERSITE"] = "1";
        info.EnvironmentVariables["SCORE_STUDIO_LAUNCHER"] = Application.ExecutablePath;
        try
        {
            Process.Start(info);
        }
        catch (Exception e)
        {
            MessageBox.Show("Score Studio could not start: " + e.Message, "Score Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }
}
