// Unix-only (symlinks); the watcher test is Linux-only because inotify is the
// backend that registers a followed symlink's target inode under the link
// spelling.
#![cfg(unix)]
use super::*;
use std::os::unix::fs::symlink;
use std::sync::atomic::AtomicUsize;

/// A unique scratch directory (pid + counter) removed on drop, so a failing
/// assertion cannot leave it behind.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "mg-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn symlink_signatures_are_not_cached_under_the_link_path() {
    let scratch = Scratch::new("link-signature");
    let root = scratch.0.join("root");
    let outside = scratch.0.join("outside.txt");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(&outside, "alpha beta\n").unwrap();
    let link = root.join("link.txt");
    symlink(&outside, &link).unwrap();
    let plain = root.join("plain.txt");
    std::fs::write(&plain, "alpha beta\n").unwrap();

    let mut signature = TrigramSignature::new();
    signature.push(b"alpha beta\n");
    signature.complete = true;
    remember_content_signature(&link, &signature, None);
    remember_content_signature(&plain, &signature, None);

    let trust = TrustSnapshot {
        usn_volumes: Arc::new(HashSet::new()),
        watch_roots: Arc::new(vec![root]),
    };
    let required = vec![b"alpha"
        .windows(3)
        .map(|window| trigram_bits(window[0], window[1], window[2]))
        .collect::<Vec<_>>()];
    // Control: a regular file under the watched root is still cached.
    assert_eq!(
        cached_signature_state(&plain, &required, false, &trust),
        CachedSignatureState::Reusable
    );
    // The target can change with no event under the watched root, so the
    // trusted cache must hold nothing for the link.
    assert_eq!(
        cached_signature_state(&link, &required, false, &trust),
        CachedSignatureState::Missing
    );
}

#[test]
fn signatures_below_a_symlinked_directory_are_not_cached() {
    let scratch = Scratch::new("dir-link-signature");
    let root = scratch.0.join("root");
    let external = scratch.0.join("external");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&external).unwrap();
    let target = external.join("file.txt");
    std::fs::write(&target, "alpha beta\n").unwrap();
    symlink(&external, root.join("dir-link")).unwrap();
    let through_link = root.join("dir-link").join("file.txt");

    // Search the operand: a complete signature of the old content is built.
    let mut signature = TrigramSignature::new();
    signature.push(b"alpha beta\n");
    signature.complete = true;
    remember_content_signature(&through_link, &signature, None);

    // The target changes outside the watched root; the watcher reports nothing.
    std::fs::write(&target, "alpha gamma, changed\n").unwrap();

    let trust = TrustSnapshot {
        usn_volumes: Arc::new(HashSet::new()),
        watch_roots: Arc::new(vec![root]),
    };
    let required = vec![b"gamma"
        .windows(3)
        .map(|window| trigram_bits(window[0], window[1], window[2]))
        .collect::<Vec<_>>()];
    // Reusing the old signature would exclude "gamma" and hide the new match.
    assert_eq!(
        cached_signature_state(&through_link, &required, false, &trust),
        CachedSignatureState::Missing
    );
}

#[cfg(target_os = "linux")]
#[test]
fn watcher_does_not_report_events_through_symlinked_directories() {
    use super::watch::new_watcher;
    use std::sync::mpsc;

    let scratch = Scratch::new("watch-links");
    let base = scratch.0.clone();
    let root = base.join("root");
    let outside = base.join("outside");
    std::fs::create_dir_all(root.join("real")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    symlink(root.join("real"), root.join("inner-link")).unwrap();
    symlink(&outside, root.join("outer-link")).unwrap();

    let (tx, rx) = mpsc::channel();
    let mut watcher = new_watcher(move |event: notify::Result<notify::Event>| {
        let _ = tx.send(event);
    })
    .unwrap();
    watcher.watch(&root, RecursiveMode::Recursive).unwrap();

    std::fs::write(outside.join("outside.txt"), "x\n").unwrap();
    std::fs::write(root.join("real").join("real.txt"), "x\n").unwrap();
    // inotify delivers in order, so the sentinel proves the earlier writes
    // were already reported (or never will be).
    let sentinel = root.join("sentinel.txt");
    std::fs::write(&sentinel, "x\n").unwrap();

    let mut seen = Vec::new();
    loop {
        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("sentinel event")
            .unwrap();
        let done = event.paths.contains(&sentinel);
        seen.extend(event.paths);
        if done {
            break;
        }
    }
    // The real directory's own event must arrive under its walked spelling.
    assert!(
        seen.contains(&root.join("real").join("real.txt")),
        "no event for real/real.txt in {seen:?}"
    );
    for path in &seen {
        assert!(
            !path.starts_with(root.join("inner-link"))
                && !path.starts_with(root.join("outer-link")),
            "event reported through a symlinked directory: {}",
            path.display()
        );
    }
}
