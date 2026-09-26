//! shell／啟動指令的固定表、工作目錄收斂、子程序環境：對照 `store.js` 與 `pty.js`。

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

pub const MAX_SESSIONS: usize = 20;
pub const MAX_COLS: i64 = 1000;
pub const MAX_ROWS: i64 = 500;

/// pty.js 的 PS_INTEGRATION：刻意不含雙引號（會變成單一 argv）
pub const PS_INTEGRATION: &str = concat!(
    "$global:__viPrompt = $function:prompt; ",
    "function global:prompt {; ",
    "$ok = $?; ",
    "$h = (Get-History -Count 1).Id; ",
    "if ($null -eq $h) { $h = 0 }; ",
    "$c = 0; ",
    "if (-not $ok) { $c = 1 }; ",
    "$e = [char]27; ",
    "$b = [char]7; ",
    "($e + ']133;D;' + $c + ';' + $h + $b) + (& $global:__viPrompt); ",
    "}"
);

const SHELLS: [(&str, &str); 3] = [("pwsh", "pwsh.exe"), ("powershell", "powershell.exe"), ("cmd", "cmd.exe")];
// ponytail: Codex 的 Windows 背景 daemon 會彈出工具視窗；上游修好後可恢復共用 daemon。
const PRESETS: [(&str, &str); 6] =
    [("shell", ""), ("claude", "claude"), ("codex", "codex --no-daemon"), ("opencode", "opencode"), ("agy", "agy"), ("grok", "grok")];

static EXE_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// store.js 的 `resolveExe`：在 PATH 上找，找不到回空字串（結果快取）
pub fn resolve_exe(name: &str) -> String {
    let mut cache = EXE_CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(hit) = cache.get(name) {
        return hit.clone();
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let found = std::env::split_paths(&path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    cache.insert(name.to_string(), found.clone());
    found
}

fn shell_exe(key: &str) -> Option<&'static str> {
    SHELLS.iter().find(|(k, _)| *k == key).map(|(_, exe)| *exe)
}

pub fn normalize_shell(key: Option<&str>) -> String {
    if let Some(key) = key {
        if shell_exe(key).is_some_and(|exe| !resolve_exe(exe).is_empty()) {
            return key.to_string();
        }
    }
    for candidate in ["pwsh", "powershell", "cmd"] {
        if !resolve_exe(shell_exe(candidate).unwrap()).is_empty() {
            return candidate.to_string();
        }
    }
    "cmd".into()
}

/// 未知的 key 退回純 shell（沒有啟動指令）
pub fn preset_command(key: Option<&str>) -> &'static str {
    PRESETS.iter().find(|(k, _)| Some(*k) == key).map_or("", |(_, cmd)| *cmd)
}

/// `store.js` 的 `isClaudeSessionId`：8-4-4-4-12 的十六進位，大小寫都收。
pub fn is_claude_session_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [8usize, 4, 4, 4, 12];
    let mut index = 0;
    for (nth, len) in groups.iter().enumerate() {
        if nth > 0 {
            if bytes.get(index) != Some(&b'-') {
                return false;
            }
            index += 1;
        }
        for _ in 0..*len {
            if !bytes.get(index).is_some_and(|b| b.is_ascii_hexdigit()) {
                return false;
            }
            index += 1;
        }
    }
    index == bytes.len()
}

/// 沒有活著的 pty、要新開 shell 時的第一行。Claude 且 meta 有合法對話 id 才接回。
pub fn startup_command(key: Option<&str>, session_id: &str) -> String {
    if key == Some("claude") && is_claude_session_id(session_id) {
        return format!("claude --resume {session_id}");
    }
    preset_command(key).to_string()
}

/// `host.rs` 的 `valid_id`。環境變數只放這一種，免得把路徑送進子程序。
pub fn valid_terminal_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn home_dir() -> String {
    std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into())
}

/// store.js 的 `normalizeCwd`：真的是目錄才收（`path.resolve`），否則家目錄
pub fn normalize_cwd(value: Option<&str>) -> String {
    let Some(v) = value.filter(|v| !v.is_empty()) else { return home_dir() };
    if !Path::new(v).is_dir() {
        return home_dir();
    }
    let Ok(abs) = std::path::absolute(v) else { return home_dir() };
    let mut s = abs.to_string_lossy().into_owned();
    // path.resolve 會去掉結尾的分隔符（根目錄 `C:\` 除外）
    while (s.ends_with('\\') || s.ends_with('/')) && s.len() > 3 {
        s.pop();
    }
    s
}

/// pty.js 的 `shellCommand`：執行檔、參數、有沒有 shell integration
pub fn shell_command(key: &str) -> (String, Vec<String>) {
    let exe_name = shell_exe(key).unwrap_or("cmd.exe");
    let resolved = resolve_exe(exe_name);
    let exe = if resolved.is_empty() { exe_name.to_string() } else { resolved };
    let args = if key == "pwsh" || key == "powershell" {
        vec!["-NoLogo".into(), "-NoExit".into(), "-Command".into(), PS_INTEGRATION.into()]
    } else {
        vec![]
    };
    (exe, args)
}

/// pty.js 的 `shellEnvironment`：宿主自己的環境＋TERM；Ctrl+G 的編輯器橋接要接手時才動 EDITOR／VISUAL／PATH。
///
/// `terminal_id` 寫進 `VOICEINK_TERMINAL_ID`，Claude 的 hook 才知道事件屬於哪個分頁。
/// 這支 exe 的內容雜湊就是宿主版本（`host-runtime.js` 的 `runtimeName`）：舊宿主不會帶這個
/// 變數，App 連上時認得出來，不用為此改協定版號。
pub fn shell_environment(editor: &str, editor_dir: &str, terminal_id: &str) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars_os()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned()))
        // `=C:` 這種每個磁碟機的工作目錄變數 Node 的 process.env 也不給
        .filter(|(k, _)| !k.is_empty() && !k.starts_with('='))
        .filter(|(k, _)| !k.eq_ignore_ascii_case("ELECTRON_RUN_AS_NODE") && !k.eq_ignore_ascii_case("ELECTRON_NO_ASAR"))
        .collect();
    set_var(&mut env, "TERM", "xterm-256color");
    if !editor.is_empty() {
        set_var(&mut env, "EDITOR", editor);
        set_var(&mut env, "VISUAL", editor);
        let folder = safe_editor_dir(editor_dir);
        if !folder.is_empty() {
            prepend_path(&mut env, &folder);
        }
    }
    if valid_terminal_id(terminal_id) {
        set_var(&mut env, "VOICEINK_TERMINAL_ID", terminal_id);
    } else {
        env.retain(|(k, _)| !k.eq_ignore_ascii_case("VOICEINK_TERMINAL_ID"));
    }
    env
}

fn set_var(env: &mut Vec<(String, String)>, key: &str, value: &str) {
    env.retain(|(k, _)| !k.eq_ignore_ascii_case(key));
    env.push((key.to_string(), value.to_string()));
}

/// pty.js 的 `prependPath`：同名不同大小寫的 PATH 收成一個（基底取第一個非空的），再接到最前面
pub fn prepend_path(env: &mut Vec<(String, String)>, folder: &str) {
    let key = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("path")).map_or("PATH".to_string(), |(k, _)| k.clone());
    let current = env.iter().filter(|(k, _)| k.eq_ignore_ascii_case("path")).map(|(_, v)| v.clone()).find(|v| !v.is_empty());
    env.retain(|(k, _)| !k.eq_ignore_ascii_case("path"));
    env.push((key, current.map_or(folder.to_string(), |c| format!("{folder};{c}"))));
}

/// 只放行絕對路徑、名叫 `editor-bridge` 的資料夾，且不能含 PATH 分隔符
fn safe_editor_dir(value: &str) -> String {
    let p = Path::new(value);
    if value.is_empty() || !p.is_absolute() || value.contains(';') {
        return String::new();
    }
    if p.file_name().and_then(|n| n.to_str()) == Some("editor-bridge") { value.to_string() } else { String::new() }
}

/// pty.js 的 `clampDim`：`Math.trunc(Number(v))`，不合法回 fallback
pub fn clamp_dim(value: Option<&serde_json::Value>, max: i64, fallback: i64) -> i64 {
    let n = match value {
        Some(serde_json::Value::Number(n)) => n.as_f64(),
        Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match n.map(f64::trunc) {
        Some(n) if n.is_finite() && n >= 1.0 => (n as i64).min(max),
        _ => fallback,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_merge() {
        let mut env = vec![("PATH".into(), String::new()), ("Path".into(), "C:\\a".into()), ("X".into(), "1".into())];
        prepend_path(&mut env, "C:\\b\\editor-bridge");
        let paths: Vec<_> = env.iter().filter(|(k, _)| k.eq_ignore_ascii_case("path")).collect();
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].0, "PATH");
        assert_eq!(paths[0].1, "C:\\b\\editor-bridge;C:\\a");
    }

    #[test]
    fn clamp() {
        use serde_json::json;
        assert_eq!(clamp_dim(Some(&json!(120.9)), 1000, 80), 120);
        assert_eq!(clamp_dim(Some(&json!("30")), 500, 24), 30);
        assert_eq!(clamp_dim(Some(&json!(0)), 500, 24), 24);
        assert_eq!(clamp_dim(Some(&json!(99999)), 500, 24), 500);
        assert_eq!(clamp_dim(None, 500, 24), 24);
    }

    #[test]
    fn editor_dir_guard() {
        assert_eq!(safe_editor_dir("C:\\x\\editor-bridge"), "C:\\x\\editor-bridge");
        assert_eq!(safe_editor_dir("C:\\x\\other"), "");
        assert_eq!(safe_editor_dir("relative\\editor-bridge"), "");
        assert_eq!(safe_editor_dir("C:\\a;b\\editor-bridge"), "");
    }

    #[test]
    fn terminal_id_and_resume() {
        let env = shell_environment("", "", "t_abc-1");
        let hit = env.iter().find(|(k, _)| k == "VOICEINK_TERMINAL_ID").map(|(_, v)| v.as_str());
        assert_eq!(hit, Some("t_abc-1"));
        let bad = shell_environment("", "", "../x");
        assert!(bad.iter().all(|(k, _)| !k.eq_ignore_ascii_case("VOICEINK_TERMINAL_ID")));
        let id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        assert!(is_claude_session_id(id));
        assert!(!is_claude_session_id("not-a-uuid"));
        assert!(!is_claude_session_id(&format!("{id};calc")));
        assert_eq!(startup_command(Some("claude"), id), format!("claude --resume {id}"));
        assert_eq!(startup_command(Some("claude"), "not-a-uuid"), "claude");
        assert_eq!(startup_command(Some("claude"), ""), "claude");
        assert_eq!(startup_command(Some("codex"), id), "codex --no-daemon");
        assert_eq!(startup_command(Some("nope"), id), "");
    }
}
