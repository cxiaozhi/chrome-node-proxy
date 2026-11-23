using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class ProxyHost
{
    private const int MaxMessage = 262144;
    private const int MaxTests = 6;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxMessage, RecursionLimit = 16 };
    private static readonly HashSet<string> TestTypes = new HashSet<string>(StringComparer.Ordinal) { "ss", "vmess", "http", "socks5" };
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly HashSet<string> Types = new HashSet<string>(StringComparer.Ordinal) { "ss", "vmess" };

    private static int Main()
    {
        using (var input = new BinaryReader(Console.OpenStandardInput()))
        using (var output = new BinaryWriter(Console.OpenStandardOutput()))
        using (var job = CreateJobObject(IntPtr.Zero, null))
        {
            string directory = null;
            try
            {
                ConfigureJob(job);
                int length = input.ReadInt32();
                if (length <= 0 || length > MaxMessage) return 1;
                byte[] bytes = input.ReadBytes(length);
                if (bytes.Length != length) return 1;
                var request = Json.DeserializeObject(Utf8.GetString(bytes)) as Dictionary<string, object>;
                if (request == null) return 1;
                if (Object.Equals(Get(request, "action"), "check"))
                {
                    Write(output, new { ok = File.Exists(CorePath()), version = 2 });
                    return 0;
                }
                bool testing = Object.Equals(Get(request, "action"), "test");
                if (!testing && !Object.Equals(Get(request, "action"), "start")) return 1;
                var proxies = testing ? ReadTestNodes(request) : ReadActiveNode(request);
                int port = GetLocalPort();
                string secret = Guid.NewGuid().ToString("N");
                directory = Path.Combine(Path.GetTempPath(), "direct-proxy-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(directory);
                var config = new Dictionary<string, object> {
                    { "allow-lan", false }, { "mode", "rule" }, { "log-level", "silent" },
                    { "find-process-mode", "off" }, { "proxies", proxies }
                };
                if (testing)
                {
                    config["external-controller"] = "127.0.0.1:" + port;
                    config["secret"] = secret;
                }
                else
                {
                    config["socks-port"] = port;
                    config["rules"] = new[] { "MATCH,SELECTED" };
                }
                string configPath = Path.Combine(directory, "config.json");
                File.WriteAllText(configPath, Json.Serialize(config), Utf8);
                using (var core = StartCore(directory, configPath))
                {
                    try
                    {
                        if (!AssignProcessToJobObject(job, core.Handle)) throw new IOException("Failed to own proxy process.");
                        WaitForListener(core, port, testing);
                        File.Delete(configPath);
                        if (testing)
                        {
                            Write(output, new { ok = true, results = Measure(proxies, port, secret) });
                            return 0;
                        }
                        Write(output, new { ok = true, port = port });
                        var closed = new ManualResetEvent(false);
                        var watcher = new Thread(() => {
                            try { input.BaseStream.ReadByte(); }
                            catch (IOException) { }
                            finally { closed.Set(); }
                        });
                        watcher.IsBackground = true;
                        watcher.Start();
                        while (!closed.WaitOne(250) && !core.HasExited) { }
                    }
                    finally
                    {
                        if (!core.HasExited) { core.Kill(); core.WaitForExit(3000); }
                    }
                }
                return 0;
            }
            catch (Exception)
            {
                try { Write(output, new { ok = false, error = "本机代理启动失败，请检查节点配置。" }); }
                catch (IOException) { }
                return 1;
            }
            finally
            {
                if (directory != null)
                {
                    try
                    {
                        File.Delete(Path.Combine(directory, "config.json"));
                        File.Delete(Path.Combine(directory, "cache.db"));
                        Directory.Delete(directory, false);
                    }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }
            }
        }
    }

    private static object Get(Dictionary<string, object> values, string key)
    {
        object value;
        return values.TryGetValue(key, out value) ? value : null;
    }

    private static Dictionary<string, object>[] ReadActiveNode(Dictionary<string, object> request)
    {
        var proxy = Get(request, "proxy") as Dictionary<string, object>;
        Validate(proxy, Types);
        proxy["name"] = "SELECTED";
        return new[] { proxy };
    }

    private static Dictionary<string, object>[] ReadTestNodes(Dictionary<string, object> request)
    {
        var nodes = Get(request, "proxies") as System.Collections.IList;
        if (nodes == null || nodes.Count < 1 || nodes.Count > MaxTests) throw new InvalidDataException();
        var proxies = new Dictionary<string, object>[nodes.Count];
        for (int index = 0; index < nodes.Count; index++)
        {
            var proxy = nodes[index] as Dictionary<string, object>;
            Validate(proxy, TestTypes);
            proxy["name"] = "TEST-" + index;
            proxies[index] = proxy;
        }
        return proxies;
    }

    private static int?[] Measure(Dictionary<string, object>[] proxies, int port, string secret)
    {
        string url = "https://www.gstatic.com/generate_204";
#if PROXY_TEST
        url = Environment.GetEnvironmentVariable("DIRECT_PROXY_TEST_URL") ?? url;
#endif
        string query = "?timeout=5000&expected=204&url=" + Uri.EscapeDataString(url);
        var results = new int?[proxies.Length];
        Parallel.For(0, proxies.Length, index => {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/proxies/TEST-" + index + "/delay" + query);
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.ServicePoint.ConnectionLimit = MaxTests;
            request.Timeout = 7500;
            request.ReadWriteTimeout = 7500;
            request.Headers[HttpRequestHeader.Authorization] = "Bearer " + secret;
            try
            {
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    var result = new JavaScriptSerializer().DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
                    if (result != null && Get(result, "delay") is int) results[index] = (int)result["delay"];
                }
            }
            catch (WebException error) { if (error.Response != null) error.Response.Close(); }
            catch (InvalidOperationException) { }
        });
        return results;
    }

    private static void Validate(Dictionary<string, object> node, HashSet<string> types)
    {
        if (node == null || !types.Contains(Get(node, "type") as string) ||
            String.IsNullOrWhiteSpace(Get(node, "server") as string) || !(Get(node, "port") is int))
            throw new InvalidDataException();
        int port = (int)node["port"];
        if (port < 1 || port > 65535) throw new InvalidDataException();
    }

    private static void Write(BinaryWriter output, object message)
    {
        var encoded = Utf8.GetBytes(Json.Serialize(message));
        output.Write(encoded.Length);
        output.Write(encoded);
        output.Flush();
    }

    private static string CorePath() { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "mihomo.exe"); }

    private static Process StartCore(string directory, string config)
    {
        var start = new ProcessStartInfo(CorePath(), "-d \"" + directory + "\" -f \"" + config + "\"") {
            UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        var process = Process.Start(start);
        process.OutputDataReceived += delegate { };
        process.ErrorDataReceived += delegate { };
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static int GetLocalPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }

    private static void WaitForListener(Process process, int port, bool testing)
    {
        var timer = Stopwatch.StartNew();
        while (!process.HasExited && timer.ElapsedMilliseconds < 8000)
        {
            try
            {
                // Match the listening PID as well as the SOCKS handshake, before giving Chrome the port.
                if (OwnsPort(process.Id, port))
                {
                    using (var client = new TcpClient())
                    {
                        client.ReceiveTimeout = 350;
                        client.SendTimeout = 350;
                        client.Connect(IPAddress.Loopback, port);
                        if (testing) return;
                        var stream = client.GetStream();
                        stream.Write(new byte[] { 5, 1, 0 }, 0, 3);
                        if (stream.ReadByte() == 5 && stream.ReadByte() == 0 && !process.HasExited) return;
                    }
                }
            }
            catch (SocketException) { }
            catch (IOException) { }
            Thread.Sleep(60);
        }
        throw new IOException("Proxy did not bind its port.");
    }

    private static bool OwnsPort(int pid, int port)
    {
        int bytes = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref bytes, false, 2, 3, 0);
        if (bytes < 4) return false;
        var table = Marshal.AllocHGlobal(bytes);
        try
        {
            if (GetExtendedTcpTable(table, ref bytes, false, 2, 3, 0) != 0) return false;
            int count = Marshal.ReadInt32(table);
            for (int row = 0; row < count && row < (bytes - 4) / 24; row++)
            {
                int offset = 4 + row * 24;
                int address = Marshal.ReadInt32(table, offset + 4);
                int networkPort = Marshal.ReadInt32(table, offset + 8);
                int owner = Marshal.ReadInt32(table, offset + 20);
                if (address == 0x0100007f && owner == pid &&
                    (ushort)IPAddress.NetworkToHostOrder((short)networkPort) == port) return true;
            }
            return false;
        }
        finally { Marshal.FreeHGlobal(table); }
    }

    private static void ConfigureJob(SafeFileHandle job)
    {
        if (job.IsInvalid) throw new IOException("Could not create Windows job.");
        int size = IntPtr.Size == 8 ? 144 : 112;
        var data = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.Copy(new byte[size], 0, data, size);
            Marshal.WriteInt32(data, 16, 0x2000); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, data, (uint)size)) throw new IOException("Could not configure Windows job.");
        }
        finally { Marshal.FreeHGlobal(data); }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int info, IntPtr data, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("iphlpapi.dll")]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int type, int reserved);
}
