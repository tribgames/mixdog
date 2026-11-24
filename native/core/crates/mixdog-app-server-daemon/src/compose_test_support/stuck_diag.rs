//! What a composed test's child or process says of its threads when it does not end.

use std::time::{Duration, Instant};

use super::kill_failure;

/// Of the run's time, what reading a stuck child's threads may take.
pub(super) const THREADS_SHARE: u64 = 25;

/// Of a sampler's output, what is kept and printed (of each of its two streams); the rest is read and dropped. A composed core's
/// sample ran to 165 KiB on the macOS runner (release gate run 44959677392), and the threads cut off were the ones started last.
const THREADS_EXCERPT: usize = 512 * 1024;

/// What a reader has of one stream so far.
#[derive(Default)]
struct Excerpt {
    kept: Vec<u8>,
    dropped: usize,
    ended: bool,
}

/// Reads `stream` on a thread of its own, keeping its first [`THREADS_EXCERPT`] bytes and dropping the rest, so its writer is never held.
/// Nobody waits for the thread: what it has is read from the shared excerpt at any time, and a stream something keeps open leaves the
/// thread to end with the process.
#[allow(clippy::disallowed_methods, reason = "test harness: a reader thread for a helper's pipe")]
fn excerpt(stream: Option<impl std::io::Read + Send + 'static>) -> std::sync::Arc<std::sync::Mutex<Excerpt>> {
    let shared = std::sync::Arc::new(std::sync::Mutex::new(Excerpt::default()));
    let reader = shared.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        if let Some(mut stream) = stream {
            while let Ok(read) = stream.read(&mut buf) {
                if read == 0 {
                    break;
                }
                let mut excerpt = reader.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                let take = read.min(THREADS_EXCERPT - excerpt.kept.len());
                excerpt.kept.extend_from_slice(&buf[..take]);
                excerpt.dropped += read - take;
            }
        }
        reader.lock().unwrap_or_else(std::sync::PoisonError::into_inner).ended = true;
    });
    shared
}

/// What `program` says, each stream cut to its excerpt. Everything ends at `deadline`: a sampler still running is sent its kill and not
/// waited for, a stream still open (a process the sampler started may hold it) is left to its reader, and what was read by then is
/// returned with a note that it is not all. Used on a child the runner supervises, and by a process on itself from a thread of its
/// own ([`threads_of_self`]): the sampler is another process, and what it stops of this one it stops only while it reads the stacks.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test harness: runs the system's own sampler on a child of the runner")]
fn sampled(program: &str, args: &[&str], deadline: Instant) -> String {
    let mut command = std::process::Command::new(program);
    command.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut sampler = match command.spawn() {
        Ok(sampler) => sampler,
        Err(error) => return format!("{program} did not start: {error}\n"),
    };
    let streams = [excerpt(sampler.stdout.take()), excerpt(sampler.stderr.take())];
    let read = |stream: &std::sync::Mutex<Excerpt>| {
        let excerpt = stream.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let dropped = if excerpt.dropped > 0 { format!("\n[{} more bytes not shown]\n", excerpt.dropped) } else { String::new() };
        (format!("{}{dropped}", String::from_utf8_lossy(&excerpt.kept)), excerpt.ended)
    };
    let mut exited = false;
    loop {
        exited = exited || !matches!(sampler.try_wait(), Ok(None));
        let all_read = streams.iter().all(|stream| read(stream).1);
        if (exited && all_read) || Instant::now() >= deadline {
            let mut text: String = streams.iter().map(|stream| read(stream).0).collect();
            if !exited {
                text.push_str(&format!("[{program} was still running at its deadline and was sent its kill{}]\n", kill_failure(sampler.kill())));
                // Reaped if it has ended by now; never waited for.
                let _ = sampler.try_wait();
            }
            if !all_read {
                text.push_str(&format!("[{program}'s output was still open at its deadline: the above is not all of it]\n"));
            }
            return text;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// What the threads of the runner's child `pid` are doing, when it does not end: on macOS the call stacks `sample` reads over two seconds; on
/// Linux the summary of [`thread_summary`], then `gdb`'s stacks where one is installed. `None` on Windows, whose runs showed no such
/// child. Until `deadline`; the samplers' output is cut to an excerpt.
pub(super) fn threads_of_child(pid: u32, deadline: Instant) -> Option<String> {
    let id = pid.to_string();
    if cfg!(target_os = "macos") {
        return Some(sampled("/usr/bin/sample", &[id.as_str(), "2", "-mayDie"], deadline));
    }
    let mut text = thread_summary(pid)?;
    text.push_str(&sampled("gdb", &["-batch", "-p", id.as_str(), "-ex", "thread apply all bt 40"], deadline));
    Some(text)
}

/// What the threads of this process are doing, read by itself: on macOS the call stacks `sample` reads, on Linux the summary of
/// [`thread_summary`] (nothing is attached to a process by its own child). `None` on Windows. Until `deadline`.
///
/// `sample` reads for one second with ten milliseconds of run time between two samples, and without `-mayDie`: a thread that does
/// not end is in every sample, and the process does not end by itself (a kill takes this output with it either way). With two
/// seconds at one millisecond and the symbols taken first, three tests sampled at once had only the sampler's first line
/// after 25 s (release gate run 45099074939, macos 3/3); one alone, its process at 23.3 GB, ended in time with 1 325 samples
/// (macos 2/3).
pub(super) fn threads_of_self(deadline: Instant) -> Option<String> {
    let pid = std::process::id();
    if cfg!(target_os = "macos") {
        return Some(sampled("/usr/bin/sample", &[pid.to_string().as_str(), "1", "10"], deadline));
    }
    thread_summary(pid)
}

/// Linux: each thread of the process `pid` by name, state and the number of the system call it is in (`/proc/<pid>/task`), like ones
/// counted together. It attaches to nothing and starts nothing, so a process may read its own. `None` elsewhere.
#[allow(clippy::disallowed_methods, reason = "test harness: reads procfs")]
fn thread_summary(pid: u32) -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let mut threads = std::collections::BTreeMap::<String, usize>::new();
    for task in std::fs::read_dir(format!("/proc/{pid}/task")).into_iter().flatten().flatten() {
        let read = |name: &str| std::fs::read_to_string(task.path().join(name)).unwrap_or_default();
        let stat = read("stat");
        // The state letter follows the name, which may itself hold spaces and brackets.
        let state = stat.rsplit_once(") ").and_then(|(_, rest)| rest.split(' ').next()).unwrap_or("?").to_owned();
        let syscall = read("syscall").split_whitespace().next().unwrap_or("?").to_owned();
        *threads.entry(format!("{} state={state} syscall={syscall}", read("comm").trim())).or_default() += 1;
    }
    Some(threads.iter().map(|(thread, count)| format!("{count} x {thread}\n")).collect())
}

/// For a composed test outside the runner (nextest alone bounds it): when its process still runs `after` this call, the summary of its
/// threads goes to stderr ([`thread_summary`]: Linux only, nothing attached), once. Under nextest only, where the process is the one test's.
/// On macOS, where such tests did not end, the body and runtime lines of [`on_marked_runtime`] are what a timeout leaves.
#[allow(clippy::disallowed_methods, reason = "test harness: a thread of its own, which the wait it reports on cannot hold")]
pub(crate) fn report_threads_if_still_running(after: Duration) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    if std::env::var_os("NEXTEST").is_none() {
        return;
    }
    STARTED.call_once(|| {
        std::thread::spawn(move || {
            std::thread::sleep(after);
            if let Some(threads) = thread_summary(std::process::id()) {
                eprintln!("[stuck-diag] the test's process still runs {after:?} after it composed; its threads:\n{threads}");
            }
        });
    });
}
