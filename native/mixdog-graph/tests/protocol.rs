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

#[test]
fn outline_mode_dumps_items_members_and_extra_rules() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-outline-{nonce}"));
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("a.ts"),
        "import { x } from './x.js';\nexport class Store {\n  read() {}\n}\n",
    )
    .unwrap();

    let lines = run(&root, &["--outline", "--files", "a.ts"], None);
    assert_eq!(lines.len(), 2, "one file line plus the summary");
    let file = &lines[0];
    assert_eq!(file["file"], "a.ts");
    assert_eq!(file["lang"], "typescript");
    let items = file["items"].as_array().unwrap();
    let import = items
        .iter()
        .find(|item| item["isImport"] == true)
        .expect("import item");
    assert_eq!(import["symbolType"], "module");
    assert_eq!(import["name"], "'./x.js'");
    let class = items
        .iter()
        .find(|item| item["symbolType"] == "class")
        .expect("class item");
    assert_eq!(class["name"], "Store");
    assert_eq!(class["isExported"], true);
    assert_eq!(class["range"]["start"]["line"], 1);
    assert_eq!(class["range"]["start"]["column"], 7);
    assert_eq!(class["range"]["byteOffset"][0], 35);
    let member = &class["members"][0];
    assert_eq!(member["symbolType"], "method");
    assert_eq!(member["name"], "read");
    assert_eq!(member["isPublic"], true);
    assert_eq!(lines[1]["summary"]["files"], 1);
    assert_eq!(lines[1]["summary"]["errors"].as_array().unwrap().len(), 0);

    // An extra rule file is layered on top of the bundle and wins per node.
    let rules = root.join("extra.yml");
    fs::write(
        &rules,
        "id: extra-ts-class\nlanguage: TypeScript\nrole: item\nsymbolType: struct\nrule:\n  kind: class_declaration\n  has:\n    field: name\n    pattern: $NAME\nname: extra-$NAME\n",
    )
    .unwrap();
    let with_extra = run(
        &root,
        &[
            "--outline",
            "--rules",
            rules.to_str().unwrap(),
            "--files",
            "a.ts",
        ],
        None,
    );
    let items = with_extra[0]["items"].as_array().unwrap();
    assert!(items
        .iter()
        .any(|item| item["name"] == "extra-Store" && item["symbolType"] == "struct"));

    fs::remove_dir_all(&root).unwrap();
}

/// The two declaration shapes a `references <name>` query used to miss reach
/// the RECORD, not only the extraction: a function-valued property of an
/// object literal, and a method signature of an interface. Both are `method`,
/// both name their enclosing declaration as `parent`.
#[test]
fn object_literal_and_signature_methods_reach_the_record() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-methods-{nonce}"));
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("host.ts"),
        "export interface SequenceRunnerHost {\n  preflightSteps?(command: string, steps: string[]): Promise<void>;\n  flag: boolean;\n  onClick: () => void;\n}\n\nexport function createPowerShellComputerHost() {\n  const sequenceRunner = createSequenceRunner({\n    preflightSteps: createInputPreflight({ retries: 2 }),\n    recordProgress: (completed: number) => completed,\n    label: 'text',\n    headers: authHeaders(key, { Accept: 'application/json' }),\n    style: { color: 'red' },\n  });\n  return sequenceRunner;\n}\n",
    )
    .unwrap();

    let walk = run(&root, &["--files", "host.ts"], None);
    let symbols = walk[0]["symbols"].as_array().unwrap();
    let named = |name: &str, line: u64| {
        symbols
            .iter()
            .find(|symbol| symbol["name"] == name && symbol["startLine"] == line)
            .unwrap_or_else(|| panic!("no `{name}` at line {line} in {symbols:?}"))
    };

    let signature = named("preflightSteps", 2);
    assert_eq!(signature["kind"], "method");
    assert_eq!(signature["parent"], "SequenceRunnerHost");
    assert_eq!(
        signature["sig"],
        "preflightSteps?(command: string, steps: string[]): Promise<void>"
    );
    assert!(signature.get("exported").is_none(), "{signature}");

    let property = named("preflightSteps", 9);
    assert_eq!(property["kind"], "method");
    assert_eq!(property["parent"], "createPowerShellComputerHost");
    assert_eq!(named("recordProgress", 10)["kind"], "method");

    // Data properties and interface fields are no symbols — a function TYPE
    // (`onClick: () => void`) is a field like any other, an OPTIONS BAG
    // (`authHeaders(key, { … })`) is a computed value, not a factory, and an
    // object literal value is data.
    assert!(
        !symbols.iter().any(|symbol| {
            matches!(
                symbol["name"].as_str(),
                Some("label" | "flag" | "onClick" | "headers" | "style" | "Accept" | "color")
            )
        }),
        "{symbols:?}"
    );

    fs::remove_dir_all(&root).unwrap();
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
fn files_mode_rejects_malformed_reused_jsonl() {
    let root = fixture();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mixdog-graph"))
        .arg(&root)
        .args(["--files", "src/main.ts"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"{not-json}\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("invalid reused JSONL at line 1"),
        "{output:?}",
    );
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
    // Symbol record v2: five always-present fields plus the three optional
    // ones, which are omitted rather than emitted empty/false.
    let symbols = main["symbols"].as_array().unwrap();
    assert!(symbols.iter().any(|s| s["name"] == "main"));
    for symbol in symbols {
        let object = symbol.as_object().unwrap();
        let keys = object
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        let required: std::collections::BTreeSet<&str> =
            ["endCol", "endLine", "kind", "name", "startCol", "startLine"]
                .into_iter()
                .collect();
        assert!(required.is_subset(&keys), "{symbol}");
        let optional: std::collections::BTreeSet<&str> =
            ["exported", "sig", "parent"].into_iter().collect();
        assert!(
            keys.difference(&required).all(|key| optional.contains(key)),
            "unknown symbol field: {symbol}"
        );
        assert!(symbol["name"].is_string() && symbol["kind"].is_string());
        for field in ["endLine", "startLine", "startCol", "endCol"] {
            assert!(symbol[field].as_u64().is_some(), "{field}: {symbol}");
        }
        assert!(symbol["endLine"].as_u64().unwrap() >= symbol["startLine"].as_u64().unwrap());
        if let Some(exported) = symbol.get("exported") {
            assert_eq!(exported, true, "exported is omitted when false: {symbol}");
        }
        for field in ["sig", "parent"] {
            if let Some(value) = symbol.get(field) {
                assert!(
                    value.as_str().is_some_and(|text| !text.is_empty()),
                    "{field} is omitted when empty: {symbol}"
                );
            }
        }
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
    assert!(hits
        .iter()
        .all(|v| v["rel"].as_str().unwrap().ends_with(".ts")));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rust_python_tsconfig_and_hash_imports_resolve() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-holes-{nonce}"));
    fs::create_dir_all(root.join("src/pkg")).unwrap();
    fs::create_dir_all(root.join("src/nested")).unwrap();
    fs::create_dir_all(root.join("apps/web")).unwrap();

    fs::write(root.join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();
    fs::write(
        root.join("src/lib.rs"),
        "mod helper;\nuse crate::helper;\nuse crate::{helper as h, nested};\n",
    )
    .unwrap();
    fs::write(root.join("src/helper.rs"), "pub fn go() {}\n").unwrap();
    fs::write(root.join("src/nested/mod.rs"), "pub fn n() {}\n").unwrap();
    fs::write(root.join("src/nested/child.rs"), "use super::n;\n").unwrap();

    fs::write(root.join("src/pkg/__init__.py"), "x = 1\n").unwrap();
    fs::write(root.join("src/pkg/mod.py"), "from pkg import x\n").unwrap();
    fs::write(root.join("app.py"), "import pkg.mod\n").unwrap();

    fs::write(
        root.join("tsconfig.base.json"),
        r#"{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }"#,
    )
    .unwrap();
    fs::write(
        root.join("apps/web/tsconfig.json"),
        r#"{ "extends": "../../tsconfig.base.json" }"#,
    )
    .unwrap();
    fs::write(root.join("src/util.ts"), "export const n = 1;\n").unwrap();
    fs::write(
        root.join("apps/web/app.ts"),
        "import { n } from '@/util';\n",
    )
    .unwrap();

    fs::write(
        root.join("package.json"),
        r##"{"name":"demo","imports":{"#lib/*":"./src/*"}}"##,
    )
    .unwrap();
    fs::write(root.join("src/hash.ts"), "import { n } from '#lib/util';\n").unwrap();

    fs::write(root.join("src/types.pyi"), "def typed() -> int: ...\n").unwrap();
    fs::write(root.join("src/box.hh"), "struct Box;\n").unwrap();

    let walk = run(&root, &[], None);
    let find = |rel: &str| {
        walk.iter()
            .find(|v| v["rel"] == rel)
            .unwrap_or_else(|| panic!("missing {rel} in {walk:?}"))
    };

    let lib_imports = find("src/lib.rs")["resolvedImports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(lib_imports.contains(&"src/helper.rs"), "{lib_imports:?}");
    assert!(
        lib_imports.contains(&"src/nested/mod.rs"),
        "{lib_imports:?}"
    );
    assert_eq!(
        find("app.py")["resolvedImports"],
        serde_json::json!(["src/pkg/mod.py"])
    );
    assert_eq!(
        find("apps/web/app.ts")["resolvedImports"],
        serde_json::json!(["src/util.ts"])
    );
    assert_eq!(
        find("src/hash.ts")["resolvedImports"],
        serde_json::json!(["src/util.ts"])
    );
    assert!(walk.iter().any(|v| v["rel"] == "src/types.pyi"));
    assert!(walk.iter().any(|v| v["rel"] == "src/box.hh"));

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
    let response = read_search_response(&mut stdout, request["id"].as_u64().unwrap());
    drop(stdin);
    let _ = child.wait();
    response
}

fn read_search_message<R: BufRead>(stdout: &mut R) -> serde_json::Value {
    loop {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let response: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        if response["event"] != "invalidate" {
            return response;
        }
    }
}

fn read_search_response<R: BufRead>(stdout: &mut R, id: u64) -> serde_json::Value {
    let response = read_search_message(stdout);
    assert_eq!(response["id"], id, "{response}");
    response
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
    assert!(lines
        .iter()
        .all(|line| line.as_str().unwrap().contains("needle")));
    assert_eq!(response["complete"], false);
    assert!(response["totalSeen"].as_u64().unwrap() >= 3);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_inventory_can_include_directories() {
    let root = fixture();
    fs::create_dir_all(root.join("src/nested")).unwrap();
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 10,
            "cwd": root,
            "args": [
                "--files",
                "--directories",
                "--no-ignore",
                "--",
                "."
            ],
            "offset": 0,
            "limit": 0
        }),
    );
    let lines = response["lines"].as_array().unwrap();
    assert!(lines.iter().any(|line| {
        line.as_str()
            .is_some_and(|line| line.ends_with("src") || line.ends_with("src/"))
    }));
    assert!(lines.iter().any(|line| {
        line.as_str()
            .is_some_and(|line| line.ends_with("src/nested") || line.ends_with(r"src\nested"))
    }));
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
    let first_json = read_search_response(&mut stdout, 1);
    writeln!(stdin, "{}", request(2, "other")).unwrap();
    let second_json = read_search_response(&mut stdout, 2);
    drop(stdin);
    let _ = child.wait();
    assert_eq!(first_json["id"], 1);
    assert_eq!(second_json["id"], 2);
    assert!(first_json["lines"].as_array().unwrap().len() >= 6);
    assert_eq!(second_json["lines"].as_array().unwrap().len(), 2);
    assert!(first_json["lines"]
        .as_array()
        .unwrap()
        .iter()
        .all(|line| line.as_str().unwrap().contains("needle")));
    assert!(second_json["lines"]
        .as_array()
        .unwrap()
        .iter()
        .all(|line| line.as_str().unwrap().contains("other")));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_shared_inventory_preserves_request_globs() {
    let root = fixture();
    fs::write(
        root.join("src/filter-hit.rs"),
        "const needle: bool = true;\n",
    )
    .unwrap();
    fs::write(
        root.join("src/filter-hit.ts"),
        "export const needle = true;\n",
    )
    .unwrap();
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 8,
            "cwd": root,
            "args": [
                "--color", "never",
                "--hidden",
                "--no-heading",
                "-H",
                "--line-number",
                "--glob", "*.ts",
                "-e", "needle",
                "--",
                "."
            ],
            "offset": 0,
            "limit": 20
        }),
    );
    let lines = response["lines"].as_array().unwrap();
    assert!(!lines.is_empty());
    assert!(lines.iter().all(|line| {
        let line = line.as_str().unwrap();
        line.contains(".ts:") && !line.contains("filter-hit.rs")
    }));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_exact_file_uses_parent_as_glob_root() {
    let root = fixture();
    let target = root.join("src/dep.ts");
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 9,
            "cwd": root,
            "args": [
                "--color", "never",
                "--hidden",
                "--no-heading",
                "-H",
                "--line-number",
                "--glob", "*.ts",
                "-e", "answer",
                "--",
                target
            ],
            "offset": 0,
            "limit": 20
        }),
    );
    let lines = response["lines"].as_array().unwrap();
    assert!(!lines.is_empty());
    assert!(lines
        .iter()
        .all(|line| line.as_str().is_some_and(|line| line.contains("dep.ts:"))));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_embedded_ripgrep_modes_preserve_contracts() {
    let root = fixture();
    fs::write(
        root.join("src/engine.ts"),
        "first needle value\nsecond needle value\nmulti start\nmulti end\n",
    )
    .unwrap();
    fs::write(root.join("src/engine.rs"), "needle rust\n").unwrap();
    let request = |id: u64, extra: &[&str], pattern: &str| {
        let mut args = vec![
            "--color",
            "never",
            "--hidden",
            "--no-heading",
            "-H",
            "--line-number",
            "--max-columns=500",
            "--max-columns-preview",
        ];
        args.extend_from_slice(extra);
        args.extend_from_slice(&["-e", pattern, "--", "."]);
        serve_search(
            &root,
            serde_json::json!({
                "id": id,
                "cwd": root,
                "args": args,
                "offset": 0,
                "limit": 20
            }),
        )
    };

    let only = request(20, &["--only-matching"], "needle");
    assert!(only["lines"]
        .as_array()
        .unwrap()
        .iter()
        .all(|line| { line.as_str().unwrap().ends_with(":needle") }));

    let count = request(21, &["--count"], "needle");
    assert!(count["lines"].as_array().unwrap().iter().any(|line| {
        line.as_str()
            .is_some_and(|line| line.ends_with("engine.ts:2"))
    }));

    let typed = request(22, &["--type", "typescript"], "needle");
    assert!(typed["lines"].as_array().unwrap().iter().all(|line| {
        let line = line.as_str().unwrap();
        line.contains(".ts:") && !line.contains("engine.rs")
    }));

    let multiline = request(23, &["-U", "--multiline-dotall"], "multi start.*multi end");
    assert!(multiline["lines"].as_array().unwrap().iter().any(|line| {
        line.as_str()
            .is_some_and(|line| line.contains("multi start"))
    }));

    let pcre = request(24, &["-P"], "(?<=needle )value");
    assert!(pcre["lines"].as_array().unwrap().iter().any(|line| {
        line.as_str()
            .is_some_and(|line| line.contains("needle value"))
    }));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_preserves_regex_parse_errors_for_native_recovery() {
    let root = fixture();
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 26,
            "cwd": root,
            "args": [
                "--color", "never",
                "--hidden",
                "--no-heading",
                "-H",
                "--line-number",
                "-e", "except (",
                "--",
                "."
            ],
            "offset": 0,
            "limit": 20
        }),
    );
    assert!(response["unsupported"]
        .as_str()
        .is_some_and(|message| message.contains("regex parse error")));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_accepts_internal_find_files_glob_order() {
    let root = fixture();
    fs::write(
        root.join("src/engine-target.ts"),
        "export const needle = true;\n",
    )
    .unwrap();
    fs::write(root.join("src/other.ts"), "export const other = true;\n").unwrap();
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 25,
            "cwd": root,
            "args": [
                "--files",
                "--directories",
                "--no-ignore",
                "--hidden",
                "--glob", "!**/.git/**",
                "--iglob", "*engine*",
                "."
            ],
            "offset": 0,
            "limit": 0
        }),
    );
    assert!(response.get("unsupported").is_none());
    let lines = response["lines"].as_array().unwrap();
    assert!(lines.iter().any(|line| {
        line.as_str()
            .is_some_and(|line| line.replace('\\', "/").ends_with("src/engine-target.ts"))
    }));
    assert!(!lines.iter().any(|line| {
        line.as_str()
            .is_some_and(|line| line.replace('\\', "/").ends_with("src/other.ts"))
    }));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_accepts_hundreds_of_parallel_requests() {
    let root = fixture();
    for index in 0..32 {
        fs::write(
            root.join("src").join(format!("parallel-{index}.ts")),
            format!("export const needle_{index} = true;\n"),
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

    const REQUESTS: u64 = 256;
    for id in 1..=REQUESTS {
        let pattern = format!("needle_{}", id % 32);
        let request = serde_json::json!({
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
            "limit": 1
        });
        writeln!(stdin, "{request}").unwrap();
    }

    let mut ids = std::collections::HashSet::new();
    for _ in 0..REQUESTS {
        let response = read_search_message(&mut stdout);
        ids.insert(response["id"].as_u64().unwrap());
        assert_eq!(response["class"], "interactive");
        assert!(response["queueMs"].as_u64().is_some());
        assert!(response["handlerMs"].as_u64().is_some());
        assert_eq!(response["lines"].as_array().unwrap().len(), 1);
    }
    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success());
    assert_eq!(ids.len(), REQUESTS as usize);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_inventory_mtime_top_k_is_globally_ordered() {
    let root = fixture();
    let old = root.join("src/old.rank");
    let new = root.join("src/new.rank");
    fs::write(&old, "old\n").unwrap();
    fs::write(&new, "new\n").unwrap();
    let old_time = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(10);
    let new_time = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(20);
    fs::OpenOptions::new()
        .write(true)
        .open(&old)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(old_time))
        .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&new)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(new_time))
        .unwrap();
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 11,
            "cwd": root,
            "args": ["--files", "--glob", "*.rank", "."],
            "offset": 0,
            "limit": 2,
            "mtimeTopK": true
        }),
    );
    assert_eq!(response["complete"], true);
    assert_eq!(response["totalSeen"], 2);
    let lines = response["lines"].as_array().unwrap();
    assert!(lines[0].as_str().unwrap().ends_with("new.rank"));
    assert!(lines[1].as_str().unwrap().ends_with("old.rank"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_returns_batched_list_metadata() {
    let root = fixture();
    let file = root.join("src/metadata.txt");
    let directory = root.join("src/nested-metadata");
    fs::write(&file, "metadata\n").unwrap();
    fs::create_dir_all(&directory).unwrap();
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 13,
            "cwd": root,
            "listMetadata": [file, directory]
        }),
    );
    let entries = response["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["type"], "file");
    assert_eq!(entries[0]["size"], 9);
    assert!(entries[0]["mtimeMs"].as_u64().unwrap() > 0);
    assert!(entries[0]["mode"].as_u64().unwrap() > 0);
    assert_eq!(entries[1]["type"], "dir");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_fuzzy_returns_native_top_k() {
    let root = fixture();
    fs::write(
        root.join("src").join("parallel-runtime.rs"),
        "fn main() {}\n",
    )
    .unwrap();
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 9,
            "cwd": root,
            "fuzzy": "parallel.rs",
            "hidden": true,
            "includeNoise": false,
            "exclude": ["!.git/**"],
            "limit": 3
        }),
    );
    assert_eq!(response["id"], 9);
    assert_eq!(response["class"], "fuzzy");
    assert!(response["complete"].as_bool().unwrap());
    assert!(response["inventoryMs"].as_f64().unwrap() >= 0.0);
    assert!(response["rankMs"].as_f64().unwrap() >= 0.0);
    let matches = response["matches"].as_array().unwrap();
    assert!(!matches.is_empty());
    assert!(matches.iter().any(|path| {
        path.as_str()
            .is_some_and(|path| path.ends_with("parallel-runtime.rs"))
    }));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_fuzzy_multi_token_and_matches_every_fragment() {
    let root = fixture();
    fs::write(
        root.join("src").join("search-native-client.rs"),
        "fn main() {}\n",
    )
    .unwrap();
    fs::write(root.join("src").join("search-only.rs"), "fn main() {}\n").unwrap();
    let response = serve_search(
        &root,
        serde_json::json!({
            "id": 12,
            "cwd": root,
            "fuzzy": "search client",
            "hidden": true,
            "includeNoise": false,
            "limit": 5
        }),
    );
    assert!(response["complete"].as_bool().unwrap());
    let matches = response["matches"].as_array().unwrap();
    assert!(matches.iter().any(|path| {
        path.as_str()
            .is_some_and(|path| path.ends_with("search-native-client.rs"))
    }));
    assert!(!matches.iter().any(|path| {
        path.as_str()
            .is_some_and(|path| path.ends_with("search-only.rs"))
    }));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_watcher_invalidates_the_shared_inventory() {
    let root = fixture();
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
    let request = |id: u64| {
        serde_json::json!({
            "id": id,
            "cwd": root,
            "fuzzy": "watcher-created",
            "hidden": true,
            "includeNoise": false,
            "limit": 5
        })
    };
    writeln!(stdin, "{}", request(1)).unwrap();
    let first = read_search_response(&mut stdout, 1);
    assert!(first["matches"].as_array().unwrap().is_empty());

    fs::write(root.join("src/watcher-created.rs"), "fn watched() {}\n").unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut found = false;
    let mut id = 2;
    while std::time::Instant::now() < deadline && !found {
        writeln!(stdin, "{}", request(id)).unwrap();
        let response = read_search_message(&mut stdout);
        assert_eq!(response["id"], id);
        found = response["matches"].as_array().unwrap().iter().any(|path| {
            path.as_str()
                .is_some_and(|path| path.ends_with("watcher-created.rs"))
        });
        id += 1;
        if !found {
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
    }
    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success());
    assert!(found, "watcher did not invalidate the native inventory");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn serve_search_parallel_load_keeps_one_server_responsive() {
    let root = fixture();
    for index in 0..512 {
        fs::write(
            root.join("src").join(format!("load-{index:04}.rs")),
            format!("pub const NEEDLE_{index}: &str = \"needle\";\n"),
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
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(ready.trim()).unwrap()["ready"],
        true
    );

    const REQUESTS: u64 = 96;
    for id in 1..=REQUESTS {
        let request = match id % 3 {
            0 => serde_json::json!({
                "id": id,
                "cwd": root,
                "args": [
                    "--hidden", "--no-heading", "-H", "--line-number",
                    "-e", "needle", "--", "."
                ],
                "offset": 0,
                "limit": 8,
                "deadlineMs": 30_000
            }),
            1 => serde_json::json!({
                "id": id,
                "cwd": root,
                "args": ["--files", "--hidden", "--glob", "*.rs", "."],
                "offset": 0,
                "limit": 8,
                "deadlineMs": 30_000
            }),
            _ => serde_json::json!({
                "id": id,
                "cwd": root,
                "fuzzy": "load",
                "hidden": true,
                "includeNoise": false,
                "limit": 8,
                "deadlineMs": 30_000
            }),
        };
        writeln!(stdin, "{request}").unwrap();
    }
    let cancel_id = REQUESTS + 1;
    writeln!(
        stdin,
        "{}",
        serde_json::json!({
            "id": cancel_id,
            "cwd": root,
            "fuzzy": "load",
            "hidden": true,
            "includeNoise": false,
            "limit": 8,
            "deadlineMs": 30_000
        })
    )
    .unwrap();
    writeln!(stdin, "{}", serde_json::json!({ "cancel": cancel_id })).unwrap();
    let cancel_started = std::time::Instant::now();
    stdin.flush().unwrap();

    let mut ids = std::collections::HashSet::new();
    let mut classes = std::collections::HashSet::new();
    let mut queue_ms = Vec::new();
    let mut cancel_elapsed = None;
    while ids.len() < REQUESTS as usize || cancel_elapsed.is_none() {
        let response = read_search_message(&mut stdout);
        if response["id"] == cancel_id && response["event"] == "cancelled" {
            cancel_elapsed = Some(cancel_started.elapsed());
            continue;
        }
        assert!(response.get("error").is_none(), "{response}");
        assert!(response.get("unsupported").is_none(), "{response}");
        assert_ne!(response["timeout"], true, "{response}");
        assert_ne!(response["partial"], true, "{response}");
        let id = response["id"].as_u64().unwrap();
        assert!((1..=REQUESTS).contains(&id), "{response}");
        assert!(ids.insert(id), "duplicate response id {id}");
        classes.insert(response["class"].as_str().unwrap().to_string());
        queue_ms.push(response["queueMs"].as_u64().unwrap());
    }
    assert_eq!(
        classes,
        ["interactive", "fuzzy", "bulk"]
            .into_iter()
            .map(str::to_string)
            .collect()
    );
    queue_ms.sort_unstable();
    let p95 = queue_ms[(queue_ms.len() * 95 / 100).min(queue_ms.len() - 1)];
    assert!(p95 < 10_000, "queue p95 too high: {p95}ms");
    assert!(
        child.try_wait().unwrap().is_none(),
        "search server exited under load"
    );
    assert!(
        cancel_elapsed.unwrap() < std::time::Duration::from_secs(1),
        "cancel acknowledgement exceeded 1s"
    );

    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn convention_imports_resolve_across_languages() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-langs-{nonce}"));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join("lib/foo")).unwrap();
    fs::create_dir_all(root.join("lib")).unwrap();
    fs::create_dir_all(root.join("Sources/Foo")).unwrap();
    fs::create_dir_all(root.join("com/acme")).unwrap();

    fs::write(
        root.join("composer.json"),
        r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#,
    )
    .unwrap();
    fs::write(root.join("src/User.php"), "<?php\nclass User {}\n").unwrap();
    fs::write(
        root.join("src/boot.php"),
        "<?php\nuse App\\User;\nrequire './User.php';\n",
    )
    .unwrap();

    fs::write(root.join("pubspec.yaml"), "name: demo\n").unwrap();
    fs::create_dir_all(root.join("lib")).unwrap();
    fs::write(root.join("lib/a.dart"), "class A {}\n").unwrap();
    fs::write(root.join("lib/b.dart"), "import 'package:demo/a.dart';\n").unwrap();

    fs::write(root.join("lib/foo/bar.ex"), "defmodule Foo.Bar do\nend\n").unwrap();
    fs::write(
        root.join("lib/foo/use.ex"),
        "defmodule Foo.Use do\n  alias Foo.Bar\nend\n",
    )
    .unwrap();

    fs::write(root.join("util.zig"), "pub const n = 1;\n").unwrap();
    fs::write(
        root.join("main.zig"),
        "const util = @import(\"util.zig\");\n",
    )
    .unwrap();

    fs::write(root.join("Foo.h"), "@interface Foo\n@end\n").unwrap();
    fs::write(root.join("main.m"), "#import \"Foo.h\"\n").unwrap();

    fs::write(root.join("Sources/Foo/Foo.swift"), "public struct Foo {}\n").unwrap();
    fs::write(root.join("Sources/Foo/Use.swift"), "import Foo\n").unwrap();

    fs::write(
        root.join("com/acme/User.scala"),
        "package com.acme\nclass User\n",
    )
    .unwrap();
    fs::write(
        root.join("com/acme/Use.scala"),
        "package com.acme\nimport com.acme.User\n",
    )
    .unwrap();

    let walk = run(&root, &[], None);
    let find = |rel: &str| walk.iter().find(|v| v["rel"] == rel).unwrap();

    assert_eq!(
        find("src/boot.php")["resolvedImports"],
        serde_json::json!(["src/User.php"])
    );
    assert_eq!(
        find("lib/b.dart")["resolvedImports"],
        serde_json::json!(["lib/a.dart"])
    );
    assert_eq!(
        find("lib/foo/use.ex")["resolvedImports"],
        serde_json::json!(["lib/foo/bar.ex"])
    );
    assert_eq!(
        find("main.zig")["resolvedImports"],
        serde_json::json!(["util.zig"])
    );
    assert_eq!(
        find("main.m")["resolvedImports"],
        serde_json::json!(["Foo.h"])
    );
    assert!(find("Sources/Foo/Use.swift")["resolvedImports"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == "Sources/Foo/Foo.swift"));
    assert_eq!(
        find("com/acme/Use.scala")["resolvedImports"],
        serde_json::json!(["com/acme/User.scala"])
    );

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn everyday_aliases_mods_headers_and_brace_use_resolve() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-polish-{nonce}"));
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(root.join("include/acme")).unwrap();
    fs::create_dir_all(root.join("packages/util")).unwrap();

    fs::write(
        root.join("tsconfig.json"),
        r#"{
          "compilerOptions": {
            "baseUrl": ".",
            "paths": { "@/*": ["src/*"] }
          }
        }"#,
    )
    .unwrap();
    fs::write(root.join("src/util.ts"), "export const n = 1;\n").unwrap();
    fs::write(root.join("src/app.ts"), "import { n } from '@/util';\n").unwrap();

    fs::write(
        root.join("packages/util/package.json"),
        r#"{"name":"@demo/util","main":"index.ts"}"#,
    )
    .unwrap();
    fs::write(root.join("packages/util/index.ts"), "export const k = 2;\n").unwrap();
    fs::write(root.join("src/pkg.ts"), "import { k } from '@demo/util';\n").unwrap();

    fs::write(root.join("src/lib.rs"), "mod helper;\n").unwrap();
    fs::write(root.join("src/helper.rs"), "pub fn go() {}\n").unwrap();

    fs::write(root.join("include/acme/box.h"), "struct Box;\n").unwrap();
    fs::write(root.join("src/box.c"), "#include <acme/box.h>\n").unwrap();

    fs::write(
        root.join("composer.json"),
        r#"{"autoload":{"psr-4":{"App\\":"src/"}}}"#,
    )
    .unwrap();
    fs::write(root.join("src/User.php"), "<?php\nclass User {}\n").unwrap();
    fs::write(root.join("src/Post.php"), "<?php\nclass Post {}\n").unwrap();
    fs::write(
        root.join("src/models.php"),
        "<?php\nuse App\\{User, Post};\n",
    )
    .unwrap();

    let walk = run(&root, &[], None);
    let find = |rel: &str| walk.iter().find(|v| v["rel"] == rel).unwrap();

    assert_eq!(
        find("src/app.ts")["resolvedImports"],
        serde_json::json!(["src/util.ts"])
    );
    assert_eq!(
        find("src/pkg.ts")["resolvedImports"],
        serde_json::json!(["packages/util/index.ts"])
    );
    assert_eq!(
        find("src/lib.rs")["resolvedImports"],
        serde_json::json!(["src/helper.rs"])
    );
    assert_eq!(
        find("src/box.c")["resolvedImports"],
        serde_json::json!(["include/acme/box.h"])
    );
    let php = find("src/models.php")["resolvedImports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(php.contains(&"src/User.php".to_string()), "{php:?}");
    assert!(php.contains(&"src/Post.php".to_string()), "{php:?}");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn go_relative_elixir_braces_and_deep_tsconfig_resolve() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-last-{nonce}"));
    fs::create_dir_all(root.join("cmd")).unwrap();
    fs::create_dir_all(root.join("cmd/util")).unwrap();
    fs::create_dir_all(root.join("lib/foo")).unwrap();
    fs::create_dir_all(root.join("apps/web/app")).unwrap();
    fs::create_dir_all(root.join("src")).unwrap();

    fs::write(
        root.join("cmd/main.go"),
        "package main\nimport \"./util\"\n",
    )
    .unwrap();
    fs::write(
        root.join("cmd/util/help.go"),
        "package util\nfunc Help() {}\n",
    )
    .unwrap();

    fs::write(root.join("lib/foo/bar.ex"), "defmodule Foo.Bar do\nend\n").unwrap();
    fs::write(root.join("lib/foo/baz.ex"), "defmodule Foo.Baz do\nend\n").unwrap();
    fs::write(
        root.join("lib/foo/use.ex"),
        "defmodule Foo.Use do\n  alias Foo.{Bar, Baz}\nend\n",
    )
    .unwrap();

    fs::write(
        root.join("tsconfig.base.json"),
        r#"{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }"#,
    )
    .unwrap();
    fs::write(
        root.join("apps/web/app/tsconfig.json"),
        r#"{ "extends": "../../../tsconfig.base.json" }"#,
    )
    .unwrap();
    fs::write(root.join("src/util.ts"), "export const n = 1;\n").unwrap();
    fs::write(
        root.join("apps/web/app/main.ts"),
        "import { n } from '@/util';\n",
    )
    .unwrap();

    let walk = run(&root, &[], None);
    let find = |rel: &str| {
        walk.iter()
            .find(|v| v["rel"] == rel)
            .unwrap_or_else(|| panic!("missing {rel}"))
    };

    assert_eq!(
        find("cmd/main.go")["resolvedImports"],
        serde_json::json!(["cmd/util/help.go"])
    );
    let elixir = find("lib/foo/use.ex")["resolvedImports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(elixir.contains(&"lib/foo/bar.ex".to_string()), "{elixir:?}");
    assert!(elixir.contains(&"lib/foo/baz.ex".to_string()), "{elixir:?}");
    assert_eq!(
        find("apps/web/app/main.ts")["resolvedImports"],
        serde_json::json!(["src/util.ts"])
    );

    fs::remove_dir_all(root).unwrap();
}

/// `calls` is tri-state on the wire: `[]` = an extraction language parsed the
/// file and it has NO call sites (a known answer), key absent = no call
/// extraction ran for that record at all. The JS side falls back to its text
/// heuristic only on the absent case, so a parsed-but-callless file must not
/// silently drop the key.
#[test]
fn calls_are_known_empty_when_parsed_and_absent_when_not_extracted() {
    let root = fixture();
    fs::write(root.join("src/quiet.ts"), "export const answer = 42;\n").unwrap();
    // Not decodable as UTF-8: the record carries a parseError and nothing was
    // parsed, so `calls` must stay unknown.
    fs::write(
        root.join("src/broken.ts"),
        [0xffu8, 0xfe, 0x00, 0x66].as_slice(),
    )
    .unwrap();

    let walk = run(&root, &[], None);
    let find = |rel: &str| {
        walk.iter()
            .find(|value| value["rel"] == rel)
            .unwrap_or_else(|| panic!("missing {rel}"))
    };

    // Parsed, no call sites → known empty.
    assert_eq!(find("src/quiet.ts")["calls"], serde_json::json!([]));
    assert_eq!(
        find("java/com/acme/User.java")["calls"],
        serde_json::json!([])
    );
    // Parsed, one call site — wire v2: [name, line, col, kind, recv, inSymbol]
    // with kind 0 = call, and no endCol (it is col + name length).
    assert_eq!(
        find("src/main.ts")["calls"],
        serde_json::json!([["answer", 2, 32, 0, "", "main"]])
    );
    // Not parsed → no key at all.
    let broken = find("src/broken.ts");
    assert!(
        !broken["parseError"].as_str().unwrap().is_empty(),
        "{broken}"
    );
    assert!(broken.get("calls").is_none(), "{broken}");

    // Manifest records read no text, so they never answer.
    let manifest = run(&root, &["--manifest"], None);
    assert!(
        manifest.iter().all(|value| value.get("calls").is_none()),
        "manifest must not claim a call answer"
    );

    // Reused nodes are not parsed here either; JS keeps its own cached calls.
    let reused_meta = serde_json::json!({ "rel": "src/dep.ts", "lang": "typescript" });
    let files = run(
        &root,
        &["--files", "src/quiet.ts"],
        Some(&format!("{reused_meta}\n")),
    );
    let fresh = files
        .iter()
        .find(|value| value["rel"] == "src/quiet.ts")
        .expect("fresh record");
    assert_eq!(fresh["calls"], serde_json::json!([]));
    let reused = files
        .iter()
        .find(|value| value["rel"] == "src/dep.ts")
        .expect("reused record");
    assert!(reused.get("calls").is_none(), "{reused}");

    fs::remove_dir_all(root).unwrap();
}

/// Wire v2 tuple `[name, line, col, kind, recv, inSymbol]` → the readable
/// object the fixtures are written in. `endCol` and the `kind` token are
/// derived, and an empty `recv` means "no receiver", so the key is dropped.
fn call_tuple_to_object(call: &serde_json::Value) -> serde_json::Value {
    let tuple = call
        .as_array()
        .unwrap_or_else(|| panic!("call must be a v2 tuple, got {call}"));
    assert_eq!(tuple.len(), 6, "v2 tuple has 6 elements: {call}");
    let name = tuple[0].as_str().expect("name");
    let col = tuple[2].as_u64().expect("col");
    let kind = match tuple[3].as_u64().expect("kind") {
        0 => "call",
        1 => "method",
        2 => "new",
        other => panic!("unknown kind code {other} in {call}"),
    };
    let recv = tuple[4].as_str().expect("recv");
    let mut object = serde_json::Map::new();
    object.insert("name".into(), name.into());
    object.insert("line".into(), tuple[1].clone());
    object.insert("col".into(), tuple[2].clone());
    object.insert("endCol".into(), (col + name.chars().count() as u64).into());
    object.insert("kind".into(), kind.into());
    if !recv.is_empty() {
        object.insert("recv".into(), recv.into());
    }
    object.insert("inSymbol".into(), tuple[5].clone());
    serde_json::Value::Object(object)
}

/// Call-site fixtures: `tests/fixtures/calls/<lang>/sample.<ext>` plus the
/// `expected.json` that language's fixture author wrote (`{"calls":[...]}`).
///
/// The comparison is EXACT — every field of every call, in order — because
/// `calls` is a protocol contract, not a heuristic. Fixtures are authored
/// separately from the extractor, so a language directory that does not exist
/// yet, or that has no `expected.json`, is SKIPPED with a message instead of
/// failing the run; the emitted list is never used as the expectation.
///
/// The fixtures stay in the READABLE object form (the v1 shape, with `endCol`
/// and a `kind` token) because a human writes and reviews them; the wire is
/// the v2 positional tuple. This test converts the emitted tuples back to that
/// object shape, which is lossless: `endCol` is `col` + the character length
/// of the name, and the kind code maps 0/1/2 → call/method/new.
#[test]
fn call_fixtures_match_expected_calls_exactly() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/calls");
    if !root.is_dir() {
        eprintln!(
            "call fixtures skipped: {} does not exist yet (fixtures are authored separately)",
            root.display()
        );
        return;
    }

    let mut dirs: Vec<std::path::PathBuf> = fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    dirs.sort();

    let mut checked: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();

    for dir in dirs {
        let lang = dir.file_name().unwrap().to_string_lossy().to_string();
        let sample = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.file_stem().is_some_and(|stem| stem == "sample"));
        let expected_path = dir.join("expected.json");
        let (Some(sample), true) = (sample, expected_path.is_file()) else {
            skipped.push(lang);
            continue;
        };

        let rel = format!("{lang}/{}", sample.file_name().unwrap().to_string_lossy());
        let records = run(&root, &["--files", &rel], Some(""));
        let record = records
            .iter()
            .find(|value| value["rel"] == rel)
            .unwrap_or_else(|| panic!("{rel}: no FileRecord emitted"));
        let actual = serde_json::Value::Array(
            record
                .get("calls")
                .and_then(|calls| calls.as_array())
                .map(|calls| calls.iter().map(call_tuple_to_object).collect())
                .unwrap_or_default(),
        );

        let expected: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&expected_path).unwrap())
                .unwrap_or_else(|error| panic!("{}: {error}", expected_path.display()));
        let expected = expected
            .get("calls")
            .cloned()
            .unwrap_or_else(|| panic!("{}: no `calls` key", expected_path.display()));

        if actual == expected {
            checked.push(lang);
        } else {
            failures.push(format!(
                "{lang}:\n  expected {}\n  actual   {}",
                serde_json::to_string(&expected).unwrap(),
                serde_json::to_string(&actual).unwrap()
            ));
        }
    }

    if !skipped.is_empty() {
        eprintln!(
            "call fixtures skipped (no sample/expected.json yet): {}",
            skipped.join(", ")
        );
    }
    assert!(
        failures.is_empty(),
        "call fixtures differ:\n{}",
        failures.join("\n")
    );
    eprintln!("call fixtures checked: {}", checked.join(", "));
}

/// Copy `tests/fixtures/resolve/<name>` into a fresh temp root and return it.
///
/// The fixtures are COPIED rather than walked in place for two reasons: the
/// resolvers are relative to the graph root, which must be the fixture root
/// and not this repository, and `_node_modules` has to arrive under its real
/// name — the repository ignores `node_modules/` everywhere, and the walk
/// honours git ignore rules, so a directory committed under that name would be
/// invisible to the very resolver leg it exists to prove.
fn resolve_fixture(name: &str) -> std::path::PathBuf {
    fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let raw = entry.file_name().to_string_lossy().to_string();
            let name = if raw == "_node_modules" {
                "node_modules".to_string()
            } else {
                raw
            };
            let target = to.join(name);
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), &target).unwrap();
            }
        }
    }

    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/resolve")
        .join(name);
    assert!(source.is_dir(), "missing fixture {}", source.display());
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-resolve-{name}-{nonce}"));
    copy_tree(&source, &root);
    root
}

fn resolved(walk: &[serde_json::Value], rel: &str) -> Vec<String> {
    walk.iter()
        .find(|value| value["rel"] == rel)
        .unwrap_or_else(|| panic!("missing {rel} in {walk:?}"))["resolvedImports"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Solidity import resolution: relative first, then `node_modules/<spec>`,
/// then the project root. A spec that names none of those (an npm package that
/// is not vendored here) is an external dependency and produces no edge.
#[test]
fn solidity_imports_resolve_relative_then_node_modules_then_root() {
    let root = resolve_fixture("solidity");
    let walk = run(&root, &[], None);

    assert_eq!(
        resolved(&walk, "contracts/Token.sol"),
        vec![
            "contracts/Base.sol",
            "lib/Math.sol",
            "node_modules/@acme/erc20/IERC20.sol",
            "contracts/Registry.sol",
        ]
    );
    assert_eq!(
        walk.iter()
            .find(|value| value["rel"] == "contracts/Base.sol")
            .unwrap()["importedBy"],
        serde_json::json!(["contracts/Token.sol"])
    );
    // The un-vendored package is still reported as a raw import.
    let raw = walk
        .iter()
        .find(|value| value["rel"] == "contracts/Token.sol")
        .unwrap()["rawImports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(
        raw.contains(&"@openzeppelin/contracts/token/ERC20.sol"),
        "{raw:?}"
    );

    fs::remove_dir_all(root).unwrap();
}

/// Haskell module resolution: `A.B.C` is a path, searched from the importing
/// file's directory up through its ancestors, each with `src`/`lib`/`app`/
/// `test`. A module that is not in the tree (`Data.List`) is a package.
#[test]
fn haskell_modules_resolve_by_walking_up_the_source_dirs() {
    let root = resolve_fixture("haskell");
    let walk = run(&root, &[], None);

    // `Acme.Util` is found under the root's `src/`, `Sibling` next to the file.
    assert_eq!(
        resolved(&walk, "app/Main.hs"),
        vec!["src/Acme/Util.hs", "app/Sibling.hs"]
    );
    // From `src/Acme`, the ancestor `src` holds `Acme/Internal/Helper.hs`.
    assert_eq!(
        resolved(&walk, "src/Acme/Util.hs"),
        vec!["src/Acme/Internal/Helper.hs"]
    );
    // Two ancestors up: `app/deep` and `app` hold nothing, so the module is
    // only found once the walk reaches the root and tries its `src/`.
    assert_eq!(resolved(&walk, "app/deep/Far.hs"), vec!["src/Acme/Util.hs"]);
    // An external package resolves to nothing at all.
    assert!(resolved(&walk, "src/Acme/Internal/Helper.hs").is_empty());

    fs::remove_dir_all(root).unwrap();
}

/// Terraform module resolution: a local `source` names a DIRECTORY, so the
/// edge fans out to every `.tf` file directly inside it — not to a nested
/// directory (its own module) and not to a registry source.
#[test]
fn hcl_local_module_sources_resolve_to_every_tf_in_the_directory() {
    let root = resolve_fixture("hcl");
    let walk = run(&root, &[], None);

    assert_eq!(
        resolved(&walk, "main.tf"),
        vec!["modules/vpc/main.tf", "modules/vpc/variables.tf"]
    );
    assert_eq!(
        walk.iter()
            .find(|value| value["rel"] == "modules/vpc/variables.tf")
            .unwrap()["importedBy"],
        serde_json::json!(["main.tf"])
    );
    // Registry/remote sources stay raw imports with no resolution.
    let raw = walk.iter().find(|value| value["rel"] == "main.tf").unwrap()["rawImports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(raw.contains(&"hashicorp/aws"), "{raw:?}");

    fs::remove_dir_all(root).unwrap();
}

/// Tokens are the candidate index the JS side reads as `tokenSymbols`: every
/// identifier that occurs in CODE, and nothing that occurs only in a comment
/// or a string body. The list is sorted, unique, and always present.
#[test]
fn tokens_hold_code_identifiers_only() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-tokens-{nonce}"));
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("sample.ts"),
        r#"// commentOnly mentions nothing real.
import { helper } from './helper.js';
const label = "stringOnly";
const url = `https://x/${interpolated}`;
export function run(): void {
  helper(label, url);
}
"#,
    )
    .unwrap();

    let walk = run(&root, &[], None);
    let record = walk
        .iter()
        .find(|value| value["rel"] == "sample.ts")
        .expect("sample.ts");
    let tokens: Vec<&str> = record["tokens"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect();

    for present in ["helper", "label", "url", "run", "interpolated"] {
        assert!(
            tokens.contains(&present),
            "{present} missing from {tokens:?}"
        );
    }
    for absent in ["commentOnly", "stringOnly", "mentions", "https"] {
        assert!(!tokens.contains(&absent), "{absent} present in {tokens:?}");
    }
    let mut sorted = tokens.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(tokens, sorted, "tokens are sorted and unique");

    fs::remove_dir_all(root).unwrap();
}

/// `packageName` / `namespaceName` / `goPackageName` come from the declaration
/// node, so a mention in a comment or a string is not one — and C#'s
/// file-scoped form reports the same name as the block form.
#[test]
fn package_and_namespace_come_from_the_declaration_node() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("mixdog-graph-meta-{nonce}"));
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("A.java"),
        "// package com.decoy.commented;\npackage com.acme.app;\npublic class A {}\n",
    )
    .unwrap();
    fs::write(root.join("a.kt"), "package com.acme.kt\nclass K\n").unwrap();
    fs::write(
        root.join("scoped.cs"),
        "namespace Acme.Scoped;\npublic class S {}\n",
    )
    .unwrap();
    fs::write(
        root.join("block.cs"),
        "namespace Acme.Block {\n  public class B {}\n}\n",
    )
    .unwrap();
    fs::write(root.join("a.go"), "package mypkg\n\nfunc F() {}\n").unwrap();

    let walk = run(&root, &[], None);
    let field = |rel: &str, key: &str| -> String {
        walk.iter()
            .find(|value| value["rel"] == rel)
            .unwrap_or_else(|| panic!("missing {rel}"))
            .get(key)
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string()
    };

    assert_eq!(field("A.java", "packageName"), "com.acme.app");
    assert_eq!(field("a.kt", "packageName"), "com.acme.kt");
    assert_eq!(field("scoped.cs", "namespaceName"), "Acme.Scoped");
    assert_eq!(field("block.cs", "namespaceName"), "Acme.Block");
    assert_eq!(field("a.go", "goPackageName"), "mypkg");
    // Fields a language does not have stay absent, not empty.
    assert_eq!(field("a.go", "packageName"), "");
    assert_eq!(field("A.java", "namespaceName"), "");

    fs::remove_dir_all(root).unwrap();
}

/// The two remaining rows of the `calls` tri-state table answer by emitting NO
/// RECORD at all rather than a record without the key: a file over the 2 MB
/// cap is never read, and an extension that is not an extraction language is
/// never collected. Both are "the JS side hears nothing about this file",
/// which is a stronger statement than "calls unknown" and must stay that way
/// on both the walk and `--files`.
#[test]
fn oversized_and_non_extraction_files_produce_no_record() {
    let root = fixture();
    let padding = "x".repeat(2 * 1024 * 1024);
    fs::write(
        root.join("src/big.ts"),
        format!("export const pad = \"{padding}\";\nexport const used = pad.length;\n"),
    )
    .unwrap();
    fs::write(root.join("src/data.json"), "{\"a\": 1}\n").unwrap();

    let walk = run(&root, &[], None);
    assert!(
        walk.iter().all(|value| value["rel"] != "src/big.ts"),
        "a file over the size cap must not be indexed at all"
    );
    assert!(
        walk.iter().all(|value| value["rel"] != "src/data.json"),
        "a non-extraction extension must not be indexed at all"
    );
    // Control: the walk itself worked and still answers `calls` for a file it
    // did parse.
    let main = walk
        .iter()
        .find(|value| value["rel"] == "src/main.ts")
        .expect("src/main.ts");
    assert!(main.get("calls").is_some(), "{main}");

    // Explicit --files selection answers the same way: skipped, not empty.
    let files = run(
        &root,
        &["--files", "src/big.ts", "src/data.json", "src/main.ts"],
        Some(""),
    );
    let rels: Vec<&str> = files
        .iter()
        .map(|value| value["rel"].as_str().unwrap())
        .collect();
    assert_eq!(rels, vec!["src/main.ts"], "{rels:?}");

    fs::remove_dir_all(root).unwrap();
}
