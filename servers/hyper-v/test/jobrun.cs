// MC-1543: a test-only launcher. jobrun.exe <command line> starts the command suspended inside a new Job object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, resumes it, waits for it, and exits with its exit code. Everything the command
// starts (cmd, ping, ...) joins the job, so when this launcher ends, however it ends (the command's exit, a crash, a
// test's timeout killing it), Windows closes the job's last handle and kills every process still in it: nothing the
// test launched can outlive it, and no PID is ever looked up to clean up. Error dialogs are off for the command and its
// children (SetErrorMode, inherited). Compiled by the tests with the in-box csc.exe; never shipped.
using System;
using System.Runtime.InteropServices;

static class JobRun
{
    [StructLayout(LayoutKind.Sequential)]
    struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXTENDED_LIMIT { public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll")] static extern uint SetErrorMode(uint mode);

    const uint KILL_ON_JOB_CLOSE = 0x2000, CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, INFINITE = 0xFFFFFFFF;
    const int ExtendedLimitInformation = 9, STARTF_USESTDHANDLES = 0x100;

    static int Main()
    {
        // The command line after this program's own name, as given.
        string line = Environment.CommandLine;
        int i = line.StartsWith("\"") ? line.IndexOf('"', 1) + 1 : line.IndexOf(' ');
        string cmd = i <= 0 || i >= line.Length ? "" : line.Substring(i).TrimStart();
        if (cmd.Length == 0) { Console.Error.WriteLine("usage: jobrun.exe <command line>"); return 2; }
        SetErrorMode(0x8003); // SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX, inherited
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var lim = new EXTENDED_LIMIT();
        lim.Basic.LimitFlags = KILL_ON_JOB_CLOSE;
        if (job == IntPtr.Zero || !SetInformationJobObject(job, ExtendedLimitInformation, ref lim, Marshal.SizeOf(typeof(EXTENDED_LIMIT))))
        { Console.Error.WriteLine("jobrun: can't make the job (" + Marshal.GetLastWin32Error() + ")"); return 3; }
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
        PROCESS_INFORMATION pi;
        if (!CreateProcess(null, new System.Text.StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi))
        { Console.Error.WriteLine("jobrun: can't start the command (" + Marshal.GetLastWin32Error() + ")"); return 3; }
        // In the job before it runs a single instruction, so nothing it starts is ever outside it.
        if (!AssignProcessToJobObject(job, pi.hProcess))
        { TerminateProcess(pi.hProcess, 1); Console.Error.WriteLine("jobrun: can't put the command in the job (" + Marshal.GetLastWin32Error() + ")"); return 3; }
        ResumeThread(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        // Returning closes the job's only handle: Windows kills whatever is still in it.
        return (int)code;
    }
}
