//! The `ctl` client: the one client of the management path (LR §6.1–§6.2). It speaks the control listener's fixed HTTP/1.1
//! grammar (`GET /mgmt/status`, `POST /mgmt/{hold,stop,cancelDrain,release,terminate}`, JSON bodies, `Authorization: Bearer`)
//! over a fresh loopback connection per request, so it works while the core's RPC runtime is stalled or draining.
//!
//! Every call is bounded like the Node session client's (`session-client.mjs` `request`): `status` is its `/health` probe
//! (800 ms of silence and 800 ms in all), every other command a lifecycle call (3000 ms of silence, no total), and a call
//! past its bound fails with `session timeout: <method> <path>`.

use std::{future::Future, path::Path, time::Duration};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

use crate::{
    discovery::{Discovery, DiscoveryError, Endpoint},
};

/// A control reply is a small snapshot; anything larger is a broken peer.
const MAX_REPLY_BYTES: usize = 1 << 20;

/// The bound of one call: Node's `request({ timeoutMs, deadlineMs })`. `inactivity` is `timeoutMs`, the longest the
/// connection may stay silent (a trickling reply keeps resetting it); `total` is `deadlineMs`, the longest the call may
/// last, which only probes set.
#[derive(Debug, Clone, Copy)]
struct Bound {
    inactivity: Duration,
    total: Option<Duration>,
}

/// `probeSessionHealth` (`timeoutMs: 800`, `deadlineMs: max(1, timeoutMs)`): `status`.
const PROBE: Bound = Bound {
    inactivity: Duration::from_millis(800),
    total: Some(Duration::from_millis(800)),
};

/// The lifecycle calls (`/shutdown`, `/stop`, `/install-hold`, `/upgrade`, `/client/register`: `timeoutMs: 3000`, no
/// deadline): `hold`, `stop`, `cancelDrain`, `release`, `terminate`.
const LIFECYCLE: Bound = Bound {
    inactivity: Duration::from_millis(3000),
    total: None,
};

/// One request in flight: what its timeout error names and the bound it runs under.
struct Call {
    verb: &'static str,
    path: String,
    bound: Bound,
}

impl Call {
    /// `sessionTimeoutError(method, urlPath)`.
    fn timed_out(&self) -> CtlError {
        CtlError::Timeout {
            method: self.verb,
            path: self.path.clone(),
        }
    }

    /// One connection operation under the inactivity bound (Node's socket `timeout`, reset by every byte moved).
    async fn idle<T>(&self, op: impl Future<Output = std::io::Result<T>>) -> Result<T, CtlError> {
        tokio::time::timeout(self.bound.inactivity, op)
            .await
            .map_err(|_| self.timed_out())?
            .map_err(CtlError::Io)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CtlError {
    #[error(transparent)]
    Discovery(#[from] DiscoveryError),
    #[error("control listener: {0}")]
    Io(#[from] std::io::Error),
    /// No answer within the call's bound: the core may be busy with it, not gone (`ESESSIONTIMEOUT`). `path` is the
    /// request path.
    #[error("session timeout: {method} {path}")]
    Timeout { method: &'static str, path: String },
    /// The listener answered something that is not its grammar.
    #[error("bad control reply: {0}")]
    BadReply(String),
    /// 401: the token is not this core's (the core restarted since the discovery file was read).
    #[error("control listener refused the token")]
    Unauthorized,
    /// The core refused the command. `code` is the state machine's refusal code (`confirmationInvalid`, `notDraining`, ...).
    #[error("{status}: {code}: {message}")]
    Refused {
        status: u16,
        code: String,
        message: String,
    },
}

impl CtlError {
    /// The refusal code of a `Refused`.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Refused { code, .. } => Some(code),
            _ => None,
        }
    }
}

/// Why a stop is asked for (LR §5.1). The reason changes only the text users see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Update,
    Quit,
    Restart,
    FastDeploy,
    SshReplace,
    UserStop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopMode {
    /// Wait for the busy count to reach zero; nothing times it.
    WhenIdle,
    /// Cancel the running turns the user saw; needs `confirm_token` from `status`.
    AbortConfirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CoreStateName {
    Booting,
    Blocked,
    Migrating,
    Serving,
    Draining,
    Stopped,
    Fenced,
}

/// One unit of work listed to the user in a drain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningWork {
    pub kind: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub title: String,
}

/// A boot stopped at the prior-owner verdict (LR §3.1): `kind` is `waitExit` or `undecidable`; the latter adds the
/// process identity and the one-decision `confirm_token`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedStatus {
    pub kind: String,
    pub pid: u32,
    pub image: Option<String>,
    pub command_line: Option<String>,
    pub start_time: Option<String>,
    pub confirm_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationStatus {
    pub kind: String,
    pub done: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainStatus {
    pub drain_id: String,
    pub reason: String,
    /// The user's authorization for `AbortConfirmed`, bound to `drain_id` and the `running` set above.
    pub confirm_token: String,
    /// The idle wait is over; `cancel_drain` no longer applies.
    pub releasing: bool,
}

/// `GET /mgmt/status`. When the core is stalled the snapshot is stale: `seq_of_snapshot` with `stalled_ms` says so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub state: CoreStateName,
    pub version: String,
    pub instance_id: String,
    pub hold: bool,
    pub clients: u64,
    pub running: Vec<RunningWork>,
    pub blocked: Option<BlockedStatus>,
    pub migration: Option<MigrationStatus>,
    pub drain: Option<DrainStatus>,
    pub fenced: Option<String>,
    /// The token `terminate` needs; bound to `instance_id`.
    pub terminate_token: String,
    pub seq_of_snapshot: u64,
    /// How long the core's runtime has left a probe unanswered; `0` when it answers.
    pub stalled_ms: u64,
}

#[derive(Serialize)]
struct HoldBody {
    on: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StopBody<'a> {
    mode: StopMode,
    reason: StopReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    confirm_token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replacement: Option<ReplacementBody<'a>>,
}
/// The build a replacement stop is for (`daemon.mjs:589`: `daemon replacement by revision/build <revision>/<version>`).
#[derive(Serialize)]
struct ReplacementBody<'a> {
    revision: &'a str,
    version: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelDrainBody<'a> {
    drain_id: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseBody<'a> {
    pid: u32,
    confirm_token: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminateBody<'a> {
    confirm_token: &'a str,
}
#[derive(Deserialize)]
struct RefusalBody {
    code: String,
    message: String,
}

/// A client of one core's control listener.
#[derive(Debug, Clone)]
pub struct CtlClient {
    endpoint: Endpoint,
}

impl CtlClient {
    pub fn new(endpoint: Endpoint) -> Self {
        Self { endpoint }
    }

    /// Resolves the control listener from the discovery file at `path` (read now; build a new client after a core restart).
    pub async fn from_discovery(path: &Path) -> Result<Self, CtlError> {
        Ok(Self::new(Discovery::read(path)?.control_endpoint()))
    }

    /// The core's own discovery file (`runtime_root()/daemon.json`).
    pub async fn local() -> Result<Self, CtlError> {
        Self::from_discovery(&crate::discovery::discovery_path()).await
    }

    pub async fn status(&self) -> Result<CoreStatus, CtlError> {
        self.request("GET", "status", None, PROBE).await
    }

    /// `hold{on}`: new turn starts are deferred, not refused (LR §5.1 step 1).
    pub async fn hold(&self, on: bool) -> Result<CoreStatus, CtlError> {
        self.post("hold", &HoldBody { on }).await
    }

    /// `stop`: commits the wind-down. Every command returns the state after it.
    pub async fn stop(
        &self,
        mode: StopMode,
        reason: StopReason,
        confirm_token: Option<&str>,
    ) -> Result<CoreStatus, CtlError> {
        self.post(
            "stop",
            &StopBody {
                mode,
                reason,
                confirm_token,
                replacement: None,
            },
        )
        .await
    }

    /// [`CtlClient::stop`] for a replacement (`update`, `restart`, `fastDeploy`, `sshReplace`): the core refuses one that does not name
    /// the build that replaces it.
    pub async fn stop_replacing(
        &self,
        mode: StopMode,
        reason: StopReason,
        confirm_token: Option<&str>,
        revision: &str,
        version: &str,
    ) -> Result<CoreStatus, CtlError> {
        self.post(
            "stop",
            &StopBody {
                mode,
                reason,
                confirm_token,
                replacement: Some(ReplacementBody { revision, version }),
            },
        )
        .await
    }

    pub async fn cancel_drain(&self, drain_id: &str) -> Result<CoreStatus, CtlError> {
        self.post("cancelDrain", &CancelDrainBody { drain_id }).await
    }

    /// The one decision on an `undecidable` prior owner; `confirm_token` is `status().blocked.confirm_token`.
    pub async fn release(&self, pid: u32, confirm_token: &str) -> Result<CoreStatus, CtlError> {
        self.post("release", &ReleaseBody { pid, confirm_token }).await
    }

    /// The user-authorized exit of a stalled core; `confirm_token` is `status().terminate_token`.
    pub async fn terminate(&self, confirm_token: &str) -> Result<CoreStatus, CtlError> {
        self.post("terminate", &TerminateBody { confirm_token }).await
    }

    async fn post<B: Serialize, R: DeserializeOwned>(
        &self,
        name: &str,
        body: &B,
    ) -> Result<R, CtlError> {
        let body = serde_json::to_vec(body).map_err(|e| CtlError::BadReply(e.to_string()))?;
        self.request("POST", name, Some(body), LIFECYCLE).await
    }

    /// Connects, sends the request and reads the reply; every step runs under the call's inactivity bound.
    async fn exchange(&self, call: &Call, body: Option<Vec<u8>>) -> Result<Reply, CtlError> {
        let mut stream = call.idle(TcpStream::connect(("127.0.0.1", self.endpoint.port))).await?;
        let body = body.unwrap_or_default();
        let mut head = format!(
            "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nConnection: close\r\n",
            call.verb, call.path, self.endpoint.port, self.endpoint.token
        );
        if call.verb == "POST" {
            head.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\n",
                body.len()
            ));
        }
        head.push_str("\r\n");
        call.idle(stream.write_all(head.as_bytes())).await?;
        call.idle(stream.write_all(&body)).await?;
        call.idle(stream.flush()).await?;
        read_reply(call, &mut stream).await
    }

    async fn request<R: DeserializeOwned>(
        &self,
        verb: &'static str,
        name: &str,
        body: Option<Vec<u8>>,
        bound: Bound,
    ) -> Result<R, CtlError> {
        let call = Call {
            verb,
            path: format!("/mgmt/{name}"),
            bound,
        };
        let reply = match bound.total {
            Some(total) => tokio::time::timeout(total, self.exchange(&call, body))
                .await
                .map_err(|_| call.timed_out())??,
            None => self.exchange(&call, body).await?,
        };
        match reply.status {
            200..=299 => serde_json::from_slice(&reply.body)
                .map_err(|e| CtlError::BadReply(format!("body: {e}"))),
            401 => Err(CtlError::Unauthorized),
            status => {
                let refusal: RefusalBody = serde_json::from_slice(&reply.body)
                    .map_err(|e| CtlError::BadReply(format!("{status} body: {e}")))?;
                Err(CtlError::Refused {
                    status,
                    code: refusal.code,
                    message: refusal.message,
                })
            }
        }
    }
}

struct Reply {
    status: u16,
    body: Vec<u8>,
}

/// Reads one `Content-Length` reply. The listener closes after each reply (`Connection: close`), so a reply without a
/// length is read to the end of the stream.
async fn read_reply(call: &Call, stream: &mut TcpStream) -> Result<Reply, CtlError> {
    let mut buf = Vec::with_capacity(1024);
    let head_end = loop {
        if let Some(i) = find_head_end(&buf) {
            break i;
        }
        if buf.len() > MAX_REPLY_BYTES {
            return Err(CtlError::BadReply("header too large".into()));
        }
        if call.idle(stream.read_buf(&mut buf)).await? == 0 {
            return Err(CtlError::BadReply("closed inside the header".into()));
        }
    };
    let head = std::str::from_utf8(&buf[..head_end])
        .map_err(|_| CtlError::BadReply("header is not utf-8".into()))?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.strip_prefix("HTTP/1.1 "))
        .and_then(|l| l.get(..3))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| CtlError::BadReply("status line".into()))?;
    let mut length = None;
    for line in lines {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| CtlError::BadReply("header line".into()))?;
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| CtlError::BadReply("content-length".into()))?,
            );
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(CtlError::BadReply("transfer-encoding".into()));
        }
    }
    let mut body = buf.split_off(head_end + 4);
    match length {
        Some(n) if n > MAX_REPLY_BYTES => return Err(CtlError::BadReply("body too large".into())),
        Some(n) => {
            while body.len() < n {
                if call.idle(stream.read_buf(&mut body)).await? == 0 {
                    return Err(CtlError::BadReply("closed inside the body".into()));
                }
            }
            body.truncate(n);
        }
        None => {
            while call.idle(stream.read_buf(&mut body)).await? != 0 {
                if body.len() > MAX_REPLY_BYTES {
                    return Err(CtlError::BadReply("body too large".into()));
                }
            }
        }
    }
    Ok(Reply { status, body })
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::net::TcpListener;

    use super::*;

    /// Serves one canned reply and returns the raw request it received.
    async fn serve_once(reply: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            loop {
                s.read_buf(&mut buf).await.unwrap();
                if let Some(i) = find_head_end(&buf) {
                    let head = String::from_utf8_lossy(&buf[..i]).to_string();
                    let want = head
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: "))
                        .map_or(0, |n| n.parse::<usize>().unwrap());
                    if buf.len() >= i + 4 + want {
                        break;
                    }
                }
            }
            s.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8(buf).unwrap()
        });
        (port, task)
    }

    fn client(port: u16) -> CtlClient {
        CtlClient::new(Endpoint {
            port,
            token: "tok".into(),
        })
    }

    fn ok_reply(body: &serde_json::Value) -> &'static str {
        let body = body.to_string();
        Box::leak(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .into_boxed_str(),
        )
    }

    fn draining_status() -> serde_json::Value {
        json!({
            "state": "draining", "version": "1.4.6", "instanceId": "i1", "hold": false, "clients": 2,
            "running": [{"kind": "turn", "threadId": "t1", "turnId": null, "title": "x"}],
            "blocked": null, "migration": null,
            "drain": {"drainId": "d1", "reason": "update", "confirmToken": "c", "releasing": false},
            "fenced": null, "terminateToken": "tt", "seqOfSnapshot": 9, "stalledMs": 40
        })
    }

    #[tokio::test]
    async fn stop_posts_the_documented_body_and_returns_the_state_after_it() {
        let (port, served) = serve_once(ok_reply(&draining_status())).await;
        let after = client(port)
            .stop(StopMode::AbortConfirmed, StopReason::FastDeploy, Some("c1"))
            .await
            .unwrap();
        assert_eq!(after.state, CoreStateName::Draining);
        let raw = served.await.unwrap();
        assert!(raw.starts_with("POST /mgmt/stop HTTP/1.1\r\n"));
        assert!(raw.contains("Authorization: Bearer tok\r\n"));
        assert!(raw.ends_with(
            r#"{"mode":"abortConfirmed","reason":"fastDeploy","confirmToken":"c1"}"#
        ));
    }

    #[tokio::test]
    async fn a_replacement_names_the_build_that_replaces_the_core() {
        let (port, served) = serve_once(ok_reply(&draining_status())).await;
        client(port).stop_replacing(StopMode::WhenIdle, StopReason::Update, None, "abc", "1.5.0").await.unwrap();
        assert!(served.await.unwrap().ends_with(
            r#"{"mode":"whenIdle","reason":"update","replacement":{"revision":"abc","version":"1.5.0"}}"#
        ));
    }

    #[tokio::test]
    async fn status_decodes_the_snapshot() {
        let (port, served) = serve_once(ok_reply(&draining_status())).await;
        let status = client(port).status().await.unwrap();
        served.await.unwrap();
        assert_eq!(status.state, CoreStateName::Draining);
        assert_eq!(status.drain.unwrap().drain_id, "d1");
        assert_eq!(status.running[0].thread_id.as_deref(), Some("t1"));
        assert_eq!(status.stalled_ms, 40);
    }

    /// The listener serves `mixdog_app_protocol::mgmt` types; this client re-declares them, so
    /// the two must agree on the wire.
    #[test]
    fn the_client_types_decode_what_the_listener_serves_and_the_listener_accepts_what_it_sends() {
        use mixdog_app_protocol::mgmt as wire;

        let served = wire::StatusReply {
            status: wire::CoreStatus {
                state: wire::StateName::Draining,
                version: "1.4.6".into(),
                instance_id: "i1".into(),
                hold: true,
                clients: 2,
                running: vec![wire::RunningWork {
                    kind: wire::ActivityKind::BackgroundShell,
                    thread_id: None,
                    turn_id: None,
                    title: "build".into(),
                }],
                blocked: Some(wire::BlockedStatus {
                    blocked: wire::Blocked::Undecidable {
                        pid: 7,
                        image: "a.exe".into(),
                        command_line: "a.exe --x".into(),
                        start_time: "99".into(),
                    },
                    confirm_token: Some("rt".into()),
                }),
                migration: Some(wire::MigrationStatus { kind: "store".into(), done: 1, total: 4 }),
                drain: Some(wire::DrainStatus {
                    drain_id: "d1".into(),
                    reason: wire::StopReason::SshReplace,
                    confirm_token: "c".into(),
                    releasing: false,
                }),
                fenced: Some(wire::FenceReason::LockLost),
                terminate_token: "tt".into(),
                seq_of_snapshot: 5,
            },
            stalled_ms: 12,
        };
        let status: CoreStatus = serde_json::from_value(serde_json::to_value(&served).unwrap()).unwrap();
        assert_eq!(status.state, CoreStateName::Draining);
        assert_eq!(status.running[0].kind, "backgroundShell");
        assert_eq!(status.running[0].thread_id, None);
        let blocked = status.blocked.unwrap();
        assert_eq!((blocked.kind.as_str(), blocked.pid), ("undecidable", 7));
        assert_eq!(blocked.command_line.as_deref(), Some("a.exe --x"));
        assert_eq!(blocked.start_time.as_deref(), Some("99"));
        assert_eq!(blocked.confirm_token.as_deref(), Some("rt"));
        assert_eq!(status.drain.unwrap().reason, "sshReplace");
        assert_eq!(status.fenced.as_deref(), Some("lockLost"));
        assert_eq!((status.clients, status.stalled_ms, status.seq_of_snapshot), (2, 12, 5));

        let wait = wire::StatusReply {
            status: wire::CoreStatus {
                blocked: Some(wire::BlockedStatus {
                    blocked: wire::Blocked::WaitExit { pid: 8 },
                    confirm_token: None,
                }),
                ..served.status.clone()
            },
            stalled_ms: 0,
        };
        let status: CoreStatus = serde_json::from_value(serde_json::to_value(&wait).unwrap()).unwrap();
        let blocked = status.blocked.unwrap();
        assert_eq!((blocked.kind.as_str(), blocked.pid, blocked.image), ("waitExit", 8, None));

        // `deny_unknown_fields` on the listener: every body this client sends must parse there.
        fn body<T: Serialize>(value: &T) -> String {
            serde_json::to_string(value).unwrap()
        }
        let stop = body(&StopBody { mode: StopMode::AbortConfirmed, reason: StopReason::UserStop, confirm_token: Some("c"), replacement: None });
        let stop: wire::StopRequest = serde_json::from_str(&stop).unwrap();
        assert_eq!((stop.mode, stop.reason), (wire::StopMode::AbortConfirmed, wire::StopReason::UserStop));
        serde_json::from_str::<wire::HoldRequest>(&body(&HoldBody { on: true })).unwrap();
        serde_json::from_str::<wire::CancelDrainRequest>(&body(&CancelDrainBody { drain_id: "d" })).unwrap();
        serde_json::from_str::<wire::ReleaseRequest>(&body(&ReleaseBody { pid: 3, confirm_token: "t" })).unwrap();
        serde_json::from_str::<wire::TerminateRequest>(&body(&TerminateBody { confirm_token: "t" })).unwrap();

        // The client's `RefusalBody` reads the listener's `ErrorReply`.
        let refusal = serde_json::to_vec(&wire::ErrorReply::new("notDraining", "no drain")).unwrap();
        let refusal: RefusalBody = serde_json::from_slice(&refusal).unwrap();
        assert_eq!((refusal.code.as_str(), refusal.message.as_str()), ("notDraining", "no drain"));
    }

    /// Accepts one connection and never answers; the stream is held open so the peer sees silence, not a close.
    async fn silent_listener() -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let _held = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        (port, task)
    }

    /// `session-client.mjs` `request`: a core that accepts and says nothing ends the call with `session timeout:
    /// <method> <path>` (`status` is the 800 ms `/health` probe, a command the 3000 ms lifecycle call).
    #[tokio::test(start_paused = true)]
    async fn a_silent_core_times_out_with_nodes_text() {
        let (port, _held) = silent_listener().await;
        let started = tokio::time::Instant::now();
        let err = client(port).status().await.unwrap_err();
        assert!(matches!(err, CtlError::Timeout { .. }), "{err:?}");
        assert_eq!(err.to_string(), "session timeout: GET /mgmt/status");
        assert_eq!(started.elapsed(), Duration::from_millis(800));

        let (port, _held) = silent_listener().await;
        let started = tokio::time::Instant::now();
        let err = client(port).hold(true).await.unwrap_err();
        assert_eq!(err.to_string(), "session timeout: POST /mgmt/hold");
        assert_eq!(started.elapsed(), Duration::from_millis(3000));
    }

    /// Answers with the headers at once and the body one byte per `every`, never silent for as long as `every`.
    async fn trickling_listener(every: Duration, body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
            s.write_all(head.as_bytes()).await.unwrap();
            for byte in body.bytes() {
                tokio::time::sleep(every).await;
                if s.write_all(&[byte]).await.is_err() {
                    return;
                }
            }
            std::future::pending::<()>().await;
        });
        port
    }

    /// `timeoutMs` is socket inactivity, `deadlineMs` the total: a reply that trickles past 3000 ms in all still lands
    /// for a lifecycle command, and past 800 ms in all it times `status` out.
    #[tokio::test(start_paused = true)]
    async fn a_trickling_reply_resets_the_silence_bound_but_not_the_probes_total() {
        let body = draining_status().to_string().leak();
        let port = trickling_listener(Duration::from_millis(20), body).await;
        assert_eq!(client(port).hold(true).await.unwrap().state, CoreStateName::Draining);

        let port = trickling_listener(Duration::from_millis(20), body).await;
        let err = client(port).status().await.unwrap_err();
        assert_eq!(err.to_string(), "session timeout: GET /mgmt/status");
    }

    #[tokio::test]
    async fn refusals_and_auth_failures_are_typed() {
        let body = r#"{"code":"confirmationInvalid","message":"nope"}"#;
        let reply: &'static str = Box::leak(
            format!("HTTP/1.1 409 Conflict\r\nContent-Length: {}\r\n\r\n{body}", body.len())
                .into_boxed_str(),
        );
        let (port, _s) = serve_once(reply).await;
        let err = client(port).terminate("x").await.unwrap_err();
        assert_eq!(err.code(), Some("confirmationInvalid"));

        let (port, _s) = serve_once("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n").await;
        assert!(matches!(
            client(port).hold(true).await.unwrap_err(),
            CtlError::Unauthorized
        ));
    }
}
