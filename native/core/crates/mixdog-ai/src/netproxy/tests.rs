//! The network proxy against Node (`fixtures/network-proxy/record.mjs`): the
//! URL and exception parsing, normalisation, the strict patch, the routing
//! decision and the three `config/*` methods, result for result.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;
use url::Url;

use super::*;
use crate::service::network_proxy::NetworkProxyService;
use crate::service::network_proxy::NetworkProxyStore;

const GOLDEN: &str = include_str!("../../fixtures/network-proxy/golden.json");

struct MapEnv(HashMap<String, String>);

impl EnvLookup for MapEnv {
    fn get(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

fn env_of(spec: &Value) -> MapEnv {
    MapEnv(spec.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect())
}

fn golden() -> Value {
    serde_json::from_str(GOLDEN).unwrap()
}

/// `parseProxyUrl`'s `{ url }` or `{ error }`, from a Rust result.
fn parsed(result: Result<String, String>) -> Value {
    match result {
        Ok(url) => json!({ "url": url }),
        Err(error) => json!({ "error": error }),
    }
}

/// Node's `{ ok }` / `{ error }` of an attempt, from a Rust result.
fn same(result: Result<Value, String>, want: &Value, what: &str) {
    match result {
        Ok(value) => assert_eq!(Some(&value), want.get("ok"), "{what}"),
        Err(error) => assert_eq!(Some(&Value::String(error)), want.get("error"), "{what}"),
    }
}

#[test]
fn proxy_urls_parse_like_node() {
    let g = golden();
    for case in g["parse"].as_array().unwrap() {
        let credentials = case["credentials"].as_bool().unwrap();
        let got = parsed(setting::parse_proxy_url(&case["url"], &setting::PROXY_SCHEMES, credentials));
        assert_eq!(Some(&got), case.get("ok"), "{case}");
    }
    for case in g["parseNonString"].as_array().unwrap() {
        let value = match case["label"].as_str().unwrap() {
            "5" => json!(5),
            "[object Object]" => json!({}),
            _ => Value::Null,
        };
        let got = parsed(setting::parse_proxy_url(&value, &setting::PROXY_SCHEMES, false));
        assert_eq!(Some(&got), case.get("ok"), "{case}");
    }
}

#[test]
fn exception_lists_match_like_node() {
    let g = golden();
    let targets: Vec<Url> = g["targets"].as_array().unwrap().iter().map(|t| Url::parse(t.as_str().unwrap()).unwrap()).collect();
    for case in g["exceptions"].as_array().unwrap() {
        let text = match &case["text"] {
            Value::String(text) => text.clone(),
            repeat => repeat["repeat"].as_str().unwrap().repeat(repeat["times"].as_u64().unwrap() as usize),
        };
        let error = setting::exceptions_error(&Value::String(text.clone()));
        assert_eq!(error.map_or(Value::Null, Value::String), case["error"], "{}", case["text"]);
        assert_eq!(Value::String(setting::canonical_exceptions(&text)), case["canonical"], "{}", case["text"]);
        let covers: Vec<Value> = targets.iter().map(|url| json!(setting::exceptions_cover(&text, url))).collect();
        assert_eq!(Value::Array(covers), case["covers"], "{}", case["text"]);
    }
    for case in g["exceptionsNonString"].as_array().unwrap() {
        let value: Value = serde_json::from_str(case["label"].as_str().unwrap()).unwrap();
        let error = setting::exceptions_error(&value).map_or(Value::Null, Value::String);
        assert_eq!(error, case["error"]);
    }
}

#[test]
fn stored_values_normalize_and_patches_apply_like_node() {
    let g = golden();
    for case in g["normalize"].as_array().unwrap() {
        let got = Value::Object(setting::normalize_network_proxy(&case["stored"]).to_value());
        assert_eq!(got, case["result"], "{}", case["stored"]);
    }
    for case in g["patch"].as_array().unwrap() {
        let got = setting::apply_network_proxy_patch(&case["current"], &case["patch"]).map(|s| Value::Object(s.to_value()));
        same(got, case, &format!("{} {}", case["current"], case["patch"]));
    }
}

#[test]
fn local_hosts_are_the_ones_node_names() {
    for case in golden()["decideLocal"].as_array().unwrap() {
        assert_eq!(json!(is_local_host(case["host"].as_str().unwrap())), case["local"], "{}", case["host"]);
    }
}

#[tokio::test]
async fn routes_are_decided_like_node() {
    let g = golden();
    for case in g["decide"].as_array().unwrap() {
        let setting = setting::normalize_network_proxy(&case["setting"]);
        // The recorded settings are exact, not defaulted: a blank address stays blank.
        let setting = NetworkProxySetting {
            url: case["setting"]["url"].as_str().unwrap().to_owned(),
            exceptions: case["setting"]["exceptions"].as_str().unwrap().to_owned(),
            ..setting
        };
        let env = env_of(&case["env"]);
        let got = route::decide_proxy_route(case["target"].as_str().unwrap(), &setting, &env, None).await;
        let want = &case["ok"];
        match got {
            Ok(route) => {
                let mut value = json!({ "proxy": route.proxy, "via": route.via });
                if let Some(name) = route.env_var {
                    value["envVar"] = json!(name);
                }
                assert_eq!(&value, want, "{case}");
            }
            Err(error) => assert_eq!(Some(&json!(error.to_string())), case.get("error"), "{case}"),
        }
    }
}

struct Config(Mutex<Value>);

#[async_trait]
impl NetworkProxyStore for Config {
    fn network_proxy(&self) -> Value {
        self.0.lock().unwrap().get("networkProxy").cloned().unwrap_or(Value::Null)
    }

    fn providers(&self) -> Value {
        self.0.lock().unwrap().get("providers").cloned().unwrap_or(Value::Null)
    }

    async fn save_network_proxy(&self, value: Value) -> Result<(), String> {
        self.0.lock().unwrap()["networkProxy"] = value;
        Ok(())
    }
}

async fn serve(status: &'static str) -> String {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let _ = socket.write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes()).await;
            });
        }
    });
    format!("http://{address}")
}

async fn closed_origin() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    format!("http://{}", listener.local_addr().unwrap())
}

fn masked(value: &Value, live: &str, closed: &str) -> Value {
    let text = value.to_string().replace(live, "<live>").replace(closed, "<closed>");
    let mut out: Value = serde_json::from_str(&text).unwrap();
    // The platform name is the machine's.
    if let Some(route) = out.get_mut("route") {
        route["platform"] = Value::Null;
    }
    out
}

fn unplatformed(mut value: Value) -> Value {
    if let Some(route) = value.get_mut("route") {
        route["platform"] = Value::Null;
    }
    value
}

#[tokio::test]
async fn the_three_methods_answer_like_node() {
    let g = golden();
    let live = serve("204 No Content").await;
    let closed = closed_origin().await;
    let configs = [
        json!({ "providers": { "main": { "baseURL": live }, "down": { "baseURL": closed } } }),
        json!({ "networkProxy": { "mode": "off" }, "providers": { "main": { "baseURL": live } } }),
        json!({ "networkProxy": { "mode": "manual", "url": "http://127.0.0.1:9", "exceptions": "nothing.example" },
                "providers": { "far": { "baseURL": "http://example.invalid" }, "down": { "baseURL": closed } } }),
        json!({ "networkProxy": { "mode": "manual", "url": "" } }),
        json!({ "networkProxy": { "mode": "system" }, "providers": { "anthropic": {}, "openai-oauth": {}, "deepseek": {}, "grok": {} } }),
    ];
    let mut at = 0;
    let methods = g["methods"].as_array().unwrap();
    for (index, config) in configs.iter().enumerate() {
        let store = Arc::new(Config(Mutex::new(config.clone())));
        let policy = NetworkProxy::new(Arc::new(MapEnv(HashMap::new())), SystemProxy::default());
        policy.adopt(&store.network_proxy());
        let clients = Arc::new(RoutedClients::new(policy.clone(), |proxy| {
            let builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
            match proxy {
                Some(uri) => builder.proxy(reqwest::Proxy::all(uri)?),
                None => builder.no_proxy(),
            }
            .build()
        }));
        let service = NetworkProxyService::new(store.clone(), policy, clients);
        let providers = ["main", "down", "far", "anthropic", "openai-oauth", "deepseek", "grok", "unknown"];
        for provider in providers.iter().map(|p| Some(*p)).chain([None]) {
            let options = provider.map_or(json!({}), |p| json!({ "provider": p }));
            let want = &methods[at];
            at += 1;
            assert_eq!((want["config"].as_u64(), want["method"].as_str()), (Some(index as u64), Some("getNetworkProxy")));
            let got = service.get_network_proxy(&options).await.unwrap();
            assert_eq!(masked(&got, &live, &closed), unplatformed(want["result"].clone()), "get {index} {provider:?}");
            if config.pointer(&format!("/providers/{}/baseURL", provider.unwrap_or("-"))).is_some() {
                let want = &methods[at];
                at += 1;
                let mut got = service.test_network_proxy(&options).await.unwrap();
                got.as_object_mut().unwrap().remove("ms");
                assert_eq!(masked(&got, &live, &closed), unplatformed(want["result"].clone()), "test {index} {provider:?}");
            }
        }
        for patch in [json!({ "mode": "manual", "url": "http://p:1" }), json!({ "mode": "off" }), json!({}), json!({ "mode": "x" }), json!({ "url": "nope" })] {
            let want = &methods[at];
            at += 1;
            assert_eq!(&want["patch"], &patch);
            match service.set_network_proxy(&patch, &json!({ "provider": "main" })).await {
                Ok(got) => {
                    assert_eq!(masked(&got, &live, &closed), unplatformed(want["result"].clone()), "set {index} {patch}");
                    assert_eq!(masked(&store.network_proxy(), &live, &closed), want["stored"], "stored {index} {patch}");
                }
                Err(error) => assert_eq!(Some(&json!(error.to_string())), want.get("error"), "set {index} {patch}"),
            }
        }
    }
    assert_eq!(at, methods.len());
}

#[test]
fn a_change_of_the_setting_announces_one_new_epoch() {
    let policy = NetworkProxy::new(Arc::new(MapEnv(HashMap::new())), SystemProxy::default());
    assert_eq!(policy.current().unwrap_err().message, UNREADABLE_MESSAGE);
    let heard = Arc::new(Mutex::new(Vec::new()));
    let seen = heard.clone();
    let _subscription = policy.on_change(Arc::new(move |epoch| seen.lock().unwrap().push(epoch)));
    policy.adopt(&json!({ "mode": "off" }));
    policy.adopt(&json!({ "mode": "off" }));
    policy.adopt(&json!({ "mode": "system" }));
    assert_eq!(*heard.lock().unwrap(), vec![1, 2]);
    assert_eq!(policy.epoch(), 2);
}

/// A proxy that answers like the one recorded under `name`: a fixed reply to the
/// first bytes read (`None` drops the connection); SOCKS5 answers the method
/// choice, then the request.
async fn refusing_proxy(name: &str) -> String {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let (socks, first, second): (bool, Option<Vec<u8>>, Option<Vec<u8>>) = match name {
        "CONNECT 403" => (false, Some(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n".to_vec()), None),
        "CONNECT 407" | "forward 407" => {
            (false, Some(b"HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n".to_vec()), None)
        }
        "CONNECT dropped" => (false, None, None),
        "forward 403" => (false, Some(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n".to_vec()), None),
        "socks5 general failure" => (true, Some(vec![5, 0]), Some(vec![5, 1, 0, 1, 0, 0, 0, 0, 0, 0])),
        "socks5 refused" => (true, Some(vec![5, 0]), Some(vec![5, 5, 0, 1, 0, 0, 0, 0, 0, 0])),
        "socks5 no method" => (true, Some(vec![5, 0xff]), None),
        other => panic!("unknown proxy {other}"),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let (first, second) = (first.clone(), second.clone());
            tokio::spawn(async move {
                let mut buffer = [0u8; 1024];
                if socket.read(&mut buffer).await.unwrap_or(0) == 0 {
                    return;
                }
                let Some(first) = first else { return };
                let _ = socket.write_all(&first).await;
                if socks && let Some(second) = second {
                    if socket.read(&mut buffer).await.unwrap_or(0) > 0 {
                        let _ = socket.write_all(&second).await;
                    }
                }
                let _ = socket.shutdown().await;
            });
        }
    });
    format!("{}://127.0.0.1:{port}", if socks { "socks5" } else { "http" })
}

#[tokio::test]
async fn refused_tunnels_report_the_codes_node_reports() {
    for case in golden()["failures"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let proxy = refusing_proxy(name).await;
        let origin = case["origin"].as_str().unwrap();
        let config = json!({
            "networkProxy": { "mode": "manual", "url": proxy, "exceptions": "nothing.example" },
            "providers": { "x": { "baseURL": origin } },
        });
        let store = Arc::new(Config(Mutex::new(config)));
        let policy = NetworkProxy::new(Arc::new(MapEnv(HashMap::new())), SystemProxy::default());
        policy.adopt(&store.network_proxy());
        let clients = Arc::new(RoutedClients::new(policy.clone(), |proxy| {
            let builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
            match proxy {
                Some(uri) => builder.proxy(reqwest::Proxy::all(uri)?),
                None => builder.no_proxy(),
            }
            .build()
        }));
        let service = NetworkProxyService::new(store, policy, clients);
        let mut got = service.test_network_proxy(&json!({ "provider": "x" })).await.unwrap();
        got.as_object_mut().unwrap().remove("ms");
        let port = proxy.rsplit(':').next().unwrap();
        let text = got.to_string().replace(port, "<port>");
        let got: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(unplatformed(got), unplatformed(case["result"].clone()), "{name}");
    }
}

#[test]
fn certificate_verdicts_have_node_codes() {
    use rustls::CertificateError as C;
    let failure = |error: C| tunnel::TlsFailure {
        error: std::io::Error::new(std::io::ErrorKind::InvalidData, rustls::Error::InvalidCertificate(error)),
    };
    assert_eq!(tunnel::tls_code(&failure(C::Expired)), "CERT_HAS_EXPIRED");
    assert_eq!(tunnel::tls_code(&failure(C::NotValidYet)), "CERT_NOT_YET_VALID");
    assert_eq!(tunnel::tls_code(&failure(C::Revoked)), "CERT_REVOKED");
    assert_eq!(tunnel::tls_code(&failure(C::NotValidForName)), "ERR_TLS_CERT_ALTNAME_INVALID");
    assert_eq!(tunnel::tls_code(&failure(C::UnknownIssuer)), "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    assert_eq!(tunnel::tls_code(&failure(C::BadSignature)), "UNKNOWN");
}
