//! `voiceink-probe hook [--key 0xA5]`：語音輸入的全域熱鍵（低階鍵盤 hook），取代 .NET 的 VoiceInkHook.exe
//! （.NET runtime 一載入就是 30MB 級的工作集）。協定與行為照 `native/dictation-hook/Program.cs`：
//!
//! stdout 一行一個事件：`READY` 掛上了／`D` 熱鍵按下（auto-repeat 會重送）／`U` 放開／`E` Esc（**不吞**）。
//! 熱鍵的 down/up 回傳 1 吞掉；注入的按鍵（LLKHF_INJECTED）一律放行。stdin 讀到 EOF＝父程序走了，自己收工。

use std::io::{Read, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, SetWindowsHookExW, UnhookWindowsHookEx,
    WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

const VK_RMENU: u32 = 0xA5;
const VK_ESCAPE: u32 = 0x1B;

static HOTKEY: AtomicU32 = AtomicU32::new(VK_RMENU);
static OUT: Mutex<()> = Mutex::new(());

fn emit(line: &str) {
    // hook callback 有時間預算（超過 LowLevelHooksTimeout 會被系統拔掉），只寫一行短字串
    let _guard = OUT.lock();
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush());
}

unsafe extern "system" fn callback(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let data = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let message = wparam.0 as u32;
        let injected = data.flags.0 & LLKHF_INJECTED.0 != 0;
        let down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        let up = message == WM_KEYUP || message == WM_SYSKEYUP;
        if !injected && data.vkCode == HOTKEY.load(Ordering::Relaxed) && (down || up) {
            emit(if down { "D" } else { "U" });
            // 這顆鍵到此為止，前景程式什麼都收不到（整支程式存在的理由）
            return LRESULT(1);
        }
        if !injected && down && data.vkCode == VK_ESCAPE {
            // Esc 只是「取消錄音」的訊號，一定要放行
            emit("E");
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// `--key 0xA5` 或 `--key 165`，範圍 1..=255，壞值維持右 Alt
fn parse_key(args: &[String]) -> u32 {
    args.windows(2)
        .filter(|w| w[0] == "--key")
        .filter_map(|w| {
            let raw = w[1].as_str();
            match raw.get(..2) {
                Some(p) if p.eq_ignore_ascii_case("0x") => u32::from_str_radix(&raw[2..], 16).ok(),
                _ => raw.parse().ok(),
            }
        })
        .filter(|k| (1..=0xFF).contains(k))
        .last()
        .unwrap_or(VK_RMENU)
}

pub fn run(args: &[String]) -> i32 {
    HOTKEY.store(parse_key(args), Ordering::Relaxed);
    let hook = unsafe {
        let module = GetModuleHandleW(None).ok();
        SetWindowsHookExW(WH_KEYBOARD_LL, Some(callback), module.map(Into::into), 0)
    };
    let Ok(hook) = hook else {
        emit("ERR hook");
        return 3;
    };
    emit("READY");
    // 父程序關掉時 stdin 收到 EOF；主執行緒要留給訊息迴圈，另開一條來等
    std::thread::spawn(|| {
        let mut buf = [0u8; 64];
        let mut stdin = std::io::stdin();
        while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
        std::process::exit(0);
    });
    // 低階 hook 的 callback 只會在有訊息迴圈的執行緒上被呼叫，這個迴圈不能省
    let mut msg = MSG::default();
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {}
    unsafe {
        let _ = UnhookWindowsHookEx(hook);
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_key(&a(&[])), VK_RMENU);
        assert_eq!(parse_key(&a(&["--key", "0x1B"])), 0x1B);
        assert_eq!(parse_key(&a(&["--key", "165"])), 165);
        assert_eq!(parse_key(&a(&["--key", "0x100"])), VK_RMENU);
        assert_eq!(parse_key(&a(&["--key", "abc"])), VK_RMENU);
    }

    /// 回呼本身：熱鍵吞掉（回 1）、注入的放行、Esc 放行
    #[test]
    fn swallow_rules() {
        use windows::Win32::UI::WindowsAndMessaging::KBDLLHOOKSTRUCT_FLAGS;
        let call = |vk: u32, flags: u32, msg: u32| {
            let data = KBDLLHOOKSTRUCT { vkCode: vk, flags: KBDLLHOOKSTRUCT_FLAGS(flags), ..Default::default() };
            unsafe { callback(0, WPARAM(msg as usize), LPARAM(&data as *const _ as isize)) }.0
        };
        HOTKEY.store(VK_RMENU, Ordering::Relaxed);
        assert_eq!(call(VK_RMENU, 0, WM_SYSKEYDOWN), 1);
        assert_eq!(call(VK_RMENU, 0, WM_KEYUP), 1);
        assert_ne!(call(VK_RMENU, LLKHF_INJECTED.0, WM_KEYDOWN), 1);
        assert_ne!(call(VK_ESCAPE, 0, WM_KEYDOWN), 1);
        assert_ne!(call(0x41, 0, WM_KEYDOWN), 1);
    }
}
