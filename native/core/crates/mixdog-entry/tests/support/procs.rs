//! The process table, for the tests that assert which programs a run started.
#![allow(dead_code, reason = "each test uses the part it needs")]
#![allow(clippy::disallowed_methods, reason = "the test reads the process table")]

/// Every live process as (pid, parent pid, image name).
#[cfg(windows)]
pub fn all() -> Vec<(u32, u32, String)> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::PROCESSENTRY32W;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32FirstW;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::Process32NextW;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::TH32CS_SNAPPROCESS;
    let mut found = Vec::new();
    // SAFETY: the snapshot handle is checked and closed; the entry is sized as the API requires.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        assert!(snapshot != INVALID_HANDLE_VALUE, "a process snapshot");
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = u32::try_from(std::mem::size_of::<PROCESSENTRY32W>()).unwrap();
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            found.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..end])));
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    found
}

/// Every live process as (pid, parent pid, image name), from `/proc`.
#[cfg(unix)]
pub fn all() -> Vec<(u32, u32, String)> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
        // `pid (name) state ppid ...`: the name may hold spaces and parentheses, so it is cut at the last `)`.
        let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else { continue };
        let parent = stat[close + 1..].split_whitespace().nth(1).and_then(|ppid| ppid.parse::<u32>().ok()).unwrap_or(0);
        found.push((pid, parent, stat[open + 1..close].to_owned()));
    }
    found
}

/// The processes below `root` (children, their children, ...), as (pid, image name).
pub fn descendants(root: u32) -> Vec<(u32, String)> {
    let table = all();
    let mut below: Vec<(u32, String)> = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for (pid, ppid, name) in &table {
            if *ppid == parent && *pid != root && !below.iter().any(|(seen, _)| seen == pid) {
                below.push((*pid, name.clone()));
                frontier.push(*pid);
            }
        }
    }
    below
}

/// Whether an image name is Node or Electron.
pub fn is_node_or_electron(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    stem == "node" || stem == "nodejs" || stem.starts_with("electron")
}

/// A watcher that records, every 25 ms until it is stopped, each Node or Electron image among the descendants of a process.
pub struct Watch {
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Watch {
    pub fn start(root: u32) -> Self {
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen: std::sync::Arc<std::sync::Mutex<Vec<String>>> = std::sync::Arc::default();
        let (flag, found) = (stop.clone(), seen.clone());
        let thread = std::thread::spawn(move || {
            while !flag.load(std::sync::atomic::Ordering::SeqCst) {
                for (_, name) in descendants(root) {
                    if is_node_or_electron(&name) {
                        found.lock().unwrap().push(name);
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        });
        Self { stop, seen, thread: Some(thread) }
    }

    /// Stops watching; the Node and Electron images that were seen.
    pub fn finish(mut self) -> Vec<String> {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
        let mut seen = std::mem::take(&mut *self.seen.lock().unwrap());
        seen.sort();
        seen.dedup();
        seen
    }
}
