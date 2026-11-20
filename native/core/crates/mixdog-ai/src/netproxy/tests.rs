//! The network proxy against Node (`benchmarks/rust-core/recorders/record-network-proxy.mjs`): the
//! URL and exception parsing, normalisation, the strict patch, the routing
//! decision and the three `config/*` methods, result for result.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;

use super::*;
use crate::service::network_proxy::NetworkProxyService;
use crate::service::network_proxy::NetworkProxyStore;

struct MapEnv(HashMap<String, String>);

impl EnvLookup for MapEnv {
    fn get(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
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

#[test]
fn certificate_verdicts_have_node_codes() {
    use rustls::CertificateError as C;
    let failure = |error: C| tunnel::TlsFailure { error: std::io::Error::new(std::io::ErrorKind::InvalidData, rustls::Error::InvalidCertificate(error)) };
    assert_eq!(tunnel::tls_code(&failure(C::Expired)), "CERT_HAS_EXPIRED");
    assert_eq!(tunnel::tls_code(&failure(C::NotValidYet)), "CERT_NOT_YET_VALID");
    assert_eq!(tunnel::tls_code(&failure(C::Revoked)), "CERT_REVOKED");
    assert_eq!(tunnel::tls_code(&failure(C::NotValidForName)), "ERR_TLS_CERT_ALTNAME_INVALID");
    assert_eq!(tunnel::tls_code(&failure(C::UnknownIssuer)), "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    assert_eq!(tunnel::tls_code(&failure(C::BadSignature)), "UNKNOWN");
}

/// The answer of `config/testNetworkProxy` for a provider at `origin`, through
/// the manual proxy `proxy`.
async fn test_through(proxy: &str, origin: &str) -> Value {
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
    NetworkProxyService::new(store, policy, clients).test_network_proxy(&json!({ "provider": "x" })).await.unwrap()
}

/// Accepts one connection and speaks SOCKS5 on it: sends the destination it was
/// asked for to `asked`, then relays to `onward` when given, else fails the request.
async fn socks_once(onward: Option<String>) -> (String, tokio::sync::oneshot::Receiver<(u8, String)>) {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (asked, received) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        drop(listener);
        let mut buffer = [0u8; 300];
        // The greeting: version 5, a method count, then that many methods.
        let greeting = socket.read(&mut buffer).await.unwrap();
        assert!(greeting >= 3 && buffer[0] == 5 && greeting == 2 + buffer[1] as usize, "not a SOCKS5 greeting: {:?}", &buffer[..greeting]);
        socket.write_all(&[5, 0]).await.unwrap();
        let n = socket.read(&mut buffer).await.unwrap();
        let (kind, host) = match buffer[3] {
            3 => (3, String::from_utf8_lossy(&buffer[5..5 + buffer[4] as usize]).into_owned()),
            kind => (kind, String::from_utf8_lossy(&buffer[4..n]).into_owned()),
        };
        let _ = asked.send((kind, host));
        match onward {
            None => {
                let _ = socket.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            Some(address) => {
                let mut upstream = tokio::net::TcpStream::connect(address).await.unwrap();
                socket.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
            }
        }
    });
    (format!("socks5://127.0.0.1:{port}"), received)
}

#[tokio::test]
async fn a_socks_proxy_is_given_the_hostname() {
    let (proxy, asked) = socks_once(None).await;
    let got = test_through(&proxy, "http://origin.invalid:8080").await;
    // ATYP 3 is a domain name; resolving here first would send an address, or fail before the proxy.
    assert_eq!(asked.await.unwrap(), (3, "origin.invalid".to_owned()));
    assert_eq!((got["ok"].as_bool(), got["code"].as_str()), (Some(false), Some("UND_ERR_SOCKS5_REPLY_1")), "{got}");
}

#[tokio::test]
async fn a_routed_client_gives_the_socks_proxy_the_hostname() {
    let (proxy, asked) = socks_once(None).await;
    let policy = NetworkProxy::new(Arc::new(MapEnv(HashMap::new())), SystemProxy::default());
    policy.adopt(&json!({ "mode": "manual", "url": proxy, "exceptions": "nothing.example" }));
    let clients = RoutedClients::new(policy, |proxy| {
        let builder = reqwest::Client::builder();
        match proxy {
            Some(uri) => builder.proxy(reqwest::Proxy::all(uri)?),
            None => builder.no_proxy(),
        }
        .build()
    });
    let client = clients.client_for("http://origin.invalid:8080").await.unwrap();
    let _ = client.head("http://origin.invalid:8080").send().await;
    assert_eq!(asked.await.unwrap(), (3, "origin.invalid".to_owned()));
}

#[tokio::test]
async fn a_refused_tunnel_on_the_one_connection_reports_the_refusal() {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = accepted.clone();
    // The proxy allows one connection: it stops listening once it has accepted it.
    let served = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        drop(listener);
        let mut buffer = [0u8; 1024];
        let _ = socket.read(&mut buffer).await;
        let _ = socket.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n").await;
        let _ = socket.shutdown().await;
    });
    let got = test_through(&proxy, "https://origin.invalid").await;
    served.await.unwrap();
    assert_eq!((got["ok"].as_bool(), got["code"].as_str()), (Some(false), Some("UND_ERR_ABORTED")), "{got}");
    assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_check_uses_the_one_connection_a_proxy_allows() {
    let origin = serve("204 No Content").await;
    let (proxy, asked) = socks_once(Some(origin.trim_start_matches("http://").to_owned())).await;
    let port = origin.rsplit(':').next().unwrap();
    let got = test_through(&proxy, &format!("http://origin.invalid:{port}")).await;
    assert_eq!((got["ok"].as_bool(), got["status"].as_u64()), (Some(true), Some(204)), "{got}");
    assert_eq!(asked.await.unwrap().1, "origin.invalid");
}

#[tokio::test(start_paused = true)]
async fn a_tunnel_that_goes_silent_times_out_at_ten_seconds() {
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = [0u8; 1024];
        let _ = socket.read(&mut buffer).await;
        let _ = socket.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
        std::future::pending::<()>().await;
    });
    let got = test_through(&proxy, "https://origin.invalid").await;
    assert_eq!((got["ok"].as_bool(), got["code"].as_str()), (Some(false), Some("ETIMEDOUT")), "{got}");
    assert!(got["ms"].as_u64().unwrap() >= 10_000, "{got}");
}
