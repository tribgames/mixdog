//! The built-in connector catalog as far as the MCP client needs it: which servers are catalog
//! connectors, the tools each asks for before it runs, and the sign-in client a connector uses.

use std::collections::BTreeMap;

use mixdog_js::js_trim;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use url::Url;

use crate::config::InlineSecret;
use crate::config::OAuthBinding;
use crate::config::StaticClient;

pub struct Connector {
    pub id: &'static str,
    pub name: &'static str,
    /// Tools that ask before they run unless the agent set their permission.
    pub ask_tools: &'static [&'static str],
    /// The pre-registered sign-in client the connector uses, with the scopes it requests.
    pub google_scopes: Option<&'static [&'static str]>,
}

const GOOGLE_SCOPE_BASE: &str = "https://www.googleapis.com/auth";

const fn plain(id: &'static str, name: &'static str) -> Connector {
    Connector { id, name, ask_tools: &[], google_scopes: None }
}

/// The catalog, in Node's order (`CONNECTOR_CATALOG`).
pub const CATALOG: [Connector; 16] = [
    plain("airtable", "Airtable"),
    plain("confluence", "Confluence"),
    plain("dropbox", "Dropbox"),
    Connector { id: "gmail", name: "Gmail", ask_tools: &["send_email"], google_scopes: Some(&["gmail.send"]) },
    Connector {
        id: "google-calendar",
        name: "Google Calendar",
        ask_tools: &["delete_event"],
        google_scopes: Some(&["calendar.events"]),
    },
    Connector { id: "google-drive", name: "Google Drive", ask_tools: &[], google_scopes: Some(&["drive.file"]) },
    plain("hugging-face", "Hugging Face"),
    plain("jira", "Jira"),
    plain("linear", "Linear"),
    plain("notion", "Notion"),
    plain("postgres", "Postgres"),
    plain("sentry", "Sentry"),
    plain("stripe", "Stripe"),
    plain("supabase", "Supabase"),
    plain("trello", "Trello"),
    plain("vercel", "Vercel"),
];

pub fn connector(id: &str) -> Option<&'static Connector> {
    CATALOG.iter().find(|c| c.id == id)
}

/// The permission a catalog connector's tool has when nothing set its own.
pub fn tool_default_asks(connector_id: Option<&str>, tool: &str) -> bool {
    connector_id.and_then(connector).is_some_and(|c| c.ask_tools.contains(&tool))
}

/// `gmail-2` → `gmail` for a catalog connector; any other id is its own. A tool's permission is
/// stored once, under this id, and governs every account.
pub fn group_id(server: &str) -> String {
    let base = server.trim_end_matches(|c: char| c.is_ascii_digit());
    match base.strip_suffix('-') {
        Some(stem) if base.len() < server.len() && connector(stem).is_some() => stem.to_owned(),
        _ => server.to_owned(),
    }
}

/// The secret-store account of the user's client secret for one server URL.
pub fn client_secret_account(url: &Url) -> String {
    let digest = Sha256::digest(url.as_str().as_bytes());
    format!("mcp-oauth-client.{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

fn text<'a>(entry: &'a Value, key: &str) -> &'a str {
    entry.get(key).and_then(Value::as_str).map_or("", str::trim)
}

fn google_params() -> BTreeMap<String, String> {
    BTreeMap::from([("access_type".to_owned(), "offline".to_owned())])
}

/// The Google client embedded at build time (see `build.rs`).
const EMBEDDED_GOOGLE: Option<(&str, &str)> = include!(concat!(env!("OUT_DIR"), "/google_client.rs"));

fn trimmed_env(name: &str) -> String {
    js_trim(&std::env::var(name).unwrap_or_default()).to_owned()
}

/// `(client id, client secret)` of Mixdog's Google client, or `None` when this build has none.
/// The environment wins over the embedded one as a whole: the two are never mixed.
pub fn google_client() -> Option<(String, String)> {
    let id = trimmed_env("MIXDOG_GOOGLE_OAUTH_CLIENT_ID");
    if !id.is_empty() {
        return Some((id, trimmed_env("MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET")));
    }
    EMBEDDED_GOOGLE.map(|(id, secret)| (id.to_owned(), secret.to_owned()))
}

/// How the server `name` at `url` signs in: the user's own client (`oauthClientId`), else the
/// catalog connector's, else dynamic client registration.
pub fn oauth_binding(name: &str, entry: &Value, url: &Url, connector_id: Option<&str>) -> OAuthBinding {
    oauth_binding_with(name, entry, url, connector_id, google_client())
}

fn oauth_binding_with(
    name: &str,
    entry: &Value,
    url: &Url,
    connector_id: Option<&str>,
    google: Option<(String, String)>,
) -> OAuthBinding {
    let catalog = connector_id.and_then(connector);
    let scopes: Vec<String> = catalog
        .and_then(|c| c.google_scopes)
        .map(|list| {
            ["openid".to_owned(), "email".to_owned()]
                .into_iter()
                .chain(list.iter().map(|s| format!("{GOOGLE_SCOPE_BASE}/{s}")))
                .collect()
        })
        .unwrap_or_default();
    let own = text(entry, "oauthClientId");
    let (client, client_unavailable) = if !own.is_empty() {
        let auth_params = if catalog.is_some_and(|c| c.google_scopes.is_some()) { google_params() } else { BTreeMap::new() };
        (
            Some(StaticClient {
                client_id: own.to_owned(),
                secret_account: client_secret_account(url),
                inline_secret: None,
                scopes,
                auth_params,
            }),
            None,
        )
    } else if catalog.is_some_and(|c| c.google_scopes.is_some()) {
        // Google offers no dynamic client registration: never fall back to it.
        match google {
            Some((client_id, secret)) => (
                Some(StaticClient {
                    client_id,
                    secret_account: String::new(),
                    inline_secret: (!secret.is_empty()).then_some(InlineSecret(secret)),
                    scopes,
                    auth_params: google_params(),
                }),
                None,
            ),
            None => (None, Some("google".to_owned())),
        }
    } else {
        (None, None)
    };
    let own_key = text(entry, "oauthKey");
    OAuthBinding {
        url: url.clone(),
        credential_key: if own_key.is_empty() { url.as_str().to_owned() } else { format!("mcp-account:{own_key}") },
        display_name: catalog.map_or_else(|| name.to_owned(), |c| c.name.to_owned()),
        client,
        client_unavailable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_google_connector_uses_the_builtin_client_the_users_own_wins_and_none_is_unavailable() {
        let url = Url::parse("https://gmailmcp.googleapis.com/mcp/v1").unwrap();
        let entry = serde_json::json!({});
        let builtin = oauth_binding_with("gmail", &entry, &url, Some("gmail"), Some(("id".into(), "sec".into())));
        let client = builtin.client.expect("built-in client");
        assert_eq!(client.client_id, "id");
        assert_eq!(client.inline_secret, Some(InlineSecret("sec".into())));
        assert_eq!(client.auth_params.get("access_type").map(String::as_str), Some("offline"));
        assert!(builtin.client_unavailable.is_none());
        assert_eq!(format!("{:?}", client.inline_secret), "Some(<redacted>)");

        let own = serde_json::json!({"oauthClientId": "mine"});
        let user = oauth_binding_with("gmail", &own, &url, Some("gmail"), Some(("id".into(), "sec".into())));
        assert_eq!(user.client.unwrap().client_id, "mine");

        let none = oauth_binding_with("gmail", &entry, &url, Some("gmail"), None);
        assert!(none.client.is_none() && none.client_unavailable.as_deref() == Some("google"));
    }

    #[test]
    fn accounts_share_their_connectors_permission_group() {
        assert_eq!(group_id("gmail-2"), "gmail");
        assert_eq!(group_id("gmail"), "gmail");
        assert_eq!(group_id("custom-2"), "custom-2");
        assert!(tool_default_asks(Some("gmail"), "send_email"));
        assert!(!tool_default_asks(Some("gmail"), "read_email"));
    }
}
