//! `voiceink-probe usage-scan <claude|codex|grok>`：用量統計的逐行解析，
//! 對照 `src/main/codeusage/parsers.js`（三個 parse*Line）＋ `scan.js` 的 `streamFile`。
//!
//! stdin 一份 JSON 工作清單 `[{ file, offset, state }]`（路徑全由 main 決定），
//! stdout 一份同順序的 `[{ next, state, events }]`。檔案之間互不相干，所以多執行緒一起讀。
//! **規則逐條照 parsers.js 搬**；改任何一邊都要跑 `scripts/probe-usage-native-parity.js`。

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeZone};
use memchr::memmem;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 同 parsers.js 的 MAX_LINE（那邊量的是 UTF-16 長度，這裡是位元組，只差在 16MB 那條邊上）
const MAX_LINE: usize = 16 * 1024 * 1024;
const USD_TICKS: f64 = 1e10;

#[derive(Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
struct State {
    seen: Vec<String>,
    model: String,
    replay: bool,
    is_fork: bool,
    session_start_ms: f64,
    last_total_tokens: f64,
}

#[derive(Deserialize)]
struct Job {
    file: String,
    offset: u64,
    #[serde(default)]
    state: State,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    ts: f64,
    model: String,
    input: f64,
    output: f64,
    reasoning: f64,
    cache_read: f64,
    cache_write: f64,
    cache_write1h: f64,
    requests: f64,
    cost_usd: Option<f64>,
}

#[derive(Serialize)]
struct Output {
    next: u64,
    state: State,
    events: Vec<Event>,
}

/// 跨行狀態：`seen` 要能查也要保留加入順序（JS 的 Set 存回游標時照插入順序）
struct Scan {
    st: State,
    seen: HashSet<String>,
}

impl Scan {
    fn first_time(&mut self, id: String) -> bool {
        if id.is_empty() {
            return true;
        }
        if !self.seen.insert(id.clone()) {
            return false;
        }
        self.st.seen.push(id);
        true
    }
}

// ===== JS 語意的小工具 =====

/// `Number(v)`；NaN 回 None
fn js_number(v: Option<&Value>) -> Option<f64> {
    let n = match v? {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse().ok()? }
        }
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => js_number(a.first())?,
        _ => return None,
    };
    (!n.is_nan()).then_some(n)
}

/// parsers.js 的 `num`：有限且非負，否則 0
fn num(v: Option<&Value>) -> f64 {
    js_number(v).filter(|n| n.is_finite() && *n >= 0.0).unwrap_or(0.0)
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v)`（只處理記錄裡真的會出現的型別）
fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{f:.0}"),
            _ => n.to_string(),
        },
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(_) => String::new(),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(a || b || c || fallback)`
fn first_truthy(values: &[Option<&Value>], fallback: &str) -> String {
    values.iter().copied().find(|v| truthy(*v)).flatten().map_or_else(|| fallback.to_string(), js_string)
}

/// `Date.parse`：ISO 帶時區照時區、只有日期算 UTC、沒時區的日期時間算本地時間
fn parse_date(s: &str) -> f64 {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return dt.timestamp_millis() as f64;
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(s, fmt) {
            return Local.from_local_datetime(&naive).earliest().map_or(0.0, |d| d.timestamp_millis() as f64);
        }
    }
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map_or(0.0, |d| d.and_utc().timestamp_millis() as f64)
}

/// parsers.js 的 `toMs`
fn to_ms(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.is_finite() => if f > 1e11 { f } else { f * 1000.0 },
            _ => 0.0,
        },
        Some(Value::String(s)) => parse_date(s),
        _ => 0.0,
    }
}

/// parsers.js 的 `uuidv7Ms`：第 15 個字是 '7' 才算，前 48 位元是毫秒
fn uuidv7_ms(v: Option<&Value>) -> f64 {
    let Some(Value::String(s)) = v else { return 0.0 };
    let b = s.as_bytes();
    if !s.is_ascii() || b.len() < 36 || b[14] != b'7' {
        return 0.0;
    }
    // parseInt(hex, 16)：取開頭連續的十六進位字
    let hex: Vec<u8> = b[0..8].iter().chain(&b[9..13]).copied().take_while(u8::is_ascii_hexdigit).collect();
    std::str::from_utf8(&hex).ok().and_then(|h| u64::from_str_radix(h, 16).ok()).map_or(0.0, |n| n as f64)
}

fn is_obj(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

fn at<'a>(v: &'a Value, path: &str) -> Option<&'a Value> {
    v.pointer(path)
}

// ===== 三家解析器 =====

fn claude(row: &Value, sc: &mut Scan) -> Vec<Event> {
    if at(row, "/type").and_then(Value::as_str) != Some("assistant") {
        return vec![];
    }
    let usage = at(row, "/message/usage");
    if !is_obj(usage) {
        return vec![];
    }
    let u = usage.unwrap();
    let model = first_truthy(&[at(row, "/message/model")], "unknown");
    if model.starts_with('<') {
        return vec![];
    }
    let id = first_truthy(&[at(row, "/message/id"), at(row, "/requestId"), at(row, "/uuid")], "");
    if !sc.first_time(id) {
        return vec![];
    }
    let write1h = num(at(u, "/cache_creation/ephemeral_1h_input_tokens"));
    let write_total = num(u.get("cache_creation_input_tokens"));
    vec![Event {
        ts: to_ms(row.get("timestamp")),
        model,
        input: num(u.get("input_tokens")),
        output: num(u.get("output_tokens")),
        reasoning: num(at(u, "/output_tokens_details/thinking_tokens")),
        cache_read: num(u.get("cache_read_input_tokens")),
        cache_write: (write_total - write1h).max(0.0),
        cache_write1h: write1h,
        requests: 1.0,
        cost_usd: None,
    }]
}

fn codex(row: &Value, sc: &mut Scan) -> Vec<Event> {
    let st = &mut sc.st;
    let kind = row.get("type").and_then(Value::as_str);
    let set_model = |st: &mut State, v: Option<&Value>| {
        if let Some(Value::String(m)) = v {
            if !m.is_empty() {
                st.model = m.clone();
            }
        }
    };
    if kind == Some("session_meta") {
        if truthy(at(row, "/payload/forked_from_id")) || truthy(at(row, "/payload/parent_thread_id")) {
            st.is_fork = true;
            st.replay = true;
            st.session_start_ms = uuidv7_ms(at(row, "/payload/id"));
        }
        set_model(st, at(row, "/payload/model"));
        return vec![];
    }
    if kind == Some("turn_context") {
        set_model(st, at(row, "/payload/model"));
        if st.is_fork {
            st.replay = if st.session_start_ms > 0.0 {
                let turn = uuidv7_ms(at(row, "/payload/turn_id"));
                !(turn != 0.0 && turn >= st.session_start_ms - 500.0)
            } else {
                false
            };
        }
        return vec![];
    }
    if kind != Some("event_msg") || at(row, "/payload/type").and_then(Value::as_str) != Some("token_count") {
        return vec![];
    }
    if st.replay {
        return vec![];
    }
    let usage = at(row, "/payload/info/last_token_usage");
    if !is_obj(usage) {
        return vec![];
    }
    let u = usage.unwrap();
    if num(u.get("input_tokens")) == 0.0 && num(u.get("output_tokens")) == 0.0 {
        return vec![];
    }
    let total = at(row, "/payload/info/total_token_usage");
    let mut cur = num(total.and_then(|t| t.get("total_tokens")));
    if cur == 0.0 {
        cur = num(total.and_then(|t| t.get("input_tokens"))) + num(total.and_then(|t| t.get("output_tokens")));
    }
    if cur > 0.0 {
        if cur <= st.last_total_tokens {
            return vec![];
        }
        st.last_total_tokens = cur;
    }
    let cached = num(u.get("cached_input_tokens"));
    vec![Event {
        ts: to_ms(row.get("timestamp")),
        model: if st.model.is_empty() { "unknown".into() } else { st.model.clone() },
        input: (num(u.get("input_tokens")) - cached).max(0.0),
        output: num(u.get("output_tokens")),
        reasoning: num(u.get("reasoning_output_tokens")),
        cache_read: cached,
        cache_write: num(u.get("cache_write_input_tokens")),
        cache_write1h: 0.0,
        requests: 1.0,
        cost_usd: None,
    }]
}

fn grok_has_tokens(part: &Value) -> bool {
    if !is_obj(Some(part)) {
        return false;
    }
    ["inputTokens", "outputTokens", "cachedReadTokens", "cacheCreationTokens", "reasoningTokens"]
        .iter()
        .any(|k| num(part.get(*k)) > 0.0)
        || js_number(part.get("costUsdTicks")).is_some_and(|n| n.is_finite() && n > 0.0)
}

fn grok_event(ts: f64, model: String, part: &Value) -> Event {
    let cached = num(part.get("cachedReadTokens"));
    let calls = num(part.get("modelCalls"));
    Event {
        ts,
        model,
        input: (num(part.get("inputTokens")) - cached).max(0.0),
        output: num(part.get("outputTokens")),
        reasoning: num(part.get("reasoningTokens")),
        cache_read: cached,
        cache_write: num(part.get("cacheCreationTokens")),
        cache_write1h: 0.0,
        requests: if calls == 0.0 { 1.0 } else { calls },
        cost_usd: js_number(part.get("costUsdTicks")).filter(|n| n.is_finite()).map(|n| n / USD_TICKS),
    }
}

fn grok(row: &Value, sc: &mut Scan) -> Vec<Event> {
    let Some(update) = at(row, "/params/update") else { return vec![] };
    if update.get("sessionUpdate").and_then(Value::as_str) != Some("turn_completed") {
        return vec![];
    }
    let usage = update.get("usage");
    if !is_obj(usage) {
        return vec![];
    }
    let u = usage.unwrap();
    let id = first_truthy(&[update.get("prompt_id"), at(row, "/params/_meta/eventId")], "");
    if !sc.first_time(id) {
        return vec![];
    }
    let mut ts = to_ms(row.get("timestamp"));
    if ts == 0.0 {
        ts = to_ms(at(row, "/params/_meta/agentTimestampMs"));
    }
    if let Some(Value::Object(detail)) = u.get("modelUsage") {
        let events: Vec<Event> = detail
            .iter()
            .filter(|(_, part)| grok_has_tokens(part))
            .map(|(model, part)| grok_event(ts, model.clone(), part))
            .collect();
        if !events.is_empty() {
            return events;
        }
    }
    if !grok_has_tokens(u) {
        return vec![];
    }
    vec![grok_event(ts, "unknown".into(), u)]
}

// ===== 讀檔 =====

type Parser = fn(&Value, &mut Scan) -> Vec<Event>;

/// 先用位元組比對擋掉絕大多數的行（跟 JS 的 `line.includes` 同一組字）
fn wanted(parser: &str, line: &[u8]) -> bool {
    let has = |needle: &str| memmem::find(line, needle.as_bytes()).is_some();
    match parser {
        "claude" => has("\"usage\"") && has("\"assistant\""),
        "codex" => has("\"token_count\"") || has("\"turn_context\"") || has("\"session_meta\""),
        _ => has("\"turn_completed\""),
    }
}

fn parse_line(line: &[u8]) -> Option<Value> {
    serde_json::from_slice(line)
        .ok()
        .or_else(|| serde_json::from_str(&String::from_utf8_lossy(line)).ok())
}

/// `scan.js#streamFile`：只讀到開檔當下的大小，游標只推到最後一個完整換行
fn stream_file(job: &Job, parser_name: &str, parse: Parser, sc: &mut Scan, events: &mut Vec<Event>) -> u64 {
    let Ok(mut file) = File::open(&job.file) else { return job.offset };
    let Ok(size) = file.metadata().map(|m| m.len()) else { return job.offset };
    if size <= job.offset {
        return size;
    }
    if file.seek(SeekFrom::Start(job.offset)).is_err() {
        return job.offset;
    }
    let mut reader = BufReader::with_capacity(1 << 20, file.take(size - job.offset));
    let mut complete = job.offset;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) if buf.last() != Some(&b'\n') => break, // 還沒寫完的尾巴，留給下一輪
            Ok(n) => complete += n as u64,
        }
        let mut line = &buf[..buf.len() - 1];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        if line.is_empty() || line.len() > MAX_LINE || !wanted(parser_name, line) {
            continue;
        }
        if let Some(row) = parse_line(line) {
            events.extend(parse(&row, sc));
        }
    }
    complete
}

fn run_job(job: &Job, parser_name: &str, parse: Parser) -> Output {
    let st = job.state.clone();
    let seen = st.seen.iter().cloned().collect();
    let mut sc = Scan { st, seen };
    let mut events = Vec::new();
    let next = stream_file(job, parser_name, parse, &mut sc, &mut events);
    Output { next, state: sc.st, events }
}

pub fn run(parser_name: &str) -> i32 {
    let parse: Parser = match parser_name {
        "claude" => claude,
        "codex" => codex,
        "grok" => grok,
        _ => {
            eprintln!("usage-scan: unknown parser");
            return 2;
        }
    };
    let jobs: Vec<Job> = match serde_json::from_reader(std::io::stdin().lock()) {
        Ok(jobs) => jobs,
        Err(e) => {
            eprintln!("usage-scan: bad input: {e}");
            return 2;
        }
    };
    let results: Vec<Mutex<Option<Output>>> = jobs.iter().map(|_| Mutex::new(None)).collect();
    let cursor = AtomicUsize::new(0);
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = cursor.fetch_add(1, Ordering::Relaxed);
                let Some(job) = jobs.get(i) else { break };
                let out = run_job(job, parser_name, parse);
                *results[i].lock().unwrap() = Some(out);
            });
        }
    });
    let outs: Vec<Output> = results.into_iter().map(|m| m.into_inner().unwrap().unwrap()).collect();
    let mut stdout = std::io::BufWriter::new(std::io::stdout().lock());
    let ok = serde_json::to_writer(&mut stdout, &outs).is_ok() && stdout.flush().is_ok();
    if ok { 0 } else { 1 }
}
