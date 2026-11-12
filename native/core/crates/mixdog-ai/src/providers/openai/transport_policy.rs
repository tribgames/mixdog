//! The shared Responses transport policy (`openai-transport-policy.mjs`): the
//! `MIXDOG_OAI_TRANSPORT` switch normalized, gated by what the provider
//! supports, and resolved into the wire, the HTTP/SSE fallback and the delta
//! frames. Pure.

/// A transport mode token after normalization.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// WebSocket first, HTTP/SSE fallback.
    Auto,
    /// WebSocket only, every frame full.
    WsFull,
    /// WebSocket only, refs-compatible delta frames.
    WsDelta,
    /// HTTP/SSE only.
    HttpSse,
}

impl Mode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::WsFull => "ws-full",
            Self::WsDelta => "ws-delta",
            Self::HttpSse => "http-sse",
        }
    }
}

/// `_normalizeTransportMode`: underscores and whitespace collapse to `-`, a
/// few spellings map to the canonical modes; unknown or empty is `None`.
pub fn normalize(raw: &str) -> Option<Mode> {
    let lowered = raw.trim().to_lowercase();
    let mut v = String::with_capacity(lowered.len());
    let mut run = false;
    for c in lowered.chars() {
        if c.is_whitespace() || c == '_' {
            if !run {
                v.push('-');
            }
            run = true;
        } else {
            v.push(c);
            run = false;
        }
    }
    match v.as_str() {
        "ws-full" | "wsfull" | "full" | "ws" | "websocket-full" => Some(Mode::WsFull),
        "ws-delta" | "wsdelta" | "delta" | "websocket-delta" => Some(Mode::WsDelta),
        "http-sse" | "httpsse" | "http" | "sse" | "http/sse" => Some(Mode::HttpSse),
        "auto" => Some(Mode::Auto),
        _ => None,
    }
}

/// What a Responses backend can speak.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Capabilities {
    pub ws: bool,
    pub http: bool,
    pub delta: bool,
}

/// `FULL_RESPONSES_TRANSPORT_CAPS`: the default of an unknown provider.
pub const FULL: Capabilities = Capabilities { ws: true, http: true, delta: true };

/// `RESPONSES_TRANSPORT_CAPABILITIES`, in its order.
pub const CAPABILITIES: [(&str, Capabilities); 3] = [("openai-oauth", FULL), ("openai", FULL), ("xai", FULL)];

/// `_gateTransportMode`: the requested mode down-shifted to the nearest one
/// the provider supports.
pub fn gate(mode: Mode, caps: Capabilities) -> Mode {
    let best_supported = || {
        if caps.ws {
            Mode::WsFull
        } else if caps.http {
            Mode::HttpSse
        } else {
            Mode::Auto
        }
    };
    let mut m = mode;
    if matches!(m, Mode::Auto | Mode::WsDelta) && !caps.delta {
        m = best_supported();
    }
    if matches!(m, Mode::Auto | Mode::WsFull | Mode::WsDelta) && !caps.ws {
        m = if caps.http { Mode::HttpSse } else { Mode::Auto };
    }
    if m == Mode::HttpSse && !caps.http {
        m = if caps.ws { Mode::WsFull } else { Mode::Auto };
    }
    m
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Transport {
    Ws,
    Http,
}

/// The delta switches (`DELTA_OFF` / `DELTA_REFS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Delta {
    pub force: bool,
    pub refs: bool,
    pub opt_in: bool,
}

const DELTA_OFF: Delta = Delta { force: false, refs: false, opt_in: false };
const DELTA_REFS: Delta = Delta { force: false, refs: true, opt_in: true };

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Policy {
    pub mode: Mode,
    pub requested_mode: Mode,
    pub transport: Transport,
    pub allow_http_fallback: bool,
    pub delta: Delta,
    pub capabilities: Capabilities,
}

/// `resolveResponsesTransportPolicy` over the value of `MIXDOG_OAI_TRANSPORT`.
pub fn resolve(setting: Option<&str>, caps: Capabilities) -> Policy {
    let requested_mode = normalize(setting.unwrap_or("")).unwrap_or(Mode::Auto);
    let mode = gate(requested_mode, caps);
    let (transport, delta) = match mode {
        Mode::HttpSse => (Transport::Http, DELTA_OFF),
        Mode::WsFull => (Transport::Ws, DELTA_OFF),
        Mode::Auto | Mode::WsDelta => (Transport::Ws, if caps.delta { DELTA_REFS } else { DELTA_OFF }),
    };
    Policy {
        mode,
        requested_mode,
        transport,
        allow_http_fallback: requested_mode == Mode::Auto && caps.http,
        delta,
        capabilities: caps,
    }
}

/// `resolveOpenAiTransportPolicy`: the full-capability resolution.
pub fn resolve_openai(setting: Option<&str>) -> Policy {
    resolve(setting, FULL)
}
