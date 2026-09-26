//! 管理員終端機，對照 `admin.js`（宿主這一端）與 `admin-host.js`（提權的那一份）。
//!
//! ConPTY 開不出提權的 shell（CreateProcess 繼承呼叫者的 token），UAC 的 `runas` 又沒辦法把
//! pty handle 交接過來，所以讓**提權的同一支 exe** 自己開 pty，位元組經具名管道轉回來。
//! 一顆提權宿主服務所有管理員工作階段（UAC 只跳一次）；管道名是 128-bit 亂數、只收第一個連線。

use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use windows::Win32::Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom};

use crate::conpty::{self, Pty, Utf8Stream};
use crate::host::{Backend, Host};
use crate::pipe::Pipe;
use crate::shell;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_BUFFER: usize = 4 * 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
struct Link {
    pipe: Option<Arc<Pipe>>,
    starting: bool,
    /// 等提權宿主連上來的工作階段（id, generation）
    waiting: Vec<(String, u64)>,
}

static HOST: OnceLock<Arc<Host>> = OnceLock::new();
static LINK: Mutex<Option<Link>> = Mutex::new(None);

pub fn configure(host: Arc<Host>) {
    let _ = HOST.set(host);
}

fn with_link<T>(f: impl FnOnce(&mut Link) -> T) -> T {
    f(LINK.lock().unwrap().get_or_insert_with(Link::default))
}

pub fn post(msg: Value) {
    if let Some(pipe) = with_link(|l| l.pipe.clone()) {
        let mut text = msg.to_string();
        text.push('\n');
        // 斷線由讀取那一條收尾
        pipe.write_all(text.as_bytes());
    }
}

fn system32(exe: &str) -> String {
    format!("{}\\System32\\{exe}", std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
}

fn random_hex() -> Option<String> {
    let mut buf = [0u8; 16];
    unsafe { BCryptGenRandom(None, &mut buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }.ok().ok()?;
    Some(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// 對某個管理員工作階段送一段文字（提示或錯誤訊息）
fn say(host: &Arc<Host>, id: &str, generation: u64, text: &str) {
    host.absorb(id, generation, text);
}

fn mark_spawned(host: &Arc<Host>, id: &str, generation: u64) -> Option<(String, String, i64, i64)> {
    let mut hub = host.lock();
    let s = hub.sessions.get_mut(id).filter(|s| s.generation == generation)?;
    s.backend = Backend::Admin { spawned: true };
    Some((s.shell.clone(), s.cwd.clone(), s.cols, s.rows))
}

/// 新的管理員工作階段：沒有提權宿主就起一顆，連上之後補送 spawn
pub fn spawn(host: Arc<Host>, id: String, generation: u64) {
    let connected = with_link(|l| {
        if l.pipe.is_some() {
            return true;
        }
        l.waiting.push((id.clone(), generation));
        if !l.starting {
            l.starting = true;
            std::thread::spawn(start);
        }
        false
    });
    if connected {
        send_spawn(&host, &id, generation);
    }
}

fn send_spawn(host: &Arc<Host>, id: &str, generation: u64) {
    say(host, id, generation, "\x1b[90m已取得系統管理員權限。\x1b[0m\r\n");
    if let Some((shell, cwd, cols, rows)) = mark_spawned(host, id, generation) {
        post(json!({ "op": "spawn", "id": id, "shell": shell, "cwd": cwd, "cols": cols, "rows": rows }));
    }
}

fn fail_waiting(message: &str) {
    let Some(host) = HOST.get() else { return };
    let waiting = with_link(|l| {
        l.starting = false;
        std::mem::take(&mut l.waiting)
    });
    for (id, generation) in waiting {
        say(host, &id, generation, &format!("\r\n\x1b[31m{message}\x1b[0m\r\n"));
        host.on_exit(&id, generation, Some(1));
    }
}

fn start() {
    let Some(name) = random_hex().map(|h| format!("\\\\.\\pipe\\voiceink-term-{h}")) else {
        return fail_waiting("無法建立管理員終端機的連線通道。");
    };
    let Ok(server) = Pipe::create(&name, true) else { return fail_waiting("無法建立管理員終端機的連線通道。") };
    let server = Arc::new(server);
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    // Start-Process -Verb RunAs 才會跳 UAC。參數只有自己的路徑與自己產生的管道名
    let command = format!(
        "Start-Process -FilePath '{}' -ArgumentList '--terminal-admin-host={}' -Verb RunAs -WindowStyle Hidden",
        exe.replace('\'', "''"),
        name
    );
    let child = std::process::Command::new(system32("WindowsPowerShell\\v1.0\\powershell.exe"))
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &command])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    let Ok(mut child) = child else { return fail_waiting("無法啟動管理員終端機。") };

    let (tx, rx) = channel();
    let acceptor = server.clone();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let _ = tx2.send(if acceptor.accept().is_ok() { "connected" } else { "failed" });
    });
    std::thread::spawn(move || {
        // 使用者在 UAC 按「否」時 Start-Process 失敗；那時還沒有人連上來
        let denied = child.wait().map(|s| !s.success()).unwrap_or(true);
        if denied {
            let _ = tx.send("denied");
        }
    });
    let outcome = loop {
        match rx.recv_timeout(CONNECT_TIMEOUT) {
            Ok("connected") => break Ok(()),
            Ok("denied") => break Err("需要系統管理員權限，授權被取消了。"),
            Ok(_) => break Err("無法建立管理員終端機的連線通道。"),
            Err(RecvTimeoutError::Timeout) => break Err("管理員終端機沒有回應。"),
            Err(RecvTimeoutError::Disconnected) => break Err("無法啟動管理員終端機。"),
        }
    };
    if let Err(message) = outcome {
        server.shutdown();
        return fail_waiting(message);
    }
    let waiting = with_link(|l| {
        l.pipe = Some(server.clone());
        l.starting = false;
        std::mem::take(&mut l.waiting)
    });
    let host = HOST.get().unwrap().clone();
    for (id, generation) in waiting {
        send_spawn(&host, &id, generation);
    }
    read_admin(&host, &server);
    // 提權宿主不見了：管理員工作階段全部收掉
    with_link(|l| l.pipe = None);
    let admins: Vec<(String, u64)> = host
        .lock()
        .sessions
        .iter()
        .filter(|(_, s)| matches!(s.backend, Backend::Admin { .. }) && s.tracker.state != crate::status::State::Exited)
        .map(|(id, s)| (id.clone(), s.generation))
        .collect();
    for (id, generation) in admins {
        say(&host, &id, generation, "\r\n\x1b[31m管理員終端機的背景程序已結束。\x1b[0m\r\n");
        host.on_exit(&id, generation, Some(1));
    }
}

fn gen_of(host: &Arc<Host>, id: &str) -> Option<u64> {
    host.lock().sessions.get(id).filter(|s| matches!(s.backend, Backend::Admin { .. })).map(|s| s.generation)
}

/// 提權宿主送回來的事件：`spawned`／`data`／`exit`
fn read_admin(host: &Arc<Host>, pipe: &Pipe) {
    let mut pending: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = pipe.read(&mut buf);
        if n == 0 {
            return;
        }
        pending.extend_from_slice(&buf[..n]);
        while let Some(end) = pending.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = pending.drain(..=end).collect();
            let Ok(msg) = serde_json::from_slice::<Value>(&raw[..raw.len() - 1]) else { continue };
            let Some(id) = msg.get("id").and_then(Value::as_str) else { continue };
            let Some(generation) = gen_of(host, id) else { continue };
            match msg.get("ev").and_then(Value::as_str) {
                Some("spawned") => {
                    if let Some(pid) = msg.get("pid").and_then(Value::as_u64).filter(|p| *p > 0) {
                        if let Some(s) = host.lock().sessions.get_mut(id) {
                            s.pid = Some(pid as u32);
                        }
                    }
                }
                Some("data") => {
                    if let Some(data) = msg.get("data").and_then(Value::as_str) {
                        host.absorb(id, generation, data);
                    }
                }
                Some("exit") => host.on_exit(id, generation, Some(msg.get("code").and_then(Value::as_i64).unwrap_or(0))),
                _ => {}
            }
        }
        if pending.len() > MAX_BUFFER {
            pending.clear();
        }
    }
}

// ===== 提權的那一份（`--terminal-admin-host=<管道名>`）=====

struct AdminTerm {
    input: isize,
    /// kill 與程序結束都會關 ConPTY：誰先拿走誰關，關兩次會讓整顆程序掛掉
    hpc: Option<isize>,
}

pub fn run_elevated(pipe_name: &str) -> i32 {
    if !pipe_name.starts_with("\\\\.\\pipe\\") {
        return 1;
    }
    let Ok(pipe) = Pipe::open(pipe_name) else { return 1 };
    let pipe = Arc::new(pipe);
    let send = {
        let pipe = pipe.clone();
        move |msg: Value| {
            let mut text = msg.to_string();
            text.push('\n');
            pipe.write_all(text.as_bytes());
        }
    };
    let send = Arc::new(Mutex::new(send));
    let post = |msg: Value| (send.lock().unwrap())(msg);
    post(json!({ "ev": "ready" }));
    let terms: Arc<Mutex<HashMap<String, AdminTerm>>> = Arc::new(Mutex::new(HashMap::new()));

    let mut pending: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = pipe.read(&mut buf);
        if n == 0 {
            break;
        }
        pending.extend_from_slice(&buf[..n]);
        while let Some(end) = pending.iter().position(|&b| b == b'\n') {
            let raw: Vec<u8> = pending.drain(..=end).collect();
            let Ok(msg) = serde_json::from_slice::<Value>(&raw[..raw.len() - 1]) else { continue };
            let Some(id) = msg.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string) else { continue };
            match msg.get("op").and_then(Value::as_str) {
                Some("spawn") => spawn_elevated(&id, &msg, &terms, &send),
                Some("write") => {
                    let input = terms.lock().unwrap().get(&id).map(|t| t.input);
                    if let (Some(input), Some(data)) = (input, msg.get("data").and_then(Value::as_str)) {
                        conpty::write(input, data.as_bytes());
                    }
                }
                Some("resize") => {
                    if let Some(hpc) = terms.lock().unwrap().get(&id).and_then(|t| t.hpc) {
                        let c = shell::clamp_dim(msg.get("cols"), shell::MAX_COLS, 80);
                        let r = shell::clamp_dim(msg.get("rows"), shell::MAX_ROWS, 24);
                        Pty::resize(hpc, c as u16, r as u16);
                    }
                }
                Some("kill") => {
                    if let Some(hpc) = terms.lock().unwrap().get_mut(&id).and_then(|t| t.hpc.take()) {
                        std::thread::spawn(move || Pty::close_console(hpc));
                    }
                }
                _ => {}
            }
        }
        if pending.len() > MAX_BUFFER {
            pending.clear();
        }
    }
    // 主程序斷線：提權的 shell 一個都不留
    for t in terms.lock().unwrap().values_mut() {
        if let Some(hpc) = t.hpc.take() {
            Pty::close_console(hpc);
        }
    }
    0
}


fn spawn_elevated<F: Fn(Value) + Send + 'static>(id: &str, msg: &Value, terms: &Arc<Mutex<HashMap<String, AdminTerm>>>, send: &Arc<Mutex<F>>) {
    {
        let t = terms.lock().unwrap();
        if t.contains_key(id) || t.len() >= shell::MAX_SESSIONS {
            return;
        }
    }
    let key = shell::normalize_shell(msg.get("shell").and_then(Value::as_str));
    let (exe, args) = shell::shell_command(&key);
    let cwd = shell::normalize_cwd(msg.get("cwd").and_then(Value::as_str));
    let c = shell::clamp_dim(msg.get("cols"), shell::MAX_COLS, 80);
    let r = shell::clamp_dim(msg.get("rows"), shell::MAX_ROWS, 24);
    let post = {
        let send = send.clone();
        move |v: Value| (send.lock().unwrap())(v)
    };
    let pty = match Pty::spawn(&exe, &args, &cwd, &shell::shell_environment("", "", id), c as u16, r as u16) {
        Ok(p) => p,
        Err(_) => return post(json!({ "ev": "exit", "id": id, "code": 1 })),
    };
    terms.lock().unwrap().insert(id.to_string(), AdminTerm { input: pty.input(), hpc: Some(pty.hpc()) });
    let (output, process, pid) = (pty.output, pty.process, pty.pid);
    let (sid, post2) = (id.to_string(), post.clone());
    std::thread::spawn(move || {
        let mut dec = Utf8Stream::default();
        let mut buf = vec![0u8; 64 * 1024];
        let mut announced = false;
        loop {
            let n = conpty::read(output, &mut buf);
            if n == 0 {
                break;
            }
            if !announced {
                announced = true;
                post2(json!({ "ev": "spawned", "id": sid, "pid": pid }));
            }
            let text = dec.push(&buf[..n]);
            if !text.is_empty() {
                post2(json!({ "ev": "data", "id": sid, "data": text }));
            }
        }
        conpty::close(output);
    });
    let (sid, terms) = (id.to_string(), terms.clone());
    std::thread::spawn(move || {
        let code = conpty::wait_exit(process);
        std::thread::sleep(Duration::from_millis(50));
        if let Some(t) = terms.lock().unwrap().remove(&sid) {
            if let Some(hpc) = t.hpc {
                Pty::close_console(hpc);
            }
            conpty::close(t.input);
        }
        conpty::close(process);
        post(json!({ "ev": "exit", "id": sid, "code": code.unwrap_or(0) }));
    });
}
