use std::fs;
use std::io::{BufRead, Write};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn fixture() -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-{nonce}"));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/main.ts"),
        "import { answer } from './dep.js';\nexport function main() { return answer(); }\n",
    )
    .unwrap();
    fs::write(
        root.join("src/dep.ts"),
        "export function answer() { return 42; }\n",
    )
    .unwrap();
    fs::create_dir_all(root.join("java/com/acme")).unwrap();
    fs::write(
        root.join("java/com/acme/User.java"),
        "package com.acme;\npublic class User { public void save() {} }\n",
    )
    .unwrap();
    fs::write(
        root.join("java/com/acme/Use.java"),
        "package com.acme;\nimport com.acme.User;\npublic class Use { User user; }\n",
    )
    .unwrap();
    fs::write(root.join("ignored.txt"), "answer\n").unwrap();
    root
}

fn run(root: &std::path::Path, args: &[&str], stdin: Option<&str>) -> Vec<serde_json::Value> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_mixdog-graph"));
    command.arg(root).args(args).stdout(Stdio::piped());
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().unwrap();
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(input.as_bytes())
            .unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success(), "{output:?}");
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn manifest_files_walk_and_search_remain_jsonl() {
    let root = fixture();

    let manifest = run(&root, &["--manifest"], None);
    assert_eq!(manifest.len(), 4);
    assert!(manifest.iter().all(|v| {
        v["fp"].as_str().unwrap().len() == 16
            && v["size"].as_u64().unwrap() > 0
            && v["tokens"] == serde_json::json!([])
    }));

    let walk = run(&root, &[], None);
    let main = walk.iter().find(|v| v["rel"] == "src/main.ts").unwrap();
    let dep = walk.iter().find(|v| v["rel"] == "src/dep.ts").unwrap();
    assert_eq!(main["resolvedImports"], serde_json::json!(["src/dep.ts"]));
    assert_eq!(dep["importedBy"], serde_json::json!(["src/main.ts"]));
    let symbols = main["symbols"].as_array().unwrap();
    assert!(symbols.iter().any(|s| s["name"] == "main"));
    for symbol in symbols {
        let object = symbol.as_object().unwrap();
        assert_eq!(
            object.keys().map(String::as_str).collect::<std::collections::BTreeSet<_>>(),
            ["endCol", "endLine", "kind", "line", "name", "startCol", "startLine"]
                .into_iter()
                .collect()
        );
        assert!(symbol["name"].is_string() && symbol["kind"].is_string());
        for field in ["line", "endLine", "startLine", "startCol", "endCol"] {
            assert!(symbol[field].as_u64().is_some(), "{field}: {symbol}");
        }
        assert!(symbol["line"].as_u64().unwrap() >= symbol["startLine"].as_u64().unwrap());
        assert!(symbol["endLine"].as_u64().unwrap() >= symbol["line"].as_u64().unwrap());
    }

    let reused = serde_json::json!({
        "rel": "src/dep.ts",
        "lang": "typescript",
        "rawImports": []
    });
    let files = run(
        &root,
        &["--files", "src/main.ts"],
        Some(&format!("{reused}\n")),
    );
    assert_eq!(files.len(), 2);
    assert_eq!(
        files.iter().find(|v| v["rel"] == "src/main.ts").unwrap()["resolvedImports"],
        serde_json::json!(["src/dep.ts"])
    );
    assert_eq!(
        files.iter().find(|v| v["rel"] == "src/dep.ts").unwrap()["importedBy"],
        serde_json::json!(["src/main.ts"])
    );

    let reused_importer = serde_json::json!({
        "rel": "src/main.ts",
        "lang": "typescript",
        "rawImports": ["./dep.js"]
    });
    let reused_links = run(
        &root,
        &["--files", "src/dep.ts"],
        Some(&format!("{reused_importer}\n")),
    );
    assert_eq!(
        reused_links
            .iter()
            .find(|v| v["rel"] == "src/main.ts")
            .unwrap()["resolvedImports"],
        serde_json::json!(["src/dep.ts"])
    );
    assert_eq!(
        reused_links
            .iter()
            .find(|v| v["rel"] == "src/dep.ts")
            .unwrap()["importedBy"],
        serde_json::json!(["src/main.ts"])
    );

    let reused_java = serde_json::json!({
        "rel": "java/com/acme/User.java",
        "lang": "java",
        "rawImports": [],
        "packageName": "com.acme",
        "topLevelTypes": ["User"]
    });
    let indexed = run(
        &root,
        &["--files", "java/com/acme/Use.java"],
        Some(&format!("{reused_java}\n")),
    );
    let use_java = indexed
        .iter()
        .find(|v| v["rel"] == "java/com/acme/Use.java")
        .unwrap();
    let user_java = indexed
        .iter()
        .find(|v| v["rel"] == "java/com/acme/User.java")
        .unwrap();
    assert_eq!(
        use_java["resolvedImports"],
        serde_json::json!(["java/com/acme/User.java"])
    );
    assert_eq!(
        user_java["importedBy"],
        serde_json::json!(["java/com/acme/Use.java"])
    );

    let hits = run(&root, &["answer"], None);
    assert_eq!(hits.len(), 3);
    assert!(hits.iter().all(|v| v["rel"].as_str().unwrap().ends_with(".ts")));

    fs::remove_dir_all(root).unwrap();
}

fn serve_search(root: &std::path::Path, request: serde_json::Value) -> serde_json::Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-graph"))
        .arg(root)
        .arg("--serve-search")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    let mut ready = String::new();
    stdout.read_line(&mut ready).unwrap();
    let ready_json: serde_json::Value = serde_json::from_str(ready.trim()).unwrap();
    assert_eq!(ready_json["ready"], true);
    writeln!(stdin, "{request}").unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    drop(stdin);
    let _ = child.wait();
    serde_json::from_str(line.trim()).unwrap()
}

#[test]
fn serve_search_limited_grep_returns_window_without_full_scan() {
    let root = fixture();
    for index in 0..8 {
        fs::write(
            root.join("src").join(format!("hit-{index}.ts")),
            "export const needle = true;\n",
        )
        .unwrap();
    }
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 7,
            "cwd": root,
            "args": [
                "--color", "never",
                "--hidden",
                "--no-heading",
                "-H",
                "--line-number",
                "-e", "needle",
                "--",
                "."
            ],
            "offset": 0,
            "limit": 3
        }),
    );
    assert_eq!(response["id"], 7);
    let lines = response["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 3);
    assert!(lines.iter().all(|line| line.as_str().unwrap().contains("needle")));
    assert_eq!(response["complete"], false);
    assert!(response["totalSeen"].as_u64().unwrap() >= 3);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_reuses_file_list_across_requests() {
    let root = fixture();
    for index in 0..6 {
        fs::write(
            root.join("src").join(format!("hit-{index}.ts")),
            "export const needle = true;\nexport const other = false;\n",
        )
        .unwrap();
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-graph"))
        .arg(&root)
        .arg("--serve-search")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut stdin = child.stdin.take().unwrap();
    let mut ready = String::new();
    stdout.read_line(&mut ready).unwrap();
    let request = |id: u64, pattern: &str| {
        serde_json::json!({
            "id": id,
            "cwd": root,
            "args": [
                "--color", "never",
                "--hidden",
                "--no-heading",
                "-H",
                "--line-number",
                "-e", pattern,
                "--",
                "."
            ],
            "offset": 0,
            "limit": if id == 1 { 0 } else { 2 }
        })
    };
    writeln!(stdin, "{}", request(1, "needle")).unwrap();
    let mut first = String::new();
    stdout.read_line(&mut first).unwrap();
    let first_json: serde_json::Value = serde_json::from_str(first.trim()).unwrap();
    writeln!(stdin, "{}", request(2, "other")).unwrap();
    let mut second = String::new();
    stdout.read_line(&mut second).unwrap();
    let second_json: serde_json::Value = serde_json::from_str(second.trim()).unwrap();
    drop(stdin);
    let _ = child.wait();
    assert_eq!(first_json["id"], 1);
    assert_eq!(second_json["id"], 2);
    assert!(first_json["lines"].as_array().unwrap().len() >= 6);
    assert_eq!(second_json["lines"].as_array().unwrap().len(), 2);
    assert!(first_json["lines"].as_array().unwrap().iter().all(|line| line.as_str().unwrap().contains("needle")));
    assert!(second_json["lines"].as_array().unwrap().iter().all(|line| line.as_str().unwrap().contains("other")));
    fs::remove_dir_all(root).unwrap();
}
