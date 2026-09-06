using System;
using System.Runtime.InteropServices;

namespace VoiceInkSensors
{
    /// <summary>
    /// NVIDIA 時脈偏移與功耗牆。公開 NVAPI 只有 Get；Set 走未公開 QueryInterface
    ///（Afterburner 同源：0x0F4DAE6B／0xAD95F5ED）。失敗就標記不可寫，不假裝成功。
    /// </summary>
    internal static class NvapiOc
    {
        private const int Ok = 0;
        private const uint IdInitialize = 0x0150E828;
        private const uint IdEnumGpus = 0xE5AC921F;
        private const uint IdSetPstates20 = 0x0F4DAE6B;
        private const uint IdGetPstates20 = 0x6FF81213;
        private const uint IdSetPower = 0xAD95F5ED;
        private const uint IdGetPower = 0x70927371;
        private const uint IdSetTemp = 0x34C0B13D;
        private const uint IdGetMask = 0x507B4B59;
        private const uint IdGetTable = 0x23F1B133;
        private const uint IdSetTable = 0x0733E009;
        private const uint IdGetVf = 0x21537AD4;

        private const int DomainCore = 0;
        private const int DomainMemory = 4;
        private const int CoreMin = -200;
        private const int CoreMax = 200;
        private const int MemMin = -500;
        private const int MemMax = 1000;
        private const int PowerMin = 50;
        private const int PowerMax = 120;
        private const int VoltMin = -100;
        private const int VoltMax = 100;
        private const int TempMin = 65;
        private const int TempMax = 95;

        private static readonly object Gate = new object();
        private static IntPtr _gpu;
        private static bool _ready;

        private delegate IntPtr QueryInterface(uint id);
        private delegate int NvInit();
        private delegate int NvEnumGpus(IntPtr[] gpus, ref uint count);
        private delegate int NvSetPstates(IntPtr gpu, ref Pstates20 info);
        private delegate int NvSetPower(IntPtr gpu, ref PowerStatus status);
        private delegate int NvSetTemp(IntPtr gpu, ref ThermalLimit limit);
        private delegate int NvTableFn(IntPtr gpu, ref ClockTable table);
        private delegate int NvMaskFn(IntPtr gpu, ref ClockMasks masks);
        private delegate int NvBufFn(IntPtr gpu, IntPtr buf);

        private static QueryInterface _query;
        private static NvSetPstates _setPstates;
        private static NvSetPstates _getPstates;
        private static NvSetPower _setPower;
        private static NvSetPower _getPower;
        private static NvSetTemp _setTemp;
        private static NvMaskFn _getMask;
        private static NvTableFn _getTable;
        private static NvTableFn _setTable;
        private static NvBufFn _getVf;

        internal static bool Ready
        {
            get { lock (Gate) return _ready; }
        }

        internal static bool Init()
        {
            lock (Gate)
            {
                if (_ready) return true;
                IntPtr dll = Native.LoadLibrary("nvapi64.dll");
                if (dll == IntPtr.Zero) return false;
                IntPtr proc = Native.GetProcAddress(dll, "nvapi_QueryInterface");
                if (proc == IntPtr.Zero) return false;
                _query = Marshal.GetDelegateForFunctionPointer<QueryInterface>(proc);
                var init = DelegateOf<NvInit>(IdInitialize);
                var enumerate = DelegateOf<NvEnumGpus>(IdEnumGpus);
                _setPstates = DelegateOf<NvSetPstates>(IdSetPstates20);
                _getPstates = DelegateOf<NvSetPstates>(IdGetPstates20);
                _setPower = DelegateOf<NvSetPower>(IdSetPower);
                _getPower = DelegateOf<NvSetPower>(IdGetPower);
                _setTemp = DelegateOf<NvSetTemp>(IdSetTemp);
                _getMask = DelegateOf<NvMaskFn>(IdGetMask);
                _getTable = DelegateOf<NvTableFn>(IdGetTable);
                _setTable = DelegateOf<NvTableFn>(IdSetTable);
                _getVf = DelegateOf<NvBufFn>(IdGetVf);
                if (init == null || enumerate == null || _setPstates == null || _setPower == null) return false;
                if (init() != Ok) return false;
                var gpus = new IntPtr[64];
                uint count = 0;
                if (enumerate(gpus, ref count) != Ok || count == 0) return false;
                _gpu = gpus[0];
                _ready = _gpu != IntPtr.Zero;
                return _ready;
            }
        }

        /// <summary>時脈偏移、功耗牆、VID 電壓偏移（µV API，不是 I2C）、溫度牆。V/F 另走 ApplyCurve。</summary>
        internal static bool Apply(int coreMhz, int memMhz, int powerPct, int voltMv, int tempC)
        {
            lock (Gate)
            {
                if (!_ready) return false;
                int core = Clamp(coreMhz, CoreMin, CoreMax);
                int mem = Clamp(memMhz, MemMin, MemMax);
                int power = Clamp(powerPct, PowerMin, PowerMax);
                int volt = Clamp(voltMv, VoltMin, VoltMax);
                int temp = Clamp(tempC, TempMin, TempMax);
                bool any = SetOffset(DomainCore, core * 1000);
                any = SetOffset(DomainMemory, mem * 1000) || any;
                any = SetPower(power) || any;
                any = SetVoltage(volt * 1000) || any;
                any = SetTemp(temp) || any;
                return any;
            }
        }

        /// <summary>extras 為每個啟用的 graphics 點相對核心滑桿的額外 MHz；空的就整條同一偏移。</summary>
        internal static bool ApplyCurve(int coreMhz, int[] extras)
        {
            lock (Gate)
            {
                if (!_ready) return false;
                int core = Clamp(coreMhz, CoreMin, CoreMax);
                return SetCurvePoints(core, extras);
            }
        }

        internal static bool Reset()
        {
            lock (Gate)
            {
                if (!_ready) return false;
                bool ok = SetOffset(DomainCore, 0);
                ok = SetOffset(DomainMemory, 0) && ok;
                ok = SetPower(100) && ok;
                ok = SetVoltage(0) && ok;
                SetCurvePoints(0, null);
                return ok;
            }
        }

        internal static bool TryRead(out int coreOff, out int memOff, out int powerPct)
        {
            coreOff = 0;
            memOff = 0;
            powerPct = 100;
            lock (Gate)
            {
                if (!_ready) return false;
                bool any = false;
                if (_getPstates != null)
                {
                    var info = Pstates20.Blank(2);
                    if (_getPstates(_gpu, ref info) == Ok && info.numPStates > 0 && info.numClocks > 0)
                    {
                        for (int i = 0; i < info.numClocks && i < 8; i++)
                        {
                            uint domain = info.p0.clocks[i].domainId;
                            int khz = info.p0.clocks[i].deltaValue;
                            if (domain == DomainCore) coreOff = khz / 1000;
                            if (domain == DomainMemory) memOff = khz / 1000;
                        }
                        any = true;
                    }
                }
                if (_getPower != null)
                {
                    var status = PowerStatus.Blank();
                    if (_getPower(_gpu, ref status) == Ok && status.count > 0)
                    {
                        powerPct = (int)Math.Round(status.e0Power / 1000.0);
                        any = true;
                    }
                }
                return any;
            }
        }

        private static bool SetOffset(int domain, int deltaKhz)
        {
            var info = Pstates20.Blank(2);
            info.numPStates = 1;
            info.numClocks = 1;
            info.p0.pStateId = 0;
            info.p0.clocks[0].domainId = (uint)domain;
            info.p0.clocks[0].typeId = 0;
            info.p0.clocks[0].deltaValue = deltaKhz;
            return _setPstates(_gpu, ref info) == Ok;
        }

        private static bool SetPower(int percent)
        {
            var status = PowerStatus.Blank();
            status.count = 1;
            status.e0Power = (uint)(percent * 1000);
            return _setPower(_gpu, ref status) == Ok;
        }

        private static bool SetVoltage(int deltaUv)
        {
            var info = Pstates20.Blank(2);
            info.numPStates = 1;
            info.numBaseVoltages = 1;
            info.p0.pStateId = 0;
            info.p0.volts[0].domainId = 0;
            info.p0.volts[0].deltaValue = deltaUv;
            return _setPstates(_gpu, ref info) == Ok;
        }

        private static bool SetTemp(int tempC)
        {
            if (_setTemp == null) return false;
            var limit = ThermalLimit.Blank();
            limit.count = 1;
            limit.controller = 1;
            limit.value = (uint)(tempC << 8);
            limit.flags = 1;
            return _setTemp(_gpu, ref limit) == Ok;
        }

        /// <summary>Pascal 以後寫入 frequencyDeltaKHz 要 ×2。extras 依啟用 graphics 點順序。</summary>
        private static bool SetCurvePoints(int coreMhz, int[] extras)
        {
            if (_getMask == null || _getTable == null || _setTable == null) return false;
            try
            {
                var mask = ClockMasks.Blank();
                if (_getMask(_gpu, ref mask) != Ok) return false;
                var table = ClockTable.Blank();
                Buffer.BlockCopy(mask.mask, 0, table.mask, 0, 32);
                if (_getTable(_gpu, ref table) != Ok) return false;
                int n = 0;
                for (int i = 0; i < 255; i++)
                {
                    if (mask.clocks[i].enabled != 1 || table.clocks[i].clockType != 0) continue;
                    int extra = (extras != null && n < extras.Length) ? extras[n] : 0;
                    int mhz = Clamp(coreMhz + extra, CoreMin, CoreMax);
                    table.clocks[i].frequencyDeltaKHz = mhz * 2000;
                    n++;
                }
                return _setTable(_gpu, ref table) == Ok;
            }
            catch
            {
                return false;
            }
        }

        internal struct VfPoint
        {
            public int Index;
            public int VoltMv;
            public int FreqMhz;
            public int DeltaMhz;
        }

        /// <summary>啟用的 graphics 點。電壓來自 GetVFPCurve，讀不到就只給偏移。</summary>
        internal static VfPoint[] TryReadCurve()
        {
            lock (Gate)
            {
                if (!_ready || _getMask == null || _getTable == null) return Array.Empty<VfPoint>();
                try
                {
                    var mask = ClockMasks.Blank();
                    if (_getMask(_gpu, ref mask) != Ok) return Array.Empty<VfPoint>();
                    var table = ClockTable.Blank();
                    Buffer.BlockCopy(mask.mask, 0, table.mask, 0, 32);
                    if (_getTable(_gpu, ref table) != Ok) return Array.Empty<VfPoint>();
                    VfSample[] tableVf = ReadVfTable();
                    var list = new System.Collections.Generic.List<VfPoint>(64);
                    int n = 0;
                    for (int i = 0; i < 255 && list.Count < 96; i++)
                    {
                        if (mask.clocks[i].enabled != 1 || table.clocks[i].clockType != 0) continue;
                        int volt = 0;
                        int freq = 0;
                        if (tableVf != null && n < tableVf.Length)
                        {
                            volt = tableVf[n].VoltMv;
                            freq = tableVf[n].FreqMhz;
                        }
                        list.Add(new VfPoint
                        {
                            Index = i,
                            DeltaMhz = table.clocks[i].frequencyDeltaKHz / 2000,
                            VoltMv = volt,
                            FreqMhz = freq
                        });
                        n++;
                    }
                    return list.ToArray();
                }
                catch
                {
                    return Array.Empty<VfPoint>();
                }
            }
        }

        private struct VfSample
        {
            public int VoltMv;
            public int FreqMhz;
        }

        private static VfSample[] ReadVfTable()
        {
            if (_getVf == null) return null;
            const int size = 0x1C28;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                for (int i = 0; i < size; i++) Marshal.WriteByte(buf, i, 0);
                Marshal.WriteInt32(buf, 0, size | (1 << 16));
                for (int i = 4; i < 20; i++) Marshal.WriteByte(buf, i, 0xFF);
                Marshal.WriteInt32(buf, 0x14, 15);
                if (_getVf(_gpu, buf) != Ok) return null;
                var samples = new VfSample[128];
                for (int i = 0; i < 128; i++)
                {
                    int off = 0x48 + i * 0x1C;
                    int freqKhz = Marshal.ReadInt32(buf, off);
                    int uv = Marshal.ReadInt32(buf, off + 4);
                    samples[i].FreqMhz = freqKhz > 0 ? freqKhz / 1000 : 0;
                    samples[i].VoltMv = uv > 0 ? uv / 1000 : 0;
                }
                return samples;
            }
            catch
            {
                return null;
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
        }

        private static T DelegateOf<T>(uint id) where T : class
        {
            IntPtr fn = _query(id);
            if (fn == IntPtr.Zero) return null;
            return Marshal.GetDelegateForFunctionPointer(fn, typeof(T)) as T;
        }

        private static int Clamp(int value, int lo, int hi)
        {
            if (value < lo) return lo;
            if (value > hi) return hi;
            return value;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ClockEntry
        {
            public uint domainId;
            public uint typeId;
            public uint flags;
            public int deltaValue;
            public int deltaMin;
            public int deltaMax;
            public uint freqKhz;
            public uint maxFreqKhz;
            public uint voltDomain;
            public uint minUv;
            public uint maxUv;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct VoltEntry
        {
            public uint domainId;
            public uint flags;
            public uint voltageUv;
            public int deltaValue;
            public int deltaMin;
            public int deltaMax;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Pstate
        {
            public uint pStateId;
            public uint flags;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 8)]
            public ClockEntry[] clocks;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 4)]
            public VoltEntry[] volts;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct Pstates20
        {
            public uint version;
            public uint flags;
            public uint numPStates;
            public uint numClocks;
            public uint numBaseVoltages;
            public Pstate p0;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 15)]
            public Pstate[] rest;
            public uint ovCount;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 4)]
            public VoltEntry[] ov;

            public static Pstates20 Blank(uint ver)
            {
                var info = new Pstates20
                {
                    p0 = new Pstate
                    {
                        clocks = new ClockEntry[8],
                        volts = new VoltEntry[4]
                    },
                    rest = new Pstate[15],
                    ov = new VoltEntry[4]
                };
                for (int i = 0; i < 15; i++)
                {
                    info.rest[i] = new Pstate
                    {
                        clocks = new ClockEntry[8],
                        volts = new VoltEntry[4]
                    };
                }
                info.version = (uint)Marshal.SizeOf<Pstates20>() | (ver << 16);
                return info;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ThermalLimit
        {
            public uint version;
            public uint count;
            public uint controller;
            public uint value;
            public uint flags;
            public uint pad0, pad1, pad2, pad3, pad4, pad5, pad6, pad7, pad8, pad9, padA, padB;

            public static ThermalLimit Blank()
            {
                var limit = new ThermalLimit();
                limit.version = (uint)Marshal.SizeOf<ThermalLimit>() | (2u << 16);
                return limit;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MaskPoint
        {
            public uint clockType;
            public byte enabled;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 19)]
            public byte[] unknown2;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ClockMasks
        {
            public uint version;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
            public byte[] mask;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
            public byte[] unknown1;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 255)]
            public MaskPoint[] clocks;

            public static ClockMasks Blank()
            {
                var table = new ClockMasks
                {
                    mask = new byte[32],
                    unknown1 = new byte[32],
                    clocks = new MaskPoint[255]
                };
                for (int i = 0; i < 255; i++)
                {
                    table.clocks[i] = new MaskPoint { unknown2 = new byte[19] };
                }
                table.version = (uint)Marshal.SizeOf<ClockMasks>() | (1u << 16);
                return table;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ClockPoint
        {
            public uint clockType;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
            public byte[] unknown2;
            public int frequencyDeltaKHz;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 12)]
            public byte[] unknown3;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ClockTable
        {
            public uint version;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
            public byte[] mask;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)]
            public byte[] unknown1;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 255)]
            public ClockPoint[] clocks;

            public static ClockTable Blank()
            {
                var table = new ClockTable
                {
                    mask = new byte[32],
                    unknown1 = new byte[32],
                    clocks = new ClockPoint[255]
                };
                for (int i = 0; i < 255; i++)
                {
                    table.clocks[i] = new ClockPoint
                    {
                        unknown2 = new byte[16],
                        unknown3 = new byte[12]
                    };
                }
                table.version = (uint)Marshal.SizeOf<ClockTable>() | (1u << 16);
                return table;
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PowerStatus
        {
            public uint version;
            public uint count;
            public uint e0A;
            public uint e0B;
            public uint e0Power;
            public uint e0D;
            public uint e1A, e1B, e1C, e1D;
            public uint e2A, e2B, e2C, e2D;
            public uint e3A, e3B, e3C, e3D;

            public static PowerStatus Blank()
            {
                var status = new PowerStatus();
                status.version = (uint)Marshal.SizeOf<PowerStatus>() | (1u << 16);
                return status;
            }
        }

        private static class Native
        {
            [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
            public static extern IntPtr LoadLibrary(string name);

            [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
            public static extern IntPtr GetProcAddress(IntPtr module, string name);
        }
    }
}
