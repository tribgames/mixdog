//! OpenCode Go sign-in and refresh: the OpenCode Console's device grant
//! (JSON bodies, client `opencode-cli`), the account and organization the
//! token acts for, and the refresh of the access token it yields.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;

use super::Http;
use crate::oauth::Pace;
use crate::oauth::http::Reply;
use crate::oauth::FlowGuard;
use crate::oauth::http::call;
use crate::oauth::device;
use crate::oauth::device::Poll;
use crate::oauth::device::Schedule;
use crate::oauth::http::failed;
use crate::oauth::http::scrub;
use crate::oauth::start_session;
use crate::oauth::CredentialFile;
use crate::oauth::Probe;
use crate::oauth::RefreshFailure;
use crate::oauth::classify_refresh_failure;
use crate::providers::compat::creds::OPENCODE_REFRESH_SKEW_SECS;
use crate::providers::compat::creds::OpenCodeGoCredentials;

pub const PROVIDER_ID: &str = "opencode-go-oauth";
const SERVER: &str = "https://opencode.ai/console";
const CLIENT_ID: &str = "opencode-cli";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL_S: f64 = 5.0;
const USER_AGENT: &str = "mixdog";

fn endpoint(path: &str) -> String {
    format!("{SERVER}{path}")
}

fn json_headers(extra: Vec<(&'static str, String)>) -> Vec<(&'static str, String)> {
    let mut all = vec![
        ("accept", "application/json".to_owned()),
        ("user-agent", USER_AGENT.to_owned()),
        ("content-type", "application/json".to_owned()),
    ];
    all.extend(extra);
    all
}

async fn post_json(http: &Http, path: &str, body: JsonValue) -> Result<Reply, LoginFailure> {
    call(http.as_ref(), "POST", &endpoint(path), json_headers(Vec::new()), body.to_string().into_bytes()).await
}

/// The device code response, validated; the verification URL is resolved
/// against the Console.
#[derive(Clone, PartialEq, Debug)]
pub struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_url: String,
    interval: Duration,
    expires_in: Option<Duration>,
}

fn device_code(reply: &Reply) -> Result<DeviceCode, LoginFailure> {
    if !reply.ok() {
        return Err(failed(
            "device_auth",
            format!("device authorization {}: {}", reply.status, scrub(&reply.text(), &[], 300)),
        ));
    }
    let doc = reply.json().unwrap_or(JsonValue::Null);
    let text = |field: &str| doc.get(field).and_then(JsonValue::as_str).unwrap_or("");
    let (device_code, user_code, verification) =
        (text("device_code"), text("user_code"), text("verification_uri_complete"));
    if device_code.is_empty() || user_code.is_empty() || verification.is_empty() {
        return Err(failed("validation", "device authorization response is missing required fields"));
    }
    let base = url::Url::parse(&format!("{SERVER}/")).expect("a constant URL parses");
    let url = base
        .join(verification)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .ok_or_else(|| failed("validation", "device verification URL is not HTTP(S)"))?;
    let positive = |field: &str| doc.get(field).and_then(JsonValue::as_f64).filter(|n| *n > 0.0);
    Ok(DeviceCode {
        device_code: device_code.to_owned(),
        user_code: user_code.to_owned(),
        verification_url: url.into(),
        interval: Duration::from_secs_f64(positive("interval").unwrap_or(DEFAULT_INTERVAL_S)),
        expires_in: positive("expires_in").map(Duration::from_secs_f64),
    })
}

/// The token fields of a device or refresh grant.
#[derive(Clone, PartialEq, Debug)]
pub struct Grant {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    org_id: Option<String>,
}

fn grant_from(doc: &JsonValue, now_ms: u64) -> Result<Grant, LoginFailure> {
    let text = |field: &str| doc.get(field).and_then(JsonValue::as_str).map_or("", str::trim);
    let (access, refresh) = (text("access_token"), text("refresh_token"));
    if access.is_empty() || refresh.is_empty() {
        return Err(failed("validation", "token response is missing access_token or refresh_token"));
    }
    let expires_at = doc
        .get("expires_in")
        .and_then(JsonValue::as_f64)
        .filter(|n| *n > 0.0)
        .map_or(0, |s| now_ms + (s * 1000.0) as u64);
    Ok(Grant {
        access_token: access.to_owned(),
        refresh_token: refresh.to_owned(),
        expires_at,
        org_id: Some(text("org_id")).filter(|o| !o.is_empty()).map(str::to_owned),
    })
}

fn classify_poll(reply: &Reply, device_code: &str, now_ms: u64) -> Poll<Grant> {
    let doc = reply.json().unwrap_or(JsonValue::Null);
    let error = doc.get("error").and_then(JsonValue::as_str).unwrap_or("");
    if reply.ok() && error.is_empty() && doc.get("access_token").is_some_and(|t| t.as_str() != Some("")) {
        return match grant_from(&doc, now_ms) {
            Ok(grant) => Poll::Granted(grant),
            Err(failure) => Poll::Fatal(failure),
        };
    }
    match error {
        "authorization_pending" => Poll::Pending,
        "slow_down" => Poll::SlowDown,
        "expired_token" => Poll::Expired,
        "access_denied" => Poll::Denied,
        "" if reply.status >= 500 => Poll::Transient {
            rate_limited: false,
            retry_after: None,
            fault: failed("device_token", format!("device token {}", reply.status)),
        },
        _ => {
            let detail = if error.is_empty() { scrub(&reply.text(), &[device_code], 300) } else { error.to_owned() };
            Poll::Fatal(failed(
                if error.is_empty() { "device_token" } else { error },
                format!("device token {}: {detail}", reply.status),
            ))
        }
    }
}

/// The organization the login acts for: the grant's own, else the first by name.
pub fn pick_organization<'a>(orgs: &'a JsonValue, org_id: Option<&str>) -> Result<Option<&'a JsonValue>, LoginFailure> {
    let mut list: Vec<&JsonValue> = orgs
        .as_array()
        .map(|a| a.iter().filter(|o| o.get("id").and_then(JsonValue::as_str).is_some_and(|i| !i.is_empty())).collect())
        .unwrap_or_default();
    let id = |o: &JsonValue| o.get("id").and_then(JsonValue::as_str).unwrap_or("").to_owned();
    if let Some(wanted) = org_id {
        return list
            .into_iter()
            .find(|o| id(o) == wanted)
            .map(Some)
            .ok_or_else(|| failed("validation", format!("OpenCode organization not found: {wanted}")));
    }
    let name = |o: &JsonValue| o.get("name").and_then(JsonValue::as_str).unwrap_or("").to_owned();
    list.sort_by(|a, b| mixdog_js::locale_compare(&name(a), &name(b)).then_with(|| mixdog_js::locale_compare(&id(a), &id(b))));
    Ok(list.first().copied())
}

fn console_headers(access_token: &str, org_id: Option<&str>) -> Vec<(&'static str, String)> {
    let mut extra = vec![("authorization", format!("Bearer {access_token}"))];
    if let Some(org) = org_id.filter(|o| !o.is_empty()) {
        extra.push(("x-org-id", org.to_owned()));
    }
    let mut all = json_headers(extra);
    all.retain(|(k, _)| *k != "content-type");
    all
}

async fn console_get(http: &Http, path: &str, grant: &Grant) -> Result<JsonValue, LoginFailure> {
    let reply = call(
        http.as_ref(),
        "GET",
        &endpoint(path),
        console_headers(&grant.access_token, grant.org_id.as_deref()),
        Vec::new(),
    )
    .await?;
    if reply.status == 401 {
        return Err(failed("invalid_grant", format!("{path} 401: OpenCode sign-in expired")));
    }
    match reply.json() {
        Some(doc) if reply.ok() => Ok(doc),
        _ => Err(failed(
            "console",
            format!(
                "{path} {}: {}",
                reply.status,
                scrub(mixdog_js::js_trim(&reply.text()), &[&grant.access_token, &grant.refresh_token], 300)
            ),
        )),
    }
}

/// Reads the account and organization of a fresh grant.
async fn credentials_for(http: &Http, grant: Grant) -> Result<OpenCodeGoCredentials, LoginFailure> {
    let user = console_get(http, "/api/user", &grant).await?;
    let orgs = console_get(http, "/api/orgs", &grant).await?;
    let org = pick_organization(&orgs, grant.org_id.as_deref())?
        .ok_or_else(|| failed("validation", "the OpenCode account has no organization"))?;
    let text = |doc: &JsonValue, field: &str| doc.get(field).and_then(JsonValue::as_str).map_or_else(String::new, str::to_owned);
    Ok(OpenCodeGoCredentials {
        access_token: grant.access_token,
        refresh_token: grant.refresh_token,
        expires_at: grant.expires_at,
        account_id: Some(text(&user, "id")).filter(|s| !s.is_empty()),
        email: Some(mixdog_js::js_trim(&text(&user, "email")).to_lowercase()).filter(|s| !s.is_empty()),
        org_id: Some(text(org, "id")),
        org_name: Some(text(org, "name")).filter(|s| !s.is_empty()),
    })
}

pub struct OpenCodeGoLogin {
    target: LoginTarget,
    http: Http,
    pace: Arc<dyn Pace>,
    file: CredentialFile,
    running: Arc<AtomicBool>,
}

impl OpenCodeGoLogin {
    pub fn new(http: Http, pace: Arc<dyn Pace>, file: CredentialFile) -> Self {
        Self {
            target: LoginTarget::Provider(ProviderId::from(PROVIDER_ID)),
            http,
            pace,
            file,
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[async_trait]
impl LoginFlow for OpenCodeGoLogin {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let guard = FlowGuard::claim(&self.running).ok_or(LoginError::Busy)?;
        let reply = post_json(&self.http, "/auth/device/code", serde_json::json!({"client_id": CLIENT_ID}))
            .await
            .map_err(LoginError::Failed)?;
        let device = device_code(&reply).map_err(LoginError::Failed)?;
        let now_ms = self.pace.now_ms();
        let first = LoginState::DeviceCode {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_url.clone(),
            expires_at: device.expires_in.map(|d| UNIX_EPOCH + Duration::from_millis(now_ms) + d),
        };
        let (http, pace, file) = (self.http.clone(), self.pace.clone(), self.file.clone());
        Ok(start_session(guard, first, false, move |ctx, _| async move {
            ctx.set(LoginState::Waiting);
            let schedule = Schedule {
                interval: device.interval,
                deadline_ms: device.expires_in.map(|d| now_ms + d.as_millis() as u64),
                back_off_on_network: false,
                ..Schedule::default()
            };
            let grant = device::run(pace.as_ref(), schedule, || async {
                let body = serde_json::json!({
                    "grant_type": DEVICE_GRANT_TYPE,
                    "device_code": device.device_code,
                    "client_id": CLIENT_ID,
                });
                match post_json(&http, "/auth/device/token", body).await {
                    Ok(reply) => classify_poll(&reply, &device.device_code, pace.now_ms()),
                    Err(fault) => Poll::Network { fault },
                }
            })
            .await?;
            let credentials = credentials_for(&http, grant).await?;
            file.save(&credentials).await.map_err(|err| failed("store", err.to_string()))?;
            Ok(credentials.email.clone().or(credentials.account_id.clone()))
        }))
    }
}

/// Why a stored credential could not be made usable.
#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
pub enum RefreshError {
    /// The grant is dead or the credential is gone: sign in again.
    #[error("OpenCode sign-in expired: {0}")]
    Reauth(String),
    /// Try again later.
    #[error("{0}")]
    Failed(String),
}

/// The stored credential, refreshed when it is about to expire.
pub struct OpenCodeGoAuth {
    http: Http,
    pace: Arc<dyn Pace>,
    file: CredentialFile,
}

impl OpenCodeGoAuth {
    pub fn new(http: Http, pace: Arc<dyn Pace>, file: CredentialFile) -> Self {
        Self { http, pace, file }
    }

    async fn stored(&self) -> Result<OpenCodeGoCredentials, RefreshError> {
        match self.file.load().await {
            Probe::Present(credentials) => Ok(credentials),
            Probe::Absent => Err(RefreshError::Reauth("credentials removed".into())),
            Probe::Unreadable => Err(RefreshError::Failed("credential file is unreadable".into())),
        }
    }

    /// `force` refreshes even a token that is not near expiry (after a 401).
    pub async fn ensure_fresh(&self, force: bool) -> Result<OpenCodeGoCredentials, RefreshError> {
        let current = self.stored().await?;
        if !force && !current.needs_refresh(self.pace.now_ms()) {
            return Ok(current);
        }
        self.refresh(current, force).await
    }

    /// Concurrent callers on one credential file share a single refresh POST.
    async fn refresh(&self, held: OpenCodeGoCredentials, force: bool) -> Result<OpenCodeGoCredentials, RefreshError> {
        let this = Self { http: self.http.clone(), pace: self.pace.clone(), file: self.file.clone() };
        self.file.refresh_once(async move { this.refresh_unshared(held, force).await }).await
    }

    async fn refresh_unshared(&self, held: OpenCodeGoCredentials, force: bool) -> Result<OpenCodeGoCredentials, RefreshError> {
        // Another process racing us spends the token once: the loser is
        // rejected, re-reads the file and adopts the winner's pair, and the
        // compare-and-swap below never overwrites a newer pair.
        let disk = self.stored().await?;
        let skew = if force { 0 } else { OPENCODE_REFRESH_SKEW_SECS * 1000 };
        let rotated = disk.access_token != held.access_token || disk.refresh_token != held.refresh_token;
        if rotated && (disk.expires_at == 0 || disk.expires_at >= self.pace.now_ms() + skew) {
            return Ok(disk);
        }
        let reply = post_json(
            &self.http,
            "/auth/device/token",
            serde_json::json!({"grant_type": "refresh_token", "refresh_token": disk.refresh_token, "client_id": CLIENT_ID}),
        )
        .await
        .map_err(|f| RefreshError::Failed(format!("token refresh: {f:?}")))?;
        if !reply.ok() {
            if reply.status == 401 || classify_refresh_failure(Some(reply.status), &reply.body) == RefreshFailure::Definitive {
                // Another process may have rotated the pair while we held the old one.
                let now = self.stored().await?;
                if now.refresh_token != disk.refresh_token {
                    return Ok(now);
                }
                return Err(RefreshError::Reauth("refresh rejected".into()));
            }
            let detail = scrub(mixdog_js::js_trim(&reply.text()), &[&disk.access_token, &disk.refresh_token], 200);
            return Err(RefreshError::Failed(format!("token refresh {}: {detail}", reply.status)));
        }
        let doc = reply.json().unwrap_or(JsonValue::Null);
        let grant = grant_from(&doc, self.pace.now_ms()).map_err(|f| RefreshError::Failed(format!("{f:?}")))?;
        // A grant naming another organization moves the account to it; its
        // name is unknown until the next sign-in.
        let org_changed = grant.org_id.as_ref().is_some_and(|o| Some(o) != disk.org_id.as_ref());
        let next = OpenCodeGoCredentials {
            access_token: grant.access_token,
            refresh_token: grant.refresh_token,
            expires_at: grant.expires_at,
            org_id: grant.org_id.clone().or(disk.org_id.clone()),
            org_name: if org_changed { grant.org_id } else { disk.org_name.clone() },
            ..disk.clone()
        };
        let update = match serde_json::to_value(&next) {
            Ok(JsonValue::Object(map)) => map,
            _ => return Err(RefreshError::Failed("credential is not an object".into())),
        };
        let (spent_access, spent_refresh) = (disk.access_token.clone(), disk.refresh_token.clone());
        let published = self
            .file
            .replace_if(
                move |doc| {
                    doc.get("access_token").and_then(JsonValue::as_str) == Some(&spent_access)
                        && doc.get("refresh_token").and_then(JsonValue::as_str) == Some(&spent_refresh)
                },
                update,
            )
            .await
            .map_err(|e| RefreshError::Failed(e.to_string()))?;
        // A sign-in or another refresh replaced the pair meanwhile: it wins.
        if published { Ok(next) } else { self.stored().await }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
use crate::oauth::pace::FakePace;
use crate::oauth::http::testing::Scripted;
use crate::oauth::http::testing::finish;
    use super::*;
    use crate::oauth::CredentialIo;

    fn store(dir: &tempfile::TempDir) -> CredentialFile {
        let tokens = mixdog_rt::testing::tokens();
        CredentialFile::new(
            dir.path().join("opencode-go-oauth.json"),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        )
    }

    const DEVICE: &str = r#"{"device_code":"DC","user_code":"WXYZ","verification_uri_complete":"/device?code=WXYZ","interval":3,"expires_in":900}"#;

    #[tokio::test]
    async fn the_device_grant_stores_the_account_and_first_organization() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let http = Scripted::new(&[
            (200, DEVICE),
            (400, r#"{"error":"slow_down"}"#),
            (200, r#"{"access_token":"AT","refresh_token":"RT","expires_in":3600}"#),
            (200, r#"{"id":"u1","email":" Me@X.Y "}"#),
            (200, r#"[{"id":"o2","name":"Zed"},{"id":"o1","name":"Alpha"}]"#),
        ]);
        let pace = Arc::new(FakePace::default());
        let flow = OpenCodeGoLogin::new(http.clone(), pace.clone(), store(&dir));
        let session = flow.start().await.unwrap();
        let states = finish(session.as_ref()).await;
        assert!(matches!(&states[0], LoginState::DeviceCode { user_code, verification_uri, .. }
            if user_code == "WXYZ" && verification_uri == "https://opencode.ai/device?code=WXYZ"));
        assert_eq!(states.last(), Some(&LoginState::Done { account: Some("me@x.y".into()) }));
        {
            let seen = http.seen.lock().unwrap();
            assert_eq!(seen[0].url, "https://opencode.ai/console/auth/device/code");
            assert_eq!(serde_json::from_slice::<JsonValue>(&seen[2].body).unwrap()["grant_type"], DEVICE_GRANT_TYPE);
        }
        assert_eq!(pace.waits.lock().unwrap().iter().map(Duration::as_secs).collect::<Vec<_>>(), [8]);
        let Probe::Present(saved) = store(&dir).load::<OpenCodeGoCredentials>().await else { panic!("stored") };
        assert_eq!((saved.org_id.as_deref(), saved.org_name.as_deref()), (Some("o1"), Some("Alpha")));
        assert_eq!(saved.expires_at, 8_000 + 3_600_000, "expiry counts from the grant");
    }

    fn stored(access: &str, refresh: &str, expires_at: u64) -> OpenCodeGoCredentials {
        OpenCodeGoCredentials {
            access_token: access.into(),
            refresh_token: refresh.into(),
            expires_at,
            account_id: Some("u1".into()),
            email: None,
            org_id: Some("o1".into()),
            org_name: Some("Alpha".into()),
        }
    }

    #[tokio::test]
    async fn refresh_keeps_the_pair_current_and_adopts_a_newer_one() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let file = store(&dir);
        file.save(&stored("A1", "R1", 1_000)).await.unwrap();
        let pace = Arc::new(FakePace::default());
        pace.now.store(2_000, std::sync::atomic::Ordering::SeqCst);
        let http = Scripted::new(&[(200, r#"{"access_token":"A2","refresh_token":"R2","expires_in":3600,"org_id":"o9"}"#)]);
        let auth = OpenCodeGoAuth::new(http.clone(), pace.clone(), file.clone());
        let fresh = auth.ensure_fresh(false).await.unwrap();
        assert_eq!((fresh.access_token.as_str(), fresh.org_id.as_deref(), fresh.org_name.as_deref()), ("A2", Some("o9"), Some("o9")));
        assert_eq!(fresh.expires_at, 3_602_000);
        // Not near expiry: no request is made (the script is empty).
        assert_eq!(auth.ensure_fresh(false).await.unwrap().access_token, "A2");
        // A dead grant after another process rotated the pair adopts the newer pair.
        let held = stored("A2", "R2", 1);
        let racing = Scripted::new(&[(400, r#"{"error":"invalid_grant"}"#)]);
        file.save(&stored("A3", "R3", 0)).await.unwrap();
        let other = OpenCodeGoAuth::new(racing, pace.clone(), file.clone());
        assert_eq!(other.refresh(held, true).await.unwrap().access_token, "A3");
        // A dead grant with nothing newer asks for a new sign-in.
        let dead = OpenCodeGoAuth::new(Scripted::new(&[(401, "")]), pace, file);
        let current = dead.stored().await.unwrap();
        assert!(matches!(dead.refresh(current, true).await, Err(RefreshError::Reauth(_))));
    }

    #[tokio::test]
    async fn concurrent_refreshes_post_the_refresh_token_once() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let file = store(&dir);
        file.save(&stored("A1", "R1", 1_000)).await.unwrap();
        let pace = Arc::new(FakePace::default());
        pace.now.store(2_000, std::sync::atomic::Ordering::SeqCst);
        let http = Scripted::new(&[(200, r#"{"access_token":"A2","refresh_token":"R2","expires_in":3600}"#)]);
        let auth = Arc::new(OpenCodeGoAuth::new(http.clone(), pace, file));
        let calls: Vec<_> = (0..4)
            .map(|_| {
                let auth = auth.clone();
                tokio::spawn(async move { auth.ensure_fresh(false).await })
            })
            .collect();
        for call in calls {
            assert_eq!(call.await.unwrap().unwrap().access_token, "A2");
        }
        assert_eq!(http.seen.lock().unwrap().len(), 1, "one refresh POST");
    }

    #[test]
    fn organizations_are_picked_by_id_or_name() {
        let orgs = json!([{"id": "b", "name": "N"}, {"id": "a", "name": "N"}, {"name": "no id"}]);
        assert_eq!(pick_organization(&orgs, None).unwrap().unwrap()["id"], "a");
        assert_eq!(pick_organization(&orgs, Some("b")).unwrap().unwrap()["id"], "b");
        assert!(pick_organization(&orgs, Some("zz")).is_err());
        assert!(pick_organization(&json!([]), None).unwrap().is_none());
    }

    #[test]
    fn organizations_sort_as_the_locale_does_not_by_bytes() {
        let orgs = json!([{"id": "1", "name": "Zed"}, {"id": "2", "name": "alpha"}]);
        assert_eq!(pick_organization(&orgs, None).unwrap().unwrap()["id"], "2");
    }
}
