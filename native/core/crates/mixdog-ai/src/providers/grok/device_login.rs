//! The `grok-oauth` RFC 8628 device-code sign-in for a host with no browser (`grok-oauth-login.mjs`
//! `beginDeviceLogin`, xAI's `grok login --device-auth`): the user opens the verification URL on any device and
//! confirms the code while this host polls the token endpoint, so no loopback listener, port forward or pasted redirect
//! is involved. An issuer with no device flow (404) leaves the sign-in to the browser flow.

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
use url::Url;

use super::auth::CLIENT_ID;
use super::auth::SCOPE;
use super::auth::StoredTokens;
use super::auth::email_from_jwts;
use super::auth::identity_of;
use super::auth::saved_document;
use super::auth::trusted_xai_endpoint;
use crate::oauth::CredentialFile;
use crate::oauth::FlowGuard;
use crate::oauth::Pace;
use crate::oauth::Poll;
use crate::oauth::Schedule;
use crate::oauth::device;
use crate::oauth::http::Reply;
use crate::oauth::http::failed;
use crate::oauth::http::try_call_under;
use crate::oauth::scrub::scrubbed_prefix;
use crate::oauth::start_session;
use crate::transport::HttpSend;
use crate::transport::deadlines::TOKEN_EXCHANGE;

const PROVIDER_ID: &str = "grok-oauth";
const DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// The path the issuer's discovery document advertises as its device authorization endpoint; the token endpoint is the
/// discovered one.
const DEVICE_CODE_PATH: &str = "/oauth2/device/code";
const DEFAULT_INTERVAL_S: i64 = 5;
/// The Grok CLI keeps polling for at least ten minutes whatever `expires_in` says.
const MIN_EXPIRY_S: i64 = 600;
const EXCERPT: usize = 300;

fn form(params: &[(&str, &str)]) -> Vec<u8> {
    url::form_urlencoded::Serializer::new(String::new()).extend_pairs(params).finish().into_bytes()
}

/// The vendor reads these as typed integers: a string or a fraction is a malformed response.
fn integer_field(value: &JsonValue, field: &str) -> Result<i64, LoginFailure> {
    value
        .as_f64()
        .filter(|number| number.fract() == 0.0 && number.abs() < 9e15)
        .map(|number| number as i64)
        .ok_or_else(|| failed("device_auth", format!("[grok-oauth] device authorization {field} must be an integer")))
}

/// The Grok CLI's verification-URI rules (`validate_verification_uri`): a string without ASCII control characters that
/// parses as a URL and is https, or http only for localhost / 127.0.0.1.
fn verification_uri(value: &JsonValue, field: &str) -> Result<String, LoginFailure> {
    let Some(text) = value.as_str() else {
        return Err(failed("device_auth", format!("[grok-oauth] device authorization {field} must be a string")));
    };
    let invalid = || failed("device_auth", "[grok-oauth] device authorization returned an invalid verification URI");
    if text.chars().any(|c| u32::from(c) < 0x20 || u32::from(c) == 0x7f) {
        return Err(invalid());
    }
    let parsed = Url::parse(text).map_err(|_| invalid())?;
    let loopback = parsed.scheme() == "http" && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
    if parsed.scheme() != "https" && !loopback {
        return Err(failed("device_auth", "[grok-oauth] device authorization returned an unsupported verification URI scheme"));
    }
    Ok(text.to_owned())
}

#[derive(Debug, PartialEq)]
struct Device {
    device_code: String,
    user_code: String,
    verification_url: String,
    interval: Duration,
    expires_in: Duration,
}

/// `requestDeviceCode`'s validation of the issuer's answer.
fn device_of(reply: &Reply) -> Result<Device, LoginFailure> {
    let body = reply.json().unwrap_or(JsonValue::Null);
    let device_code = body.get("device_code").and_then(JsonValue::as_str).unwrap_or_default();
    let user_code = body.get("user_code").and_then(JsonValue::as_str).unwrap_or_default();
    let safe = !user_code.is_empty() && user_code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if device_code.is_empty() || !safe {
        return Err(failed("device_auth", "[grok-oauth] device authorization response is missing or has invalid required fields"));
    }
    // Both addresses are checked on their own: an invalid one fails the login rather than yielding to the other. The
    // complete one (code pre-filled) wins.
    let plain = verification_uri(body.get("verification_uri").unwrap_or(&JsonValue::Null), "verification_uri")?;
    let verification_url = match body.get("verification_uri_complete").filter(|v| !v.is_null()) {
        None => plain,
        Some(complete) => verification_uri(complete, "verification_uri_complete")?,
    };
    // 5 s only when the interval is omitted; zero or a negative value clamps to one second.
    let interval = match body.get("interval").filter(|v| !v.is_null()) {
        None => DEFAULT_INTERVAL_S,
        Some(value) => integer_field(value, "interval")?,
    }
    .max(1);
    let expires_in = integer_field(body.get("expires_in").unwrap_or(&JsonValue::Null), "expires_in")?.max(MIN_EXPIRY_S);
    Ok(Device {
        device_code: device_code.to_owned(),
        user_code: user_code.to_owned(),
        verification_url,
        interval: Duration::from_secs(interval as u64),
        expires_in: Duration::from_secs(expires_in as u64),
    })
}

/// One poll of the token endpoint: the grant, or the answer that keeps the poll going (`pending`, `slow_down`), or
/// the one that ends the login. Only those two keep it going.
fn classify_poll(reply: &Reply) -> Poll<JsonValue> {
    let text = reply.text();
    let json: Option<JsonValue> = serde_json::from_str(&text).ok();
    if reply.ok()
        && let Some(grant) = json.as_ref().filter(|j| j.get("access_token").and_then(JsonValue::as_str).is_some_and(|t| !t.is_empty()))
    {
        return Poll::Granted(grant.clone());
    }
    let error = json.as_ref().and_then(|j| j.get("error")).and_then(JsonValue::as_str).unwrap_or_default();
    match error {
        "slow_down" => Poll::SlowDown,
        "access_denied" => Poll::Denied,
        "expired_token" => Poll::Expired,
        "authorization_pending" => Poll::Pending,
        _ => {
            let shown = if error.is_empty() { scrubbed_prefix(&text, &[], EXCERPT) } else { error.to_owned() };
            Poll::Fatal(failed("device_token", format!("[grok-oauth] device token {}: {shown}", reply.status)))
        }
    }
}

/// `tokensFromGrant`: the stored tokens a granted device code yields.
fn tokens_of(grant: &JsonValue, token_endpoint: &str, now_ms: u64) -> Result<StoredTokens, LoginFailure> {
    let text = |key: &str| grant.get(key).and_then(JsonValue::as_str).filter(|s| !s.is_empty()).unwrap_or_default();
    let (access, refresh) = (text("access_token"), text("refresh_token"));
    if access.is_empty() || refresh.is_empty() {
        return Err(failed("token_exchange", "[grok-oauth] token exchange response missing access_token or refresh_token"));
    }
    let identity = identity_of(access);
    let first = |own: &str, claimed: String| if own.is_empty() { claimed } else { own.to_owned() };
    Ok(StoredTokens {
        access_token: access.to_owned(),
        refresh_token: refresh.to_owned(),
        expires_at: match grant.get("expires_in").and_then(JsonValue::as_f64) {
            Some(seconds) => now_ms + (seconds * 1000.0) as u64,
            None => grant.get("expires_at").and_then(JsonValue::as_u64).unwrap_or(0),
        },
        token_endpoint: token_endpoint.to_owned(),
        user_id: identity.user_id,
        principal_type: first(text("principal_type"), identity.principal_type),
        principal_id: first(text("principal_id"), identity.principal_id),
        email: email_from_jwts(&[text("id_token"), access]).unwrap_or_default(),
    })
}

pub struct GrokDeviceLogin {
    target: LoginTarget,
    http: Arc<dyn HttpSend>,
    file: CredentialFile,
    pace: Arc<dyn Pace>,
    /// The discovered token endpoint; the device code is requested beside it.
    token_endpoint: Url,
    /// Where the sign-in goes when the issuer has no device flow.
    browser: Arc<dyn LoginFlow>,
    running: Arc<AtomicBool>,
}

impl GrokDeviceLogin {
    pub fn new(
        http: Arc<dyn HttpSend>,
        file: CredentialFile,
        pace: Arc<dyn Pace>,
        token_endpoint: &str,
        browser: Arc<dyn LoginFlow>,
    ) -> Result<Self, mixdog_core_api::domain::provider::ProviderError> {
        Ok(Self {
            target: LoginTarget::Provider(ProviderId::from(PROVIDER_ID)),
            http,
            file,
            pace,
            token_endpoint: trusted_xai_endpoint(token_endpoint)?,
            browser,
            running: Arc::new(AtomicBool::new(false)),
        })
    }
}

#[async_trait]
impl LoginFlow for GrokDeviceLogin {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let guard = FlowGuard::claim(&self.running).ok_or(LoginError::Busy)?;
        let device_url = self.token_endpoint.join(DEVICE_CODE_PATH).map_err(|error| LoginError::Failed(failed("device_auth", error.to_string())))?;
        let started = try_call_under(
            self.http.as_ref(),
            TOKEN_EXCHANGE,
            "POST",
            device_url.as_str(),
            vec![("Accept", "application/json".to_owned()), ("Content-Type", "application/x-www-form-urlencoded".to_owned())],
            form(&[("client_id", CLIENT_ID), ("scope", SCOPE)]),
        )
        .await
        .map_err(|error| LoginError::Failed(failed("transport", error.message)))?;
        if started.status == 404 {
            // The issuer has no device flow, as the Grok CLI reads it: the loopback login takes over.
            drop(guard);
            return self.browser.start().await;
        }
        if !started.ok() {
            return Err(LoginError::Failed(failed(
                "device_auth",
                format!("[grok-oauth] device authorization {}: {}", started.status, scrubbed_prefix(&started.text(), &[], EXCERPT)),
            )));
        }
        let device = device_of(&started).map_err(LoginError::Failed)?;
        let now_ms = self.pace.now_ms();
        let first = LoginState::DeviceCode {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_url.clone(),
            expires_at: Some(UNIX_EPOCH + Duration::from_millis(now_ms) + device.expires_in),
        };
        let (http, file, pace, endpoint) = (self.http.clone(), self.file.clone(), self.pace.clone(), self.token_endpoint.to_string());
        Ok(start_session(guard, first, false, move |ctx, _| async move {
            ctx.set(LoginState::Waiting);
            // A poll straight after the code was issued only answers authorization_pending: the first one waits.
            let schedule = Schedule {
                interval: device.interval,
                deadline_ms: Some(now_ms + device.expires_in.as_millis() as u64),
                wait_first: true,
                ..Schedule::default()
            };
            let grant = device::run(pace.as_ref(), schedule, || async {
                let polled = try_call_under(
                    http.as_ref(),
                    TOKEN_EXCHANGE,
                    "POST",
                    &endpoint,
                    vec![("Accept", "application/json".to_owned()), ("Content-Type", "application/x-www-form-urlencoded".to_owned())],
                    form(&[("grant_type", DEVICE_GRANT_TYPE), ("device_code", &device.device_code), ("client_id", CLIENT_ID)]),
                )
                .await;
                match polled {
                    Ok(reply) => classify_poll(&reply),
                    // As in the Grok CLI, a transport failure ends the login at once.
                    Err(error) => Poll::Fatal(failed(
                        "device_token",
                        format!("[grok-oauth] device token request failed: {}", scrubbed_prefix(&error.message, &[], EXCERPT)),
                    )),
                }
            })
            .await?;
            let tokens = tokens_of(&grant, &endpoint, pace.now_ms())?;
            file.keep(&[&tokens.access_token, &tokens.refresh_token]);
            file.replace(saved_document(&tokens)).await.map_err(|_| failed("storage", "the tokens could not be stored"))?;
            Ok((!tokens.email.is_empty()).then_some(tokens.email))
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::CredentialIo;
    use crate::oauth::http::testing::Scripted;
    use crate::oauth::http::testing::finish;
    use crate::oauth::pace::FakePace;

    struct Browser;

    #[async_trait]
    impl LoginFlow for Browser {
        fn target(&self) -> &LoginTarget {
            unreachable!("the target of the device flow is read")
        }
        async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
            Err(LoginError::Busy)
        }
    }

    fn flow(http: Arc<Scripted>, dir: &tempfile::TempDir) -> GrokDeviceLogin {
        let tokens = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(dir.path().join("grok-oauth.json"), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
        GrokDeviceLogin::new(http, file, Arc::new(FakePace::default()), "https://auth.x.ai/oauth2/token", Arc::new(Browser)).unwrap()
    }

    const STARTED: &str = r#"{"device_code":"dc-1","user_code":"AB-12","verification_uri":"https://accounts.x.ai/device","verification_uri_complete":"https://accounts.x.ai/device?c=AB-12","interval":1,"expires_in":60}"#;

    #[tokio::test]
    async fn the_code_is_shown_polled_with_the_device_grant_and_saved() {
        let dir = tempfile::tempdir().unwrap();
        let http = Scripted::new(&[
            (200, STARTED),
            (400, r#"{"error":"authorization_pending"}"#),
            (400, r#"{"error":"slow_down"}"#),
            (200, r#"{"access_token":"a.b.c","refresh_token":"r","expires_in":3600}"#),
        ]);
        let session = flow(http.clone(), &dir).start().await.expect("a device flow");
        let states = finish(session.as_ref()).await;
        assert!(matches!(
            states.first(),
            Some(LoginState::DeviceCode { user_code, verification_uri, .. })
                if user_code == "AB-12" && verification_uri == "https://accounts.x.ai/device?c=AB-12"
        ));
        assert!(matches!(states.last(), Some(LoginState::Done { .. })), "{states:?}");
        let seen = http.seen.lock().unwrap();
        assert_eq!(seen[0].url, "https://auth.x.ai/oauth2/device/code");
        let poll = String::from_utf8_lossy(&seen[1].body).into_owned();
        assert!(poll.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"), "{poll}");
        assert!(poll.contains("device_code=dc-1"), "{poll}");
        assert!(dir.path().join("grok-oauth.json").exists());
    }

    #[tokio::test]
    async fn an_issuer_without_a_device_flow_leaves_the_sign_in_to_the_browser_flow() {
        let dir = tempfile::tempdir().unwrap();
        let outcome = flow(Scripted::new(&[(404, "")]), &dir).start().await;
        assert!(matches!(outcome, Err(LoginError::Busy)));
    }

    #[tokio::test]
    async fn only_pending_and_slow_down_keep_the_poll_going() {
        let dir = tempfile::tempdir().unwrap();
        let denied = flow(Scripted::new(&[(200, STARTED), (400, r#"{"error":"access_denied"}"#)]), &dir).start().await.unwrap();
        assert_eq!(finish(denied.as_ref()).await.last(), Some(&LoginState::Failed(LoginFailure::Denied)));
        let expired = flow(Scripted::new(&[(200, STARTED), (400, r#"{"error":"expired_token"}"#)]), &dir).start().await.unwrap();
        assert_eq!(finish(expired.as_ref()).await.last(), Some(&LoginState::Failed(LoginFailure::Expired)));
        let other = flow(Scripted::new(&[(200, STARTED), (500, r#"{"error":"server_error"}"#)]), &dir).start().await.unwrap();
        assert!(matches!(
            finish(other.as_ref()).await.last(),
            Some(LoginState::Failed(LoginFailure::Failed { message, .. })) if message == "[grok-oauth] device token 500: server_error"
        ));
    }

    #[test]
    fn the_issuers_answer_is_held_to_the_grok_clis_rules() {
        let reply = |body: &str| Reply { status: 200, headers: Vec::new(), body: body.as_bytes().to_vec() };
        let device = device_of(&reply(r#"{"device_code":"d","user_code":"A-1","verification_uri":"https://x.ai/d","expires_in":5,"interval":0}"#)).unwrap();
        // Zero clamps the interval to one second; a short expiry is raised to ten minutes.
        assert_eq!((device.interval, device.expires_in), (Duration::from_secs(1), Duration::from_secs(600)));
        let omitted = device_of(&reply(r#"{"device_code":"d","user_code":"A-1","verification_uri":"https://x.ai/d","expires_in":900}"#)).unwrap();
        assert_eq!(omitted.interval, Duration::from_secs(5));
        for bad in [
            r#"{"device_code":"d","user_code":"A 1","verification_uri":"https://x.ai/d","expires_in":9}"#,
            r#"{"device_code":"d","user_code":"A1","verification_uri":"ftp://x.ai/d","expires_in":9}"#,
            r#"{"device_code":"d","user_code":"A1","verification_uri":"http://evil.test/d","expires_in":9}"#,
            r#"{"device_code":"d","user_code":"A1","verification_uri":"https://x.ai/d","expires_in":"9"}"#,
            r#"{"device_code":"d","user_code":"A1","verification_uri":"https://x.ai/d","expires_in":9,"interval":1.5}"#,
        ] {
            assert!(device_of(&reply(bad)).is_err(), "{bad}");
        }
        let local = device_of(&reply(r#"{"device_code":"d","user_code":"A1","verification_uri":"http://localhost:9/d","expires_in":9}"#));
        assert!(local.is_ok(), "http is allowed for localhost only");
    }
}
