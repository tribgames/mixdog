//! Contract gates: protocol.md §14.1 (schema/TS golden + table-driven method
//! rows), §14.2 (envelope), DS-ALL-1 and DS-DUP-1 (DS §14, §16).

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

/// DS-ALL-1: each of the 166 operations, 61 service methods, 190 phone
/// methods and 303 session actions is mapped exactly once, to a target that
/// exists in the generated tables.
#[test]
fn ds_all_1_every_inventory_name_is_mapped_once() {
    let fixture: Value = serde_json::from_str(
        &std::fs::read_to_string(crate_dir().join("tests/fixtures/parity-inventory.json")).unwrap(),
    )
    .unwrap();
    let lists = [
        (InventoryList::Operations, "operations", 166),
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
        },
    );
    assert_eq!(
        initialized.unwrap(),
        mixdog_app_protocol::ClientNotification::Initialized
    );
}
