//! The surviving originals read from the data directory: the rotated agent trace, the gateway
//! usage store, the legacy rollup document and the read-only database's pid file. Nothing is
//! written or rewritten; a file that is absent is absence, one that cannot be read is an error,
//! and one that is damaged is skipped with a warning and leaves the import unmarked so that a
//! repair is retried.

#![allow(
    clippy::disallowed_methods,
    reason = "a maintenance-lane job body: it runs on the lane's thread, not an async task"
)]

use std::io::ErrorKind;
use std::path::Path;

use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use crate::error::Result;

/// One `agent-trace.jsonl[.N]` file: the usage rows in it and the lines a crash tore.
pub(super) struct TraceFile {
    pub path: String,
    pub sha256: String,
    pub rows: Vec<Value>,
    pub torn: u64,
}

/// Everything read, in the order the import takes it.
pub(super) struct Originals {
    /// The gateway store's events, as rows; none when there is no usable store.
    pub gateway: Option<Vec<Value>>,
    /// The legacy rollup's `days`.
    pub rollup_days: Option<Value>,
    /// No damaged legacy file was skipped: the import may be marked done.
    pub ready: bool,
    pub warnings: Vec<String>,
}

fn optional(path: &Path) -> Result<Option<String>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// `agent-trace.jsonl` or `agent-trace.jsonl.<digits>`.
fn is_trace_name(name: &str) -> bool {
    match name.strip_prefix("agent-trace.jsonl") {
        Some("") => true,
        Some(rest) => rest
            .strip_prefix('.')
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())),
        None => false,
    }
}

pub(super) fn trace_names(history: &Path) -> Result<Vec<String>> {
    let entries = match std::fs::read_dir(history) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut names = Vec::new();
    for entry in entries {
        if let Some(name) = entry?.file_name().to_str().filter(|name| is_trace_name(name)) {
            names.push(name.to_owned());
        }
    }
    names.sort();
    Ok(names)
}

fn trace_file(path: &Path, original: &str) -> TraceFile {
    let mut rows = Vec::new();
    let mut torn = 0;
    for line in original.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if mixdog_js::js_trim(line).is_empty() {
            continue;
        }
        match mixdog_js::json_parse(line) {
            Ok(row) => {
                if matches!(row.get("kind").and_then(Value::as_str), Some("usage_raw" | "usage")) {
                    rows.push(row);
                }
            }
            // An append a crash tore (cut short, or NUL-filled) is no record.
            Err(_) => torn += 1,
        }
    }
    let digest = Sha256::digest(original.as_bytes());
    TraceFile {
        path: path.display().to_string(),
        sha256: digest.iter().map(|byte| format!("{byte:02x}")).collect(),
        rows,
        torn,
    }
}

/// A gateway event as an import row: always a `usage` row, its session under `session_id`.
fn gateway_row(event: &Value) -> Result<Value> {
    if event.is_null() {
        return Err(crate::LedgerError::History("Cannot read properties of null (reading 'sessionId')".into()));
    }
    // Primitive events are still source rows. Their spread has no usage fields.
    let mut row = event.as_object().cloned().unwrap_or_default();
    row.insert("kind".to_owned(), Value::from("usage"));
    match event.get("sessionId") {
        Some(session) => {
            row.insert("session_id".to_owned(), session.clone());
        }
        None => {
            row.shift_remove("session_id");
        }
    }
    Ok(Value::Object(row))
}

fn parse_failure(text: &str, error: mixdog_js::JsonSyntaxError) -> String {
    mixdog_js::v8_json_parse_error(text).unwrap_or_else(|| error.to_string())
}

/// The days of a legacy rollup document: a root object holding `days` as an object or an array.
fn rollup_days(text: &str) -> std::result::Result<Value, String> {
    let parsed = mixdog_js::json_parse(text).map_err(|error| parse_failure(text, error))?;
    let Value::Object(mut root) = parsed else {
        return Err("legacy rollup root is not an object".to_owned());
    };
    let Some(days) = root.remove("days") else {
        return Err("legacy rollup days is missing".to_owned());
    };
    match days {
        Value::Object(_) | Value::Array(_) => Ok(days),
        _ => Err("legacy rollup days is not an object or array".to_owned()),
    }
}

pub(super) fn read_gateway(data_dir: &Path) -> Result<Originals> {
    let mut originals = Originals {
        gateway: None,
        rollup_days: None,
        ready: true,
        warnings: Vec::new(),
    };
    // The JSONL store supersedes the legacy JSON file (it is migrated from it).
    let jsonl = optional(&data_dir.join("gateway-usage.local.jsonl"))?;
    let legacy = match jsonl {
        Some(_) => None,
        None => optional(&data_dir.join("gateway-usage.local.json"))?,
    };
    if let Some(jsonl) = jsonl {
        let events = jsonl
            .split('\n')
            .filter(|line| !mixdog_js::js_trim(line).is_empty())
            // A torn append is no event.
            .filter_map(|line| mixdog_js::json_parse(line).ok());
        originals.gateway = Some(events.map(|event| gateway_row(&event)).collect::<Result<Vec<_>>>()?);
    } else if let Some(legacy) = legacy {
        match mixdog_js::json_parse(&legacy) {
            Ok(parsed) => {
                let events = parsed.get("events").and_then(Value::as_array);
                originals.gateway = Some(events.map(|events| events.iter().map(gateway_row).collect::<Result<Vec<_>>>()).transpose()?.unwrap_or_default());
            }
            Err(error) => {
                originals.ready = false;
                originals.warnings.push(format!(
                    "[usage-ledger] warning: legacy gateway usage file gateway-usage.local.json is empty or corrupt ({}); skipping its import",
                    parse_failure(&legacy, error)
                ));
            }
        }
    }

    Ok(originals)
}

pub(super) fn read_pid(data_dir: &Path) -> Result<Option<String>> {
    Ok(optional(&data_dir.join("pgdata").join("postmaster.pid"))?.filter(|pid| !pid.is_empty()))
}

pub(super) fn read_trace_file(path: &Path) -> Result<TraceFile> {
    let original = std::fs::read(path)?;
    Ok(trace_file(path, &String::from_utf8_lossy(&original)))
}

pub(super) fn read_rollup(data_dir: &Path, mut originals: Originals) -> Result<Originals> {
    let rollup_path = data_dir.join("usage-rollup.local.json");
    if let Some(rollup) = optional(&rollup_path)? {
        match rollup_days(&rollup) {
            Ok(days) => originals.rollup_days = Some(days),
            Err(reason) => {
                originals.ready = false;
                originals.warnings.push(format!(
                    "[usage-ledger] warning: legacy rollup {} is empty, corrupt, or the wrong shape ({reason}); skipping its import",
                    rollup_path.display()
                ));
            }
        }
    }
    Ok(originals)
}
