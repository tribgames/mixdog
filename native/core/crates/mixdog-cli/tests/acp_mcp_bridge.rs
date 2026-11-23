//! `mixdogd acp-mcp-bridge`: the program an ACP agent that takes no HTTP MCP server starts as its session's tool server.
#![allow(clippy::disallowed_methods, reason = "the test runs the binary and is the listener it talks to")]

use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use mixdog_acp::mcp_bridge::PORT_ENV;
use mixdog_acp::mcp_bridge::SUBCOMMAND;
use mixdog_acp::mcp_bridge::TOKEN_ENV;

/// A message written to the bridge's stdin reaches the session's listener as that session's own request (its path and
/// its bearer token), and the listener's answer is the line the bridge writes back.
#[test]
fn the_bridge_subcommand_passes_a_message_to_the_sessions_listener_and_writes_back_its_answer() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let port = listener.local_addr().expect("the port").port();
    let (heard, requests) = mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("the bridge's connection");
        let mut reader = BufReader::new(stream.try_clone().expect("the stream"));
        let (mut head, mut length) = (Vec::new(), 0_usize);
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':')
                && name.eq_ignore_ascii_case("content-length")
            {
                length = value.trim().parse().unwrap_or(0);
            }
            head.push(line.trim().to_owned());
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).expect("the body");
        heard.send((head, String::from_utf8_lossy(&body).into_owned())).expect("the test waits");
        let answer = r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#;
        write!(stream, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len())
            .expect("the answer");
    });

    let mut bridge = Command::new(mixdog_testkit::bin_exe!("mixdogd"))
        .arg(SUBCOMMAND)
        .env(PORT_ENV, port.to_string())
        .env(TOKEN_ENV, "the-session-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("the bridge starts");
    let message = r#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#;
    let mut stdin = bridge.stdin.take().expect("stdin");
    writeln!(stdin, "{message}").expect("the message");
    let (head, body) = requests.recv_timeout(Duration::from_secs(120)).expect("the listener's request");
    assert_eq!(head[0], "POST /mcp HTTP/1.1", "{head:?}");
    assert!(head.iter().any(|line| line.eq_ignore_ascii_case("authorization: Bearer the-session-token")), "{head:?}");
    assert_eq!(body, message);

    let mut answer = String::new();
    BufReader::new(bridge.stdout.take().expect("stdout")).read_line(&mut answer).expect("the answer's line");
    assert_eq!(answer.trim_end(), r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#);
    // The agent closes the bridge's stdin when its session ends: the bridge ends with it.
    drop(stdin);
    assert!(bridge.wait().expect("the bridge's exit").success());
}
