using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace VoiceInkShell
{
    /// <summary>
    /// stdin 一行一個請求（JSON），stdout 一行一個回覆（JSON）。啟動先吐 `READY`。
    ///
    /// stdin 的 EOF ＝主程式關掉了，這裡就結束——跟 `dictation-hook` 同一個約定，
    /// 免得留下孤兒程序抓著殼層擴充不放。
    ///
    /// 整支跑在 STA：殼層擴充是 COM Apartment-threaded，MTA 下有的會直接失敗。
    ///
    /// **主執行緒一定要跑訊息迴圈**：stdin 在背景執行緒讀。以前主執行緒整天卡在
    /// `ReadLine`，殼層開在別的執行緒的東西（「內容」視窗、部分擴充的對話框）要跨執行緒
    /// 叫回這個 STA 時永遠等不到人接——`InvokeCommand` 回報成功，視窗卻從來沒出現。
    /// </summary>
    internal static class Program
    {
        private static readonly Dictionary<int, ShellMenu> Live = new Dictionary<int, ShellMenu>();
        private static int _nextToken = 1;
        private static readonly ConcurrentQueue<string> Inbox = new ConcurrentQueue<string>();
        private static readonly AutoResetEvent Arrived = new AutoResetEvent(false);
        private static volatile bool _ended;

        [STAThread]
        private static int Main()
        {
            Native.OleInitialize(IntPtr.Zero);
            Stream stdout = Console.OpenStandardOutput();
            StreamWriter writer = new StreamWriter(stdout, new UTF8Encoding(false)) { AutoFlush = true };
            StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            writer.WriteLine("READY");
            Thread input = new Thread(() =>
            {
                string read;
                while ((read = reader.ReadLine()) != null)
                {
                    Inbox.Enqueue(read);
                    Arrived.Set();
                }
                _ended = true;
                Arrived.Set();
            }) { IsBackground = true };
            input.Start();
            IntPtr[] handles = { Arrived.SafeWaitHandle.DangerousGetHandle() };
            while (true)
            {
                uint woke = Native.MsgWaitForMultipleObjectsEx(1, handles, Native.INFINITE, Native.QS_ALLINPUT, Native.MWMO_INPUTAVAILABLE);
                if (woke == Native.WAIT_OBJECT_0)
                {
                    string line;
                    while (Inbox.TryDequeue(out line))
                    {
                        if (line.Length > 0) writer.WriteLine(Handle(line));
                    }
                    if (_ended && Inbox.IsEmpty) break;
                }
                Pump();
            }
            foreach (ShellMenu menu in Live.Values) menu.Dispose();
            return 0;
        }

        private static void Pump()
        {
            MSG msg;
            while (Native.PeekMessageW(out msg, IntPtr.Zero, 0, 0, Native.PM_REMOVE))
            {
                Native.TranslateMessage(ref msg);
                Native.DispatchMessageW(ref msg);
            }
        }

        private static string Handle(string line)
        {
            int id = 0;
            try
            {
                using (JsonDocument doc = JsonDocument.Parse(line))
                {
                    JsonElement root = doc.RootElement;
                    id = Num(root, "id", 0);
                    string op = Str(root, "op");
                    switch (op)
                    {
                        case "overlay": return Ok(id, w => Overlay(root, w));
                        case "icon": return Ok(id, w => Icon(root, w));
                        case "thumb": return Ok(id, w => Thumb(root, w));
                        case "attrs": return Ok(id, w => Attributes.Write(Str(root, "dir"), w));
                        case "menu": return Ok(id, w => Menu(root, w));
                        case "invoke": return Ok(id, w => Invoke(root, w));
                        case "release": return Ok(id, w => Release(root, w));
                        case "mtpList": return Ok(id, w => Portable.List(root, w));
                        case "mtpCopy": return Ok(id, w => Portable.Copy(root, w));
                        case "mtpDelete": return Ok(id, w => Portable.Delete(root, w));
                        default: return Fail(id, "BAD_OP");
                    }
                }
            }
            catch (Exception error)
            {
                // 外部錯誤訊息不往回送，只留分類：上游文字可能含使用者路徑
                return Fail(id, error is JsonException ? "BAD_JSON" : "SHELL_FAILED");
            }
        }

        // ---- 各個操作 ----

        private static void Overlay(JsonElement root, Utf8JsonWriter w)
        {
            w.WriteStartArray("slots");
            foreach (string path in Paths(root, "paths")) w.WriteNumberValue(Overlays.IndexOf(path));
            w.WriteEndArray();
        }

        private static void Icon(JsonElement root, Utf8JsonWriter w)
        {
            WriteImage(w, "icon", Overlays.IconOf(Str(root, "path")));
        }

        private static void Thumb(JsonElement root, Utf8JsonWriter w)
        {
            int size = Thumbnails.ClampSize(Num(root, "size", Thumbnails.DefaultSize));
            WriteImage(w, "thumb", Thumbnails.Of(Str(root, "path"), size));
        }

        private static void Menu(JsonElement root, Utf8JsonWriter w)
        {
            string[] paths = Paths(root, "paths");
            bool extended = root.TryGetProperty("extended", out JsonElement ext) && ext.ValueKind == JsonValueKind.True;
            ShellMenu menu = paths.Length > 0
                ? ShellMenu.ForPaths(paths, extended)
                : ShellMenu.ForBackground(Str(root, "dir"), extended);
            if (menu == null) throw new InvalidOperationException("no menu");
            int token = _nextToken++;
            Live[token] = menu;
            Sweep(token);
            w.WriteNumber("token", token);
            WriteNodes(w, "items", menu.Items);
        }

        private static void Invoke(JsonElement root, Utf8JsonWriter w)
        {
            ShellMenu menu;
            if (!Live.TryGetValue(Num(root, "token", 0), out menu)) throw new InvalidOperationException("stale token");
            long hwnd;
            long.TryParse(Str(root, "hwnd") ?? "0", out hwnd);
            bool done = menu.Invoke((uint)Num(root, "cmd", -1), new IntPtr(hwnd), Str(root, "dir"));
            w.WriteBoolean("invoked", done);
        }

        private static void Release(JsonElement root, Utf8JsonWriter w)
        {
            int token = Num(root, "token", 0);
            ShellMenu menu;
            if (Live.TryGetValue(token, out menu)) { menu.Dispose(); Live.Remove(token); }
            w.WriteBoolean("released", true);
        }

        /// <summary>只留最近一份：選單關掉時 App 會 release，沒 release 到的不該無限累積。</summary>
        private static void Sweep(int keep)
        {
            List<int> stale = new List<int>();
            foreach (int token in Live.Keys) if (token != keep) stale.Add(token);
            foreach (int token in stale) { Live[token].Dispose(); Live.Remove(token); }
        }

        // ---- 輸出 ----

        private static void WriteNodes(Utf8JsonWriter w, string name, List<MenuNode> nodes)
        {
            w.WriteStartArray(name);
            foreach (MenuNode node in nodes ?? new List<MenuNode>())
            {
                w.WriteStartObject();
                if (node.Separator) w.WriteBoolean("sep", true);
                else
                {
                    w.WriteNumber("cmd", node.Id);
                    w.WriteString("label", node.Label ?? "");
                    if (node.Verb != null) w.WriteString("verb", node.Verb);
                    if (node.Disabled) w.WriteBoolean("disabled", true);
                    if (node.Checked) w.WriteBoolean("checked", true);
                    WriteImage(w, "icon", node.Icon);
                    if (node.Children != null) WriteNodes(w, "children", node.Children);
                }
                w.WriteEndObject();
            }
            w.WriteEndArray();
        }

        private static void WriteImage(Utf8JsonWriter w, string name, Bgra image)
        {
            if (image == null) return;
            w.WriteStartObject(name);
            w.WriteNumber("w", image.Width);
            w.WriteNumber("h", image.Height);
            w.WriteString("bgra", Convert.ToBase64String(image.Bytes));
            if (image.Pending) w.WriteBoolean("pending", true);
            w.WriteEndObject();
        }

        private static string Ok(int id, Action<Utf8JsonWriter> body)
        {
            using (MemoryStream buffer = new MemoryStream())
            {
                using (Utf8JsonWriter w = new Utf8JsonWriter(buffer))
                {
                    w.WriteStartObject();
                    w.WriteNumber("id", id);
                    w.WriteBoolean("ok", true);
                    w.WriteStartObject("data");
                    body(w);
                    w.WriteEndObject();
                    w.WriteEndObject();
                }
                return Encoding.UTF8.GetString(buffer.ToArray());
            }
        }

        private static string Fail(int id, string code)
        {
            return "{\"id\":" + id + ",\"ok\":false,\"error\":\"" + code + "\"}";
        }

        // ---- 小工具 ----

        private static string Str(JsonElement root, string name)
        {
            JsonElement value;
            return root.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }

        private static int Num(JsonElement root, string name, int fallback)
        {
            JsonElement value;
            int parsed;
            return root.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Number
                && value.TryGetInt32(out parsed) ? parsed : fallback;
        }

        private static string[] Paths(JsonElement root, string name)
        {
            JsonElement value;
            if (!root.TryGetProperty(name, out value) || value.ValueKind != JsonValueKind.Array) return new string[0];
            List<string> list = new List<string>();
            foreach (JsonElement item in value.EnumerateArray())
            {
                if (item.ValueKind == JsonValueKind.String && list.Count < 64) list.Add(item.GetString());
            }
            return list.ToArray();
        }
    }
}
