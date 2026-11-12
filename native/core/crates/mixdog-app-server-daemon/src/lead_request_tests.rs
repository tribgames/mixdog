//! What the model receives on a desktop lead thread, against Node: `fixtures/lead-request/golden.json`, recorded by
//! `benchmarks/rust-core/recorders/record-lead-request.mjs` from Node's own daemon. Each scenario is a user's settings (the config file, the
//! files of the data directory and of the workspace). The real core is composed over a profile holding them, a desktop client starts a task
//! on a loopback provider of the recorded wire (thread/start, route/set, turn/start), and the request that reaches that endpoint, the
//! provider adapter's own, must equal Node's: the whole system prompt, the whole tool list in its order and every `cache_control` breakpoint.
//! The profile's folders are the tokens the recording holds (`{DATA}`, `{WS}`, `{HOME}`), and the session's scratch folder, named by a digest of the
//! thread's id, is `s.{SCRATCH}`: nothing else is replaced.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories, a loopback endpoint on a thread of its own and the recorded fixture")]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use mixdog_app_server::Outgoing;
use mixdog_app_server_client::api::{Target, TransportEvent, TransportHalves};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::compose::{ComposeConfig, compose};
use crate::server::serve_in_process;

const PROMPT_TOKEN: &str = "LEAD-REQUEST-PROMPT";

fn golden() -> Value {
    serde_json::from_str(&mixdog_testkit::fixture!("../../fixtures/lead-request/golden.json")).expect("the lead-request recording")
}

/// What one HTTP exchange of the loopback endpoint carried: a POST's path and JSON body.
struct Post {
    url: String,
    body: Value,
}

/// A loopback endpoint of one wire: every POST is sent to the test, and answered with one short text; anything else is the model list.
fn endpoint(wire: &str, model: &str) -> (u16, Receiver<Post>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let port = listener.local_addr().expect("its address").port();
    let (posts, received) = channel();
    let (wire, model) = (wire.to_owned(), model.to_owned());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (posts, wire, model) = (posts.clone(), wire.clone(), model.clone());
            std::thread::spawn(move || answer(stream, &wire, &model, &posts));
        }
    });
    (port, received)
}

fn answer(mut stream: TcpStream, wire: &str, model: &str, posts: &Sender<Post>) {
    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = stream.read(&mut chunk).expect("the request");
        assert!(n > 0, "the client closed before its request head ended");
        raw.extend_from_slice(&chunk[..n]);
        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
    let mut lines = head.lines();
    let mut first = lines.next().unwrap_or_default().split(' ');
    let (method, url) = (first.next().unwrap_or_default().to_owned(), first.next().unwrap_or_default().to_owned());
    let header = |name: &str| lines.clone().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_owned()));
    let mut body = raw[head_end..].to_vec();
    if header("transfer-encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked")) {
        // Each chunk: its size in hex, the bytes, a line end; a zero size ends it.
        let mut decoded = Vec::new();
        let mut rest = body;
        loop {
            let at = loop {
                if let Some(at) = rest.windows(2).position(|w| w == b"\r\n") {
                    break at;
                }
                let n = stream.read(&mut chunk).expect("a chunk size");
                assert!(n > 0, "the client closed inside a chunked body");
                rest.extend_from_slice(&chunk[..n]);
            };
            let size = usize::from_str_radix(String::from_utf8_lossy(&rest[..at]).trim(), 16).expect("a chunk size");
            if size == 0 {
                break;
            }
            while rest.len() < at + 2 + size + 2 {
                let n = stream.read(&mut chunk).expect("a chunk");
                assert!(n > 0, "the client closed inside a chunk");
                rest.extend_from_slice(&chunk[..n]);
            }
            decoded.extend_from_slice(&rest[at + 2..at + 2 + size]);
            rest.drain(..at + 2 + size + 2);
        }
        body = decoded;
    } else {
        let length: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        while body.len() < length {
            let n = stream.read(&mut chunk).expect("the body");
            assert!(n > 0, "the client closed inside its body");
            body.extend_from_slice(&chunk[..n]);
        }
    }
    let sse = |events: &[(&str, Value)]| events.iter().map(|(name, data)| if name.is_empty() { format!("data: {data}\n\n") } else { format!("event: {name}\ndata: {data}\n\n") }).collect::<String>();
    let (kind, text) = if method != "POST" {
        ("application/json", json!({ "object": "list", "data": [{ "id": model, "object": "model", "type": "model" }], "has_more": false }).to_string())
    } else {
        posts.send(Post { url, body: serde_json::from_slice(&body).expect("a JSON body") }).expect("the test is waiting");
        let events = if wire == "anthropic" {
            sse(&[
                ("message_start", json!({ "type": "message_start", "message": { "id": "msg_1", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": null, "usage": { "input_tokens": 10, "output_tokens": 1 } } })),
                ("content_block_start", json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
                ("content_block_delta", json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "ok" } })),
                ("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
                ("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 2 } })),
                ("message_stop", json!({ "type": "message_stop" })),
            ])
        } else {
            let chunk = |delta: Value, finish: Value| json!({ "id": "c1", "object": "chat.completion.chunk", "model": model, "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }] });
            sse(&[
                ("", chunk(json!({ "role": "assistant", "content": "" }), Value::Null)),
                ("", chunk(json!({ "content": "ok" }), Value::Null)),
                ("", chunk(json!({}), json!("stop"))),
                ("", json!({ "id": "c1", "object": "chat.completion.chunk", "model": model, "choices": [], "usage": { "prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12 } })),
            ]) + "data: [DONE]\n\n"
        };
        ("text/event-stream", events)
    };
    let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len());
    stream.write_all(reply.as_bytes()).expect("the answer");
}

/// The files of a scenario, by path, under `root`; `{DATA}` is the data directory.
fn put_files(root: &Path, files: &Value, data: &Path) {
    for (rel, text) in files.as_object().into_iter().flatten() {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("the folder");
        std::fs::write(path, text.as_str().expect("file text").replace("{DATA}", &slashed(data))).expect("the file");
    }
}

fn slashed(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The recorder's profile: the same variables a daemon of its sandbox saw (nothing of the user's own `MIXDOG_*`, home or PATH).
fn sandbox_env(home: &Path, programs: &[&str]) {
    let root = std::env::var("SystemRoot").expect("SystemRoot");
    let mut path = format!("{root}\\System32;{root}");
    // The folders of the programs the scenario names (a developer's git, a server's node), found on the PATH this process has.
    for program in programs {
        let folder = std::env::var("PATH").expect("PATH").split(';').find(|dir| Path::new(dir).join(format!("{program}.exe")).is_file()).unwrap_or_else(|| panic!("{program} is not on PATH")).to_owned();
        path = format!("{path};{folder}");
    }
    let doomed: Vec<String> = std::env::vars().map(|(name, _)| name).filter(|name| name.starts_with("MIXDOG_") && !name.starts_with("MIXDOG_COMPOSED_TEST") && name != "MIXDOG_PG_RUNTIME").collect();
    // SAFETY: each test of this module is a process of its own (`compose_test_support::in_child`), and this runs before it starts a thread.
    unsafe {
        for name in doomed {
            std::env::remove_var(name);
        }
        std::env::set_var("PATH", path);
        std::env::set_var("HOME", home);
        std::env::set_var("USERPROFILE", home);
        std::env::set_var("APPDATA", home.join("AppData").join("Roaming"));
        std::env::set_var("LOCALAPPDATA", home.join("AppData").join("Local"));
        std::env::set_var("NO_PROXY", "127.0.0.1,localhost");
        std::env::set_var("TZ", "UTC");
    }
}

async fn reply(halves: &mut TransportHalves, id: u64) -> Value {
    loop {
        let TransportEvent::Frame(text) = halves.reader.recv().await else { panic!("the connection closed before the reply to {id}") };
        let frame: Value = serde_json::from_str(&text).expect("a frame");
        if frame["id"] == id {
            return frame;
        }
    }
}

/// The ids a request's op takes: lowercase UUIDv7s.
fn op(n: u64) -> String {
    format!("01900000-0000-7000-8000-{n:012}")
}

async fn call(halves: &mut TransportHalves, id: u64, method: &str, params: Value) -> Value {
    halves.writer.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()).await.expect("send");
    let answer = reply(halves, id).await;
    assert!(answer.get("result").is_some(), "{method}: {answer}");
    answer["result"].clone()
}

fn tokenize(value: &mut Value, folders: &[(String, &'static str)], thread: &str, scratch: &str) {
    match value {
        Value::String(text) => {
            let mut out = text.replace(thread, "{SESSION}").replace(scratch, "s.{SCRATCH}");
            for (folder, token) in folders {
                out = out.replace(folder.as_str(), token);
            }
            *text = out;
        }
        Value::Array(items) => items.iter_mut().for_each(|v| tokenize(v, folders, thread, scratch)),
        Value::Object(map) => map.values_mut().for_each(|v| tokenize(v, folders, thread, scratch)),
        _ => {}
    }
}

/// Every place two JSON values differ (key order and array order count), in document order, at most `LIMIT`.
fn differences(path: &str, got: &Value, want: &Value, out: &mut Vec<String>) {
    const LIMIT: usize = 60;
    if out.len() >= LIMIT {
        return;
    }
    match (got, want) {
        (Value::Object(a), Value::Object(b)) => {
            let (ka, kb): (Vec<_>, Vec<_>) = (a.keys().collect(), b.keys().collect());
            if ka != kb {
                out.push(format!("{path}: keys {ka:?} != recorded {kb:?}"));
            }
            for (k, v) in a {
                if let Some(w) = b.get(k) {
                    differences(&format!("{path}.{k}"), v, w, out);
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!("{path}: {} items != recorded {}", a.len(), b.len()));
            }
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                differences(&format!("{path}[{i}]"), x, y, out);
            }
        }
        (Value::String(a), Value::String(b)) if a != b => {
            let (la, lb): (Vec<_>, Vec<_>) = (a.lines().collect(), b.lines().collect());
            if la.len() != lb.len() {
                out.push(format!("{path}: {} lines != recorded {}", la.len(), lb.len()));
            }
            for (i, (x, y)) in la.iter().zip(&lb).enumerate().filter(|(_, (x, y))| x != y) {
                out.push(format!("{path} line {i}:\n    got      {x:?}\n    recorded {y:?}"));
            }
        }
        _ if got != want => out.push(format!("{path}: {got} != recorded {want}")),
        _ => {}
    }
}
async fn replay(name: &str, dir: PathBuf) {
    let golden = golden();
    let case = golden["scenarios"].as_array().expect("scenarios").iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("no recorded scenario {name}"));
    let route = &case["routeSpec"];
    let (provider, model) = (route["provider"].as_str().expect("provider"), route["model"].as_str().expect("model"));
    let home = dir.join("home");
    let ws = dir.join("ws");
    std::fs::create_dir_all(&ws).expect("the workspace");
    let programs: Vec<&str> = case["path"].as_array().expect("path").iter().filter_map(Value::as_str).collect();
    sandbox_env(&home, &programs);
    let data = crate::compose_test_support::data_in(&dir);
    let (port, posts) = endpoint(route["wire"].as_str().expect("wire"), model);

    let mut config = case["config"].clone();
    let providers = json!({ provider: {
        "type": "custom", "schemaVersion": 2, "name": "lead", "protocol": route["protocol"], "baseURL": format!("http://127.0.0.1:{port}/v1"),
        "auth": "none", "enabled": true, "modelOverrides": { model: { "manual": true } },
    } });
    config["agent"]["providers"] = providers;
    // A draft that names no route starts on the model the settings choose.
    let settings_route = case["settingsRoute"] == true;
    if settings_route {
        config["agent"]["default"] = json!("main");
        config["agent"]["presets"] = json!([{ "id": "main", "name": "main", "provider": provider, "model": model }]);
    }
    std::fs::write(data.join("mixdog-config.json"), config.to_string().replace("{DATA}", &slashed(&data))).expect("the settings file");
    let snapshot = json!({ "generation": 1, "models": { provider: [{
        "id": model, "provider": provider, "displayName": null, "rates": {}, "vision": "unknown", "functionCalling": "unknown",
        "reasoning": "unknown", "fastMode": "unknown", "reasoningEfforts": [], "source": "native", "manual": true,
    }] } });
    std::fs::create_dir_all(data.join("catalogs")).expect("the catalog directory");
    std::fs::write(data.join("catalogs").join("snapshot.json"), snapshot.to_string()).expect("the catalog cache");
    put_files(&data, &case["data"], &data);
    put_files(&ws, &case["workspace"], &data);
    if case["gitInit"] == true {
        let made = std::process::Command::new("git").args(["init", "-b", "main"]).current_dir(&ws).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().expect("git runs");
        assert!(made.success(), "git init in the workspace");
    }

    let outgoing = Outgoing::new();
    let core = compose(
        &mixdog_rt::testing::tokens(),
        ComposeConfig {
            data_dir: data.clone(),
            user_data_dir: dir.join("userdata"),
            runtime_root: dir.join("runtime"),
            js_runtime: crate::js_runtime::fixture(&dir),
            ort_library: mixdog_services::effort_judge::model::OrtRuntime::NoBinding,
            outgoing: outgoing.clone(),
            ownership: std::sync::Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()),
            log: crate::daemon_log::DaemonLog::new(dir.join("daemon.log"), mixdog_rt::testing::tokens().maintenance_io, mixdog_rt::CancellationToken::new()),
            stop: mixdog_rt::CancellationToken::new(),
            catalog_http: crate::compose_test_support::offline_http(),
            pg_install: None,
        },
    )
    .await
    .expect("the composed core");
    let (connector, shutdown) = serve_in_process(std::sync::Arc::new(core), outgoing).expect("the in-process server");
    let mut halves = connector.open(&Target { id: "in-process".into() }).await.expect("a connection");
    call(&mut halves, 0, "initialize", json!({ "clientInfo": { "name": "lead-request", "version": env!("CARGO_PKG_VERSION"), "kind": "desktop" }, "capabilities": {} })).await;
    // The desktop's new task: a thread in the project on the draft's route, the route applied, then the first prompt.
    let draft = if settings_route { json!({}) } else { json!({ "route": { "provider": provider, "model": model } }) };
    let started = call(&mut halves, 1, "thread/start", json!({ "opId": op(1), "kind": "project", "projectPath": ws, "draft": draft })).await;
    let thread = started["thread"]["id"].as_str().expect("thread id").to_owned();
    if !settings_route {
        call(&mut halves, 2, "route/set", json!({ "opId": op(2), "threadId": thread, "route": { "provider": provider, "model": model, "applyToCurrentSession": true, "keepMainModel": false } })).await;
    }
    let prompt = format!("{PROMPT_TOKEN} {}", case["prompt"].as_str().expect("prompt"));
    let turn = call(&mut halves, 3, "turn/start", json!({ "opId": op(3), "threadId": thread, "input": { "prompt": prompt } })).await;
    assert_eq!(turn["kind"], "started", "{turn}");

    let wanted = |post: &Post| post.body.to_string().contains(PROMPT_TOKEN);
    let post = tokio::task::spawn_blocking(move || loop {
        match posts.recv_timeout(Duration::from_secs(60)) {
            Ok(post) if wanted(&post) => return post,
            Ok(_) => {}
            Err(error) => panic!("the provider endpoint received no request carrying the prompt within 60 s: {error}"),
        }
    })
    .await
    .expect("the endpoint's wait");
    shutdown.run().await;

    let scratch = format!("s.{}", &Sha256::digest(thread.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>()[..16]);
    let folders: Vec<(String, &'static str)> = [(&data, "{DATA}"), (&ws, "{WS}"), (&home, "{HOME}")]
        .into_iter()
        .flat_map(|(path, token)| [(path.to_string_lossy().into_owned(), token), (slashed(path), token)])
        .collect();
    let mut got = json!({ "url": post.url, "body": post.body });
    tokenize(&mut got, &folders, &thread, &scratch);
    // `LEAD_REQUEST_DUMP=<folder>` keeps the request this side sent, for reading a difference whole.
    if let Some(folder) = std::env::var_os("LEAD_REQUEST_DUMP") {
        std::fs::write(Path::new(&folder).join(format!("{name}.json")), serde_json::to_string_pretty(&got).expect("json")).expect("the dump");
    }
    let recorded = &case["request"];
    let mut found = Vec::new();
    differences("request", &got, recorded, &mut found);
    assert!(found.is_empty(), "{name}: the request differs from Node's in {} place(s):\n{}", found.len(), found.join("\n"));
}

fn runtime() -> tokio::runtime::Builder {
    let mut runtime = tokio::runtime::Builder::new_multi_thread();
    runtime.worker_threads(2);
    runtime
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn default_anthropic() {
    crate::compose_test_support::in_child(module_path!(), "default_anthropic", runtime(), |dir| replay("default-anthropic", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn default_openai() {
    crate::compose_test_support::in_child(module_path!(), "default_openai", runtime(), |dir| replay("default-openai", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn style_detailed() {
    crate::compose_test_support::in_child(module_path!(), "style_detailed", runtime(), |dir| replay("style-detailed", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn style_minimal_openai() {
    crate::compose_test_support::in_child(module_path!(), "style_minimal_openai", runtime(), |dir| replay("style-minimal-openai", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn style_extreme_minimal() {
    crate::compose_test_support::in_child(module_path!(), "style_extreme_minimal", runtime(), |dir| replay("style-extreme-minimal", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn language_korean_with_preferences() {
    crate::compose_test_support::in_child(module_path!(), "language_korean_with_preferences", runtime(), |dir| replay("language-korean-with-preferences", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn language_japanese_junior() {
    crate::compose_test_support::in_child(module_path!(), "language_japanese_junior", runtime(), |dir| replay("language-japanese-junior", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn workflow_headless() {
    crate::compose_test_support::in_child(module_path!(), "workflow_headless", runtime(), |dir| replay("workflow-headless", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn workflow_user_pack() {
    crate::compose_test_support::in_child(module_path!(), "workflow_user_pack", runtime(), |dir| replay("workflow-user-pack", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn orchestration_none() {
    crate::compose_test_support::in_child(module_path!(), "orchestration_none", runtime(), |dir| replay("orchestration-none", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn orchestration_focused_openai() {
    crate::compose_test_support::in_child(module_path!(), "orchestration_focused_openai", runtime(), |dir| replay("orchestration-focused-openai", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn orchestration_swarm() {
    crate::compose_test_support::in_child(module_path!(), "orchestration_swarm", runtime(), |dir| replay("orchestration-swarm", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn skills_present() {
    crate::compose_test_support::in_child(module_path!(), "skills_present", runtime(), |dir| replay("skills-present", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn skills_disabled_by_user() {
    crate::compose_test_support::in_child(module_path!(), "skills_disabled_by_user", runtime(), |dir| replay("skills-disabled-by-user", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn memory_tools_off() {
    crate::compose_test_support::in_child(module_path!(), "memory_tools_off", runtime(), |dir| replay("memory-tools-off", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn web_search_off_openai() {
    crate::compose_test_support::in_child(module_path!(), "web_search_off_openai", runtime(), |dir| replay("web-search-off-openai", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn instruction_files() {
    crate::compose_test_support::in_child(module_path!(), "instruction_files", runtime(), |dir| replay("instruction-files", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn mcp_connected() {
    crate::compose_test_support::in_child(module_path!(), "mcp_connected", runtime(), |dir| replay("mcp-connected", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn user_agents() {
    crate::compose_test_support::in_child(module_path!(), "user_agents", runtime(), |dir| replay("user-agents", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn fresh_profile_nothing_installed() {
    crate::compose_test_support::in_child(module_path!(), "fresh_profile_nothing_installed", runtime(), |dir| replay("fresh-profile-nothing-installed", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn builtins_office_and_tidy_installed() {
    crate::compose_test_support::in_child(module_path!(), "builtins_office_and_tidy_installed", runtime(), |dir| replay("builtins-office-and-tidy-installed", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn git_and_media_modules_off() {
    crate::compose_test_support::in_child(module_path!(), "git_and_media_modules_off", runtime(), |dir| replay("git-and-media-modules-off", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn instruction_files_default() {
    crate::compose_test_support::in_child(module_path!(), "instruction_files_default", runtime(), |dir| replay("instruction-files-default", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn git_repository_workspace() {
    crate::compose_test_support::in_child(module_path!(), "git_repository_workspace", runtime(), |dir| replay("git-repository-workspace", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn settings_route_default() {
    crate::compose_test_support::in_child(module_path!(), "settings_route_default", runtime(), |dir| replay("settings-route-default", dir));
}

#[test]
#[ignore = "integration: composes the real core, which needs a bundled Postgres runtime (MIXDOG_PG_RUNTIME); no network"]
fn settings_route_git_module_off() {
    crate::compose_test_support::in_child(module_path!(), "settings_route_git_module_off", runtime(), |dir| replay("settings-route-git-module-off", dir));
}
