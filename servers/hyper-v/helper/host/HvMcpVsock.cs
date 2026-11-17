// hyper-v MCP (MC-1501; design: docs/linux-guests.md §4, transport A): ssh.exe's ProxyCommand to a Linux guest.
// HvMcpVsock.exe <vmId> <port> connects an AF_HYPERV socket to the VM (by its id) on the vsock port (the service id
// <port as 8 hex digits>-facb-11e6-bd58-64006a7986d3, which a Linux guest's AF_VSOCK listener on that port answers),
// then copies its stdin to the socket and the socket to its stdout until either side closes. Nothing else: no
// network, no other argument. Compiled by setup (the in-box .NET Framework compiler) into Program Files, where only
// Administrators can write; the helper names it in ssh.exe's fixed arguments.
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;

static class HvMcpVsock
{
    const AddressFamily AF_HYPERV = (AddressFamily)34;
    const ProtocolType HV_PROTOCOL_RAW = (ProtocolType)1;

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
        Socket sock;
        try
        {
            sock = new Socket(AF_HYPERV, SocketType.Stream, HV_PROTOCOL_RAW);
            sock.Connect(new HvEndPoint(vm, service));
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("HvMcpVsock: can't connect to the guest's vsock port " + port + ": " + e.Message);
            return 255;
        }
        var net = new NetworkStream(sock, true);
        Stream stdin = Console.OpenStandardInput(), stdout = Console.OpenStandardOutput();
        var up = new Thread(() =>
        {
            try { stdin.CopyTo(net); } catch (Exception) { }
            try { sock.Shutdown(SocketShutdown.Send); } catch (Exception) { }
        });
        up.IsBackground = true;
        up.Start();
        try { net.CopyTo(stdout); stdout.Flush(); } catch (Exception) { }
        try { sock.Close(); } catch (Exception) { }
        return 0;
    }
}
