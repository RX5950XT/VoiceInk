//! 背景宿主：對照 `src/main/terminal/host.js`（管道、認證、指令）與 `pty.js`（工作階段、scrollback、flush）。
//! 協定一個字都不改——App 端的 `host-client.js` 不知道對面換成 Rust。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::admin;
use crate::conpty::{self, Pty, Utf8Stream};
use crate::pipe::Pipe;
use crate::shell;
use crate::status::{State, Tracker};

pub const PROTOCOL: i64 = 1;
const MAX_FRAME: usize = 4 * 1024 * 1024;
/// pty.js 是 256K 個 UTF-16 字元；這裡量位元組，給寬一點讓 CJK 也留得差不多
const SCROLLBACK: usize = 512 * 1024;
const MAX_WRITE_UNITS: usize = 8192;
const FLUSH: Duration = Duration::from_millis(16);
const PRESET_DELAY: Duration = Duration::from_millis(400);
const MAX_SOCKETS: usize = 8;

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// 真的 ConPTY 的 handle；最後一個持有者放手時才關（寫入不在鎖裡做，不能讓 handle 先被關掉）
pub struct PtyIo {
    hpc: Mutex<Option<isize>>,
    input: isize,
    process: isize,
}

impl PtyIo {
    fn close_console(&self) {
        if let Some(hpc) = self.hpc.lock().unwrap().take() {
            // ClosePseudoConsole 可能等 conhost 收尾，不要卡住呼叫端
            std::thread::spawn(move || Pty::close_console(hpc));
        }
    }
}

impl Drop for PtyIo {
    fn drop(&mut self) {
        if let Some(hpc) = self.hpc.get_mut().unwrap().take() {
            Pty::close_console(hpc);
        }
        conpty::close(self.input);
        conpty::close(self.process);
    }
}

pub enum Backend {
    Pty(Arc<PtyIo>),
    /// 提權的 shell 開在另一顆程序裡（admin.rs）；`spawned` 之前的輸入直接丟掉
    Admin { spawned: bool },
}

pub struct Session {
    pub generation: u64,
    pub backend: Backend,
    pub tracker: Tracker,
    buffer: String,
    seq: u64,
    pending_out: String,
    pub cols: i64,
    pub rows: i64,
    pub pid: Option<u32>,
    preset: &'static str,
    preset_sent: bool,
    pub shell: String,
    pub cwd: String,
}

struct Client {
    pipe: Arc<Pipe>,
    /// 斷線時拿掉，寫出執行緒的通道才會結束
    tx: Mutex<Option<Sender<String>>>,
    queued: Arc<AtomicUsize>,
    authed: AtomicBool,
}

impl Client {
    /// 對面讀太慢、積了超過一個封包上限就斷線（host.js 的 writableLength 檢查）
    fn send(&self, line: String) {
        if self.queued.fetch_add(line.len(), Ordering::AcqRel) > MAX_FRAME {
            self.pipe.shutdown();
            return;
        }
        let sent = self.tx.lock().unwrap().as_ref().is_some_and(|tx| tx.send(line).is_ok());
        if !sent {
            self.pipe.shutdown();
        }
    }
}

pub struct Hub {
    pub sessions: HashMap<String, Session>,
    clients: Vec<Arc<Client>>,
    flush_pending: bool,
}

pub struct Host {
    hub: Mutex<Hub>,
    flush_cv: Condvar,
    next_gen: AtomicU64,
    pub runtime: String,
}

fn line(v: &Value) -> String {
    let mut s = v.to_string();
    s.push('\n');
    s
}

impl Host {
    pub fn lock(&self) -> MutexGuard<'_, Hub> {
        self.hub.lock().unwrap()
    }

    pub fn emit(hub: &Hub, event: &str, payload: Value) {
        let text = line(&json!({ "event": event, "payload": payload }));
        for client in &hub.clients {
            if client.authed.load(Ordering::Acquire) {
                client.send(text.clone());
            }
        }
    }

    pub fn publish_status(hub: &Hub, id: &str) {
        let payload = match hub.sessions.get(id) {
            Some(s) => json!({ "id": id, "state": s.tracker.state.as_str(), "exitCode": s.tracker.exit_code, "title": s.tracker.title, "cwd": s.tracker.cwd }),
            None => json!({ "id": id, "state": "exited", "exitCode": null, "title": "", "cwd": "" }),
        };
        Self::emit(hub, "terminal:status", payload);
    }

    fn flush_one(hub: &mut Hub, id: &str) {
        let Some(s) = hub.sessions.get_mut(id) else { return };
        if s.pending_out.is_empty() {
            return;
        }
        let data = std::mem::take(&mut s.pending_out);
        s.seq += 1;
        let payload = json!({ "id": id, "seq": s.seq, "data": data });
        Self::emit(hub, "terminal:data", payload);
    }

    /// pty.js 的 `absorb`：狀態判定、scrollback、排進下一次 flush
    pub fn absorb(self: &Arc<Self>, id: &str, generation: u64, chunk: &str) {
        let mut hub = self.lock();
        let Some(s) = hub.sessions.get_mut(id).filter(|s| s.generation == generation) else { return };
        let before = (s.tracker.state, s.tracker.title.clone(), s.tracker.cwd.clone());
        s.tracker.on_output(chunk, now_ms());
        s.buffer.push_str(chunk);
        if s.buffer.len() > SCROLLBACK * 2 {
            s.buffer = trim_buffer(&s.buffer).to_string();
        }
        s.pending_out.push_str(chunk);
        let changed = before != (s.tracker.state, s.tracker.title.clone(), s.tracker.cwd.clone());
        let preset = (!s.preset_sent).then(|| {
            s.preset_sent = true;
            s.preset
        });
        if !hub.flush_pending {
            hub.flush_pending = true;
            self.flush_cv.notify_one();
        }
        if changed {
            Self::publish_status(&hub, id);
        }
        drop(hub);
        // 啟動指令等 shell 吐出第一段輸出、再等一下才送
        if let Some(cmd) = preset.filter(|c| !c.is_empty()) {
            let host = self.clone();
            let id = id.to_string();
            std::thread::spawn(move || {
                std::thread::sleep(PRESET_DELAY);
                if host.lock().sessions.get(&id).is_some_and(|s| s.generation == generation) {
                    host.write(&id, &format!("{cmd}\r"));
                }
            });
        }
    }

    pub fn on_exit(&self, id: &str, generation: u64, code: Option<i64>) {
        let mut hub = self.lock();
        if !hub.sessions.get(id).is_some_and(|s| s.generation == generation) {
            return;
        }
        Self::flush_one(&mut hub, id);
        let s = hub.sessions.get_mut(id).unwrap();
        s.tracker.on_exit(code);
        if let Backend::Pty(io) = &s.backend {
            io.close_console();
        }
        Self::publish_status(&hub, id);
    }

    fn states(hub: &Hub) -> Value {
        Value::Array(
            hub.sessions
                .iter()
                .map(|(id, s)| json!({ "id": id, "state": s.tracker.state.as_str(), "exitCode": s.tracker.exit_code, "title": s.tracker.title, "cwd": s.tracker.cwd, "pid": s.pid }))
                .collect(),
        )
    }

    fn spawn_pty(self: &Arc<Self>, id: &str, shell_key: &str, cwd: &str, cols: i64, rows: i64, editor: &str, editor_dir: &str) -> Result<(Backend, u32, u64), ()> {
        let (exe, args) = shell::shell_command(shell_key);
        let env = shell::shell_environment(editor, editor_dir);
        let pty = Pty::spawn(&exe, &args, cwd, &env, cols as u16, rows as u16).map_err(|_| ())?;
        let generation = self.next_gen.fetch_add(1, Ordering::Relaxed);
        let io = Arc::new(PtyIo { hpc: Mutex::new(Some(pty.hpc())), input: pty.input(), process: pty.process });
        let (output, process, pid) = (pty.output, pty.process, pty.pid);
        let (host, sid) = (self.clone(), id.to_string());
        std::thread::spawn(move || {
            let mut dec = Utf8Stream::default();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = conpty::read(output, &mut buf);
                if n == 0 {
                    break;
                }
                let text = dec.push(&buf[..n]);
                if !text.is_empty() {
                    host.absorb(&sid, generation, &text);
                }
            }
            conpty::close(output);
        });
        let (host, sid, keep) = (self.clone(), id.to_string(), io.clone());
        std::thread::spawn(move || {
            let code = conpty::wait_exit(process);
            // 讓最後一段輸出先進來
            std::thread::sleep(Duration::from_millis(50));
            host.on_exit(&sid, generation, code);
            drop(keep);
        });
        Ok((Backend::Pty(io), pid, generation))
    }

    /// pty.js 的 `openSessionWithMeta`
    fn open(self: &Arc<Self>, id: &str, msg: &Value) -> Result<Value, ()> {
        let meta = msg.get("meta").filter(|m| m.is_object()).ok_or(())?;
        if meta.get("id").and_then(Value::as_str) != Some(id) {
            return Err(());
        }
        let editor = msg.get("editor").and_then(Value::as_str).unwrap_or("");
        let editor_dir = msg.get("editorDir").and_then(Value::as_str).unwrap_or("");
        let c = shell::clamp_dim(msg.get("cols"), shell::MAX_COLS, 80);
        let r = shell::clamp_dim(msg.get("rows"), shell::MAX_ROWS, 24);
        let exists = self.lock().sessions.contains_key(id);
        if !exists {
            if self.lock().sessions.len() >= shell::MAX_SESSIONS {
                return Err(());
            }
            let shell_key = shell::normalize_shell(meta.get("shell").and_then(Value::as_str));
            let preset = shell::preset_command(meta.get("preset").and_then(Value::as_str));
            let cwd = shell::normalize_cwd(meta.get("cwd").and_then(Value::as_str));
            let is_admin = meta.get("admin") == Some(&Value::Bool(true));
            let (backend, pid, generation) = if is_admin {
                (Backend::Admin { spawned: false }, None, self.next_gen.fetch_add(1, Ordering::Relaxed))
            } else {
                let (b, pid, generation) = self.spawn_pty(id, &shell_key, &cwd, c, r, editor, editor_dir)?;
                (b, Some(pid), generation)
            };
            let session = Session {
                generation,
                backend,
                tracker: Tracker::new(now_ms()),
                buffer: String::new(),
                seq: 0,
                pending_out: String::new(),
                cols: c,
                rows: r,
                pid,
                preset,
                preset_sent: preset.is_empty(),
                shell: shell_key,
                cwd,
            };
            let mut hub = self.lock();
            // 兩個 open 同時進來：先放進去的那一顆贏，後來的這顆收掉
            if hub.sessions.contains_key(id) {
                drop(hub);
                if let Backend::Pty(io) = &session.backend {
                    io.close_console();
                }
            } else {
                hub.sessions.insert(id.to_string(), session);
                Self::publish_status(&hub, id);
                drop(hub);
                if is_admin {
                    admin::spawn(self.clone(), id.to_string(), generation);
                }
            }
        } else {
            self.resize(id, msg.get("cols"), msg.get("rows"));
        }
        let mut hub = self.lock();
        Self::flush_one(&mut hub, id);
        let s = hub.sessions.get(id).ok_or(())?;
        Ok(json!({
            "id": id, "pid": s.pid, "state": s.tracker.state.as_str(), "exitCode": s.tracker.exit_code,
            "title": s.tracker.title, "cwd": s.tracker.cwd, "seq": s.seq, "buffer": trim_buffer(&s.buffer)
        }))
    }

    pub fn write(self: &Arc<Self>, id: &str, data: &str) -> bool {
        let mut hub = self.lock();
        let Some(s) = hub.sessions.get_mut(id).filter(|s| s.tracker.state != State::Exited) else { return false };
        if data.is_empty() {
            return false;
        }
        let before = s.tracker.state;
        s.tracker.on_input(data, now_ms());
        let changed = s.tracker.state != before;
        let target = match &s.backend {
            Backend::Pty(io) => Some(io.clone()),
            Backend::Admin { spawned } => {
                if *spawned {
                    admin::post(json!({ "op": "write", "id": id, "data": data }));
                }
                None
            }
        };
        if changed {
            Self::publish_status(&hub, id);
        }
        drop(hub);
        match target {
            Some(io) => conpty::write(io.input, data.as_bytes()),
            None => true,
        }
    }

    fn resize(&self, id: &str, cols: Option<&Value>, rows: Option<&Value>) -> bool {
        let mut hub = self.lock();
        let Some(s) = hub.sessions.get_mut(id).filter(|s| s.tracker.state != State::Exited) else { return false };
        let c = shell::clamp_dim(cols, shell::MAX_COLS, s.cols);
        let r = shell::clamp_dim(rows, shell::MAX_ROWS, s.rows);
        if c == s.cols && r == s.rows {
            return true;
        }
        s.cols = c;
        s.rows = r;
        match &s.backend {
            Backend::Pty(io) => io.hpc.lock().unwrap().is_some_and(|hpc| Pty::resize(hpc, c as u16, r as u16)),
            Backend::Admin { spawned } => {
                if *spawned {
                    admin::post(json!({ "op": "resize", "id": id, "cols": c, "rows": r }));
                }
                true
            }
        }
    }

    pub fn kill(&self, id: &str) -> bool {
        let mut hub = self.lock();
        let Some(s) = hub.sessions.get_mut(id).filter(|s| s.tracker.state != State::Exited) else { return false };
        match &mut s.backend {
            Backend::Pty(io) => io.close_console(),
            Backend::Admin { spawned: true } => admin::post(json!({ "op": "kill", "id": id })),
            Backend::Admin { spawned: false } => {
                s.tracker.on_exit(Some(0));
                Self::publish_status(&hub, id);
            }
        }
        true
    }

    fn forget(&self, id: &str) -> bool {
        if !self.lock().sessions.contains_key(id) {
            return false;
        }
        self.kill(id);
        self.lock().sessions.remove(id);
        true
    }

    /// host.js 的 `dispatch`
    fn dispatch(self: &Arc<Self>, msg: &Value) -> Result<Value, ()> {
        let op = msg.get("op").and_then(Value::as_str).unwrap_or("");
        if op == "list" {
            return Ok(Self::states(&self.lock()));
        }
        let id = msg.get("sessionId").and_then(Value::as_str).filter(|id| valid_id(id)).ok_or(())?;
        match op {
            "open" => self.open(id, msg),
            "write" => {
                let data = msg.get("data").and_then(Value::as_str).ok_or(())?;
                if data.encode_utf16().count() > MAX_WRITE_UNITS {
                    return Err(());
                }
                Ok(Value::Bool(self.write(id, data)))
            }
            "resize" => Ok(Value::Bool(self.resize(id, msg.get("cols"), msg.get("rows")))),
            "kill" => Ok(Value::Bool(self.kill(id))),
            "forget" => Ok(Value::Bool(self.forget(id))),
            _ => Err(()),
        }
    }

    fn remove_client(&self, client: &Arc<Client>) {
        self.lock().clients.retain(|c| !Arc::ptr_eq(c, client));
        client.tx.lock().unwrap().take();
        client.pipe.shutdown();
    }

    fn serve(self: &Arc<Self>, pipe: Arc<Pipe>, token: String) {
        let (tx, rx) = channel::<String>();
        let queued = Arc::new(AtomicUsize::new(0));
        let client = Arc::new(Client { pipe: pipe.clone(), tx: Mutex::new(Some(tx)), queued: queued.clone(), authed: AtomicBool::new(false) });
        {
            let mut hub = self.lock();
            if hub.clients.len() >= MAX_SOCKETS {
                drop(hub);
                client.tx.lock().unwrap().take();
                pipe.shutdown();
                return;
            }
            hub.clients.push(client.clone());
        }
        // 寫出去的那一條
        let out = pipe.clone();
        std::thread::spawn(move || {
            for text in rx {
                let ok = out.write_all(text.as_bytes());
                queued.fetch_sub(text.len(), Ordering::AcqRel);
                if !ok {
                    out.shutdown();
                    break;
                }
            }
        });
        // 5 秒內沒認證就斷
        let watch = client.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(5));
            if !watch.authed.load(Ordering::Acquire) {
                watch.pipe.shutdown();
            }
        });
        let mut pending: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        'outer: loop {
            let n = pipe.read(&mut buf);
            if n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n]);
            while let Some(end) = pending.iter().position(|&b| b == b'\n') {
                if end > MAX_FRAME {
                    break 'outer;
                }
                let raw: Vec<u8> = pending.drain(..=end).collect();
                let text = String::from_utf8_lossy(&raw[..raw.len() - 1]);
                let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&text) else { break 'outer };
                let msg = Value::Object(obj);
                // Number.isSafeInteger 且 ≥ 1（小數在 serde_json 裡是 f64，as_i64 拿不到）
                let Some(req) = msg.get("id").and_then(Value::as_i64).filter(|n| *n >= 1 && *n <= 9_007_199_254_740_991) else { break 'outer };
                if !client.authed.load(Ordering::Acquire) {
                    if !self.auth_ok(&msg, &token) {
                        break 'outer;
                    }
                    client.authed.store(true, Ordering::Release);
                    client.send(line(&json!({ "id": req, "ok": true, "data": { "protocol": PROTOCOL, "pid": std::process::id(), "runtime": self.runtime } })));
                    continue;
                }
                let reply = match self.dispatch(&msg) {
                    Ok(data) => json!({ "id": req, "ok": true, "data": data }),
                    Err(()) => json!({ "id": req, "ok": false, "error": { "code": "TERMINAL_HOST_REQUEST" } }),
                };
                client.send(line(&reply));
            }
            if pending.len() > MAX_FRAME {
                break;
            }
        }
        self.remove_client(&client);
    }

    fn auth_ok(&self, msg: &Value, token: &str) -> bool {
        let given = msg.get("token").and_then(Value::as_str).unwrap_or("");
        msg.get("op").and_then(Value::as_str) == Some("auth")
            && msg.get("protocol").and_then(Value::as_i64) == Some(PROTOCOL)
            && is_token(given)
            // 固定時間比較
            && given.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
    }
}

pub fn valid_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn is_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// pty.js 的 `trimBuffer`：砍到上限，儘量從換行砍（別切在跳脫序列中間）
pub fn trim_buffer(text: &str) -> &str {
    if text.len() <= SCROLLBACK {
        return text;
    }
    let mut cut = text.len() - SCROLLBACK;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    match text[cut..].find('\n') {
        Some(nl) if nl < 4096 => &text[cut + nl + 1..],
        _ => &text[cut..],
    }
}

/// 宿主主迴圈：管道、flush、每秒巡檢、沒人用 5 秒就收工
pub fn run(pipe_name: &str, token: String, runtime: String) -> i32 {
    // 先搶到管道名：已經有一顆宿主在聽就直接退出
    let Ok(first) = Pipe::create(pipe_name, true) else { return 1 };
    let host = Arc::new(Host {
        hub: Mutex::new(Hub { sessions: HashMap::new(), clients: Vec::new(), flush_pending: false }),
        flush_cv: Condvar::new(),
        next_gen: AtomicU64::new(1),
        runtime,
    });
    admin::configure(host.clone());

    let h = host.clone();
    std::thread::spawn(move || loop {
        let mut hub = h.lock();
        while !hub.flush_pending {
            hub = h.flush_cv.wait(hub).unwrap();
        }
        drop(hub);
        std::thread::sleep(FLUSH);
        let mut hub = h.lock();
        hub.flush_pending = false;
        let ids: Vec<String> = hub.sessions.keys().cloned().collect();
        for id in ids {
            Host::flush_one(&mut hub, &id);
        }
    });

    let h = host.clone();
    std::thread::spawn(move || {
        let mut idle_since: Option<Instant> = Some(Instant::now());
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let mut hub = h.lock();
            let now = now_ms();
            let changed: Vec<String> = hub.sessions.iter_mut().filter_map(|(id, s)| s.tracker.tick(now).then(|| id.clone())).collect();
            for id in &changed {
                Host::publish_status(&hub, id);
            }
            if hub.clients.is_empty() && hub.sessions.is_empty() {
                let since = *idle_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= Duration::from_secs(5) {
                    std::process::exit(0);
                }
            } else {
                idle_since = None;
            }
        }
    });

    let mut current = first;
    loop {
        if current.accept().is_err() {
            return 1;
        }
        let Ok(next) = Pipe::create(pipe_name, false) else { return 1 };
        let conn = Arc::new(std::mem::replace(&mut current, next));
        let (h, token) = (host.clone(), token.clone());
        std::thread::spawn(move || h.serve(conn, token));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_prefers_newline() {
        let mut s = "x".repeat(SCROLLBACK);
        s.push_str("ab\ncd");
        let t = trim_buffer(&s);
        assert!(t.len() <= SCROLLBACK);
        let big = format!("{}\n{}", "y".repeat(10), "z".repeat(SCROLLBACK));
        assert_eq!(trim_buffer(&big), "z".repeat(SCROLLBACK));
        let s2 = format!("中{}", "z".repeat(SCROLLBACK));
        assert!(trim_buffer(&s2).len() <= SCROLLBACK);
    }

    #[test]
    fn ids_and_tokens() {
        assert!(valid_id("t_abc-1"));
        assert!(!valid_id("../escape"));
        assert!(!valid_id(""));
        assert!(is_token(&"a".repeat(64)));
        assert!(!is_token(&"界".repeat(64)));
    }
}
