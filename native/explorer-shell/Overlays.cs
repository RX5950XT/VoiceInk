using System;
using System.Runtime.InteropServices;

namespace VoiceInkShell
{
    /// <summary>
    /// 圖示重疊（icon overlay）——Google Drive 的綠勾／雲朵／同步中，OneDrive、
    /// TortoiseSVN 也都是這一套。
    ///
    /// 誰畫什麼由登錄檔的 `ShellIconOverlayIdentifiers` 決定，每個處理常式拿到一個
    /// 1～15 的槽位；`SHGetFileInfo` 會把槽位編號放在 `iIcon` 的最高位元組，
    /// 0 ＝這個路徑沒有任何重疊。
    ///
    /// **不要想自己把那張小圖單獨挖出來**：`IImageList::GetOverlayImage` 在這台
    /// Windows 11 上不管傳哪個槽位都回同一個索引（實測 8～15 全回 1，畫出來是
    /// 一張通用文件圖示），而「空白圖＋INDEXTOOVERLAYMASK」取回來整張是透明的。
    /// 正解是讓殼層自己疊：`SHGFI_ADDOVERLAYS` 回來的就是檔案總管畫在畫面上的那張。
    /// </summary>
    internal static class Overlays
    {
        /// <summary>回傳這個路徑的重疊槽位；問不到就當成 0（沒有重疊），不是錯誤。</summary>
        public static int IndexOf(string path)
        {
            if (string.IsNullOrEmpty(path)) return 0;
            SHFILEINFOW info = new SHFILEINFOW();
            // **一定要配 SHGFI_ICON**：`SHGFI_OVERLAYINDEX` 是「修飾 SHGFI_ICON」的旗標，
            // 跟 `SHGFI_SYSICONINDEX` 一起用會安靜地一律回 0（實測 Google Drive 的路徑
            // 用 SYSICONINDEX 拿到 0、用 ICON 拿到 12）。代價是每問一次配一個 HICON，
            // 所以要立刻 DestroyIcon，不然列一個資料夾就漏幾百個控制代碼。
            uint flags = Native.SHGFI_ICON | Native.SHGFI_OVERLAYINDEX | Native.SHGFI_SMALLICON;
            IntPtr result = Native.SHGetFileInfoW(path, 0, ref info,
                (uint)Marshal.SizeOf<SHFILEINFOW>(), flags);
            if (result == IntPtr.Zero) return 0;
            if (info.hIcon != IntPtr.Zero) Native.DestroyIcon(info.hIcon);
            int slot = (info.iIcon >> 24) & 0xFF;
            return slot <= 15 ? slot : 0;
        }

        /// <summary>這個路徑在檔案總管裡實際長的樣子（32×32，含疊上去的同步標記）。</summary>
        public static Bgra IconOf(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            SHFILEINFOW info = new SHFILEINFOW();
            uint flags = Native.SHGFI_ICON | Native.SHGFI_ADDOVERLAYS | Native.SHGFI_LARGEICON;
            IntPtr result = Native.SHGetFileInfoW(path, 0, ref info,
                (uint)Marshal.SizeOf<SHFILEINFOW>(), flags);
            if (result == IntPtr.Zero || info.hIcon == IntPtr.Zero) return null;
            try
            {
                return Pixels.FromIcon(info.hIcon);
            }
            finally
            {
                Native.DestroyIcon(info.hIcon);
            }
        }
    }
}
