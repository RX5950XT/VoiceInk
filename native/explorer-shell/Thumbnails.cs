using System;
using System.Runtime.InteropServices;

namespace VoiceInkShell
{
    /// <summary>
    /// 真正的檔案縮圖（照片／影片／PDF 預覽），不是 SHGetFileInfo 的類型圖示。
    ///
    /// 走 IShellItemImageFactory.GetImage，旗標是「有縮圖給縮圖、沒有就給圖示」。
    /// 不要用 SIIGBF_THUMBNAILONLY：沒預覽的檔會直接失敗，呼叫端還得再問一次圖示。
    /// </summary>
    internal static class Thumbnails
    {
        public const int DefaultSize = 96;
        public const int MinSize = 16;
        /// <summary>跟 shell.js toPng 同一個上限：再大就變成 IPC 裡幾百 KB 的 base64。</summary>
        public const int MaxSize = 256;

        public static int ClampSize(int size)
        {
            if (size < MinSize) return DefaultSize;
            if (size > MaxSize) return MaxSize;
            return size;
        }

        public static Bgra Of(string path, int size)
        {
            if (string.IsNullOrEmpty(path)) return null;
            int edge = ClampSize(size);
            Guid iid = Guids.IShellItemImageFactory;
            IntPtr unk;
            int hr = Native.SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out unk);
            if (hr != 0 || unk == IntPtr.Zero) return null;
            object com = Marshal.GetObjectForIUnknown(unk);
            Marshal.Release(unk);
            try
            {
                IShellItemImageFactory factory = com as IShellItemImageFactory;
                if (factory == null) return null;
                SIZE sz = new SIZE { cx = edge, cy = edge };
                IntPtr hbmp;
                int flags = Native.SIIGBF_RESIZETOFIT | Native.SIIGBF_BIGGERSIZEOK;
                hr = factory.GetImage(sz, flags, out hbmp);
                if (hr != 0 || hbmp == IntPtr.Zero) return null;
                try
                {
                    return Pixels.FromBitmap(hbmp);
                }
                finally
                {
                    Native.DeleteObject(hbmp);
                }
            }
            finally
            {
                Marshal.ReleaseComObject(com);
            }
        }
    }
}
