using System;
using System.Globalization;
using System.IO;
using System.Text;
using LibreHardwareMonitor.Hardware;

namespace VoiceInkSensors
{
    /// <summary>
    /// CPU／GPU 效能調整的套用狀態。指令在 Program.ReadCommands：G／C／K／X。
    /// 看門狗與 RestoreAll 都要走到 Reset——跟風扇一樣，主程式被硬殺時唯一會交還的機制。
    /// </summary>
    internal static class Oc
    {
        private static readonly object Gate = new object();
        private static bool _gpuApplied;
        private static bool _cpuApplied;
        private static int _core;
        private static int _mem;
        private static int _power = 100;
        private static int _ppt;
        private static int _tdc;
        private static int _edc;
        private static int _scalar = 100;
        private static int _volt;
        private static int _gpuTemp = 90;
        private static int _coAll;
        private static int _freq;
        private static int _tctl = 90;
        private static int _cpuVolt;
        private static int _soc;
        private static int _factorySoc;
        private static int _liveSoc;
        private static int[] _perCore = Array.Empty<int>();
        private static int[] _perFreq = Array.Empty<int>();
        private static int[] _vf = Array.Empty<int>();
        private static int _factoryPpt;
        private static int _factoryTdc;
        private static int _factoryEdc;
        private static int _factoryScalar = 100;
        private static bool _factoryOk;

        internal static bool IsApplied
        {
            get { lock (Gate) return _gpuApplied || _cpuApplied; }
        }

        /// <summary>
        /// 極小幅度實機探測：核心 +15 MHz，功耗牆維持現況。不開管道、不碰風扇。
        /// 結束一定還原成進門時讀到的值。結果寫 %TEMP%\voiceink-oc-probe.jsonl。
        /// </summary>
        internal static int RunProbe(bool hold)
        {
            string log = Path.Combine(Path.GetTempPath(), "voiceink-oc-probe.jsonl");
            var lines = new StringBuilder();
            void emit(string json)
            {
                lines.AppendLine(json);
                try { Console.WriteLine(json); } catch { /* 提權時 stdout 可能沒接 */ }
                try { File.WriteAllText(log, lines.ToString(), new UTF8Encoding(false)); } catch { /* 下一筆再試 */ }
            }
            try
            {
                if (!NvapiOc.Init())
                {
                    emit("{\"ok\":false,\"error\":\"nvapi-init\"}");
                    File.WriteAllText(log, lines.ToString(), new UTF8Encoding(false));
                    return 1;
                }
                int core0, mem0, ignoredPower;
                NvapiOc.TryRead(out core0, out mem0, out ignoredPower);
                string smi0 = SmiLine();
                int power0 = PowerPctFromSmi(smi0, ignoredPower);
                emit("{\"step\":\"baseline\",\"co\":" + core0 + ",\"mo\":" + mem0 + ",\"pw\":" + power0
                    + ",\"smi\":" + JsonString(smi0) + "}");
                int core1 = core0 + 15;
                if (core1 > 200) core1 = core0 - 15;
                bool applied = NvapiOc.Apply(core1, mem0, power0, 0, 90);
                System.Threading.Thread.Sleep(1000);
                int coreA, memA, powerA;
                NvapiOc.TryRead(out coreA, out memA, out powerA);
                emit("{\"step\":\"applied\",\"ok\":" + (applied ? "true" : "false")
                    + ",\"co\":" + coreA + ",\"mo\":" + memA + ",\"pw\":" + power0
                    + ",\"smi\":" + JsonString(SmiLine()) + "}");
                if (hold) System.Threading.Thread.Sleep(1500);
                NvapiOc.Apply(core0, mem0, power0, 0, 90);
                System.Threading.Thread.Sleep(1000);
                int coreR, memR, powerR;
                NvapiOc.TryRead(out coreR, out memR, out powerR);
                emit("{\"step\":\"restored\",\"co\":" + coreR + ",\"mo\":" + memR + ",\"pw\":" + powerR
                    + ",\"smi\":" + JsonString(SmiLine()) + "}");
                bool changed = applied && coreA != core0;
                emit("{\"ok\":" + (changed ? "true" : "false") + ",\"delta\":" + (coreA - core0) + "}");
                File.WriteAllText(log, lines.ToString(), new UTF8Encoding(false));
                return changed ? 0 : 2;
            }
            catch (Exception ex)
            {
                emit("{\"ok\":false,\"error\":\"exception\",\"type\":" + JsonString(ex.GetType().Name) + "}");
                try { File.WriteAllText(log, lines.ToString(), new UTF8Encoding(false)); } catch { /* 寫不進去也要結束 */ }
                return 1;
            }
        }

        /// <summary>nvidia-smi 的功耗牆百分比。NVAPI GetPower 在這張卡上會謊報 100。</summary>
        private static int PowerPctFromSmi(string smi, int fallback)
        {
            string[] parts = (smi ?? "").Split(',');
            if (parts.Length < 4) return fallback;
            double limit, def;
            if (!double.TryParse(parts[2].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out limit)) return fallback;
            if (!double.TryParse(parts[3].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out def)) return fallback;
            if (def <= 0) return fallback;
            int pct = (int)Math.Round(limit / def * 100.0);
            if (pct < 50) pct = 50;
            if (pct > 120) pct = 120;
            return pct;
        }

        private static string SmiLine()
        {
            try
            {
                var info = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "nvidia-smi",
                    Arguments = "--query-gpu=clocks.gr,clocks.max.gr,power.limit,power.default_limit,power.draw --format=csv,noheader,nounits",
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using var proc = System.Diagnostics.Process.Start(info);
                if (proc == null) return "";
                string text = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(4000);
                return text.Trim();
            }
            catch
            {
                return "";
            }
        }

        internal static void Init(Computer computer)
        {
            NvapiOc.Init();
            SmuOc.Init();
            SnapshotFactory(computer);
        }

        internal static void ApplyGpu(int coreMhz, int memMhz, int powerPct, int voltMv, int tempC)
        {
            lock (Gate)
            {
                if (!NvapiOc.Init()) return;
                if (!NvapiOc.Apply(coreMhz, memMhz, powerPct, voltMv, tempC)) return;
                NvapiOc.ApplyCurve(coreMhz, _vf);
                _core = coreMhz;
                _mem = memMhz;
                _power = powerPct;
                _volt = voltMv;
                _gpuTemp = tempC;
                _gpuApplied = true;
            }
        }

        internal static void ApplyVf(int[] extras)
        {
            lock (Gate)
            {
                _vf = extras ?? Array.Empty<int>();
                if (_gpuApplied) NvapiOc.ApplyCurve(_core, _vf);
            }
        }

        internal static void ApplyCpu(int pptW, int tdcA, int edcA, int scalarX100, int coAll, int freqMhz, int tctlC, int voltMv, int socMv)
        {
            lock (Gate)
            {
                if (!SmuOc.Init()) return;
                if (!_factoryOk)
                {
                    _factoryPpt = pptW;
                    _factoryTdc = tdcA;
                    _factoryEdc = edcA;
                    _factoryScalar = 100;
                    _factoryOk = true;
                }
                bool ok = SmuOc.ApplyPbo(pptW, tdcA, edcA, scalarX100, tctlC);
                ok = SmuOc.ApplyManualFreq(freqMhz, _perFreq) || ok;
                if (freqMhz > 0 || HasPositive(_perFreq)) ok = SmuOc.ApplyVid(voltMv) || ok;
                _soc = socMv;
                if (_soc > 0)
                {
                    if (_factorySoc <= 0 && _liveSoc > 0) _factorySoc = _liveSoc;
                    if (_factorySoc > 0) ok = SmuOc.ApplySoc(_soc) || ok;
                }
                ok = SmuOc.ApplyCurve(coAll, _perCore) || ok;
                if (!ok) return;
                _ppt = pptW;
                _tdc = tdcA;
                _edc = edcA;
                _scalar = scalarX100;
                _coAll = coAll;
                _freq = freqMhz;
                _tctl = tctlC;
                _cpuVolt = voltMv;
                _cpuApplied = true;
            }
        }

        internal static void ApplyCores(int[] margins)
        {
            lock (Gate)
            {
                _perCore = margins ?? Array.Empty<int>();
                if (_cpuApplied) SmuOc.ApplyCurve(_coAll, _perCore);
            }
        }

        internal static void ApplyFreqCores(int[] mhz)
        {
            lock (Gate)
            {
                _perFreq = mhz ?? Array.Empty<int>();
                if (_cpuApplied) SmuOc.ApplyManualFreq(_freq, _perFreq);
            }
        }

        private static bool HasPositive(int[] values)
        {
            if (values == null) return false;
            for (int i = 0; i < values.Length; i++) if (values[i] > 0) return true;
            return false;
        }

        internal static void Reset()
        {
            lock (Gate)
            {
                if (_gpuApplied)
                {
                    NvapiOc.Reset();
                    _gpuApplied = false;
                    _core = 0;
                    _mem = 0;
                    _power = 100;
                    _volt = 0;
                    _gpuTemp = 90;
                    _vf = Array.Empty<int>();
                }
                if (_cpuApplied)
                {
                    if (_factoryOk)
                    {
                        SmuOc.ApplyPbo(_factoryPpt, _factoryTdc, _factoryEdc, _factoryScalar, 90);
                    }
                    if (_factorySoc > 0) SmuOc.ApplySoc(_factorySoc);
                    SmuOc.ResetExtras();
                    _cpuApplied = false;
                    _coAll = 0;
                    _freq = 0;
                    _tctl = 90;
                    _cpuVolt = 0;
                    _soc = 0;
                    _perCore = Array.Empty<int>();
                    _perFreq = Array.Empty<int>();
                    _vf = Array.Empty<int>();
                }
            }
        }

        /// <summary>把目前讀得到的牆與是否已套用寫進 sidecar 每一框的 "o"。</summary>
        internal static void AppendJson(StringBuilder sb, Computer computer)
        {
            SensorSnap cpu = ReadCpu(computer);
            SensorSnap gpu = ReadGpu(computer);
            int coreOff;
            int memOff;
            int powerPct;
            bool gpuReady;
            bool cpuReady;
            string cpuReason;
            bool gpuApplied;
            bool cpuApplied;
            int ppt;
            int tdc;
            int edc;
            int scalar;
            int factoryPpt;
            int factoryTdc;
            int factoryEdc;
            int volt;
            int gpuTemp;
            int coAll;
            int freq;
            int tctl;
            int cpuVolt;
            int cores;
            lock (Gate)
            {
                if (!_factoryOk) SnapshotFactory(cpu);
                coreOff = _core;
                memOff = _mem;
                powerPct = _power;
                gpuApplied = _gpuApplied;
                cpuApplied = _cpuApplied;
                ppt = _ppt;
                tdc = _tdc;
                edc = _edc;
                scalar = _scalar;
                factoryPpt = _factoryPpt;
                factoryTdc = _factoryTdc;
                factoryEdc = _factoryEdc;
                volt = _volt;
                gpuTemp = _gpuTemp;
                coAll = _coAll;
                freq = _freq;
                tctl = _tctl;
                cpuVolt = _cpuVolt;
                cores = cpu.CoreClocks != null && cpu.CoreClocks.Length > 0
                    ? cpu.CoreClocks.Length
                    : (cpu.Cores > 0 ? cpu.Cores : 8);
            }
            gpuReady = NvapiOc.Ready;
            cpuReady = SmuOc.Ready;
            cpuReason = SmuOc.Reason;
            if (gpuReady) NvapiOc.TryRead(out coreOff, out memOff, out powerPct);
            if (cpu.Soc > 0.4f) _liveSoc = (int)Math.Round(cpu.Soc * 1000);

            sb.Append("\"o\":{\"c\":{");
            sb.Append("\"w\":").Append(cpuReady ? "1" : "0");
            sb.Append(",\"n\":").Append(JsonString(cpu.Name));
            sb.Append(",\"t\":").Append(Num(cpu.Temp));
            sb.Append(",\"k\":").Append(Num(cpu.Clock));
            sb.Append(",\"p\":").Append(Num(cpu.Power));
            sb.Append(",\"pl\":").Append(cpu.PptLimit > 0 ? ((int)Math.Round(cpu.PptLimit)).ToString(CultureInfo.InvariantCulture) : ppt.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"d\":").Append(Num(cpu.Tdc > 0 ? cpu.Tdc : tdc));
            sb.Append(",\"e\":").Append(Num(cpu.Edc > 0 ? cpu.Edc : edc));
            sb.Append(",\"u\":").Append(NumZero(cpu.Load));
            sb.Append(",\"v\":").Append(Num(cpu.Volt));
            sb.Append(",\"so\":").Append(Num(cpu.Soc));
            sb.Append(",\"sv\":").Append(_soc);
            sb.Append(",\"s\":").Append(cpuApplied ? scalar : 100);
            sb.Append(",\"fp\":").Append(factoryPpt);
            sb.Append(",\"fd\":").Append(factoryTdc);
            sb.Append(",\"fe\":").Append(factoryEdc);
            sb.Append(",\"ca\":").Append(coAll);
            sb.Append(",\"fa\":").Append(freq);
            sb.Append(",\"tc\":").Append(tctl);
            sb.Append(",\"cv\":").Append(cpuVolt);
            sb.Append(",\"cc\":").Append(cores);
            sb.Append(",\"a\":").Append(cpuApplied ? "1" : "0");
            AppendClocks(sb, cpu.CoreClocks);
            if (!cpuReady) sb.Append(",\"r\":").Append(JsonString(cpuReason));
            sb.Append("},\"g\":{");
            sb.Append("\"w\":").Append(gpuReady ? "1" : "0");
            sb.Append(",\"n\":").Append(JsonString(gpu.Name));
            sb.Append(",\"t\":").Append(Num(gpu.Temp));
            sb.Append(",\"h\":").Append(Num(gpu.Hotspot));
            sb.Append(",\"k\":").Append(Num(gpu.Clock));
            sb.Append(",\"m\":").Append(Num(gpu.Mem));
            sb.Append(",\"u\":").Append(NumZero(gpu.Load));
            sb.Append(",\"pw\":").Append(powerPct);
            sb.Append(",\"pd\":").Append(Num(gpu.Power));
            sb.Append(",\"vl\":").Append(Num(gpu.Volt));
            sb.Append(",\"f\":").Append(Num(gpu.Fan));
            sb.Append(",\"vu\":").Append(Num(gpu.VramUsed));
            sb.Append(",\"vt\":").Append(Num(gpu.VramTotal));
            sb.Append(",\"co\":").Append(coreOff);
            sb.Append(",\"mo\":").Append(memOff);
            sb.Append(",\"vo\":").Append(volt);
            sb.Append(",\"gt\":").Append(gpuTemp);
            sb.Append(",\"a\":").Append(gpuApplied ? "1" : "0");
            AppendVf(sb);
            if (!gpuReady) sb.Append(",\"r\":").Append(JsonString("這張顯示卡還沒接（NVIDIA 時脈／功耗／電壓／溫度牆）"));
            sb.Append("}}");
        }

        private static void SnapshotFactory(Computer computer)
        {
            SnapshotFactory(ReadCpu(computer));
        }

        private static void SnapshotFactory(SensorSnap cpu)
        {
            if (_factoryOk) return;
            float wall = cpu.PptLimit > 0 ? cpu.PptLimit : cpu.Power;
            if (wall <= 0 || cpu.Tdc <= 0 || cpu.Edc <= 0) return;
            _factoryPpt = (int)Math.Round(wall);
            _factoryTdc = (int)Math.Round(cpu.Tdc);
            _factoryEdc = (int)Math.Round(cpu.Edc);
            int scalar;
            _factoryScalar = SmuOc.TryGetScalar(out scalar) ? scalar : 100;
            _factoryOk = true;
        }

        private static SensorSnap ReadCpu(Computer computer)
        {
            var snap = new SensorSnap();
            var clocks = new float[16];
            var have = new bool[16];
            bool sawZero = false;
            int maxIdx = -1;
            Walk(computer, (hw, sensor) =>
            {
                if (hw.HardwareType != HardwareType.Cpu) return;
                if (string.IsNullOrEmpty(snap.Name)) snap.Name = hw.Name;
                float? value = sensor.Value;
                if (!value.HasValue || float.IsNaN(value.Value)) return;
                float v = value.Value;
                string name = sensor.Name ?? "";
                if (sensor.SensorType == SensorType.Temperature && snap.Temp == 0
                    && (name.IndexOf("Tctl", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("Package", StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    snap.Temp = v;
                }
                if (sensor.SensorType == SensorType.Clock && name.IndexOf("Bus", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    if (v > snap.Clock) snap.Clock = v;
                    var match = System.Text.RegularExpressions.Regex.Match(name, @"^Core\s+#?(\d+)$");
                    if (match.Success)
                    {
                        int raw;
                        if (int.TryParse(match.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out raw)
                            && raw >= 0 && raw < 16)
                        {
                            if (raw == 0) sawZero = true;
                            clocks[raw] = v;
                            have[raw] = true;
                            if (raw > maxIdx) maxIdx = raw;
                            snap.Cores++;
                        }
                    }
                }
                if (sensor.SensorType == SensorType.Load && name.IndexOf("Total", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    snap.Load = v;
                }
                if (sensor.SensorType == SensorType.Voltage)
                {
                    if (name.IndexOf("SoC", StringComparison.OrdinalIgnoreCase) >= 0) snap.Soc = v;
                    else if (snap.Volt == 0
                        && (name.IndexOf("Core", StringComparison.OrdinalIgnoreCase) >= 0
                            || name.IndexOf("VID", StringComparison.OrdinalIgnoreCase) >= 0
                            || name.IndexOf("SVI", StringComparison.OrdinalIgnoreCase) >= 0))
                    {
                        snap.Volt = v;
                    }
                }
                if (sensor.SensorType == SensorType.Power)
                {
                    if (name.IndexOf("PPT", StringComparison.OrdinalIgnoreCase) >= 0
                        && name.IndexOf("Limit", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        snap.PptLimit = v;
                    }
                    else if (name.IndexOf("Package", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        snap.Power = v;
                    }
                }
                if (name.IndexOf("TDC", StringComparison.OrdinalIgnoreCase) >= 0
                    && name.IndexOf("Limit", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    snap.Tdc = v;
                }
                if (name.IndexOf("EDC", StringComparison.OrdinalIgnoreCase) >= 0
                    && name.IndexOf("Limit", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    snap.Edc = v;
                }
            });
            snap.CoreClocks = PackClocks(clocks, have, maxIdx, sawZero);
            return snap;
        }

        private static SensorSnap ReadGpu(Computer computer)
        {
            var snap = new SensorSnap();
            Walk(computer, (hw, sensor) =>
            {
                if (hw.HardwareType != HardwareType.GpuNvidia
                    && hw.HardwareType != HardwareType.GpuAmd)
                {
                    return;
                }
                if (string.IsNullOrEmpty(snap.Name)) snap.Name = hw.Name;
                float? value = sensor.Value;
                if (!value.HasValue || float.IsNaN(value.Value)) return;
                float v = value.Value;
                string name = sensor.Name ?? "";
                if (sensor.SensorType == SensorType.Temperature)
                {
                    if (name.IndexOf("Hot", StringComparison.OrdinalIgnoreCase) >= 0) snap.Hotspot = v;
                    else if (snap.Temp == 0 && (name.IndexOf("Core", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("GPU", StringComparison.OrdinalIgnoreCase) >= 0))
                    {
                        snap.Temp = v;
                    }
                }
                if (sensor.SensorType == SensorType.Clock)
                {
                    if (name.IndexOf("Core", StringComparison.OrdinalIgnoreCase) >= 0) snap.Clock = v;
                    if (name.IndexOf("Memory", StringComparison.OrdinalIgnoreCase) >= 0) snap.Mem = v;
                }
                if (sensor.SensorType == SensorType.Load && snap.Load == 0
                    && (name.IndexOf("Core", StringComparison.OrdinalIgnoreCase) >= 0
                        || name.IndexOf("GPU", StringComparison.OrdinalIgnoreCase) >= 0)
                    && name.IndexOf("Memory", StringComparison.OrdinalIgnoreCase) < 0)
                {
                    snap.Load = v;
                }
                if (sensor.SensorType == SensorType.Power && snap.Power == 0) snap.Power = v;
                if (sensor.SensorType == SensorType.Voltage && snap.Volt == 0
                    && name.IndexOf("Core", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    snap.Volt = v;
                }
                if (sensor.SensorType == SensorType.Fan && snap.Fan == 0) snap.Fan = v;
                if (sensor.SensorType == SensorType.SmallData)
                {
                    if (name.IndexOf("Memory Used", StringComparison.OrdinalIgnoreCase) >= 0) snap.VramUsed = v;
                    if (name.IndexOf("Memory Total", StringComparison.OrdinalIgnoreCase) >= 0) snap.VramTotal = v;
                }
            });
            return snap;
        }

        private static void Walk(Computer computer, Action<IHardware, ISensor> visit)
        {
            if (computer == null) return;
            foreach (IHardware hardware in computer.Hardware)
            {
                WalkHardware(hardware, visit);
            }
        }

        private static void WalkHardware(IHardware hardware, Action<IHardware, ISensor> visit)
        {
            foreach (ISensor sensor in hardware.Sensors) visit(hardware, sensor);
            foreach (IHardware sub in hardware.SubHardware) WalkHardware(sub, visit);
        }

        private static float[] PackClocks(float[] clocks, bool[] have, int maxIdx, bool sawZero)
        {
            if (maxIdx < 0) return Array.Empty<float>();
            int start = sawZero ? 0 : 1;
            if (start > maxIdx) return Array.Empty<float>();
            var list = new System.Collections.Generic.List<float>(maxIdx - start + 1);
            for (int i = start; i <= maxIdx; i++)
            {
                if (have[i]) list.Add(clocks[i]);
            }
            return list.ToArray();
        }

        private static void AppendVf(StringBuilder sb)
        {
            if (!NvapiOc.Ready) return;
            NvapiOc.VfPoint[] points = NvapiOc.TryReadCurve();
            if (points == null || points.Length == 0) return;
            sb.Append(",\"vf\":[");
            for (int i = 0; i < points.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('[').Append(points[i].Index);
                sb.Append(',').Append(points[i].VoltMv);
                sb.Append(',').Append(points[i].FreqMhz);
                sb.Append(',').Append(points[i].DeltaMhz);
                sb.Append(']');
            }
            sb.Append(']');
        }

        private static void AppendClocks(StringBuilder sb, float[] clocks)
        {
            if (clocks == null || clocks.Length == 0) return;
            sb.Append(",\"ck\":[");
            for (int i = 0; i < clocks.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(Num(clocks[i]));
            }
            sb.Append(']');
        }

        private static string Num(float value)
        {
            if (float.IsNaN(value) || value == 0) return "null";
            return value.ToString("0.###", CultureInfo.InvariantCulture);
        }

        private static string NumZero(float value)
        {
            if (float.IsNaN(value) || value < 0) return "null";
            return value.ToString("0.###", CultureInfo.InvariantCulture);
        }

        private static string JsonString(string value)
        {
            if (string.IsNullOrEmpty(value)) return "\"\"";
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                if (c == '"' || c == '\\') sb.Append('\\');
                if (c == '\n' || c == '\r' || c == '\t') continue;
                sb.Append(c);
            }
            sb.Append('"');
            return sb.ToString();
        }

        private struct SensorSnap
        {
            public string Name;
            public float Temp;
            public float Hotspot;
            public float Clock;
            public float Mem;
            public float Power;
            public float PptLimit;
            public float Tdc;
            public float Edc;
            public float Load;
            public float Volt;
            public float Soc;
            public float Fan;
            public float VramUsed;
            public float VramTotal;
            public int Cores;
            public float[] CoreClocks;
        }
    }
}
