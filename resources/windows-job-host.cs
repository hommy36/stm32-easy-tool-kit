using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

public static class Stm32JobHost
{
    sealed class Request
    {
        public string executable { get; set; }
        public string[] args { get; set; }
        public string cwd { get; set; }
        public Dictionary<string, string> env { get; set; }
        public int timeoutMs { get; set; }
    }
    [StructLayout(LayoutKind.Sequential)] struct Security
    { public int length; public IntPtr descriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup
    {
        public int cb; public string reserved; public string desktop; public string title;
        public uint x, y, xSize, ySize, xCount, yCount, fill, flags;
        public short show, reservedCount; public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo
    { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit
    {
        public long processTime, jobTime; public uint flags;
        public UIntPtr minWorking, maxWorking; public uint activeLimit;
        public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters
    { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit
    {
        public BasicLimit basic; public IoCounters io;
        public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting
    {
        public long userTime, kernelTime, periodUser, periodKernel;
        public uint faults, total, active, terminated;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr resultSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, ref Security security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity,
        bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);

    static readonly object outputGate = new object();
    static readonly JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 8388608 };
    static int control;

    static void Check(bool value)
    { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Close(ref IntPtr handle)
    { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle = IntPtr.Zero; }
    static void Emit(object frame)
    { lock (outputGate) { Console.WriteLine(serializer.Serialize(frame)); Console.Out.Flush(); } }
    static string Quote(string value)
    {
        if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid process argument");
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
    static Task Pump(IntPtr handle, string stream)
    {
        return Task.Run(delegate {
            using (var file = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 4096, false))
            {
                var buffer = new byte[4096];
                int count;
                while ((count = file.Read(buffer, 0, buffer.Length)) != 0)
                    Emit(new { type = "output", stream = stream, data = Convert.ToBase64String(buffer, 0, count) });
            }
        });
    }
    static bool Empty(IntPtr job)
    {
        Accounting accounting;
        Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return accounting.active == 0;
    }
    static void ReadControl()
    {
        try
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                var command = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(line);
                string type;
                if (command == null || command.Count != 1 || !command.TryGetValue("type", out type)) break;
                if (type == "cancel") { Interlocked.Exchange(ref control, 2); return; }
                if (type == "resume") { Interlocked.CompareExchange(ref control, 1, 0); continue; }
                break;
            }
        }
        catch { }
        Interlocked.Exchange(ref control, 2);
    }
    public static void Run()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        IntPtr job = IntPtr.Zero, environment = IntPtr.Zero, stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero, input = IntPtr.Zero;
        var process = new ProcessInfo();
        Task stdoutTask = null, stderrTask = null;
        bool assigned = false, treeExited = false;
        int? exitCode = null;
        string reason = "failed", error = null;
        try
        {
            string line = Console.ReadLine();
            if (line == null || line.Length > 8388608) throw new ArgumentException("Invalid job request");
            Request request = serializer.Deserialize<Request>(line);
            if (request == null || !Path.IsPathRooted(request.executable) || !File.Exists(request.executable)
                || !Directory.Exists(request.cwd) || request.args == null || request.env == null || request.timeoutMs < 1)
                throw new ArgumentException("Invalid job executable, cwd, arguments or timeout");
            var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in request.env)
            {
                if (String.IsNullOrEmpty(item.Key) || item.Key.IndexOfAny(new[] { '\0', '=' }) >= 0
                    || item.Value == null || item.Value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid environment");
                values[item.Key] = item.Value;
            }
            var block = new StringBuilder();
            foreach (var item in values) block.Append(item.Key).Append('=').Append(item.Value).Append('\0');
            block.Append('\0');
            environment = Marshal.StringToHGlobalUni(block.ToString());
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            var limit = new ExtendedLimit(); limit.basic.flags = 0x00002000;
            Check(SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
            var security = new Security { length = Marshal.SizeOf(typeof(Security)), inherit = 1 };
            Check(CreatePipe(out stdoutRead, out stdoutWrite, ref security, 0));
            Check(CreatePipe(out stderrRead, out stderrWrite, ref security, 0));
            Check(SetHandleInformation(stdoutRead, 1, 0)); Check(SetHandleInformation(stderrRead, 1, 0));
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
            Check(input != new IntPtr(-1));
            var startup = new Startup { cb = Marshal.SizeOf(typeof(Startup)), flags = 0x100, stdin = input, stdout = stdoutWrite, stderr = stderrWrite };
            var command = new StringBuilder(Quote(request.executable));
            foreach (string arg in request.args) command.Append(' ').Append(Quote(arg));
            Check(CreateProcess(request.executable, command, IntPtr.Zero, IntPtr.Zero, true,
                0x00000004 | 0x00000400 | 0x08000000, environment, request.cwd, ref startup, out process));
            Check(AssignProcessToJobObject(job, process.process)); assigned = true;
            Close(ref stdoutWrite); Close(ref stderrWrite); Close(ref input);
            stdoutTask = Pump(stdoutRead, "stdout"); stdoutRead = IntPtr.Zero;
            stderrTask = Pump(stderrRead, "stderr"); stderrRead = IntPtr.Zero;
            new Thread(ReadControl) { IsBackground = true }.Start();
            Emit(new { type = "prepared", pid = process.pid });
            var watch = System.Diagnostics.Stopwatch.StartNew();
            while (Volatile.Read(ref control) == 0 && watch.ElapsedMilliseconds < 15000) Thread.Sleep(10);
            if (Volatile.Read(ref control) != 1) reason = "cancelled";
            else
            {
                if (ResumeThread(process.thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                Emit(new { type = "started", pid = process.pid });
                watch.Restart();
                reason = "exit";
                while (WaitForSingleObject(process.process, 25) == 258)
                {
                    if (Volatile.Read(ref control) == 2) { reason = "cancelled"; break; }
                    if (watch.ElapsedMilliseconds >= request.timeoutMs) { reason = "timeout"; break; }
                }
            }
            if (reason != "exit" || !Empty(job)) Check(TerminateJobObject(job, 1));
            watch.Restart();
            while (!Empty(job) && watch.ElapsedMilliseconds < 10000) Thread.Sleep(10);
            treeExited = Empty(job) && WaitForSingleObject(process.process, 1000) == 0;
            uint code;
            if (treeExited && GetExitCodeProcess(process.process, out code)) exitCode = unchecked((int)code);
            if (!treeExited) reason = "failed";
        }
        catch (Exception exception)
        {
            reason = "failed"; error = exception.Message;
            try
            {
                if (process.process != IntPtr.Zero)
                {
                    if (assigned) Check(TerminateJobObject(job, 1)); else Check(TerminateProcess(process.process, 1));
                    treeExited = WaitForSingleObject(process.process, 10000) == 0 && (!assigned || Empty(job));
                }
                else treeExited = true;
            }
            catch { treeExited = false; }
        }
        finally
        {
            Close(ref stdoutRead); Close(ref stdoutWrite); Close(ref stderrRead); Close(ref stderrWrite); Close(ref input);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            Close(ref process.thread); Close(ref process.process); Close(ref job);
        }
        try
        {
            if (stdoutTask != null && !stdoutTask.Wait(10000)) treeExited = false;
            if (stderrTask != null && !stderrTask.Wait(10000)) treeExited = false;
        }
        catch (Exception exception) { error = exception.Message; reason = "failed"; treeExited = false; }
        Emit(new { type = "finished", exitCode = exitCode, reason = reason, treeExited = treeExited, error = error });
    }
}
