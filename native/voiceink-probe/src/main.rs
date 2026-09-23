//! VoiceInk 的常駐取樣小程式，取代原本兩支 PowerShell（每支 70～190MB）：
//!
//! - `voiceink-probe sysmon`   ＝ `src/main/sysmon/probe.ps1`：stdin 收 `static|tick|detail|bye <seq> [arg]`，
//!   stdout 吐 `#B <cmd> <seq>` … `#E <cmd> <seq>` 框住的資料塊。**協定與每一列的格式都跟 ps1 一樣**，
//!   `sampler.js`／`metrics.js` 不必知道對面換了人。
//! - `voiceink-probe observer` ＝ `src/main/screentime/observer.ps1`：每秒一列前景視窗 JSON。
//!
//! 不接受任何來自 renderer 的字串：指令只有固定幾個，全由 main 送。

mod detail;
mod inventory;
mod observer;
mod procs;
mod smart;
mod tick;
mod util;

use std::io::{BufRead, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};

use wmi::WMIConnection;

fn frame(cmd: &str, seq: &str, body: &str) -> String {
    let mut s = String::with_capacity(body.len() + 64);
    s.push_str(&format!("#B {cmd} {seq}\n"));
    s.push_str(body);
    if !body.is_empty() && !body.ends_with('\n') {
        s.push('\n');
    }
    s.push_str(&format!("#E {cmd} {seq}\n"));
    s
}

fn lines_to_body(rows: Vec<String>) -> String {
    let mut body = rows.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    body
}

fn sysmon() {
    // WMI 連不上就只剩原生那幾段（程序／網路／SMART），不要整支掛掉
    let con = WMIConnection::new().ok();
    let mut st = tick::TickState { proc_buf: Vec::new(), net_buf: Vec::new(), smart_drives: Vec::new() };
    let stdout = std::io::stdout();
    let write = |s: &str| -> bool {
        let mut out = stdout.lock();
        out.write_all(s.as_bytes()).and_then(|_| out.flush()).is_ok()
    };
    if !write("#READY\n") {
        return;
    }
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(' ').collect();
        let (cmd, seq, arg) = (parts[0], parts.get(1).copied().unwrap_or("0"), parts.get(2).copied().unwrap_or(""));
        if cmd == "bye" {
            break;
        }
        let result = catch_unwind(AssertUnwindSafe(|| match cmd {
            "static" => {
                let (rows, disks) = inventory::emit(con.as_ref());
                st.smart_drives = disks;
                lines_to_body(rows)
            }
            "tick" => tick::emit(con.as_ref(), &mut st),
            "detail" => detail::emit(arg.parse().unwrap_or(0), &mut st.proc_buf),
            _ => String::new(),
        }));
        let out = match result {
            Ok(body) => frame(cmd, seq, &body),
            // 單輪失敗不能讓取樣器死掉：回一個帶錯誤的空框，下一輪照跑
            Err(_) => frame(cmd, seq, "#ERR|sampler panic\n"),
        };
        if !write(&out) {
            break;
        }
    }
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("observer") => observer::run(),
        Some("sysmon") => sysmon(),
        _ => {
            eprintln!("usage: voiceink-probe sysmon|observer");
            std::process::exit(2);
        }
    }
}
