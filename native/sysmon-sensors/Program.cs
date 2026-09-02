using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using LibreHardwareMonitor.Hardware;

namespace VoiceInkSensors
{
    /// <summary>
    /// VoiceInk 的感測器 sidecar。
    ///
    /// 用法：VoiceInkSensors.exe \\.\pipe\voiceink-sensors-&lt;亂數&gt;
    /// 主程式先建好管道伺服器再用 Start-Process -Verb RunAs 拉起這支；管道名就是共享密鑰
    /// （128 bit 亂數），而且主程式只接受第一個連線。
    ///
    /// 輸出是一行一個 JSON：
    ///   {"t":1730000000000,"h":[{"n":"AMD Ryzen 7 5700X","t":"Cpu",
    ///                            "s":[{"n":"Core (Tctl/Tdie)","t":"Temperature","v":52.3}]}]}
    /// 每一框另外帶 "c"：可寫入的 PWM 通道（風扇控制用）。
    ///
    /// 管道是**雙向**的：主程式可以送指令進來（一行一個，空白分隔，不用 JSON——
    /// 指令只有四種、識別碼不含空白，自己 split 比拉一包序列化器省事）：
    ///   S &lt;identifier&gt; &lt;0~100&gt;   把該通道設成手動 PWM
    ///   D &lt;identifier&gt;            該通道交還（LHM 的 SetDefault）
    ///   R                          全部交還
    ///   P                          心跳
    /// 交還完成後回一行 {"reset":1}，主程式靠它知道可以安全結束了。
    ///
    /// **看門狗**：只要我們寫過任何一條通道，超過 WatchdogMs 沒收到任何指令就自己
    /// 全部交還並結束。手動 PWM 是**留在晶片裡的**（實測硬殺程序後仍在），
    /// 沒有這道保險，主程式被硬殺就會把風扇永久釘在最後的轉速。
    ///
    /// 缺 PawnIO 核心驅動時先送一行 {"warn":"pawnio"} 再照常送資料（GPU 與硬碟溫度
    /// 不需要它）；連 Computer.Open() 都失敗才送 {"error":"driver"} 並結束。
    /// 主程式會據此顯示「下一步該做什麼」，而不是讓整頁空著。
    ///
    /// 刻意不用 System.Text.Json：這裡的結構是固定的，手動組字串省掉一整包反射依賴，
    /// 單檔發佈也不必擔心裁剪把序列化器裁掉。
    /// </summary>
    internal static class Program
    {
        private const int IntervalMs = 1000;
        private const int ConnectTimeoutMs = 20000;
        /// 主程式那邊沒人讀就自己結束，別變成孤兒程序
        private const int WriteFailuresBeforeExit = 3;
        /// 我們寫過風扇之後，多久沒聽到主程式就自己交還（主程式每秒送一次心跳）
        private const int WatchdogMs = 5000;

        private static readonly object Gate = new object();
        private static readonly Dictionary<string, ISensor> Controls = new Dictionary<string, ISensor>(StringComparer.Ordinal);
        /// 被我們接管的通道；空的時候看門狗不作用（純讀感測器的用法要能一直跑）
        private static readonly HashSet<string> Overridden = new HashSet<string>(StringComparer.Ordinal);
        /// 同一顆硬體上同 Index 的轉速感測器（可能沒有，例如沒插風扇的接頭）
        private static readonly Dictionary<string, ISensor> Fans = new Dictionary<string, ISensor>(StringComparer.Ordinal);
        private static long _lastCommandAt;

        private static int Main(string[] args)
        {
            if (args.Length < 1 || string.IsNullOrWhiteSpace(args[0]))
            {
                return 2;
            }

            // 排程工作的動作在註冊時就寫死（改參數要再提權一次），所以管道名改用交接檔傳：
            // 主程式寫檔 → schtasks /run → 我們讀完立刻刪。直接給管道名的舊用法
            // （-Verb RunAs 退路、probe 腳本）照樣支援。
            string pipeName = args[0];
            if (pipeName.EndsWith(".txt", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    string handoff = pipeName;
                    pipeName = File.ReadAllText(handoff).Trim();
                    try { File.Delete(handoff); } catch { /* 刪不掉不影響本次連線 */ }
                }
                catch
                {
                    return 5;
                }
                if (string.IsNullOrWhiteSpace(pipeName)) return 5;
            }
            // .NET 的 NamedPipeClientStream 只吃名稱本身，不吃 \\.\pipe\ 前綴
            const string prefix = @"\\.\pipe\";
            if (pipeName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                pipeName = pipeName.Substring(prefix.Length);
            }

            // InOut：主程式要能把風扇指令送進來（方向給錯 Connect 會直接失敗）。
            //
            // **PipeOptions.Asynchronous 不可省**：不帶它，Windows 開出來的是非 overlapped handle，
            // 同一個 handle 上的同步讀會**把同步寫整個擋住**——讀取執行緒一卡進 ReadLine()，
            // 主迴圈的 WriteLine 就再也送不出去，主程式只會收到「reader 開始讀之前」的那一框，
            // 之後永遠停在「感測器沒有連線」。而且它不報錯：管道是通的、程序活著、
            // 只是資料再也不來（實測主程式端 60 秒收到 1 框；主程式每秒送心跳時反而正常，
            // 因為每顆心跳都讓 ReadLine 返回一次，剛好把寫入的縫隙打開，看起來像「有時候會動」）。
            using var pipe = new NamedPipeClientStream(
                ".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                pipe.Connect(ConnectTimeoutMs);
            }
            catch
            {
                return 3;
            }

            using var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };

            // LibreHardwareMonitor 0.9.4 起把 WinRing0 換成 PawnIO（另一顆已簽章、
            // 相容記憶體完整性的核心驅動），但它**必須另外安裝**。沒裝的時候 LHM
            // 不會報錯，只會讓 CPU／主機板的每一個讀數都變成 0——看起來像「這台機器
            // 沒有這顆感測器」，實際上是缺驅動。所以先自己探一下，好回一個講得清楚的原因。
            // 我們**不代裝核心驅動**：那必須是使用者自己按下去的決定。
            // 注意這是**警告不是致命錯誤**：沒有 PawnIO 也還是拿得到 GPU 溫度（NVML）
            // 與硬碟 SMART 溫度，那些只需要系統管理員。所以照樣繼續送資料。
            if (!PreparePawnIo())
            {
                TryWrite(writer, "{\"warn\":\"pawnio\"}");
            }

            var computer = new Computer
            {
                IsCpuEnabled = true,
                IsGpuEnabled = true,
                IsMemoryEnabled = true,
                IsMotherboardEnabled = true,
                IsControllerEnabled = true,
                IsStorageEnabled = true,
                IsPsuEnabled = true
            };

            try
            {
                computer.Open();
            }
            catch
            {
                // 幾乎一定是核心驅動載不起來：弱點驅動封鎖清單、HVCI，或防毒把它隔離了
                TryWrite(writer, "{\"error\":\"driver\"}");
                return 4;
            }

            var visitor = new UpdateVisitor();
            int writeFailures = 0;
            var builder = new StringBuilder(16 * 1024);

            // 先跑一輪才索引得到控制通道（LHM 要 Update 過才會把感測器物件建出來）
            try { computer.Accept(visitor); } catch { /* 下一輪還會再試 */ }
            IndexControls(computer);
            _lastCommandAt = Environment.TickCount64;

            var reader = new Thread(() => ReadCommands(pipe, writer)) { IsBackground = true };
            reader.Start();

            try
            {
                while (writeFailures < WriteFailuresBeforeExit)
                {
                    lock (Gate)
                    {
                        try
                        {
                            computer.Accept(visitor);
                        }
                        catch
                        {
                            // 單輪讀取失敗（某個感測器暫時不回應）不該讓整支結束
                        }

                        builder.Clear();
                        BuildPayload(builder, computer);
                    }

                    try
                    {
                        writer.WriteLine(builder.ToString());
                        writeFailures = 0;
                    }
                    catch
                    {
                        writeFailures++;
                    }

                    if (!pipe.IsConnected)
                    {
                        break;
                    }

                    // 看門狗：只有在我們真的接管過風扇時才作用——純讀感測器的用法沒有心跳，
                    // 不能因此被關掉。主程式被硬殺時，這是唯一會把風扇交還的機制。
                    lock (Gate)
                    {
                        if (Overridden.Count > 0
                            && Environment.TickCount64 - _lastCommandAt > WatchdogMs)
                        {
                            RestoreAll();
                            break;
                        }
                    }

                    Thread.Sleep(IntervalMs);
                }
            }
            finally
            {
                // 交還一定要排在 Close 之前：Close 之後控制物件就不能用了
                lock (Gate) { RestoreAll(); }
                try { computer.Close(); } catch { /* 關不掉就算了，程序要結束了 */ }
            }

            return 0;
        }

        /// <summary>
        /// 找出 PawnIO 核心驅動的使用者態程式庫，並讓 LoadLibrary 找得到它。
        ///
        /// PawnIO 2.2.0 把 <c>PawnIOLib.dll</c> 裝在 <c>%ProgramFiles%\PawnIO\</c>，而且
        /// **不會把那個目錄加進 PATH**——所以即使裝好了、驅動也在跑，
        /// LibreHardwareMonitor 的 <c>LoadLibrary("PawnIOLib.dll")</c> 仍然會失敗，
        /// 症狀跟完全沒裝一模一樣（CPU 那一整組讀數安靜地變成 0）。
        /// 舊版本裝在 System32，所以兩個位置都要找。
        /// </summary>
        /// <returns>找得到就 true（並已加進本程序的 PATH）</returns>
        private static bool PreparePawnIo()
        {
            string[] candidates =
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "PawnIOLib.dll"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PawnIO", "PawnIOLib.dll")
            };
            foreach (string candidate in candidates)
            {
                if (!File.Exists(candidate)) continue;
                string dir = Path.GetDirectoryName(candidate);
                if (!string.IsNullOrEmpty(dir))
                {
                    // 只改本程序的環境變數，不動系統設定
                    Environment.SetEnvironmentVariable(
                        "PATH", dir + ";" + Environment.GetEnvironmentVariable("PATH"));
                }
                return true;
            }
            return false;
        }

        /// <summary>
        /// 建立「可寫入的 PWM 通道」索引。identifier（例如 <c>/lpc/it8688e/0/control/0</c>）
        /// 是主程式唯一認得的 key——它不含空白，所以指令用空白分隔就夠了。
        /// 順便把同一顆硬體上同 Index 的轉速感測器配起來，好一起回報 RPM。
        /// </summary>
        private static void IndexControls(Computer computer)
        {
            lock (Gate)
            {
                Controls.Clear();
                Fans.Clear();
                foreach (IHardware hardware in computer.Hardware) IndexHardware(hardware);
            }
        }

        private static void IndexHardware(IHardware hardware)
        {
            foreach (ISensor sensor in hardware.Sensors)
            {
                if (sensor.SensorType == SensorType.Control && sensor.Control != null)
                {
                    Controls[sensor.Identifier.ToString()] = sensor;
                }
            }
            // 兩趟：控制與轉速的列舉順序不保證，先收齊控制才配得到
            foreach (ISensor sensor in hardware.Sensors)
            {
                if (sensor.SensorType != SensorType.Fan) continue;
                foreach (var pair in Controls)
                {
                    if (pair.Value.Hardware == hardware && pair.Value.Index == sensor.Index)
                    {
                        Fans[pair.Key] = sensor;
                        break;
                    }
                }
            }
            foreach (IHardware sub in hardware.SubHardware) IndexHardware(sub);
        }

        /// <summary>
        /// 指令讀取執行緒。一行一個指令，空白分隔（見類別註解）。
        /// 未知指令一律忽略——這條管道只有主程式連得上，但還是不要對格式做假設。
        /// </summary>
        private static void ReadCommands(NamedPipeClientStream pipe, StreamWriter writer)
        {
            try
            {
                using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true);
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    _lastCommandAt = Environment.TickCount64;
                    string[] parts = line.Trim().Split(' ');
                    if (parts.Length == 0 || parts[0].Length == 0) continue;
                    switch (parts[0])
                    {
                        case "P":
                            break;
                        case "S" when parts.Length >= 3:
                            ApplyControl(parts[1], parts[2]);
                            break;
                        case "D" when parts.Length >= 2:
                            ApplyControl(parts[1], null);
                            break;
                        case "R":
                            lock (Gate) { RestoreAll(); }
                            // 主程式靠這一行知道風扇已經交還、可以安全收掉我們了
                            lock (Gate) { TryWrite(writer, "{\"reset\":1}"); }
                            break;
                    }
                }
            }
            catch
            {
                // 管道斷了：主迴圈的 IsConnected 與看門狗會把風扇交還後結束
            }
        }

        /// <param name="raw">0~100 的字串；null 代表交還給 BIOS（LHM 的 SetDefault）</param>
        private static void ApplyControl(string identifier, string raw)
        {
            lock (Gate)
            {
                if (!Controls.TryGetValue(identifier, out ISensor sensor) || sensor.Control == null) return;
                try
                {
                    if (raw == null)
                    {
                        sensor.Control.SetDefault();
                        Overridden.Remove(identifier);
                        return;
                    }
                    if (!float.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out float value)) return;
                    // 夾在硬體自己講的範圍內（NVIDIA 的下限是 30%，送 0 會被拒）
                    float min = sensor.Control.MinSoftwareValue;
                    float max = sensor.Control.MaxSoftwareValue;
                    if (value < min) value = min;
                    if (value > max) value = max;
                    sensor.Control.SetSoftware(value);
                    Overridden.Add(identifier);
                }
                catch
                {
                    // 單一通道寫不進去（晶片被別的軟體佔著）不該讓整支倒掉
                }
            }
        }

        /// <summary>把所有被我們接管的通道交還。呼叫端要自己拿 Gate。</summary>
        private static void RestoreAll()
        {
            foreach (string identifier in new List<string>(Overridden))
            {
                if (!Controls.TryGetValue(identifier, out ISensor sensor)) continue;
                try { sensor.Control?.SetDefault(); } catch { /* 盡力而為 */ }
            }
            Overridden.Clear();
        }

        private static void TryWrite(StreamWriter writer, string line)
        {
            try { writer.WriteLine(line); } catch { /* 對方已經走了 */ }
        }

        private static void BuildPayload(StringBuilder sb, Computer computer)
        {
            sb.Append("{\"t\":")
              .Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture))
              .Append(",\"h\":[");

            bool firstHardware = true;
            foreach (IHardware hardware in computer.Hardware)
            {
                firstHardware = AppendHardware(sb, hardware, firstHardware);
                foreach (IHardware sub in hardware.SubHardware)
                {
                    firstHardware = AppendHardware(sb, sub, firstHardware);
                }
            }

            sb.Append("],\"c\":[");

            bool firstControl = true;
            foreach (var pair in Controls)
            {
                ISensor sensor = pair.Value;
                Fans.TryGetValue(pair.Key, out ISensor fan);
                if (!firstControl) sb.Append(',');
                firstControl = false;
                sb.Append("{\"id\":").Append(JsonString(pair.Key))
                  .Append(",\"n\":").Append(JsonString(sensor.Name))
                  .Append(",\"hw\":").Append(JsonString(sensor.Hardware.Name))
                  .Append(",\"pwm\":").Append(Num(sensor.Value))
                  .Append(",\"rpm\":").Append(Num(fan?.Value))
                  .Append(",\"min\":").Append(Num(sensor.Control?.MinSoftwareValue))
                  .Append(",\"max\":").Append(Num(sensor.Control?.MaxSoftwareValue))
                  .Append(",\"o\":").Append(Overridden.Contains(pair.Key) ? "true" : "false")
                  .Append('}');
            }

            sb.Append("]}");
        }

        /// 讀不到就送 null——送 0 會在畫面上變成「轉速 0」，那是完全不同的意思
        private static string Num(float? value)
        {
            if (!value.HasValue || float.IsNaN(value.Value)) return "null";
            return value.Value.ToString("0.###", CultureInfo.InvariantCulture);
        }

        /// <returns>下一筆是不是還是「第一筆」（沒有感測器的硬體會被整個略過）</returns>
        private static bool AppendHardware(StringBuilder sb, IHardware hardware, bool first)
        {
            var sensors = new StringBuilder();
            bool firstSensor = true;
            foreach (ISensor sensor in hardware.Sensors)
            {
                // Value 是 float?，還沒讀到值時是 null——送 0 會在畫面上變成「溫度 0 度」
                if (!sensor.Value.HasValue || float.IsNaN(sensor.Value.Value))
                {
                    continue;
                }
                if (!firstSensor) sensors.Append(',');
                firstSensor = false;
                sensors.Append("{\"n\":").Append(JsonString(sensor.Name))
                       .Append(",\"t\":").Append(JsonString(sensor.SensorType.ToString()))
                       .Append(",\"v\":")
                       .Append(sensor.Value.Value.ToString("0.###", CultureInfo.InvariantCulture))
                       .Append('}');
            }

            if (firstSensor)
            {
                return first;
            }

            if (!first) sb.Append(',');
            sb.Append("{\"n\":").Append(JsonString(hardware.Name))
              .Append(",\"t\":").Append(JsonString(hardware.HardwareType.ToString()))
              .Append(",\"s\":[").Append(sensors).Append("]}");
            return false;
        }

        private static string JsonString(string value)
        {
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        /// <summary>
        /// LibreHardwareMonitor 的讀值方式：每一輪都要 Accept 一次 visitor，
        /// 只呼叫一次的話 sensor.Value 之後就不會再更新了。
        /// </summary>
        private sealed class UpdateVisitor : IVisitor
        {
            public void VisitComputer(IComputer computer) => computer.Traverse(this);

            public void VisitHardware(IHardware hardware)
            {
                hardware.Update();
                foreach (IHardware sub in hardware.SubHardware) sub.Accept(this);
            }

            public void VisitSensor(ISensor sensor) { }

            public void VisitParameter(IParameter parameter) { }
        }
    }
}
