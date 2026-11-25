//! A stdio ACP agent for the integration suite. `--version` prints `FAKE_AGENT_VERSION`; `acp`
//! serves the protocol, and the first word of a prompt chooses what the turn does: `stream`
//! (thought, text, two tool calls, a plan), `permission` (asks before a call), `hang` (works until
//! cancelled), `mute` (answers nothing until cancelled), `background` (ends its turn with a call
//! running, then replies on its own), `read <path>` (reads a file through the client), `whoami`
//! (reports how it was started), `meta` (the `_meta` its session was opened with), and `servers`, `tools`,
//! `tool <name> <json>` and `calls` (several such calls in one turn) (what the session's MCP server hands it).
//! Started with `FAKE_AGENT_OFFICIAL` in its environment it is Google's official ACP server instead: no version
//! flag, its version named in `initialize` alone, no `session/close`, an MCP call named under `_meta.mcp` only, and a
//! prompt of a session it lost answered with -32002.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    clippy::zombie_processes,
    reason = "a plain blocking test process, not a runtime thread: it starts its own children and leaves the one it is asked to leave"
)]

use std::io::BufRead;
use std::io::Write;

use serde_json::Value;
use serde_json::json;

const PERMISSION: u64 = 9001;
const READ: u64 = 9002;
const AFTER_LEFTOVER: u64 = 9003;

#[derive(Default)]
struct Agent {
    session: String,
    resumed: bool,
    loaded: bool,
    append: String,
    model: String,
    client: Value,
    /// The prompt that waits for the client's answer to a request of the agent's.
    asked: Option<Value>,
    /// The prompt that works until it is cancelled.
    hanging: Option<Value>,
    /// The prompt taken and answered nothing until it is cancelled.
    muted: Option<Value>,
    /// A permission was asked for with no prompt open.
    unprompted: bool,
    /// The MCP servers the session was opened or reopened with.
    servers: Value,
    /// The `_meta` the session was opened or reopened with.
    meta: Value,
}

/// The official server's mode: set in the environment it is started with alone, so a CLI started in the same folder
/// is no official server.
fn official() -> bool {
    std::env::var_os("FAKE_AGENT_OFFICIAL").is_some()
}

/// How a call `call` of the tool `name` of the session's MCP server is shown, as `sessionUpdate` `update` with `status`.
fn mcp_call(update: &str, call: &str, name: &str, status: &str, arguments: &Value) -> Value {
    let wire = format!("mcp_mixdog_{name}");
    if official() {
        return json!({
            "sessionUpdate": update, "toolCallId": call, "title": format!("mixdog_{name}"), "kind": "other", "status": status,
            "rawInput": { "arguments": arguments }, "_meta": { "mcp": { "server": "mixdog", "tool": name }, "is_mcp_tool_call": true },
        });
    }
    json!({ "sessionUpdate": update, "toolCallId": call, "name": wire, "title": format!("Run {wire}"), "kind": "other", "status": status, "rawInput": arguments })
}

/// One message to the session's first MCP server and its answer: over HTTP where the entry has a `url`, else
/// through the program the entry names, started for the one message.
fn mcp(server: &Value, message: &Value) -> Value {
    let answer = if let Some(url) = server["url"].as_str() {
        let port: u16 = url.split(':').nth(2).and_then(|rest| rest.split('/').next()).and_then(|port| port.parse().ok()).unwrap();
        let token = server["headers"][0]["value"].as_str().and_then(|value| value.strip_prefix("Bearer ")).unwrap();
        mixdog_acp::mcp_bridge::post(port, token, &message.to_string()).unwrap().unwrap()
    } else {
        let mut command = std::process::Command::new(server["command"].as_str().unwrap());
        command.args(server["args"].as_array().unwrap().iter().filter_map(Value::as_str));
        for variable in server["env"].as_array().unwrap() {
            command.env(variable["name"].as_str().unwrap(), variable["value"].as_str().unwrap());
        }
        let mut child = command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
        writeln!(child.stdin.take().unwrap(), "{message}").unwrap();
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        child.wait().unwrap();
        line
    };
    serde_json::from_str(&answer).unwrap()
}

fn send(message: Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{message}").unwrap();
    out.flush().unwrap();
}

/// A setting of the fake: the environment variable, else its `NAME=value` line in `fake-agent.env` of the
/// folder it was started in (the runs a client starts with no environment of its own).
fn setting(name: &str) -> Option<String> {
    std::env::var(name).ok().or_else(|| {
        let file = std::fs::read_to_string("fake-agent.env").ok()?;
        file.lines().find_map(|line| line.strip_prefix(name)?.strip_prefix('=').map(str::to_owned))
    })
}

fn signed_out() -> bool {
    let there = |file: String| std::path::Path::new(&file).exists();
    setting("FAKE_AGENT_SIGNED_OUT_FILE").is_some_and(there)
        || (setting("FAKE_AGENT_SIGNED_OUT").is_some() && !setting("FAKE_AGENT_SIGNED_IN_FILE").is_some_and(there))
}

fn log(line: &str) {
    if let Some(path) = setting("FAKE_AGENT_LOG") {
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        writeln!(file, "{line}").unwrap();
    }
}

fn answer(id: &Value, result: Value) {
    send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
}

/// A call's arguments: the first JSON value of `text`, `{}` where it holds none. What the client added behind the prompt
/// is not theirs.
fn first_json(text: &str) -> Value {
    serde_json::Deserializer::from_str(text).into_iter::<Value>().next().and_then(Result::ok).unwrap_or_else(|| json!({}))
}

impl Agent {
    /// A session opened or reopened with `params`: what it was given is kept, and the agent connects to the first MCP
    /// server it was handed before it answers (`FAKE_AGENT_NO_MCP`: an agent that never connects to one).
    fn opened(&mut self, params: &Value) {
        self.servers = params["mcpServers"].clone();
        self.meta = params["_meta"].clone();
        self.append = params["_meta"]["antigravity"]["systemPrompt"]["append"].as_str().unwrap_or_default().to_owned();
        if !self.servers[0].is_null() && setting("FAKE_AGENT_NO_MCP").is_none() && setting("FAKE_AGENT_LATE_MCP").is_none() {
            self.connect();
        }
    }

    fn connect(&self) {
        mcp(&self.servers[0], &json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {} } }));
    }

    fn update(&self, update: Value) {
        send(json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": self.session, "update": update } }));
    }

    fn say(&self, text: &str) {
        self.update(json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } }));
    }

    fn end(&self, id: &Value) {
        answer(id, json!({ "stopReason": "end_turn", "usage": { "inputTokens": 10, "outputTokens": 5, "cachedReadTokens": 2 } }));
    }

    /// Calls the server's tool `name` with `arguments` as the agent's call `call`, which it reports as its own under the
    /// name its wire gives an MCP server's tool: what it says of the answer (`result:` or `error:`, the texts, ` images=N`)
    /// and the answer's texts.
    fn call_tool(&self, call: &str, name: &str, arguments: Value) -> (String, String) {
        self.update(mcp_call("tool_call", call, name, "in_progress", &arguments));
        let answer = mcp(&self.servers[0], &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": name, "arguments": arguments } }));
        self.update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": call, "status": "completed" }));
        let result = &answer["result"];
        let said = if result["isError"] == true { "error" } else { "result" };
        let texts = result["content"].as_array().into_iter().flatten().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("\n");
        let pictures = result["content"].as_array().into_iter().flatten().filter(|block| block["type"] == "image").count();
        let pictures = if pictures == 0 { String::new() } else { format!(" images={pictures}") };
        (format!("{said}:{texts}{pictures}"), texts)
    }

    /// Asks the client's permission for the call `call` with `options`; the prompt `id` ends with the answer.
    fn ask(&mut self, id: Value, call: Value, options: Value) {
        self.update(call.clone());
        send(json!({
            "jsonrpc": "2.0", "id": PERMISSION, "method": "session/request_permission",
            "params": { "sessionId": self.session, "toolCall": call, "options": options },
        }));
        self.asked = Some(id);
    }

    /// The prompt's last text block chooses what the turn does, by its first word; the text blocks before it are
    /// what the client sent ahead of the user's own.
    fn prompt(&mut self, id: Value, blocks: &Value) {
        let blocks: Vec<&Value> = blocks.as_array().into_iter().flatten().collect();
        let texts: Vec<&str> = blocks.iter().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect();
        let images = blocks.iter().filter(|block| block["type"] == "image").count();
        let (text, lead) = texts.split_last().map_or(("", Vec::new()), |(last, lead)| (*last, lead.to_vec()));
        let (word, rest) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
        // `FAKE_AGENT_LATE_MCP`: an agent whose connection to its session's MCP server is made after the session opened.
        if setting("FAKE_AGENT_LATE_MCP").is_some() && !self.servers[0].is_null() {
            self.connect();
        }
        let once_or_no = json!([{ "optionId": "once", "name": "Allow", "kind": "allow_once" }, { "optionId": "no", "name": "Reject", "kind": "reject_once" }]);
        match word {
            // A command of the agent's own whose title holds the name of a Mixdog tool.
            "titled" => {
                let call = json!({
                    "sessionUpdate": "tool_call", "toolCallId": "p1", "name": "run_command", "title": "ls mcp_mixdog_read", "kind": "execute", "status": "pending",
                    "rawInput": { "CommandLine": "ls mcp_mixdog_read" },
                });
                self.ask(id, call, once_or_no);
            }
            // The agent's question about its call of the session's tool `rest`.
            "asktool" => {
                let call = mcp_call("tool_call", "p1", rest, "pending", &json!({}));
                self.ask(id, call, once_or_no);
            }
            // The agent's question about a read of the files `rest` names with a tool of its own.
            "askread" => {
                let locations: Vec<Value> = rest.split_whitespace().map(|path| json!({ "path": path })).collect();
                let call = json!({
                    "sessionUpdate": "tool_call", "toolCallId": "p1", "name": "read_file", "title": format!("Read {rest}"), "kind": "read", "status": "pending",
                    "locations": locations, "rawInput": {},
                });
                self.ask(id, call, once_or_no);
            }
            // The agent's question about a command of its own whose command line is `rest`; with none it names no command.
            "askrun" => {
                let input = if rest.is_empty() { json!({}) } else { json!({ "command": rest }) };
                let call = json!({ "sessionUpdate": "tool_call", "toolCallId": "p1", "name": "run_command", "title": "Run it", "kind": "execute", "status": "pending", "rawInput": input });
                self.ask(id, call, once_or_no);
            }
            // What the prompt carried besides text and images: its resources and its links, as they were sent.
            "files" => {
                let files: Vec<Value> =
                    blocks.iter().filter(|block| block["type"] == "resource" || block["type"] == "resource_link").map(|block| (*block).clone()).collect();
                self.say(&format!("files={} lead={}", Value::Array(files), lead.join("|")));
                self.end(&id);
            }
            // A question that offers no answer for one call.
            "lasting" => {
                let name = if rest.is_empty() { "run_command".to_owned() } else { format!("mcp_mixdog_{rest}") };
                let call = json!({ "sessionUpdate": "tool_call", "toolCallId": "p1", "name": name, "title": "Delete build", "kind": "execute", "status": "pending", "rawInput": {} });
                let options = json!([{ "optionId": "always", "name": "Always allow", "kind": "allow_always" }, { "optionId": "no", "name": "Reject", "kind": "reject_once" }]);
                self.ask(id, call, options);
            }
            // A failure of its own, told as `agy` tells it: the notice `rest` as a text chunk, and the prompt closed with
            // no usage.
            "notice" => {
                self.say(&format!("\n⚠ {rest}\n"));
                answer(&id, json!({ "stopReason": "end_turn" }));
            }
            // A chunk in the form of its own notice of a failure, and the reply going on after it.
            "warnfirst" => {
                self.say("\n⚠ Model produced invalid output.\n");
                self.say("four");
                self.end(&id);
            }
            // A reply that ends on a warning in the form of its own notice of a failure, answered with usage.
            "warnlast" => {
                self.say("Done.");
                self.say("\n⚠ Warning: the tests were skipped.\n");
                self.end(&id);
            }
            // A prompt of a session it no longer holds, answered as `agy` answers one.
            "lost" => {
                let (code, message) = if official() { (-32002, "Resource not found") } else { (-32602, "Session not found") };
                send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": format!("{message}: {}", self.session) } }));
            }
            "meta" => {
                self.say(&format!("meta={}", self.meta));
                self.end(&id);
            }
            // The whole reply of an account that may not use the agent.
            "suspended" => {
                self.say("This service has been disabled in this account for violation of Terms of Service.");
                self.end(&id);
            }
            "stream" => {
                self.update(json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "thinking" } }));
                self.say("Hello");
                self.say(" world");
                self.update(
                    json!({ "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Run tests", "kind": "execute", "status": "in_progress", "rawInput": { "command": "npm test" } }),
                );
                self.update(
                    json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "content": [{ "type": "content", "content": { "type": "text", "text": "ok" } }] }),
                );
                self.update(json!({
                    "sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Edit a.txt", "kind": "edit", "status": "completed",
                    "content": [{ "type": "diff", "path": "a.txt", "oldText": "one\n", "newText": "two\n" }],
                }));
                self.update(json!({
                    "sessionUpdate": "plan",
                    "entries": [{ "content": "first", "priority": "high", "status": "completed" }, { "content": "second", "priority": "low", "status": "in_progress" }],
                }));
                self.say("Done.");
                self.update(json!({ "sessionUpdate": "usage_update", "used": 100, "size": 1000 }));
                self.end(&id);
            }
            // Asks about a call of its own tool `rest` (`run_command` when the prompt names none); `delete_file` is a deletion.
            "permission" => {
                // What the client added behind the prompt is no tool's name.
                let name = rest.split_whitespace().next().filter(|word| word.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).unwrap_or("run_command");
                let kind = if name == "delete_file" { "delete" } else { "execute" };
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "p1", "name": name, "title": "Delete build", "kind": kind, "status": "pending", "rawInput": { "command": "rm -rf build" } }));
                send(json!({
                    "jsonrpc": "2.0", "id": PERMISSION, "method": "session/request_permission",
                    "params": {
                        "sessionId": self.session,
                        "toolCall": { "toolCallId": "p1" },
                        "options": [
                            { "optionId": "once", "name": "Allow", "kind": "allow_once" },
                            { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
                            { "optionId": "no", "name": "Reject", "kind": "reject_once" },
                        ],
                    },
                }));
                self.asked = Some(id);
            }
            // A report, then a last call of the agent's own, and the turn's end with no text after it.
            "report" => {
                self.say("The report.");
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "r1", "title": "Save notes", "kind": "edit", "status": "completed" }));
                self.end(&id);
            }
            "mute" => self.muted = Some(id),
            "hang" => {
                self.say("working");
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "h1", "title": "Long build", "kind": "execute", "status": "in_progress" }));
                self.hanging = Some(id);
            }
            "background" => {
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "b1", "title": "Dev build", "kind": "execute", "status": "in_progress" }));
                self.say("started");
                self.end(&id);
                self.update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": "b1", "status": "completed" }));
                self.say("woke");
                self.update(json!({ "sessionUpdate": "usage_update", "used": 120, "size": 1000 }));
            }
            // The process ends in the middle of a turn, a call open.
            "die" => {
                self.say("going");
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "d1", "title": "Half done", "kind": "execute", "status": "in_progress" }));
                std::process::exit(1);
            }
            // A line that is no message, among the ones that are.
            "garbage" => {
                println!("warning: this line is not JSON");
                self.say("fine");
                self.end(&id);
            }
            // Ends its turn, then asks for a permission on its own and goes on once it is answered.
            "selfask" => {
                self.say("asked");
                self.end(&id);
                self.unprompted = true;
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "s1", "title": "Clean up", "kind": "execute", "status": "pending" }));
                send(json!({
                    "jsonrpc": "2.0", "id": PERMISSION, "method": "session/request_permission",
                    "params": { "sessionId": self.session, "toolCall": { "toolCallId": "s1" }, "options": [{ "optionId": "once", "name": "Allow", "kind": "allow_once" }] },
                }));
            }
            // What the session was handed: its MCP servers, the tools the first one lists, and a call of one.
            "servers" => {
                self.say(&format!("servers={}", self.servers));
                self.end(&id);
            }
            // The agent definition the CLI finds in the folder it was started in.
            "definition" => {
                let text = std::fs::read_to_string(".agents/agents/mixdog/agent.md").unwrap_or_default();
                self.say(&format!("definition={text}"));
                self.end(&id);
            }
            "tools" => {
                let listed = mcp(&self.servers[0], &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
                let names: Vec<&str> = listed["result"]["tools"].as_array().into_iter().flatten().filter_map(|tool| tool["name"].as_str()).collect();
                self.say(&format!("tools={}", names.join(",")));
                self.end(&id);
            }
            "tool" => {
                let (name, arguments) = rest.split_once(' ').unwrap_or((rest, "{}"));
                let (said, _) = self.call_tool("m1", name, first_json(arguments));
                self.say(&said);
                self.end(&id);
            }
            // Calls of the server's tools made one after another in one turn, `<name> <json>` each, separated by ` ;; `:
            // `$TASK` in a call's arguments is the `task_id` the answer before it named. Says what `tool` says of each, one
            // per line.
            "calls" => {
                let (mut said, mut task) = (Vec::new(), String::new());
                for (n, call) in rest.split(" ;; ").enumerate() {
                    let call = call.replace("$TASK", &task);
                    let (name, arguments) = call.split_once(' ').unwrap_or((call.as_str(), "{}"));
                    let (line, texts) = self.call_tool(&format!("m{}", n + 1), name, first_json(arguments));
                    if let Some(named) = texts.lines().find_map(|line| line.strip_prefix("task_id: ")) {
                        task = named.to_owned();
                    }
                    said.push(line);
                }
                self.say(&said.join("\n"));
                self.end(&id);
            }
            "read" => {
                send(json!({ "jsonrpc": "2.0", "id": READ, "method": "fs/read_text_file", "params": { "sessionId": self.session, "path": rest } }));
                self.asked = Some(id);
            }
            _ => {
                let fs = &self.client["fs"];
                self.say(&format!(
                    "session={} resumed={} loaded={} append={} model={} read={} write={} terminal={} lead={} images={images}",
                    self.session,
                    self.resumed,
                    self.loaded,
                    self.append,
                    self.model,
                    fs["readTextFile"],
                    fs["writeTextFile"],
                    self.client["terminal"],
                    lead.join("|")
                ));
                self.end(&id);
            }
        }
    }

    /// The client's answer to a request of the agent's.
    fn answered(&mut self, id: u64, message: &Value) {
        if std::mem::take(&mut self.unprompted) {
            self.say("leftover");
            self.update(json!({ "sessionUpdate": "usage_update", "used": 130, "size": 1000 }));
            // A request behind what it said: the client's answer to it tells that the client has read all of the above.
            send(json!({ "jsonrpc": "2.0", "id": AFTER_LEFTOVER, "method": "fs/read_text_file", "params": { "sessionId": self.session, "path": "" } }));
            return;
        }
        if id == AFTER_LEFTOVER {
            log("leftover read");
            return;
        }
        let Some(prompt) = self.asked.take() else { return };
        match id {
            PERMISSION => {
                let outcome = &message["result"]["outcome"];
                let selected = outcome["outcome"] == "selected";
                self.update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": "p1", "status": if selected { "completed" } else { "failed" } }));
                self.say(&if selected { format!("option:{}", outcome["optionId"].as_str().unwrap_or_default()) } else { "cancelled".to_owned() });
            }
            _ => match message.get("error") {
                Some(error) => self.say(&format!("error:{}", error["message"].as_str().unwrap_or_default())),
                None => self.say(&format!("read:{}", message["result"]["content"].as_str().unwrap_or_default())),
            },
        }
        self.end(&prompt);
    }

    fn handle(&mut self, message: &Value) {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let params = &message["params"];
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            if let Some(id) = id.as_u64() {
                self.answered(id, message);
            }
            return;
        };
        log(method);
        match method {
            "initialize" => {
                self.client = params["clientCapabilities"].clone();
                answer(
                    &id,
                    json!({
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": true,
                            // `FAKE_AGENT_STDIO_MCP`: an agent that starts its MCP servers as programs only.
                            "mcpCapabilities": { "http": setting("FAKE_AGENT_STDIO_MCP").is_none() },
                            // `FAKE_AGENT_EMBEDDED`: an agent that takes a file's text as an embedded resource.
                            "promptCapabilities": { "image": setting("FAKE_AGENT_NO_IMAGES").is_none(), "embeddedContext": setting("FAKE_AGENT_EMBEDDED").is_some() },
                            "sessionCapabilities": if official() { json!({ "resume": {} }) } else { json!({ "resume": {}, "close": {} }) },
                            // `FAKE_AGENT_NO_LOGOUT`: an agent that cannot be signed out through the protocol.
                            "auth": if setting("FAKE_AGENT_NO_LOGOUT").is_some() { json!({}) } else { json!({ "logout": {} }) },
                            // `FAKE_AGENT_NO_APPEND`: an agent whose system prompt takes nothing from its client.
                            "_meta": { "antigravity": { "systemPrompt": { "append": setting("FAKE_AGENT_NO_APPEND").is_none() } } },
                        },
                        "agentInfo": { "name": "fake", "version": version() },
                    }),
                );
            }
            "session/new" if signed_out() => {
                send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "Authentication required" } }));
            }
            // A CLI that hangs: the request is never answered.
            "session/new" if setting("FAKE_AGENT_SILENT_NEW").is_some() => {}
            "session/close" => answer(&id, json!({})),
            // The protocol's sign-out: the CLI forgets its own sign-in (`FAKE_AGENT_SIGNED_OUT_FILE` says it did).
            "logout" => {
                if let Some(file) = setting("FAKE_AGENT_SIGNED_OUT_FILE") {
                    std::fs::write(file, "signed out").unwrap();
                }
                answer(&id, json!({}));
            }
            "session/new" => {
                self.session = "sess-1".to_owned();
                self.model = "m1".to_owned();
                self.opened(params);
                answer(
                    &id,
                    json!({
                        "sessionId": self.session,
                        // `FAKE_AGENT_MODELS`: the models listed (a JSON array of `{modelId, name}`) in place of the two.
                        // `FAKE_AGENT_PLAN`: the plan the signed-in account is on.
                        "_meta": { "antigravity": { "tier": setting("FAKE_AGENT_PLAN").map_or(Value::Null, |name| json!({ "name": name, "id": "a-tier" })) } },
                        "models": { "currentModelId": "m1", "availableModels": setting("FAKE_AGENT_MODELS").and_then(|listed| serde_json::from_str::<Value>(&listed).ok()).unwrap_or_else(|| json!([{ "modelId": "m1", "name": "Model One" }, { "modelId": "m2", "name": "Model Two" }])) },
                    }),
                );
            }
            "session/resume" | "session/load" => {
                self.session = params["sessionId"].as_str().unwrap_or_default().to_owned();
                self.opened(params);
                self.resumed = method == "session/resume";
                self.loaded = method == "session/load";
                answer(&id, json!({}));
            }
            // A model request that is never answered.
            "session/set_model" if setting("FAKE_AGENT_SILENT_MODEL").is_some() => {}
            // A model it does not have, refused as `agy` refuses one.
            "session/set_model" if params["modelId"] == "refused" => {
                send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": "Unknown model ID: refused" } }));
            }
            "session/set_model" => {
                self.model = params["modelId"].as_str().unwrap_or_default().to_owned();
                answer(&id, json!({}));
            }
            "session/prompt" => self.prompt(id, &params["prompt"]),
            "session/cancel" => {
                if let Some(prompt) = self.hanging.take() {
                    self.update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": "h1", "status": "failed" }));
                    answer(&prompt, json!({ "stopReason": "cancelled" }));
                }
                if let Some(prompt) = self.muted.take() {
                    answer(&prompt, json!({ "stopReason": "cancelled" }));
                }
            }
            _ if !id.is_null() => send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "method not found" } })),
            _ => {}
        }
    }
}

/// The version an `update` left, else the one the fake was set to.
fn version() -> String {
    let updated = setting("FAKE_AGENT_VERSION_FILE").and_then(|file| std::fs::read_to_string(file).ok());
    let shipped = if official() { "1.5.2" } else { "1.5.1" };
    updated.or_else(|| setting("FAKE_AGENT_VERSION")).unwrap_or_else(|| shipped.to_owned()).trim().to_owned()
}

/// `update`: moves to `FAKE_AGENT_UPDATE_TO`, or fails as `FAKE_AGENT_UPDATE_FAILS` says.
fn update() {
    log("update");
    if let Some(why) = setting("FAKE_AGENT_UPDATE_FAILS") {
        eprintln!("{why}");
        std::process::exit(3);
    }
    if let (Some(to), Some(file)) = (setting("FAKE_AGENT_UPDATE_TO"), setting("FAKE_AGENT_VERSION_FILE")) {
        std::fs::write(file, to).unwrap();
    }
}

/// `install-into <file>`: the installer, which puts this program at `<file>`.
fn install(file: &str) {
    log("install");
    // An installer that never ends.
    if setting("FAKE_AGENT_INSTALL_HANGS").is_some() {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
    if let Some(why) = setting("FAKE_AGENT_INSTALL_FAILS") {
        eprintln!("{why}");
        std::process::exit(1);
    }
    let file = std::path::Path::new(file);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::copy(std::env::current_exe().unwrap(), file).unwrap();
}

/// `acp --login`: prints the page to open, reads the code it shows and signs in with the right one.
fn login() {
    log("login");
    println!("Open the following link to sign in:");
    println!("\u{1b}[1mhttps://accounts.example/o/oauth2/auth?state=fake\u{1b}[0m");
    print!("Enter the authorization code: ");
    std::io::stdout().flush().unwrap();
    let mut code = String::new();
    std::io::stdin().lock().read_line(&mut code).unwrap();
    if code.trim() != "good-code" {
        eprintln!("The code was not accepted.");
        std::process::exit(1);
    }
    if let Some(file) = setting("FAKE_AGENT_SIGNED_IN_FILE") {
        std::fs::write(file, "signed in").unwrap();
    }
    if let Some(file) = setting("FAKE_AGENT_SIGNED_OUT_FILE") {
        let _ = std::fs::remove_file(file);
    }
}

fn main() {
    run(std::env::args().skip(1).collect());
}

/// The program, given its arguments: a test binary that is its own fake agent runs it on the arguments it was started with.
pub fn run(args: Vec<String>) {
    // The official server has no version flag: it refuses one it does not know.
    if official() && args.iter().any(|arg| arg == "--version") {
        log("version");
        eprintln!("unknown flag: --version");
        std::process::exit(1);
    }
    if official() {
        let variable = |name: &str| std::env::var(name).unwrap_or_default();
        log(&format!(
            "official args={} GEMINI_HOME={} AGY_ACP_FORCE_FILE_STORAGE={}",
            args.join(" "),
            variable("GEMINI_HOME"),
            variable("AGY_ACP_FORCE_FILE_STORAGE")
        ));
    }
    if args.iter().any(|arg| arg == "--version") {
        log("version");
        println!("{}", version());
        return;
    }
    // The `/usage` command in print mode: the account's quota (`FAKE_AGENT_USAGE`: the report's `command.data`), or
    // the command's failure (`FAKE_AGENT_USAGE_FAILS`).
    if args.iter().any(|arg| arg == "/usage") {
        log("usage");
        if let Some(why) = setting("FAKE_AGENT_USAGE_FAILS") {
            println!("{}", json!({ "status": "ERROR", "error": why }));
            std::process::exit(1);
        }
        let data: Value = setting("FAKE_AGENT_USAGE").and_then(|data| serde_json::from_str(&data).ok()).unwrap_or_else(|| {
            json!({ "groups": [{ "name": "Gemini Models", "buckets": [
                { "id": "gemini-weekly", "name": "Weekly Limit Remaining", "window": "weekly", "remaining_fraction": 0.75, "reset_time": "2030-01-08T00:00:00Z" },
                { "id": "gemini-5h", "name": "Five Hour Limit Remaining", "window": "5h", "remaining_fraction": 0.5, "reset_time": "2030-01-01T05:00:00Z" },
            ] }] })
        });
        println!("{}", json!({ "conversation_id": "", "status": "SUCCESS", "num_turns": 0, "command": { "name": "usage", "data": data } }));
        return;
    }
    match args.first().map(String::as_str) {
        // A child of the agent: it does nothing until its process tree is ended.
        Some("idle") => loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        },
        // The stdio end of a session's tool server, as the daemon's own program runs it.
        Some("mcp-bridge") => return mixdog_acp::mcp_bridge::run().unwrap(),
        Some("update") => return update(),
        Some("install-into") => return install(&args[1]),
        Some("acp") if args.iter().any(|arg| arg == "--login") => return login(),
        _ => {}
    }
    log("start acp");
    // `FAKE_AGENT_CHILD_PID_FILE`: the agent has a child of its own, whose pid it writes there.
    if let Some(file) = setting("FAKE_AGENT_CHILD_PID_FILE") {
        let child = std::process::Command::new(std::env::current_exe().unwrap()).arg("idle").spawn().unwrap();
        std::fs::write(file, child.id().to_string()).unwrap();
    }
    let mut agent = Agent::default();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if let Ok(message) = serde_json::from_str::<Value>(&line) {
            agent.handle(&message);
        }
    }
}
