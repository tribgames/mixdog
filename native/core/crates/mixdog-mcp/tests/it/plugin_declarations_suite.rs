//! What a plugin's `.mcp.json` says when it cannot be used: a file that is not JSON is described by where it breaks and never by the
//! text around it (which may hold a credential); a folder in its place cannot be read; and an entry that cannot be launched names the
//! field and the type it needs, never a configured value. The usable entries are still declared.

use std::path::Path;

use mixdog_mcp::plugins;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use mixdog_statefile::Opts;
use tokio_util::sync::CancellationToken;

async fn on_lane<T: Send + 'static>(work: impl FnOnce(&InLane<MaintenanceIo>) -> T + Send + 'static) -> T {
    mixdog_rt::testing::tokens().maintenance_io.submit(&CancellationToken::new(), work).unwrap().await.unwrap()
}

async fn declared(root: &Path, mcp_json: Option<&str>) -> plugins::PluginMcpDeclarations {
    let (root, text) = (root.to_path_buf(), mcp_json.map(str::to_owned));
    on_lane(move |lane| {
        mixdog_statefile::create_dir_all(lane, &root).unwrap();
        match text {
            Some(text) => mixdog_statefile::write_file(lane, &root.join(".mcp.json"), text.as_bytes(), &Opts::default()).map(drop).unwrap(),
            None => mixdog_statefile::create_dir_all(lane, &root.join(".mcp.json")).unwrap(),
        }
        plugins::load_declarations(lane, &root)
    })
    .await
}

fn messages(declarations: &plugins::PluginMcpDeclarations) -> Vec<&str> {
    declarations.errors.iter().map(|error| error.message.as_str()).collect()
}

// V8's `JSON.parse` words each failure with its position; the plugin keeps only that location: "line L column C", else "position N",
// else (a text that just ends) "unexpected end of input", else a bare "invalid JSON" (e.g. an unexpected token, whose message quotes text).
#[tokio::test]
async fn a_damaged_declaration_file_is_described_by_where_it_breaks() {
    let scratch = tempfile::tempdir().unwrap();
    let rows = [
        ("", "invalid JSON: unexpected end of input"),
        ("   \n", "invalid JSON: unexpected end of input"),
        ("nul", "invalid JSON: unexpected end of input"),
        ("{", "invalid JSON at line 1 column 2"),
        ("{'a':1}", "invalid JSON at line 1 column 2"),
        ("{\"a\"", "invalid JSON at line 1 column 5"),
        ("{\"a\":1,", "invalid JSON at line 1 column 8"),
        ("{\"a\":1,}", "invalid JSON at line 1 column 8"),
        ("{\"a\":\"x\\q\"}", "invalid JSON at line 1 column 9"),
        ("{\"a\":01}", "invalid JSON at line 1 column 7"),
        ("\"abc", "invalid JSON at line 1 column 5"),
        ("[1 2]", "invalid JSON at line 1 column 4"),
        ("{\"a\":1}\n{\"b\":2}", "invalid JSON at line 2 column 1"),
        ("{\"a\":\"line\nbreak\"}", "invalid JSON at line 1 column 11"),
        ("{\"a\":}", "invalid JSON"),
        ("[1,]", "invalid JSON"),
        ("\u{feff}{}", "invalid JSON"),
    ];
    for (index, (text, expected)) in rows.into_iter().enumerate() {
        let found = declared(&scratch.path().join(index.to_string()), Some(text)).await;
        assert_eq!(messages(&found), [expected], "{text:?}");
        assert!(found.servers.is_empty());
    }
}

#[tokio::test]
async fn a_folder_where_the_declaration_file_should_be_cannot_be_read() {
    let scratch = tempfile::tempdir().unwrap();
    let found = declared(scratch.path(), None).await;
    assert_eq!(messages(&found), ["cannot read file (EISDIR)"]);
}

#[tokio::test]
async fn an_entry_that_cannot_be_launched_says_which_field_it_lacks_and_the_others_are_still_declared() {
    let scratch = tempfile::tempdir().unwrap();
    let text = r#"{"mcpServers": {
        "a": 123,
        "b": {"type": "carrier-pigeon", "command": "x"},
        "c": {"command": "  "},
        "d": {"url": ""},
        "e": {"type": "sse"},
        "ok": {"command": "run", "args": ["--flag"]}
    }}"#;
    let found = declared(scratch.path(), Some(text)).await;
    let by_key: Vec<(&str, &str)> = found.errors.iter().map(|error| (error.key.as_deref().unwrap(), error.message.as_str())).collect();
    assert_eq!(
        by_key,
        [
            ("a", "server entry must be an object"),
            ("b", "\"type\" must be one of stdio, http, streamable-http, sse, ws"),
            ("c", "stdio server requires \"command\""),
            ("d", "http server requires \"url\""),
            ("e", "sse server requires \"url\""),
        ]
    );
    let keys: Vec<&str> = found.servers.iter().map(|server| server.key.as_str()).collect();
    assert_eq!(keys, ["ok"]);
}