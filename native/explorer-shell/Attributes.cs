using System;
using System.IO;
using System.Text.Json;

namespace VoiceInkShell
{
    /// <summary>
    /// 一層資料夾裡每個名字的 Hidden／System 旗標。
    ///
    /// Node 的 <c>fs.Stats</c> 讀不到 <c>FILE_ATTRIBUTE_HIDDEN</c>，所以由 sidecar
    /// 一次問整層，避免幾千次 IPC。讀不到或沒權限的項目跳過，不要整批失敗。
    /// </summary>
    internal static class Attributes
    {
        /// <summary>跟 <c>listDir</c> 的 MAX_ENTRIES 對齊。</summary>
        public const int MaxEntries = 2000;

        public static void Write(string dir, Utf8JsonWriter w)
        {
            w.WriteStartArray("items");
            if (!string.IsNullOrEmpty(dir))
            {
                try
                {
                    DirectoryInfo folder = new DirectoryInfo(dir);
                    if (folder.Exists)
                    {
                        int n = 0;
                        foreach (FileSystemInfo info in folder.EnumerateFileSystemInfos())
                        {
                            if (n >= MaxEntries) break;
                            try
                            {
                                FileAttributes attrs = info.Attributes;
                                w.WriteStartObject();
                                w.WriteString("name", info.Name);
                                w.WriteBoolean("hidden", (attrs & FileAttributes.Hidden) != 0);
                                w.WriteBoolean("system", (attrs & FileAttributes.System) != 0);
                                w.WriteEndObject();
                                n += 1;
                            }
                            catch
                            {
                                // 沒權限或瞬間消失：跳過這一筆
                            }
                        }
                    }
                }
                catch
                {
                    // 資料夾本身讀不到：回空陣列，呼叫端走啟發式
                }
            }
            w.WriteEndArray();
        }
    }
}
