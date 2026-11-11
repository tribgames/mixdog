//! A real stdio MCP server for replays that must observe which servers and tools a route reaches. The test binary runs
//! itself as the server (the way a test of a crash runs the test executable as the crashing process): a test function of
//! the crate, `scripted_server`, calls [`serve_if_asked`], which does nothing unless the process was started as a server
//! ([`launch`] sets the environment). A server answers `initialize`, `tools/list` and `tools/call`; a call appends its
//! tool name and the arguments it carried to its reach log before it answers `ran <server> <tool>`, so what reached a
//! server is read from the log, never from what the test supplied. The harness prints its own lines on stdout; the client skips lines that are not JSON.

use std::io::BufRead;
use std::io::Write;
use std::path::Path;

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const SERVER: &str = "MIXDOG_TEST_MCP_SERVER";
const TOOLS: &str = "MIXDOG_TEST_MCP_TOOLS";
const REACH: &str = "MIXDOG_TEST_MCP_REACH";

/// How to start one scripted server: `test` is the full path of the crate's `scripted_server` test (as `--exact` names it).
pub struct Launch {
    pub command: String,
    pub args: Vec<String>,
    pub env: Map<String, Value>,
}

/// The start of a server named `server` listing `tools`, appending what reaches it to `reach`.
pub fn launch(test: &str, server: &str, tools: &[&str], reach: &Path) -> Launch {
    let mut env = Map::new();
    env.insert(SERVER.into(), json!(server));
    env.insert(TOOLS.into(), json!(json!(tools).to_string()));
    env.insert(REACH.into(), json!(reach.to_string_lossy()));
    Launch {
        command: std::env::current_exe().expect("this test binary").to_string_lossy().into_owned(),
        args: vec![test.into(), "--exact".into(), "--nocapture".into(), "--test-threads=1".into(), "-q".into()],
        env,
    }
}

/// What reached the servers logging to `reach` so far, one `{"name": "mcp__<server>__<tool>", "arguments": …}` per call, in
/// the order the calls arrived (servers started with the same log share one order: the `seq` each record took under the log's lock).
pub fn reached(reach: &Path) -> Vec<Value> {
    let mut records: Vec<(u64, Value)> = std::fs::read_to_string(reach)
        .map(|text| {
            text.lines()
                .map(|line| {
                    let mut record: Value = serde_json::from_str(line).expect("a reach line");
                    let seq = record.as_object_mut().and_then(|object| object.remove("seq")).and_then(|seq| seq.as_u64()).expect("a reach line's seq");
                    (seq, record)
                })
                .collect()
        })
        .unwrap_or_default();
    records.sort_by_key(|(seq, _)| *seq);
    records.into_iter().map(|(_, record)| record).collect()
}

/// Appends one record to the log as one write, its `seq` taken under an exclusive lock on the file: the processes (or threads) that
/// share a log get distinct, gap-free sequence numbers in the order they held the lock, and no record is interleaved with another.
fn append(reach: &Path, record: Value) {
    use std::io::Read;
    let mut log = std::fs::OpenOptions::new().create(true).read(true).append(true).open(reach).expect("the reach log");
    log.lock().expect("the reach log's lock");
    let mut text = String::new();
    log.read_to_string(&mut text).expect("the reach log's records");
    let mut record = record;
    record["seq"] = json!(text.lines().count());
    let mut line = record.to_string();
    line.push('\n');
    log.write_all(line.as_bytes()).expect("the reach record");
    log.unlock().expect("the reach log's unlock");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writers sharing one log (each with its own handle, as separate server processes have) leave one whole record per call and a
    /// sequence with no repeat and no gap, which `reached` reads back in order.
    #[test]
    fn writers_sharing_a_log_take_one_order() {
        let dir = std::env::temp_dir().join(format!("mixdog-testkit-reach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("reach.log");
        let _ = std::fs::remove_file(&log);
        let writers: Vec<_> = (0..8)
            .map(|writer| {
                let log = log.clone();
                std::thread::spawn(move || {
                    for call in 0..40 {
                        append(&log, json!({"name": format!("mcp__s{writer}__t"), "arguments": {"call": call, "pad": "x".repeat(8192)}}));
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        let text = std::fs::read_to_string(&log).unwrap();
        let seqs: Vec<u64> = text.lines().map(|line| serde_json::from_str::<Value>(line).expect("a whole record")["seq"].as_u64().unwrap()).collect();
        assert_eq!(seqs, (0..320).collect::<Vec<u64>>(), "records land in the order of their sequence");
        assert_eq!(reached(&log).len(), 320);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// Serves MCP over stdio until the client closes it, when this process was started by [`launch`]; returns at once otherwise.
pub fn serve_if_asked() {
    let Ok(server) = std::env::var(SERVER) else { return };
    let tools: Vec<String> = serde_json::from_str(&std::env::var(TOOLS).expect("the tools")).expect("tools json");
    let reach = std::env::var(REACH).expect("the reach log");
    let mut out = std::io::stdout();
    let mut send = |message: Value| {
        writeln!(out, "{message}").unwrap();
        out.flush().unwrap();
    };
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let (Some(method), Some(id)) = (message["method"].as_str(), message.get("id").cloned()) else { continue };
        match method {
            "initialize" => send(json!({"jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": server, "version": "0"}}})),
            "tools/list" => {
                let listed: Vec<Value> = tools
                    .iter()
                    .map(|name| json!({"name": name, "description": format!("{name} tool"), "inputSchema": {"type": "object", "properties": {}}, "annotations": {"readOnlyHint": true}}))
                    .collect();
                send(json!({"jsonrpc": "2.0", "id": id, "result": {"tools": listed}}));
            }
            "tools/call" => {
                let tool = message["params"]["name"].as_str().unwrap_or_default().to_owned();
                if !tools.contains(&tool) {
                    send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "unknown tool"}}));
                    continue;
                }
                let arguments = message["params"].get("arguments").cloned().unwrap_or_else(|| json!({}));
                append(Path::new(&reach), json!({"name": format!("mcp__{server}__{tool}"), "arguments": arguments}));
                send(json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": format!("ran {server} {tool}")}]}}));
            }
            _ => send(json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}})),
        }
    }
}
