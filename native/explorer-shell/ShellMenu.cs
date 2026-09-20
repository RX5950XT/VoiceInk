using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace VoiceInkShell
{
    internal sealed class MenuNode
    {
        public uint Id;              // 相對命令編號（已扣掉 idCmdFirst）
        public string Label;
        public string Verb;          // 有的話；用來跟 App 自己的項目去重
        public bool Separator;
        public bool Disabled;
        public bool Checked;
        public Bgra Icon;
        public List<MenuNode> Children;
    }

    /// <summary>
    /// 一次右鍵的殼層選單。`Build` 之後物件要活著，使用者選了才 `Invoke`——
    /// `IContextMenu` 的命令編號只在同一個實例裡有效，放掉再叫就是叫到別的東西。
    /// </summary>
    internal sealed class ShellMenu : IDisposable
    {
        private const uint IdFirst = 1;
        private const uint IdLast = 0x6FFF;
        /// <summary>子選單最多展開幾層：殼層擴充不會做很深，遞迴無上限只會被壞掉的擴充拖住。</summary>
        private const int MaxDepth = 4;

        /// <summary>設了 VOICEINK_SHELL_DEBUG 才往 stderr 印 HRESULT。一般執行完全安靜。</summary>
        private static readonly bool Debug = Environment.GetEnvironmentVariable("VOICEINK_SHELL_DEBUG") == "1";

        private static void Trace(string step, int hr)
        {
            if (Debug) Console.Error.WriteLine("[shell] " + step + " hr=0x" + hr.ToString("X8"));
        }

        private IntPtr _menu = IntPtr.Zero;
        private object _com;
        private IContextMenu _cm;
        private IContextMenu2 _cm2;
        private IContextMenu3 _cm3;
        private readonly List<IntPtr> _pidls = new List<IntPtr>();

        public List<MenuNode> Items = new List<MenuNode>();

        /// <summary>選了幾個檔案／資料夾時的選單。</summary>
        public static ShellMenu ForPaths(string[] paths, bool extended)
        {
            if (paths == null || paths.Length == 0) return null;
            IntPtr first;
            uint ignored;
            int parsed = Native.SHParseDisplayName(paths[0], IntPtr.Zero, out first, 0, out ignored);
            Trace("SHParseDisplayName", parsed);
            if (parsed != 0) return null;
            ShellMenu menu = new ShellMenu();
            menu._pidls.Add(first);
            try
            {
                Guid folderIid = Guids.IShellFolder;
                IntPtr psfPtr;
                IntPtr lastIgnored;
                int bound = Native.SHBindToParent(first, ref folderIid, out psfPtr, out lastIgnored);
                Trace("SHBindToParent", bound);
                if (bound != 0) { menu.Dispose(); return null; }
                IShellFolder folder = (IShellFolder)Marshal.GetObjectForIUnknown(psfPtr);
                Marshal.Release(psfPtr);
                IntPtr[] children = menu.ChildPidls(paths);
                if (children == null) { menu.Dispose(); return null; }
                Guid cmIid = Guids.IContextMenu;
                IntPtr cmPtr;
                int hr = folder.GetUIObjectOf(IntPtr.Zero, (uint)children.Length, children, ref cmIid, IntPtr.Zero, out cmPtr);
                Trace("GetUIObjectOf", hr);
                Marshal.ReleaseComObject(folder);
                if (hr != 0 || cmPtr == IntPtr.Zero) { menu.Dispose(); return null; }
                menu.Attach(cmPtr);
                menu.Populate(extended, true);
                return menu;
            }
            catch
            {
                menu.Dispose();
                return null;
            }
        }

        /// <summary>在空白處按右鍵時的選單（「新增 ▸」、「在此開啟終端機」那些）。</summary>
        public static ShellMenu ForBackground(string dir, bool extended)
        {
            if (string.IsNullOrEmpty(dir)) return null;
            IntPtr pidl;
            uint ignored;
            int parsed = Native.SHParseDisplayName(dir, IntPtr.Zero, out pidl, 0, out ignored);
            Trace("bg SHParseDisplayName", parsed);
            if (parsed != 0) return null;
            ShellMenu menu = new ShellMenu();
            menu._pidls.Add(pidl);
            try
            {
                Guid folderIid = Guids.IShellFolder;
                IntPtr psfPtr;
                int bound = Native.SHBindToObject(IntPtr.Zero, pidl, IntPtr.Zero, ref folderIid, out psfPtr);
                Trace("bg SHBindToObject", bound);
                if (bound != 0) { menu.Dispose(); return null; }
                IShellFolder folder = (IShellFolder)Marshal.GetObjectForIUnknown(psfPtr);
                Marshal.Release(psfPtr);
                Guid cmIid = Guids.IContextMenu;
                IntPtr cmPtr;
                int hr = folder.CreateViewObject(IntPtr.Zero, ref cmIid, out cmPtr);
                Trace("bg CreateViewObject", hr);
                Marshal.ReleaseComObject(folder);
                if (hr != 0 || cmPtr == IntPtr.Zero) { menu.Dispose(); return null; }
                menu.Attach(cmPtr);
                menu.Populate(extended, false);
                return menu;
            }
            catch
            {
                menu.Dispose();
                return null;
            }
        }

        /// <summary>同一個資料夾裡的每個項目，取它在父資料夾裡的那一截 pidl。</summary>
        private IntPtr[] ChildPidls(string[] paths)
        {
            List<IntPtr> list = new List<IntPtr> { Native.ILFindLastID(_pidls[0]) };
            for (int i = 1; i < paths.Length && i < 64; i++)
            {
                IntPtr full;
                uint ignored;
                if (Native.SHParseDisplayName(paths[i], IntPtr.Zero, out full, 0, out ignored) != 0) continue;
                _pidls.Add(full);
                list.Add(Native.ILFindLastID(full));
            }
            return list.Count > 0 ? list.ToArray() : null;
        }

        private void Attach(IntPtr cmPtr)
        {
            _com = Marshal.GetObjectForIUnknown(cmPtr);
            Marshal.Release(cmPtr);
            _cm = _com as IContextMenu;
            _cm2 = _com as IContextMenu2;
            _cm3 = _com as IContextMenu3;
            Trace("IContextMenu2", _cm2 == null ? 1 : 0);
            Trace("IContextMenu3", _cm3 == null ? 1 : 0);
        }

        private void Populate(bool extended, bool itemMenu)
        {
            _menu = Native.CreatePopupMenu();
            if (_menu == IntPtr.Zero || _cm == null) return;
            // EXPLORE＝跟檔案總管同一組動詞；SYNCCASCADEMENU＝「傳送到」那類層疊選單
            // 在 Query 當下就填，不要只靠稍後的 WM_INITMENUPOPUP（有的處理常式只實作
            // IContextMenu2，IContextMenu3 那條會安靜地不做事）。
            uint flags = Native.CMF_NORMAL | Native.CMF_EXPLORE | Native.CMF_SYNCCASCADEMENU
                | (itemMenu ? Native.CMF_ITEMMENU : 0)
                | (extended ? Native.CMF_EXTENDEDVERBS : 0);
            if (_cm.QueryContextMenu(_menu, 0, IdFirst, IdLast, flags) < 0) return;
            Items = Read(_menu, 0);
        }

        /// <summary>
        /// 把 HMENU 讀成樹。
        ///
        /// 子選單**要先送 WM_INITMENUPOPUP 才有東西**：7-Zip／WinRAR 那類是等
        /// Windows 要展開時才把項目塞進去的，直接讀會拿到一個空的子選單。
        /// </summary>
        private List<MenuNode> Read(IntPtr hmenu, int depth)
        {
            List<MenuNode> list = new List<MenuNode>();
            int count = Native.GetMenuItemCount(hmenu);
            for (int i = 0; i < count; i++)
            {
                MenuNode node = ReadOne(hmenu, (uint)i, depth);
                if (node != null) list.Add(node);
            }
            return list;
        }

        private MenuNode ReadOne(IntPtr hmenu, uint index, int depth)
        {
            char[] text = new char[512];
            GCHandle pin = GCHandle.Alloc(text, GCHandleType.Pinned);
            try
            {
                MENUITEMINFOW info = new MENUITEMINFOW
                {
                    cbSize = (uint)Marshal.SizeOf<MENUITEMINFOW>(),
                    fMask = Native.MIIM_STRING | Native.MIIM_ID | Native.MIIM_SUBMENU
                        | Native.MIIM_FTYPE | Native.MIIM_STATE | Native.MIIM_BITMAP,
                    dwTypeData = pin.AddrOfPinnedObject(),
                    cch = (uint)text.Length - 1
                };
                if (!Native.GetMenuItemInfoW(hmenu, index, true, ref info)) return null;
                if ((info.fType & Native.MFT_SEPARATOR) != 0) return new MenuNode { Separator = true };

                string label = new string(text, 0, (int)Math.Min(info.cch, (uint)text.Length)).Replace("&", "");
                if (string.IsNullOrWhiteSpace(label)) label = MenuString(hmenu, index);
                MenuNode node = new MenuNode
                {
                    Id = info.wID >= IdFirst ? info.wID - IdFirst : 0,
                    Label = label.Trim(),
                    Disabled = (info.fState & Native.MFS_DISABLED) != 0,
                    Checked = (info.fState & Native.MFS_CHECKED) != 0,
                    Icon = Pixels.IsRealBitmap(info.hbmpItem) ? Pixels.FromBitmap(info.hbmpItem) : null
                };
                if (info.hSubMenu != IntPtr.Zero && depth < MaxDepth)
                {
                    InitPopup(info.hSubMenu, index);
                    node.Children = Read(info.hSubMenu, depth + 1);
                }
                if (node.Children == null && info.wID >= IdFirst) node.Verb = VerbOf(node.Id);
                // owner-draw 的項目沒有文字可讀（極少數舊擴充），寧可丟掉也不要放一列空白
                if (string.IsNullOrEmpty(node.Label) && node.Children == null) return null;
                return node;
            }
            finally
            {
                pin.Free();
            }
        }

        private void InitPopup(IntPtr submenu, uint index)
        {
            IntPtr wparam = submenu;
            // WM_INITMENUPOPUP：低位＝父選單裡的位置，高位＝是不是視窗選單（一定是 0）
            IntPtr lparam = new IntPtr(index & 0xFFFF);
            int before = Native.GetMenuItemCount(submenu);
            try
            {
                if (_cm3 != null)
                {
                    IntPtr result;
                    _cm3.HandleMenuMsg2(Native.WM_INITMENUPOPUP, wparam, lparam, out result);
                }
                // 「傳送到」只實作 IContextMenu2。複合選單的 IContextMenu3 常常不往下轉
                // WM_INITMENUPOPUP，7-Zip 那種自己實作 v3 的沒差，SendTo 就會是空的。
                if (Native.GetMenuItemCount(submenu) == before && _cm2 != null)
                {
                    _cm2.HandleMenuMsg(Native.WM_INITMENUPOPUP, wparam, lparam);
                }
            }
            catch
            {
                // 擴充自己炸了不該把整份選單拖下水，那一格就維持空的
            }
        }

        /// <summary>owner-draw 的項目 GetMenuItemInfo 拿不到字，GetMenuString 有時還在。</summary>
        private static string MenuString(IntPtr hmenu, uint index)
        {
            char[] text = new char[512];
            int n = Native.GetMenuStringW(hmenu, index, text, text.Length, Native.MF_BYPOSITION);
            if (n <= 0) return "";
            return new string(text, 0, n).Replace("&", "").Trim();
        }

        private string VerbOf(uint id)
        {
            IntPtr buffer = Marshal.AllocHGlobal(260 * 2);
            try
            {
                Marshal.WriteInt16(buffer, 0, 0);
                if (_cm.GetCommandString(new UIntPtr(id), Native.GCS_VERBW, IntPtr.Zero, buffer, 260) != 0) return null;
                return Marshal.PtrToStringUni(buffer);
            }
            catch
            {
                return null;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>跑使用者選的那一項。`hwndOwner` 是 VoiceInk 的視窗，「內容」那種對話框才會開在前面。</summary>
        public bool Invoke(uint id, IntPtr hwndOwner, string directory)
        {
            if (_cm == null) return false;
            IntPtr owner = Native.IsWindow(hwndOwner) ? hwndOwner : Native.GetDesktopWindow();
            CMINVOKECOMMANDINFOEX info = new CMINVOKECOMMANDINFOEX
            {
                cbSize = Marshal.SizeOf<CMINVOKECOMMANDINFOEX>(),
                fMask = Native.CMIC_MASK_UNICODE,
                hwnd = owner,
                lpVerb = new IntPtr(id),
                lpVerbW = new IntPtr(id),
                lpDirectory = directory,
                lpDirectoryW = directory,
                nShow = 1
            };
            return _cm.InvokeCommand(ref info) >= 0;
        }

        public void Dispose()
        {
            if (_menu != IntPtr.Zero) { Native.DestroyMenu(_menu); _menu = IntPtr.Zero; }
            _cm = null;
            _cm2 = null;
            _cm3 = null;
            if (_com != null) { try { Marshal.ReleaseComObject(_com); } catch { } _com = null; }
            foreach (IntPtr pidl in _pidls) Native.ILFree(pidl);
            _pidls.Clear();
        }
    }
}
