//! The connection half of the webhook relay tunnel (`webhook/relay-tunnel.mjs`
//! `startHookTunnel`): the install's hook identity, the relay URL policy, and one leg to the
//! relay's `/hookleg` that replays each request frame against the local listener. The leg itself
//! (dial, heartbeat, redial) is `mixdog_remote::leg::run_leg`.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use mixdog_js::js_trim;
use mixdog_remote::identity::device::{DeviceFiles, DeviceIdentity};
use mixdog_remote::leg::socket::relay_client_url;
use mixdog_remote::leg::{LegConfig, LegEvent, Outgoing, run_leg, validated_relay_url};
use mixdog_rt::{DurabilityIo, LaneToken};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::lifecycle::{HookTunnel, LocalPort, TunnelStarter};
use super::tunnel::{MAX_HOOK_FRAME_BYTES, answer};

/// Packaged default mirrors the desktop pairing relay.
const DEFAULT_RELAY_URL: &str = "wss://192-255-139-161.sslip.io";
const IDENTITY_FILE: &str = "relay-hook-device.json";

/// `resolveHookRelayUrl`: `None` when the tunnel is switched off (`0`, `false`, `off`), else the
/// validated URL; the error is Node's `TypeError` message.
pub fn resolve_relay_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let raw = js_trim(raw.unwrap_or(""));
    if matches!(raw.to_lowercase().as_str(), "0" | "false" | "off") {
        return Ok(None);
    }
    let raw = if raw.is_empty() { DEFAULT_RELAY_URL } else { raw };
    validated_relay_url(raw).map(|url| Some(url.to_string())).map_err(|e| e.hook_text().to_owned())
}

/// `hookPublicBase`: `https://<relay>/hook/<deviceId>` (`http` for a `ws` relay).
pub fn hook_public_base(relay_url: &str, device_id: &str) -> Result<String, String> {
    let client = relay_client_url(relay_url, device_id).map_err(|e| e.hook_text().to_owned())?;
    let base = client.strip_suffix(&format!("/d/{device_id}/")).unwrap_or(&client);
    Ok(format!("{base}/hook/{device_id}"))
}

pub struct RelayTunnelStarter {
    lane: DurabilityIo,
    data_dir: PathBuf,
    /// `MIXDOG_RELAY_URL`, read by the composition root.
    relay_url_env: Option<String>,
}

impl RelayTunnelStarter {
    pub fn new(lane: DurabilityIo, data_dir: PathBuf, relay_url_env: Option<String>) -> Self {
        Self { lane, data_dir, relay_url_env }
    }

    /// The install's stable hook identity; a damaged file is kept aside and replaced. A file that
    /// can be neither read nor written is logged and the tunnel runs on a fresh in-memory
    /// identity, as Node's `startHookTunnel` does.
    async fn identity(&self) -> DeviceIdentity {
        let files = DeviceFiles::at(self.data_dir.clone(), IDENTITY_FILE);
        let loaded = async {
            let job = self
                .lane
                .submit_wait(&CancellationToken::new(), move |lane| files.load_or_create(lane))
                .await
                .map_err(|e| e.to_string())?;
            job.await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
        };
        loaded.await.unwrap_or_else(|error| {
            tracing::warn!("hook relay identity unavailable, using an in-memory one: {error}");
            DeviceIdentity::mint()
        })
    }
}

struct RelayTunnel {
    public_base: String,
    cancel: CancellationToken,
}

impl HookTunnel for RelayTunnel {
    fn public_base(&self) -> String {
        self.public_base.clone()
    }

    fn close(&mut self) {
        self.cancel.cancel();
    }
}

#[async_trait]
impl TunnelStarter for RelayTunnelStarter {
    async fn start(&self, local_port: LocalPort) -> Result<Option<Box<dyn HookTunnel>>, String> {
        let Some(relay_url) = resolve_relay_url(self.relay_url_env.as_deref())? else { return Ok(None) };
        let identity = self.identity().await;
        let public_base = hook_public_base(&relay_url, &identity.device_id)?;
        let cancel = CancellationToken::new();
        let (events_tx, events) = mpsc::channel(64);
        let (outgoing_tx, outgoing) = mpsc::channel(64);
        tokio::spawn(run_leg(LegConfig::hook(relay_url, identity, MAX_HOOK_FRAME_BYTES), events_tx, outgoing, cancel.clone()));
        tokio::spawn(pump(events, outgoing_tx, local_port, public_base.clone()));
        Ok(Some(Box::new(RelayTunnel { public_base, cancel })))
    }
}

/// Answers each frame on its own task. A reply belongs to the leg the frame came in on: when
/// that leg has been replaced the reply is dropped, as Node drops a reply whose socket closed.
async fn pump(mut events: mpsc::Receiver<LegEvent>, outgoing: mpsc::Sender<Outgoing>, port: LocalPort, public_base: String) {
    let leg = Arc::new(AtomicU64::new(0));
    let mut announced = false;
    while let Some(event) = events.recv().await {
        match event {
            LegEvent::Open => {
                leg.fetch_add(1, Ordering::SeqCst);
                if !announced {
                    announced = true;
                    tracing::info!("webhook: hook tunnel up: {public_base}");
                }
            }
            LegEvent::Lost { .. } => {
                leg.fetch_add(1, Ordering::SeqCst);
            }
            LegEvent::Raw(text) => {
                let (leg, port, outgoing) = (Arc::clone(&leg), port.clone(), outgoing.clone());
                let seen = leg.load(Ordering::SeqCst);
                tokio::spawn(async move {
                    if let Some(reply) = answer(&text, port.get()).await
                        && leg.load(Ordering::SeqCst) == seen
                    {
                        let _ = outgoing.send(Outgoing::Text(reply)).await;
                    }
                });
            }
            LegEvent::Inbound(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;
    use std::time::Duration;

    use base64::Engine;
    use futures::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::WebSocketStream;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    use super::*;

    const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

    struct Leg {
        socket: WebSocketStream<TcpStream>,
        authorization: String,
        path: String,
    }

    /// The relay: accepts legs and hands each to the test.
    struct Relay {
        url: String,
        legs: mpsc::UnboundedReceiver<Leg>,
    }

    impl Relay {
        async fn start() -> Self {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());
            let (tx, legs) = mpsc::unbounded_channel();
            tokio::spawn(async move {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let tx = tx.clone();
                    tokio::spawn(async move {
                        let seen = Arc::new(std::sync::Mutex::new((String::new(), String::new())));
                        let capture = Arc::clone(&seen);
                        let socket = tokio_tungstenite::accept_hdr_async(stream, move |request: &Request, response: Response| {
                            let authorization = request.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
                            *capture.lock().unwrap() = (authorization, request.uri().path().to_owned());
                            Ok(response)
                        })
                        .await
                        .unwrap();
                        let (authorization, path) = seen.lock().unwrap().clone();
                        let _ = tx.send(Leg { socket, authorization, path });
                    });
                }
            });
            Self { url, legs }
        }

        async fn next_leg(&mut self) -> Leg {
            tokio::time::timeout(Duration::from_secs(10), self.legs.recv()).await.expect("a leg is dialed").unwrap()
        }
    }

    impl Leg {
        async fn round_trip(&mut self, frame: Value) -> Value {
            self.socket.send(Message::Text(frame.to_string().into())).await.unwrap();
            loop {
                match tokio::time::timeout(Duration::from_secs(10), self.socket.next()).await.expect("a reply").unwrap().unwrap() {
                    Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
                    _ => continue,
                }
            }
        }
    }

    fn http_frame(id: &str, body: &str) -> Value {
        json!({"type": "http", "id": id, "method": "POST", "path": "/webhook/demo",
               "headers": {"content-type": "application/json", "x-demo": "yes"}, "body": B64.encode(body)})
    }

    fn starter(dir: &std::path::Path, url: &str) -> RelayTunnelStarter {
        RelayTunnelStarter::new(mixdog_rt::testing::tokens().durability_io, dir.to_path_buf(), Some(url.to_owned()))
    }

    fn stored_identity(dir: &std::path::Path) -> Value {
        serde_json::from_slice(&std::fs::read(dir.join(IDENTITY_FILE)).unwrap()).unwrap()
    }

    /// Node `relay-tunnel.test.mjs`: the relay needs encrypted transport.
    #[test]
    fn the_relay_url_requires_encrypted_transport() {
        assert_eq!(resolve_relay_url(Some("off")), Ok(None));
        assert_eq!(resolve_relay_url(Some(" FALSE ")), Ok(None));
        assert_eq!(resolve_relay_url(Some("ws://127.0.0.1:9800")), Ok(Some("ws://127.0.0.1:9800/".into())));
        assert!(resolve_relay_url(Some("ws://relay.example")).unwrap_err().contains("must use wss"));
        assert!(resolve_relay_url(Some("wss://token@relay.example")).unwrap_err().contains("must not contain credentials"));
        assert_eq!(resolve_relay_url(Some("not a url")), Err("MIXDOG_RELAY_URL is invalid".into()));
        assert_eq!(resolve_relay_url(None), Ok(Some("wss://192-255-139-161.sslip.io/".into())));
        assert_eq!(hook_public_base("wss://relay.example/", "dev-1").unwrap(), "https://relay.example/hook/dev-1");
        assert_eq!(hook_public_base("ws://127.0.0.1:9800/x?y#z", "dev-1").unwrap(), "http://127.0.0.1:9800/hook/dev-1");
    }

    /// Node `relay-tunnel-connect.test.mjs`: a relay URL that fails the dial check is an error
    /// result, never a panic, and no leg is started.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_relay_url_that_fails_the_dial_check_is_an_error_not_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let result = starter(dir.path(), "http://relay.invalid").start(LocalPort::with(0)).await;
        assert!(result.err().unwrap().contains("must use wss"));
        let off = starter(dir.path(), "off").start(LocalPort::with(0)).await;
        assert!(off.unwrap().is_none());
    }

    /// Node `relay-tunnel.identity.test.mjs`: a NUL-filled identity is kept aside and a fresh one
    /// is persisted, then stays stable.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_nul_filled_identity_is_kept_aside_and_a_fresh_one_persisted() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(IDENTITY_FILE), vec![0u8; 80]).unwrap();
        let relay = Relay::start().await;
        let mut first = starter(dir.path(), &relay.url).start(LocalPort::with(0)).await.unwrap().unwrap();
        first.close();
        let id = stored_identity(dir.path())["deviceId"].as_str().unwrap().to_owned();
        assert!(first.public_base().ends_with(&format!("/hook/{id}")));
        let kept = std::fs::read_dir(dir.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("relay-hook-device.json.corrupt-"));
        assert!(kept, "the damaged file is kept aside");
        let mut again = starter(dir.path(), &relay.url).start(LocalPort::with(0)).await.unwrap().unwrap();
        again.close();
        assert_eq!(again.public_base(), first.public_base(), "the repaired identity is stable");
    }

    /// Node logs an identity it can neither read nor write and runs on an in-memory one.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unreadable_identity_file_leaves_the_tunnel_running_on_a_fresh_identity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(IDENTITY_FILE)).unwrap();
        let relay = Relay::start().await;
        let mut tunnel = starter(dir.path(), &relay.url).start(LocalPort::with(0)).await.unwrap().unwrap();
        assert!(tunnel.public_base().contains("/hook/"));
        assert!(dir.path().join(IDENTITY_FILE).is_dir(), "nothing was written over the unreadable path");
        tunnel.close();
    }

    /// Node `relay-tunnel.tunnel.test.mjs`: the leg authenticates with the persisted identity on
    /// `/hookleg`, and frames are replayed against the local server.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_tunnel_authenticates_with_the_persisted_identity_and_replays_frames() {
        let dir = tempfile::tempdir().unwrap();
        let mut relay = Relay::start().await;
        let local = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let local_port = local.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let (mut socket, _) = local.accept().await.unwrap();
            let mut got = Vec::new();
            let mut chunk = [0u8; 4096];
            while !got.ends_with(b"0\r\n\r\n") {
                let n = socket.read(&mut chunk).await.unwrap();
                got.extend_from_slice(&chunk[..n]);
            }
            socket.write_all(b"HTTP/1.1 201 Created\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nConnection: close\r\n\r\nstored").await.unwrap();
            String::from_utf8(got).unwrap()
        });
        let mut tunnel = starter(dir.path(), &relay.url).start(LocalPort::with(local_port)).await.unwrap().unwrap();
        let identity = stored_identity(dir.path());
        let id = identity["deviceId"].as_str().unwrap();
        assert_eq!(tunnel.public_base(), format!("{}/hook/{id}", relay.url.replace("ws://", "http://")));
        let mut leg = relay.next_leg().await;
        assert_eq!(leg.path, "/hookleg");
        assert_eq!(leg.authorization, format!("Basic {}", B64.encode(format!("{id}:{}", identity["deviceSecret"].as_str().unwrap()))));

        let reply = leg.round_trip(http_frame("req-1", r#"{"hello":1}"#)).await;
        assert_eq!(reply, json!({"type": "http-response", "id": "req-1", "status": 201, "headers": {"content-type": "text/plain"}, "body": B64.encode("stored")}));
        let request = seen.await.unwrap();
        assert!(request.starts_with("POST /webhook/demo HTTP/1.1\r\n") && request.contains("x-demo: yes\r\n"));

        let invalid = leg.round_trip(json!({"type": "http", "id": "bad-1", "method": "GET", "path": "/webhook/x"})).await;
        assert_eq!((invalid["status"].as_u64(), invalid["id"].as_str()), (Some(400), Some("bad-1")));
        assert!(String::from_utf8(B64.decode(invalid["body"].as_str().unwrap()).unwrap()).unwrap().contains("method must be POST"));
        tunnel.close();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn without_a_local_listener_the_tunnel_answers_503_and_redials_after_the_relay_drops_the_leg() {
        let dir = tempfile::tempdir().unwrap();
        let mut relay = Relay::start().await;
        let mut tunnel = starter(dir.path(), &relay.url).start(LocalPort::with(0)).await.unwrap().unwrap();
        let mut first = relay.next_leg().await;
        let reply = first.round_trip(http_frame("req-503", "")).await;
        assert_eq!(reply["status"], 503);
        assert_eq!(B64.decode(reply["body"].as_str().unwrap()).unwrap(), br#"{"error":"webhook server not listening"}"#);
        first.socket.close(None).await.unwrap();
        drop(first);
        let second = relay.next_leg().await;
        assert_eq!(second.path, "/hookleg", "a fresh leg is dialed after the close");
        tunnel.close();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_ends_the_leg_and_stops_redialing() {
        let dir = tempfile::tempdir().unwrap();
        let mut relay = Relay::start().await;
        let mut tunnel = starter(dir.path(), &relay.url).start(LocalPort::with(0)).await.unwrap().unwrap();
        let mut leg = relay.next_leg().await;
        tunnel.close();
        let ended = tokio::time::timeout(Duration::from_secs(10), async {
            while let Some(Ok(message)) = leg.socket.next().await {
                if message.is_close() {
                    break;
                }
            }
        })
        .await;
        assert!(ended.is_ok(), "the leg is closed");
        tokio::time::sleep(Duration::from_millis(1_500)).await;
        assert!(relay.legs.try_recv().is_err(), "no reconnect after close");
    }
}
