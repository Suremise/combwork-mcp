// hyper-v MCP (MC-1501; design: docs/linux-guests.md §4, transport A): ssh.exe's ProxyCommand to a Linux guest.
// HvMcpVsock.exe <vmId> <port> connects an AF_HYPERV socket to the VM (by its id) on the vsock port (the service id
// <port as 8 hex digits>-facb-11e6-bd58-64006a7986d3, which a Linux guest's AF_VSOCK listener on that port answers),
// then copies its stdin to the socket and the socket to its stdout until either side closes. Nothing else: no
// network, no other argument. Compiled by setup (the in-box .NET Framework compiler) into Program Files, where only
// Administrators can write; the helper names it in ssh.exe's fixed arguments.
// MC-1545: the connect is bounded (20 s, "connect timed out"), and stderr says when it completed and how the socket
// closed, with the bytes each way, so a build that never gets an SSH answer can say which side stopped.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;

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
            sock = new Socket(AF_HYPERV, SocketType.Stream, HV_PROTOCOL_RAW);
            var ar = sock.BeginConnect(new HvEndPoint(vm, service), null, null);
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
        Stream stdin = Console.OpenStandardInput(), stdout = Console.OpenStandardOutput();
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
