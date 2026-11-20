//! APNs delivery (`native-push-apns.mjs`): token auth over HTTP/2 with the cached provider token.

use std::sync::Arc;

use serde_json::{Value, json};

use super::jwt::{ProviderTokenCache, apns_provider_token};
use super::keys::{ApnsConfig, js_string, truthy};
use super::{Clock, HttpRequest, HttpTransport, NOTIFICATION_TTL_SECONDS, Origins, PushMessage, SendResult, TransportError};
use crate::js;

pub struct ApnsSender {
    config: ApnsConfig,
    production: String,
    sandbox: String,
    transport: Arc<dyn HttpTransport>,
    clock: Clock,
    provider_token: ProviderTokenCache,
}

impl ApnsSender {
    pub fn new(config: ApnsConfig, transport: Arc<dyn HttpTransport>, origins: &Origins, clock: Clock) -> Self {
        Self {
            config,
            production: origins.apns_production.clone(),
            sandbox: origins.apns_sandbox.clone(),
            transport,
            clock,
            provider_token: ProviderTokenCache::default(),
        }
    }

    fn authorization(&self, now_ms: i64) -> String {
        let token = self.provider_token.get_or_mint(now_ms, || apns_provider_token(&self.config.key, &self.config.key_id, &self.config.team_id, now_ms));
        format!("bearer {token}")
    }

    /// Delivers one notification. An `Err` is a send that got no answer (a refused connection, a timeout).
    pub async fn send(&self, message: &PushMessage) -> Result<SendResult, String> {
        // The app reports its environment at registration (development builds are sandbox, TestFlight and the App Store
        // are production); APNS_ENVIRONMENT only decides for a subscription that did not say.
        let use_sandbox = message.sandbox.unwrap_or(self.config.sandbox_default);
        let origin = if use_sandbox { &self.sandbox } else { &self.production };
        let payload = json!({
            // Shown only if the notification service extension cannot decrypt `mx`; deliberately free of any session
            // content or language. No action category: whether an approval offers Allow is in the encrypted content, and
            // the phone's extension picks it from there.
            "aps": {
                "alert": { "title": "Mixdog", "body": "\u{1F514}" },
                "mutable-content": 1,
                "sound": "default",
            },
            "mx": message.mx,
        });
        let now = (self.clock)();
        let request = HttpRequest {
            url: format!("{origin}/3/device/{}", message.token),
            headers: vec![
                ("authorization".to_owned(), self.authorization(now)),
                ("apns-topic".to_owned(), self.config.topic.clone()),
                ("apns-push-type".to_owned(), "alert".to_owned()),
                ("apns-priority".to_owned(), "10".to_owned()),
                ("apns-expiration".to_owned(), (now.div_euclid(1000) + NOTIFICATION_TTL_SECONDS).to_string()),
                ("apns-collapse-id".to_owned(), message.collapse_key.clone()),
                ("content-type".to_owned(), "application/json".to_owned()),
            ],
            body: js::node_utf8(&js::wire(&payload)),
            http2_only: true,
        };
        let response = self.transport.post(request).await.map_err(|error| match error {
            TransportError::Timeout => "APNs request timed out".to_owned(),
            TransportError::Failed(text) => text,
        })?;
        if response.status == 200 {
            return Ok(SendResult { ok: true, status: 200, invalid: false, error: None });
        }
        let failure = js::parse_bytes(&response.body).ok().and_then(|body| body.get("reason").cloned()).unwrap_or(Value::Null);
        // 403 means the cached provider token was refused: mint a fresh one next time.
        if response.status == 403 {
            self.provider_token.discard();
        }
        let named = truthy(&failure);
        Ok(SendResult {
            ok: false,
            status: response.status,
            invalid: response.status == 410 || failure.as_str() == Some("Unregistered"),
            error: Some(if named { js_string(&failure) } else { format!("http {}", response.status) }),
        })
    }

    /// Drops the pooled connections; the next send reconnects.
    pub fn close(&self) {
        self.transport.close();
    }
}
