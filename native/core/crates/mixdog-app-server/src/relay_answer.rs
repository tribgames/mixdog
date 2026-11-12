//! What a relay client (a paired phone) is told of a request that failed: the desktop relay's answer frame
//! (`apps/desktop/src/main/remote-methods.ts` `executeRemoteFrame`), which the core now owes it itself.
//!
//! * The failure's text and its public params lose the call's own secrets, as `redactRemoteError` removed them: every string of
//!   the arguments of a secret-bearing call, six characters or longer (a handoff secret, whole), plain and as a JSON string escapes
//!   it, becomes `[redacted]`.
//! * Only the params a code declares public ride along (`coded-error.ts` `codedErrorParams`): the `name` of a room or schedule
//!   refusal, a non-empty string of at most 200 characters. Every other detail of a failure stays on the core's side.

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_protocol::DomainErrorDetail;
use mixdog_protocol::Origin;
use serde_json::Value;

const REDACTED: &str = "[redacted]";
/// `MIN_REDACTED_SECRET_LENGTH`.
const MIN_SECRET_LENGTH: usize = 6;
/// How many levels of the arguments are walked (`visit`'s `depth < 6`).
const MAX_DEPTH: usize = 6;
/// `MAX_PARAM_LENGTH`.
const MAX_PARAM_LENGTH: usize = 200;

/// The methods whose arguments carry secrets: the wire methods of Node's `SECRET_CAPABILITY_NAMES` (API keys, session keys, auth
/// codes, pasted redirect URLs, a connector account's key or app password, an MCP config's header credentials).
const SECRET_METHODS: [&str; 23] = [
    "account/saveProviderApiKey",
    "account/saveOpenAIUsageSessionKey",
    "account/saveCustomProvider",
    "account/saveCustomProviderKey",
    "account/removeCustomProvider",
    "account/updateCustomProviderModel",
    "account/testCustomProvider",
    "account/checkCustomProviderKeyEnv",
    "account/discoverCustomProviderModels",
    "mcp/getMcpServerConfig",
    "mcp/addMcpServer",
    "connector/addConnectorAccount",
    "mcp/saveMcpServer",
    "config/setDeveloperOption",
    "account/forgetProviderAuth",
    "account/beginOAuthProviderLogin",
    "account/getOAuthProviderLoginStatus",
    "account/completeOAuthProviderLogin",
    "account/cancelOAuthProviderLogin",
    "account/loginOAuthProvider",
    "account/authenticateProvider",
    "mcp/completeMcpOAuthLogin",
    "mcp/probeMcpServerAuth",
];
/// A phone's handoff secret (`provideSecretInput`).
const PROVIDE_SECRET: &str = "approval/provideSecret";

/// The answer of one request to a relay client, cleaned of what that client must not read.
pub(crate) struct RelayAnswer {
    secrets: Vec<String>,
    /// A failure told without the call that caused it (a stored rejection read back, a rejected answer of a server request): the
    /// call's secrets are not at hand to remove, so its text is not told at all.
    withhold_message: bool,
}

impl RelayAnswer {
    /// `Some` for a request of a relay connection; every other origin is told the failure as it is.
    pub(crate) fn of(origin: Origin, method: &str, params: Option<&Value>) -> Option<Self> {
        (origin == Origin::Relay).then(|| Self { secrets: secret_strings(method, params), withhold_message: false })
    }

    /// `Some` for a failure told to a relay connection without its call in hand (`origin` unknown counts as a relay: nothing
    /// leaves to a connection that is not known to be a local one). Node's relay never tells one: it holds no outcome after the
    /// frame that carried it, and a repeated call fails afresh through `executeRemoteFrame`.
    pub(crate) fn stored(origin: Option<Origin>) -> Option<Self> {
        origin.is_none_or(|origin| origin == Origin::Relay).then(|| Self { secrets: Vec::new(), withhold_message: true })
    }

    pub(crate) fn outcome(&self, outcome: Result<Reply, CoreError>) -> Result<Reply, CoreError> {
        outcome.map_err(|error| self.error(error))
    }

    pub(crate) fn error(&self, error: CoreError) -> CoreError {
        let CoreError::DomainError { domain, code, message, detail } = error else { return error };
        // A public param is redacted like the message, so without the call's secrets it goes the way of the message.
        let detail = detail.filter(|_| !self.withhold_message).and_then(|detail| self.public_detail(*detail)).map(Box::new);
        let message = message.filter(|_| !self.withhold_message).map(|message| self.redact(&message).into());
        CoreError::DomainError { domain, code, message, detail }
    }

    /// The detail when its code declares params public and the param is one the relay forwards, with the secrets out of it.
    fn public_detail(&self, detail: DomainErrorDetail) -> Option<DomainErrorDetail> {
        let (name, rebuild): (String, fn(String) -> DomainErrorDetail) = match detail {
            DomainErrorDetail::RoomMemberSwitchedOff { name } => (name, |name| DomainErrorDetail::RoomMemberSwitchedOff { name }),
            DomainErrorDetail::ScheduleNameTaken { name } => (name, |name| DomainErrorDetail::ScheduleNameTaken { name }),
            DomainErrorDetail::ScheduleRenameRunning { name } => (name, |name| DomainErrorDetail::ScheduleRenameRunning { name }),
            DomainErrorDetail::ScheduleRenameReloadFailed { name } => (name, |name| DomainErrorDetail::ScheduleRenameReloadFailed { name }),
            _ => return None,
        };
        let length = name.encode_utf16().count();
        (length > 0 && length <= MAX_PARAM_LENGTH).then(|| rebuild(self.redact(&name)))
    }

    /// `redactSecrets`: each secret, plain and as the inside of a JSON string, replaced by `[redacted]`.
    fn redact(&self, text: &str) -> String {
        let mut safe = text.to_owned();
        for secret in self.secrets.iter().filter(|secret| !secret.is_empty()) {
            let json = serde_json::to_string(secret).expect("a string serializes");
            let escaped = &json[1..json.len() - 1];
            safe = safe.replace(secret.as_str(), REDACTED);
            if escaped != secret {
                safe = safe.replace(escaped, REDACTED);
            }
        }
        safe
    }
}

/// `secretStringsOf`: the strings of a secret-bearing call's arguments. A wrapped call (`{opId, input}`) has its `input` for
/// arguments; any other has its fields beside the envelope's (`opId`, `threadId`).
fn secret_strings(method: &str, params: Option<&Value>) -> Vec<String> {
    let Some(params) = params else { return Vec::new() };
    if method == PROVIDE_SECRET {
        return params.get("secret").and_then(Value::as_str).filter(|secret| !secret.is_empty()).map(str::to_owned).into_iter().collect();
    }
    if !SECRET_METHODS.contains(&method) {
        return Vec::new();
    }
    let mut found = Vec::new();
    match params.get("input").filter(|input| input.is_object() || input.is_array()) {
        Some(input) => visit(input, 0, &mut found),
        None => {
            for (_, value) in params.as_object().into_iter().flatten().filter(|(key, _)| !["opId", "threadId"].contains(&key.as_str())) {
                visit(value, 1, &mut found);
            }
        }
    }
    found
}

fn visit(value: &Value, depth: usize, found: &mut Vec<String>) {
    match value {
        Value::String(text) if text.encode_utf16().count() >= MIN_SECRET_LENGTH => found.push(text.clone()),
        Value::Object(fields) if depth < MAX_DEPTH => fields.values().for_each(|value| visit(value, depth + 1, found)),
        Value::Array(items) if depth < MAX_DEPTH => items.iter().for_each(|value| visit(value, depth + 1, found)),
        _ => {}
    }
}
