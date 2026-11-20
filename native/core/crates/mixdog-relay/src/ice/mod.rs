//! ICE server issuance: the TURN REST credentials ([`turn`]) and the issuer the desktop leg's `ice-servers` request uses
//! (`createIceService` of `lib/ice-legs.mjs`).

pub mod frames;
pub mod turn;

use serde_json::{Value, json};

use crate::rate_limit::RateLimiter;
pub use turn::{
    IssuedCredential, TURN_CREDENTIAL_TTL_SECONDS, TURN_DEFAULT_PORT, TURN_DEFAULT_TLS_PORT, TURN_SECRET_MIN_BYTES, TurnConfig, TurnConfigError,
    ice_servers_for, issue_turn_credential, stun_urls, turn_config_from_env, turn_password, turn_urls, turn_user_id, verify_turn_credential,
};

/// Why an `ice-servers` request is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IceRefusal {
    NotPaired,
    RateLimited,
}

impl IceRefusal {
    /// The `error` field of the refusal and the `cause=` of its log line.
    pub fn name(self) -> &'static str {
        match self {
            Self::NotPaired => "not-paired",
            Self::RateLimited => "rate-limited",
        }
    }
}

/// What one successful issuance carries.
#[derive(Debug, Clone, PartialEq)]
pub struct IceIssue {
    pub servers: Value,
    pub ttl_seconds: i64,
    pub expires_at: i64,
    pub remaining_ms: i64,
}

/// The relay's issuer for one TURN configuration. A device may ask `config.issue_limit` times per credential lifetime.
pub struct IceService {
    config: TurnConfig,
    pub stun_urls: Vec<String>,
    pub limiter: RateLimiter,
}

impl IceService {
    pub fn new(config: TurnConfig) -> Self {
        let window_ms = config.ttl_seconds * 1000;
        let limiter = RateLimiter::new(usize::try_from(config.issue_limit).unwrap_or(usize::MAX), window_ms);
        Self { stun_urls: stun_urls(&config), config, limiter }
    }

    /// A credential for `device_id` at `now_ms`.
    pub fn issue(&self, device_id: &str, now_ms: i64) -> IceIssue {
        let user_id = turn_user_id(&self.config.secret, device_id);
        let issued = issue_turn_credential(&self.config.secret, &user_id, now_ms, self.config.ttl_seconds);
        IceIssue {
            servers: ice_servers_for(&self.config, &issued),
            ttl_seconds: issued.ttl_seconds,
            expires_at: issued.expires_at,
            remaining_ms: issued.remaining_ms,
        }
    }

    /// `{ type: 'ice-servers', requestId, ok: true, servers, ttlSeconds, expiresAt, remainingMs }`.
    pub fn issued_reply(request_id: &str, issue: &IceIssue) -> Value {
        json!({
            "type": "ice-servers", "requestId": request_id, "ok": true,
            "servers": issue.servers, "ttlSeconds": issue.ttl_seconds, "expiresAt": issue.expires_at, "remainingMs": issue.remaining_ms,
        })
    }

    /// `{ type: 'ice-servers', requestId, ok: false, error, stun, retryAfterMs? }`; `retry_after_ms` is set for a rate limit.
    pub fn refusal_reply(&self, request_id: &str, refusal: IceRefusal, retry_after_ms: Option<i64>) -> Value {
        let mut reply = json!({
            "type": "ice-servers", "requestId": request_id, "ok": false, "error": refusal.name(), "stun": self.stun_urls,
        });
        if let (Some(ms), Some(map)) = (retry_after_ms, reply.as_object_mut()) {
            map.insert("retryAfterMs".into(), json!(ms));
        }
        reply
    }
}
