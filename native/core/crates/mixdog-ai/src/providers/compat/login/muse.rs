//! Muse Code sign-in: the OAuth device grant against Meta, then a one-time
//! exchange of the account token for the subscription Model API key. Meta
//! issues no expiry and rejects refresh grants: a 401 later means signing in
//! again, so there is no refresh path.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use std::time::SystemTime;
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
use crate::oauth::scrub::muse_excerpt;
use crate::oauth::scrub::muse_prefix;
use crate::oauth::start_session;
use crate::oauth::CredentialFile;
use crate::providers::compat::creds::MuseCodeCredentials;

pub const PROVIDER_ID: &str = "muse-code-oauth";
const CLIENT_ID: &str = "1031625952748946";
const DEVICE_AUTH_URL: &str = "https://auth.meta.com/oidc/device/authorization/";
const DEVICE_TOKEN_URL: &str = "https://auth.meta.com/oidc/device/token/";
const KEY_URL: &str = "https://api.meta.ai/muse-code/key";
const API_VERSION: &str = "1.0.0";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_INTERVAL_S: f64 = 5.0;
const MIN_INTERVAL_S: f64 = 1.0;
const TRANSIENT_STATUSES: [u16; 5] = [429, 500, 502, 503, 504];

fn headers(extra: Vec<(&'static str, String)>) -> Vec<(&'static str, String)> {
    let mut all = vec![("accept", "application/json".to_owned()), ("x-api-version", API_VERSION.to_owned())];
    all.extend(extra);
    all
}

fn form(params: &[(&str, &str)]) -> Vec<u8> {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(params)
        .finish()
        .into_bytes()
}

/// The device authorization response, validated.
#[derive(Clone, PartialEq, Debug)]
pub struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: Duration,
    expires_in: Option<Duration>,
}

fn non_empty<'a>(doc: &'a JsonValue, field: &str) -> &'a str {
    doc.get(field).and_then(JsonValue::as_str).filter(|s| !s.is_empty()).unwrap_or("")
}

fn device_authorization(reply: &Reply) -> Result<DeviceAuthorization, LoginFailure> {
    if !reply.ok() {
        return Err(failed(
            "device_auth",
            format!("device authorization {}: {}", reply.status, muse_prefix(&reply.text(), &[], 300)),
        ));
    }
    let doc = reply.json().unwrap_or(JsonValue::Null);
    let (device_code, user_code, uri) = (
        non_empty(&doc, "device_code"),
        non_empty(&doc, "user_code"),
        non_empty(&doc, "verification_uri"),
    );
    if device_code.is_empty() || user_code.is_empty() || uri.is_empty() {
        return Err(failed("validation", "device authorization response is missing required fields"));
    }
    let complete = non_empty(&doc, "verification_uri_complete");
    let seconds = |field: &str| doc.get(field).and_then(JsonValue::as_f64);
    Ok(DeviceAuthorization {
        device_code: device_code.to_owned(),
        user_code: user_code.to_owned(),
        verification_uri: if complete.is_empty() { uri } else { complete }.to_owned(),
        interval: Duration::from_secs_f64(seconds("interval").unwrap_or(DEFAULT_INTERVAL_S).max(MIN_INTERVAL_S)),
        // A supplied expiry, even zero, is a deadline; only an absent one means none.
        expires_in: seconds("expires_in").map(|s| Duration::from_secs_f64(s.max(0.0))),
    })
}

/// `Retry-After` as delta-seconds; absent or unusable gives `None`.
fn retry_after(reply: &Reply) -> Option<Duration> {
    let seconds = mixdog_js::string_to_number(reply.header("retry-after").filter(|raw| !raw.is_empty())?);
    (seconds.is_finite() && seconds >= 0.0).then(|| Duration::from_secs_f64(seconds))
}

fn classify_poll(reply: &Reply, device_code: &str) -> Poll<String> {
    let doc = reply.json().unwrap_or(JsonValue::Null);
    let error = doc.get("error").and_then(JsonValue::as_str).unwrap_or("");
    let token = doc.get("access_token").and_then(JsonValue::as_str).unwrap_or("");
    if reply.ok() && error.is_empty() && !token.is_empty() {
        return Poll::Granted(token.to_owned());
    }
    let known = ["authorization_pending", "slow_down", "expired_token", "access_denied"].contains(&error);
    let detail = || {
        let description = doc.get("error_description").and_then(JsonValue::as_str).unwrap_or("");
        let joined = [error, description].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(": ");
        let shown = if joined.is_empty() { reply.text() } else { joined };
        muse_prefix(&shown, &[device_code], 300)
    };
    if !known && TRANSIENT_STATUSES.contains(&reply.status) {
        return Poll::Transient {
            rate_limited: reply.status == 429,
            retry_after: retry_after(reply),
            fault: failed("device_token", format!("device token {}: {}", reply.status, detail())),
        };
    }
    match error {
        "authorization_pending" => Poll::Pending,
        "slow_down" => Poll::SlowDown,
        "expired_token" => Poll::Expired,
        "access_denied" => Poll::Denied,
        _ => Poll::Fatal(failed(
            if error.is_empty() { "device_token" } else { error },
            format!("device token {}: {}", reply.status, detail()),
        )),
    }
}

/// A usage meter: absent or null, or an object whose percent and duration are
/// numbers when present and whose reset is a string or number when present.
fn is_usage_window(window: &JsonValue) -> bool {
    if window.is_null() {
        return true;
    }
    let Some(window) = window.as_object() else {
        return false;
    };
    let numeric = |field: &str| window.get(field).is_none_or(JsonValue::is_number);
    numeric("used_percent")
        && numeric("window_duration_mins")
        && window.get("resets_at").is_none_or(|v| v.is_string() || v.is_number())
}

/// The key response checked field by field: a wrong type is refused rather
/// than stringified.
fn validate_key_payload(doc: &JsonValue) -> Result<(), LoginFailure> {
    let bad = |field: &str| failed("validation", format!("key response has an invalid {field}"));
    let Some(object) = doc.as_object() else {
        return Err(bad("body"));
    };
    type Fits = fn(&JsonValue) -> bool;
    let kinds: [(&str, Fits); 9] = [
        ("api_key", JsonValue::is_string),
        ("user_id", JsonValue::is_string),
        ("user_email", JsonValue::is_string),
        ("is_subs_active", JsonValue::is_boolean),
        ("require_payment", JsonValue::is_boolean),
        ("action_url", |v| v.is_string() || v.is_null()),
        ("require_payment_action_url", JsonValue::is_string),
        ("subs_tier_id", |v| v.is_string() || v.is_null()),
        ("subs_tier_name", |v| v.is_string() || v.is_null()),
    ];
    for (field, fits) in kinds {
        if object.get(field).is_some_and(|v| !fits(v)) {
            return Err(bad(field));
        }
    }
    if let Some(usage) = object.get("subs_usage").filter(|v| !v.is_null()) {
        let Some(usage) = usage.as_object() else {
            return Err(bad("subs_usage"));
        };
        for window in ["window", "weekly"] {
            if !usage.get(window).is_none_or(is_usage_window) {
                return Err(bad(&format!("subs_usage.{window}")));
            }
        }
    }
    Ok(())
}

/// The stored credential from a key response.
pub fn credentials_from_key_response(doc: &JsonValue, access_token: &str) -> Result<MuseCodeCredentials, LoginFailure> {
    validate_key_payload(doc)?;
    let text = |field: &str| doc.get(field).and_then(JsonValue::as_str).map_or("", str::trim);
    if doc.get("is_subs_active") == Some(&JsonValue::Bool(false)) {
        return Err(failed("invalid_grant", "Muse Code subscription inactive"));
    }
    let api_key = text("api_key");
    if api_key.is_empty() {
        let action = [text("action_url"), text("require_payment_action_url")]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("");
        if doc.get("require_payment") == Some(&JsonValue::Bool(true)) || !action.is_empty() {
            let suffix = if action.is_empty() { String::new() } else { format!(": {action}") };
            return Err(failed("payment_required", format!("Muse Code subscription payment required{suffix}")));
        }
        return Err(failed("validation", "key response is missing api_key"));
    }
    let email = text("user_email").to_lowercase();
    let account_id = Some(text("user_id")).filter(|s| !s.is_empty()).unwrap_or(&email).to_owned();
    if account_id.is_empty() {
        return Err(failed("validation", "key response is missing a stable account identity"));
    }
    Ok(MuseCodeCredentials {
        access_token: access_token.to_owned(),
        api_key: api_key.to_owned(),
        account_id: Some(account_id),
        email: Some(email).filter(|e| !e.is_empty()),
    })
}

/// Mints the Model API key for a fresh account token.
async fn mint_key(http: &Http, access_token: &str) -> Result<MuseCodeCredentials, LoginFailure> {
    let reply = call(
        http.as_ref(),
        "POST",
        KEY_URL,
        headers(vec![
            ("authorization", format!("Bearer {access_token}")),
            ("content-type", "application/json".to_owned()),
        ]),
        br#"{"onboard":true}"#.to_vec(),
    )
    .await?;
    if !reply.ok() {
        let detail = muse_excerpt(&reply.text(), &[access_token], 500);
        return Err(failed("token_exchange", format!("key request {}: {detail}", reply.status)));
    }
    let doc = reply
        .json()
        .ok_or_else(|| failed("validation", "key response was not valid JSON"))?;
    credentials_from_key_response(&doc, access_token)
}

pub struct MuseCodeLogin {
    target: LoginTarget,
    http: Http,
    pace: Arc<dyn Pace>,
    file: CredentialFile,
    running: Arc<AtomicBool>,
}

impl MuseCodeLogin {
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
impl LoginFlow for MuseCodeLogin {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let guard = FlowGuard::claim(&self.running).ok_or(LoginError::Busy)?;
        let reply = call(
            self.http.as_ref(),
            "POST",
            DEVICE_AUTH_URL,
            headers(vec![("content-type", "application/x-www-form-urlencoded".to_owned())]),
            form(&[("client_id", CLIENT_ID)]),
        )
        .await
        .map_err(LoginError::Failed)?;
        let device = device_authorization(&reply).map_err(LoginError::Failed)?;
        let now_ms = self.pace.now_ms();
        let expires_at = device
            .expires_in
            .map(|d| UNIX_EPOCH + Duration::from_millis(now_ms) + d)
            .filter(|at| *at > SystemTime::UNIX_EPOCH);
        let first = LoginState::DeviceCode {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
            expires_at,
        };
        let (http, pace, file) = (self.http.clone(), self.pace.clone(), self.file.clone());
        Ok(start_session(guard, first, false, move |ctx, _| async move {
            ctx.set(LoginState::Waiting);
            let schedule = Schedule {
                interval: device.interval,
                deadline_ms: device.expires_in.map(|d| now_ms + d.as_millis() as u64),
                back_off_on_network: true,
                ..Schedule::default()
            };
            let token = device::run(pace.as_ref(), schedule, || async {
                let polled = call(
                    http.as_ref(),
                    "POST",
                    DEVICE_TOKEN_URL,
                    headers(vec![("content-type", "application/x-www-form-urlencoded".to_owned())]),
                    form(&[
                        ("client_id", CLIENT_ID),
                        ("device_code", &device.device_code),
                        ("grant_type", DEVICE_GRANT_TYPE),
                    ]),
                )
                .await;
                match polled {
                    Ok(reply) => classify_poll(&reply, &device.device_code),
                    Err(fault) => Poll::Network { fault },
                }
            })
            .await?;
            let credentials = mint_key(&http, &token).await?;
            file.save(&credentials)
                .await
                .map_err(|err| failed("store", err.to_string()))?;
            Ok(credentials.account_id)
        }))
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
    use crate::oauth::Probe;

    fn store(dir: &tempfile::TempDir) -> CredentialFile {
        let tokens = mixdog_rt::testing::tokens();
        CredentialFile::new(
            dir.path().join("muse-code-oauth.json"),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        )
    }

    const DEVICE: &str = r#"{"device_code":"DC","user_code":"ABCD","verification_uri":"https://meta/v","verification_uri_complete":"https://meta/v?c=ABCD","interval":2,"expires_in":600}"#;

    #[tokio::test]
    async fn a_device_grant_ends_with_the_minted_key_stored() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let http = Scripted::new(&[
            (200, DEVICE),
            (400, r#"{"error":"authorization_pending"}"#),
            (200, r#"{"access_token":"AT"}"#),
            (200, r#"{"api_key":" K1 ","user_id":"u-1","user_email":"A@B.C","is_subs_active":true}"#),
        ]);
        let pace = Arc::new(FakePace::default());
        let flow = MuseCodeLogin::new(http.clone(), pace.clone(), store(&dir));
        let session = flow.start().await.unwrap();
        assert!(matches!(flow.start().await, Err(LoginError::Busy)));
        let states = finish(session.as_ref()).await;
        assert!(matches!(&states[0], LoginState::DeviceCode { user_code, verification_uri, .. }
            if user_code == "ABCD" && verification_uri == "https://meta/v?c=ABCD"));
        assert_eq!(states.last(), Some(&LoginState::Done { account: Some("u-1".into()) }));
        {
            let seen = http.seen.lock().unwrap();
            assert_eq!(
                String::from_utf8_lossy(&seen[2].body),
                "client_id=1031625952748946&device_code=DC&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
            );
            assert_eq!(seen[3].body, br#"{"onboard":true}"#);
            assert!(seen[3].headers.contains(&("authorization".into(), "Bearer AT".into())));
        }
        assert_eq!(pace.waits.lock().unwrap().len(), 1, "one wait, after the pending answer");
        let Probe::Present(saved) = store(&dir).load::<MuseCodeCredentials>().await else { panic!("stored") };
        assert_eq!(
            saved,
            MuseCodeCredentials {
                access_token: "AT".into(),
                api_key: "K1".into(),
                account_id: Some("u-1".into()),
                email: Some("a@b.c".into()),
            }
        );
        // The flow is free again.
        let again = MuseCodeLogin::new(Scripted::new(&[(500, "")]), pace, store(&dir));
        assert!(matches!(again.start().await, Err(LoginError::Failed(_))));
    }

    #[tokio::test]
    async fn a_denied_grant_fails_the_login() {
        mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let http = Scripted::new(&[(200, DEVICE), (400, r#"{"error":"access_denied"}"#)]);
        let flow = MuseCodeLogin::new(http, Arc::new(FakePace::default()), store(&dir));
        let session = flow.start().await.unwrap();
        assert_eq!(finish(session.as_ref()).await.last(), Some(&LoginState::Failed(LoginFailure::Denied)));
        assert!(matches!(store(&dir).load::<MuseCodeCredentials>().await, Probe::Absent));
    }

    #[test]
    fn key_responses_are_validated() {
        let ok = |doc: JsonValue| credentials_from_key_response(&doc, "AT");
        assert_eq!(ok(json!({"api_key": "k", "user_email": "X@Y.Z"})).unwrap().account_id.as_deref(), Some("x@y.z"));
        let code = |doc: JsonValue| match ok(doc) {
            Err(LoginFailure::Failed { code, .. }) => code,
            other => panic!("{other:?}"),
        };
        assert_eq!(code(json!({"api_key": "k", "is_subs_active": false})), "invalid_grant");
        assert_eq!(code(json!({"require_payment": true, "action_url": "https://pay"})), "payment_required");
        assert_eq!(code(json!({"user_id": "u"})), "validation");
        assert_eq!(code(json!({"api_key": 7})), "validation");
        let usage = |usage: JsonValue| ok(json!({"api_key": "k", "user_id": "u", "subs_usage": usage}));
        assert!(usage(json!({"window": {"used_percent": 3, "resets_at": "t"}, "weekly": null})).is_ok());
        assert!(usage(json!({"window": {"used_percent": "3"}})).is_err());
        assert!(usage(json!({"weekly": {"resets_at": true}})).is_err());
        assert!(usage(json!({"weekly": [1]})).is_err());
        assert!(usage(json!([1])).is_err());
        assert_eq!(code(json!({"api_key": "k"})), "validation", "no stable identity");
        assert_eq!(code(json!([1])), "validation");
    }
}
