//! The `ctl` client: the one client of the management path (LR §6.1–§6.2). It speaks the control listener's fixed HTTP/1.1
//! grammar (`GET /mgmt/status`, `POST /mgmt/{hold,stop,cancelDrain,release,terminate}`, JSON bodies, `Authorization: Bearer`)
//! over a fresh loopback connection per request, so it works while the core's RPC runtime is stalled or draining.
//!
//! Every call is bounded like the Node session client's (`session-client.mjs` `request`), by the Node call that does the
//! same job; a call past its bound fails with `session timeout: <method> <path>` (code `ESESSIONTIMEOUT`):
//!
//! | ctl call | Node call | bound |
//! |---|---|---|
//! | `status` | `probeSessionHealth` `GET /health` | 800 ms of silence, 800 ms in all |
//! | `hold(true)` | `holdInTreeDaemon` `POST /install-hold {action: close}` | 3000 ms of silence |
//! | `hold(false)`, `cancelDrain` | `holdInTreeDaemon` `{action: release}` (`cancelDrain` has no Node endpoint; it also reopens admission) | 3000 ms of silence |
//! | `stop`, `release` | `stopInTreeDaemon` `POST /stop` (`release` has no Node endpoint; it also settles a boot) | 3000 ms of silence |
//! | `terminate` | `shutdownDaemon` `POST /shutdown` (`terminate` has no Node endpoint; it also ends the daemon) | 3000 ms of silence |
//!
//! "Silence" is Node's socket `timeout`: every byte moved in either direction resets it.

use std::{future::Future, path::Path, time::Duration};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{
    io::{AsyncReadExt, AsyncWrite, AsyncWriteExt},
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

/// The lifecycle calls (`/shutdown`, `/stop`, `/install-hold`: `timeoutMs: 3000`, no deadline): `hold`, `stop`,
/// `cancelDrain`, `release`, `terminate`.
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

    /// `write_all` with the silence bound restarted by every write that moves bytes, as Node's socket timer is.
    async fn write_all<W: AsyncWrite + Unpin>(&self, stream: &mut W, mut bytes: &[u8]) -> Result<(), CtlError> {
        while !bytes.is_empty() {
            let moved = self.idle(stream.write(bytes)).await?;
            if moved == 0 {
                return Err(CtlError::Io(std::io::ErrorKind::WriteZero.into()));
            }
            bytes = &bytes[moved..];
        }
        Ok(())
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
    /// The refusal code of a `Refused`; `ESESSIONTIMEOUT` for a `Timeout`, the `code` Node's error carries.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Refused { code, .. } => Some(code),
            Self::Timeout { .. } => Some("ESESSIONTIMEOUT"),
            _ => None,
        }
    }

    /// What `mixdogd ctl` prints on stderr for a failed call. Only a `Refused` is a refusal: a timeout is the core not
    /// answering, which Node's callers show as the bare `session timeout: <method> <path>` (`holdInTreeDaemon` and
    /// `stopInTreeDaemon` carry it as `error`; `probeSessionHealth` and `shutdownDaemon` show only that the core did not answer).
    pub fn cli_line(&self) -> String {
        match self {
            Self::Refused { code, .. } => format!("mixdogd: refused: {code}: {self}"),
            _ => format!("mixdogd: {self}"),
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
        call.write_all(&mut stream, head.as_bytes()).await?;
        call.write_all(&mut stream, &body).await?;
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

    /// A stub core that plays one recorded reply script: accepts, then stays silent, answers after `ms`, or trickles
    /// (headers and the first piece of the body at once, one more piece every `everyMs`, `chunks` times). The pieces
    /// are scheduled on the paused clock, so the order against the client's own timers is the clock's, not the host's.
    async fn scripted_listener(reply: &serde_json::Value, body: String) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let reply = reply.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let begun = tokio::time::Instant::now();
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
            let at = |ms: u64| begun + Duration::from_millis(ms);
            match reply["kind"].as_str().unwrap() {
                "silent" => {}
                "after" => {
                    tokio::time::sleep_until(at(reply["ms"].as_u64().unwrap())).await;
                    let _ = stream.write_all(format!("{head}{body}").as_bytes()).await;
                }
                "trickle" => {
                    let every = reply["everyMs"].as_u64().unwrap();
                    let chunks = reply["chunks"].as_u64().unwrap() as usize;
                    let bytes = body.as_bytes();
                    let piece = bytes.len().div_ceil(chunks + 1);
                    let mut pieces = bytes.chunks(piece);
                    let first = pieces.next().unwrap();
                    let _ = stream.write_all(&[head.as_bytes(), first].concat()).await;
                    for (k, rest) in pieces.enumerate() {
                        tokio::time::sleep_until(at(every * (k as u64 + 1))).await;
                        if stream.write_all(rest).await.is_err() {
                            return;
                        }
                    }
                }
                other => panic!("unknown reply script {other}"),
            }
            // The stream stays open: the peer must see silence, not a close.
            std::future::pending::<()>().await;
        });
        port
    }

    /// Each recorded Node call and the ctl calls that do the same job (the table in the module docs): the Node call, the
    /// ctl path, the ctl call.
    const COUNTERPARTS: [(&str, &str, &str); 7] = [
        ("GET /health", "/mgmt/status", "status"),
        ("POST /install-hold close", "/mgmt/hold", "hold"),
        ("POST /install-hold release", "/mgmt/hold", "unhold"),
        ("POST /install-hold release", "/mgmt/cancelDrain", "cancelDrain"),
        ("POST /stop", "/mgmt/stop", "stop"),
        ("POST /stop", "/mgmt/release", "release"),
        ("POST /shutdown", "/mgmt/terminate", "terminate"),
    ];

    async fn invoke(call: &str, c: &CtlClient) -> Result<CoreStatus, CtlError> {
        match call {
            "status" => c.status().await,
            "hold" => c.hold(true).await,
            "unhold" => c.hold(false).await,
            "cancelDrain" => c.cancel_drain("d1").await,
            "stop" => c.stop(StopMode::WhenIdle, StopReason::UserStop, None).await,
            "release" => c.release(7, "t").await,
            "terminate" => c.terminate("t").await,
            other => panic!("unknown ctl call {other}"),
        }
    }

    /// `session-client.mjs` `request` as recorded from the real call sites (`fixtures/ctl-timeouts/golden.json`): every
    /// ctl call, replayed against each reply script of its Node counterpart under the paused clock, ends as Node's did
    /// (answered, or `session timeout: <method> <path>` with the same code), gives up when the recorded bound says (the
    /// silence `timeoutMs`, or the `deadlineMs` total when the call has one), and no later than Node did.
    #[tokio::test(start_paused = true)]
    async fn every_ctl_call_ends_as_its_node_counterpart_did() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/ctl-timeouts/golden.json")).unwrap();
        let cases = golden["cases"].as_array().unwrap();
        assert!(
            cases.iter().all(|c| COUNTERPARTS.iter().any(|(node_call, ..)| c["nodeCall"] == *node_call)),
            "every recorded Node call has a ctl counterpart"
        );
        for (node_call, ctl_path, call) in COUNTERPARTS {
            for case in cases.iter().filter(|c| c["nodeCall"] == node_call) {
                let what = format!("{ctl_path} against {node_call} {}", case["reply"]);
                let request = &case["request"];
                let port = scripted_listener(&case["reply"], draining_status().to_string()).await;
                let started = tokio::time::Instant::now();
                // The outer bound only keeps a client without a deadline from hanging the test.
                let outcome = tokio::time::timeout(Duration::from_secs(60), invoke(call, &client(port)))
                    .await
                    .unwrap_or_else(|_| panic!("{what}: never ended"));
                let elapsed = started.elapsed();
                let answered = outcome.is_ok();
                let shown = outcome.as_ref().err().map(CtlError::cli_line);
                match case["settled"].as_str().unwrap() {
                    "resolved" => assert_eq!(outcome.expect(&what).state, CoreStateName::Draining, "{what}"),
                    _ => {
                        let err = outcome.expect_err(&what);
                        let recorded = &case["error"];
                        assert_eq!(err.code(), recorded["code"].as_str(), "{what}");
                        let node_path = request["path"].as_str().unwrap();
                        let node_method = request["method"].as_str().unwrap();
                        assert_eq!(
                            recorded["message"].as_str().unwrap(),
                            format!("session timeout: {node_method} {node_path}"),
                            "{what}: Node's text"
                        );
                        assert_eq!(err.to_string(), format!("session timeout: {node_method} {ctl_path}"), "{what}");
                        let silence = request["timeoutMs"].as_u64().unwrap();
                        let total = request["deadlineMs"].as_u64().unwrap();
                        let gave_up = if total > 0 { silence.min(total) } else { silence };
                        assert_eq!(elapsed, Duration::from_millis(gave_up), "{what}");
                        assert!(elapsed <= Duration::from_millis(case["elapsedMs"].as_u64().unwrap()), "{what}: after Node");
                    }
                }
                // What the Node caller shows or returns (`seen`), projected from what `mixdogd ctl` shows or exits with.
                let node_path = request["path"].as_str().unwrap();
                let shown_error = shown.as_deref().map(|line| {
                    line.strip_prefix("mixdogd: ").expect("a bare error line, not a refusal").replace(ctl_path, node_path)
                });
                let ok_word = |word: &'static str, other: &'static str| if answered { word } else { other };
                let seen = match node_call {
                    "GET /health" => json!({"health": if answered { json!("ok") } else { json!(null) }}),
                    "POST /install-hold close" => json!({"status": ok_word("held", "unknown"), "error": shown_error}),
                    "POST /install-hold release" => json!({"status": ok_word("released", "unknown"), "error": shown_error}),
                    "POST /stop" => json!({"request": ok_word("sent", "failed"), "error": shown_error}),
                    "POST /shutdown" => json!({"shutDown": answered}),
                    other => panic!("no projection for {other}"),
                };
                assert_eq!(seen, case["seen"], "{what}: what the caller sees");
            }
        }
    }

    /// The silence bound is restarted by every write that moves bytes (Node's socket `timeout`), not a limit on the whole
    /// write: a peer that drains a little at intervals shorter than the recorded `timeoutMs` keeps a transfer much longer
    /// than it alive, and one that stops draining ends it at that bound after its last progress.
    #[tokio::test(start_paused = true)]
    async fn a_write_that_keeps_moving_outlasts_the_silence_bound_and_a_stalled_one_ends_at_it() {
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/ctl-timeouts/golden.json")).unwrap();
        let silence = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["nodeCall"] == "POST /stop" && c["reply"]["kind"] == "silent")
            .map(|c| Duration::from_millis(c["request"]["timeoutMs"].as_u64().unwrap()))
            .unwrap();
        let call = Call { verb: "POST", path: "/mgmt/stop".into(), bound: LIFECYCLE };
        assert_eq!(call.bound.inactivity, silence);

        let (mut near, mut far) = tokio::io::duplex(16);
        let every = silence / 2;
        // The peer reads one full buffer every half bound, three times: the transfer lasts 1.5 bounds.
        let drain = tokio::spawn(async move {
            let begun = tokio::time::Instant::now();
            let mut buf = [0u8; 16];
            for k in 1..=3 {
                tokio::time::sleep_until(begun + every * k).await;
                far.read_exact(&mut buf).await.unwrap();
            }
            far
        });
        let started = tokio::time::Instant::now();
        call.write_all(&mut near, &[7u8; 64]).await.expect("progress keeps the call alive");
        assert!(started.elapsed() > silence, "the transfer outlasted the bound");
        let _undrained = drain.await.unwrap();

        // Nobody reads any more: what fits goes in at once, the rest stalls and the call ends one bound later.
        let stalled = tokio::time::Instant::now();
        let err = call.write_all(&mut near, &[7u8; 64]).await.unwrap_err();
        assert_eq!(err.to_string(), "session timeout: POST /mgmt/stop");
        assert_eq!(stalled.elapsed(), silence);
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
