//! The one error-kind classification (PW §3.2) as a pure function of typed
//! facts. An adapter gathers the facts from the status, headers and parsed
//! body of a failed response, calls [`kind_of`] once and stores the kind in
//! the [`ProviderError`](mixdog_core_api::domain::provider::ProviderError).
//! Message text is read only where `providerErrorKind` reads it: for an error no
//! typed code decides (see [`wording_kind`] and [`Facts::text`]).

use std::sync::LazyLock;
use std::time::Duration;

use regex::RegexSet;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::QuotaScope;
use mixdog_core_api::domain::provider::TransportFault;

/// OpenRouter's in-flight budget code, the one 402 that is not billing.
pub const OPENROUTER_IN_FLIGHT_BUDGET: &str = "openrouter_in_flight_budget";

/// Longest `Retry-After` for which that 402 is transient.
const IN_FLIGHT_BUDGET_MAX_ADVICE: Duration = Duration::from_secs(60);

/// WebSocket close codes that end a link without blaming the request.
const TRANSIENT_WS_CLOSES: [u16; 6] = [1000, 1001, 1005, 1006, 1011, 1012];

#[derive(Clone, Copy, Debug, Default)]
pub struct Facts<'a> {
    pub status: Option<u16>,
    /// The provider's typed error code, any case.
    pub code: Option<&'a str>,
    /// A gateway's error type (OpenRouter vocabulary); it supersedes `code`.
    pub gateway_error_type: Option<&'a str>,
    pub quota_scope: Option<QuotaScope>,
    /// Header-derived quota evidence (Anthropic unified status, provider
    /// quota headers) on a response that is otherwise a rate limit.
    pub quota_header: bool,
    /// Account-pool evidence that the account's quota is exhausted.
    pub account_quota_exhausted: bool,
    pub reauth_required: bool,
    pub retry_after: Option<Duration>,
    pub transport: Option<&'a TransportFault>,
    /// An in-stream error event that carried no code.
    pub wire_error_without_code: bool,
    /// The provider's message text, read only for an error no typed code
    /// decides (`providerErrorKind`'s wording fallbacks).
    pub text: Option<&'a str>,
}

/// Token-context refusals (`TOKEN_CONTEXT_OVERFLOW_PATTERNS`): each is tied to
/// a context or input-length noun so a tokens-per-minute rate limit never
/// matches.
static CONTEXT_OVERFLOW_WORDING: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r"(?i)input (?:length|tokens?) exceeds? the context window",
        r"(?i)exceeds? the (?:maximum )?context (?:window|length)",
        r"(?i)maximum context length",
        r"(?i)context[_ ]length[_ ]exceeded",
        r"(?i)prompt is too long",
        r"(?i)reduce the length of (?:the )?(?:messages|input|prompt)",
        r"(?i)prompt too long",
        r"(?i)prompt exceeds max length",
        r"(?i)input is too long for requested model",
        r"(?i)input token count.*exceeds the maximum",
        r"(?i)maximum prompt length is \d+",
        r"(?i)exceeds (?:the )?maximum allowed input length",
        r"(?i)is longer than the model'?s context length",
        r"(?i)exceeds the available context size",
        r"(?i)greater than the context length",
        r"(?i)context window exceeds limit",
        r"(?i)exceeded model token limit",
        r"(?i)too large for model with \d+ maximum context length",
        r"(?i)range of input length should be",
        r"(?i)model_context_window_exceeded",
    ])
    .expect("static patterns")
});

/// Byte or media size refusals (`REQUEST_SIZE_PATTERNS`): the body itself is
/// too large.
static REQUEST_SIZE_WORDING: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([
        r"(?i)request payload size exceeds the limit",
        r"(?i)request entity too large",
        r"(?i)request exceeds the maximum size",
    ])
    .expect("static patterns")
});

/// Capacity wording on an untyped 429 (`CAPACITY_MESSAGE_RE`).
static CAPACITY_WORDING: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new([r"(?i)\bat capacity\b|\boverloaded\b|\bserver is busy\b"]).expect("static patterns")
});

/// `providerErrorKind`'s wording fallback: an error read as `unknown` or
/// `invalid_request` whose text names a token-context or request-size refusal
/// is `context_overflow` or `request_too_large`. A typed code or any other
/// kind always stands.
pub fn wording_kind(kind: ErrorKind, text: &str) -> ErrorKind {
    if !matches!(kind, ErrorKind::Unknown | ErrorKind::InvalidRequest) {
        return kind;
    }
    if CONTEXT_OVERFLOW_WORDING.is_match(text) {
        ErrorKind::ContextOverflow
    } else if REQUEST_SIZE_WORDING.is_match(text) {
        ErrorKind::RequestTooLarge
    } else {
        kind
    }
}

/// The vocabulary of PW §3.3 (`CODE_KINDS`), matched case-insensitively.
pub fn kind_from_code(code: &str) -> Option<ErrorKind> {
    let code = code.trim().to_ascii_lowercase();
    let code = code.as_str();
    if code.ends_with("_policy_violation") {
        return Some(ErrorKind::Policy);
    }
    Some(match code {
        "cyber_policy" | "bio_policy" | "content_filter" | "safety" | "recitation"
        | "invalid_prompt" => ErrorKind::Policy,
        "insufficient_quota"
        | "credit_balance_exhausted"
        | "organization_spend_limit_exceeded"
        | "project_spend_limit_exceeded"
        | "organization_usage_limit_exceeded"
        | "billing_not_active"
        | "billing_hard_limit_reached"
        | "payment_required"
        | "insufficient_g1_credits_balance" => ErrorKind::Billing,
        "usage_not_included" => ErrorKind::Entitlement,
        "quota_exceeded" | "quota_exhausted" | "usage_limit_reached"
        | "provider_accounts_exhausted" => ErrorKind::QuotaExhausted,
        "context_length_exceeded" | "context_window_exceeded" | "model_context_window_exceeded" => {
            ErrorKind::ContextOverflow
        }
        "request_too_large" | "payload_too_large" | "request_entity_too_large" => {
            ErrorKind::RequestTooLarge
        }
        "invalid_api_key"
        | "authentication_error"
        | "unauthenticated"
        | "unauthorized"
        | "invalid_authentication"
        | "api_key_invalid"
        | "api_key_expired"
        | "access_token_expired"
        | "auth_context_expired"
        | "auth_expired" => ErrorKind::Auth,
        "permission_error" | "permission_denied" | "forbidden" | "service_disabled"
        | "api_key_service_blocked" => ErrorKind::Permission,
        "server_is_overloaded"
        | "overloaded_error"
        | "overloaded"
        | "server_overloaded"
        | "model_capacity_exhausted"
        | "model_capacity_exceeded" => ErrorKind::Overloaded,
        "flex_unavailable" => ErrorKind::ServiceTierUnavailable,
        "rate_limit_exceeded" | "rate_limit_error" | "rate_limited" | "slow_down"
        | "too_many_requests" => ErrorKind::RateLimited,
        "server_error"
        | "api_error"
        | "internal"
        | "internal_error"
        | "unavailable"
        | "service_unavailable"
        | "deadline_exceeded"
        | "timeout"
        | "previous_response_not_found"
        | "websocket_connection_limit_reached"
        | "stream_disconnected"
        | "network_error"
        | "malformed_stream" => ErrorKind::Transient,
        "invalid_request"
        | "invalid_request_error"
        | "invalid_argument"
        | "failed_precondition"
        | "bad_request"
        | "not_found"
        | "not_found_error"
        | "model_not_found"
        | "model_not_supported"
        | "unsupported_parameter" => ErrorKind::InvalidRequest,
        _ => return None,
    })
}

/// The HTTP status table. 525/526 carry no verdict (edge failures).
pub fn kind_from_status(status: u16) -> Option<ErrorKind> {
    match status {
        401 => Some(ErrorKind::Auth),
        402 => Some(ErrorKind::Billing),
        403 => Some(ErrorKind::Permission),
        413 => Some(ErrorKind::RequestTooLarge),
        429 => Some(ErrorKind::RateLimited),
        529 => Some(ErrorKind::Overloaded),
        408 | 409 | 425 => Some(ErrorKind::Transient),
        525 | 526 => None,
        400..=499 => Some(ErrorKind::InvalidRequest),
        500..=599 => Some(ErrorKind::Transient),
        _ => None,
    }
}

fn transport_is_transient(fault: &TransportFault) -> bool {
    match fault {
        TransportFault::WsClose { code } => code.is_none_or(|c| TRANSIENT_WS_CLOSES.contains(&c)),
        _ => true,
    }
}

pub fn kind_of(facts: &Facts<'_>) -> ErrorKind {
    let kind = if facts.account_quota_exhausted {
        ErrorKind::QuotaExhausted
    } else if facts.reauth_required {
        ErrorKind::Auth
    } else if facts.status == Some(402) {
        let in_flight = facts
            .code
            .is_some_and(|c| c.eq_ignore_ascii_case(OPENROUTER_IN_FLIGHT_BUDGET))
            && facts
                .retry_after
                .is_none_or(|advice| advice <= IN_FLIGHT_BUDGET_MAX_ADVICE);
        if in_flight {
            ErrorKind::Transient
        } else {
            ErrorKind::Billing
        }
    } else {
        base_kind(facts)
    };
    let kind = match facts.text {
        Some(text) => wording_kind(kind, text),
        None => kind,
    };
    window_adjusted(kind, facts)
}

fn base_kind(facts: &Facts<'_>) -> ErrorKind {
    let from_gateway = facts.gateway_error_type.and_then(kind_from_code);
    let from_code = facts.code.map(|code| {
        // Google reports quota and rate limits under one status; the quota
        // scope decides, and window adjustment below keeps it consistent.
        if code.eq_ignore_ascii_case("resource_exhausted") {
            return Some(match facts.quota_scope {
                Some(QuotaScope::Day | QuotaScope::Plan) => ErrorKind::QuotaExhausted,
                _ => ErrorKind::RateLimited,
            });
        }
        kind_from_code(code)
    });
    let typed = from_gateway.or(from_code.flatten());
    let by_status = facts.status.and_then(kind_from_status);
    let mut kind = typed.or(by_status);
    if facts.quota_header && matches!(kind, None | Some(ErrorKind::RateLimited)) {
        kind = Some(ErrorKind::QuotaExhausted);
    } else if typed.is_none()
        && facts.code.is_none()
        && facts.status == Some(429)
        && facts.text.is_some_and(|text| CAPACITY_WORDING.is_match(text))
    {
        // Capacity wording counts only on an untyped 429 ("... is at
        // capacity"): it keeps such a 429 from reading as a rate limit.
        kind = Some(ErrorKind::Overloaded);
    }
    if let Some(kind) = kind {
        return kind;
    }
    if facts.transport.is_some_and(transport_is_transient) || facts.wire_error_without_code {
        return ErrorKind::Transient;
    }
    ErrorKind::Unknown
}

fn window_adjusted(kind: ErrorKind, facts: &Facts<'_>) -> ErrorKind {
    match (kind, facts.quota_scope) {
        (ErrorKind::QuotaExhausted, Some(QuotaScope::Minute)) => ErrorKind::RateLimited,
        (ErrorKind::RateLimited, Some(QuotaScope::Day | QuotaScope::Plan)) => {
            ErrorKind::QuotaExhausted
        }
        _ => kind,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(status: u16) -> Facts<'static> {
        Facts {
            status: Some(status),
            ..Facts::default()
        }
    }

    #[test]
    fn status_table() {
        let expect = [
            (401, ErrorKind::Auth),
            (402, ErrorKind::Billing),
            (403, ErrorKind::Permission),
            (413, ErrorKind::RequestTooLarge),
            (429, ErrorKind::RateLimited),
            (529, ErrorKind::Overloaded),
            (408, ErrorKind::Transient),
            (404, ErrorKind::InvalidRequest),
            (503, ErrorKind::Transient),
            (525, ErrorKind::Unknown),
        ];
        for (code, kind) in expect {
            assert_eq!(kind_of(&status(code)), kind, "status {code}");
        }
    }

    #[test]
    fn typed_code_beats_status() {
        let facts = Facts {
            status: Some(429),
            code: Some("insufficient_quota"),
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::Billing);
        let facts = Facts {
            status: Some(400),
            code: Some("context_length_exceeded"),
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::ContextOverflow);
    }

    #[test]
    fn gateway_type_supersedes_native_code() {
        let facts = Facts {
            status: Some(429),
            code: Some("rate_limit_exceeded"),
            gateway_error_type: Some("insufficient_quota"),
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::Billing);
    }

    #[test]
    fn google_resource_exhausted_follows_quota_scope() {
        let mut facts = Facts {
            status: Some(429),
            code: Some("RESOURCE_EXHAUSTED"),
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::RateLimited);
        facts.quota_scope = Some(QuotaScope::Day);
        assert_eq!(kind_of(&facts), ErrorKind::QuotaExhausted);
        facts.quota_scope = Some(QuotaScope::Minute);
        assert_eq!(kind_of(&facts), ErrorKind::RateLimited);
    }

    #[test]
    fn quota_header_promotes_a_rate_limit() {
        let facts = Facts {
            status: Some(429),
            quota_header: true,
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::QuotaExhausted);
    }

    #[test]
    fn in_flight_budget_402_is_transient_only_with_short_advice() {
        let mut facts = Facts {
            status: Some(402),
            code: Some(OPENROUTER_IN_FLIGHT_BUDGET),
            retry_after: Some(Duration::from_secs(5)),
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::Transient);
        facts.retry_after = Some(Duration::from_secs(61));
        assert_eq!(kind_of(&facts), ErrorKind::Billing);
    }

    #[test]
    fn reauth_and_account_evidence_come_first() {
        let facts = Facts {
            status: Some(500),
            reauth_required: true,
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::Auth);
        let facts = Facts {
            status: Some(500),
            account_quota_exhausted: true,
            reauth_required: true,
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::QuotaExhausted);
    }

    #[test]
    fn transport_evidence_is_transient() {
        let closed = TransportFault::Reset;
        let facts = Facts {
            transport: Some(&closed),
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::Transient);
        let policy_close = TransportFault::WsClose { code: Some(1008) };
        let facts = Facts {
            transport: Some(&policy_close),
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::Unknown);
        let going_away = TransportFault::WsClose { code: Some(1001) };
        let facts = Facts {
            transport: Some(&going_away),
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::Transient);
    }

    #[test]
    fn codeless_wire_error_is_transient() {
        let facts = Facts {
            wire_error_without_code: true,
            ..Facts::default()
        };
        assert_eq!(kind_of(&facts), ErrorKind::Transient);
    }

    #[test]
    fn wording_names_a_context_overflow_only_for_an_undecided_error() {
        for text in [
            "prompt is too long: 250000 tokens > 200000 maximum",
            "This model's maximum context length is 8192 tokens",
            "the request exceeds the available context size (8192 tokens)",
            "Exceeded model token limit: 262144",
        ] {
            let facts = Facts { status: Some(400), text: Some(text), ..Facts::default() };
            assert_eq!(kind_of(&facts), ErrorKind::ContextOverflow, "{text}");
            let facts = Facts { text: Some(text), ..Facts::default() };
            assert_eq!(kind_of(&facts), ErrorKind::ContextOverflow, "{text}");
        }
        let typed = Facts {
            status: Some(400),
            code: Some("content_filter"),
            text: Some("prompt is too long"),
            ..Facts::default()
        };
        assert_eq!(kind_of(&typed), ErrorKind::Policy);
        let rate = Facts { status: Some(429), text: Some("prompt is too long"), ..Facts::default() };
        assert_eq!(kind_of(&rate), ErrorKind::RateLimited);
        let tpm = Facts { status: Some(400), text: Some("tokens per minute limit"), ..Facts::default() };
        assert_eq!(kind_of(&tpm), ErrorKind::InvalidRequest);
    }

    #[test]
    fn wording_names_a_request_size_refusal() {
        let facts = Facts { status: Some(400), text: Some("Request Entity Too Large"), ..Facts::default() };
        assert_eq!(kind_of(&facts), ErrorKind::RequestTooLarge);
        assert_eq!(wording_kind(ErrorKind::Transient, "request entity too large"), ErrorKind::Transient);
    }

    #[test]
    fn capacity_wording_counts_only_on_an_untyped_429() {
        let facts = Facts { status: Some(429), text: Some("The server is busy"), ..Facts::default() };
        assert_eq!(kind_of(&facts), ErrorKind::Overloaded);
        let typed = Facts {
            status: Some(429),
            code: Some("rate_limit_exceeded"),
            text: Some("model is at capacity"),
            ..Facts::default()
        };
        assert_eq!(kind_of(&typed), ErrorKind::RateLimited);
        let server = Facts { status: Some(500), text: Some("overloaded"), ..Facts::default() };
        assert_eq!(kind_of(&server), ErrorKind::Transient);
    }
}
