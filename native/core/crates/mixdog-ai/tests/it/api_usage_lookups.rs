//! What each provider's usage lookup asks and how it reads the answer into a snapshot: OpenAI's four sources in order,
//! Anthropic's cost report, Gemini's key probe and xAI's prepaid balance, over a scripted network.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::registry::keys::ApiKeyStore;
use mixdog_ai::registry::keys::Environment;
use mixdog_ai::registry::keys::MemoryVault;
use mixdog_ai::service::api_usage::ApiUsageService;
use mixdog_ai::service::oauth_usage::UsageError;
use mixdog_ai::service::oauth_usage::UsageHttp;
use mixdog_ai::service::oauth_usage::UsageResponse;
use serde_json::Value;
use serde_json::json;

struct Env(HashMap<String, String>);

impl Environment for Env {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

/// Answers by URL prefix (the first rule that matches), 404 with `{}` otherwise; records every request.
struct Net {
    rules: Vec<(&'static str, u16, String)>,
    seen: Mutex<Vec<(String, Vec<(String, String)>)>>,
}

#[async_trait]
impl UsageHttp for Net {
    async fn get(&self, url: &str, headers: &[(String, String)], _timeout: Duration) -> Result<UsageResponse, UsageError> {
        self.seen.lock().unwrap().push((url.to_owned(), headers.to_vec()));
        let (status, body) = self.rules.iter().find(|(prefix, ..)| url.starts_with(prefix)).map_or((404, "{}".to_owned()), |(_, status, body)| (*status, body.clone()));
        Ok(UsageResponse { status, body })
    }

    async fn post_json(&self, _url: &str, _headers: &[(String, String)], _body: &Value, _timeout: Duration) -> Result<UsageResponse, UsageError> {
        unreachable!("no usage lookup posts")
    }
}

/// Every number as a float: a whole number may be read as an integer or a float and mean the same.
fn f(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64()),
        Value::Array(items) => Value::Array(items.iter().map(f).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), f(v))).collect()),
        other => other.clone(),
    }
}

const NOW: i64 = 1_700_000_000_000;

struct Lookup {
    service: ApiUsageService,
    net: Arc<Net>,
    _dir: tempfile::TempDir,
}

fn lookup(env: &[(&str, &str)], rules: Vec<(&'static str, u16, Value)>) -> Lookup {
    let dir = tempfile::tempdir().unwrap();
    let vault = Arc::new(MemoryVault::default());
    let env: Arc<dyn Environment> = Arc::new(Env(env.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()));
    let net = Arc::new(Net { rules: rules.into_iter().map(|(prefix, status, body)| (prefix, status, body.to_string())).collect(), seen: Mutex::default() });
    let tokens = mixdog_rt::testing::tokens();
    let service = ApiUsageService::new(
        net.clone(),
        ApiKeyStore::new(vault.clone(), env.clone(), false),
        vault,
        env,
        CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        dir.path().to_path_buf(),
        Arc::new(|| NOW),
    );
    Lookup { service, net, _dir: dir }
}

impl Lookup {
    async fn snapshot(&self, provider: &str) -> Option<Value> {
        self.service.fetch(provider, true).await.expect("the lookup answers")
    }

    fn urls(&self) -> Vec<String> {
        self.net.seen.lock().unwrap().iter().map(|(url, _)| url.clone()).collect()
    }

    fn header(&self, call: usize, name: &str) -> Option<String> {
        self.net.seen.lock().unwrap()[call].1.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
    }
}

#[tokio::test]
async fn a_provider_nobody_looks_up_and_one_without_a_key_have_no_snapshot() {
    let l = lookup(&[], Vec::new());
    assert_eq!(l.snapshot("somebody-else").await, None);
    assert_eq!(l.snapshot("deepseek").await, None);
    assert_eq!(l.snapshot("gemini").await, None);
    assert!(l.urls().is_empty(), "nothing is asked without a key");
}

#[tokio::test]
async fn the_provider_name_is_read_trimmed_and_lowercase() {
    let l = lookup(&[("GEMINI_API_KEY", "k")], vec![("https://generativelanguage", 200, json!({}))]);
    assert_eq!(l.snapshot("  GeMiNi ").await.unwrap()["provider"], "gemini");
}

#[tokio::test]
async fn xai_with_a_management_key_and_team_reads_the_prepaid_balance_in_dollars() {
    let env = [("XAI_MANAGEMENT_API_KEY", "mgmt"), ("XAI_TEAM_ID", "team/a b")];
    let l = lookup(&env, vec![("https://management-api.x.ai/", 200, json!({"total": "$1,234.56789"}))]);
    let snapshot = l.snapshot("xai").await.unwrap();
    assert_eq!(l.urls(), ["https://management-api.x.ai/v1/billing/teams/team%2Fa%20b/prepaid/balance"], "the team is one path segment");
    assert_eq!(l.header(0, "authorization").as_deref(), Some("Bearer mgmt"));
    assert_eq!(snapshot["source"], "xai-management-prepaid-balance");
    assert_eq!(f(&snapshot["balance"]), f(&json!({"remainingUsd": 1234.5679, "currency": "USD", "source": "xai-management-prepaid-balance"})));
}

#[tokio::test]
async fn a_prepaid_balance_may_be_given_in_cents_or_in_a_named_field_and_an_unreadable_one_is_no_snapshot() {
    for (body, usd) in [(json!({"balance": {"cents": 250}}), Some(2.5)), (json!({"availableCredits": 7}), Some(7.0)), (json!({"credits": {"usd": "3.25"}}), Some(3.25)), (json!({"credits": true}), None), (json!({"unrelated": 1}), None)] {
        let l = lookup(&[("XAI_MANAGEMENT_API_KEY", "m"), ("XAI_TEAM_ID", "t")], vec![("https://management-api.x.ai/", 200, body.clone())]);
        let got = l.snapshot("xai").await.map(|s| s["balance"]["remainingUsd"].as_f64().unwrap());
        assert_eq!(got, usd, "{body}");
    }
}

#[tokio::test]
async fn xai_without_management_credentials_probes_the_public_endpoints_in_order() {
    let l = lookup(&[("XAI_API_KEY", "k")], vec![("https://api.x.ai/v1/usage", 404, json!({})), ("https://api.x.ai/v1/rate_limits", 200, json!({"balance": 4}))]);
    let snapshot = l.snapshot("xai").await.unwrap();
    assert_eq!(l.urls(), ["https://api.x.ai/v1/usage", "https://api.x.ai/v1/rate_limits"]);
    assert_eq!((snapshot["source"].clone(), snapshot["balance"]["source"].clone()), (json!("xai-public-usage-probe"), json!("xai-public-usage-probe")));
    assert_eq!(snapshot["balance"]["remainingUsd"].as_f64(), Some(4.0));
    let unsupported = lookup(&[("XAI_API_KEY", "k")], vec![("https://api.x.ai/v1/usage", 200, json!({"x": 1}))]);
    assert_eq!(unsupported.snapshot("xai").await.unwrap()["unavailable"]["message"], "xAI public usage probe returned unsupported data from https://api.x.ai/v1/usage");
    let failing = lookup(&[("XAI_API_KEY", "k")], vec![("https://api.x.ai/v1/usage", 403, json!({"error": {"message": "no access"}}))]);
    let unavailable = failing.snapshot("xai").await.unwrap();
    assert_eq!((unavailable["unavailable"]["status"].clone(), unavailable["unavailable"]["message"].clone()), (json!(403), json!("no access")), "the first failure is the one reported");
}

#[tokio::test]
async fn xai_with_no_credential_at_all_says_what_to_set() {
    let none = lookup(&[], Vec::new());
    assert_eq!(none.snapshot("xai").await.unwrap()["unavailable"]["message"], "Set XAI_MANAGEMENT_API_KEY and XAI_TEAM_ID for prepaid balance");
    let half = lookup(&[("XAI_MANAGEMENT_API_KEY", "m")], Vec::new());
    assert_eq!(half.snapshot("xai").await.unwrap()["unavailable"]["message"], "Set XAI_MANAGEMENT_API_KEY and XAI_TEAM_ID for prepaid balance", "the team is needed too");
}

#[tokio::test]
async fn gemini_only_proves_the_key_and_says_the_balance_is_elsewhere() {
    let l = lookup(&[("GEMINI_API_KEY", "a b&c")], vec![("https://generativelanguage.googleapis.com/", 200, json!({"models": []}))]);
    let snapshot = l.snapshot("gemini").await.unwrap();
    assert_eq!(l.urls(), ["https://generativelanguage.googleapis.com/v1beta/models?key=a%20b%26c"], "the key is escaped as a URI component");
    assert_eq!(snapshot["source"], "provider-api-unavailable");
    assert_eq!(snapshot["unavailable"], json!({"status": null, "message": "Gemini API key valid; balance/usage is AI Studio or Cloud Billing only"}));
    let bad = lookup(&[("GEMINI_API_KEY", "k")], vec![("https://generativelanguage", 400, json!({"error": {"message": " API key not valid "}}))]);
    assert_eq!(bad.snapshot("gemini").await.unwrap()["unavailable"], json!({"status": 400, "message": "API key not valid"}));
}

#[tokio::test]
async fn anthropic_without_an_admin_key_says_what_to_set() {
    let l = lookup(&[], Vec::new());
    assert_eq!(l.snapshot("anthropic").await.unwrap()["unavailable"]["message"], "Set ANTHROPIC_ADMIN_API_KEY for usage/cost report");
    assert!(l.urls().is_empty());
}

#[tokio::test]
async fn the_anthropic_cost_report_sums_the_usd_cents_of_every_bucket_into_dollars() {
    let body = json!({"data": [{"results": [{"currency": "USD", "amount": "150"}, {"currency": "eur", "amount": 999}]}, {"results": [{"amount": 50}]}]});
    let l = lookup(&[("ANTHROPIC_ADMIN_API_KEY", "admin")], vec![("https://api.anthropic.com/v1/organizations/cost_report", 200, body)]);
    let snapshot = l.snapshot("anthropic").await.unwrap();
    assert_eq!(f(&snapshot["balance"]), f(&json!({"usedUsd": 2.0, "source": "anthropic-cost-report"})), "150 + 50 cents; another currency is not summed");
    let url = &l.urls()[0];
    assert!(url.starts_with("https://api.anthropic.com/v1/organizations/cost_report?starting_at=2023-10-14T22%3A13%3A20.000Z&bucket_width=1d&limit=31"), "{url}");
    assert_eq!(l.header(0, "anthropic-version").as_deref(), Some("2023-06-01"));
    assert_eq!(l.header(0, "authorization").as_deref(), Some("Bearer admin"), "the bearer form is tried first");
}

#[tokio::test]
async fn a_refused_bearer_is_retried_as_an_api_key_and_every_key_is_tried_before_giving_up() {
    let l = lookup(&[("ANTHROPIC_ADMIN_API_KEY", "one"), ("ANTHROPIC_ADMIN_KEY", "two")], vec![("https://api.anthropic.com/", 401, json!({"error": {"message": "invalid x-api-key"}}))]);
    let snapshot = l.snapshot("anthropic").await.unwrap();
    assert_eq!(l.urls().len(), 4, "two keys, each as a bearer and as x-api-key");
    assert_eq!((l.header(0, "authorization").as_deref(), l.header(1, "x-api-key").as_deref()), (Some("Bearer one"), Some("one")));
    assert_eq!(l.header(2, "authorization").as_deref(), Some("Bearer two"));
    assert_eq!(snapshot["unavailable"], json!({"status": 401, "message": "invalid x-api-key"}));
    let server_error = lookup(&[("ANTHROPIC_ADMIN_API_KEY", "k")], vec![("https://api.anthropic.com/", 500, json!({}))]);
    assert!(server_error.service.fetch("anthropic", true).await.is_err(), "only a refusal moves on; a server error is the caller's");
    assert_eq!(server_error.urls().len(), 1);
}

#[tokio::test]
async fn a_cost_report_without_a_data_list_is_unavailable_and_an_empty_one_is_a_zero_reading() {
    let none = lookup(&[("ANTHROPIC_ADMIN_API_KEY", "k")], vec![("https://api.anthropic.com/", 200, json!({"unrelated": true}))]);
    assert_eq!(none.snapshot("anthropic").await.unwrap()["unavailable"]["message"], "Anthropic cost report returned no usage data");
    let empty = lookup(&[("ANTHROPIC_ADMIN_API_KEY", "k")], vec![("https://api.anthropic.com/", 200, json!({"data": []}))]);
    assert_eq!(empty.snapshot("anthropic").await.unwrap()["balance"]["usedUsd"], 0.0);
}

const GRANTS: &str = "https://api.openai.com/dashboard/billing/credit_grants";

#[tokio::test]
async fn openai_credit_grants_give_the_remaining_balance_and_the_nearest_expiry_in_milliseconds() {
    let body = json!({"total_available": 12.34567, "total_used": 1, "total_granted": 13.34567, "grants": {"data": [{"expires_at": 1_800_000_000u64}, {"expires_at": 1_700_000_000_000u64}, {"expires_at": 0}]}});
    let l = lookup(&[("OPENAI_API_KEY", "sk")], vec![(GRANTS, 200, body)]);
    let snapshot = l.snapshot("openai").await.unwrap();
    assert_eq!(snapshot["source"], "openai-credit-grants");
    assert_eq!(snapshot["balance"]["remainingUsd"], 12.3457);
    assert_eq!(f(&snapshot["creditGrants"]), f(&json!({"usedUsd": 1.0, "limitUsd": 13.3457, "nextExpiry": 1_700_000_000_000.0})), "an expiry in seconds is read as seconds");
    assert_eq!(l.urls(), [GRANTS], "the first source that answers ends the lookup");
}

#[tokio::test]
async fn the_usage_session_key_is_tried_for_credit_grants_before_the_api_key() {
    let l = lookup(&[("OPENAI_API_KEY", "sk"), ("OPENAI_USAGE_SESSION_KEY", "sess")], vec![(GRANTS, 200, json!({"total_available": 1}))]);
    l.snapshot("openai").await.unwrap();
    assert_eq!(l.header(0, "authorization").as_deref(), Some("Bearer sess"));
}

#[tokio::test]
async fn without_credit_grants_a_session_key_reads_the_dashboard_limit_and_the_cents_used() {
    let rules = vec![
        (GRANTS, 404, json!({})),
        ("https://api.openai.com/dashboard/billing/subscription", 200, json!({"hard_limit_usd": 100})),
        ("https://api.openai.com/dashboard/billing/usage", 200, json!({"total_usage": 2500})),
    ];
    let l = lookup(&[("OPENAI_USAGE_SESSION_KEY", "sess")], rules);
    let snapshot = l.snapshot("openai").await.unwrap();
    assert_eq!(f(&snapshot["balance"]), f(&json!({"source": "openai-dashboard-billing", "usedUsd": 25.0, "limitUsd": 100.0, "remainingUsd": 75.0})));
    assert!(l.urls().contains(&"https://api.openai.com/dashboard/billing/usage?start_date=2023-10-14&end_date=2023-11-14".to_owned()), "{:?}", l.urls());
}

#[tokio::test]
async fn without_a_dashboard_the_organization_costs_are_summed_over_the_last_31_days() {
    let body = json!({"data": [{"results": [{"amount": {"value": 1.5}}, {"amount": {"usd": "2"}}, {"amount": "x"}]}, {"results": []}]});
    let l = lookup(&[("OPENAI_API_KEY", "sk")], vec![(GRANTS, 404, json!({})), ("https://api.openai.com/v1/organization/costs", 200, body)]);
    let snapshot = l.snapshot("openai").await.unwrap();
    assert_eq!(f(&snapshot["balance"]), f(&json!({"usedUsd": 3.5, "source": "openai-organization-costs"})));
    assert!(l.urls().contains(&"https://api.openai.com/v1/organization/costs?start_time=1697321600&limit=31".to_owned()), "{:?}", l.urls());
}

#[tokio::test]
async fn a_refused_costs_report_falls_to_the_completion_token_totals_and_other_failures_are_errors() {
    let usage = json!({"data": [{"results": [{"input_tokens": 10, "output_tokens": 5, "input_cached_tokens": 2, "num_model_requests": 1}, {"input_tokens": 1}]}]});
    let l = lookup(&[("OPENAI_API_KEY", "sk")], vec![("https://api.openai.com/v1/organization/costs", 403, json!({})), ("https://api.openai.com/v1/organization/usage/completions", 200, usage)]);
    let snapshot = l.snapshot("openai").await.unwrap();
    assert_eq!(f(&snapshot["tokenUsage"]), f(&json!({"inputTokens": 11.0, "outputTokens": 5.0, "cachedInputTokens": 2.0, "requests": 1.0, "source": "openai-organization-usage-completions"})));
    assert!(l.urls().last().unwrap().starts_with("https://api.openai.com/v1/organization/usage/completions?start_time=1697321600&bucket_width=1d&limit=31"));
    let broken = lookup(&[("OPENAI_API_KEY", "sk")], vec![("https://api.openai.com/v1/organization/costs", 500, json!({}))]);
    assert!(broken.service.fetch("openai", true).await.is_err());
    let nothing = lookup(&[("OPENAI_API_KEY", "sk")], vec![("https://api.openai.com/v1/organization/costs", 200, json!({"data": []})), ("https://api.openai.com/v1/organization/usage/completions", 200, json!({"nodata": 1}))]);
    assert_eq!(nothing.snapshot("openai").await, None, "no source gave a reading");
}
