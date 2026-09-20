using System;
using System.Runtime.InteropServices;

namespace VoiceInkShell
{
    /// <summary>一張 32bpp 的圖，位元組順序是 BGRA（跟 Windows DIB 一樣，renderer 自己換成 RGBA）。</summary>
    internal sealed class Bgra
    {
        public int Width;
        public int Height;
        public byte[] Bytes;
        /// <summary>殼層還在現生縮圖，這張只是暫時能顯示的圖（通常是類型圖示）。</summary>
        public bool Pending;
    }

    /// <summary>
    /// HBITMAP／HICON 轉成 BGRA 位元組。
    ///
    /// 不用 System.Drawing：那會把 WindowsDesktop 執行環境整包拉進來（見 csproj）。
    /// 而且 `Icon.ToBitmap()` 的 alpha 本來就不可靠，自己讀 DIB 反而單純。
    /// </summary>
    internal static class Pixels
    {
        /// <summary>
        /// 選單項目的 hbmpItem 可能根本不是點陣圖：HBMMENU_CALLBACK 是 -1，
        /// 其餘 HBMMENU_* 是 1～12 的小數字。真的控制代碼一定是指標，值很大。
        /// </summary>
        public static bool IsRealBitmap(IntPtr hbmp)
        {
            return hbmp.ToInt64() > 16;
        }

        /// <summary>整張都是透明的就當成「沒有這張圖」——延遲載入還沒好時會拿到空白格。</summary>
        public static bool HasAnyPixel(Bgra image)
        {
            return image != null && HasAlpha(image.Bytes);
        }

        public static Bgra FromBitmap(IntPtr hbmp)
        {
            if (hbmp == IntPtr.Zero) return null;
            BITMAP bm = new BITMAP();
            if (Native.GetObject(hbmp, Marshal.SizeOf<BITMAP>(), ref bm) == 0) return null;
            if (bm.bmWidth <= 0 || bm.bmHeight == 0 || bm.bmWidth > 256 || Math.Abs(bm.bmHeight) > 256) return null;
            return ReadDib(hbmp, bm.bmWidth, Math.Abs(bm.bmHeight));
        }

        public static Bgra FromIcon(IntPtr hicon)
        {
            if (hicon == IntPtr.Zero) return null;
            ICONINFO info;
            if (!Native.GetIconInfo(hicon, out info)) return null;
            try
            {
                Bgra color = FromBitmap(info.hbmColor);
                if (color == null) return null;
                if (!HasAlpha(color.Bytes)) ApplyMask(color, info.hbmMask);
                return color;
            }
            finally
            {
                if (info.hbmColor != IntPtr.Zero) Native.DeleteObject(info.hbmColor);
                if (info.hbmMask != IntPtr.Zero) Native.DeleteObject(info.hbmMask);
            }
        }

        /// <summary>負的 biHeight ＝由上往下，省得自己翻轉。</summary>
        private static Bgra ReadDib(IntPtr hbmp, int width, int height)
        {
            BITMAPINFOHEADER header = new BITMAPINFOHEADER
            {
                biSize = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
                biWidth = width,
                biHeight = -height,
                biPlanes = 1,
                biBitCount = 32,
                biCompression = 0
            };
            byte[] bytes = new byte[width * height * 4];
            IntPtr dc = Native.CreateCompatibleDC(IntPtr.Zero);
            if (dc == IntPtr.Zero) return null;
            try
            {
                if (Native.GetDIBits(dc, hbmp, 0, (uint)height, bytes, ref header, 0) == 0) return null;
            }
            finally
            {
                Native.DeleteDC(dc);
            }
            return new Bgra { Width = width, Height = height, Bytes = bytes };
        }

        private static bool HasAlpha(byte[] bytes)
        {
            for (int i = 3; i < bytes.Length; i += 4)
            {
                if (bytes[i] != 0) return true;
            }
            return false;
        }

        /// <summary>舊式 24bpp 圖示沒有 alpha，透明度在另一張單色遮罩裡（1 ＝透明）。</summary>
        private static void ApplyMask(Bgra color, IntPtr hbmMask)
        {
            Bgra mask = hbmMask == IntPtr.Zero ? null : FromBitmap(hbmMask);
            for (int i = 0; i < color.Bytes.Length; i += 4)
            {
                bool clear = mask != null && i < mask.Bytes.Length && mask.Bytes[i] != 0;
                color.Bytes[i + 3] = clear ? (byte)0 : (byte)255;
            }
        }
    }
}
