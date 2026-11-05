//! The account side of an MCP sign-in: which documented authorization parameter makes a provider
//! show its account choice, and who a sign-in belongs to — read only from what the authorization
//! server returned, never guessed.
//!
//! Parameters are sent only where the provider documents them, keyed by the authorization
//! endpoint's host: Google and GitHub `prompt=select_account`; Atlassian and Linear
//! `prompt=consent`; Dropbox `force_reapprove=true`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use url::Url;

/// How a sign-in treats the account: a normal authorization, a repair of the same connection,
/// or a transactional switch.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum AccountMode {
    #[default]
    Connect,
    Reauth,
    Switch,
}

const CONNECT_HOSTS: [&str; 2] = ["accounts.google.com", "github.com"];

fn params_of(host: &str, mode: AccountMode) -> Option<(&'static str, &'static str)> {
    let host = host.to_ascii_lowercase();
    if CONNECT_HOSTS.contains(&host.as_str()) {
        return (mode != AccountMode::Reauth).then_some(("prompt", "select_account"));
    }
    if mode != AccountMode::Switch {
        return None;
    }
    match host.as_str() {
        "auth.atlassian.com" | "linear.app" | "mcp.linear.app" => Some(("prompt", "consent")),
        "www.dropbox.com" => Some(("force_reapprove", "true")),
        _ => None,
    }
}

/// `authorization_url` with the account parameters of `mode`; a repair adds nothing. A `prompt`
/// the request already carries (`consent` for offline access) is kept and extended.
pub fn with_account_params(authorization_url: &Url, mode: AccountMode) -> Url {
    let mut target = authorization_url.clone();
    let Some((key, value)) = target.host_str().and_then(|host| params_of(host, mode)) else { return target };
    if key != "prompt" {
        set_query(&mut target, key, value);
        return target;
    }
    let existing = target.query_pairs().find(|(k, _)| k == "prompt").map(|(_, v)| v.into_owned()).unwrap_or_default();
    let mut values: Vec<&str> = existing.split(' ').filter(|v| !v.is_empty()).collect();
    if !values.contains(&value) {
        values.push(value);
    }
    set_query(&mut target, "prompt", &values.join(" "));
    target
}

/// Replaces (or adds) one query parameter, keeping the others in order.
pub fn set_query(url: &mut Url, key: &str, value: &str) {
    let mut replaced = false;
    let mut pairs: Vec<(String, String)> = Vec::new();
    for (k, v) in url.query_pairs() {
        if k == key {
            if !replaced {
                pairs.push((k.into_owned(), value.to_owned()));
                replaced = true;
            }
        } else {
            pairs.push((k.into_owned(), v.into_owned()));
        }
    }
    if !replaced {
        pairs.push((key.to_owned(), value.to_owned()));
    }
    url.query_pairs_mut().clear().extend_pairs(pairs);
}

/// Whether the provider of this authorization endpoint can be made to show its account choice
/// (otherwise the user switches at the provider first).
pub fn can_force_account_choice(authorization_endpoint: Option<&str>) -> bool {
    let Some(host) = authorization_endpoint.and_then(|e| Url::parse(e).ok()).and_then(|u| u.host_str().map(str::to_owned)) else {
        return false;
    };
    params_of(&host, AccountMode::Switch).is_some()
}

#[derive(Clone, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
pub struct Identity {
    #[serde(default)]
    pub account: String,
    #[serde(default)]
    pub workspace: String,
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).map(str::trim).unwrap_or_default().to_owned()
}

fn id_token_claims(id_token: Option<&Value>) -> Value {
    let payload = id_token.and_then(Value::as_str).and_then(|t| t.split('.').nth(1)).unwrap_or_default();
    URL_SAFE_NO_PAD
        .decode(payload)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or(Value::Null)
}

/// `{ account, workspace }` from a token endpoint response: the OIDC id_token claims and the
/// identity fields providers return beside the tokens (Notion's workspace and owner, Slack's
/// team, a `user` / `organization` object). `None` when the response names nobody.
pub fn identity_from_token_response(body: &Value) -> Option<Identity> {
    if !body.is_object() {
        return None;
    }
    let claims = id_token_claims(body.get("id_token"));
    let user = body.get("user").filter(|u| u.is_object()).unwrap_or(&Value::Null);
    let first = |candidates: &[Option<&Value>]| candidates.iter().map(|c| text(*c)).find(|t| !t.is_empty()).unwrap_or_default();
    let owner_user = body.pointer("/owner/user");
    let account = first(&[
        claims.get("email"),
        claims.get("preferred_username"),
        body.get("email"),
        user.get("email"),
        user.get("login"),
        user.get("username"),
        owner_user.and_then(|u| u.pointer("/person/email")),
        owner_user.and_then(|u| u.get("name")),
    ]);
    let workspace = first(&[
        body.get("workspace_name"),
        body.pointer("/team/name"),
        body.pointer("/organization/name"),
        body.pointer("/org/name"),
    ]);
    (!account.is_empty() || !workspace.is_empty()).then_some(Identity { account, workspace })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn account_choice_follows_the_documented_parameter_per_host() {
        let google = Url::parse("https://accounts.google.com/o/oauth2/v2/auth?prompt=consent&x=1").unwrap();
        assert_eq!(with_account_params(&google, AccountMode::Connect).query(), Some("prompt=consent+select_account&x=1"));
        assert_eq!(with_account_params(&google, AccountMode::Reauth), google);
        let linear = Url::parse("https://linear.app/oauth/authorize?x=1").unwrap();
        assert_eq!(with_account_params(&linear, AccountMode::Connect), linear);
        assert_eq!(with_account_params(&linear, AccountMode::Switch).query(), Some("x=1&prompt=consent"));
        assert!(can_force_account_choice(Some("https://www.dropbox.com/oauth2/authorize")));
        assert!(!can_force_account_choice(Some("https://example.com/authorize")));
    }

    #[test]
    fn identity_is_read_from_claims_and_provider_fields_or_is_absent() {
        let claims = URL_SAFE_NO_PAD.encode(br#"{"email":" a@b.c "}"#);
        let body = json!({"id_token": format!("h.{claims}.s"), "team": {"name": "Acme"}});
        assert_eq!(identity_from_token_response(&body), Some(Identity { account: "a@b.c".into(), workspace: "Acme".into() }));
        let notion = json!({"owner": {"user": {"person": {"email": "n@x.y"}}}, "workspace_name": "W"});
        assert_eq!(identity_from_token_response(&notion).unwrap().account, "n@x.y");
        assert_eq!(identity_from_token_response(&json!({"access_token": "t"})), None);
    }
}
