//! A stdio ACP agent for the integration suite. `--version` prints `FAKE_AGENT_VERSION`; `acp`
//! serves the protocol, and the first word of a prompt chooses what the turn does: `stream`
//! (thought, text, two tool calls, a plan), `permission` (asks before a call), `hang` (works until
//! cancelled), `mute` (answers nothing until cancelled), `background` (ends its turn with a call
//! running, then replies on its own), `read <path>` (reads a file through the client), `whoami`
//! (reports how it was started), `meta` (the `_meta` its session was opened with), and `servers`, `tools`,
//! `tool <name> <json>` and `calls` (several such calls in one turn) (what the session's MCP server hands it), `cwd`
//! (the folder the session was opened in), `readas <session id or -> <path>` (a read that names another session, or
//! none) and `askas <session id>` (a question about a call that names another session). It holds any number of
//! sessions, each its own: what it sends of one names that one.
//! Started with `FAKE_AGENT_OFFICIAL` in its environment it is Google's official ACP server instead: no version
//! flag, its version named in `initialize` alone, no `session/close`, an MCP call named under `_meta.mcp` only, a
//! prompt of a session it lost answered with -32002, every session-scoped method logged again with the session's id,
//! its temporary folder logged (and, where it is one of Mixdog's, unpacked into as the server's build unpacks itself), and
//! the end of its input logged before it exits. `FAKE_AGENT_FORGETS` has it refuse to resume a session it does not hold.
//! Its sign-in is the files of its home (`GEMINI_HOME`): `authenticate` names the sign-in page on its stderr and writes
//! them, `logout` removes the credential, and with no credential `session/new` asks for a sign-in in the browser as
//! `authenticate` does, and answers nothing.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    clippy::zombie_processes,
    reason = "a plain blocking test process, not a runtime thread: it starts its own children and leaves the one it is asked to leave"
)]

use std::collections::HashMap;
use std::io::BufRead;
use std::io::Write;

use serde_json::Value;
use serde_json::json;

/// What a request of the agent's to the client is.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Asked {
    Permission,
    Read,
    AfterLeftover,
}

#[derive(Default)]
struct Session {
    id: String,
    resumed: bool,
    loaded: bool,
    append: String,
    model: String,
    cwd: String,
    /// The prompt that waits for the client's answer to a request of the agent's.
    asked: Option<Value>,
    /// The prompt that works until it is cancelled.
    hanging: Option<Value>,
    /// The prompt taken and answered nothing until it is cancelled.
    muted: Option<Value>,
    /// A call a turn left running, which ends when the next cancelled prompt is cancelled.
    kept: Option<String>,
    /// The session took a prompt.
    prompted: bool,
    /// The MCP servers the session was opened or reopened with.
    servers: Value,
    /// The `_meta` the session was opened or reopened with.
    meta: Value,
}

#[derive(Default)]
struct Agent {
    client: Value,
    sessions: HashMap<String, Session>,
    /// How many sessions it opened: the next one is numbered after them.
    numbered: u64,
    /// The session the message being handled is of.
    current: String,
    /// The requests of the agent's the client has not answered, each with its session.
    requests: HashMap<u64, (String, Asked)>,
    next_request: u64,
    /// A permission was asked for with no prompt open, in this session.
    unprompted: Option<String>,
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

/// The line the official server writes on its stderr, the page to sign in on after it, whenever it asks for a sign-in.
const SIGN_IN_LINE: &str = "Open the following link to authenticate the ACP server: https://accounts.example/o/oauth2/auth?state=acp";

/// `FAKE_AGENT_NEW_UNTIL` (a session opens), `FAKE_AGENT_LOGOUT_UNTIL` (a sign-out answers): what the setting `name`
/// holds back waits until the file it names is there.
fn wait_for(name: &str) {
    if let Some(file) = setting(name) {
        while !std::path::Path::new(&file).exists() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

/// A file of the official server's home (`GEMINI_HOME`), under its own folder there.
fn home_file(name: &str) -> std::path::PathBuf {
    std::path::Path::new(&std::env::var("GEMINI_HOME").unwrap_or_default()).join("antigravity-acp").join(name)
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
    /// The session the message being handled is of.
    fn session(&mut self) -> &mut Session {
        let id = self.current.clone();
        self.sessions.entry(id.clone()).or_insert_with(|| Session { id, ..Session::default() })
    }

    fn held(&self) -> &Session {
        self.sessions.get(&self.current).expect("the session being handled")
    }

    /// A request of the agent's about the current session, sent with a number of its own.
    fn request(&mut self, method: &str, mut params: Value, what: Asked, named: bool) -> u64 {
        self.next_request += 1;
        let id = 9000 + self.next_request;
        self.requests.insert(id, (self.current.clone(), what));
        if named {
            params["sessionId"] = json!(self.current);
        }
        send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        id
    }

    /// A session opened or reopened with `params`: what it was given is kept, and the agent connects to the first MCP
    /// server it was handed before it answers (`FAKE_AGENT_NO_MCP`: an agent that never connects to one).
    fn opened(&mut self, params: &Value) {
        let session = self.session();
        session.servers = params["mcpServers"].clone();
        session.meta = params["_meta"].clone();
        session.cwd = params["cwd"].as_str().unwrap_or_default().to_owned();
        session.append = params["_meta"]["antigravity"]["systemPrompt"]["append"].as_str().unwrap_or_default().to_owned();
        if !session.servers[0].is_null() && setting("FAKE_AGENT_NO_MCP").is_none() && setting("FAKE_AGENT_LATE_MCP").is_none() {
            self.connect();
        }
    }

    fn connect(&self) {
        mcp(
            &self.held().servers[0],
            &json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {} } }),
        );
    }

    fn update(&self, update: Value) {
        send(json!({ "jsonrpc": "2.0", "method": "session/update", "params": { "sessionId": self.current, "update": update } }));
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
        let answer =
            mcp(&self.held().servers[0], &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": name, "arguments": arguments } }));
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
        self.request("session/request_permission", json!({ "toolCall": call, "options": options }), Asked::Permission, true);
        self.session().asked = Some(id);
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
        // A prompt of a session it never opened is taken as one of a session it holds.
        if !self.session().servers[0].is_null() && setting("FAKE_AGENT_LATE_MCP").is_some() {
            self.connect();
        }
        self.session().prompted = true;
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
                send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": format!("{message}: {}", self.current) } }));
            }
            "meta" => {
                self.say(&format!("meta={}", self.held().meta));
                self.end(&id);
            }
            "cwd" => {
                self.say(&format!("cwd={}", self.held().cwd));
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
                let options = json!([
                    { "optionId": "once", "name": "Allow", "kind": "allow_once" },
                    { "optionId": "always", "name": "Always allow", "kind": "allow_always" },
                    { "optionId": "no", "name": "Reject", "kind": "reject_once" },
                ]);
                self.request("session/request_permission", json!({ "toolCall": { "toolCallId": "p1" }, "options": options }), Asked::Permission, true);
                self.session().asked = Some(id);
            }
            // A report, then a last call of the agent's own, and the turn's end with no text after it.
            "report" => {
                self.say("The report.");
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "r1", "title": "Save notes", "kind": "edit", "status": "completed" }));
                self.end(&id);
            }
            "mute" => self.session().muted = Some(id),
            // A turn that ends with a call left running, which ends when a muted prompt is cancelled.
            "keep" => {
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "k1", "title": "Watch", "kind": "execute", "status": "in_progress" }));
                self.say("kept");
                self.end(&id);
                self.session().kept = Some("k1".to_owned());
            }
            // An error answered to no request, as an agent answers a line it could not parse, and the turn going on.
            "nullerror" => {
                send(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }));
                self.say("fine");
                self.end(&id);
            }
            // The process's last words on both its outputs, with no end of line after them, and its exit.
            "lastword" => {
                eprint!("the last stderr words");
                std::io::stderr().flush().unwrap();
                print!("{}", json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": "out of words" } }));
                std::io::stdout().flush().unwrap();
                std::process::exit(1);
            }
            // A stderr line far longer than any the client tells whole.
            "noisy" => {
                eprintln!("{}", "x".repeat(100_000));
                self.say("noisy");
                self.end(&id);
            }
            // A report of its context made after the prompt's answer.
            "latereport" => {
                self.say("done");
                self.end(&id);
                self.update(json!({ "sessionUpdate": "usage_update", "used": 300, "size": 2000 }));
            }
            // The agent puts itself on the model `<model>` (at `<level>`), and tells its config options.
            "switch" => {
                let (model, level) = rest.split_once(' ').map_or((rest, None), |(model, level)| (model, Some(level)));
                self.session().model = level.map_or_else(|| model.to_owned(), |level| format!("{model}-{level}"));
                let mut options = vec![json!({ "id": "model", "category": "model", "type": "select", "currentValue": model, "options": [{ "value": model }] })];
                if let Some(level) = level {
                    options.push(json!({ "id": "thought_level", "category": "thought_level", "type": "select", "currentValue": level, "options": [{ "value": level }] }));
                }
                self.update(json!({ "sessionUpdate": "config_option_update", "configOptions": options }));
                self.say("switched");
                self.end(&id);
            }
            "hang" => {
                self.say("working");
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "h1", "title": "Long build", "kind": "execute", "status": "in_progress" }));
                self.session().hanging = Some(id);
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
                self.unprompted = Some(self.current.clone());
                self.update(json!({ "sessionUpdate": "tool_call", "toolCallId": "s1", "title": "Clean up", "kind": "execute", "status": "pending" }));
                let params = json!({ "toolCall": { "toolCallId": "s1" }, "options": [{ "optionId": "once", "name": "Allow", "kind": "allow_once" }] });
                self.request("session/request_permission", params, Asked::Permission, true);
            }
            // What the session was handed: its MCP servers, the tools the first one lists, and a call of one.
            "servers" => {
                self.say(&format!("servers={}", self.held().servers));
                self.end(&id);
            }
            // The agent definition the CLI finds in the folder it was started in.
            "definition" => {
                let text = std::fs::read_to_string(".agents/agents/mixdog/agent.md").unwrap_or_default();
                self.say(&format!("definition={text}"));
                self.end(&id);
            }
            "tools" => {
                let listed = mcp(&self.held().servers[0], &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
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
                self.request("fs/read_text_file", json!({ "path": rest }), Asked::Read, true);
                self.session().asked = Some(id);
            }
            // A question about a call that names the session `<id>`.
            "askas" => {
                self.request(
                    "session/request_permission",
                    json!({ "sessionId": rest, "toolCall": { "toolCallId": "p1" }, "options": once_or_no }),
                    Asked::Permission,
                    false,
                );
                self.session().asked = Some(id);
            }
            // A read that names the session `<id>`, or none for `-`.
            "readas" => {
                let (named, path) = rest.split_once(' ').unwrap_or((rest, ""));
                let params = if named == "-" { json!({ "path": path }) } else { json!({ "sessionId": named, "path": path }) };
                self.request("fs/read_text_file", params, Asked::Read, false);
                self.session().asked = Some(id);
            }
            _ => {
                let fs = &self.client["fs"];
                let session = self.held();
                self.say(&format!(
                    "session={} resumed={} loaded={} append={} model={} read={} write={} terminal={} lead={} images={images}",
                    session.id,
                    session.resumed,
                    session.loaded,
                    session.append,
                    session.model,
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
        let Some((session, what)) = self.requests.remove(&id) else { return };
        if let Some(unprompted) = self.unprompted.take() {
            self.current = unprompted;
            self.say("leftover");
            self.update(json!({ "sessionUpdate": "usage_update", "used": 130, "size": 1000 }));
            // A request behind what it said: the client's answer to it tells that the client has read all of the above.
            self.request("fs/read_text_file", json!({ "path": "" }), Asked::AfterLeftover, true);
            return;
        }
        if what == Asked::AfterLeftover {
            log("leftover read");
            return;
        }
        self.current = session;
        let Some(prompt) = self.session().asked.take() else { return };
        match what {
            Asked::Permission => {
                let outcome = &message["result"]["outcome"];
                log(&format!("permission answered {} {}", self.current, outcome["outcome"].as_str().unwrap_or_default()));
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
        if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
            self.current = session.to_owned();
            if official() {
                log(&format!("{method} {session}"));
            }
        }
        match method {
            // `FAKE_AGENT_SILENT_INIT`: an agent that reads its input and never answers `initialize`.
            "initialize" if setting("FAKE_AGENT_SILENT_INIT").is_some() => {}
            "initialize" => {
                wait_for("FAKE_AGENT_INIT_UNTIL");
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
                            // `FAKE_AGENT_CLOSE_NULL`: an agent that states the close it does not offer as `null`.
                            "sessionCapabilities": if setting("FAKE_AGENT_CLOSE_NULL").is_some() {
                                json!({ "resume": {}, "close": null })
                            } else if official() {
                                json!({ "resume": {} })
                            } else {
                                json!({ "resume": {}, "close": {} })
                            },
                            // `FAKE_AGENT_NO_LOGOUT`: an agent that cannot be signed out through the protocol.
                            "auth": if setting("FAKE_AGENT_NO_LOGOUT").is_some() { json!({}) } else { json!({ "logout": {} }) },
                            // `FAKE_AGENT_NO_APPEND`: an agent whose system prompt takes nothing from its client.
                            "_meta": { "antigravity": { "systemPrompt": { "append": setting("FAKE_AGENT_NO_APPEND").is_none() } } },
                        },
                        "agentInfo": { "name": "fake", "version": version() },
                        "authMethods": if official() {
                            json!([{ "id": "oauth-personal", "name": "Sign in with Google" }, { "id": "gemini-api-key", "name": "Use a Gemini API key" }])
                        } else {
                            json!([])
                        },
                    }),
                );
            }
            // The official server's sign-in: it names the page on its stderr and answers once the user signed in there
            // (`FAKE_AGENT_AUTH_HANGS`: never; `FAKE_AGENT_AUTH_FAILS`: with that error), its sign-in kept in its home.
            "authenticate" if official() => {
                log(&format!(
                    "authenticate {} GEMINI_HOME={}",
                    params["methodId"].as_str().unwrap_or_default(),
                    std::env::var("GEMINI_HOME").unwrap_or_default()
                ));
                // `FAKE_AGENT_AUTH_PAGE`: the page it names in place of its own.
                match setting("FAKE_AGENT_AUTH_PAGE") {
                    Some(page) => eprintln!("Open the following link to authenticate the ACP server: {page}"),
                    None => eprintln!("{SIGN_IN_LINE}"),
                }
                if setting("FAKE_AGENT_AUTH_HANGS").is_some() {
                    return;
                }
                // `FAKE_AGENT_AUTH_UNTIL`: the user signs in on the page once that file is there.
                if let Some(file) = setting("FAKE_AGENT_AUTH_UNTIL") {
                    while !std::path::Path::new(&file).exists() {
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                }
                if let Some(why) = setting("FAKE_AGENT_AUTH_FAILS") {
                    send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": why } }));
                    return;
                }
                std::fs::create_dir_all(home_file("settings.json").parent().unwrap()).unwrap();
                std::fs::write(home_file("settings.json"), r#"{"auth":{"type":"oauth-personal"}}"#).unwrap();
                // `FAKE_AGENT_AUTH_NO_TOKEN`: a sign-in that leaves its settings and no credential.
                if setting("FAKE_AGENT_AUTH_NO_TOKEN").is_none() {
                    std::fs::write(home_file("acp_token.json"), setting("FAKE_AGENT_ACCOUNT").unwrap_or_else(|| "token".into())).unwrap();
                }
                answer(&id, json!({ "_meta": { "antigravity": { "tier": { "name": "Google AI Ultra" } } } }));
            }
            // With no credential in its home the official server asks for a sign-in in the browser where its settings name
            // the way to sign in, and refuses the session where they name none.
            // A credential `expired` is one the server no longer takes.
            "session/new" if official() && !std::fs::read_to_string(home_file("acp_token.json")).is_ok_and(|token| token != "expired") => {
                wait_for("FAKE_AGENT_NEW_UNTIL");
                if home_file("settings.json").exists() {
                    log("browser sign-in");
                    eprintln!("{SIGN_IN_LINE}");
                } else {
                    send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "Authentication required" } }));
                }
            }
            "session/new" if signed_out() => {
                send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "Authentication required" } }));
            }
            // A CLI that hangs: the request is never answered.
            "session/new" if setting("FAKE_AGENT_SILENT_NEW").is_some() => {}
            // `FAKE_AGENT_SILENT_CLOSE`: a close of a session that took a prompt is never answered.
            "session/close" if setting("FAKE_AGENT_SILENT_CLOSE").is_some() && self.session().prompted => {}
            "session/close" => answer(&id, json!({})),
            // The protocol's sign-out: the CLI forgets its own sign-in (`FAKE_AGENT_SIGNED_OUT_FILE` says it did).
            "logout" => {
                wait_for("FAKE_AGENT_LOGOUT_UNTIL");
                if let Some(file) = setting("FAKE_AGENT_SIGNED_OUT_FILE") {
                    std::fs::write(file, "signed out").unwrap();
                }
                // The official server forgets the credential of its home.
                if official() {
                    let _ = std::fs::remove_file(home_file("acp_token.json"));
                }
                answer(&id, json!({}));
            }
            "session/new" => {
                wait_for("FAKE_AGENT_NEW_UNTIL");
                self.numbered += 1;
                self.current = format!("sess-{}", self.numbered);
                self.session().model = "m1".to_owned();
                self.opened(params);
                // `FAKE_AGENT_EARLY_UPDATE`: the new session's first report, sent ahead of the answer that names it.
                if setting("FAKE_AGENT_EARLY_UPDATE").is_some() {
                    self.update(json!({ "sessionUpdate": "usage_update", "used": 7, "size": 700 }));
                }
                answer(
                    &id,
                    json!({
                        "sessionId": self.current,
                        // `FAKE_AGENT_MODELS`: the models listed (a JSON array of `{modelId, name}`) in place of the two.
                        // `FAKE_AGENT_PLAN`: the plan the signed-in account is on.
                        "_meta": { "antigravity": { "tier": setting("FAKE_AGENT_PLAN").map_or(Value::Null, |name| json!({ "name": name, "id": "a-tier" })) } },
                        "models": { "currentModelId": "m1", "availableModels": setting("FAKE_AGENT_MODELS").and_then(|listed| serde_json::from_str::<Value>(&listed).ok()).unwrap_or_else(|| json!([{ "modelId": "m1", "name": "Model One" }, { "modelId": "m2", "name": "Model Two" }])) },
                    }),
                );
            }
            // `FAKE_AGENT_FORGETS`: a server that kept nothing of the sessions an earlier process of it held, and never gives
            // a new session the id of one it was asked for.
            "session/resume" if official() && setting("FAKE_AGENT_FORGETS").is_some() && !self.sessions.contains_key(&self.current) => {
                let asked = self.current.strip_prefix("sess-").and_then(|number| number.parse().ok()).unwrap_or(0);
                self.numbered = self.numbered.max(asked);
                send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32002, "message": format!("Resource not found: {}", self.current) } }));
            }
            // `FAKE_AGENT_RESUME_AUTH`: a resume refused for a sign-in that no longer holds, while a new session opens.
            "session/resume" if setting("FAKE_AGENT_RESUME_AUTH").is_some() => {
                send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": "Authentication required" } }));
            }
            // `FAKE_AGENT_LOAD_FAILS`: a load that replays a part of the session, then fails.
            "session/load" if setting("FAKE_AGENT_LOAD_FAILS").is_some() => {
                self.say("replayed");
                send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32002, "message": format!("Resource not found: {}", self.current) } }));
            }
            "session/resume" | "session/load" => {
                self.opened(params);
                let session = self.session();
                session.resumed = method == "session/resume";
                session.loaded = method == "session/load";
                answer(&id, json!({}));
            }
            // A model request that is never answered.
            "session/set_model" if setting("FAKE_AGENT_SILENT_MODEL").is_some() => {}
            // A model it does not have, refused as `agy` refuses one.
            "session/set_model" if params["modelId"] == "refused" => {
                send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": "Unknown model ID: refused" } }));
            }
            "session/set_model" => {
                self.session().model = params["modelId"].as_str().unwrap_or_default().to_owned();
                answer(&id, json!({}));
            }
            "session/prompt" => self.prompt(id, &params["prompt"]),
            // `FAKE_AGENT_DEAF`: an agent that never closes a cancelled prompt.
            "session/cancel" if setting("FAKE_AGENT_DEAF").is_some() => {}
            // Only the session it names is cancelled.
            "session/cancel" if setting("FAKE_AGENT_SILENT_CANCEL").is_some() => {}
            "session/cancel" => {
                if let Some(prompt) = self.session().hanging.take() {
                    self.update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": "h1", "status": "failed" }));
                    answer(&prompt, json!({ "stopReason": "cancelled" }));
                }
                if let Some(prompt) = self.session().muted.take() {
                    // The call an earlier turn left running ends before the cancelled prompt is closed.
                    if let Some(kept) = self.session().kept.take() {
                        self.update(json!({ "sessionUpdate": "tool_call_update", "toolCallId": kept, "status": "completed" }));
                    }
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

/// `update`: moves to `FAKE_AGENT_UPDATE_TO`, fails as `FAKE_AGENT_UPDATE_FAILS` says, or never ends.
fn update() {
    log("update");
    if setting("FAKE_AGENT_UPDATE_HANGS").is_some() {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
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
        // What its `webbrowser` would run in place of the system's browser.
        log(&format!("official browser={}", variable("BROWSER")));
    }
    if args.iter().any(|arg| arg == "--version") {
        log("version");
        println!("{}", version());
        // `FAKE_AGENT_VERSION_FAILS`: a version run that prints its version and still fails, saying why on stderr.
        if let Some(why) = setting("FAKE_AGENT_VERSION_FAILS") {
            eprintln!("{why}");
            std::process::exit(2);
        }
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
    // `FAKE_AGENT_SLOW_START`: a server that reads nothing for that many milliseconds after it started.
    if let Some(millis) = setting("FAKE_AGENT_SLOW_START").and_then(|millis| millis.parse().ok()) {
        std::thread::sleep(std::time::Duration::from_millis(millis));
    }
    // The official server's build unpacks itself into its temporary folder, and leaves what it unpacked when it is ended
    // by force. Only a folder of Mixdog's own is unpacked into: a check runs the server in the system's.
    if official() {
        let temp = std::env::var("TEMP").unwrap_or_default();
        log(&format!("official temp={temp}"));
        let temp = std::path::Path::new(&temp);
        if temp.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("pid-")) {
            std::fs::create_dir_all(temp.join("_MEIfake")).unwrap();
            std::fs::write(temp.join("_MEIfake").join("base_library.zip"), "unpacked").unwrap();
        }
    }
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
    if official() {
        log("eof");
        // `FAKE_AGENT_LINGERS`: a server that goes on for a while after the end of its input.
        if setting("FAKE_AGENT_LINGERS").is_some() {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }
}
