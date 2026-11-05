//! Where Vertex AI serves a model (port of `vertex-ai-models.mjs`
//! `vertexServingProblem`, its sets and lists) and which location one request
//! goes to (`vertex-ai.mjs` `send`): a location the user configured is never
//! moved; one taken from the environment gives way to `global` before sending
//! when it cannot serve the request but `global` can. The combination is
//! checked before any request leaves.

use mixdog_core_api::domain::provider::ProviderError;
use serde_json::Value;

use super::auth::vertex::EXPRESS_BASE;
use super::auth::vertex::project_base;
use super::request::invalid;

/// Multi-region locations, served by representative endpoints.
const MULTI_REGIONS: [&str; 2] = ["us", "eu"];
const PRIORITY_LOCATIONS: [&str; 3] = ["global", "us", "eu"];

/// Every Claude model before 4.5.
const EARLIER_CLAUDE: [&str; 10] = [
    "claude-3-sonnet",
    "claude-3-opus",
    "claude-3-haiku",
    "claude-3-5-sonnet",
    "claude-3-5-sonnet-v2",
    "claude-3-5-haiku",
    "claude-3-7-sonnet",
    "claude-sonnet-4",
    "claude-opus-4",
    "claude-opus-4-1",
];
/// Of those, the ones the global endpoint serves.
const GLOBAL_EARLIER_CLAUDE: [&str; 2] = ["claude-3-7-sonnet", "claude-3-5-sonnet-v2"];
/// 4.5 and 4.6: served on global, not on the multi-region endpoints.
const CLAUDE_4_5_TO_4_6: [&str; 5] = [
    "claude-opus-4-5",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
];

/// The environment's region when no location is configured, in precedence order.
const LOCATION_ENV: [&str; 5] = [
    "GOOGLE_VERTEX_LOCATION",
    "GOOGLE_CLOUD_LOCATION",
    "CLOUD_ML_REGION",
    "VERTEX_LOCATION",
    "VERTEXAI_LOCATION",
];

/// Flex PayGo: global endpoint only.
const FLEX_MODELS: [&str; 12] = [
    "gemini-3.8-flash-cyber",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite-image",
    "gemini-3-pro-image",
    "gemini-3.1-flash-image",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
];

/// Priority PayGo: global, us and eu endpoints.
const PRIORITY_MODELS: [&str; 15] = [
    "gemini-4-argon",
    "gemini-4-argon-cyber-permissive",
    "gemini-3.8-flash-cyber",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite-image",
    "gemini-3-pro-image",
    "gemini-nano-banana-2.1",
    "gemini-3.1-flash-image",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
];

/// Open and partner models on the OpenAI-compatible endpoint, keyed
/// `publisher/model`, with the model card's availability. A listed model is
/// sent only there.
const LISTED_LOCATIONS: [(&str, &[&str]); 22] = [
    ("deepseek-ai/deepseek-v4.1-flash-maas", &["global"]),
    ("deepseek-ai/deepseek-v3.2-maas", &["global"]),
    ("deepseek-ai/deepseek-v3.1-maas", &["us-central1"]),
    ("deepseek-ai/deepseek-r1-0528-maas", &["us-central1"]),
    ("qwen/qwen3-coder-480b-a35b-instruct-maas", &["global", "us-south1"]),
    ("qwen/qwen3-next-80b-a3b-instruct-maas", &["global"]),
    ("qwen/qwen3-next-80b-a3b-thinking-maas", &["global"]),
    ("zai-org/glm-5.2-maas", &["global"]),
    ("zai-org/glm-5-maas", &["global"]),
    ("zai-org/glm-4.7-maas", &["global"]),
    ("moonshotai/kimi-k2-thinking-maas", &["global"]),
    ("minimaxai/minimax-m2-maas", &["global"]),
    ("openai/gpt-oss-120b-maas", &["global", "us-central1"]),
    ("openai/gpt-oss-20b-maas", &["us-central1"]),
    ("meta/llama-4-maverick-17b-128e-instruct-maas", &["us-east5"]),
    ("meta/llama-4-scout-17b-16e-instruct-maas", &["us-east5"]),
    ("google/gemma-4-26b-a4b-it-maas", &["global"]),
    ("xai/grok-4.7", &["global", "us"]),
    ("xai/grok-4.6", &["global", "us"]),
    ("xai/grok-4.3", &["global"]),
    ("xai/grok-4.20-reasoning", &["global"]),
    ("xai/grok-4.20-non-reasoning", &["global"]),
];

fn listed_locations(key: &str) -> Option<&'static [&'static str]> {
    LISTED_LOCATIONS.iter().find(|(k, _)| *k == key).map(|(_, l)| *l)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Wire {
    Gemini,
    Claude,
    Maas,
}

#[derive(Clone, Copy, Debug)]
pub struct Route<'a> {
    pub publisher: &'a str,
    pub id: &'a str,
    pub wire: Wire,
}

/// The PayGo tier a send asks for.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tier {
    Standard,
    Flex,
    Priority,
}

impl Tier {
    /// `modelParameters.serviceTier`: `flex` or `priority`, else standard.
    pub fn requested(model_parameters: Option<&Value>) -> Self {
        let text = model_parameters.and_then(|p| p.get("serviceTier")).and_then(Value::as_str).unwrap_or("");
        match text.to_lowercase().as_str() {
            "flex" => Self::Flex,
            "priority" => Self::Priority,
            _ => Self::Standard,
        }
    }

    /// The `X-Vertex-AI-LLM-Shared-Request-Type` value.
    pub fn header_value(self) -> Option<&'static str> {
        match self {
            Self::Standard => None,
            Self::Flex => Some("flex"),
            Self::Priority => Some("priority"),
        }
    }
}

/// A Claude model id without its `@version` and Anthropic's `-YYYYMMDD` snapshot suffix.
fn claude_base(id: &str) -> &str {
    let id = id.split('@').next().unwrap_or(id);
    match id.rsplit_once('-') {
        Some((head, tail)) if tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => id,
    }
}

/// Leading ASCII digits (at most `max`, all of them when `None`) and the rest.
fn digits(text: &str, max: Option<usize>) -> Option<(u32, &str)> {
    let len = text.bytes().take_while(u8::is_ascii_digit).count();
    let len = max.map_or(len, |m| len.min(m));
    (len > 0).then(|| (text[..len].parse().unwrap_or(u32::MAX), &text[len..]))
}

/// `[major, minor]` of a Claude id (claude-opus-4-8, claude-sonnet-5, claude-3-7-sonnet).
pub fn claude_version(id: &str) -> Option<(u32, u32)> {
    let bare = id.split('@').next().unwrap_or(id);
    let rest = bare.strip_prefix("claude-")?;
    // claude-<family>-<major>[-<minor>](-|end)
    let letters = rest.bytes().take_while(u8::is_ascii_lowercase).count();
    if letters > 0
        && let Some((major, after)) = rest[letters..].strip_prefix('-').and_then(|r| digits(r, None))
    {
        let tail_ok = |r: &str| r.is_empty() || r.starts_with('-');
        for width in [2, 1] {
            if let Some((minor, r)) = after.strip_prefix('-').and_then(|a| digits(a, Some(width)))
                && tail_ok(r)
            {
                return Some((major, minor));
            }
        }
        if tail_ok(after) {
            return Some((major, 0));
        }
    }
    // claude-<major>[-<minor>]-<letter>
    let (major, after) = digits(rest, None)?;
    let letter_next = |r: &str| r.strip_prefix('-').is_some_and(|x| x.starts_with(|c: char| c.is_ascii_lowercase()));
    for width in [2, 1] {
        if let Some((minor, r)) = after.strip_prefix('-').and_then(|a| digits(a, Some(width)))
            && letter_next(r)
        {
            return Some((major, minor));
        }
    }
    letter_next(after).then_some((major, 0))
}

/// A Claude model's own region variables: VERTEX_REGION_CLAUDE_4_5_SONNET, VERTEX_REGION_CLAUDE_SONNET_4_5.
fn claude_region_env(id: &str) -> Vec<String> {
    let Some((major, minor)) = claude_version(id) else { return Vec::new() };
    let rest = id.strip_prefix("claude-").unwrap_or("");
    let letters_of = |r: &str| {
        let n = r.bytes().take_while(u8::is_ascii_lowercase).count();
        (n > 0).then(|| r[..n].to_uppercase())
    };
    let family = match digits(rest, None) {
        Some((_, after)) => after.strip_prefix('-').and_then(|r| {
            let skipped = digits(r, Some(2)).and_then(|(_, a)| a.strip_prefix('-')).and_then(letters_of);
            skipped.or_else(|| letters_of(r))
        }),
        None => letters_of(rest),
    };
    let Some(family) = family else { return Vec::new() };
    vec![
        format!("VERTEX_REGION_CLAUDE_{major}_{minor}_{family}"),
        format!("VERTEX_REGION_CLAUDE_{family}_{major}_{minor}"),
    ]
}

/// The region the environment names, for use only when no location is
/// configured: a Claude model's own `VERTEX_REGION_CLAUDE_*` first.
pub fn env_location(get: impl Fn(&str) -> Option<String>, claude_id: &str) -> Option<String> {
    let claude = if claude_id.is_empty() { Vec::new() } else { claude_region_env(claude_id) };
    claude
        .iter()
        .map(String::as_str)
        .chain(LOCATION_ENV)
        .find_map(|name| get(name).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()))
}

/// Why Vertex does not serve a model / location / tier combination, or `None`.
pub fn serving_problem(route: &Route<'_>, location: &str, tier: Tier) -> Option<String> {
    if tier == Tier::Flex {
        if route.wire != Wire::Gemini || !FLEX_MODELS.contains(&route.id) {
            return Some(format!("[vertex-ai] Flex PayGo is not available for {}", route.id));
        }
        if location != "global" {
            return Some("[vertex-ai] Flex PayGo is only available with the global location".into());
        }
    }
    if tier == Tier::Priority {
        if route.wire != Wire::Gemini || !PRIORITY_MODELS.contains(&route.id) {
            return Some(format!("[vertex-ai] Priority PayGo is not available for {}", route.id));
        }
        if !PRIORITY_LOCATIONS.contains(&location) {
            return Some("[vertex-ai] Priority PayGo is only available with the global, us or eu location".into());
        }
    }
    let served = (route.wire == Wire::Maas).then(|| listed_locations(&format!("{}/{}", route.publisher, route.id))).flatten();
    if let Some(served) = served
        && !served.contains(&location)
    {
        return Some(format!(
            "[vertex-ai] {}/{} is served only in: {} (location is {location})",
            route.publisher,
            route.id,
            served.join(", ")
        ));
    }
    let claude_id = if route.wire == Wire::Claude { claude_base(route.id) } else { "" };
    let earlier = EARLIER_CLAUDE.contains(&claude_id);
    if MULTI_REGIONS.contains(&location) && (earlier || CLAUDE_4_5_TO_4_6.contains(&claude_id)) {
        return Some(format!(
            "[vertex-ai] {} is not served on the {location} multi-region endpoint (Claude 4.7 and later only); use the global location or a region",
            route.id
        ));
    }
    if location == "global" && earlier && !GLOBAL_EARLIER_CLAUDE.contains(&claude_id) {
        let variable = claude_region_env(claude_id).into_iter().next().unwrap_or_else(|| "undefined".into());
        return Some(format!(
            "[vertex-ai] {} is not served on the global endpoint; set the location to a region that serves it \
             (for example us-east5), or with no location set, {variable}",
            route.id
        ));
    }
    None
}

/// The account a Vertex adapter sends as.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VertexAccount {
    /// An API key on the global endpoint.
    Express,
    Project(String),
}

/// Everything that decides a request's Vertex location.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VertexPlace {
    pub account: VertexAccount,
    /// The location the user configured; never moved.
    pub configured: Option<String>,
    /// The environment's region ([`env_location`]); used only when nothing is configured.
    pub environment: Option<String>,
}

fn valid_location(location: &str) -> bool {
    location.len() <= 63
        && location.starts_with(|c: char| c.is_ascii_lowercase())
        && location.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl VertexPlace {
    pub fn express() -> Self {
        Self { account: VertexAccount::Express, configured: None, environment: None }
    }

    pub fn project(project: impl Into<String>, configured: Option<&str>, environment: Option<&str>) -> Self {
        Self {
            account: VertexAccount::Project(project.into()),
            configured: configured.map(str::to_owned),
            environment: environment.map(str::to_owned),
        }
    }

    pub fn project_id(&self) -> Option<&str> {
        match &self.account {
            VertexAccount::Express => None,
            VertexAccount::Project(p) => Some(p),
        }
    }

    /// The location one request goes to, or why none can serve it.
    pub fn choose(&self, route: &Route<'_>, tier: Tier) -> Result<String, ProviderError> {
        let configured = self.configured.as_deref().map(str::trim).filter(|c| !c.is_empty());
        let pinned = configured.is_some();
        let requested = configured.or(self.environment.as_deref()).unwrap_or("global").trim().to_lowercase();
        if !valid_location(&requested) {
            return Err(invalid("[vertex-ai] location is invalid"));
        }
        let express = matches!(self.account, VertexAccount::Express);
        if express && pinned && requested != "global" {
            return Err(invalid(
                "[vertex-ai] a Vertex AI express mode API key serves only the global location; set the location to global",
            ));
        }
        let mut location = if express { "global".to_owned() } else { requested };
        let serves = |at: &str| serving_problem(route, at, tier).is_none();
        if !pinned && location != "global" && !serves(&location) && serves("global") {
            location = "global".into();
        }
        match serving_problem(route, &location, tier) {
            Some(problem) => Err(invalid(problem)),
            None => Ok(location),
        }
    }

    /// `https://{host}/v1[/projects/{project}/locations/{location}]`.
    pub fn base(&self, location: &str) -> Result<String, ProviderError> {
        match &self.account {
            VertexAccount::Express => Ok(EXPRESS_BASE.to_owned()),
            VertexAccount::Project(project) => project_base(project, location),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gemini(id: &str) -> Route<'_> {
        Route { publisher: "google", id, wire: Wire::Gemini }
    }

    fn claude(id: &str) -> Route<'_> {
        Route { publisher: "anthropic", id, wire: Wire::Claude }
    }

    fn maas<'a>(publisher: &'a str, id: &'a str) -> Route<'a> {
        Route { publisher, id, wire: Wire::Maas }
    }

    #[test]
    fn tiers_need_a_listed_gemini_model_and_their_locations() {
        assert!(serving_problem(&gemini("gemini-3.6-flash"), "global", Tier::Flex).is_none());
        assert_eq!(
            serving_problem(&gemini("gemini-3.6-flash"), "us-central1", Tier::Flex).unwrap(),
            "[vertex-ai] Flex PayGo is only available with the global location"
        );
        assert_eq!(
            serving_problem(&gemini("gemini-2.5-pro"), "global", Tier::Flex).unwrap(),
            "[vertex-ai] Flex PayGo is not available for gemini-2.5-pro"
        );
        assert_eq!(
            serving_problem(&claude("claude-opus-4-6"), "global", Tier::Priority).unwrap(),
            "[vertex-ai] Priority PayGo is not available for claude-opus-4-6"
        );
        assert!(serving_problem(&gemini("gemini-3.6-flash"), "eu", Tier::Priority).is_none());
        assert_eq!(
            serving_problem(&gemini("gemini-3.6-flash"), "us-east5", Tier::Priority).unwrap(),
            "[vertex-ai] Priority PayGo is only available with the global, us or eu location"
        );
    }

    #[test]
    fn listed_open_models_are_sent_only_where_they_are_served() {
        assert!(serving_problem(&maas("zai-org", "glm-5-maas"), "global", Tier::Standard).is_none());
        assert_eq!(
            serving_problem(&maas("meta", "llama-4-scout-17b-16e-instruct-maas"), "global", Tier::Standard).unwrap(),
            "[vertex-ai] meta/llama-4-scout-17b-16e-instruct-maas is served only in: us-east5 (location is global)"
        );
        // The last catalog row is found too, and an unlisted id is unchecked.
        assert!(serving_problem(&maas("xai", "grok-4.20-non-reasoning"), "us", Tier::Standard).is_some());
        assert!(serving_problem(&maas("acme", "free-form-maas"), "us", Tier::Standard).is_none());
    }

    #[test]
    fn claude_rules_enumerate_the_older_models() {
        let on = |id: &str, at: &str| serving_problem(&claude(id), at, Tier::Standard);
        assert!(on("claude-3-5-haiku", "global").unwrap().contains("VERTEX_REGION_CLAUDE_3_5_HAIKU"));
        assert!(on("claude-3-7-sonnet", "global").is_none());
        assert!(on("claude-opus-4-6", "us").unwrap().contains("not served on the us multi-region endpoint"));
        assert!(on("claude-opus-4-7", "eu").is_none());
        // A snapshot suffix and `@version` do not change the model.
        assert!(on("claude-opus-4-1-20250805", "global").is_some());
        assert!(on("claude-opus-4-1@20250805", "us-east5").is_none());
        // An id in no set is a newer model.
        assert!(on("claude-opus-9", "global").is_none());
    }

    #[test]
    fn claude_versions_and_region_variables() {
        assert_eq!(claude_version("claude-opus-4-8"), Some((4, 8)));
        assert_eq!(claude_version("claude-sonnet-5"), Some((5, 0)));
        assert_eq!(claude_version("claude-3-7-sonnet"), Some((3, 7)));
        assert_eq!(claude_version("claude-opus-4-20250514"), Some((4, 0)));
        assert_eq!(claude_version("gemini-3"), None);
        assert_eq!(
            claude_region_env("claude-sonnet-4-5"),
            ["VERTEX_REGION_CLAUDE_4_5_SONNET", "VERTEX_REGION_CLAUDE_SONNET_4_5"]
        );
        assert_eq!(claude_region_env("claude-3-5-haiku")[0], "VERTEX_REGION_CLAUDE_3_5_HAIKU");
        let env = |name: &str| match name {
            "VERTEX_REGION_CLAUDE_4_5_SONNET" => Some(" us-east5 ".to_owned()),
            "CLOUD_ML_REGION" => Some("europe-west4".to_owned()),
            _ => None,
        };
        assert_eq!(env_location(env, "claude-sonnet-4-5").as_deref(), Some("us-east5"));
        assert_eq!(env_location(env, "").as_deref(), Some("europe-west4"));
        assert_eq!(env_location(|_| None, ""), None);
    }

    #[test]
    fn tier_comes_from_the_service_tier_parameter() {
        assert_eq!(Tier::requested(Some(&json!({"serviceTier":"Flex"}))), Tier::Flex);
        assert_eq!(Tier::requested(Some(&json!({"serviceTier":"priority"}))), Tier::Priority);
        assert_eq!(Tier::requested(Some(&json!({"serviceTier":"standard"}))), Tier::Standard);
        assert_eq!(Tier::requested(None), Tier::Standard);
    }

    #[test]
    fn an_environment_region_gives_way_to_global_but_a_configured_one_never_moves() {
        let flex = gemini("gemini-3.6-flash");
        let from_env = VertexPlace::project("p", None, Some("us-central1"));
        assert_eq!(from_env.choose(&flex, Tier::Flex).unwrap(), "global");
        assert_eq!(from_env.choose(&flex, Tier::Standard).unwrap(), "us-central1");
        let pinned = VertexPlace::project("p", Some(" US-Central1 "), None);
        assert_eq!(pinned.choose(&flex, Tier::Standard).unwrap(), "us-central1");
        assert!(pinned.choose(&flex, Tier::Flex).unwrap_err().message.contains("only available with the global"));
        // A region that cannot serve and a global that cannot either: the problem is the region's.
        let llama = maas("meta", "llama-4-scout-17b-16e-instruct-maas");
        let from_env = VertexPlace::project("p", None, Some("us-east5"));
        assert_eq!(from_env.choose(&llama, Tier::Standard).unwrap(), "us-east5");
        let other = VertexPlace::project("p", None, Some("europe-west1"));
        assert!(other.choose(&llama, Tier::Standard).unwrap_err().message.contains("served only in: us-east5"));
        // The default is global.
        assert_eq!(VertexPlace::project("p", None, None).choose(&flex, Tier::Standard).unwrap(), "global");
        assert!(VertexPlace::project("p", Some("us/../x"), None).choose(&flex, Tier::Standard).is_err());
    }

    #[test]
    fn express_mode_is_global_only() {
        let route = gemini("gemini-3.6-flash");
        let express = VertexPlace::express();
        assert_eq!(express.choose(&route, Tier::Standard).unwrap(), "global");
        assert_eq!(express.base("global").unwrap(), EXPRESS_BASE);
        let pinned = VertexPlace { configured: Some("us-central1".into()), ..VertexPlace::express() };
        assert!(pinned.choose(&route, Tier::Standard).unwrap_err().message.contains("express mode API key serves only the global"));
        let env = VertexPlace { environment: Some("us-central1".into()), ..VertexPlace::express() };
        assert_eq!(env.choose(&route, Tier::Standard).unwrap(), "global");
    }
}
