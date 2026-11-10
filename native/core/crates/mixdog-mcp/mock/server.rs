//! A stdio MCP server for the integration suite. Behaviour is chosen by the tool called:
//! `echo`, `fail` (isError), `big` (3000 lines), `slow` (progress ticks, then a result), `hang`
//! (never answers), `crash` (exits), `elicit` (asks the client to elicit, reports the answer),
//! `grow` (adds the tool `extra` and announces `list_changed`) and `cancels` (how many
//! `notifications/cancelled` arrived).
#![allow(clippy::disallowed_methods, reason = "a plain blocking test process, not a runtime thread")]

use std::io::BufRead;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Value;
use serde_json::json;

struct Shared {
    out: Mutex<std::io::Stdout>,
    cancels: AtomicUsize,
    grown: AtomicBool,
    elicit_answer: Mutex<Option<std::sync::mpsc::Sender<Value>>>,
    /// The arguments of the last `describe_emails` call.
    last_describe: Mutex<Value>,
    fixture_calls: AtomicUsize,
    /// The arguments of every fixture call, in order.
    fixture_args: Mutex<Vec<Value>>,
}

fn send(shared: &Shared, message: Value) {
    let mut out = shared.out.lock().unwrap();
    writeln!(out, "{message}").unwrap();
    out.flush().unwrap();
}

fn tool(name: &str) -> Value {
    json!({"name": name, "description": format!("{name} tool"), "inputSchema": {"type": "object"},
           "annotations": {"readOnlyHint": name == "echo"}})
}

fn text(text: impl Into<String>) -> Value {
    json!({"content": [{"type": "text", "text": text.into()}]})
}

fn call(shared: &Arc<Shared>, id: Value, params: &Value) {
    let name = params["name"].as_str().unwrap_or_default();
    let token = params["_meta"]["progressToken"].clone();
    let result = match name {
        "echo" => text(params["arguments"]["text"].as_str().unwrap_or_default()),
        "fail" => json!({"isError": true, "content": [{"type": "text", "text": "boom"}]}),
        "big" => text((1..=3000).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n")),
        "slow" => {
            for tick in 1..=5 {
                std::thread::sleep(Duration::from_millis(100));
                send(shared, json!({"jsonrpc": "2.0", "method": "notifications/progress",
                                    "params": {"progressToken": token, "progress": tick}}));
            }
            text("slow done")
        }
        "hang" => return,
        "crash" => {
            eprintln!("crashing on purpose");
            std::process::exit(3);
        }
        "elicit" => {
            let (tx, rx) = std::sync::mpsc::channel();
            *shared.elicit_answer.lock().unwrap() = Some(tx);
            send(shared, json!({"jsonrpc": "2.0", "id": "e1", "method": "elicitation/create",
                                "params": {"message": "name?"}}));
            let answer = rx.recv_timeout(Duration::from_secs(5)).unwrap_or(Value::Null);
            text(answer["error"]["message"].as_str().unwrap_or("no answer"))
        }
        "grow" => {
            shared.grown.store(true, Ordering::SeqCst);
            send(shared, json!({"jsonrpc": "2.0", "id": id, "result": text("grown")}));
            send(shared, json!({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}));
            return;
        }
        "cancels" => text(shared.cancels.load(Ordering::SeqCst).to_string()),
        // Never listed (like the Gmail connector's): answers the result in `MOCK_DESCRIBE_RESULT`.
        "describe_emails" => {
            *shared.last_describe.lock().unwrap() = params["arguments"].clone();
            match std::env::var("MOCK_DESCRIBE_RESULT") {
                Ok(raw) => serde_json::from_str(&raw).unwrap(),
                Err(_) => {
                    send(shared, json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "unknown tool"}}));
                    return;
                }
            }
        }
        "describe_args" => text(shared.last_describe.lock().unwrap().to_string()),
        // Hook fixtures: `fixture_<n>` answers the n-th entry of `MOCK_FIXTURES` (a JSON array of
        // strings; an `{"error": …}` entry is a tool error); `fixture_count` counts the calls.
        "fixture_count" => text(shared.fixture_calls.load(Ordering::SeqCst).to_string()),
        // The arguments the fixtures were called with, as a JSON array.
        "fixture_args" => text(Value::Array(shared.fixture_args.lock().unwrap().clone()).to_string()),
        fixture if fixture.starts_with("fixture_") => {
            shared.fixture_calls.fetch_add(1, Ordering::SeqCst);
            shared.fixture_args.lock().unwrap().push(params["arguments"].clone());
            let fixtures: Vec<Value> = serde_json::from_str(&std::env::var("MOCK_FIXTURES").unwrap_or_default()).unwrap_or_default();
            match fixtures.get(fixture["fixture_".len()..].parse::<usize>().unwrap_or(usize::MAX)) {
                Some(Value::String(output)) => text(output.clone()),
                Some(entry) => json!({"isError": true, "content": [{"type": "text", "text": entry["error"].as_str().unwrap_or_default()}]}),
                None => json!({"isError": true, "content": [{"type": "text", "text": "no such fixture"}]}),
            }
        }
        _ => {
            send(shared, json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "unknown tool"}}));
            return;
        }
    };
    send(shared, json!({"jsonrpc": "2.0", "id": id, "result": result}));
}

fn main() {
    // `MOCK_STARTS`: a file that gets one line per start. `MOCK_DOWN_WHILE`: while that file
    // exists, the server exits at once (a start that fails with an unchanged configuration).
    if let Ok(starts) = std::env::var("MOCK_STARTS") {
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(starts).unwrap();
        writeln!(file, "start").unwrap();
    }
    if std::env::var("MOCK_DOWN_WHILE").is_ok_and(|path| std::path::Path::new(&path).exists()) {
        eprintln!("down on purpose");
        std::process::exit(1);
    }
    let shared = Arc::new(Shared {
        out: Mutex::new(std::io::stdout()),
        cancels: AtomicUsize::new(0),
        grown: AtomicBool::new(false),
        elicit_answer: Mutex::new(None),
        last_describe: Mutex::new(Value::Null),
        fixture_calls: AtomicUsize::new(0),
        fixture_args: Mutex::new(Vec::new()),
    });
    // `MOCK_SCENARIO`: `{tools, results}` — lists `tools` and answers `tools/call {name, {i}}`
    // with `results[name][i]` (a recorded case of `record-mcp-output-schema.mjs`).
    let scenario: Option<Value> = std::env::var("MOCK_SCENARIO").ok().map(|raw| serde_json::from_str(&raw).unwrap());
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let method = message["method"].as_str().map(str::to_owned);
        let id = message.get("id").cloned();
        match (method.as_deref(), id) {
            (Some("tools/list"), Some(id)) if scenario.is_some() => {
                let tools = scenario.as_ref().map(|s| s["tools"].clone()).unwrap_or_default();
                send(&shared, json!({"jsonrpc": "2.0", "id": id, "result": {"tools": tools}}));
            }
            (Some("tools/call"), Some(id)) if scenario.is_some() => {
                let params = &message["params"];
                let index = params["arguments"]["i"].as_u64().unwrap_or_default() as usize;
                let result = scenario.as_ref().map(|s| s["results"][params["name"].as_str().unwrap_or_default()][index].clone());
                send(&shared, json!({"jsonrpc": "2.0", "id": id, "result": result}));
            }
            (Some("initialize"), Some(id)) => send(&shared, json!({"jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {"listChanged": true}},
                "serverInfo": {"name": "mock", "version": "0"},
                "instructions": "mock instructions"}})),
            (Some("tools/list"), Some(id)) => {
                let cursor = message["params"]["cursor"].as_str();
                let result = match cursor {
                    None => json!({"tools": [tool("echo"), tool("slow")], "nextCursor": "p2"}),
                    Some(_) => {
                        let mut tools = vec![tool("big"), tool("fail"), tool("hang"), tool("crash"),
                                             tool("elicit"), tool("grow"), tool("cancels")];
                        if shared.grown.load(Ordering::SeqCst) {
                            tools.push(tool("extra"));
                        }
                        let fixtures: Vec<Value> = serde_json::from_str(&std::env::var("MOCK_FIXTURES").unwrap_or_default()).unwrap_or_default();
                        tools.extend((0..fixtures.len()).map(|n| tool(&format!("fixture_{n}"))));
                        json!({"tools": tools})
                    }
                };
                send(&shared, json!({"jsonrpc": "2.0", "id": id, "result": result}));
            }
            (Some("tools/call"), Some(id)) => {
                let shared = Arc::clone(&shared);
                let params = message["params"].clone();
                std::thread::spawn(move || call(&shared, id, &params));
            }
            (Some("notifications/cancelled"), None) => {
                shared.cancels.fetch_add(1, Ordering::SeqCst);
            }
            (None, Some(id)) if id == json!("e1") => {
                if let Some(tx) = shared.elicit_answer.lock().unwrap().take() {
                    let _ = tx.send(message.clone());
                }
            }
            (Some(_), Some(id)) => {
                send(&shared, json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "method not found"}}));
            }
            _ => {}
        }
    }
}
