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
    ("admission/settings.rs", "SETTINGS", NotState("the lane rule from the process environment, read once as Node builds its scheduler once")),
    ("accounts/binding.rs", "SCOPED", NotState("task-local: the account a task runs under, gone with the task")),
    ("oauth/single_flight.rs", "FLIGHTS", NotState("only refreshes in flight; each leaves the map when it ends")),
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

#[test]
fn every_process_wide_value_is_reset_for_a_replay_or_named_with_its_reason() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let declaration = regex::Regex::new(r"\bstatic\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)\s*:\s*(.*)").unwrap();
    let mut files = Vec::new();
    sources(&root, &mut files);
    let mut found = Vec::new();
    let mut unscannable = Vec::new();
    for file in files {
        let relative = file.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let text = std::fs::read_to_string(&file).unwrap();
        for (index, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for word in ["thread_local!", "lazy_static!", "once_cell::"] {
                if line.contains(word) {
                    unscannable.push(format!("{relative}:{}: {word}", index + 1));
                }
            }
            let Some(captures) = declaration.captures(line) else { continue };
            let kind = &captures[2];
            let pattern = kind.contains("Regex") && !["Mutex", "RwLock", "Atomic", "Cell"].iter().any(|m| kind.contains(m));
            if !pattern {
                found.push((relative.clone(), captures[1].to_owned()));
            }
        }
    }
    assert!(unscannable.is_empty(), "process-wide values this scan does not read: {unscannable:?}");

    let lib = std::fs::read_to_string(root.join("lib.rs")).unwrap();
    let anthropic = std::fs::read_to_string(root.join("providers/anthropic/mod.rs")).unwrap();
    // The calls the two bodies make; a commented-out call is none.
    let reset = format!("{}\n{}", body(&lib, "reset_process_state"), body(&anthropic, "reset_process_state"))
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
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
