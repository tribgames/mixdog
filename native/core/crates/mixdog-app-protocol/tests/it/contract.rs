//! Contract gates: protocol.md §14.1 (schema/TS golden + table-driven method
//! rows), §14.2 (envelope), DS-ALL-1 and DS-DUP-1 (DS §14, §16).

#![allow(clippy::disallowed_methods, reason = "test setup: reads goldens and writes its own sample files on the test thread")]

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::path::PathBuf;

use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_app_protocol::CLIENT_NOTIFICATIONS;
use mixdog_app_protocol::ClientRequest;
use mixdog_app_protocol::ErrorData;
use mixdog_app_protocol::JsonRpcMessage;
use mixdog_app_protocol::JsonRpcRequest;
use mixdog_app_protocol::Mutation;
use mixdog_app_protocol::OpScopeRule;
use mixdog_app_protocol::RequestId;
use mixdog_app_protocol::SERVER_NOTIFICATIONS;
use mixdog_app_protocol::SERVER_REQUESTS;
use mixdog_app_protocol::error::METHOD_NOT_FOUND;
use mixdog_app_protocol::export::FileKind;
use mixdog_app_protocol::inventory::INVENTORY;
use mixdog_app_protocol::inventory::InventoryList;
use mixdog_app_protocol::inventory::Target;
use mixdog_app_protocol::limits::CloseCode;
use mixdog_app_protocol::rpc::InboundText;
use mixdog_app_protocol::rpc::decode_inbound_text;
use mixdog_js::LoneAt;
use serde_json::Value;
use serde_json::json;

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn golden_path(kind: FileKind, name: &str) -> PathBuf {
    match kind {
        FileKind::Schema => crate_dir().join("schema").join(name),
        FileKind::TypeScript => crate_dir()
            .join("../../../../packages/protocol/src")
            .join(name),
    }
}

/// §14.1: the generated JSON Schema and TS equal the checked-in goldens.
/// `MIXDOG_UPDATE_PROTOCOL_GOLDEN=1` rewrites them.
#[test]
fn schema_and_typescript_goldens_match() {
    let update = std::env::var_os("MIXDOG_UPDATE_PROTOCOL_GOLDEN").is_some();
    let mut stale = Vec::new();
    for file in mixdog_app_protocol::export::generate() {
        let path = golden_path(file.kind, file.name);
        if update {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, &file.content).unwrap();
            continue;
        }
        let current = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        if current != file.content {
            stale.push(path.display().to_string());
        }
    }
    assert!(
        stale.is_empty(),
        "stale golden files (rerun with MIXDOG_UPDATE_PROTOCOL_GOLDEN=1): {stale:?}"
    );
}

fn resolve<'a>(schema: &'a Value, definitions: &'a Value) -> &'a Value {
    match schema.get("$ref").and_then(Value::as_str) {
        Some(reference) => {
            let name = reference.rsplit('/').next().unwrap();
            resolve(&definitions[name], definitions)
        }
        None => schema,
    }
}

/// §14.1 table-driven: every row has params/result types, scope, class,
/// mutation and an op-scope derivation; mutation rows require `opId`,
/// non-mutation rows do not carry it.
#[test]
fn every_method_row_is_complete() {
    let file = mixdog_app_protocol::export::generate()
        .into_iter()
        .find(|f| f.name == "client_methods.json")
        .unwrap();
    let schema: Value = serde_json::from_str(&file.content).unwrap();
    let definitions = &schema["definitions"];
    for spec in CLIENT_METHODS {
        let row = &schema["methods"][spec.method];
        assert!(
            row.get("params").is_some() && row.get("result").is_some(),
            "{} lacks types",
            spec.method
        );
        assert!(!spec.origins.is_empty(), "{} has no origins", spec.method);
        let params = resolve(&row["params"], definitions);
        let required: HashSet<&str> = params
            .get("required")
            .and_then(Value::as_array)
            .map(|r| r.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        match spec.mutation {
            Mutation::Op(_) => {
                assert!(
                    required.contains("opId"),
                    "mutation {} must require opId",
                    spec.method
                );
                assert_ne!(
                    spec.op_scope,
                    OpScopeRule::None,
                    "mutation {} needs an op scope",
                    spec.method
                );
            }
            Mutation::None => {
                assert!(
                    !required.contains("opId"),
                    "non-mutation {} must not require opId",
                    spec.method
                );
                assert_eq!(spec.op_scope, OpScopeRule::None, "{}", spec.method);
            }
        }
    }
    for method in ["blob/put", "blob/read"] {
        let spec = CLIENT_METHODS.iter().find(|s| s.method == method).unwrap();
        assert_eq!(spec.mutation, Mutation::None, "{method} is not a mutation");
    }
}

/// DS-DUP-1: every name appears once in each generated table, and the D1
/// duplicates collapse to their one survivor.
#[test]
fn ds_dup_1_no_duplicate_rows() {
    fn unique<'a>(label: &str, names: impl Iterator<Item = &'a str>) {
        let mut seen = HashSet::new();
        for name in names {
            assert!(seen.insert(name), "{label}: {name} appears twice");
        }
    }
    unique("client methods", CLIENT_METHODS.iter().map(|s| s.method));
    unique("server requests", SERVER_REQUESTS.iter().map(|s| s.method));
    unique(
        "server notifications",
        SERVER_NOTIFICATIONS.iter().map(|s| s.method),
    );
    unique(
        "client notifications",
        CLIENT_NOTIFICATIONS.iter().map(|s| s.method),
    );
    for (list, name) in [
        (InventoryList::Services, "deleteSession"),
        (InventoryList::Remote, "deleteSession"),
        (InventoryList::Actions, "deleteSession"),
    ] {
        assert_eq!(
            target_of(list, name),
            Some(&Target::Method("thread/delete")),
            "{name}"
        );
    }
    let quota = [
        ("getQuotaAutoResume", Target::Section("config")),
        ("setQuotaAutoResume", Target::Method("config/value/write")),
        (
            "scheduleQuotaResume",
            Target::Method("thread/quotaResume/schedule"),
        ),
        (
            "cancelQuotaResume",
            Target::Method("thread/quotaResume/cancel"),
        ),
    ];
    for (name, survivor) in &quota {
        for list in [
            InventoryList::Services,
            InventoryList::Remote,
            InventoryList::Actions,
        ] {
            assert_eq!(target_of(list, name), Some(survivor), "{list:?} {name}");
        }
    }
    let survivors: BTreeMap<&str, Vec<&Target>> = [
        "listProviderModels",
        "continueSessionInModel",
        "setFast",
        "stopShellJob",
        "releaseShellJob",
    ]
    .into_iter()
    .map(|name| {
        (
            name,
            INVENTORY
                .iter()
                .filter(|(_, n, _)| *n == name)
                .map(|(_, _, t)| t)
                .collect(),
        )
    })
    .collect();
    for (name, targets) in survivors {
        let distinct: HashSet<String> = targets.iter().map(|t| format!("{t:?}")).collect();
        assert_eq!(
            distinct.len(),
            1,
            "{name} maps to several targets: {distinct:?}"
        );
    }
}

/// CCR-4: scope and opScope fields are wire paths; agent home is keyed per agent.
/// `terminal/ensure` without a `tabId` makes a new tab: nothing to order against, so it runs
/// concurrently; naming a tab serializes on that tab like every other terminal request.
#[test]
fn terminal_ensure_is_keyed_by_its_tab_only_when_it_names_one() {
    use mixdog_app_protocol::common::SerializationScope;
    let scope = |params: Value| {
        let request = JsonRpcRequest { id: RequestId::Integer(1), method: "terminal/ensure".into(), params: Some(params), trace: None, lone_surrogates: Vec::new() };
        ClientRequest::from_jsonrpc(request).unwrap().serialization_scope()
    };
    assert_eq!(scope(json!({ "opId": "o1", "options": {} })), None);
    assert_eq!(
        scope(json!({ "opId": "o2", "tabId": "tab1", "options": {} })),
        Some(SerializationScope::Terminal { tab_id: "tab1".into() })
    );
}
#[test]
fn method_table_fields_are_wire_paths() {
    let table = serde_json::to_value(CLIENT_METHODS).unwrap();
    for row in table.as_array().unwrap() {
        for column in ["scope", "opScope"] {
            if let Some(field) = row[column]["field"].as_str() {
                assert!(
                    !field.contains('_'),
                    "{} {column}.field {field}",
                    row["method"]
                );
            }
        }
    }
    let reset = CLIENT_METHODS
        .iter()
        .find(|s| s.method == "agent/home/reset")
        .unwrap();
    assert!(matches!(
        reset.scope,
        mixdog_app_protocol::ScopeRule::Keyed {
            field: "agentId",
            ..
        }
    ));
    let home = table
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["method"] == "agent/home/reset")
        .unwrap();
    assert_eq!(
        home["scope"],
        serde_json::json!({"kind": "keyed", "namespace": "agentHome", "field": "agentId"})
    );
}

/// Domain error details decode today's producer payloads without loss.
#[test]
fn domain_error_details_match_producers() {
    for payload in [
        serde_json::json!({"type": "worktreeDirty", "reason": "project-dirty", "files": ["a.txt"], "count": 1}),
        serde_json::json!({"type": "worktreeDirty", "reason": "too-large", "files": 900, "maxFiles": 500}),
        serde_json::json!({"type": "worktreeBranchOccupied", "branch": "main"}),
        serde_json::json!({"type": "worktreeBranchOccupied", "branch": "main", "path": "/w", "kind": "session", "sessionId": "s1"}),
    ] {
        let detail: mixdog_protocol::DomainErrorDetail =
            serde_json::from_value(payload.clone()).unwrap();
        assert_eq!(serde_json::to_value(&detail).unwrap(), payload);
    }
}

fn target_of(list: InventoryList, name: &str) -> Option<&'static Target> {
    INVENTORY
        .iter()
        .find(|(l, n, _)| *l == list && *n == name)
        .map(|(_, _, t)| t)
}

/// DS-ALL-1: each of the 173 operations, 61 service methods, 190 phone
/// methods and 303 session actions is mapped exactly once, to a target that
/// exists in the generated tables.
#[test]
fn ds_all_1_every_inventory_name_is_mapped_once() {
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(crate_dir().join("tests/fixtures/parity-inventory.json")).unwrap(),
    )
    .unwrap();
    let lists = [
        (InventoryList::Operations, "operations", 173),
        (InventoryList::Services, "services", 61),
        (InventoryList::Remote, "remote", 190),
        (InventoryList::Actions, "actions", 303),
    ];
    let methods: HashSet<&str> = CLIENT_METHODS.iter().map(|s| s.method).collect();
    let notifications: HashSet<&str> = SERVER_NOTIFICATIONS.iter().map(|s| s.method).collect();
    let client_notifications: HashSet<&str> =
        CLIENT_NOTIFICATIONS.iter().map(|s| s.method).collect();
    let server_requests: HashSet<&str> = SERVER_REQUESTS.iter().map(|s| s.method).collect();
    let sections: HashSet<&str> = mixdog_protocol::SectionName::ALL
        .iter()
        .map(|s| s.wire())
        .collect();
    for (list, key, count) in lists {
        let expected: Vec<&str> = fixture[key]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(expected.len(), count, "fixture {key}");
        let mapped: Vec<&str> = INVENTORY
            .iter()
            .filter(|(l, _, _)| *l == list)
            .map(|(_, n, _)| *n)
            .collect();
        let mut seen = HashSet::new();
        for name in &mapped {
            assert!(seen.insert(*name), "{key}: {name} mapped twice");
        }
        let expected_set: HashSet<&str> = expected.iter().copied().collect();
        let unmapped: Vec<_> = expected.iter().filter(|n| !seen.contains(*n)).collect();
        let unknown: Vec<_> = mapped
            .iter()
            .filter(|n| !expected_set.contains(*n))
            .collect();
        assert!(unmapped.is_empty(), "{key}: unmapped {unmapped:?}");
        assert!(unknown.is_empty(), "{key}: not in inventory {unknown:?}");
    }
    for (list, name, target) in INVENTORY {
        let ok = match target {
            Target::Method(m) => methods.contains(m),
            Target::Methods(ms) => !ms.is_empty() && ms.iter().all(|m| methods.contains(m)),
            Target::Section(s) => sections.contains(s),
            Target::Notification(n) => notifications.contains(n),
            Target::ClientNotification(n) => client_notifications.contains(n),
            Target::ServerRequestResponse(r) | Target::HostRequest(r) => {
                server_requests.contains(r)
            }
            Target::MediaFrame(p)
            | Target::InitializeField(p)
            | Target::ByDesign(p)
            | Target::Internal(p)
            | Target::Deleted(p) => !p.is_empty(),
        };
        assert!(ok, "{list:?} {name}: target {target:?} does not exist");
    }
}

/// Transcript-row facts the client fold needs travel typed and round-trip unchanged.
#[test]
fn transcript_row_facts_round_trip() {
    use mixdog_protocol::ThreadItem;
    let hash = "a".repeat(64);
    let items = [
        json!({"type": "userMessage", "id": "u1", "content": [{"type": "text", "text": "hi"}],
            "displayText": "hi", "countsForPromptHistory": true,
            "details": {"source": "routine-trigger", "routineTrigger": {"kind": "webhook", "name": "w", "event": "e"},
                "sender": "lead", "fromAgent": "bot", "steered": true, "submissionIds": ["s1"],
                "attachments": [{"id": hash, "attachmentRef": hash, "kind": "image", "name": "a.png",
                    "mimeType": "image/png", "size": 3, "original": {"attachmentRef": hash, "mimeType": "image/jpeg"}}],
                "images": [{"id": null, "name": "a", "mimeType": "image/png", "bytes": 3}],
                "imageRefs": [{"line": "[Image: a]", "ref": hash}],
                "reactions": [{"agentId": "a1", "emoji": "x", "at": 5}]},
            "meta": {"messageId": "msg_1", "posted": true}}),
        json!({"type": "toolCall", "id": "t1", "name": "__aggregate__", "input": {},
            "run": {"callId": "c1", "isError": false, "startedAt": 1, "completedAt": 2, "uiDiff": "d",
                "toolMeta": {"code": "cu", "missing": ["screen"], "ownerSessionId": "s"},
                "aggregate": {"callIds": ["c1"], "categoryOrder": ["Read|r|r|file|files"],
                    "categories": {"Read|r|r|file|files": {"key": "Read|r|r|file|files", "category": "Read",
                        "active": "r", "done": "r", "noun": "file", "pluralNoun": "files", "effect": false, "count": 1}},
                    "doneCategories": {}, "completedCount": 1}},
            "meta": {}}),
        json!({"type": "contextCompaction", "id": "k1", "status": "compacted", "meta": {"label": "Conversation compacted"}}),
        json!({"type": "roomRow", "id": "r1", "text": "",
            "room": {"kind": "cap", "limit": "usage", "usage": {"kind": "k", "provider": "p", "model": "m", "resetAt": null},
                "to": ["a"], "toName": ["A"], "rounds": 2},
            "meta": {"messageId": "r1"}}),
    ];
    for value in items {
        let item: ThreadItem = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&item).unwrap(), value);
    }
}

/// The shipped defaults satisfy their own P §6.5 startup invariants, and a
/// default-size `blob/put` chunk, base64-encoded, fits an inbound frame.
#[test]
fn default_limits_pass_their_own_check() {
    let limits = mixdog_app_protocol::limits::Limits::default();
    limits.check().unwrap();
    let encoded = limits.max_blob_put_chunk_bytes.div_ceil(3) * 4;
    assert!(encoded < limits.max_inbound_frame_bytes);
    assert_eq!(limits.max_blob_put_chunk_bytes % 3, 0);
}

/// §14.2: the parity envelope vectors round-trip with identical shape.
#[test]
fn envelope_round_trips_codex_vectors() {
    let vectors = [
        json!({"id": 1, "method": "thread/start", "params": {"opId": "o"}}),
        json!({"id": "a", "method": "initialize", "params": {}, "trace": {"traceparent": "00-x-y-01"}}),
        json!({"method": "initialized"}),
        json!({"method": "turn/started", "params": {}, "emittedAtMs": 5, "feed": {"id": "t", "epoch": "e", "seq": 3}}),
        json!({"id": 7, "result": {"ok": true}}),
        json!({"id": "b", "error": {"code": -32601, "message": "m", "data": {"reason": "methodNotFound", "method": "x"}}}),
    ];
    for vector in vectors {
        let message: JsonRpcMessage = serde_json::from_value(vector.clone()).unwrap();
        assert_eq!(serde_json::to_value(&message).unwrap(), vector);
    }
    assert!(
        serde_json::from_value::<JsonRpcMessage>(json!({"id": 1, "result": 1, "jsonrpc": "2.0"}))
            .is_ok()
    );
}

/// §14.2: unknown method → -32601; oversized frame → 1009; bad JSON → 1007.
#[test]
fn envelope_failure_codes() {
    let request = JsonRpcRequest {
        id: RequestId::Integer(1),
        method: "no/such".into(),
        params: None,
        trace: None,
        lone_surrogates: Vec::new(),
    };
    let error = ClientRequest::from_jsonrpc(request)
        .unwrap_err()
        .into_error_data();
    assert_eq!(error.code(), METHOD_NOT_FOUND);
    assert!(matches!(error, ErrorData::MethodNotFound { .. }));

    let big = format!("{{\"method\":\"x\",\"params\":\"{}\"}}", "a".repeat(64));
    assert_eq!(
        decode_inbound_text(&big, 16).close_code(),
        Some(CloseCode::FrameTooBig)
    );
    assert_eq!(CloseCode::FrameTooBig.code(), 1009);
    let bad = decode_inbound_text("{not json", 1 << 20);
    assert_eq!(bad, InboundText::Invalid);
    assert_eq!(bad.close_code().map(CloseCode::code), Some(1007));
}

/// A request holding unpaired surrogate escapes (a high one, a low one, a reversed pair, in a key, in a nested
/// value, in the method name) is a request, read with U+FFFD in each place; a pair stays the character it encodes.
/// A frame that is not JSON stays refused (1007). Node accepts such a frame (`JSON.parse`); the recording is
/// `native/core/fixtures/inbound-lone-surrogate`.
#[test]
fn unpaired_surrogate_escapes_are_read_as_replacement_characters() {
    let frame = r#"{"id":1,"method":"x\ud83d","params":{"a":"\ud800 \udc00 \ude00\ud83d \ud83d\ude00","\udbff":{"n":["\ude00"]}}}"#;
    let InboundText::Message(JsonRpcMessage::Request(request)) = decode_inbound_text(frame, 1 << 20) else { panic!("not a request") };
    assert_eq!(request.method, "x\u{fffd}");
    assert_eq!(
        request.params,
        Some(json!({"a": "\u{fffd} \u{fffd} \u{fffd}\u{fffd} \u{1f600}", "\u{fffd}": {"n": ["\u{fffd}"]}}))
    );
    // Where it happened, for the server's refusal of every place that is no free-text field: the strings that held one,
    // not the ones that hold a real U+FFFD; a place outside the params (the method name) behind `#`.
    // A string is named once, then each lone unit it held with its UTF-16 index ([`LoneAt::Unit`]); the order is the parsed
    // map's.
    let places = |lone: &[LoneAt]| lone.iter().filter(|at| !matches!(at, LoneAt::Unit { .. })).cloned().collect::<Vec<_>>();
    let mut named = places(&request.lone_surrogates);
    named.sort();
    let mut expected = vec![LoneAt::Value("#/method".into()), LoneAt::Value("/a".into()), LoneAt::Key("/\u{fffd}".into()), LoneAt::Value("/\u{fffd}/n/0".into())];
    expected.sort();
    assert_eq!(named, expected);
    assert_eq!(LoneAt::units_at(&request.lone_surrogates, "/a"), [(0, 0xd800), (2, 0xdc00), (4, 0xde00), (5, 0xd83d)]);
    assert_eq!(LoneAt::units_at(&request.lone_surrogates, "#/method"), [(1, 0xd83d)]);
    let frame = r#"{"id":2,"method":"m","params":{"content":"a\ufffdb","relPath":"n\ude00.txt"}}"#;
    let InboundText::Message(JsonRpcMessage::Request(request)) = decode_inbound_text(frame, 1 << 20) else { panic!("not a request") };
    assert_eq!(request.lone_surrogates, [LoneAt::Value("/relPath".into()), LoneAt::Unit { pointer: "/relPath".into(), at: 1, unit: 0xde00 }]);
    // Upper-case hex is the same escape; an escaped backslash before `u` is no escape; an escaped valid pair is one character.
    let frame = r#"{"id":3,"method":"m","params":["\uD83D x","\\ud83d","\uD83D\uDE00","\ud83d\u0041","\ud83d\ud83d\ude00"]}"#;
    let InboundText::Message(JsonRpcMessage::Request(request)) = decode_inbound_text(frame, 1 << 20) else { panic!("not a request") };
    assert_eq!(request.params, Some(json!(["\u{fffd} x", "\\ud83d", "\u{1f600}", "\u{fffd}A", "\u{fffd}\u{1f600}"])));
    assert_eq!(places(&request.lone_surrogates), [LoneAt::Value("/0".into()), LoneAt::Value("/3".into()), LoneAt::Value("/4".into())]);
    let bad = decode_inbound_text(r#"{"id":1,"method":"\ud800"#, 1 << 20);
    assert_eq!(bad.close_code().map(CloseCode::code), Some(1007));
}

/// Every inbound kind keeps where its payload held a lone unit: a notification (no id) its `params`, a client's answer its
/// `result`, an error answer its `error`; a key as a key.
#[test]
fn every_inbound_kind_names_its_lone_surrogates() {
    let decode = |frame: &str| match decode_inbound_text(frame, 1 << 20) {
        InboundText::Message(message) => message,
        other => panic!("{frame}: {other:?}"),
    };
    let note = decode(r#"{"method":"x","params":{"a":"\ud800"}}"#);
    assert!(matches!(note, JsonRpcMessage::Notification(_)));
    let unit = |pointer: &str, at, unit| LoneAt::Unit { pointer: pointer.into(), at, unit };
    assert_eq!(note.lone_surrogates(), [LoneAt::Value("/a".into()), unit("/a", 0, 0xd800)]);
    let answer = decode(r#"{"id":"s1","result":{"answers":{"q\ud83d":"x"}}}"#);
    assert!(matches!(answer, JsonRpcMessage::Response(_)));
    assert_eq!(answer.lone_surrogates(), [LoneAt::Key("/answers/q\u{fffd}".into())]);
    let failed = decode(r#"{"id":"s1","error":{"code":1,"message":"m\udc00"}}"#);
    assert!(matches!(failed, JsonRpcMessage::Error(_)));
    assert_eq!(failed.lone_surrogates(), [LoneAt::Value("/message".into()), unit("/message", 1, 0xdc00)]);
    let id = decode(r#"{"id":"r\ud800","method":"m","params":{}}"#);
    assert_eq!(id.lone_surrogates(), [LoneAt::Value("#/id".into()), unit("#/id", 1, 0xd800)]);
    // The same key twice is one key to Node too (the last value).
    let JsonRpcMessage::Request(twice) = decode(r#"{"id":1,"method":"m","params":{"a":1,"a":2}}"#) else { panic!("not a request") };
    assert_eq!(twice.params, Some(json!({"a": 2})));
}

/// Every string field of every client request, client notification and answer to a server request (read from the
/// schema goldens, and inside the values the schema leaves untyped from the inventory's `payloads`), a map's keys
/// included, is in exactly one class of `free_text_fields.json` with its reason, and the `free` class is exactly
/// `free_text::FREE_TEXT`, either way: the inventory is the statement the table is checked against. A part classed whole
/// (`**`) is only one the inventory declares `open` (no fixed fields by nature), in the class it declares.
#[test]
fn every_string_field_is_classed_once_and_free_text_is_listed_free() {
    use mixdog_app_protocol::free_text::FREE_TEXT;
    use mixdog_app_protocol::free_text::Kind;
    use std::collections::BTreeSet;
    fn untyped(schema: &Value) -> bool {
        schema == &Value::Bool(true)
            || schema.as_object().is_some_and(|object| {
                !["type", "$ref", "anyOf", "oneOf", "allOf", "properties", "items", "enum", "const", "additionalProperties"]
                    .iter()
                    .any(|key| object.contains_key(*key))
            })
    }
    fn walk(schema: &Value, defs: &Value, path: &str, out: &mut BTreeSet<String>, seen: &[String]) {
        if schema.is_null() || schema == &Value::Bool(false) {
            return;
        }
        if untyped(schema) {
            out.insert(format!("{path}/**"));
            return;
        }
        if let Some(name) = schema["$ref"].as_str().and_then(|r| r.rsplit('/').next()) {
            if seen.iter().any(|s| s == name) {
                out.insert(format!("{path}/**"));
                return;
            }
            let seen = [seen, &[name.to_owned()]].concat();
            walk(&defs[name], defs, path, out, &seen);
        }
        for key in ["anyOf", "oneOf", "allOf"] {
            for branch in schema[key].as_array().into_iter().flatten() {
                walk(branch, defs, path, out, seen);
            }
        }
        let types: Vec<&str> = match &schema["type"] {
            Value::String(t) => vec![t.as_str()],
            Value::Array(ts) => ts.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if types.contains(&"string")
            || schema["enum"].as_array().is_some_and(|values| values.iter().any(Value::is_string))
            || schema["const"].is_string()
        {
            out.insert(path.to_owned());
        }
        for (key, property) in schema["properties"].as_object().into_iter().flatten() {
            walk(property, defs, &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")), out, seen);
        }
        if let Some(more) = schema.get("additionalProperties").filter(|more| *more != &Value::Bool(false)) {
            // A map: its keys are strings of their own class.
            out.insert(format!("{path}/{{}}"));
            walk(more, defs, &format!("{path}/*"), out, seen);
        }
        match &schema["items"] {
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    walk(item, defs, &format!("{path}/{index}"), out, seen);
                }
            }
            Value::Null => {}
            item => walk(item, defs, &format!("{path}/*"), out, seen),
        }
    }
    let schema = |name: &str| -> Value { serde_json::from_slice(&std::fs::read(crate_dir().join("schema").join(name)).unwrap()).unwrap() };
    let named: Value = serde_json::from_slice(&std::fs::read(crate_dir().join("tests/it/free_text_fields.json")).unwrap()).unwrap();
    let mut problems = Vec::new();
    // Each untyped value (`path/**`) is replaced by what `payloads` declares for it; one with no declaration is a failure.
    // The `**` parts left are the declared `open` ones, each with the class it must have.
    let mut used = BTreeSet::new();
    let mut open_class: BTreeMap<String, String> = BTreeMap::new();
    let mut expand = |kind: &str, method: &str, walked: BTreeSet<String>, problems: &mut Vec<String>| {
        let mut out = BTreeSet::new();
        for field in walked {
            let Some(at) = field.strip_suffix("/**") else {
                out.insert(field);
                continue;
            };
            let spec = &named["payloads"][kind][method][at];
            if spec.is_null() {
                problems.push(format!("{kind} {method} {field}: an untyped value whose fields are not enumerated in `payloads`"));
                continue;
            }
            used.insert(format!("{kind} {method} {at}"));
            assert!(spec["source"].as_str().is_some_and(|s| !s.is_empty()), "{kind} {method} {at}: a payload without its source");
            for sub in spec["fields"].as_array().into_iter().flatten() {
                out.insert(format!("{at}{}", sub.as_str().unwrap()));
            }
            if let Some(reference) = spec["schema"].as_str() {
                let (file, definition) = reference.split_once('#').unwrap();
                let file = schema(file);
                walk(&file["definitions"][definition], &file["definitions"], at, &mut out, &[definition.to_owned()]);
            }
            for (sub, open) in spec["open"].as_object().into_iter().flatten() {
                let class = open["class"].as_str().unwrap_or_default();
                if !["free", "refused"].contains(&class) || !open["reason"].as_str().is_some_and(|r| !r.is_empty()) {
                    problems.push(format!("{kind} {method} {at}{sub}: an open part without its class and reason"));
                }
                out.insert(format!("{at}{sub}/**"));
                open_class.insert(format!("{kind} {method} {at}{sub}/**"), class.to_owned());
            }
        }
        out
    };
    let mut fields: BTreeSet<String> = BTreeSet::new();
    for (file, kind) in [("client_request.json", "request"), ("client_notification.json", "notification")] {
        let file = schema(file);
        for variant in file["oneOf"].as_array().unwrap() {
            let method = &variant["properties"]["method"];
            let method = method["const"].as_str().or_else(|| method["enum"][0].as_str()).unwrap().to_owned();
            let mut out = BTreeSet::new();
            walk(&variant["properties"]["params"], &file["definitions"], "", &mut out, &[]);
            fields.extend(expand(kind, &method, out, &mut problems).into_iter().map(|f| format!("{kind} {method} {f}")));
        }
    }
    let answers = schema("server_request_methods.json");
    for (method, row) in answers["methods"].as_object().unwrap() {
        let mut out = BTreeSet::new();
        walk(&row["result"], &answers["definitions"], "", &mut out, &[]);
        fields.extend(expand("answer", method, out, &mut problems).into_iter().map(|f| format!("answer {method} {f}")));
    }
    for (kind, methods) in named["payloads"].as_object().unwrap() {
        for (method, paths) in methods.as_object().unwrap() {
            for at in paths.as_object().unwrap().keys().filter(|at| !used.contains(&format!("{kind} {method} {at}"))) {
                problems.push(format!("{kind} {method} {at}: a payload declaration for no untyped value of the schema"));
            }
        }
    }
    // The inventory's classes: every field once, with its reason.
    let mut class_of: BTreeMap<String, String> = BTreeMap::new();
    for group in named["classes"].as_array().unwrap() {
        let class = group["class"].as_str().unwrap();
        assert!(["free", "refused"].contains(&class), "a class that is neither free nor refused: {class}");
        assert!(group["reason"].as_str().is_some_and(|r| !r.is_empty()), "a class without its reason");
        for entry in group["fields"].as_array().unwrap() {
            let entry = entry.as_str().unwrap();
            if class_of.insert(entry.to_owned(), class.to_owned()).is_some() {
                problems.push(format!("{entry}: classed twice"));
            }
            if !fields.contains(entry) {
                problems.push(format!("{entry}: classed, not a string field of the schema"));
            }
        }
    }
    for field in &fields {
        match (class_of.get(field), open_class.get(field)) {
            (None, _) => problems.push(format!("{field}: a string field in no class")),
            (Some(class), Some(open)) if class != open => problems.push(format!("{field}: an open part classed {class}, declared {open}")),
            _ => {}
        }
    }
    // FREE_TEXT equals the inventory's free class, either way.
    let listed: BTreeSet<String> = FREE_TEXT
        .iter()
        .flat_map(|(kind, method, patterns)| {
            let kind = match kind {
                Kind::Request => "request",
                Kind::Notification => "notification",
                Kind::Answer => "answer",
            };
            patterns.iter().map(move |pattern| format!("{kind} {method} {pattern}"))
        })
        .collect();
    let free: BTreeSet<String> = class_of.iter().filter(|(_, class)| *class == "free").map(|(field, _)| field.clone()).collect();
    for field in listed.difference(&free) {
        problems.push(format!("{field}: in FREE_TEXT, not classed free in the inventory"));
    }
    for field in free.difference(&listed) {
        problems.push(format!("{field}: classed free in the inventory, not in FREE_TEXT"));
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// §14.3, wire half: the handshake refusals are `-32600` with their `reason`
/// data, a version refusal closes with 4002, and `initialize` is a method row.
#[test]
fn handshake_refusals_on_the_wire() {
    let outdated = |reason: &str| json!({"reason": reason, "serverVersion": "2.0.0", "clientVersion": "1.4.6"});
    for (data, wire) in [
        (
            ErrorData::NotInitialized,
            json!({"reason": "notInitialized"}),
        ),
        (
            ErrorData::AlreadyInitialized,
            json!({"reason": "alreadyInitialized"}),
        ),
        (
            ErrorData::ClientOutdated {
                server_version: "2.0.0".into(),
                client_version: "1.4.6".into(),
            },
            outdated("clientOutdated"),
        ),
        (
            ErrorData::ServerOutdated {
                server_version: "2.0.0".into(),
                client_version: "1.4.6".into(),
            },
            outdated("serverOutdated"),
        ),
    ] {
        assert_eq!(data.code(), -32600);
        assert_eq!(serde_json::to_value(&data).unwrap(), wire);
        assert_eq!(
            serde_json::from_value::<ErrorData>(wire.clone()).unwrap(),
            data
        );
        assert_eq!(data.into_body("m").data, Some(wire));
    }
    assert_eq!(CloseCode::VersionRefused.code(), 4002);
    assert!(CLIENT_METHODS.iter().any(|s| s.method == "initialize"));
}

/// WP-CLIENT-TS / WP-CONFIG / WP-PHONE contract changes, as they travel.
#[test]
fn product_state_shapes_on_the_wire() {
    use mixdog_app_protocol::ServerNotification;
    let decode = |value: Value| serde_json::from_value::<ServerNotification>(value);
    // The provider account clears with null.
    assert!(
        decode(json!({"method": "thread/providerAccount/changed", "params": {"threadId": "t", "value": null}})).is_ok()
    );
    // hasOlder rides the history reset.
    assert!(
        decode(json!({"method": "thread/historyReset", "params": {"threadId": "t", "reason": "clear", "hasOlder": false}})).is_ok()
    );
    assert!(
        decode(json!({"method": "thread/historyReset", "params": {"threadId": "t", "reason": "clear"}})).is_err()
    );
    // Prompt history: both increment kinds.
    for value in [
        json!({"kind": "added", "prompt": "p"}),
        json!({"kind": "replaced", "prompts": ["b", "a"]}),
    ] {
        assert!(
            decode(json!({"method": "thread/promptHistory/updated", "params": {"threadId": "t", "value": value}})).is_ok()
        );
    }
    // The notifications config value is today's file without its version.
    let prefs: mixdog_protocol::NotificationPreferences = serde_json::from_value(json!({
        "migratedAt": 5,
        "devices": {"pc": {"scope": "bots", "events": {"error": true}, "quietHours": {"days": "weekends"}}},
        "overrides": [
            {"target": {"kind": "agent", "id": "a1"}, "setting": {"mode": "muted", "until": null}},
            {"target": {"kind": "room", "id": "r"}, "setting": {"mode": "always"}}
        ]
    }))
    .unwrap();
    assert_eq!(prefs.devices["pc"].scope, mixdog_protocol::NotificationScope::Bots);
    assert!(prefs.devices["pc"].events.finished && prefs.devices["pc"].events.error);
    assert_eq!(
        serde_json::to_value(&prefs.overrides[0]).unwrap(),
        json!({"target": {"kind": "agent", "id": "a1"}, "setting": {"mode": "muted", "until": null}})
    );
}

/// `host/state/set` `visualize`: Node's change event and claim snapshot, byte for byte, with the
/// explicit `null`s (`active`, a live tab's `version`) kept.
#[test]
fn host_state_set_visualize_on_the_wire() {
    use mixdog_app_protocol::v2::host::HostStateSetParams;
    let tab = json!({
        "id": "t1", "label": "Mock", "remoteLabel": "mock.html", "revision": 2, "cwd": "/p",
        "panes": [{"kind": "html", "label": "mock.html", "target": "mock.html", "path": "/p/mock.html",
                   "remoteTarget": "mock.html", "root": "/p"},
                  {"kind": "inline", "label": "g", "target": "g", "path": "", "remoteTarget": "g",
                   "inline": {"kind": "mermaid", "source": "graph TD", "deferred": true}}],
        "networkAllowed": true, "version": null,
        "problems": [{"kind": "asset-failed", "message": "m", "source": "a.js", "line": 0, "count": 1, "pane": 0}],
    });
    let state = json!({"sessionId": "s", "tabs": [tab], "active": null,
                       "history": [{"id": "h", "label": "l", "kind": "split", "versions": 1, "at": 5, "open": true}]});
    for value in [
        json!([state.clone()]),
        json!({"sessionId": "s", "state": state, "reveal": true, "tab": "t1", "heldSince": 9}),
    ] {
        let wire = json!({"key": "visualize", "value": value});
        let params: HostStateSetParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&params).unwrap(), wire);
    }
    assert!(serde_json::from_value::<HostStateSetParams>(json!({"key": "visualize", "value": {"state": {}}})).is_err());
    assert!(serde_json::from_value::<HostStateSetParams>(json!({"key": "other", "value": 1})).is_err());
}

/// Node's wire error carries `code` only when the error has one: a plain `Error` is
/// `{domain, detail}` with no `code` key, and it reads back as `None`.
#[test]
fn domain_error_without_a_code_has_no_code_key() {
    let plain = json!({"reason": "domainError", "domain": "workspace"});
    let data: ErrorData = serde_json::from_value(plain.clone()).unwrap();
    assert!(matches!(&data, ErrorData::DomainError { code: None, .. }));
    assert_eq!(serde_json::to_value(&data).unwrap(), plain);
    let coded = json!({"reason": "domainError", "domain": "git", "code": "WORKTREE_DIRTY"});
    assert_eq!(serde_json::to_value(serde_json::from_value::<ErrorData>(coded.clone()).unwrap()).unwrap(), coded);
}

/// Node's error carries `code`, `message` and `details` together: a coded error with a typed
/// detail keeps its message, and a plain `Error` is the message alone.
#[test]
fn domain_error_carries_code_message_and_detail_together() {
    let both = json!({"reason": "domainError", "domain": "worktree", "code": "WORKTREE_BUSY_JOBS",
                      "message": "Worktree has running jobs",
                      "detail": {"type": "worktreeBusyJobs", "reason": "workspace-retained"}});
    let data: ErrorData = serde_json::from_value(both.clone()).unwrap();
    let ErrorData::DomainError { message, detail, .. } = &data else { panic!("a domain error") };
    assert_eq!(message.as_deref(), Some("Worktree has running jobs"));
    assert!(detail.is_some());
    assert_eq!(serde_json::to_value(&data).unwrap(), both);
    let plain = json!({"reason": "domainError", "domain": "config", "message": "Updater is busy"});
    let data: ErrorData = serde_json::from_value(plain.clone()).unwrap();
    assert!(matches!(&data, ErrorData::DomainError { code: None, detail: None, .. }));
    assert_eq!(serde_json::to_value(&data).unwrap(), plain);
}

/// `core/drain`, `ui/openRequested` per kind and `ui/newTab/created`, as they travel.
#[test]
fn drain_open_requested_and_new_tab_on_the_wire() {
    use mixdog_app_protocol::ClientNotification;
    use mixdog_app_protocol::ServerNotification;
    let decode = |value: Value| serde_json::from_value::<ServerNotification>(value).unwrap();
    let drain = json!({"method": "core/drain", "params": {
        "drainId": "d1", "confirmToken": "tok",
        "running": [{"threadId": "t", "turnId": "u", "kind": "turn", "title": "Fix"},
                    {"threadId": null, "turnId": null, "kind": "backgroundShell", "title": "npm test"}]}});
    assert_eq!(serde_json::to_value(decode(drain.clone())).unwrap(), drain);
    for params in [
        json!({"kind": "browser", "sessionId": "s", "handoff": true, "tabId": "p1"}),
        json!({"kind": "terminal", "sessionId": "s", "terminalId": "x",
               "tabs": [{"id": "x", "tab": 1, "cwd": null}, {"id": "y", "tab": 2}], "requestId": "r"}),
        json!({"kind": "visualize", "sessionId": "s", "openUrl": "https://a.test/", "openRequestId": "o"}),
    ] {
        let wire = json!({"method": "ui/openRequested", "params": params});
        assert_eq!(serde_json::to_value(decode(wire.clone())).unwrap(), wire);
    }
    let created = ClientNotification::from_jsonrpc(
        serde_json::from_value(json!({"jsonrpc": "2.0", "method": "ui/newTab/created",
            "params": {"sessionId": "s", "openRequestId": "o", "pageId": "p3"}}))
        .unwrap(),
    );
    assert!(created.is_ok());
    let claimed = ClientNotification::from_jsonrpc(
        serde_json::from_value(json!({"jsonrpc": "2.0", "method": "ui/terminalRun/claimed",
            "params": {"requestId": "r"}}))
        .unwrap(),
    );
    assert!(claimed.is_ok());
}

/// Node's route values `effort`, `provider`, `model`, `turnEffort` and `effortOptions` (`runtime-facade.mjs:62,93`) ride
/// the route section: on the wire, and in the `ThreadRoute` definition of both schemas, not in `ModelSelection`.
#[test]
fn a_route_section_carries_the_efforts_and_the_selected_route() {
    use mixdog_app_protocol::ServerNotification;
    let route = json!({
        "sessionProvider": "anthropic-oauth", "sessionModel": "m", "fast": false, "fastCapable": false, "autoEffort": true,
        "modelParameters": {}, "effort": "high", "provider": "anthropic-oauth", "model": "m", "turnEffort": "low",
        "effortOptions": ["low", "high"],
        // Node's context-state.mjs sends `runtime.session?.forkedFrom || null`: the key is always present.
        "sessionForkedFrom": null
    });
    let wire = json!({"method": "thread/route/updated", "params": {"threadId": "t", "value": route}});
    let decoded = serde_json::from_value::<ServerNotification>(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), wire, "no route value is dropped on the wire");

    let keys = ["effort", "provider", "model", "turnEffort", "effortOptions"];
    for name in ["client_methods.json", "server_notification.json"] {
        let file = mixdog_app_protocol::export::generate().into_iter().find(|f| f.name == name).unwrap();
        let schema: Value = serde_json::from_str(&file.content).unwrap();
        let route = &schema["definitions"]["ThreadRoute"]["properties"];
        for key in keys {
            assert!(route.get(key).is_some(), "{name}: ThreadRoute lacks {key}");
        }
        assert!(
            schema["definitions"]["ModelSelection"]["properties"].get("effortOptions").is_none(),
            "{name}: effortOptions is a route value, not a model selection's"
        );
    }
    // The checked-in goldens say the same (a duplicate key is lost by a parse, so the text is counted).
    let golden = std::fs::read_to_string(golden_path(FileKind::Schema, "client_methods.json")).unwrap();
    assert_eq!(golden.matches("\"effortOptions\"").count(), 1, "effortOptions appears once in client_methods.json");
}
/// CCR settlements visible on the wire.
#[test]
fn ccr_shapes() {
    let unavailable = ErrorData::CapabilityUnavailable {
        capability: "host.browser".into(),
        detail: "absent".into(),
    };
    let value = serde_json::to_value(&unavailable).unwrap();
    assert_eq!(
        value,
        json!({"reason": "capabilityUnavailable", "capability": "host.browser", "detail": "absent"})
    );
    assert_eq!(
        serde_json::from_value::<ErrorData>(value).unwrap(),
        unavailable
    );
    let initialized = mixdog_app_protocol::ClientNotification::from_jsonrpc(
        mixdog_app_protocol::JsonRpcNotification {
            method: "initialized".into(),
            params: None,
            emitted_at_ms: None,
            feed: None,
            lone_surrogates: Vec::new(),
        },
    );
    assert_eq!(
        initialized.unwrap(),
        mixdog_app_protocol::ClientNotification::Initialized
    );
}
