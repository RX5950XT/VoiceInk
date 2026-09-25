//! `voiceink-probe disk-tree <path> <maxMs> <maxDepth> <keep>`：磁碟空間樹，
//! 對照 `src/main/sysmon/disktree.js`。
//!
//! `read_dir` 自帶大小、不跟 symlink／junction、讀不到記 incomplete。由下往上。
//! 額度＝`available_parallelism`（上限 16，主執行緒佔一格）：一開始借光開 scoped thread，
//! 結束才還。資料夾進同一條佇列。額度 1 不分支。列舉超過 8 秒沒有新項目就取消該次呼叫。
//! 每層留前 `keep` 個，其餘與小於根總量 1/20000 的併成「其他」；超過 `maxDepth` 只加總（`t:1`）。
//! stdout：每 200ms 一列 `P <bytes> <files> <dirs>`（一次寫整行）；最後 `J <json>`。根讀不到印 `E read`。
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};
use serde::Serialize;
const PROGRESS_MS: u64 = 200;
const RELATIVE: u64 = 20_000;
const MAX_THREADS: usize = 16;
const STUCK_MS: u64 = 8_000;
#[derive(Serialize)]
struct Node {
    n: String,
    s: u64,
    f: u64,
    k: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    c: Vec<Node>,
    #[serde(skip_serializing_if = "is_zero")]
    t: u8,
    /// 「其他」併進去的項目數。只給第二輪修剪加總，不進 JSON。
    #[serde(skip)]
    collapsed: u64,
}
#[derive(Serialize)]
struct Report {
    root: String,
    bytes: u64,
    files: u64,
    dirs: u64,
    incomplete: bool,
    reason: String,
    ms: u64,
    tree: Node,
}
fn is_zero(value: &u8) -> bool {
    *value == 0
}
struct ScanState {
    incomplete: bool,
    reason: &'static str,
}
struct Ctx {
    bytes: AtomicU64,
    files: AtomicU64,
    dirs: AtomicU64,
    state: Mutex<ScanState>,
    max_depth: u32,
    keep: usize,
    deadline: Instant,
    started: Instant,
    last_ms: AtomicU64,
    /// 還能再借的執行緒數，含主執行緒。初值就是額度。
    permits: AtomicUsize,
}
struct Slot<'a>(&'a Ctx);
impl Drop for Slot<'_> {
    fn drop(&mut self) {
        self.0.permits.fetch_add(1, Ordering::Release);
    }
}
fn emit_line(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = write!(out, "{line}\n");
    let _ = out.flush();
}
fn dir_node(name: String, c: Vec<Node>, s: u64, f: u64, truncated: bool) -> Node {
    Node { n: name, s, f, k: "d".to_string(), c, t: u8::from(truncated), collapsed: 0 }
}
fn file_node(name: String, size: u64) -> Node {
    Node { n: name, s: size, f: 1, k: "f".to_string(), c: Vec::new(), t: 0, collapsed: 0 }
}
fn other_node(count: u64, s: u64, f: u64) -> Node {
    Node { n: format!("（其他 {count} 項）"), s, f, k: "o".to_string(), c: Vec::new(), t: 0, collapsed: count }
}
fn sum_field(nodes: &[Node], field: impl Fn(&Node) -> u64) -> u64 {
    nodes.iter().fold(0, |acc, node| acc.saturating_add(field(node)))
}
fn by_size(nodes: &mut [Node]) {
    nodes.sort_by(|a, b| b.s.cmp(&a.s).then_with(|| a.n.cmp(&b.n)));
}
/// 只留前 `keep` 個。有併掉的話回傳 true，呼叫端標 `t:1`。
fn trim_keep(mut children: Vec<Node>, keep: usize) -> (Vec<Node>, bool) {
    by_size(&mut children);
    if children.len() <= keep {
        return (children, false);
    }
    let rest = children.split_off(keep);
    let other = other_node(rest.len() as u64, sum_field(&rest, |n| n.s), sum_field(&rest, |n| n.f));
    children.push(other);
    by_size(&mut children);
    (children, true)
}
/// 子項小於整棵樹的 1/20000 就併進「其他」。`threshold` 是根目錄總量除出來的。
fn apply_threshold(node: &mut Node, threshold: u64) {
    if node.k != "d" || node.c.is_empty() {
        return;
    }
    let mut kept = Vec::new();
    let mut other_s = 0u64;
    let mut other_f = 0u64;
    let mut other_n = 0u64;
    for mut child in std::mem::take(&mut node.c) {
        if child.k == "o" {
            other_s = other_s.saturating_add(child.s);
            other_f = other_f.saturating_add(child.f);
            other_n = other_n.saturating_add(child.collapsed.max(1));
            continue;
        }
        if child.s < threshold {
            other_s = other_s.saturating_add(child.s);
            other_f = other_f.saturating_add(child.f);
            other_n = other_n.saturating_add(1);
            continue;
        }
        apply_threshold(&mut child, threshold);
        kept.push(child);
    }
    if other_n > 0 {
        kept.push(other_node(other_n, other_s, other_f));
        node.t = 1;
    }
    by_size(&mut kept);
    node.c = kept;
}
fn lock<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}
fn thread_budget() -> usize {
    thread::available_parallelism().map(|n| n.get()).unwrap_or(1).clamp(1, MAX_THREADS)
}
fn try_acquire(ctx: &Ctx) -> bool {
    ctx.permits
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |cur| cur.checked_sub(1))
        .is_ok()
}
impl Ctx {
    fn new(max_depth: u32, keep: usize, started: Instant, max_ms: u64, budget: usize) -> Self {
        let budget = budget.clamp(1, MAX_THREADS);
        Self {
            bytes: AtomicU64::new(0),
            files: AtomicU64::new(0),
            dirs: AtomicU64::new(0),
            state: Mutex::new(ScanState { incomplete: false, reason: "" }),
            max_depth,
            keep,
            deadline: started + Duration::from_millis(max_ms),
            started,
            last_ms: AtomicU64::new(0),
            permits: AtomicUsize::new(budget),
        }
    }
    fn timed_out(&self) -> bool {
        if Instant::now() <= self.deadline {
            return false;
        }
        let mut state = lock(&self.state);
        state.incomplete = true;
        state.reason = "time";
        true
    }
    fn mark(&self, reason: &'static str) {
        let mut state = lock(&self.state);
        state.incomplete = true;
        if state.reason.is_empty() {
            state.reason = reason;
        }
    }
    /// 200ms 內只有搶到 CAS 的那一條執行緒印。stdout 鎖住後一次寫整行。
    fn progress(&self) {
        let now = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let prev = self.last_ms.load(Ordering::Relaxed);
        if now.saturating_sub(prev) < PROGRESS_MS {
            return;
        }
        if self.last_ms.compare_exchange(prev, now, Ordering::AcqRel, Ordering::Relaxed).is_err() {
            return;
        }
        emit_line(&format!(
            "P {} {} {}",
            self.bytes.load(Ordering::Relaxed),
            self.files.load(Ordering::Relaxed),
            self.dirs.load(Ordering::Relaxed),
        ));
    }
    fn add_file(&self, size: u64) {
        self.bytes.fetch_add(size, Ordering::Relaxed);
        self.files.fetch_add(1, Ordering::Relaxed);
    }
    fn add_dir(&self) {
        self.dirs.fetch_add(1, Ordering::Relaxed);
    }
    fn outcome(&self) -> (bool, String) {
        let state = lock(&self.state);
        (state.incomplete, state.reason.to_string())
    }
}
struct Gate {
    name: String,
    depth: u32,
    rollup: bool,
    parent: Option<Arc<Gate>>,
    file_nodes: Mutex<Vec<Node>>,
    sub_nodes: Mutex<Vec<Node>>,
    sum_bytes: AtomicU64,
    sum_files: AtomicU64,
    any: AtomicBool,
    cut: AtomicBool,
    /// 還沒做完的子資料夾數。歸零的那一條執行緒負責收成節點。
    left: AtomicUsize,
}
struct Task {
    path: PathBuf,
    gate: Arc<Gate>,
}
struct Shared {
    queue: Vec<Task>,
    out: Option<std::io::Result<Node>>,
}
struct Pool {
    shared: Mutex<Shared>,
    wait: Condvar,
}
fn gate(name: String, depth: u32, rollup: bool, parent: Option<Arc<Gate>>) -> Arc<Gate> {
    Arc::new(Gate {
        name, depth, rollup, parent,
        file_nodes: Mutex::new(Vec::new()), sub_nodes: Mutex::new(Vec::new()),
        sum_bytes: AtomicU64::new(0), sum_files: AtomicU64::new(0),
        any: AtomicBool::new(false), cut: AtomicBool::new(false), left: AtomicUsize::new(0),
    })
}
fn push_tasks(pool: &Pool, tasks: Vec<Task>) {
    if tasks.is_empty() { return; }
    lock(&pool.shared).queue.extend(tasks);
    pool.wait.notify_all();
}
fn pop_task(pool: &Pool) -> Option<Task> {
    let mut shared = lock(&pool.shared);
    loop {
        if let Some(task) = shared.queue.pop() {
            return Some(task);
        }
        if shared.out.is_some() {
            return None;
        }
        shared = pool.wait.wait(shared).unwrap_or_else(|err| err.into_inner());
    }
}
fn finish_root(pool: &Pool, result: std::io::Result<Node>) {
    lock(&pool.shared).out = Some(result);
    pool.wait.notify_all();
}
fn finish_dir(name: String, children: Vec<Node>, keep: usize, cut: bool) -> Node {
    let (children, trimmed) = trim_keep(children, keep);
    let bytes = sum_field(&children, |node| node.s);
    let files = sum_field(&children, |node| node.f);
    dir_node(name, children, bytes, files, cut || trimmed)
}
fn make_node(ctx: &Ctx, gate: &Gate) -> Node {
    if gate.rollup {
        let trunc = gate.any.load(Ordering::Relaxed) || gate.cut.load(Ordering::Relaxed);
        return dir_node(
            gate.name.clone(),
            Vec::new(),
            gate.sum_bytes.load(Ordering::Relaxed),
            gate.sum_files.load(Ordering::Relaxed),
            trunc,
        );
    }
    let mut children = std::mem::take(&mut *lock(&gate.file_nodes));
    children.extend(std::mem::take(&mut *lock(&gate.sub_nodes)));
    finish_dir(gate.name.clone(), children, ctx.keep, gate.cut.load(Ordering::Relaxed))
}
fn finalize(ctx: &Ctx, pool: &Pool, mut gate: Arc<Gate>) {
    loop {
        let node = make_node(ctx, &gate);
        let Some(parent) = gate.parent.clone() else {
            finish_root(pool, Ok(node));
            return;
        };
        if parent.rollup {
            parent.sum_bytes.fetch_add(node.s, Ordering::Relaxed);
            parent.sum_files.fetch_add(node.f, Ordering::Relaxed);
        } else {
            lock(&parent.sub_nodes).push(node);
        }
        if parent.left.fetch_sub(1, Ordering::AcqRel) != 1 {
            return;
        }
        gate = parent;
    }
}
struct Listed {
    files: Vec<Node>,
    subs: Vec<(String, PathBuf)>,
    sum_bytes: u64,
    sum_files: u64,
    any: bool,
    cut: bool,
}
struct Raw {
    name: String,
    path: PathBuf,
    dir: bool,
    len: u64,
}
fn read_raw(path: &Path) -> std::io::Result<(Vec<Raw>, bool)> {
    let mut items = Vec::new();
    let mut failed = false;
    for entry in std::fs::read_dir(path)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => { failed = true; continue; }
        };
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => { failed = true; continue; }
        };
        if meta.file_type().is_symlink() { continue; }
        let name = entry.file_name().to_string_lossy().into_owned();
        if meta.is_dir() {
            items.push(Raw { name, path: entry.path(), dir: true, len: 0 });
        } else {
            items.push(Raw { name, path: PathBuf::new(), dir: false, len: meta.len() });
        }
    }
    Ok((items, failed))
}
fn absorb(ctx: &Ctx, items: Vec<Raw>, failed: bool, rollup: bool) -> Listed {
    let mut out = Listed { files: Vec::new(), subs: Vec::new(), sum_bytes: 0, sum_files: 0, any: failed, cut: false };
    if failed { ctx.mark("read"); }
    for item in items {
        if ctx.timed_out() { out.cut = true; out.any = true; break; }
        out.any = true;
        if item.dir {
            ctx.add_dir();
            out.subs.push((item.name, item.path));
        } else {
            ctx.add_file(item.len);
            if rollup {
                out.sum_bytes = out.sum_bytes.saturating_add(item.len);
                out.sum_files += 1;
                ctx.progress();
            } else {
                out.files.push(file_node(item.name, item.len));
            }
        }
        if !rollup { ctx.progress(); }
    }
    out
}
/// 列舉放在另一條執行緒。超過 8 秒沒回來就放棄，呼叫端當成讀取失敗，不把掃描執行緒卡住。
fn list_bounded(ctx: &Ctx, path: &Path, rollup: bool) -> std::io::Result<Listed> {
    let (tx, rx) = std::sync::mpsc::channel();
    let owned = path.to_path_buf();
    thread::spawn(move || { let _ = tx.send(read_raw(&owned)); });
    match rx.recv_timeout(Duration::from_millis(STUCK_MS)) {
        Ok(Ok((items, failed))) => Ok(absorb(ctx, items, failed, rollup)),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "read")),
    }
}
fn fail_gate(ctx: &Ctx, pool: &Pool, gate: Arc<Gate>) {
    ctx.mark("read");
    gate.cut.store(true, Ordering::Relaxed);
    gate.any.store(true, Ordering::Relaxed);
    finalize(ctx, pool, gate);
}
fn expand(ctx: &Ctx, pool: &Pool, task: Task) {
    if task.gate.depth > 0 && ctx.timed_out() {
        task.gate.cut.store(true, Ordering::Relaxed);
        finalize(ctx, pool, task.gate);
        return;
    }
    let listed = match list_bounded(ctx, &task.path, task.gate.rollup) {
        Ok(listed) => listed,
        Err(err) if task.gate.depth == 0 => { finish_root(pool, Err(err)); return; }
        Err(_) => { fail_gate(ctx, pool, task.gate); return; }
    };
    task.gate.cut.store(listed.cut, Ordering::Relaxed);
    task.gate.any.store(listed.any, Ordering::Relaxed);
    task.gate.sum_bytes.store(listed.sum_bytes, Ordering::Relaxed);
    task.gate.sum_files.store(listed.sum_files, Ordering::Relaxed);
    *lock(&task.gate.file_nodes) = listed.files;
    let n = listed.subs.len();
    task.gate.left.store(n, Ordering::Release);
    if n == 0 { finalize(ctx, pool, task.gate); return; }
    let depth = task.gate.depth;
    let mut tasks = Vec::with_capacity(n);
    for (name, path) in listed.subs {
        let child = gate(name, depth + 1, depth + 1 > ctx.max_depth, Some(Arc::clone(&task.gate)));
        tasks.push(Task { path, gate: child });
    }
    push_tasks(pool, tasks);
}
fn worker(ctx: &Ctx, pool: &Pool) {
    while let Some(task) = pop_task(pool) { expand(ctx, pool, task); }
}
fn run_pool(ctx: &Ctx, root: &Path, name: String) -> std::io::Result<Node> {
    let pool = Pool { shared: Mutex::new(Shared { queue: Vec::new(), out: None }), wait: Condvar::new() };
    let pool = &pool;
    push_tasks(pool, vec![Task { path: root.to_path_buf(), gate: gate(name, 0, false, None) }]);
    let _main = try_acquire(ctx).then(|| Slot(ctx));
    thread::scope(|scope| {
        while try_acquire(ctx) {
            scope.spawn(move || {
                let _slot = Slot(ctx);
                worker(ctx, pool);
            });
        }
        worker(ctx, pool);
    });
    match lock(&pool.shared).out.take() {
        Some(result) => result,
        None => Err(std::io::Error::other("read")),
    }
}
fn build_with(
    root: &Path,
    max_ms: u64,
    max_depth: u32,
    keep: usize,
    budget: usize,
) -> std::io::Result<Report> {
    let started = Instant::now();
    let ctx = Ctx::new(max_depth, keep, started, max_ms, budget);
    let name = root.to_string_lossy().into_owned();
    let mut tree = run_pool(&ctx, root, name.clone())?;
    let threshold = tree.s / RELATIVE;
    apply_threshold(&mut tree, threshold);
    let (incomplete, reason) = ctx.outcome();
    Ok(Report {
        root: name,
        bytes: ctx.bytes.load(Ordering::Relaxed),
        files: ctx.files.load(Ordering::Relaxed),
        dirs: ctx.dirs.load(Ordering::Relaxed),
        incomplete,
        reason,
        ms: walk_ms(started),
        tree,
    })
}
fn build(root: &Path, max_ms: u64, max_depth: u32, keep: usize) -> std::io::Result<Report> {
    build_with(root, max_ms, max_depth, keep, thread_budget())
}
fn walk_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
pub fn run(args: &[String]) -> i32 {
    let [root, max_ms, max_depth, keep] = args else {
        eprintln!("usage: voiceink-probe disk-tree <path> <maxMs> <maxDepth> <keep>");
        return 2;
    };
    let max_ms = max_ms.parse().unwrap_or(180_000);
    let max_depth = max_depth.parse().unwrap_or(12);
    let keep = keep.parse().unwrap_or(200);
    match build(Path::new(root), max_ms, max_depth, keep) {
        Ok(report) => match serde_json::to_string(&report) {
            Ok(json) => emit_line(&format!("J {json}")),
            Err(_) => emit_line("E read"),
        },
        Err(_) => emit_line("E read"),
    }
    0
}
#[cfg(test)]
mod tests {
    use super::*;
    fn file(name: &str, size: u64) -> Node {
        file_node(name.to_string(), size)
    }
    fn bundled(name: &str, children: Vec<Node>) -> Node {
        let bytes = sum_field(&children, |node| node.s);
        let files = sum_field(&children, |node| node.f);
        dir_node(name.to_string(), children, bytes, files, false)
    }
    #[test]
    fn keep_merges_the_rest_into_other() {
        let nodes = vec![file("a", 10), file("b", 40), file("c", 30), file("d", 20), file("e", 50)];
        let (out, truncated) = trim_keep(nodes, 2);
        assert!(truncated);
        assert_eq!(out.len(), 3);
        // 被併掉的三項加起來比留下的最大檔還大，所以「其他」排最前面
        assert_eq!(out[0].k, "o");
        assert_eq!(out[0].n, "（其他 3 項）");
        assert_eq!(out[0].s, 60);
        assert_eq!(out[0].f, 3);
        assert_eq!(out[1].n, "e");
        assert_eq!(out[1].s, 50);
        assert_eq!(out[2].n, "b");
        assert_eq!(sum_field(&out, |node| node.s), 150);
    }
    #[test]
    fn other_can_outrank_a_kept_item() {
        let (out, truncated) = trim_keep(vec![file("a", 100), file("b", 80), file("c", 70)], 1);
        assert!(truncated);
        assert_eq!(out[0].n, "（其他 2 項）");
        assert_eq!(out[0].s, 150);
        assert_eq!(out[1].n, "a");
    }
    #[test]
    fn threshold_merges_dust_into_other() {
        let mut root = bundled("root", vec![file("big", 2_000_000), file("mid", 150), file("dust", 10)]);
        let threshold = root.s / RELATIVE;
        apply_threshold(&mut root, threshold);
        assert_eq!(root.t, 1);
        assert_eq!(root.c.len(), 3);
        assert_eq!(root.c[0].n, "big");
        assert_eq!(root.c[1].n, "mid");
        assert_eq!(root.c[2].n, "（其他 1 項）");
        assert_eq!(root.c[2].s, 10);
        assert_eq!(root.c[2].f, 1);
        assert_eq!(sum_field(&root.c, |node| node.s), root.s);
    }
    #[test]
    fn threshold_absorbs_an_existing_other() {
        let mut root = bundled(
            "root",
            vec![file("big", 2_000_000), file("dust", 10), other_node(3, 30, 3)],
        );
        root.s = sum_field(&root.c, |node| node.s);
        let threshold = root.s / RELATIVE;
        apply_threshold(&mut root, threshold);
        assert_eq!(root.c.len(), 2);
        assert_eq!(root.c[0].n, "big");
        assert_eq!(root.c[1].n, "（其他 4 項）");
        assert_eq!(root.c[1].s, 40);
        assert_eq!(root.c[1].f, 4);
        assert_eq!(root.t, 1);
    }
    #[test]
    fn tiny_tree_skips_the_relative_cut() {
        let mut root = bundled("root", vec![file("a", 0), file("b", 4)]);
        let threshold = root.s / RELATIVE;
        apply_threshold(&mut root, threshold);
        assert_eq!(root.t, 0);
        assert_eq!(root.c.len(), 2);
    }
    #[test]
    fn threshold_cuts_inside_a_kept_folder() {
        let sub = bundled("sub", vec![file("big", 2_000_000), file("dust", 10)]);
        let mut root = bundled("root", vec![sub]);
        let threshold = root.s / RELATIVE;
        apply_threshold(&mut root, threshold);
        assert_eq!(root.t, 0);
        assert_eq!(root.c[0].n, "sub");
        assert_eq!(root.c[0].t, 1);
        assert_eq!(root.c[0].c.len(), 2);
        assert_eq!(root.c[0].c[1].n, "（其他 1 項）");
        assert_eq!(root.c[0].s, root.s);
    }
    #[test]
    fn json_omits_empty_children_and_zero_flag() {
        assert_eq!(
            serde_json::to_string(&file("a.txt", 3)).unwrap(),
            r#"{"n":"a.txt","s":3,"f":1,"k":"f"}"#
        );
        let truncated = dir_node("sub".into(), Vec::new(), 5, 1, true);
        assert_eq!(
            serde_json::to_string(&truncated).unwrap(),
            r#"{"n":"sub","s":5,"f":1,"k":"d","t":1}"#
        );
        assert_eq!(
            serde_json::to_string(&other_node(2, 9, 2)).unwrap(),
            r#"{"n":"（其他 2 項）","s":9,"f":2,"k":"o"}"#
        );
    }
    struct Guard {
        root: PathBuf,
        outside: PathBuf,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            // 先拆連結再刪，就算遞迴刪除會跟著 junction 走，也碰不到外面那份
            let _ = std::fs::remove_dir(self.root.join("link"));
            let _ = std::fs::remove_dir_all(&self.root);
            let _ = std::fs::remove_dir_all(&self.outside);
        }
    }
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vi-disktree-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn link_to(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_dir(target, link).is_ok() {
                return true;
            }
            return std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J", &link.display().to_string(), &target.display().to_string()])
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
        }
        #[cfg(not(windows))]
        {
            let _ = (link, target);
            false
        }
    }
    #[test]
    fn walk_rolls_up_past_max_depth_and_skips_links() {
        let root = scratch("walk");
        let outside = scratch("out");
        let guard = Guard { root: root.clone(), outside: outside.clone() };
        std::fs::create_dir_all(guard.root.join("sub").join("deep")).unwrap();
        std::fs::write(guard.root.join("a.txt"), vec![1u8; 10]).unwrap();
        std::fs::write(guard.root.join("sub").join("b.txt"), vec![1u8; 20]).unwrap();
        std::fs::write(guard.root.join("sub").join("deep").join("c.txt"), vec![1u8; 30]).unwrap();
        std::fs::write(guard.outside.join("secret.bin"), vec![9u8; 5000]).unwrap();
        assert!(link_to(&guard.root.join("link"), &guard.outside), "這台機器建不起資料夾連結");
        let report = build(&guard.root, 30_000, 1, 200).unwrap();
        assert!(!report.incomplete, "{}", report.reason);
        assert_eq!(report.bytes, 60);
        assert_eq!(report.files, 3);
        assert_eq!(report.dirs, 2);
        assert_eq!(report.tree.s, 60);
        assert_eq!(report.tree.f, 3);
        assert_eq!(report.tree.n, guard.root.to_string_lossy());
        let names: Vec<&str> = report.tree.c.iter().map(|node| node.n.as_str()).collect();
        assert!(!names.contains(&"link"), "{names:?}");
        let sub = report.tree.c.iter().find(|node| node.n == "sub").unwrap();
        assert_eq!(sub.s, 50);
        assert_eq!(sub.f, 2);
        assert_eq!(sub.t, 0);
        let deep = sub.c.iter().find(|node| node.n == "deep").unwrap();
        assert_eq!(deep.t, 1);
        assert!(deep.c.is_empty());
        assert_eq!(deep.s, 30);
        assert_eq!(deep.f, 1);
    }
    #[test]
    fn walk_keep_and_threshold_show_up_in_the_tree() {
        let root = scratch("trim");
        let _guard = Guard { root: root.clone(), outside: scratch("trim-out") };
        std::fs::write(root.join("a.txt"), vec![1u8; 100]).unwrap();
        std::fs::write(root.join("b.txt"), vec![1u8; 80]).unwrap();
        std::fs::write(root.join("c.txt"), vec![1u8; 70]).unwrap();
        std::fs::write(root.join("d.txt"), vec![1u8; 60]).unwrap();
        let kept = build(&root, 30_000, 12, 2).unwrap();
        assert_eq!(kept.bytes, 310);
        assert_eq!(kept.files, 4);
        assert_eq!(kept.dirs, 0);
        assert_eq!(kept.tree.t, 1);
        assert_eq!(kept.tree.c.len(), 3);
        assert_eq!(kept.tree.c[0].n, "（其他 2 項）");
        assert_eq!(kept.tree.c[0].s, 130);
        assert_eq!(sum_field(&kept.tree.c, |node| node.s), 310);
    }
    #[test]
    fn walk_threshold_hides_dust() {
        let root = scratch("cut");
        let _guard = Guard { root: root.clone(), outside: scratch("cut-out") };
        std::fs::write(root.join("huge.bin"), vec![1u8; 2_000_000]).unwrap();
        std::fs::write(root.join("mid.bin"), vec![1u8; 150]).unwrap();
        std::fs::write(root.join("dust.bin"), vec![1u8; 10]).unwrap();
        let cut = build(&root, 30_000, 12, 200).unwrap();
        assert_eq!(cut.bytes, 2_000_160);
        assert_eq!(cut.files, 3);
        assert_eq!(cut.tree.t, 1);
        assert_eq!(cut.tree.s, cut.bytes);
        let other = cut.tree.c.iter().find(|node| node.k == "o").unwrap();
        assert_eq!(other.n, "（其他 1 項）");
        assert_eq!(other.s, 10);
        assert_eq!(other.f, 1);
        assert!(cut.tree.c.iter().any(|node| node.n == "huge.bin"));
        assert!(!cut.tree.c.iter().any(|node| node.n == "dust.bin"));
    }
    #[test]
    fn missing_root_is_an_error() {
        let missing = std::env::temp_dir().join(format!("vi-disktree-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        assert!(build(&missing, 1_000, 12, 200).is_err());
    }
    fn put_file(dir: &Path, name: &str, size: usize, bytes: &mut u64, files: &mut u64) {
        std::fs::write(dir.join(name), vec![1u8; size]).unwrap();
        *bytes += size as u64;
        *files += 1;
    }
    fn put_dir(dir: &Path, dirs: &mut u64) {
        std::fs::create_dir_all(dir).unwrap();
        *dirs += 1;
    }
    /// 寬一點的樹：同大小檔名要排序、超過深度要捲總、太小的要併進「其他」、連結不能跟著走。
    fn sample_tree(root: &Path, outside: &Path) -> (u64, u64, u64) {
        let (mut bytes, mut files, mut dirs) = (0u64, 0u64, 0u64);
        put_file(root, "a.txt", 100, &mut bytes, &mut files);
        put_file(root, "b.txt", 100, &mut bytes, &mut files);
        put_file(root, "huge.bin", 2_000_000, &mut bytes, &mut files);
        put_file(root, "dust.bin", 10, &mut bytes, &mut files);
        put_dir(&root.join("empty"), &mut dirs);
        put_dir(&root.join("sub"), &mut dirs);
        put_file(&root.join("sub"), "big.bin", 2_000_000, &mut bytes, &mut files);
        put_file(&root.join("sub"), "dust2.bin", 10, &mut bytes, &mut files);
        put_file(&root.join("sub"), "mid.bin", 5_000, &mut bytes, &mut files);
        put_dir(&root.join("sub").join("nest"), &mut dirs);
        put_dir(&root.join("sub").join("nest").join("deep"), &mut dirs);
        put_file(&root.join("sub").join("nest").join("deep"), "x.bin", 30, &mut bytes, &mut files);
        for i in 0..32 {
            let dir = root.join(format!("d{i:02}"));
            put_dir(&dir, &mut dirs);
            put_file(&dir, "f.bin", 1000 + i, &mut bytes, &mut files);
            put_dir(&dir.join("deep"), &mut dirs);
            put_file(&dir.join("deep"), "g.bin", 10, &mut bytes, &mut files);
        }
        std::fs::write(outside.join("secret.bin"), vec![9u8; 5000]).unwrap();
        (bytes, files, dirs)
    }
    fn report_json(root: &Path, budget: usize) -> String {
        let mut report = build_with(root, 30_000, 2, 200, budget).unwrap();
        assert!(!report.incomplete, "{}", report.reason);
        report.ms = 0;
        serde_json::to_string(&report).unwrap()
    }
    #[test]
    fn parallel_matches_single_thread_json() {
        let root = scratch("par");
        let outside = scratch("par-out");
        let guard = Guard { root: root.clone(), outside: outside.clone() };
        let (bytes, files, dirs) = sample_tree(&guard.root, &guard.outside);
        assert!(link_to(&guard.root.join("link"), &guard.outside), "這台機器建不起資料夾連結");
        let single = build_with(&guard.root, 30_000, 2, 200, 1).unwrap();
        assert!(!single.incomplete, "{}", single.reason);
        assert_eq!(single.bytes, bytes);
        assert_eq!(single.files, files);
        assert_eq!(single.dirs, dirs);
        assert_eq!(single.tree.s, bytes);
        assert!(!single.tree.c.iter().any(|node| node.n == "link"));
        let left = report_json(&guard.root, 1);
        for _ in 0..4 {
            assert_eq!(left, report_json(&guard.root, 16), "平行掃出來的 JSON 跟額度 1 不同");
        }
    }
}