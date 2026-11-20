//! Which URLs the Browser Use host lets an agent or a page open, and the normalised form it hands on.

use mixdog_browser_policy::url_policy::AdmitCtx;
use mixdog_browser_policy::url_policy::MAIL_LINK_WINDOW_MS;
use mixdog_browser_policy::url_policy::MailLink;
use mixdog_browser_policy::url_policy::UrlPolicy;
use mixdog_browser_policy::url_policy::admit;
use mixdog_browser_policy::url_policy::assert_resolved_address_allowed;
use mixdog_browser_policy::url_policy::normalize_agent_url;
use mixdog_browser_policy::url_policy::normalize_page_url;

const SECRET_REFUSAL: &str = "navigation URLs may not contain credential-like query values or secret tokens";
const METADATA_REFUSAL: &str = "navigation to cloud metadata endpoints is blocked";
const JWT: &str = "eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImRldiJ9.c2lnbmF0dXJlLXZhbHVl";

fn open() -> UrlPolicy {
    UrlPolicy::default()
}

fn local() -> UrlPolicy {
    UrlPolicy { allow_private_network: true, allowed_domains: vec![] }
}

fn only(domains: &[&str]) -> UrlPolicy {
    UrlPolicy { allow_private_network: false, allowed_domains: domains.iter().map(|d| (*d).to_owned()).collect() }
}

fn agent(url: &str, policy: &UrlPolicy) -> Result<String, String> {
    normalize_agent_url(url, policy, None, 0).map_err(|refusal| refusal.reason)
}

fn page(url: &str, policy: &UrlPolicy) -> Result<String, String> {
    normalize_page_url(url, policy).map_err(|refusal| refusal.reason)
}

fn private(host: &str) -> String {
    format!("navigation to private or internal address {host} is blocked")
}

#[test]
fn a_bare_host_is_read_as_https_and_the_url_is_returned_in_normal_form() {
    assert_eq!(agent("example.com", &open()), Ok("https://example.com/".into()));
    assert_eq!(agent("HTTP://EXAMPLE.COM/Path?Q=1", &open()), Ok("http://example.com/Path?Q=1".into()));
    assert_eq!(agent("   https://example.com/a b  ", &open()), Ok("https://example.com/a%20b".into()));
    assert_eq!(agent("https://bücher.example/", &open()), Ok("https://xn--bcher-kva.example/".into()));
    assert_eq!(agent("https://example.com./", &open()), Ok("https://example.com./".into()));
}

#[test]
fn an_empty_url_is_refused() {
    assert_eq!(agent("", &open()), Err("navigate requires url".into()));
    assert_eq!(agent("   ", &open()), Err("navigate requires url".into()));
}

#[test]
fn only_http_and_https_are_opened() {
    for (url, scheme) in [
        ("ftp://example.com/file", "ftp"),
        ("file:///C:/Users/example/secrets.txt", "file"),
        ("javascript:alert(1)", "javascript"),
        ("data:text/html,test", "data"),
        ("about:blank", "about"),
        // A host with a port and no scheme reads as `host:` scheme, as a URL parser does.
        ("localhost:3000/app", "localhost"),
    ] {
        assert_eq!(agent(url, &open()), Err(format!("only http(s) navigation is allowed (got {scheme}:)")), "{url}");
        assert_eq!(page(url, &open()), Err(format!("only http(s) navigation is allowed (got {scheme}:)")), "page {url}");
    }
}

#[test]
fn an_unparsable_url_is_refused_with_its_secrets_redacted_from_the_message() {
    assert_eq!(agent("https://exa mple.com/?token=abcdef", &open()), Err("invalid url: https://exa mple.com/?token=[REDACTED]".into()));
    assert_eq!(agent("http://[bad ghp_abcdefghijklmnopqrstuvwxyz", &open()), Err("invalid url: http://[bad [REDACTED_GITHUB_TOKEN]".into()));
}

#[test]
fn embedded_credentials_are_refused_for_agents_and_pages_alike() {
    let reason = "URLs containing embedded credentials are not allowed";
    for url in ["https://user:pass@example.com", "https://user@example.com"] {
        assert_eq!(agent(url, &open()), Err(reason.into()), "{url}");
        assert_eq!(page(url, &open()), Err(reason.into()), "page {url}");
    }
    // An empty userinfo carries no credential.
    assert_eq!(agent("https://@example.com/", &open()), Ok("https://example.com/".into()));
    assert_eq!(page("https://user:pass@gamerscroll.com", &only(&["gamerscroll.com"])), Err(reason.into()));
}

#[test]
fn an_agent_url_may_not_carry_a_secret_but_a_page_url_may() {
    for url in [
        "https://example.com/collect?token=plain-secret",
        "https://example.com/?api_key=value",
        "https://example.com/cb?code=abcdefgh",
        "https://example.com/collect/sk%2Dproj%2Dabcdefghijklmnop",
        "https://example.test/Bearer+abcdefghijklmnop",
        &format!("https://example.com/a/{JWT}"),
    ] {
        assert_eq!(agent(url, &open()), Err(SECRET_REFUSAL.into()), "{url}");
    }
    let tokenised = "https://example.com/cb?token=plain-secret&code=abcdefghijkl";
    assert_eq!(page(tokenised, &open()), Ok(tokenised.into()), "a site's own tokens are kept on a page request");
}

#[test]
fn what_looks_like_a_secret_but_is_not_one_is_admitted() {
    for url in ["https://example.com/cb?code=abc", "https://example.com/?token=", "https://example.com/docs?key=keyboard", "https://example.com/#token=abc"] {
        assert_eq!(agent(url, &open()), Ok(url.into()), "{url}");
    }
}

#[test]
fn loopback_hosts_may_carry_a_token_for_local_development() {
    for url in ["http://localhost:3000/callback?token=local-development", "http://127.0.0.1:3000/callback?token=local-development"] {
        assert_eq!(agent(url, &open()), Ok(url.into()), "{url}");
    }
}

#[test]
fn cloud_metadata_endpoints_are_refused_even_when_private_networks_are_allowed() {
    for url in [
        "http://169.254.169.254/latest/meta-data",
        "http://169.254.170.2/v2",
        "http://100.100.100.200/",
        "http://metadata.google.internal/computeMetadata",
        "http://metadata.google.internal./x",
        "https://metadata.goog/",
        "http://[fd00:ec2::254]/",
        "http://[::ffff:169.254.169.254]/",
    ] {
        assert_eq!(agent(url, &local()), Err(METADATA_REFUSAL.into()), "{url}");
        assert_eq!(page(url, &open()), Err(METADATA_REFUSAL.into()), "page {url}");
    }
}

#[test]
fn private_and_internal_ranges_are_refused_unless_the_policy_allows_them() {
    for (url, shown) in [
        ("http://192.168.1.1", "192.168.1.1"),
        ("http://0.0.0.0/", "0.0.0.0"),
        ("http://10.1.2.3/", "10.1.2.3"),
        ("http://100.64.0.1/", "100.64.0.1"),
        ("http://100.127.255.255/", "100.127.255.255"),
        ("http://172.16.0.1/", "172.16.0.1"),
        ("http://198.18.0.1/", "198.18.0.1"),
        ("http://224.0.0.1/", "224.0.0.1"),
        ("http://255.255.255.255/", "255.255.255.255"),
        ("http://169.254.1.1/", "169.254.1.1"),
        ("http://[::]/", "::"),
        ("http://[fc00::1]/", "fc00::1"),
        ("http://[fd12:3456::1]/", "fd12:3456::1"),
        ("http://[fe80::1]/", "fe80::1"),
        ("http://[febf::1]/", "febf::1"),
        ("http://[::ffff:10.0.0.1]/", "::ffff:a00:1"),
        // A decimal spelling is normalised to its dotted form before the check.
        ("http://3232235777/", "192.168.1.1"),
    ] {
        assert_eq!(agent(url, &open()), Err(private(shown)), "{url}");
        assert_eq!(page(url, &open()), Err(private(shown)), "page {url}");
        assert!(agent(url, &local()).is_ok(), "allowed for a local session: {url}");
    }
}

#[test]
fn addresses_just_outside_the_private_ranges_are_public() {
    for url in ["http://100.128.0.1/", "http://172.32.0.1/", "http://198.20.0.1/", "http://[2001:4860:4860::8888]/"] {
        assert!(agent(url, &open()).is_ok(), "{url}");
    }
    assert_eq!(agent("http://[::ffff:8.8.8.8]/", &open()), Ok("http://[::ffff:808:808]/".into()));
}

#[test]
fn loopback_is_always_reachable_for_local_web_app_development() {
    for url in ["http://localhost:3000/app", "http://app.localhost:5173/", "http://127.1.2.3/", "http://[::1]:8080/x", "http://localhost./"] {
        assert_eq!(agent(url, &open()), Ok(url.into()), "{url}");
    }
    assert_eq!(agent("http://0x7f.1/", &open()), Ok("http://127.0.0.1/".into()));
    assert_eq!(agent("http://2130706433/", &open()), Ok("http://127.0.0.1/".into()));
    assert_eq!(agent("http://0177.0.0.1/", &open()), Ok("http://127.0.0.1/".into()));
}

#[test]
fn the_domain_allow_list_admits_exact_hosts_and_wildcard_subdomains_only() {
    let policy = only(&["example.com", "*.trusted.test"]);
    assert_eq!(agent("https://example.net", &policy), Err("navigation to example.net is blocked by the Browser Use domain policy".into()));
    assert_eq!(
        agent("https://evilexample.com/", &only(&["example.com"])),
        Err("navigation to evilexample.com is blocked by the Browser Use domain policy".into())
    );
    assert!(agent("https://example.com/x", &policy).is_ok());
    assert!(agent("https://a.b.trusted.test/x", &policy).is_ok());
    // A wildcard entry also admits the bare domain it names.
    assert!(agent("https://trusted.test/x", &only(&["*.trusted.test"])).is_ok());
}

#[test]
fn allow_list_entries_are_trimmed_and_case_folded_and_blank_entries_mean_no_list() {
    assert!(agent("https://example.com/", &only(&["  ", " Example.COM. "])).is_ok());
    assert!(agent("https://example.org/", &only(&["", "  "])).is_ok());
    assert_eq!(
        page("https://outside.test/", &only(&["gamerscroll.com"])),
        Err("navigation to outside.test is blocked by the Browser Use domain policy".into())
    );
    assert!(page("https://gamerscroll.com/rankings/", &only(&["gamerscroll.com"])).is_ok());
}

#[test]
fn a_resolved_address_is_checked_against_the_name_it_was_resolved_for() {
    let check = |address: &str, host: &str, policy: &UrlPolicy| assert_resolved_address_allowed(address, host, policy).map_err(|r| r.reason);
    assert_eq!(check("93.184.216.34", "example.test", &open()), Ok(()));
    assert_eq!(check("2606:4700::1111", "example.test", &open()), Ok(()));
    assert_eq!(
        check("192.168.1.10", "nas.example.test", &open()),
        Err("navigation to nas.example.test resolved to blocked private or internal address 192.168.1.10".into())
    );
    assert_eq!(check("192.168.1.10", "nas.example.test", &local()), Ok(()));
    assert_eq!(check("100.101.102.103", "nas.example.test", &local()), Ok(()));
    assert_eq!(check("fe80::1", "x.test", &open()), Err("navigation to x.test resolved to blocked private or internal address fe80::1".into()));
    assert_eq!(check("[::1]", "x.example.test", &open()), Err("navigation to x.example.test resolved to blocked private or internal address [::1]".into()));
}

#[test]
fn a_loopback_name_may_resolve_privately_but_never_to_a_metadata_endpoint() {
    assert_eq!(assert_resolved_address_allowed("10.0.0.1", "app.localhost", &open()), Ok(()));
    for address in ["169.254.169.254", "metadata.google.internal", "METADATA.GOOG"] {
        for policy in [open(), local()] {
            let refusal = assert_resolved_address_allowed(address, "app.localhost", &policy).unwrap_err();
            assert_eq!(refusal.reason, "navigation to app.localhost resolved to a blocked cloud metadata endpoint", "{address}");
        }
    }
}

#[test]
fn a_resolved_text_that_is_not_a_canonical_address_is_not_judged_private() {
    // Only the canonical spelling is an address: a long-form IPv6, a zero-padded IPv4 and plain text are not recognised.
    for address in ["0:0:0:0:0:0:0:1", "010.0.0.1", "not-an-ip"] {
        assert_eq!(assert_resolved_address_allowed(address, "r.example.test", &open()), Ok(()), "{address}");
    }
}

fn mail_url(host: &str) -> String {
    format!("https://{host}/api/auth/verify-email?token={JWT}&callbackURL=https%3A%2F%2F{host}%2F")
}

fn link(url: &str, from: &str, read_at: Option<i64>) -> MailLink {
    MailLink { url: url.to_owned(), from_domain: from.to_owned(), read_at }
}

fn with_mail(url: &str, mail: &MailLink, now: i64, policy: &UrlPolicy) -> Result<String, String> {
    normalize_agent_url(url, policy, Some(mail), now).map_err(|refusal| refusal.reason)
}

#[test]
fn a_link_the_runtime_read_in_a_mail_may_carry_its_token_when_opened_exactly_as_read() {
    let url = mail_url("alternativeto.net");
    let now = 1_000_000;
    assert_eq!(with_mail(&url, &link(&url, "alternativeto.net", Some(now)), now, &open()), Ok(url.clone()));
    assert_eq!(with_mail(&url, &link(&url, "mail.alternativeto.net", Some(now)), now, &open()), Ok(url.clone()), "sender subdomain");
    let padded = format!("  {url}  ");
    assert_eq!(with_mail(&padded, &link(&url, "alternativeto.net", Some(now)), now, &open()), Ok(url.clone()));
    assert_eq!(agent(&url, &open()), Err(SECRET_REFUSAL.into()), "typed without a mail read");
}

#[test]
fn a_mail_link_lasts_thirty_minutes_and_is_not_valid_before_it_was_read() {
    let url = mail_url("alternativeto.net");
    let read_at = 5_000_000;
    let at = |age: i64| with_mail(&url, &link(&url, "alternativeto.net", Some(read_at)), read_at + age, &open());
    assert!(at(0).is_ok());
    assert!(at(MAIL_LINK_WINDOW_MS).is_ok(), "the window is inclusive");
    assert_eq!(at(MAIL_LINK_WINDOW_MS + 1), Err(SECRET_REFUSAL.into()));
    assert_eq!(at(-5_000), Err(SECRET_REFUSAL.into()), "read in the future");
    assert_eq!(with_mail(&url, &link(&url, "alternativeto.net", None), read_at, &open()), Err(SECRET_REFUSAL.into()), "no read time");
}

#[test]
fn a_mail_link_lifts_nothing_for_another_url_scheme_or_sender() {
    let url = mail_url("alternativeto.net");
    let now = 0;
    let refused = |typed: &str, mail: &MailLink| assert_eq!(with_mail(typed, mail, now, &open()), Err(SECRET_REFUSAL.into()), "{typed} / {mail:?}");
    refused(&format!("{url}&next=%2Fadmin"), &link(&url, "alternativeto.net", Some(now)));
    refused(&url, &link(&url, "evil.example", Some(now)));
    refused(&url, &link(&url, "alternativeto.net.evil.com", Some(now)));
    refused(&url, &link(&url, "evil.example/alternativeto.net", Some(now)));
    refused(&url, &link(&url, "alternativeto.net\u{a0}", Some(now)));
    refused(&url, &link(&url, "127.0.0.1", Some(now)));
    let evil_host = mail_url("alternativeto.net.evil.com");
    refused(&evil_host, &link(&evil_host, "alternativeto.net", Some(now)));
    let lookalike = mail_url("аlternativeto.net");
    refused(&lookalike, &link(&lookalike, "alternativeto.net", Some(now)));
    let plain = url.replacen("https:", "http:", 1);
    refused(&plain, &link(&plain, "alternativeto.net", Some(now)));
    let literal = format!("https://10.0.0.5/v?token={JWT}");
    refused(&literal, &link(&literal, "10.0.0.5", Some(now)));
}

#[test]
fn a_mail_link_compares_registrable_domains_on_the_public_suffix_list() {
    let tenant = |host: &str| format!("https://{host}/v?token={JWT}");
    let (a, b) = (tenant("a.github.io"), tenant("b.github.io"));
    assert_eq!(with_mail(&b, &link(&b, "a.github.io", Some(0)), 0, &open()), Err(SECRET_REFUSAL.into()), "another tenant of a private suffix");
    assert_eq!(with_mail(&a, &link(&a, "www.a.github.io", Some(0)), 0, &open()), Ok(a.clone()));
    let dotted = tenant("alternativeto.net.");
    assert_eq!(with_mail(&dotted, &link(&dotted, "alternativeto.net", Some(0)), 0, &open()), Ok(dotted.clone()), "trailing dot host");
}

#[test]
fn a_mail_link_lifts_only_the_secret_refusal() {
    let url = mail_url("alternativeto.net");
    let mail = link(&url, "alternativeto.net", Some(0));
    assert_eq!(with_mail(&url, &mail, 0, &only(&["example.com"])), Err("navigation to alternativeto.net is blocked by the Browser Use domain policy".into()));
}

#[test]
fn admit_applies_the_rule_set_of_the_context_and_discards_the_normal_form() {
    let tokenised = "https://example.test/?token=abc";
    assert_eq!(admit(tokenised, &open(), &AdmitCtx::agent(0)).unwrap_err().reason, SECRET_REFUSAL);
    assert_eq!(admit(tokenised, &open(), &AdmitCtx::page(0)), Ok(()));
    assert_eq!(admit("http://10.0.0.1/", &open(), &AdmitCtx::page(0)).unwrap_err().reason, private("10.0.0.1"));
    let url = mail_url("alternativeto.net");
    let ctx = AdmitCtx { mail_link: Some(link(&url, "alternativeto.net", Some(0))), ..AdmitCtx::agent(0) };
    assert_eq!(admit(&url, &open(), &ctx), Ok(()));
}
