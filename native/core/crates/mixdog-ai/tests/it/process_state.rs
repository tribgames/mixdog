//! Every process-wide value of the crate is either put back by `reset_process_state` (`src/lib.rs`), which a replay of
//! a recording Node made in a fresh process starts with, or named here with the reason it needs no reset. A compiled
//! pattern (`Regex`/`JsRegex` behind a once-cell, nothing mutable) is no state and needs no entry.
#![allow(clippy::disallowed_methods, reason = "a test reads the crate's sources directly")]

use std::path::Path;
use std::path::PathBuf;

enum Verdict {
    /// Put back by this call, which `reset_process_state` makes (directly or in `providers::anthropic::reset_process_state`).
    Reset(&'static str),
    /// No state: built once from constants, or a cache whose hit equals a recompute.
    NotState(&'static str),
    /// State a replay must not reset, and why.
    Survives(&'static str),
}
use Verdict::*;

const VALUES: &[(&str, &str, Verdict)] = &[
    ("providers/anthropic/adapter.rs", "GZIP_LATCHED", Reset("adapter::reset_gzip_latch()")),
    ("providers/anthropic/fast_mode.rs", "PROCESS", Reset("fast_mode::process().clear()")),
    ("providers/anthropic/threads.rs", "PROCESS", Reset("threads::reset_process()")),
    ("providers/compat/schema.rs", "WARNED", Reset("compat::schema::reset_warned()")),
    ("providers/openai/adapter.rs", "ZSTD_LATCHED", Reset("openai::adapter::reset_zstd_latch()")),
    ("providers/google/adapter.rs", "ANNOUNCED", Reset("google::adapter::reset_announced()")),
    ("providers/google/cache/registry.rs", "SHARED", Reset("Registry::reset_shared()")),
    ("transport/preconnect.rs", "PRECONNECTED_AT", Reset("transport::preconnect::reset()")),
    ("providers/grok/mod.rs", "NUMBERED_REQUEST_IDS", Reset("providers::grok::reset_process_state()")),
    ("providers/grok/auth.rs", "DISCOVERED", Reset("providers::grok::reset_process_state()")),
    (
        "oauth/lease.rs",
        "THIS",
        Survives("this process's identity as a lease owner and the leases it holds, keyed by lock path; a lease leaves when its holder ends, and a replay's credential files are its own"),
    ),
    (
        "providers/grok/auth.rs",
        "THIS",
        Survives("this process's running Grok refreshes keyed by credential file path; an entry leaves when its refresh ends, and a replay's credential files are its own"),
    ),
    ("catalog/listing.rs", "EMPTY", NotState("an empty JSON object")),
    ("catalog/service.rs", "EMPTY", NotState("an empty JSON object")),
    ("catalog/lookup/registry.rs", "PRICING_OVERRIDES", NotState("a constant price table")),
    ("catalog/lookup/registry.rs", "CURSOR_PRICING", NotState("a constant price table")),
    ("providers/compat/ajv_meta.rs", "BUNDLE", NotState("the bundled meta-schema, parsed once")),
    ("providers/devin/families.rs", "REVIEWED", NotState("a constant family table")),
    ("providers/devin/families.rs", "REVIEWED_CLAIMS", NotState("derived from the constant family table")),
    ("providers/compat/schema.rs", "MEMO", NotState("verdicts of a pure schema check by schema text")),
    ("providers/cursor/request.rs", "SCHEMAS", NotState("verdicts of a pure schema check by schema text")),
    ("providers/compat/wire_route.rs", "COMPILED", NotState("compiled patterns by pattern text")),
    ("providers/custom/mod.rs", "IDS", NotState("interned id strings")),
    ("transport/deadlines.rs", "LABELS", NotState("interned deadline labels")),
    ("admission/settings.rs", "SETTINGS", Reset("settings::reset_process_lane_settings()")),
    ("providers/first_byte.rs", "AT_START", Reset("FirstByteSettings::reset_process()")),
    ("oauth/single_flight.rs", "FLIGHTS", Reset("single_flight::reset()")),
    ("claude_floors.rs", "UNSUPPORTED", Reset("claude_floors::reset_process()")),
    ("accounts/binding.rs", "SCOPED", NotState("task-local: the account a task runs under, gone with the task")),
    ("registry/gateway.rs", "SEND_HEADERS", NotState("task-local: the headers of one gateway send, gone with the send")),
    ("registry/gateway.rs", "REFUSAL", NotState("task-local: the refusal one routed attempt received, gone with the attempt")),
    ("work.rs", "CREDENTIAL_READS", NotState("a `count-work` measurement counter no send reads")),
    ("work.rs", "PROVIDERS_BUILT", NotState("a `count-work` measurement counter no send reads")),
    ("work.rs", "PROVIDER_LOADS", NotState("a `count-work` measurement counter no send reads")),
    (
        "providers/action_input.rs",
        "NESTED_BY_FLAT",
        Survives("the unions tool modules register as they load (Node registers them at import, `action-schema.mjs:414`), keyed by content"),
    ),
    ("accounts/binding.rs", "BINDINGS", Survives("the host's account bindings; `replace_provider_auth_bindings` hands its caller the restore step")),
    (
        "netproxy/tunnel.rs",
        "CONFIG",
        Survives("the product TLS configuration and its session cache; a replay connects through its own server's configuration (`Pinned::tls`)"),
    ),
    (
        "transport/node_http.rs",
        "CONFIG",
        Survives("the product TLS configuration with Node's ALPN; a replay connects through its own server's configuration (`Pinned::tls`)"),
    ),
];

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

/// The body of `fn <name>()` in `text`, through its closing brace at the start of a line.
fn body<'a>(text: &'a str, name: &str) -> &'a str {
    let start = text.find(&format!("fn {name}()")).unwrap_or_else(|| panic!("fn {name}"));
    let rest = &text[start..];
    &rest[..rest.find("\n}").expect("the body's end")]
}

// A fast request refused with "fast mode is not enabled" disables fast mode for the process
// (`anthropic-fast-mode.mjs:71`); a replay after it starts as a new process does, with fast mode available (`:41`, `:45`).
#[test]
fn a_replay_starts_with_fast_mode_available_after_a_send_disabled_it() {
    use mixdog_ai::providers::anthropic::fast_mode;
    let refusal = fast_mode::CapacityError { status: 400, message: "Fast mode is not enabled for this organization", headers: &[], retry_after_ms: None };
    assert_eq!(fast_mode::process().note_capacity_error(&refusal, true, 0.0), fast_mode::Capacity::Disabled);
    assert!(!fast_mode::process().available(0.0), "disabled by the refusal");
    mixdog_ai::reset_process_state();
    assert!(fast_mode::process().available(0.0), "a replay's process has fast mode available");
    assert_eq!(fast_mode::process().disabled_reason(), None);
}

/// `text` with its comments and the contents of its string and character literals blanked (newlines kept, so a line
/// number is the source's): what is left is code. A lifetime (`'static`) is code.
fn code(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let blank = |out: &mut String, c: char| out.push(if c == '\n' { '\n' } else { ' ' });
    let ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '/' && next == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                blank(&mut out, chars[i]);
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            let mut depth = 0;
            loop {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    out.push_str("  ");
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    out.push_str("  ");
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    blank(&mut out, chars[i]);
                    i += 1;
                }
            }
        } else if c == 'r' && (i == 0 || !ident(chars[i - 1]) || (chars[i - 1] == 'b' && (i < 2 || !ident(chars[i - 2])))) && matches!(next, Some('"' | '#')) {
            // A raw string `r#"…"#`, or the identifier `r#name` / a plain `r`.
            let hashes = chars[i + 1..].iter().take_while(|c| **c == '#').count();
            if chars.get(i + 1 + hashes) != Some(&'"') {
                out.push(c);
                i += 1;
                continue;
            }
            let close: Vec<char> = std::iter::once('"').chain(std::iter::repeat_n('#', hashes)).collect();
            out.push('r');
            for _ in 0..=hashes {
                out.push(' ');
            }
            i += 2 + hashes;
            while i < chars.len() && !chars[i..].starts_with(&close) {
                blank(&mut out, chars[i]);
                i += 1;
            }
            for _ in 0..close.len() {
                out.push(' ');
            }
            i += close.len();
        } else if c == '"' {
            out.push(' ');
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                let skip = if chars[i] == '\\' { 2 } else { 1 };
                for _ in 0..skip.min(chars.len() - i) {
                    blank(&mut out, chars[i]);
                    i += 1;
                }
            }
            out.push(' ');
            i += 1;
        } else if c == '\'' && (next == Some('\\') || chars.get(i + 2) == Some(&'\'')) {
            // A character literal (`'x'`, `'\''`, `'\u{7f}'`); anything else after `'` is a lifetime or a label.
            out.push(' ');
            i += 1;
            while i < chars.len() && chars[i] != '\'' {
                let skip = if chars[i] == '\\' { 2 } else { 1 };
                for _ in 0..skip.min(chars.len() - i) {
                    blank(&mut out, chars[i]);
                    i += 1;
                }
            }
            out.push(' ');
            i += 1;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// Every `static` keyword of `code` ([`code`]): read as a declaration (`static [mut] name: type`, the name and the
/// type on any lines), or listed with its line as one this scan cannot read; a `'static` lifetime is neither. A
/// refused macro (`thread_local!`, `lazy_static!`, a `once_cell::` path), with any spacing, is listed too.
fn statics(code: &str) -> (Vec<(usize, String, String)>, Vec<(usize, String)>) {
    let line_of = |at: usize| code[..at].matches('\n').count() + 1;
    let keyword = regex::Regex::new(r"\bstatic\b").unwrap();
    let declaration = regex::Regex::new(r"^static\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:([^=;]*)").unwrap();
    let refused = regex::Regex::new(r"\b(?:thread_local\s*!|lazy_static\s*!|once_cell\s*::)").unwrap();
    let mut read = Vec::new();
    let mut unreadable = Vec::new();
    for found in keyword.find_iter(code) {
        if code[..found.start()].ends_with('\'') {
            continue;
        }
        match declaration.captures(&code[found.start()..]) {
            Some(captures) => read.push((line_of(found.start()), captures[1].to_owned(), captures[2].trim().to_owned())),
            None => unreadable.push((line_of(found.start()), code[found.start()..].chars().take(40).collect::<String>().replace('\n', " "))),
        }
    }
    for found in refused.find_iter(code) {
        unreadable.push((line_of(found.start()), found.as_str().to_owned()));
    }
    (read, unreadable)
}

// The lanes' queue bound is read from the environment once per process (Node builds its scheduler once); a replay
// after the environment changed reads it again, as a new process would.
#[test]
fn a_replay_reads_the_lane_queue_bound_from_the_environment_again() {
    use mixdog_ai::admission::{LaneKey, process_lane_settings};
    const NAME: &str = "MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE";
    let key = LaneKey::new("gemini".into(), "default");
    // SAFETY: this test's process (nextest runs each test in its own) has no other thread reading the environment.
    unsafe { std::env::set_var(NAME, "7") };
    mixdog_ai::reset_process_state();
    assert_eq!(process_lane_settings()(&key).max_queue, 7);
    unsafe { std::env::set_var(NAME, "9") };
    assert_eq!(process_lane_settings()(&key).max_queue, 7, "read once per process");
    mixdog_ai::reset_process_state();
    assert_eq!(process_lane_settings()(&key).max_queue, 9, "a replay's process reads the environment it starts with");
    unsafe { std::env::remove_var(NAME) };
}

// The scan reads a declaration however it is laid out, and refuses what it cannot read instead of skipping it.
#[test]
fn the_scan_reads_every_static_or_names_it_unreadable() {
    let source = "// static IN_COMMENT: u8 = 0;\nconst S: &str = \"static IN_STRING: u8\";\nfn f(x: &'static str) {}\n\
                  static lower: Mutex<u8> = Mutex::new(0);\nstatic\n    NEXT_LINE\n    : AtomicU64 = AtomicU64::new(0);\n\
                  static A: u8 = 0; static B: u8 = 0;\nmacro_rules! m { ($name:ident) => { static $name: u8 = 0; }; }\n\
                  thread_local !{ static T: u8 = 0; }\nconst C: char = '\"'; static AFTER_CHAR: u8 = 0;\n\
                  const R: &str = r#\"static IN_RAW: u8\"#;\nstatic mut M: u8 = 0;\n/* static IN_BLOCK: u8 /* nested */ */\n";
    let (read, unreadable) = statics(&code(source));
    let names: Vec<(usize, &str)> = read.iter().map(|(line, name, _)| (*line, name.as_str())).collect();
    assert_eq!(names, [(4, "lower"), (5, "NEXT_LINE"), (8, "A"), (8, "B"), (10, "T"), (11, "AFTER_CHAR"), (13, "M")]);
    assert_eq!(read[1].2, "AtomicU64", "the type is read across lines");
    let lines: Vec<usize> = unreadable.iter().map(|(line, _)| *line).collect();
    assert_eq!(lines, [9, 10], "{unreadable:?}: the macro's `static $name` and the spaced `thread_local !`");
}

#[test]
fn every_process_wide_value_is_reset_for_a_replay_or_named_with_its_reason() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    let mut found = Vec::new();
    let mut unscannable = Vec::new();
    for file in files {
        let relative = file.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let (read, unreadable) = statics(&code(&std::fs::read_to_string(&file).unwrap()));
        unscannable.extend(unreadable.into_iter().map(|(line, what)| format!("{relative}:{line}: {what}")));
        for (_, name, kind) in read {
            let pattern = kind.contains("Regex") && !["Mutex", "RwLock", "Atomic", "Cell"].iter().any(|m| kind.contains(m));
            if !pattern {
                found.push((relative.clone(), name));
            }
        }
    }
    assert!(unscannable.is_empty(), "process-wide values this scan does not read: {unscannable:#?}");

    let lib = code(&std::fs::read_to_string(root.join("lib.rs")).unwrap());
    let anthropic = code(&std::fs::read_to_string(root.join("providers/anthropic/mod.rs")).unwrap());
    // The calls the two bodies make; a commented-out call is none.
    let reset = format!("{}\n{}", body(&lib, "reset_process_state"), body(&anthropic, "reset_process_state"));
    let mut problems = Vec::new();
    for (file, name) in &found {
        match VALUES.iter().find(|(f, n, _)| f == file && n == name) {
            None => problems.push(format!("{file}: {name} is neither reset by reset_process_state nor named here with its reason")),
            Some((_, _, Reset(call))) if !reset.contains(call) => problems.push(format!("{file}: {name}: reset_process_state does not call `{call}`")),
            Some((_, _, NotState(why) | Survives(why))) if why.is_empty() => problems.push(format!("{file}: {name} has no reason")),
            Some(_) => {}
        }
    }
    for (file, name, _) in VALUES {
        if !found.iter().any(|(f, n)| f == file && n == name) {
            problems.push(format!("{file}: {name} is named here but no longer declared"));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}
