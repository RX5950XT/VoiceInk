//! `voiceink-probe.exe claude-hook`：Claude Code 的 hook 執行檔。
//!
//! Claude 每個事件用 stdin 送一大包 JSON，SessionStart／UserPromptSubmit 的 **stdout 會被塞進
//! 模型上下文**。所以這支：
//! - 任何情況都 **exit 0、stdout 一個字都不寫**（寫了 Claude 會把垃圾當對話的一部分）
//! - 只把歸約用得到的幾個欄位寫到「exe 旁邊的 events/」，main 再去監看
//!
//! `CLAUDE_JOB_DIR` 有值代表這是 Agent View 的背景 job，環境變數是從前景終端機繼承的，
//! 記到那個終端機上會張冠李戴，直接丟掉。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

/// stdin 上限。超過就整筆丟掉（不解析半包）。
pub const MAX_STDIN: usize = 4 * 1024 * 1024;

/// 跟 `host.rs` 的 `valid_id`、`store.js` 的工作階段 id 同一條：`t_...` 以及測試用的短 id。
pub fn valid_terminal_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 不該寫事件檔：id 不合法，或這是背景 job。
pub fn should_drop(terminal_id: &str, job_dir: &str) -> bool {
    !valid_terminal_id(terminal_id) || !job_dir.is_empty()
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct HookRecord {
    pub v: u32,
    #[serde(rename = "terminalId")]
    pub terminal_id: String,
    pub event: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "transcriptPath")]
    pub transcript_path: String,
    #[serde(rename = "notificationType")]
    pub notification_type: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub source: String,
    pub reason: String,
    pub at: u64,
}

fn field(obj: &serde_json::Map<String, Value>, key: &str) -> String {
    match obj.get(key).and_then(Value::as_str) {
        Some(text) if text.len() <= 4096 && !text.chars().any(|c| c.is_control()) => text.to_string(),
        _ => String::new(),
    }
}

/// 只留下歸約要的欄位。使用者的 prompt、工具參數那些不落盤。
pub fn parse_record(raw: &[u8], terminal_id: &str, at: u64) -> Option<HookRecord> {
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    let value: Value = serde_json::from_slice(raw).ok()?;
    let obj = value.as_object()?;
    let event = field(obj, "hook_event_name");
    if event.is_empty() {
        return None;
    }
    Some(HookRecord {
        v: 1,
        terminal_id: terminal_id.to_string(),
        event,
        session_id: field(obj, "session_id"),
        transcript_path: field(obj, "transcript_path"),
        notification_type: field(obj, "notification_type"),
        tool_name: field(obj, "tool_name"),
        source: field(obj, "source"),
        reason: field(obj, "reason"),
        at,
    })
}

/// 讀到 `max` 為止。超過就把剩下的也讀完（不然 Claude 寫 stdin 會被中途掐掉），然後回錯、整筆丟棄。
pub fn read_capped(input: &mut impl Read, max: usize) -> Result<Vec<u8>, ()> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = input.read(&mut chunk).map_err(|_| ())?;
        if n == 0 {
            return Ok(buf);
        }
        if buf.len().saturating_add(n) > max {
            while input.read(&mut chunk).unwrap_or(0) > 0 {}
            return Err(());
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn drain_stdin() {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut chunk = [0u8; 8192];
    while input.read(&mut chunk).unwrap_or(0) > 0 {}
}

/// 先寫 `.tmp` 再 rename，main 不會掃到半份 JSON。
pub fn write_record(dir: &Path, rec: &HookRecord, millis: u64, pid: u32) -> std::io::Result<PathBuf> {
    fs_create(dir)?;
    let name = format!("{millis}-{pid}.json");
    let dest = dir.join(&name);
    let tmp = dir.join(format!("{name}.tmp"));
    let body = serde_json::to_vec(rec).map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err))?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, &dest)?;
    Ok(dest)
}

fn fs_create(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

fn events_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("events"))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Claude 呼叫的進入點。失敗也是 0：hook 報錯會卡住使用者的那一輪。
pub fn run() -> i32 {
    let _ = std::panic::catch_unwind(|| {
        let id = std::env::var("VOICEINK_TERMINAL_ID").unwrap_or_default();
        let job = std::env::var("CLAUDE_JOB_DIR").unwrap_or_default();
        if should_drop(&id, &job) {
            drain_stdin();
            return;
        }
        let stdin = std::io::stdin();
        let mut input = stdin.lock();
        let Ok(raw) = read_capped(&mut input, MAX_STDIN) else { return };
        let at = now_ms();
        let Some(rec) = parse_record(&raw, &id, at) else { return };
        let Some(dir) = events_dir() else { return };
        let _ = write_record(&dir, &rec, at, std::process::id());
    });
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn parse_keeps_only_the_small_fields() {
        let raw = br#"{
            "hook_event_name":"Notification",
            "session_id":"11111111-2222-3333-4444-555555555555",
            "transcript_path":"C:\\a\\11111111-2222-3333-4444-555555555555.jsonl",
            "notification_type":"permission_prompt",
            "tool_name":"Bash",
            "source":"startup",
            "reason":"ask",
            "prompt":"secret should not be copied"
        }"#;
        let rec = parse_record(raw, "t_ab", 42).unwrap();
        assert_eq!(rec.v, 1);
        assert_eq!(rec.terminal_id, "t_ab");
        assert_eq!(rec.event, "Notification");
        assert_eq!(rec.session_id, "11111111-2222-3333-4444-555555555555");
        assert_eq!(rec.notification_type, "permission_prompt");
        assert_eq!(rec.tool_name, "Bash");
        assert_eq!(rec.source, "startup");
        assert_eq!(rec.reason, "ask");
        assert!(rec.transcript_path.ends_with(".jsonl"));
        let text = serde_json::to_string(&rec).unwrap();
        assert!(!text.contains("secret"));
        assert!(parse_record(b"not-json", "t_ab", 1).is_none());
        assert!(parse_record(b"{}", "t_ab", 1).is_none());
    }

    #[test]
    fn guards_drop_bad_id_and_background_jobs() {
        assert!(should_drop("", ""));
        assert!(should_drop("../x", ""));
        assert!(should_drop(&"t".repeat(81), ""));
        assert!(should_drop("t_ok", "C:\\jobs\\1"));
        assert!(should_drop("t_ok", " "));
        assert!(!should_drop("t_ok-1", ""));
        assert!(valid_terminal_id("t_abc"));
    }

    #[test]
    fn capped_read_discards_the_oversize_payload() {
        let mut small = Cursor::new(b"abc".to_vec());
        assert_eq!(read_capped(&mut small, 4).unwrap(), b"abc");
        let mut big = Cursor::new(vec![b'a'; 8]);
        assert!(read_capped(&mut big, 4).is_err());
        assert_eq!(big.position(), 8, "超過上限也要把剩下的讀完");
    }

    #[test]
    fn write_renames_tmp_away() {
        let dir = std::env::temp_dir().join(format!("vi-hook-{}-write", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let rec = parse_record(br#"{"hook_event_name":"Stop","session_id":"abc"}"#, "t_ab", 7).unwrap();
        let path = write_record(&dir, &rec, 1_700_000_000_000, 99).unwrap();
        assert_eq!(path.file_name().unwrap(), "1700000000000-99.json");
        assert!(!dir.join("1700000000000-99.json.tmp").exists());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"event\":\"Stop\""));
        assert!(text.contains("\"terminalId\":\"t_ab\""));
        assert!(text.contains("\"at\":7"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
