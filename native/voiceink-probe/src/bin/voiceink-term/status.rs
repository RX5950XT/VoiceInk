//! 「在運行中／已完成」判定，逐條對照 `src/main/terminal/status.js`（那邊的註解解釋了每條規則的來由）。
//! 長度一律以 char 計（JS 是 UTF-16 單位，只在罕用字上差一點）。

const ESC: char = '\x1b';
const BEL: char = '\x07';
pub const BUSY_QUIET_MS: u64 = 4000;
pub const PROMPT_QUIET_MS: u64 = 800;
const TAIL_KEEP: usize = 768;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Running,
    Exited,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Running => "running",
            State::Exited => "exited",
        }
    }
}

pub struct Tracker {
    pub state: State,
    pub exit_code: Option<i64>,
    last_output_at: u64,
    max_history_id: i64,
    in_flight: bool,
    tail: String,
    pending: String,
    recalled: bool,
    interactive: bool,
    pub title: String,
    pub cwd: String,
}

impl Tracker {
    pub fn new(now: u64) -> Self {
        Tracker {
            state: State::Idle,
            exit_code: None,
            last_output_at: now,
            max_history_id: -1,
            in_flight: false,
            tail: String::new(),
            pending: String::new(),
            recalled: false,
            interactive: false,
            title: String::new(),
            cwd: String::new(),
        }
    }

    pub fn on_input(&mut self, data: &str, now: u64) {
        if self.state == State::Exited {
            return;
        }
        for ch in data.chars() {
            if ch == '\r' || ch == '\n' {
                if !self.pending.trim().is_empty() || self.recalled {
                    if self.in_flight {
                        self.interactive = true;
                    }
                    self.state = State::Running;
                    self.in_flight = true;
                    self.exit_code = None;
                    self.last_output_at = now;
                }
                self.pending.clear();
                self.recalled = false;
            } else if ch == '\x7f' || ch == '\x08' {
                self.pending.pop();
            } else if ch == ESC {
                self.recalled = true;
            } else if ch >= ' ' {
                self.pending.push(ch);
            }
        }
    }

    pub fn on_output(&mut self, chunk: &str, now: u64) {
        if self.state == State::Exited {
            return;
        }
        self.last_output_at = now;
        self.state = State::Running;
        let buf = format!("{}{}", self.tail, chunk);
        for osc in oscs(&buf) {
            if let Some(rest) = osc.strip_prefix("133;D;") {
                self.on_done(rest);
            } else if let Some(title) = osc.strip_prefix("0;").or_else(|| osc.strip_prefix("2;")) {
                // TITLE_RE：最多 200 字
                let title = title.trim();
                if osc.chars().count() <= 202 && !title.is_empty() && !has_control(title) {
                    self.title = title.to_string();
                }
            } else if let Some(value) = osc.strip_prefix("7;") {
                if value.chars().count() <= 600 {
                    let cwd = parse_osc7(value);
                    if !cwd.is_empty() {
                        self.cwd = cwd;
                    }
                }
            }
        }
        let n = buf.chars().count();
        self.tail = buf.chars().skip(n.saturating_sub(TAIL_KEEP)).collect();
    }

    /// `OSC 133;D;<離開碼>;<history id>`：只認比看過的更大的 id
    fn on_done(&mut self, rest: &str) {
        let mut parts = rest.split(';');
        let (Some(code), Some(id), None) = (parts.next(), parts.next(), parts.next()) else { return };
        if !is_digits(code) || !is_digits(id) {
            return;
        }
        let history_id: i64 = id.parse().unwrap_or(i64::MAX);
        if history_id <= self.max_history_id {
            return;
        }
        let first_ever = self.max_history_id < 0;
        self.max_history_id = history_id;
        if first_ever {
            return;
        }
        self.in_flight = false;
        self.interactive = false;
        self.exit_code = code.parse().ok();
        self.state = State::Idle;
    }

    /// 每秒一次；回傳狀態有沒有變
    pub fn tick(&mut self, now: u64) -> bool {
        if self.state != State::Running {
            return false;
        }
        if self.max_history_id >= 0 && self.in_flight && !self.interactive {
            return false;
        }
        let quiet = now.saturating_sub(self.last_output_at);
        if quiet < if self.in_flight { BUSY_QUIET_MS } else { PROMPT_QUIET_MS } {
            return false;
        }
        self.state = State::Idle;
        true
    }

    pub fn on_exit(&mut self, code: Option<i64>) {
        self.state = State::Exited;
        self.exit_code = code;
        self.in_flight = false;
        self.interactive = false;
    }
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn has_control(s: &str) -> bool {
    s.chars().any(|c| (c as u32) < 32 || c as u32 == 127)
}

/// 找出所有以 BEL 或 ESC \ 收尾的 `ESC ] … ` 內容（不含開頭與結尾）
fn oscs(buf: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = buf[from..].find("\x1b]") {
        let start = from + rel + 2;
        let body = &buf[start..];
        let end = body.find([ESC, BEL]);
        match end {
            Some(i) if body[i..].starts_with(BEL) || body[i..].starts_with("\x1b\\") => {
                out.push(&body[..i]);
                from = start + i + 1;
            }
            Some(i) => from = start + i,
            None => break,
        }
    }
    out
}

/// status.js 的 `parseOsc7`：只收磁碟機開頭的絕對路徑
pub fn parse_osc7(value: &str) -> String {
    let Some(rest) = value.strip_prefix("file://") else { return String::new() };
    let Some(slash) = rest.find('/') else { return String::new() };
    let Some(raw) = percent_decode(&rest[slash + 1..]) else { return String::new() };
    let b = raw.as_bytes();
    if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || !(b[2] == b'\\' || b[2] == b'/') {
        return String::new();
    }
    let full = raw.replace('/', "\\");
    if full.encode_utf16().count() <= 260 && !has_control(&full) { full } else { String::new() }
}

/// `decodeURIComponent`：格式錯或解出來不是 UTF-8 就當失敗
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn done_marker_needs_bigger_id() {
        let mut t = Tracker::new(0);
        t.on_output("\x1b]133;D;0;5\x07PS> ", 1);
        t.on_input("dir\r", 2);
        assert!(t.state == State::Running);
        t.on_output("\x1b]133;D;0;5\x07", 3); // 重繪：同一個 id
        assert!(t.state == State::Running);
        t.on_output("\x1b]133;D;1;6\x1b\\", 4);
        assert!(t.state == State::Idle && t.exit_code == Some(1));
    }

    #[test]
    fn marker_split_across_chunks() {
        let mut t = Tracker::new(0);
        t.on_output("\x1b]133;D;0;1\x07", 1);
        t.on_input("x\r", 2);
        t.on_output("out\x1b]133;D;", 3);
        t.on_output("0;2\x07", 4);
        assert!(t.state == State::Idle);
    }

    #[test]
    fn title_and_cwd() {
        let mut t = Tracker::new(0);
        t.on_output("\x1b]0;  claude  \x07\x1b]7;file://host/C:/Users/a%20b\x07", 1);
        assert_eq!(t.title, "claude");
        assert_eq!(t.cwd, "C:\\Users\\a b");
        assert_eq!(parse_osc7("file://h/%E0%A4%A"), "");
        assert_eq!(parse_osc7("file://h//server/share"), "");
    }

    #[test]
    fn quiet_tick() {
        let mut t = Tracker::new(0);
        t.on_output("x", 0);
        assert!(!t.tick(500));
        assert!(t.tick(900));
        t.on_input("claude\r", 1000); // 沒有標記：in_flight 但 max_history_id < 0
        t.on_output("spin", 1000);
        assert!(!t.tick(4000));
        assert!(t.tick(5100));
    }
}
