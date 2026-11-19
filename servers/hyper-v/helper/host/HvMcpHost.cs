// The hyper-v MCP helper's service host. Setup compiles it with the in-box .NET Framework compiler (csc.exe) into
// %ProgramFiles%\hyperv-mcp\HvMcpHost.exe and runs it as the service "HyperVMcp" under its virtual account
// (NT SERVICE\HyperVMcp, the only account in Hyper-V Administrators). It exists because Node can't answer the Service
// Control Manager or set a named pipe's ACL. It does three things:
//
// 1. Supervises `node helper.js`: started inside its own job object (KILL_ON_JOB_CLOSE), so the helper and every
//    PowerShell it starts die with the job. The helper does nothing until the host has assigned it ("go"). When the
//    helper exits, closes its output, or misses heartbeats (ping every 10 s, no pong in 5 min), the host closes every
//    client connection, stops accepting, terminates the job (no old operation carries on), and starts a new helper,
//    which recovers before it says "ready". 3 restarts within 10 minutes: the host exits with an error and leaves the
//    restart to the Service Control Manager's recovery actions.
// 2. Owns the named pipe \\.\pipe\<name>, opened only once the helper is ready, with an explicit ACL: SYSTEM,
//    Administrators and the service itself full control; the local group of users (from host.config) read and write,
//    without the right to create pipe instances. It refuses to start if a pipe of that name already exists (squatted).
// 3. Relays each connection to the helper as text lines (see helper.js): "open <c> <pid>", "msg <c> <line>",
//    "close <c>". A client line is capped at 4 MB and can't contain a newline, so it can't forge framing.
//
// Usage: HvMcpHost.exe            (as the service)
//        HvMcpHost.exe --console  (in a console, for a manual check)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;

static class Native {
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
  [DllImport("kernel32", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32", SetLastError = true)] public static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);

  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  public const int JobObjectExtendedLimitInformation = 9;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
}

class Conn {
  public int Id; public NamedPipeServerStream Pipe; public readonly object WriteLock = new object(); public volatile bool Closed;
}

class Supervisor {
  const int MaxLine = 4 * 1024 * 1024;
  readonly Dictionary<string, string> cfg;
  readonly string logFile;
  readonly ManualResetEvent stopping = new ManualResetEvent(false);
  readonly object gate = new object();
  readonly Dictionary<int, Conn> conns = new Dictionary<int, Conn>();
  Process helper; IntPtr job = IntPtr.Zero; StreamWriter helperIn; readonly object helperLock = new object();
  ManualResetEvent helperReady, helperGone;
  int nextConn = 0; long lastPong = 0; long pingN = 0;
  // MC-1558: a helper is killed (every lease ends) only after 5 min without a pong: a host under memory pressure can stall
  // a healthy Node process for half a minute. The tests set a shorter one (HYPERV_MCP_HOST_HEARTBEAT_MS).
  static readonly TimeSpan HeartbeatTimeout = TimeSpan.FromMilliseconds(EnvMs("HYPERV_MCP_HOST_HEARTBEAT_MS", 5 * 60 * 1000));
  static int EnvMs(string name, int dflt) { int v; return int.TryParse(Environment.GetEnvironmentVariable(name), out v) && v > 0 ? v : dflt; }
  readonly List<DateTime> restarts = new List<DateTime>();
  public int ExitCode = 0;

  public Supervisor(string dir) {
    cfg = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var raw in File.ReadAllLines(Path.Combine(dir, "host.config"))) {
      var line = raw.Trim();
      if (line.Length == 0 || line.StartsWith("#")) continue;
      int i = line.IndexOf('=');
      if (i > 0) cfg[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
    }
    foreach (var k in new[] { "node", "helper", "stateDir", "pipe", "usersSid" }) if (!cfg.ContainsKey(k)) throw new Exception("host.config has no " + k);
    logFile = Path.Combine(cfg["stateDir"], "host.log");
  }

  void Log(string s) {
    try {
      lock (gate) {
        var f = new FileInfo(logFile);
        if (f.Exists && f.Length > 4 * 1024 * 1024) File.Copy(logFile, logFile + ".1", true);
        if (f.Exists && f.Length > 4 * 1024 * 1024) File.Delete(logFile);
        File.AppendAllText(logFile, DateTime.UtcNow.ToString("o") + " " + s + Environment.NewLine);
      }
    } catch { }
  }

  public void Stop() { stopping.Set(); }

  public void Run() {
    try {
      var pipePath = @"\\.\pipe\" + cfg["pipe"];
      if (Array.Exists(Directory.GetFiles(@"\\.\pipe\"), p => string.Equals(p, pipePath, StringComparison.OrdinalIgnoreCase))) {
        Log("refusing to start: a pipe named " + cfg["pipe"] + " already exists (another program may be squatting it)");
        ExitCode = 3; return;
      }
      while (!stopping.WaitOne(0)) {
        lock (restarts) {
          restarts.RemoveAll(t => (DateTime.UtcNow - t).TotalMinutes > 10);
          if (restarts.Count >= 3) { Log("the helper failed 3 times within 10 minutes: exiting for the service's recovery"); ExitCode = 4; return; }
          restarts.Add(DateTime.UtcNow);
        }
        RunHelperOnce();
        if (!stopping.WaitOne(0)) stopping.WaitOne(2000);
      }
    } catch (Exception e) {
      Log("host failed: " + e); ExitCode = 5;
    } finally {
      KillHelper("host stopping");
    }
  }

  void RunHelperOnce() {
    helperReady = new ManualResetEvent(false);
    helperGone = new ManualResetEvent(false);
    job = Native.CreateJobObject(IntPtr.Zero, null);
    var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (job == IntPtr.Zero || !Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(info)))
      throw new Exception("can't create the job object: " + Marshal.GetLastWin32Error());
    var psi = new ProcessStartInfo(cfg["node"], "\"" + cfg["helper"] + "\"") {
      UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true,
      RedirectStandardError = true, StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false),
      WorkingDirectory = Path.GetDirectoryName(cfg["helper"])
    };
    psi.EnvironmentVariables["HYPERV_MCP_STATE_DIR"] = cfg["stateDir"];
    psi.EnvironmentVariables["HYPERV_MCP_INSTALL_DIR"] = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    // MC-1575: the PowerShell setup ran in (one registered in HKLM), for hv.ps1. An older setup's host.config has none:
    // the helper then finds one itself, the same way.
    if (cfg.ContainsKey("powershell")) psi.EnvironmentVariables["HYPERV_MCP_POWERSHELL"] = cfg["powershell"];
    helper = Process.Start(psi);
    if (!Native.AssignProcessToJobObject(job, helper.Handle)) { Log("can't assign the helper to its job: " + Marshal.GetLastWin32Error()); KillHelper("no job"); return; }
    helperIn = new StreamWriter(helper.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
    var h = helper;
    new Thread(() => ReadHelper(h)) { IsBackground = true }.Start();
    new Thread(() => { try { string l; while ((l = h.StandardError.ReadLine()) != null) Log("helper: " + l); } catch { } }) { IsBackground = true }.Start();
    ToHelper("go");
    Log("helper started, pid " + h.Id);
    int which = WaitHandle.WaitAny(new WaitHandle[] { helperReady, helperGone, stopping }, 30 * 60 * 1000);
    if (which != 0) { KillHelper(which == 1 ? "the helper ended before it was ready" : which == 2 ? "stopping" : "the helper was not ready within 30 minutes"); return; }
    Log("helper ready: opening the pipe");
    var acceptor = new Thread(AcceptLoop) { IsBackground = true };
    acceptor.Start();
    Interlocked.Exchange(ref lastPong, DateTime.UtcNow.Ticks);
    while (true) {
      int w = WaitHandle.WaitAny(new WaitHandle[] { helperGone, stopping }, 10000);
      if (w == 0) { KillHelper("the helper exited or closed its output"); break; }
      if (w == 1) { KillHelper("stopping"); break; }
      if ((DateTime.UtcNow.Ticks - Interlocked.Read(ref lastPong)) > HeartbeatTimeout.Ticks) { KillHelper("the helper missed its heartbeats"); break; }
      ToHelper("ping " + Interlocked.Increment(ref pingN));
    }
    acceptor.Join(5000);
  }

  void ToHelper(string line) {
    lock (helperLock) { try { if (helperIn != null) helperIn.WriteLine(line); } catch { if (helperGone != null) helperGone.Set(); } }
  }

  void ReadHelper(Process h) {
    try {
      string line;
      while ((line = h.StandardOutput.ReadLine()) != null) {
        if (line == "ready") helperReady.Set();
        else if (line.StartsWith("pong ")) Interlocked.Exchange(ref lastPong, DateTime.UtcNow.Ticks);
        else if (line.StartsWith("msg ")) {
          int sp = line.IndexOf(' ', 4);
          int c;
          if (sp > 4 && int.TryParse(line.Substring(4, sp - 4), out c)) {
            Conn conn; lock (gate) conns.TryGetValue(c, out conn);
            if (conn != null) Write(conn, line.Substring(sp + 1));
          }
        }
      }
    } catch { }
    helperGone.Set();
  }

  /** Ends the helper: every client connection closed first, then the whole job (helper and its PowerShells). */
  void KillHelper(string why) {
    Log("ending the helper: " + why);
    List<Conn> all; lock (gate) { all = new List<Conn>(conns.Values); conns.Clear(); }
    foreach (var c in all) Close(c, false);
    lock (helperLock) { try { if (helperIn != null) helperIn.Close(); } catch { } helperIn = null; }
    if (job != IntPtr.Zero) { Native.TerminateJobObject(job, 1); Native.CloseHandle(job); job = IntPtr.Zero; }
    if (helper != null) { try { helper.WaitForExit(10000); } catch { } helper = null; }
    if (helperGone != null) helperGone.Set();
  }

  PipeSecurity Acl() {
    var sec = new PipeSecurity();
    sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
    sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
    sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
    // usersSid: ';'-separated SIDs: the group, and the installing user directly (a new group membership only counts
    // after the user signs in again).
    foreach (var sid in cfg["usersSid"].Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
      sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid.Trim()), PipeAccessRights.ReadWrite & ~PipeAccessRights.CreateNewInstance, AccessControlType.Allow));
    return sec;
  }

  void AcceptLoop() {
    var acl = Acl();
    while (!helperGone.WaitOne(0) && !stopping.WaitOne(0)) {
      NamedPipeServerStream s = null;
      try {
        s = new NamedPipeServerStream(cfg["pipe"], PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
          PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, acl);
        var ar = s.BeginWaitForConnection(null, null);
        int w = WaitHandle.WaitAny(new WaitHandle[] { ar.AsyncWaitHandle, helperGone, stopping });
        if (w != 0) { s.Dispose(); return; }
        s.EndWaitForConnection(ar);
        uint pid; Native.GetNamedPipeClientProcessId(s.SafePipeHandle.DangerousGetHandle(), out pid);
        var conn = new Conn { Id = Interlocked.Increment(ref nextConn), Pipe = s };
        lock (gate) conns[conn.Id] = conn;
        ToHelper("open " + conn.Id + " " + pid);
        new Thread(() => ReadClient(conn)) { IsBackground = true }.Start();
      } catch (Exception e) {
        Log("accept: " + e.Message);
        if (s != null) s.Dispose();
        if (stopping.WaitOne(1000)) return;
      }
    }
  }

  void ReadClient(Conn c) {
    var buf = new byte[65536];
    var line = new MemoryStream();
    try {
      int n;
      while ((n = c.Pipe.Read(buf, 0, buf.Length)) > 0) {
        int start = 0;
        for (int i = 0; i < n; i++) {
          if (buf[i] != (byte)'\n') continue;
          line.Write(buf, start, i - start);
          start = i + 1;
          var text = Encoding.UTF8.GetString(line.GetBuffer(), 0, (int)line.Length).TrimEnd('\r');
          line.SetLength(0);
          if (text.Length > 0) ToHelper("msg " + c.Id + " " + text);
        }
        line.Write(buf, start, n - start);
        if (line.Length > MaxLine) { Log("connection " + c.Id + ": a line over 4 MB, closed"); break; }
      }
    } catch { }
    Close(c, true);
  }

  void Write(Conn c, string text) {
    lock (c.WriteLock) {
      if (c.Closed) return;
      try { var b = Encoding.UTF8.GetBytes(text + "\n"); c.Pipe.Write(b, 0, b.Length); c.Pipe.Flush(); } catch { Close(c, true); }
    }
  }

  void Close(Conn c, bool tellHelper) {
    lock (c.WriteLock) { if (c.Closed) return; c.Closed = true; }
    try { c.Pipe.Dispose(); } catch { }
    bool known; lock (gate) known = conns.Remove(c.Id);
    if (tellHelper && known) ToHelper("close " + c.Id);
  }
}

class HostService : ServiceBase {
  Supervisor sup; Thread t;
  public HostService() { ServiceName = "HyperVMcp"; CanStop = true; }
  protected override void OnStart(string[] args) {
    sup = new Supervisor(AppDomain.CurrentDomain.BaseDirectory);
    t = new Thread(() => { sup.Run(); if (sup.ExitCode != 0) { ExitCode = sup.ExitCode; Environment.Exit(sup.ExitCode); } }) { IsBackground = true };
    t.Start();
  }
  protected override void OnStop() { if (sup != null) sup.Stop(); if (t != null) t.Join(20000); }
}

static class Program {
  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--console") {
      var sup = new Supervisor(AppDomain.CurrentDomain.BaseDirectory);
      Console.CancelKeyPress += (s, e) => { e.Cancel = true; sup.Stop(); };
      sup.Run();
      return sup.ExitCode;
    }
    ServiceBase.Run(new HostService());
    return 0;
  }
}
