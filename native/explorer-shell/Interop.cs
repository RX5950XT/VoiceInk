using System;
using System.Runtime.InteropServices;

namespace VoiceInkShell
{
    /// <summary>
    /// 殼層 COM 介面與 Win32 宣告。
    ///
    /// 這裡每個介面的方法順序就是 vtable 順序，**不可以重排、不可以漏**——漏一個
    /// 後面全部錯位，症狀不是編譯錯誤而是執行時隨機當掉或回垃圾值。
    /// </summary>
    internal static class Guids
    {
        public static Guid IShellFolder = new Guid("000214E6-0000-0000-C000-000000000046");
        public static Guid IContextMenu = new Guid("000214E4-0000-0000-C000-000000000046");
        public static Guid IContextMenu2 = new Guid("000214F4-0000-0000-C000-000000000046");
        public static Guid IContextMenu3 = new Guid("BCFCE0A0-EC17-11D0-8D10-00A0C90F2719");
        public static Guid IImageList = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
        public static Guid IShellItemImageFactory = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    }

    [ComImport, Guid("000214E6-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellFolder
    {
        [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string name,
            ref uint eaten, out IntPtr pidl, ref uint attributes);
        [PreserveSig] int EnumObjects(IntPtr hwnd, int flags, out IntPtr enumIdList);
        [PreserveSig] int BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
        [PreserveSig] int CreateViewObject(IntPtr hwndOwner, ref Guid riid, out IntPtr ppv);
        // pidl 陣列一定要明寫 LPArray：ComImport 介面上的陣列預設會被當成 SAFEARRAY 送，
        // 對面收到的就是一個完全不同的東西——症狀是 GetUIObjectOf 當場 AccessViolation。
        [PreserveSig] int GetAttributesOf(uint count,
            [In, MarshalAs(UnmanagedType.LPArray)] IntPtr[] pidls, ref uint inOut);
        [PreserveSig] int GetUIObjectOf(IntPtr hwndOwner, uint count,
            [In, MarshalAs(UnmanagedType.LPArray)] IntPtr[] pidls,
            ref Guid riid, IntPtr rgfReserved, out IntPtr ppv);
        [PreserveSig] int GetDisplayNameOf(IntPtr pidl, uint flags, IntPtr name);
        [PreserveSig] int SetNameOf(IntPtr hwnd, IntPtr pidl, [MarshalAs(UnmanagedType.LPWStr)] string name,
            uint flags, out IntPtr pidlOut);
    }

    [ComImport, Guid("000214E4-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IContextMenu
    {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint flags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX info);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint type, IntPtr reserved, IntPtr commandString, uint cch);
    }

    [ComImport, Guid("000214F4-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IContextMenu2
    {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint flags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX info);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint type, IntPtr reserved, IntPtr commandString, uint cch);
        [PreserveSig] int HandleMenuMsg(uint msg, IntPtr wParam, IntPtr lParam);
    }

    [ComImport, Guid("BCFCE0A0-EC17-11D0-8D10-00A0C90F2719")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IContextMenu3
    {
        [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint flags);
        [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX info);
        [PreserveSig] int GetCommandString(UIntPtr idCmd, uint type, IntPtr reserved, IntPtr commandString, uint cch);
        [PreserveSig] int HandleMenuMsg(uint msg, IntPtr wParam, IntPtr lParam);
        [PreserveSig] int HandleMenuMsg2(uint msg, IntPtr wParam, IntPtr lParam, out IntPtr result);
    }

    /// <summary>系統圖示清單，只用得到 GetIcon；前面的成員純粹佔 vtable 位置。</summary>
    [ComImport, Guid("46EB5926-582E-4017-9FDF-E8998DAA0950")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IImageList
    {
        [PreserveSig] int Add(IntPtr hbmImage, IntPtr hbmMask, ref int i);
        [PreserveSig] int ReplaceIcon(int i, IntPtr hicon, ref int index);
        [PreserveSig] int SetOverlayImage(int iImage, int iOverlay);
        [PreserveSig] int Replace(int i, IntPtr hbmImage, IntPtr hbmMask);
        [PreserveSig] int AddMasked(IntPtr hbmImage, int crMask, ref int i);
        [PreserveSig] int Draw(IntPtr pimldp);
        [PreserveSig] int Remove(int i);
        [PreserveSig] int GetIcon(int i, int flags, out IntPtr hicon);
        [PreserveSig] int GetImageInfo(int i, IntPtr info);
        [PreserveSig] int Copy(int dst, IntPtr src, int srcIndex, int flags);
        [PreserveSig] int Merge(int i1, IntPtr list, int i2, int dx, int dy, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int Clone(ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetImageRect(int i, IntPtr rect);
        [PreserveSig] int GetIconSize(out int cx, out int cy);
        [PreserveSig] int SetIconSize(int cx, int cy);
        [PreserveSig] int GetImageCount(out int count);
        [PreserveSig] int SetImageCount(int count);
        [PreserveSig] int SetBkColor(int color, out int old);
        [PreserveSig] int GetBkColor(out int color);
        [PreserveSig] int BeginDrag(int track, int dxHotspot, int dyHotspot);
        [PreserveSig] int DragEnter(IntPtr hwndLock, int x, int y);
        [PreserveSig] int DragLeave(IntPtr hwndLock);
        [PreserveSig] int DragMove(int x, int y);
        [PreserveSig] int SetDragCursorImage(IntPtr list, int drag, int dxHotspot, int dyHotspot);
        [PreserveSig] int DragShowNolock(int show);
        [PreserveSig] int GetDragImage(IntPtr pt, IntPtr hotspot, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetItemFlags(int i, out int flags);
        [PreserveSig] int GetOverlayImage(int overlay, out int image);
    }

    /// <summary>
    /// 檔案總管拿縮圖的入口。GetImage 的 SIZE 是值型別、vtable 第一個方法，
    /// 漏一個後面就錯位。
    /// </summary>
    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItemImageFactory
    {
        [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    internal struct CMINVOKECOMMANDINFOEX
    {
        public int cbSize;
        public uint fMask;
        public IntPtr hwnd;
        public IntPtr lpVerb;
        [MarshalAs(UnmanagedType.LPStr)] public string lpParameters;
        [MarshalAs(UnmanagedType.LPStr)] public string lpDirectory;
        public int nShow;
        public uint dwHotKey;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.LPStr)] public string lpTitle;
        public IntPtr lpVerbW;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpParametersW;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectoryW;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpTitleW;
        public int ptX;
        public int ptY;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MENUITEMINFOW
    {
        public uint cbSize;
        public uint fMask;
        public uint fType;
        public uint fState;
        public uint wID;
        public IntPtr hSubMenu;
        public IntPtr hbmpChecked;
        public IntPtr hbmpUnchecked;
        public IntPtr dwItemData;
        public IntPtr dwTypeData;
        public uint cch;
        public IntPtr hbmpItem;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct SHFILEINFOW
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SIZE
    {
        public int cx;
        public int cy;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BITMAP
    {
        public int bmType;
        public int bmWidth;
        public int bmHeight;
        public int bmWidthBytes;
        public ushort bmPlanes;
        public ushort bmBitsPixel;
        public IntPtr bmBits;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BITMAPINFOHEADER
    {
        public uint biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public uint biCompression;
        public uint biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public uint biClrUsed;
        public uint biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ICONINFO
    {
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    internal static class Native
    {
        // ---- 選單旗標 ----
        public const uint CMF_NORMAL = 0x00000000;
        public const uint CMF_EXPLORE = 0x00000004;
        public const uint CMF_ITEMMENU = 0x00000080;
        public const uint CMF_EXTENDEDVERBS = 0x00000100;
        // 子選單要在 QueryContextMenu 當下就填好，不然「傳送到」拿到的是空的
        public const uint CMF_SYNCCASCADEMENU = 0x00001000;
        public const uint CMIC_MASK_UNICODE = 0x00004000;

        public const uint MIIM_STATE = 0x00000001;
        public const uint MIIM_ID = 0x00000002;
        public const uint MIIM_SUBMENU = 0x00000004;
        public const uint MIIM_STRING = 0x00000040;
        public const uint MIIM_BITMAP = 0x00000080;
        public const uint MIIM_FTYPE = 0x00000100;
        public const uint MIIM_DATA = 0x00000020;

        public const uint MFT_SEPARATOR = 0x00000800;
        public const uint MFT_OWNERDRAW = 0x00000100;
        public const uint MFS_DISABLED = 0x00000003;
        public const uint MFS_CHECKED = 0x00000008;

        public const uint MF_BYPOSITION = 0x00000400;

        public const uint WM_INITMENUPOPUP = 0x0117;

        public const uint GCS_VERBW = 0x00000004;

        // ---- SHGetFileInfo 旗標 ----
        public const uint SHGFI_ICON = 0x000000100;
        public const uint SHGFI_SMALLICON = 0x000000001;
        public const uint SHGFI_LARGEICON = 0x000000000;
        public const uint SHGFI_OVERLAYINDEX = 0x000000040;
        public const uint SHGFI_ADDOVERLAYS = 0x000000020;

        // IShellItemImageFactory.GetImage：有縮圖給縮圖，沒有就給圖示。
        // THUMBNAILONLY 只拿來探「有沒有真縮圖」；沒有就退回 RESIZETOFIT | BIGGERSIZEOK。
        public const int SIIGBF_RESIZETOFIT = 0x00000000;
        public const int SIIGBF_BIGGERSIZEOK = 0x00000001;
        public const int SIIGBF_ICONONLY = 0x00000004;
        public const int SIIGBF_THUMBNAILONLY = 0x00000008;
        public const int SIIGBF_INCACHEONLY = 0x00000010;

        [DllImport("ole32.dll")] public static extern int OleInitialize(IntPtr reserved);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHParseDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr bindCtx,
            out IntPtr pidl, uint sfgaoIn, out uint sfgaoOut);

        [DllImport("shell32.dll")]
        public static extern int SHBindToParent(IntPtr pidl, ref Guid riid, out IntPtr ppv, out IntPtr pidlLast);

        [DllImport("shell32.dll")]
        public static extern int SHBindToObject(IntPtr psf, IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);

        [DllImport("shell32.dll")] public static extern IntPtr ILFindLastID(IntPtr pidl);
        [DllImport("shell32.dll")] public static extern void ILFree(IntPtr pidl);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SHGetFileInfoW([MarshalAs(UnmanagedType.LPWStr)] string path, uint attributes,
            ref SHFILEINFOW info, uint cbSize, uint flags);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr bindCtx,
            ref Guid riid, out IntPtr ppv);

        [DllImport("shell32.dll")]
        public static extern int SHGetImageList(int imageList, ref Guid riid, out IImageList ppv);

        [DllImport("user32.dll")] public static extern IntPtr CreatePopupMenu();
        [DllImport("user32.dll")] public static extern bool DestroyMenu(IntPtr hmenu);
        [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr hmenu);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern bool GetMenuItemInfoW(IntPtr hmenu, uint item, bool byPosition, ref MENUITEMINFOW info);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetMenuStringW(IntPtr hmenu, uint item, [Out] char[] text, int max, uint flags);

        [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hicon);
        [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hicon, out ICONINFO info);
        [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);

        [DllImport("gdi32.dll")] public static extern int GetObject(IntPtr handle, int count, ref BITMAP obj);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);

        [DllImport("gdi32.dll")]
        public static extern int GetDIBits(IntPtr hdc, IntPtr hbmp, uint start, uint lines, byte[] bits,
            ref BITMAPINFOHEADER info, uint usage);
    }
}
