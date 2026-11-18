//! A URL that passes the policy is admitted only when every address its name resolves to passes too.

use std::collections::HashMap;

use async_trait::async_trait;
use mixdog_browser_policy::url_admission::Resolve;
use mixdog_browser_policy::url_admission::ResolveFailed;
use mixdog_browser_policy::url_admission::UrlAdmission;
use mixdog_browser_policy::url_admission::admit_resolved;
use mixdog_browser_policy::url_policy::MailLink;
use mixdog_browser_policy::url_policy::UrlPolicy;

/// A resolver with a fixed table; a name that is absent (or mapped to `None`) fails to resolve.
struct Table(HashMap<&'static str, Option<Vec<String>>>);

#[async_trait]
impl Resolve for Table {
    async fn lookup(&self, hostname: &str) -> Result<Vec<String>, ResolveFailed> {
        self.0.get(hostname).cloned().flatten().ok_or(ResolveFailed)
    }
}

fn table(rows: &[(&'static str, &[&str])]) -> Table {
    Table(rows.iter().map(|(name, addresses)| (*name, Some(addresses.iter().map(|a| (*a).to_owned()).collect()))).collect())
}

fn local() -> UrlPolicy {
    UrlPolicy { allow_private_network: true, allowed_domains: vec![] }
}

async fn url(address: &str, policy: UrlPolicy, resolver: &Table) -> Result<(), String> {
    UrlAdmission::new(policy).assert_resolved_url_allowed(address, false, resolver).await.map_err(|r| r.reason)
}

const BLOCKED: &str = "blocked private or internal address";

#[tokio::test]
async fn a_name_that_resolves_to_a_public_address_is_admitted() {
    let resolver = table(&[("example.test", &["93.184.216.34"]), ("v6.example.test", &["2606:4700::1111"])]);
    assert_eq!(url("https://example.test/", UrlPolicy::default(), &resolver).await, Ok(()));
    assert_eq!(url("https://v6.example.test/", UrlPolicy::default(), &resolver).await, Ok(()));
}

#[tokio::test]
async fn a_public_name_resolving_to_a_private_address_is_refused_unless_the_session_is_local() {
    let resolver = table(&[
        ("rebind.example.test", &["192.168.1.10"]),
        ("ts.example.test", &["100.101.102.103"]),
        ("mapped.example.test", &["::ffff:10.0.0.1"]),
        ("v6ula.example.test", &["fd00::1"]),
    ]);
    for (name, address) in
        [("rebind", "192.168.1.10"), ("ts", "100.101.102.103"), ("mapped", "::ffff:10.0.0.1"), ("v6ula", "fd00::1")]
    {
        let url_text = format!("https://{name}.example.test/");
        assert_eq!(
            url(&url_text, UrlPolicy::default(), &resolver).await,
            Err(format!("navigation to {name}.example.test resolved to {BLOCKED} {address}")),
            "{name}"
        );
        assert_eq!(url(&url_text, local(), &resolver).await, Ok(()), "{name} in a local session");
    }
}

#[tokio::test]
async fn a_metadata_answer_is_refused_even_in_a_local_session() {
    let resolver = table(&[("meta.example.test", &["169.254.169.254"]), ("mixed.example.test", &["93.184.216.34", "169.254.169.254"])]);
    for name in ["meta", "mixed"] {
        for policy in [UrlPolicy::default(), local()] {
            assert_eq!(
                url(&format!("https://{name}.example.test/"), policy, &resolver).await,
                Err(format!("navigation to {name}.example.test resolved to a blocked cloud metadata endpoint"))
            );
        }
    }
}

#[tokio::test]
async fn one_private_address_among_several_refuses_the_name() {
    let resolver = table(&[("mixed.example.test", &["93.184.216.34", "10.0.0.1"])]);
    assert_eq!(
        url("https://mixed.example.test/", UrlPolicy::default(), &resolver).await,
        Err(format!("navigation to mixed.example.test resolved to {BLOCKED} 10.0.0.1"))
    );
}

#[tokio::test]
async fn an_empty_failed_or_oversized_answer_refuses_the_name() {
    let many = |count: usize| (1..=count).map(|n| format!("93.184.216.{n}")).collect::<Vec<_>>();
    let resolver = Table(HashMap::from([
        ("empty.example.test", Some(vec![])),
        ("fail.example.test", None),
        ("sixty-four.example.test", Some(many(64))),
        ("sixty-five.example.test", Some(many(65))),
    ]));
    let ask = |name: &str| url_via(format!("https://{name}/"), &resolver);
    assert_eq!(ask("empty.example.test").await, Err("navigation to empty.example.test returned no addresses for private-network validation".into()));
    assert_eq!(ask("fail.example.test").await, Err("navigation to fail.example.test could not be resolved for private-network validation".into()));
    assert_eq!(ask("nowhere.example.test").await, Err("navigation to nowhere.example.test could not be resolved for private-network validation".into()));
    assert_eq!(ask("sixty-four.example.test").await, Ok(()));
    assert_eq!(ask("sixty-five.example.test").await, Err("navigation to sixty-five.example.test returned too many resolved addresses".into()));
}

async fn url_via(address: String, resolver: &Table) -> Result<(), String> {
    admit_resolved(&address, &UrlPolicy::default(), resolver).await.map_err(|r| r.reason)
}

#[tokio::test]
async fn loopback_names_and_ip_literals_are_decided_without_a_lookup() {
    let nothing = table(&[]);
    for target in ["http://[::1]:8080/fixture", "http://localhost:3000/", "http://app.localhost:3000/"] {
        assert_eq!(url(target, UrlPolicy::default(), &nothing).await, Ok(()), "{target}");
    }
    assert_eq!(url("http://192.168.1.10/", UrlPolicy::default(), &nothing).await, Err("navigation to private or internal address 192.168.1.10 is blocked".into()));
    assert_eq!(url("http://192.168.1.10/", local(), &nothing).await, Ok(()));
    for policy in [UrlPolicy::default(), local()] {
        assert_eq!(url("http://169.254.169.254/", policy, &nothing).await, Err("navigation to cloud metadata endpoints is blocked".into()));
    }
}

#[tokio::test]
async fn a_loopback_name_with_a_trailing_dot_is_looked_up_like_any_other_name() {
    assert_eq!(url("http://localhost./", UrlPolicy::default(), &table(&[("localhost.", &["127.0.0.1"])])).await, Ok(()));
    assert!(url("http://localhost./", UrlPolicy::default(), &table(&[])).await.is_err(), "no answer means refusal");
}

#[tokio::test]
async fn the_policy_is_applied_before_any_lookup() {
    let resolver = table(&[("example.test", &["93.184.216.34"])]);
    let policy = UrlPolicy::default();
    let refused = |text: &str, reason: &str| (text.to_owned(), reason.to_owned());
    for (target, reason) in [
        refused("https://example.test/?token=abc", "navigation URLs may not contain credential-like query values or secret tokens"),
        refused("https://u:p@example.test/", "URLs containing embedded credentials are not allowed"),
        refused("ftp://example.test/", "only http(s) navigation is allowed (got ftp:)"),
    ] {
        assert_eq!(url(&target, policy.clone(), &resolver).await, Err(reason), "{target}");
    }
    let listed = UrlPolicy { allow_private_network: false, allowed_domains: vec!["example.com".into()] };
    assert_eq!(
        url("https://example.test/", listed, &resolver).await,
        Err("navigation to example.test is blocked by the Browser Use domain policy".into())
    );
}

#[tokio::test]
async fn a_page_generated_request_keeps_its_token() {
    let resolver = table(&[("example.test", &["93.184.216.34"])]);
    let admission = UrlAdmission::new(UrlPolicy::default());
    assert_eq!(admission.assert_resolved_url_allowed("https://example.test/?token=abc", true, &resolver).await, Ok(()));
}

#[tokio::test]
async fn a_validated_agent_url_is_the_normal_form_once_its_host_is_admitted() {
    let resolver = table(&[("example.test", &["93.184.216.34"]), ("rebind.example.test", &["192.168.1.10"])]);
    let admission = UrlAdmission::new(UrlPolicy::default());
    async fn check(admission: &UrlAdmission, resolver: &Table, text: &str, link: Option<&MailLink>) -> Result<String, String> {
        admission.validated_agent_url(text, link, 0, resolver).await.map_err(|r| r.reason)
    }
    assert_eq!(check(&admission, &resolver, "example.test", None).await, Ok("https://example.test/".into()));
    assert_eq!(
        check(&admission, &resolver, "rebind.example.test", None).await,
        Err("navigation to rebind.example.test resolved to blocked private or internal address 192.168.1.10".into())
    );
    assert_eq!(
        check(&admission, &resolver, "http://10.0.0.1/", None).await,
        Err("navigation to private or internal address 10.0.0.1 is blocked".into())
    );
    let token = "eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImRldiJ9.c2lnbmF0dXJlLXZhbHVl";
    let mail_url = format!("https://example.test/v?token={token}");
    assert_eq!(
        check(&admission, &resolver, &mail_url, None).await,
        Err("navigation URLs may not contain credential-like query values or secret tokens".into())
    );
    let link = MailLink { url: mail_url.clone(), from_domain: "example.test".into(), read_at: Some(0) };
    assert_eq!(check(&admission, &resolver, &mail_url, Some(&link)).await, Ok(mail_url));
}

#[tokio::test]
async fn a_websocket_is_checked_as_the_http_request_it_upgrades() {
    let resolver = table(&[("socket.example.test", &["93.184.216.34"]), ("rebind.example.test", &["192.168.1.10"])]);
    let admission = UrlAdmission::new(UrlPolicy::default());
    let resource = |text: &str| {
        let text = text.to_owned();
        let admission = &admission;
        let resolver = &resolver;
        async move { admission.assert_resolved_resource_url_allowed(&text, resolver).await.map_err(|r| r.reason) }
    };
    assert_eq!(resource("wss://socket.example.test/live").await, Ok(()));
    assert_eq!(resource("https://socket.example.test/app.js?token=abc").await, Ok(()), "a resource may carry a token");
    assert_eq!(resource("ws://169.254.169.254/latest/meta-data").await, Err("navigation to cloud metadata endpoints is blocked".into()));
    assert_eq!(
        resource("ws://rebind.example.test/").await,
        Err("navigation to rebind.example.test resolved to blocked private or internal address 192.168.1.10".into())
    );
    assert_eq!(resource("wss://u:p@socket.example.test/").await, Err("URLs containing embedded credentials are not allowed".into()));
}

#[tokio::test]
async fn a_resource_with_another_scheme_or_no_url_at_all_is_refused() {
    let resolver = table(&[("example.test", &["93.184.216.34"])]);
    let admission = UrlAdmission::new(UrlPolicy::default());
    for (text, reason) in [
        ("ftp://example.test/", "unsupported browser network protocol ftp:"),
        ("data:text/plain,hello", "unsupported browser network protocol data:"),
        ("blob:https://example.test/id", "unsupported browser network protocol blob:"),
        ("not a url", "Invalid URL"),
    ] {
        let refusal = admission.assert_resolved_resource_url_allowed(text, &resolver).await.unwrap_err();
        assert_eq!(refusal.reason, reason, "{text}");
    }
}
