//! `voiceink-term.exe`：終端機背景宿主（取代把整支 Electron 複製進 userData 當 Node 跑的做法）。
//!
//! - `--pipe=<名> --root=<userData>\terminal-host`：宿主。通行證從 `<root>\connection.json` 讀
//!   （App 的 `host-runtime.js#connection` 建的、已鎖 ACL），協定同 `src/main/terminal/host.js`。
//! - `--terminal-admin-host=<管道名>`：提權的那一份（UAC 叫起來的），見 admin.rs。
#![windows_subsystem = "windows"]

mod admin;
mod conpty;
mod host;
mod pipe;
mod shell;
mod status;

use std::path::Path;

fn arg(name: &str) -> Option<String> {
    std::env::args_os().find_map(|a| a.to_str().and_then(|s| s.strip_prefix(name)).map(str::to_string))
}

/// host-runtime.js 的 `connection` 那幾條檢查：一般檔案、不是連結、小於 4KB、協定與通行證格式對
fn read_token(root: &Path) -> Option<String> {
    let file = root.join("connection.json");
    let meta = std::fs::symlink_metadata(&file).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).ok()?).ok()?;
    let token = config.get("token")?.as_str()?.to_string();
    (config.get("protocol")?.as_i64()? == host::PROTOCOL && host::is_token(&token)).then_some(token)
}

fn main() {
    if let Some(pipe) = arg("--terminal-admin-host=") {
        std::process::exit(admin::run_elevated(&pipe));
    }
    let (Some(pipe), Some(root)) = (arg("--pipe="), arg("--root=")) else { std::process::exit(1) };
    if !pipe.starts_with(r"\\.\pipe\voiceink-terminal-") {
        std::process::exit(1);
    }
    let Some(token) = read_token(Path::new(&root)) else { std::process::exit(1) };
    // 回報給 App 的「執行環境名」＝自己所在的資料夾（內容雜湊），用來認出更新前的舊宿主
    let runtime = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    std::process::exit(host::run(&pipe, token, runtime));
}
