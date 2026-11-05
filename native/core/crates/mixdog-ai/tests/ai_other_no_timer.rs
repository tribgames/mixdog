//! No content timer exists in the Devin, Cursor, Grok, local and custom
//! providers or the Connect plumbing under them (SPEC §4.9): a response ends
//! by transport facts only. The one deadline in the family is the Cursor client
//! heartbeat, a frame the protocol requires the client to send; it runs on the
//! core ticker and never ends or restarts anything.
#![allow(clippy::disallowed_methods, reason = "a test reads its fixture files directly")]

use std::path::Path;
use std::path::PathBuf;

const FAMILY: [&str; 6] = ["connect", "cursor", "devin", "grok", "local", "custom"];
const FORBIDDEN: [&str; 6] = ["tokio::time", "sleep(", "timeout(", "Instant::now", "interval(", "interval_at("];
/// The protocol heartbeat of the Cursor stream.
const HEARTBEAT_FILE: &str = "cursor/mod.rs";
/// The heartbeat's next deadline is computed from the wall clock.
const HEARTBEAT_WORD: &str = "Instant::now";

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// The text before the file's unit tests: tests may pace themselves.
fn product_code(text: &str) -> &str {
    text.split("#[cfg(test)]").next().unwrap_or(text)
}

#[test]
fn no_timer_decides_when_a_response_ends() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/providers");
    let mut offenders = Vec::new();
    for family in FAMILY {
        let mut files = Vec::new();
        sources(&root.join(family), &mut files);
        for file in files {
            let relative = file.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
            let text = std::fs::read_to_string(&file).unwrap();
            let code = product_code(&text);
            for word in FORBIDDEN {
                // Field names of the wire (`timeout` of a shell call, an exec deadline) are not clocks.
                let hit = code.lines().any(|l| !l.trim_start().starts_with("//") && l.contains(word));
                let allowed = relative == HEARTBEAT_FILE && word == HEARTBEAT_WORD;
                if hit && !allowed {
                    offenders.push(format!("{relative}: {word}"));
                }
            }
        }
    }
    assert!(offenders.is_empty(), "timers in the provider family: {offenders:?}");
}
