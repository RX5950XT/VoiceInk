using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace VoiceInkHook
{
    /// <summary>
    /// VoiceInk 語音輸入的全域熱鍵 sidecar（Windows 低階鍵盤 hook）。
    ///
    /// 用法：VoiceInkHook.exe            （預設綁右 Alt）
    ///       VoiceInkHook.exe --key 0xA5 （綁別的虛擬鍵碼）
    ///
    /// stdout 一行一個事件（父程序靠這個驅動狀態機）：
    ///   READY   hook 掛上了
    ///   D       熱鍵按下（作業系統的 auto-repeat 也會重送，父程序自己擋）
    ///   U       熱鍵放開
    ///   E       Esc 按下（取消用；**不吞**，Esc 要照樣送給前景程式）
    ///
    /// 關鍵differences與 uiohook：熱鍵的 down/up **回傳 1 吞掉**，前景程式完全收不到，
    /// 所以不會再有「Alt 叫出選單列」那種副作用，也不需要補送 F24 去中和。
    /// 注入的按鍵（LLKHF_INJECTED）一律放行，免得吃到自己或別的自動化工具送的鍵。
    ///
    /// 停止＝父程序把這支砍掉（hook 隨程序消失）。
    /// </summary>
    internal static class Program
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;
        private const uint LLKHF_INJECTED = 0x10;
        private const int VK_RMENU = 0xA5;
        private const int VK_ESCAPE = 0x1B;
        /// 父程序不見了就自己收工，不要變成攔著全機鍵盤的孤兒程序
        private const int ParentCheckMs = 2000;

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public int ptX;
            public int ptY;
        }

        private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookExW(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern int GetMessageW(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetModuleHandleW(string lpModuleName);

        private static int _hotkey = VK_RMENU;
        private static IntPtr _hook = IntPtr.Zero;
        /// 委派要自己抓著：被 GC 掉之後 Windows 回呼一個不存在的位址，整台機器的鍵盤就卡住了
        private static HookProc _proc;
        private static readonly object WriteLock = new object();

        private static int Main(string[] args)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] != "--key")
                {
                    continue;
                }
                string raw = args[i + 1];
                bool hex = raw.StartsWith("0x", StringComparison.OrdinalIgnoreCase);
                if (int.TryParse(hex ? raw.Substring(2) : raw,
                        hex ? System.Globalization.NumberStyles.HexNumber : System.Globalization.NumberStyles.Integer,
                        System.Globalization.CultureInfo.InvariantCulture, out int key)
                    && key > 0 && key <= 0xFF)
                {
                    _hotkey = key;
                }
            }

            var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))
            {
                AutoFlush = true
            };
            Console.SetOut(stdout);

            _proc = HookCallback;
            _hook = SetWindowsHookExW(WH_KEYBOARD_LL, _proc, GetModuleHandleW(null), 0);
            if (_hook == IntPtr.Zero)
            {
                Console.Out.WriteLine("ERR hook");
                return 3;
            }
            Console.Out.WriteLine("READY");

            // 父程序關掉時 stdin 會收到 EOF；主執行緒要留給訊息迴圈，所以另開一條來等
            var watcher = new Thread(WatchParent) { IsBackground = true };
            watcher.Start();

            // 低階 hook 的 callback 只會在「有訊息迴圈」的執行緒上被呼叫，這個迴圈不能省
            while (GetMessageW(out MSG msg, IntPtr.Zero, 0, 0) > 0)
            {
                // 這支沒有視窗，收到的訊息不必轉發
            }

            UnhookWindowsHookEx(_hook);
            return 0;
        }

        private static void WatchParent()
        {
            try
            {
                var stdin = Console.OpenStandardInput();
                var buffer = new byte[64];
                while (true)
                {
                    int read = stdin.Read(buffer, 0, buffer.Length);
                    if (read <= 0)
                    {
                        break; // EOF＝父程序關了
                    }
                }
            }
            catch
            {
                // 讀不到就當父程序已經走了
            }
            Environment.Exit(0);
        }

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0)
            {
                return CallNextHookEx(_hook, nCode, wParam, lParam);
            }

            var data = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            int message = wParam.ToInt32();
            bool injected = (data.flags & LLKHF_INJECTED) != 0;
            bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            bool up = message == WM_KEYUP || message == WM_SYSKEYUP;

            if (!injected && data.vkCode == (uint)_hotkey && (down || up))
            {
                Emit(down ? "D" : "U");
                // 回傳 1＝這顆鍵到此為止，前景程式什麼都收不到（這就是整支程式存在的理由）
                return new IntPtr(1);
            }

            if (!injected && down && data.vkCode == VK_ESCAPE)
            {
                // Esc 只是「取消錄音」的訊號，一定要放行——吞掉它會弄壞所有程式的 Esc
                Emit("E");
            }

            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        private static void Emit(string line)
        {
            // hook callback 有時間預算（超過 LowLevelHooksTimeout 會被系統拔掉），
            // 這裡只寫一行短字串，AutoFlush 的成本可以接受
            lock (WriteLock)
            {
                try
                {
                    Console.Out.WriteLine(line);
                }
                catch
                {
                    // 父程序不讀了：交給 WatchParent 收尾，這裡不能讓例外飛回 Windows
                }
            }
        }
    }
}
