//! The stdio end of a session's MCP server, for an agent that starts its MCP servers as programs:
//! a process the agent runs, which passes each message it is written to the session's listener and
//! writes back the answer. It is told the listener's port and token in its environment, by the one
//! agent that was handed them.
#![allow(clippy::disallowed_methods, reason = "a plain blocking helper process and a test's client, not a runtime thread")]

use std::io::BufRead;
use std::io::Read;
use std::io::Write;
use std::net::TcpStream;

/// The environment variables the bridge reads.
pub const PORT_ENV: &str = "MIXDOG_ACP_MCP_PORT";
pub const TOKEN_ENV: &str = "MIXDOG_ACP_MCP_TOKEN";
/// The argument the daemon's program is run with as the bridge.
pub const SUBCOMMAND: &str = "acp-mcp-bridge";

/// One message to the listener on `port`: the answer's body, or `None` for a message that has none.
pub fn post(port: u16, token: &str, message: &str) -> std::io::Result<Option<String>> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        message.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(message.as_bytes())?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer)?;
    let split = answer.windows(4).position(|window| window == b"\r\n\r\n").ok_or_else(|| std::io::Error::from(std::io::ErrorKind::InvalidData))?;
    let head = String::from_utf8_lossy(&answer[..split]);
    let status = head.split(' ').nth(1).and_then(|status| status.parse::<u16>().ok()).unwrap_or(0);
    let body = String::from_utf8_lossy(&answer[split + 4..]).into_owned();
    match status {
        200 => Ok(Some(body)),
        202 => Ok(None),
        other => Err(std::io::Error::other(format!("the session's tool server answered {other}"))),
    }
}

/// Serves the process's stdin and stdout until stdin closes. Each message is passed on a thread of its own: a
/// call that runs long holds back no other.
pub fn run() -> std::io::Result<()> {
    let missing = |name: &str| std::io::Error::other(format!("{name} is not set"));
    let port: u16 = std::env::var(PORT_ENV).ok().and_then(|port| port.parse().ok()).ok_or_else(|| missing(PORT_ENV))?;
    let token = std::env::var(TOKEN_ENV).map_err(|_| missing(TOKEN_ENV))?;
    std::thread::scope(|scope| {
        for line in std::io::stdin().lock().lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let token = &token;
            scope.spawn(move || {
                let answer = match post(port, token, &line) {
                    Ok(answer) => answer,
                    // The listener is gone or refused: a request is answered so its sender does not wait.
                    Err(error) => serde_json::from_str::<serde_json::Value>(&line).ok().and_then(|message| {
                        let id = message.get("id").filter(|id| !id.is_null())?.clone();
                        Some(serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": error.to_string() } }).to_string())
                    }),
                };
                if let Some(answer) = answer {
                    let mut out = std::io::stdout().lock();
                    let _ = writeln!(out, "{}", answer.trim_end());
                    let _ = out.flush();
                }
            });
        }
        Ok(())
    })
}
