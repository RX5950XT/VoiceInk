using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace VoiceInkShell
{
    /// <summary>
    /// 手機／相機（MTP）。它們沒有磁碟代號，只能走殼層：`IShellItem` 列舉子項、
    /// `IFileOperation` 複製進出（跟檔案總管同一套，進度與同名詢問也是 Windows 自己的視窗）。
    ///
    /// 位址有兩種：`{ path }` 是本機路徑；`{ root, segs, parse? }` 是裝置裡的東西——
    /// root 是裝置在「本機」底下的解析名稱，segs 是一層層顯示名稱。parse 是上次列出來時
    /// 拿到的解析名稱（`SID-{…}\{物件 ID}` 那種），有就直接用，沒有才一層層列舉去找。
    /// </summary>
    internal static class Portable
    {
        private static Guid IID_IShellItem = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        private static Guid BHID_EnumItems = new Guid("94F60519-2850-4924-AA5A-D15E84868039");
        private static Guid IID_IEnumShellItems = new Guid("70629033-E363-4A28-A567-0DB78006E6D7");
        private static readonly Guid CLSID_FileOperation = new Guid("3AD05575-8857-4850-9277-11B85BDB8E09");

        private const uint SIGDN_NORMALDISPLAY = 0;
        private const uint SIGDN_DESKTOPABSOLUTEPARSING = 0x80028000;
        private const uint SFGAO_FOLDER = 0x20000000;
        private const uint SFGAO_STREAM = 0x00400000;

        private const uint FOF_SILENT = 0x0004;
        private const uint FOF_NOCONFIRMATION = 0x0010;
        private const uint FOF_NOCONFIRMMKDIR = 0x0200;
        private const uint FOF_NOERRORUI = 0x0400;

        // System.FileName（含副檔名，不受「隱藏副檔名」影響）、System.Size、System.DateModified
        private static PROPERTYKEY PKEY_FileName = new PROPERTYKEY(new Guid("41CF5AE0-F75A-4806-BD87-59C7D9248EB9"), 100);
        private static PROPERTYKEY PKEY_Size = new PROPERTYKEY(new Guid("B725F130-47EF-101A-A5F1-02608C9EEBAC"), 12);
        private static PROPERTYKEY PKEY_DateModified = new PROPERTYKEY(new Guid("B725F130-47EF-101A-A5F1-02608C9EEBAC"), 14);

        /// <summary>一個資料夾最多列幾筆：相機資料夾幾千張很正常，再多就是異常</summary>
        private const int MaxItems = 50000;

        public static void List(JsonElement root, Utf8JsonWriter w)
        {
            IShellItem2 folder = Resolve(root.GetProperty("at"));
            w.WriteStartArray("items");
            int count = 0;
            foreach (IShellItem2 child in Children(folder))
            {
                if (count++ >= MaxItems) break;
                uint attrs;
                child.GetAttributes(SFGAO_FOLDER | SFGAO_STREAM, out attrs);
                bool dir = (attrs & SFGAO_FOLDER) != 0 && (attrs & SFGAO_STREAM) == 0;
                w.WriteStartObject();
                w.WriteString("name", NameOf(child));
                w.WriteString("parse", Display(child, SIGDN_DESKTOPABSOLUTEPARSING) ?? "");
                w.WriteBoolean("dir", dir);
                ulong size;
                if (!dir && child.GetUInt64(ref PKEY_Size, out size) == 0) w.WriteNumber("size", size);
                long ft;
                if (child.GetFileTime(ref PKEY_DateModified, out ft) == 0 && ft > 0)
                {
                    w.WriteNumber("mtimeMs", (ft - 116444736000000000L) / 10000);
                }
                w.WriteEndObject();
                Marshal.ReleaseComObject(child);
            }
            w.WriteEndArray();
        }

        /// <summary>
        /// 複製：from 每一項、to 一個資料夾，都是位址。silent＝開檔／預覽用的暫存複製，
        /// 不跳任何視窗、同名直接蓋掉；否則進度與同名詢問都交給 Windows。
        /// </summary>
        public static void Copy(JsonElement root, Utf8JsonWriter w)
        {
            IShellItem2 dest = Resolve(root.GetProperty("to"));
            bool silent = root.TryGetProperty("silent", out JsonElement s) && s.ValueKind == JsonValueKind.True;
            uint flags = silent ? FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOCONFIRMMKDIR | FOF_NOERRORUI : FOF_NOCONFIRMMKDIR;
            Run(root, "from", flags, w, (op, item) => op.CopyItem(item, dest, null, IntPtr.Zero));
        }

        /// <summary>刪除（手機沒有回收筒＝永久刪除）。App 那邊已經問過了，這裡不再跳確認。</summary>
        public static void Delete(JsonElement root, Utf8JsonWriter w)
        {
            Run(root, "items", FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI, w, (op, item) => op.DeleteItem(item, IntPtr.Zero));
        }

        private static void Run(JsonElement root, string listName, uint flags, Utf8JsonWriter w, Func<IFileOperation, IShellItem2, int> queue)
        {
            IFileOperation op = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_FileOperation));
            try
            {
                Check(op.SetOperationFlags(flags));
                long hwnd;
                if (long.TryParse(Str(root, "hwnd") ?? "0", out hwnd) && hwnd != 0) op.SetOwnerWindow(new IntPtr(hwnd));
                int queued = 0;
                foreach (JsonElement at in root.GetProperty(listName).EnumerateArray())
                {
                    if (queued >= 500) break;
                    Check(queue(op, Resolve(at)));
                    queued++;
                }
                if (queued == 0) throw new InvalidOperationException("nothing to do");
                int hr = op.PerformOperations();
                int aborted;
                op.GetAnyOperationsAborted(out aborted);
                // 使用者在 Windows 的視窗按取消＝ERROR_CANCELLED（0x800704C7），不算壞掉
                w.WriteBoolean("aborted", aborted != 0 || hr == unchecked((int)0x800704C7));
                if (hr != 0 && hr != unchecked((int)0x800704C7)) throw new InvalidOperationException("operation failed");
            }
            finally
            {
                Marshal.ReleaseComObject(op);
            }
        }

        // ---- 解析位址 ----

        private static IShellItem2 Resolve(JsonElement at)
        {
            string local = Str(at, "path");
            if (local != null) return FromParsing(local);
            string parse = Str(at, "parse");
            if (!string.IsNullOrEmpty(parse))
            {
                try { return FromParsing(parse); } catch (Exception) { /* 裝置重插過，物件 ID 變了就退回一層層找 */ }
            }
            IShellItem2 item = FromParsing(Str(at, "root") ?? throw new ArgumentException("root"));
            if (at.TryGetProperty("segs", out JsonElement segs) && segs.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement seg in segs.EnumerateArray()) item = Child(item, seg.GetString() ?? "");
            }
            return item;
        }

        private static IShellItem2 Child(IShellItem2 parent, string name)
        {
            foreach (IShellItem2 child in Children(parent))
            {
                if (string.Equals(NameOf(child), name, StringComparison.OrdinalIgnoreCase)) return child;
                Marshal.ReleaseComObject(child);
            }
            throw new InvalidOperationException("not found");
        }

        private static IEnumerable<IShellItem2> Children(IShellItem2 folder)
        {
            IntPtr raw;
            Check(folder.BindToHandler(IntPtr.Zero, ref BHID_EnumItems, ref IID_IEnumShellItems, out raw));
            IEnumShellItems items = (IEnumShellItems)Marshal.GetObjectForIUnknown(raw);
            Marshal.Release(raw);
            try
            {
                while (true)
                {
                    IShellItem next;
                    uint fetched;
                    if (items.Next(1, out next, out fetched) != 0 || fetched == 0 || next == null) yield break;
                    yield return (IShellItem2)next;
                }
            }
            finally
            {
                Marshal.ReleaseComObject(items);
            }
        }

        private static IShellItem2 FromParsing(string name)
        {
            IntPtr raw;
            Check(Native.SHCreateItemFromParsingName(name, IntPtr.Zero, ref IID_IShellItem, out raw));
            try { return (IShellItem2)Marshal.GetObjectForIUnknown(raw); }
            finally { Marshal.Release(raw); }
        }

        private static string NameOf(IShellItem2 item)
        {
            IntPtr text;
            if (item.GetString(ref PKEY_FileName, out text) == 0 && text != IntPtr.Zero)
            {
                string name = Marshal.PtrToStringUni(text);
                Marshal.FreeCoTaskMem(text);
                if (!string.IsNullOrEmpty(name)) return name;
            }
            return Display(item, SIGDN_NORMALDISPLAY) ?? "";
        }

        private static string Display(IShellItem2 item, uint kind)
        {
            IntPtr text;
            if (item.GetDisplayName(kind, out text) != 0 || text == IntPtr.Zero) return null;
            string value = Marshal.PtrToStringUni(text);
            Marshal.FreeCoTaskMem(text);
            return value;
        }

        private static void Check(int hr)
        {
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        }

        private static string Str(JsonElement root, string name)
        {
            return root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out JsonElement v)
                && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
        public PROPERTYKEY(Guid f, uint p) { fmtid = f; pid = p; }
    }

    // vtable 順序照 ShObjIdl_core.h，不可重排（見 Interop.cs 開頭）
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IShellItem ppsi);
        [PreserveSig] int GetDisplayName(uint sigdn, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attrs);
        [PreserveSig] int Compare(IShellItem psi, uint hint, out int order);
    }

    [ComImport, Guid("7E9FB0D3-919F-4307-AB2E-9B1860310C93"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem2 : IShellItem
    {
        [PreserveSig] new int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] new int GetParent(out IShellItem ppsi);
        [PreserveSig] new int GetDisplayName(uint sigdn, out IntPtr name);
        [PreserveSig] new int GetAttributes(uint mask, out uint attrs);
        [PreserveSig] new int Compare(IShellItem psi, uint hint, out int order);
        [PreserveSig] int GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetPropertyStoreWithCreateObject(int flags, IntPtr punk, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetPropertyStoreForKeys(IntPtr keys, uint count, int flags, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetPropertyDescriptionList(ref PROPERTYKEY keyType, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int Update(IntPtr pbc);
        [PreserveSig] int GetProperty(ref PROPERTYKEY key, IntPtr propvar);
        [PreserveSig] int GetCLSID(ref PROPERTYKEY key, out Guid clsid);
        [PreserveSig] int GetFileTime(ref PROPERTYKEY key, out long ft);
        [PreserveSig] int GetInt32(ref PROPERTYKEY key, out int value);
        [PreserveSig] int GetString(ref PROPERTYKEY key, out IntPtr value);
        [PreserveSig] int GetUInt32(ref PROPERTYKEY key, out uint value);
        [PreserveSig] int GetUInt64(ref PROPERTYKEY key, out ulong value);
        [PreserveSig] int GetBool(ref PROPERTYKEY key, out int value);
    }

    [ComImport, Guid("70629033-E363-4A28-A567-0DB78006E6D7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IEnumShellItems
    {
        [PreserveSig] int Next(uint celt, out IShellItem item, out uint fetched);
        [PreserveSig] int Skip(uint celt);
        [PreserveSig] int Reset();
        [PreserveSig] int Clone(out IEnumShellItems ppenum);
    }

    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOperation
    {
        [PreserveSig] int Advise(IntPtr sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOperationFlags(uint flags);
        [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        [PreserveSig] int SetProgressDialog(IntPtr dialog);
        [PreserveSig] int SetProperties(IntPtr props);
        [PreserveSig] int SetOwnerWindow(IntPtr hwnd);
        [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
        [PreserveSig] int ApplyPropertiesToItems(IntPtr items);
        [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        [PreserveSig] int RenameItems(IntPtr items, [MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int MoveItem(IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        [PreserveSig] int MoveItems(IntPtr items, IShellItem dest);
        [PreserveSig] int CopyItem(IShellItem item, IShellItem dest, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        [PreserveSig] int CopyItems(IntPtr items, IShellItem dest);
        [PreserveSig] int DeleteItem(IShellItem item, IntPtr sink);
        [PreserveSig] int DeleteItems(IntPtr items);
        [PreserveSig] int NewItem(IShellItem dest, uint attrs, [MarshalAs(UnmanagedType.LPWStr)] string name,
            [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
        [PreserveSig] int PerformOperations();
        [PreserveSig] int GetAnyOperationsAborted(out int aborted);
    }
}
