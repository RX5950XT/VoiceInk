//! `voiceink-probe dir-size <path> <maxFiles> <maxDepth> <maxMs>`：資料夾大小，
//! 對照 `src/main/explorer/size.js` 的 `walk`（同樣的上限、同樣不跟 symlink／junction）。
//!
//! 快在 Windows 的 `read_dir` 本身就帶大小與屬性（FindFirstFile），不必每個檔案再 lstat 一次。
//! stdout：每 200ms 一列 `P <bytes> <files> <dirs>`；結束一列 `D <bytes> <files> <dirs> <0|1> <reason>`；
//! 根目錄讀不到只印 `E read`。取消＝main 直接把程序砍掉。

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

const PROGRESS: Duration = Duration::from_millis(200);

struct Walk {
    bytes: u64,
    files: u64,
    dirs: u64,
    incomplete: bool,
    reason: &'static str,
    max_files: u64,
    max_depth: u32,
    deadline: Instant,
    last: Instant,
}

impl Walk {
    fn mark(&mut self, reason: &'static str) {
        self.incomplete = true;
        if self.reason.is_empty() {
            self.reason = reason;
        }
    }

    /// size.js 的 hitLimit：時間與檔案數到了就整個停（原因直接覆寫，跟 JS 一樣）
    fn stop(&mut self) -> bool {
        let reason = if Instant::now() > self.deadline {
            "time"
        } else if self.files >= self.max_files {
            "files"
        } else {
            return false;
        };
        self.incomplete = true;
        self.reason = reason;
        true
    }

    fn line(&self, tag: char) -> String {
        format!("{tag} {} {} {}", self.bytes, self.files, self.dirs)
    }

    fn progress(&mut self) {
        if self.last.elapsed() >= PROGRESS {
            self.last = Instant::now();
            println!("{}", self.line('P'));
        }
    }

    /// 回 Err 只在根目錄讀不到時有意義
    fn walk(&mut self, dir: &Path, depth: u32) -> std::io::Result<()> {
        if self.stop() {
            return Ok(());
        }
        if depth > self.max_depth {
            self.incomplete = true;
            self.reason = "depth";
            return Ok(());
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if depth == 0 => return Err(e),
            Err(_) => {
                self.mark("read");
                return Ok(());
            }
        };
        for entry in entries {
            if self.stop() {
                return Ok(());
            }
            // Windows 上 DirEntry::metadata 直接取自列目錄的結果，沒有額外系統呼叫
            let Ok(meta) = entry.and_then(|e| e.metadata().map(|m| (e.path(), m))) else {
                self.mark("read");
                continue;
            };
            let (path, meta) = meta;
            // junction 也算（std 把 name-surrogate reparse point 當 symlink），跟 Node 的 lstat 一致
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                self.dirs += 1;
                let _ = self.walk(&path, depth + 1);
                continue;
            }
            self.files += 1;
            self.bytes += meta.len();
            self.progress();
        }
        Ok(())
    }
}

pub fn run(args: &[String]) -> i32 {
    let [root, max_files, max_depth, max_ms] = args else {
        eprintln!("usage: voiceink-probe dir-size <path> <maxFiles> <maxDepth> <maxMs>");
        return 2;
    };
    let now = Instant::now();
    let mut w = Walk {
        bytes: 0,
        files: 0,
        dirs: 0,
        incomplete: false,
        reason: "",
        max_files: max_files.parse().unwrap_or(50_000),
        max_depth: max_depth.parse().unwrap_or(32),
        deadline: now + Duration::from_millis(max_ms.parse().unwrap_or(8_000)),
        last: now,
    };
    let out = match w.walk(Path::new(root), 0) {
        Ok(()) => format!("{} {} {}", w.line('D'), u8::from(w.incomplete), w.reason),
        Err(_) => "E read".to_string(),
    };
    println!("{out}");
    let _ = std::io::stdout().flush();
    0
}
