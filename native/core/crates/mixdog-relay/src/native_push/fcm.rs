//! FCM (HTTP v1) delivery (`native-push-fcm.mjs`): the cached OAuth access token and the data-only message.

use std::sync::Arc;

use serde_json::{Value, json};

use super::jwt::{AccessTokenCache, fcm_assertion};
use super::keys::{FcmConfig, js_string, truthy};
use super::{Clock, HttpRequest, HttpTransport, NOTIFICATION_TTL_SECONDS, PushMessage, SendResult, TransportError};
use crate::js;

/// `AbortSignal.timeout` aborting a `fetch`.
const TIMED_OUT: &str = "The operation was aborted due to timeout";

pub struct FcmSender {
    config: FcmConfig,
    origin: String,
    transport: Arc<dyn HttpTransport>,
    clock: Clock,
    access_token: AccessTokenCache,
}

fn fetch_error(error: TransportError) -> String {
    match error {
        TransportError::Timeout => TIMED_OUT.to_owned(),
        TransportError::Failed(text) => text,
    }
}

/// `Number(value) || 3600`: the lifetime in seconds an OAuth response names.
fn lifetime_seconds(expires_in: Option<&Value>) -> f64 {
    let number = match expires_in {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => mixdog_js::string_to_number(text),
        Some(Value::Bool(true)) => 1.0,
        Some(Value::Null | Value::Bool(false)) | None => 0.0,
        Some(_) => f64::NAN,
    };
    if number == 0.0 || number.is_nan() { 3600.0 } else { number }
}

impl FcmSender {
    pub fn new(config: FcmConfig, transport: Arc<dyn HttpTransport>, origin: String, clock: Clock) -> Self {
        Self { config, origin, transport, clock, access_token: AccessTokenCache::default() }
    }

    async fn access_token(&self) -> Result<String, String> {
        let now = (self.clock)();
        if let Some(token) = self.access_token.get(now) {
            return Ok(token);
        }
        let assertion = fcm_assertion(&self.config.key, &self.config.client_email, &self.config.token_uri, now)?;
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
            .append_pair("assertion", &assertion)
            .finish();
        let response = self
            .transport
            .post(HttpRequest {
                url: self.config.token_uri.clone(),
                headers: vec![("content-type".to_owned(), "application/x-www-form-urlencoded".to_owned())],
                body: body.into_bytes(),
                http2_only: false,
            })
            .await
            .map_err(fetch_error)?;
        let parsed = js::parse_bytes(&response.body).ok();
        let token = parsed.as_ref().and_then(|body| body.get("access_token")).filter(|token| truthy(token));
        let (true, Some(token)) = ((200..300).contains(&response.status), token) else {
            return Err(format!("FCM token exchange failed ({})", response.status));
        };
        let token = js_string(token);
        let lifetime = lifetime_seconds(parsed.as_ref().and_then(|body| body.get("expires_in")));
        // `now()` is read again after the exchange, as Node reads it when it stores the token.
        self.access_token.store(&token, (self.clock)() + (lifetime * 1000.0) as i64);
        Ok(token)
    }

    /// Delivers one notification. An `Err` is a send that got no answer or no access token.
    pub async fn send(&self, message: &PushMessage) -> Result<SendResult, String> {
        let access_token = self.access_token().await?;
        let body = json!({
            "message": {
                "token": message.token,
                // Data-only: the app builds the visible notification after decrypting.
                "data": { "mx": message.mx, "reason": message.reason },
                "android": { "priority": "HIGH", "collapse_key": message.collapse_key, "ttl": format!("{NOTIFICATION_TTL_SECONDS}s") },
            },
        });
        let response = self
            .transport
            .post(HttpRequest {
                url: format!("{}/v1/projects/{}/messages:send", self.origin, self.config.project_id),
                headers: vec![
                    ("authorization".to_owned(), format!("Bearer {access_token}")),
                    ("content-type".to_owned(), "application/json".to_owned()),
                ],
                body: js::node_utf8(&js::wire(&body)),
                http2_only: false,
            })
            .await
            .map_err(fetch_error)?;
        if (200..300).contains(&response.status) {
            return Ok(SendResult { ok: true, status: response.status, invalid: false, error: None });
        }
        if response.status == 401 {
            self.access_token.discard();
        }
        let error = js::parse_bytes(&response.body).ok().and_then(|body| body.get("error").cloned()).unwrap_or(Value::Null);
        let status_name = error.get("status").cloned().unwrap_or(Value::Null);
        let listed_unregistered = error.get("details").and_then(Value::as_array).is_some_and(|details| {
            details.iter().any(|detail| detail.get("errorCode").and_then(Value::as_str) == Some("UNREGISTERED"))
        });
        let unregistered = response.status == 404 && (status_name.as_str() == Some("NOT_FOUND") || listed_unregistered);
        Ok(SendResult {
            ok: false,
            status: response.status,
            invalid: unregistered,
            error: Some(if truthy(&status_name) { js_string(&status_name) } else { format!("http {}", response.status) }),
        })
    }
}
