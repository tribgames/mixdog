//! The rule of decisions.md "Lone UTF-16 surrogates in client strings", field by field from the inventory
//! (mixdog-app-protocol tests/it/free_text_fields.json, each field's class stated independently of `FREE_TEXT`): a lone
//! surrogate in a `free` field reaches its service as U+FFFD, whole as with a real U+FFFD there; in a `refused` field the
//! frame is refused naming the field (a request), dropped (a notification) or fails its request (an answer), before
//! anything acts on it.

use mixdog_app_protocol::CLIENT_METHODS;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;

use super::Rig;
use super::reason;
use super::sample::Samples;

/// The text a field gets, written as a lone surrogate escape in the frame ([`lone`]).
pub(crate) const MARK: &str = "lone-surrogate-mark";
/// What the core reads the escape as.
pub(crate) const READ: &str = "a\u{fffd}";
/// A map's value where the lone unit is in its key.
const KEYED: &str = "lone-surrogate-keyed";

/// One field of the inventory: its method, its pattern, and whether it is free text.
pub(crate) struct Field {
    pub(crate) free: bool,
    pub(crate) method: String,
    pub(crate) pattern: String,
}

/// Every field of `kind` (`request`, `notification`, `answer`) the inventory classes, in its order.
pub(crate) fn inventory(kind: &str) -> Vec<Field> {
    let text = mixdog_testkit::fixture!("../mixdog-app-protocol/tests/it/free_text_fields.json");
    let inventory: Value = serde_json::from_str(text).expect("the inventory parses");
    let mut fields = Vec::new();
    for class in inventory["classes"].as_array().expect("its classes") {
        let free = class["class"] == "free";
        for field in class["fields"].as_array().expect("a class's fields") {
            let mut parts = field.as_str().expect("a field").splitn(3, ' ');
            let (of, method, pattern) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            if of == kind {
                fields.push(Field { free, method: method.to_owned(), pattern: pattern.to_owned() });
            }
        }
    }
    fields
}

/// The payload `put` builds with `text` at `pattern`; for a last `{}`, `text` is a key of the map there.
pub(crate) fn placed(pattern: &str, text: &str, put: impl Fn(&str, &str) -> Value) -> Value {
    match pattern.strip_suffix("/{}") {
        Some(map) => put(&format!("{map}/{text}"), KEYED),
        None => put(pattern, text),
    }
}

/// The pointer of the string or key `text` in `value`, as the core names it (the escape read as U+FFFD).
pub(crate) fn pointer_of(value: &Value, text: &str) -> String {
    fn find(value: &Value, text: &str) -> Option<String> {
        match value {
            Value::String(held) if held == text => Some(String::new()),
            Value::Array(items) => items.iter().enumerate().find_map(|(index, item)| find(item, text).map(|rest| format!("/{index}{rest}"))),
            Value::Object(map) => map.iter().find_map(|(key, item)| {
                let at = format!("/{}", key.replace('~', "~0").replace('/', "~1"));
                if key == text { Some(at) } else { find(item, text).map(|rest| format!("{at}{rest}")) }
            }),
            _ => None,
        }
    }
    find(value, text).expect("the field was placed").replace(MARK, READ)
}

/// `message` as a client's text, [`MARK`] written as the escape of a lone high surrogate.
pub(crate) fn lone(message: &Value) -> String {
    message.to_string().replace(&format!("\"{MARK}\""), r#""a\ud800""#)
}

/// Every request field: free text reaches the core as U+FFFD (the mock core echoes the params, compared whole); a refused one is
/// `invalidParams` naming the field, and nothing reached the core (its echo is no answer). That a refused field leaves the real
/// core's files and the servers it talks to untouched is the `inventorySweep` of the lone-surrogate-wire replay
/// (benchmarks/rust-core/recorders/lib/lone-surrogate-wire-replay.mjs): every refused request and notification field of this
/// inventory, sent to a built mixdogd, with the bytes of every file of its folders and the stand-in servers' requests compared
/// before and after.
#[tokio::test(start_paused = true)]
async fn every_request_field_of_the_inventory_reaches_the_core_or_is_refused_as_classed() {
    let rig = Rig::new();
    rig.core.mock.directory().insert(ThreadId::from("x"));
    let samples = Samples::new();
    let origins = [Origin::Local, Origin::Ssh, Origin::Relay];
    let clients: Vec<super::Client> = origins
        .iter()
        .enumerate()
        .map(|(n, origin)| {
            let client = rig.connect(n as u64 + 1, *origin);
            client.initialize(super::VERSION, json!({}));
            client.drain();
            client
        })
        .collect();
    let mut failures = Vec::new();
    let (mut id, mut free, mut refused) = (0_i64, 0, 0);
    for field in inventory("request") {
        id += 1;
        let spec = CLIENT_METHODS.iter().find(|spec| spec.method == field.method).expect("a classed method is in the table");
        let client = &clients[origins.iter().position(|origin| spec.allows(*origin)).expect("an origin may call it")];
        let with = |text: &str| placed(&field.pattern, text, |pattern, text| samples.with_text(&field.method, pattern, text));
        let params = with(MARK);
        client.send_text(&lone(&json!({ "id": id, "method": field.method, "params": params })));
        let answer = client.response(id).await;
        if field.free {
            free += 1;
            if answer.get("result") != Some(&json!({ "method": field.method, "params": with(READ) })) {
                failures.push(format!("free {} {}: {answer}", field.method, field.pattern));
            }
        } else {
            refused += 1;
            let path = format!("{}.params{}", field.method, pointer_of(&params, MARK));
            if answer.get("result").is_some() || reason(&answer) != "invalidParams" || answer["error"]["data"]["path"] != json!(path) {
                failures.push(format!("refused {} {}: {answer}", field.method, field.pattern));
            }
        }
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
    assert!(free > 100 && refused > 100, "{free} free and {refused} refused fields");
}

/// Every notification field: free text reaches its service as U+FFFD, whole; a refused one never reaches it.
#[tokio::test]
async fn every_notification_field_of_the_inventory_reaches_its_service_or_is_dropped_as_classed() {
    let fields = inventory("notification");
    let mut methods: Vec<&'static str> = fields.iter().map(|field| &*Box::leak(field.method.clone().into_boxed_str())).collect();
    methods.sort_unstable();
    methods.dedup();
    let rig = Rig::routed(Box::leak(methods.into_boxed_slice()), Vec::new());
    let client = rig.ready(1, json!({}));
    let samples = Samples::new();
    let payload = |field: &Field, text: &str| placed(&field.pattern, text, |pattern, text| samples.untyped_with_text(pattern, text));
    for field in &fields {
        client.send_text(&lone(&json!({ "method": field.method, "params": payload(field, MARK) })));
    }
    let recorded: Vec<(String, Value)> =
        rig.core.mock.mock_domain().notifications().into_iter().map(|(method, params, _)| (method.as_str().to_owned(), params)).collect();
    let expected: Vec<(String, Value)> = fields.iter().filter(|field| field.free).map(|field| (field.method.clone(), payload(field, READ))).collect();
    assert!(fields.iter().any(|field| !field.free) && !expected.is_empty());
    assert_eq!(recorded, expected);
}

/// Every field of an answer to a `host/*` request or a model proxy call: free text answers the request with U+FFFD there, whole;
/// a refused one fails the request instead.
#[tokio::test(start_paused = true)]
async fn every_host_answer_field_of_the_inventory_answers_or_fails_as_classed() {
    let rig = Rig::new();
    let host = rig.ready(1, json!({ "host": { "browser": true, "visualize": true, "systemProxy": true, "updater": true, "files": true, "computer": true, "browserEngine": { "version": 1 } }, "modelProxy": true }));
    host.request(1, "host/claim", json!({ "hostId": "pc" }));
    assert_eq!(host.response(1).await["result"], json!({}));
    let samples = Samples::new();
    let payload = |field: &Field, text: &str| placed(&field.pattern, text, |pattern, text| samples.untyped_with_text(pattern, text));
    let mut answered = 0;
    for field in inventory("answer").into_iter().filter(|field| !field.method.starts_with("item/")) {
        let capability = match field.method.as_str() {
            "model/proxy/execute" => HostCapability::ModelProxy,
            "host/systemProxy/resolve" => HostCapability::SystemProxy,
            "host/visualize/command" => HostCapability::Visualize,
            "host/update/command" => HostCapability::Updater,
            "host/capture/fileSnapshot" | "host/localPage/url" => HostCapability::Files,
            "host/screen/displays" => HostCapability::Browser,
            "host/computer/capture" | "host/computer/displays" | "host/computer/foregroundLease" | "host/computer/internalWindows" | "host/computer/pixels"
            | "host/computer/appWindows" | "host/computer/appInput" | "host/computer/cursorPrepare" | "host/computer/permissions" | "host/computer/command" => {
                HostCapability::Computer
            }
            other if other.starts_with("host/browser/") && other != "host/browser/command" => HostCapability::BrowserEngine,
            other => panic!("an answer of {other}: no capability serves it"),
        };
        let method = Method(Box::leak(field.method.clone().into_boxed_str()));
        let outgoing = rig.outgoing.clone();
        let call = tokio::spawn(async move { outgoing.request(capability, method, json!({})).await });
        let request = host.frames(1).await.remove(0).body;
        host.send_text(&lone(&json!({ "id": request["id"], "result": payload(&field, MARK) })));
        let expected = if field.free {
            Ok(payload(&field, READ))
        } else {
            Err(HostError::Rpc { code: -32602, message: "The answer contains unpaired Unicode surrogates.".into(), data: None })
        };
        assert_eq!(call.await.unwrap(), expected, "{} {} ({})", field.method, field.pattern, if field.free { "free" } else { "refused" });
        answered += 1;
    }
    assert!(answered > 50, "only {answered} fields");
}
