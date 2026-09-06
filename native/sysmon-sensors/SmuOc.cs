using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace VoiceInkSensors
{
    /// <summary>
    /// Ryzen PBO 三牆與 scalar。PawnIO 的 RyzenSMU 模組已有 ioctl_send_smu_command，
    /// LHM 的 C# 包裝沒接——這裡自己載同一份 .bin，只寫進表上的世代。
    /// </summary>
    internal static class SmuOc
    {
        private const int CmdPpt = 0x53;
        private const int CmdTdc = 0x54;
        private const int CmdEdc = 0x55;
        private const int CmdTctl = 0x56;
        private const int CmdScalar = 0x58;
        private const int CmdEnableOc = 0x5A;
        private const int CmdDisableOc = 0x5B;
        private const int CmdFreqAll = 0x5C;
        private const int CmdFreqPer = 0x5D;
        private const int CmdSetVid = 0x61;
        private const int CmdSoc = 0x14;
        private const int CmdGetScalar = 0x6C;
        private const int VoltMinMv = 800;
        private const int VoltMaxMv = 1400;
        private const int SocMinMv = 900;
        private const int SocMaxMv = 1200;
        // Zen 3 Curve Optimizer 在 MP1（PawnIO 的 send_command 只打 RSMU）
        private const int Mp1Msg = 0x3B10530;
        private const int Mp1Rsp = 0x3B1057C;
        private const int Mp1Arg = 0x3B109C4;
        private const int Mp1CoAll = 0x36;
        private const int Mp1CoOne = 0x35;
        private const int ScalarMin = 100;
        private const int ScalarMax = 200;
        private const int CoMin = -30;
        private const int CoMax = 30;
        private const int FreqMin = 3500;
        private const int FreqMax = 5000;

        private static readonly object Gate = new object();
        private static PawnClient _pawn;
        private static Mutex _pci;
        private static bool _ready;
        private static string _reason = "尚未初始化";

        internal static bool Ready
        {
            get { lock (Gate) return _ready; }
        }

        internal static string Reason
        {
            get { lock (Gate) return _reason; }
        }

        internal static bool Init()
        {
            lock (Gate)
            {
                if (_ready) return true;
                if (!IsSupportedRyzen(out _reason)) return false;
                try
                {
                    _pci = Mutex.OpenExisting(@"Global\Access_PCI");
                }
                catch
                {
                    try { _pci = new Mutex(false, @"Global\Access_PCI"); }
                    catch { _pci = null; }
                }
                _pawn = PawnClient.LoadRyzenSmu();
                if (_pawn == null || !_pawn.IsLoaded)
                {
                    _reason = "PawnIO 的 RyzenSMU 模組載不進來";
                    return false;
                }
                _ready = true;
                _reason = "";
                return true;
            }
        }

        internal static void Close()
        {
            lock (Gate)
            {
                _pawn?.Close();
                _pawn = null;
                _ready = false;
            }
        }

        /// <summary>PBO 三牆＋scalar＋Tctl；單位 W／A／°C，scalar ×100。</summary>
        internal static bool ApplyPbo(int pptW, int tdcA, int edcA, int scalarX100, int tctlC)
        {
            lock (Gate)
            {
                if (!_ready) return false;
                int ppt = Clamp(pptW, 15, 400);
                int tdc = Clamp(tdcA, 10, 400);
                int edc = Clamp(edcA, 10, 500);
                int scalar = Clamp(scalarX100, ScalarMin, ScalarMax);
                int tctl = Clamp(tctlC, 70, 95);
                bool ok = Send(CmdPpt, (uint)(ppt * 1000));
                ok = Send(CmdTdc, (uint)(tdc * 1000)) && ok;
                ok = Send(CmdEdc, (uint)(edc * 1000)) && ok;
                ok = Send(CmdScalar, (uint)scalar) && ok;
                ok = Send(CmdTctl, (uint)tctl) && ok;
                return ok;
            }
        }

        /// <summary>freqMhz＝0 且沒有每核時脈時關掉手動超頻、回到 PBO。</summary>
        internal static bool ApplyManualFreq(int freqMhz, int[] perCoreMhz)
        {
            lock (Gate)
            {
                if (!_ready) return false;
                bool anyPer = false;
                if (perCoreMhz != null)
                {
                    for (int i = 0; i < perCoreMhz.Length; i++)
                    {
                        if (perCoreMhz[i] > 0) { anyPer = true; break; }
                    }
                }
                if (freqMhz <= 0 && !anyPer) return Send(CmdDisableOc, 0);
                if (!Send(CmdEnableOc, 0)) return false;
                bool ok = true;
                if (freqMhz > 0)
                {
                    int mhz = Clamp(freqMhz, FreqMin, FreqMax);
                    ok = Send(CmdFreqAll, (uint)mhz);
                }
                if (perCoreMhz == null) return ok;
                for (int i = 0; i < perCoreMhz.Length && i < 16; i++)
                {
                    if (perCoreMhz[i] <= 0) continue;
                    int one = Clamp(perCoreMhz[i], FreqMin, FreqMax);
                    ok = Send(CmdFreqPer, PackPerCore(one, i)) && ok;
                }
                return ok;
            }
        }

        /// <summary>Vermeer 一顆 CCD、一個 CCX：freq 在低 20 bit，核號在 bit 20–23。</summary>
        private static uint PackPerCore(int mhz, int coreId)
        {
            return (uint)((mhz & 0xFFFFF) | ((coreId & 0xF) << 20));
        }

        /// <summary>
        /// 手動超頻時的 CPU VID。milliVolts＝0 表示不鎖電壓。
        /// VID = (1.55 − V) / 0.00625，跟 Ryzen Master 同一套。
        /// </summary>
        internal static bool ApplyVid(int milliVolts)
        {
            lock (Gate)
            {
                if (!_ready || milliVolts <= 0) return true;
                int mv = Clamp(milliVolts, VoltMinMv, VoltMaxMv);
                double volts = mv / 1000.0;
                int vid = (int)Math.Round((1.55 - volts) / 0.00625);
                if (vid < 0) vid = 0;
                if (vid > 255) vid = 255;
                return Send(CmdSetVid, (uint)vid);
            }
        }

        /// <summary>SoC VID。milliVolts＝0 表示不寫。還原時把進門快照寫回去。</summary>
        internal static bool ApplySoc(int milliVolts)
        {
            lock (Gate)
            {
                if (!_ready || milliVolts <= 0) return true;
                int mv = Clamp(milliVolts, SocMinMv, SocMaxMv);
                double volts = mv / 1000.0;
                int vid = (int)Math.Round((1.55 - volts) / 0.00625);
                if (vid < 0) vid = 0;
                if (vid > 255) vid = 255;
                return Send(CmdSoc, (uint)vid);
            }
        }

        /// <summary>Curve Optimizer：先全核再每核。margin 負值＝降壓。</summary>
        internal static bool ApplyCurve(int all, int[] perCore)
        {
            lock (Gate)
            {
                if (!_ready) return false;
                int margin = Clamp(all, CoMin, CoMax);
                bool ok = SendMp1(Mp1CoAll, margin, 0);
                if (perCore == null) return ok;
                for (int i = 0; i < perCore.Length && i < 16; i++)
                {
                    int one = Clamp(perCore[i], CoMin, CoMax);
                    ok = SendMp1(Mp1CoOne, i, one) && ok;
                }
                return ok;
            }
        }

        internal static bool ResetExtras()
        {
            lock (Gate)
            {
                if (!_ready) return false;
                Send(CmdDisableOc, 0);
                SendMp1(Mp1CoAll, 0, 0);
                return true;
            }
        }

        internal static bool TryGetScalar(out int scalarX100)
        {
            scalarX100 = 100;
            lock (Gate)
            {
                if (!_ready) return false;
                uint[] args;
                if (!SendRaw(CmdGetScalar, 0, out args) || args == null || args.Length == 0) return false;
                int value = (int)args[0];
                if (value < ScalarMin || value > ScalarMax) return false;
                scalarX100 = value;
                return true;
            }
        }

        private static bool SendMp1(int cmd, int a0, int a1)
        {
            if (_pawn == null) return false;
            bool taken = false;
            try
            {
                if (_pci != null)
                {
                    try { taken = _pci.WaitOne(2000, false); }
                    catch (AbandonedMutexException) { taken = true; }
                    if (!taken) return false;
                }
                if (!WaitReg(Mp1Rsp, true)) return false;
                if (!WriteReg(Mp1Rsp, 0)) return false;
                if (!WriteReg(Mp1Arg, unchecked((uint)a0))) return false;
                if (!WriteReg(Mp1Arg + 4, unchecked((uint)a1))) return false;
                for (int i = 2; i < 6; i++) WriteReg(Mp1Arg + 4 * i, 0);
                if (!WriteReg(Mp1Msg, (uint)cmd)) return false;
                return WaitReg(Mp1Rsp, false);
            }
            catch
            {
                return false;
            }
            finally
            {
                if (taken)
                {
                    try { _pci.ReleaseMutex(); } catch { /* 對手放過 */ }
                }
            }
        }

        private static bool WaitReg(int addr, bool anyNonZero)
        {
            for (int i = 0; i < 200; i++)
            {
                uint value;
                if (!ReadReg(addr, out value)) return false;
                if (anyNonZero ? value != 0 : value == 1) return true;
                if (!anyNonZero && value != 0) return false;
                Thread.Sleep(1);
            }
            return false;
        }

        private static bool ReadReg(int addr, out uint value)
        {
            value = 0;
            long[] output;
            if (!_pawn.Execute("ioctl_read_smu_register", new long[] { addr }, 1, out output)) return false;
            if (output.Length < 1) return false;
            value = (uint)output[0];
            return true;
        }

        private static bool WriteReg(int addr, uint value)
        {
            long[] output;
            return _pawn.Execute("ioctl_write_smu_register", new long[] { addr, value }, 0, out output);
        }

        private static bool Send(int cmd, uint arg0)
        {
            uint[] _;
            return SendRaw(cmd, arg0, out _);
        }

        private static bool SendRaw(int cmd, uint arg0, out uint[] args)
        {
            args = null;
            if (_pawn == null) return false;
            bool taken = false;
            try
            {
                if (_pci != null)
                {
                    try { taken = _pci.WaitOne(2000, false); }
                    catch (AbandonedMutexException) { taken = true; }
                    if (!taken) return false;
                }
                long[] input = { cmd, arg0, 0, 0, 0, 0, 0 };
                long[] output;
                if (!_pawn.Execute("ioctl_send_smu_command", input, 6, out output)) return false;
                args = new uint[output.Length];
                for (int i = 0; i < output.Length; i++) args[i] = (uint)output[i];
                return true;
            }
            catch
            {
                return false;
            }
            finally
            {
                if (taken)
                {
                    try { _pci.ReleaseMutex(); } catch { /* 對手放過 */ }
                }
            }
        }

        private static bool IsSupportedRyzen(out string reason)
        {
            reason = "這顆 CPU 還沒接（v1 只寫 Matisse／Vermeer 的 PBO）";
            try
            {
                using var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(
                    @"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
                string vendor = Convert.ToString(key?.GetValue("VendorIdentifier") ?? "", CultureInfo.InvariantCulture);
                string id = Convert.ToString(key?.GetValue("Identifier") ?? "", CultureInfo.InvariantCulture);
                if (vendor.IndexOf("AMD", StringComparison.OrdinalIgnoreCase) < 0) return false;
                var match = Regex.Match(id, @"Family\s+(\d+)\s+Model\s+(\d+)", RegexOptions.IgnoreCase);
                if (!match.Success) return false;
                int family = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
                int model = int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture);
                // Matisse = Family 23 Model 113；Vermeer = Family 25 Model 32／33
                bool ok = (family == 23 && model == 113) || (family == 25 && (model == 32 || model == 33));
                if (ok) reason = "";
                return ok;
            }
            catch
            {
                return false;
            }
        }

        private static int Clamp(int value, int lo, int hi)
        {
            if (value < lo) return lo;
            if (value > hi) return hi;
            return value;
        }

        /// <summary>PawnIO 使用者態客戶端：載 LHM 內嵌的 RyzenSMU.bin 再 Execute 具名 ioctl。</summary>
        private sealed class PawnClient
        {
            private const uint DeviceType = 41394u << 16;
            private const uint IoctlLoad = DeviceType | (0x821u << 2);
            private const uint IoctlExec = DeviceType | (0x841u << 2);
            private const int NameLen = 32;
            private const uint GenericReadWrite = 0xC0000000;
            private const uint ShareReadWrite = 0x3;
            private const uint OpenExisting = 3;

            private readonly SafeFileHandle _handle;

            private PawnClient(SafeFileHandle handle) { _handle = handle; }

            public bool IsLoaded => _handle != null && !_handle.IsInvalid && !_handle.IsClosed;

            public static PawnClient LoadRyzenSmu()
            {
                SafeFileHandle handle = Native.CreateFile(
                    @"\\?\GLOBALROOT\Device\PawnIO",
                    GenericReadWrite, ShareReadWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
                if (handle.IsInvalid) return null;
                byte[] bin = ReadEmbeddedBin();
                if (bin == null || bin.Length == 0)
                {
                    handle.Dispose();
                    return null;
                }
                uint written;
                if (!Native.DeviceIoControl(handle, IoctlLoad, bin, (uint)bin.Length, null, 0, out written, IntPtr.Zero))
                {
                    handle.Dispose();
                    return null;
                }
                return new PawnClient(handle);
            }

            public bool Execute(string name, long[] input, int outLen, out long[] output)
            {
                output = Array.Empty<long>();
                if (!IsLoaded) return false;
                byte[] payload = new byte[NameLen + (input.Length * 8)];
                byte[] nameBytes = Encoding.ASCII.GetBytes(name);
                Buffer.BlockCopy(nameBytes, 0, payload, 0, Math.Min(NameLen - 1, nameBytes.Length));
                Buffer.BlockCopy(input, 0, payload, NameLen, input.Length * 8);
                byte[] rawOut = new byte[outLen * 8];
                uint read;
                if (!Native.DeviceIoControl(_handle, IoctlExec, payload, (uint)payload.Length,
                    rawOut, (uint)rawOut.Length, out read, IntPtr.Zero))
                {
                    return false;
                }
                int count = (int)(read / 8);
                output = new long[count];
                Buffer.BlockCopy(rawOut, 0, output, 0, count * 8);
                return true;
            }

            public void Close()
            {
                if (IsLoaded) _handle.Dispose();
            }

            private static byte[] ReadEmbeddedBin()
            {
                foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    string[] names;
                    try { names = assembly.GetManifestResourceNames(); }
                    catch { continue; }
                    foreach (string name in names)
                    {
                        if (name.IndexOf("RyzenSMU.bin", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        using Stream stream = assembly.GetManifestResourceStream(name);
                        if (stream == null) continue;
                        using var memory = new MemoryStream();
                        stream.CopyTo(memory);
                        return memory.ToArray();
                    }
                }
                return null;
            }
        }

        private static class Native
        {
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern SafeFileHandle CreateFile(
                string name, uint access, uint share, IntPtr security,
                uint create, uint flags, IntPtr template);

            [DllImport("kernel32.dll", SetLastError = true)]
            public static extern bool DeviceIoControl(
                SafeFileHandle device, uint code,
                byte[] inBuffer, uint inSize,
                byte[] outBuffer, uint outSize,
                out uint written, IntPtr overlapped);
        }
    }
}
