// hyper-v MCP (MC-1501; design: docs/linux-guests.md §4, transport A): ssh.exe's ProxyCommand to a Linux guest.
// HvMcpVsock.exe <vmId> <port> connects an AF_HYPERV socket to the VM (by its id) on the vsock port (the service id
// <port as 8 hex digits>-facb-11e6-bd58-64006a7986d3, which a Linux guest's AF_VSOCK listener on that port answers),
// then copies its stdin to the socket and the socket to its stdout until either side closes. Nothing else: no
// network, no other argument. Compiled by setup (the in-box .NET Framework compiler) into Program Files, where only
// Administrators can write; the helper names it in ssh.exe's fixed arguments.
// MC-1545: the connect is bounded (20 s, "connect timed out"), and stderr says when it completed and how the socket
// closed, with the bytes each way, so a build that never gets an SSH answer can say which side stopped.
// MC-1549: stdin and stdout are read and written with ReadFile/WriteFile and an OVERLAPPED (StdPipe below), never
// .NET's Console streams. Win32-OpenSSH hands its ProxyCommand overlapped pipe handles, and a synchronous ReadFile on
// one is unsupported: the old bridge passed ssh.exe's first write (its banner) and then nothing, so key exchange
// stalled. An OVERLAPPED with its own event works on overlapped and synchronous handles alike.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;

// A one-way stream over a standard handle (pipe, file or console), every call through an OVERLAPPED and an event,
// waited on with GetOverlappedResult. Reads end (0) on a broken pipe or end of file. One call at a time per stream.
sealed class StdPipe : Stream
{
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateEvent(IntPtr attrs, bool manualReset, bool initial, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ResetEvent(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr h, IntPtr buf, int n, IntPtr done, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr h, IntPtr buf, int n, IntPtr done, IntPtr ov);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetOverlappedResult(IntPtr h, IntPtr ov, out int done, bool wait);

    const int ERROR_HANDLE_EOF = 38, ERROR_BROKEN_PIPE = 109, ERROR_NO_DATA = 232, ERROR_IO_PENDING = 997;
    const int BUF = 65536;
    readonly IntPtr handle, ev, ov, buf;
    readonly bool reading;

    public StdPipe(int which, bool reading)
    {
        this.reading = reading;
        handle = GetStdHandle(which);
        if (handle == IntPtr.Zero || handle == new IntPtr(-1)) throw new IOException("no standard " + (reading ? "input" : "output"));
        ev = CreateEvent(IntPtr.Zero, true, false, null);
        if (ev == IntPtr.Zero) throw new Win32Exception();
        ov = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(NativeOverlapped)));
        buf = Marshal.AllocHGlobal(BUF);
    }

    // Starts the call with a zeroed OVERLAPPED and its event, and waits for it. Returns the bytes moved, or -1 at the end.
    int Call(int n)
    {
        var o = new NativeOverlapped();
        o.EventHandle = ev;
        Marshal.StructureToPtr(o, ov, false);
        ResetEvent(ev);
        bool ok = reading ? ReadFile(handle, buf, n, IntPtr.Zero, ov) : WriteFile(handle, buf, n, IntPtr.Zero, ov);
        if (!ok)
        {
            int e = Marshal.GetLastWin32Error();
            if (e == ERROR_BROKEN_PIPE || e == ERROR_HANDLE_EOF || e == ERROR_NO_DATA) return -1;
            if (e != ERROR_IO_PENDING) throw new Win32Exception(e);
        }
        int done;
        if (!GetOverlappedResult(handle, ov, out done, true))
        {
            int e = Marshal.GetLastWin32Error();
            if (e == ERROR_BROKEN_PIPE || e == ERROR_HANDLE_EOF || e == ERROR_NO_DATA) return -1;
            throw new Win32Exception(e);
        }
        return done;
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (!reading) throw new NotSupportedException();
        for (;;)
        {
            int n = Call(Math.Min(count, BUF));
            if (n < 0) return 0;
            if (n == 0) continue; // a zero-length message on a message pipe, not the end
            Marshal.Copy(buf, buffer, offset, n);
            return n;
        }
    }

    public override void Write(byte[] buffer, int offset, int count)
    {
        if (reading) throw new NotSupportedException();
        while (count > 0)
        {
            int n = Math.Min(count, BUF);
            Marshal.Copy(buffer, offset, buf, n);
            int done = Call(n);
            if (done <= 0) throw new IOException("standard output closed");
            offset += done; count -= done;
        }
    }

    public override bool CanRead { get { return reading; } }
    public override bool CanWrite { get { return !reading; } }
    public override bool CanSeek { get { return false; } }
    public override void Flush() { }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
    public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
    public override void SetLength(long v) { throw new NotSupportedException(); }
}

static class HvMcpVsock
{
    const AddressFamily AF_HYPERV = (AddressFamily)34;
    const ProtocolType HV_PROTOCOL_RAW = (ProtocolType)1;
    const int CONNECT_MS = 20000;

    // SOCKADDR_HV: family (2 bytes), reserved (2), VM id (16), service id (16).
    sealed class HvEndPoint : EndPoint
    {
        readonly Guid vm, service;
        public HvEndPoint(Guid vm, Guid service) { this.vm = vm; this.service = service; }
        public override AddressFamily AddressFamily { get { return AF_HYPERV; } }
        public override SocketAddress Serialize()
        {
            var a = new SocketAddress(AF_HYPERV, 36);
            byte[] v = vm.ToByteArray(), s = service.ToByteArray();
            for (int i = 0; i < 16; i++) { a[4 + i] = v[i]; a[20 + i] = s[i]; }
            return a;
        }
        public override EndPoint Create(SocketAddress sa) { return this; }
    }

    static long bytesIn, bytesOut;

    // Copies from one stream to another, counting the bytes, until the source ends or fails.
    static void Pump(Stream from, Stream to, bool counted, bool inbound)
    {
        var buf = new byte[65536];
        try
        {
            int n;
            while ((n = from.Read(buf, 0, buf.Length)) > 0)
            {
                to.Write(buf, 0, n);
                to.Flush();
                if (counted) { if (inbound) Interlocked.Add(ref bytesIn, n); else Interlocked.Add(ref bytesOut, n); }
            }
        }
        catch (Exception) { }
    }

    static int Main(string[] args)
    {
        Guid vm;
        int port;
        if (args.Length != 2 || !Guid.TryParse(args[0], out vm) || !int.TryParse(args[1], out port) || port < 1 || port > 65535)
        {
            Console.Error.WriteLine("usage: HvMcpVsock.exe <vmId> <port>");
            return 2;
        }
        var service = new Guid(port.ToString("x8") + "-facb-11e6-bd58-64006a7986d3");
        var clock = Stopwatch.StartNew();
        Socket sock;
        try
        {
#if HVMCP_TEST
            // MC-1549: test builds only (csc -define:HVMCP_TEST, by the tests, never by setup): the VM id
            // 00000000-0000-0000-0000-000000000000 means TCP to 127.0.0.1:<port>, a local fake SSH server, so the
            // stdin/stdout side can be proven with the real ssh.exe and no VM.
            EndPoint target = vm == Guid.Empty ? (EndPoint)new IPEndPoint(IPAddress.Loopback, port) : new HvEndPoint(vm, service);
            sock = vm == Guid.Empty ? new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp) : new Socket(AF_HYPERV, SocketType.Stream, HV_PROTOCOL_RAW);
            var ar = sock.BeginConnect(target, null, null);
#else
            sock = new Socket(AF_HYPERV, SocketType.Stream, HV_PROTOCOL_RAW);
            var ar = sock.BeginConnect(new HvEndPoint(vm, service), null, null);
#endif
            if (!ar.AsyncWaitHandle.WaitOne(CONNECT_MS))
            {
                try { sock.Close(); } catch (Exception) { }
                Console.Error.WriteLine("HvMcpVsock: connect timed out after " + clock.ElapsedMilliseconds + " ms (vsock port " + port + ")");
                return 255;
            }
            sock.EndConnect(ar);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("HvMcpVsock: can't connect to the guest's vsock port " + port + ": " + e.Message);
            return 255;
        }
        Console.Error.WriteLine("HvMcpVsock: connected to " + vm + ":" + port + " after " + clock.ElapsedMilliseconds + " ms");
        var net = new NetworkStream(sock, true);
        Stream stdin = new StdPipe(-10, true), stdout = new StdPipe(-11, false);
        var up = new Thread(() =>
        {
            Pump(stdin, net, true, false);
            try { sock.Shutdown(SocketShutdown.Send); } catch (Exception) { }
        });
        up.IsBackground = true;
        up.Start();
        Pump(net, stdout, true, true);
        try { sock.Close(); } catch (Exception) { }
        Console.Error.WriteLine("HvMcpVsock: closed after " + clock.ElapsedMilliseconds + " ms, " + Interlocked.Read(ref bytesIn) + " bytes in, " + Interlocked.Read(ref bytesOut) + " bytes out");
        return 0;
    }
}
