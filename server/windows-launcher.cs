using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class LocalChromeNativeLauncher
{
    private const string NodePath = __NODE_PATH__;
    private const string HostPath = __HOST_PATH__;

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
            else { result.Append('\\', slashes); result.Append(c); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    private static void Stop(Process child)
    {
        try { if (!child.HasExited) child.Kill(); } catch { }
    }

    private static Thread Copy(Stream input, Stream output, Process child, bool closeOutput)
    {
        var thread = new Thread(delegate()
        {
            try
            {
                var buffer = new byte[8192];
                int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                {
                    output.Write(buffer, 0, count); output.Flush();
                }
            }
            catch { Stop(child); }
            finally { if (closeOutput) { try { output.Close(); } catch { } } }
        });
        thread.IsBackground = true; thread.Start(); return thread;
    }

    private static int Main(string[] args)
    {
        try
        {
            var arguments = new StringBuilder(Quote(HostPath));
            foreach (string argument in args) { arguments.Append(' '); arguments.Append(Quote(argument)); }
            using (var child = new Process())
            {
                child.StartInfo = new ProcessStartInfo(NodePath, arguments.ToString())
                {
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
                };
                child.Start();
                Copy(Console.OpenStandardInput(), child.StandardInput.BaseStream, child, true);
                var stdout = Copy(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), child, false);
                var stderr = Copy(child.StandardError.BaseStream, Console.OpenStandardError(), child, false);
                child.WaitForExit(); stdout.Join(); stderr.Join();
                return child.ExitCode;
            }
        }
        catch
        {
            Console.Error.WriteLine("Local Chrome Control: native launcher failed");
            return 1;
        }
    }
}
