//! The system proxy beyond per-origin routing: how the registry's `ProxyServer` and `ProxyOverride` are read, what makes the
//! system proxy unused, the handoff to a child Mixdog, Chromium's answer for an origin, and the lookup's caching, sharing
//! and failure.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::netproxy::EnvLookup;
use mixdog_ai::netproxy::SystemProxy;
use mixdog_ai::netproxy::system::Bypass;
use mixdog_ai::netproxy::system::HANDOFF_VAR;
use mixdog_ai::netproxy::system::NotUsed;
use mixdog_ai::netproxy::system::ProxyPair;
use mixdog_ai::netproxy::system::RegistryReader;
use mixdog_ai::netproxy::system::RegistryValues;
use mixdog_ai::netproxy::system::SystemProxyResolver;
use mixdog_ai::netproxy::system::parse_proxy_server;
use mixdog_ai::netproxy::system::parse_registry_output;
use mixdog_ai::netproxy::system::registry_values;
use mixdog_ai::netproxy::system::route_from_chromium;
use mixdog_ai::netproxy::system::system_proxy_from_registry;
use mixdog_ai::netproxy::system::translate_proxy_override;

struct Env(HashMap<&'static str, &'static str>);

impl EnvLookup for Env {
    fn get(&self, name: &str) -> Option<String> {
        self.0.get(name).map(|v| (*v).to_owned())
    }
}

fn no_env() -> Env {
    Env(HashMap::new())
}

struct Registry(Option<RegistryValues>);

#[async_trait]
impl RegistryReader for Registry {
    async fn read(&self) -> Option<RegistryValues> {
        self.0.clone()
    }
}

fn values(enable: &str, server: &str, over: &str) -> RegistryValues {
    RegistryValues { proxy_enable: Some(enable.into()), proxy_server: Some(server.into()), proxy_override: Some(over.into()), auto_config_url: None }
}

fn pair(https: &str, http: Option<&str>) -> ProxyPair {
    ProxyPair { https: https.into(), http: http.map(str::to_owned) }
}

fn logged() -> (SystemProxy, Arc<Mutex<Vec<String>>>) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let sink = lines.clone();
    (SystemProxy::new(Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_owned()))), lines)
}

#[test]
fn a_registry_proxy_server_is_one_address_for_every_scheme_or_a_list_that_must_name_an_https_proxy() {
    assert_eq!(parse_proxy_server("proxy.corp:8080"), Ok(pair("http://proxy.corp:8080", Some("http://proxy.corp:8080"))));
    assert_eq!(
        parse_proxy_server(" HTTPS://secure.corp:443 "),
        Ok(pair("https://secure.corp:443", Some("https://secure.corp:443"))),
        "the scheme is read in any case"
    );
    assert_eq!(parse_proxy_server("[::1]:3128"), Ok(pair("http://[::1]:3128", Some("http://[::1]:3128"))));
    assert_eq!(parse_proxy_server("http=a:1;https=b:2"), Ok(pair("http://b:2", Some("http://a:1"))));
    assert_eq!(parse_proxy_server("https=b:2"), Ok(pair("http://b:2", None)));
    assert_eq!(parse_proxy_server("socks=s:1;; HTTPS = b:2 ;ftp=f:3"), Ok(pair("http://b:2", None)), "other entries and blanks are ignored");
    assert_eq!(parse_proxy_server("https=old:1;https=new:2"), Ok(pair("http://new:2", None)), "the last entry of a scheme wins");
    for (text, error) in [
        ("", "no proxy server"),
        ("   ", "no proxy server"),
        ("no-port", "unsupported proxy server"),
        ("host:70000", "unsupported proxy server"),
        ("host:8080/path", "unsupported proxy server"),
        ("https=bad", "unsupported proxy server"),
        ("http=a:1;https=bad", "unsupported proxy server"),
        ("=a:1;https=b:2", "unsupported proxy server"),
        ("http=a:1", "no HTTPS proxy (HTTP-only, SOCKS-only or other entries)"),
        ("socks=a:1", "no HTTPS proxy (HTTP-only, SOCKS-only or other entries)"),
    ] {
        assert_eq!(parse_proxy_server(text), Err(error.to_owned()), "{text:?}");
    }
}

#[test]
fn a_proxy_override_becomes_exact_host_and_subdomain_exceptions_or_cannot_be_translated() {
    let translated = translate_proxy_override("<local>; *.Corp.Example ;Intranet;10.0.0.1;;").unwrap();
    assert_eq!(translated, Bypass { hosts: vec!["intranet".into(), "10.0.0.1".into()], suffixes: vec!["corp.example".into()] });
    assert_eq!(translate_proxy_override("").unwrap(), Bypass::default());
    assert_eq!(translate_proxy_override("[::1]").unwrap().hosts, ["::1"], "an IPv6 literal loses its brackets");
    // A wildcard over loopback adds nothing to bypass; any other wildcard has no exact rule.
    assert_eq!(translate_proxy_override("127.*").unwrap(), Bypass::default());
    for inexact in ["8.8.*", "*.*.example", "*", "foo bar", "1.2.3", "http://x", "a*b.example"] {
        assert_eq!(translate_proxy_override(inexact), None, "{inexact}");
    }
    assert_eq!(translate_proxy_override("ok.example;8.8.*"), None, "one entry without a rule spoils the list");
}

#[test]
fn the_registry_decides_a_proxy_only_when_enabled_without_a_pac_and_with_exact_values() {
    let used = system_proxy_from_registry(Some(&values("0x1", "p:1", "<local>;*.corp.example"))).unwrap();
    assert_eq!(used.proxy, Some(pair("http://p:1", Some("http://p:1"))));
    assert_eq!(used.bypass.suffixes, ["corp.example"]);
    for enabled in ["1", "0x1", "0x00000001", "0X1", " 1 ", "001"] {
        assert!(system_proxy_from_registry(Some(&values(enabled, "p:1", ""))).is_ok(), "{enabled:?} is on");
    }
    for disabled in ["0", "0x0", "2", "0x2", "", "yes"] {
        let skipped = system_proxy_from_registry(Some(&values(disabled, "p:1", ""))).unwrap_err();
        assert_eq!(skipped, NotUsed { reason: "disabled".into(), silent: true }, "{disabled:?}");
    }
    assert_eq!(
        system_proxy_from_registry(Some(&RegistryValues { proxy_enable: Some("1".into()), ..RegistryValues::default() })).unwrap_err().reason,
        "disabled",
        "no server"
    );
    assert_eq!(system_proxy_from_registry(None).unwrap_err(), NotUsed { reason: "registry unreadable".into(), silent: true });
    let pac = RegistryValues { auto_config_url: Some("http://wpad/wpad.dat".into()), ..values("1", "p:1", "") };
    assert_eq!(system_proxy_from_registry(Some(&pac)).unwrap_err(), NotUsed { reason: "a PAC script is configured".into(), silent: false });
    assert_eq!(
        system_proxy_from_registry(Some(&values("1", "nonsense", ""))).unwrap_err(),
        NotUsed { reason: "unsupported proxy server".into(), silent: false }
    );
    assert_eq!(
        system_proxy_from_registry(Some(&values("1", "p:1", "8.8.*"))).unwrap_err(),
        NotUsed { reason: "proxy exceptions cannot be translated exactly".into(), silent: false }
    );
}

#[test]
fn reg_query_output_is_read_by_row_with_lower_cased_names() {
    let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=a:1;https=b:2\r\n    ProxyOverride    REG_SZ    <local>;*.corp.example  \r\n    AutoConfigURL    REG_SZ\r\n    Other Name    REG_SZ    x y\r\n";
    let settings = parse_registry_output(out);
    assert_eq!(settings["proxyenable"], "0x1");
    assert_eq!(settings["proxyserver"], "http=a:1;https=b:2");
    assert_eq!(settings["proxyoverride"], "<local>;*.corp.example", "trailing blanks are dropped");
    assert_eq!(settings["autoconfigurl"], "", "a value with no data");
    assert_eq!(settings["other name"], "x y");
    assert_eq!(settings.len(), 5, "the key line is not a row");
    let found = registry_values(&settings);
    assert_eq!(
        (found.proxy_enable.as_deref(), found.proxy_server.as_deref(), found.auto_config_url.as_deref()),
        (Some("0x1"), Some("http=a:1;https=b:2"), Some(""))
    );
}

#[test]
fn chromiums_answer_gives_the_first_http_proxy_and_direct_ends_the_list() {
    let route = |answer: &str| route_from_chromium(answer);
    assert_eq!((route("PROXY 127.0.0.1:7890; DIRECT").proxy.as_deref(), route("PROXY 127.0.0.1:7890; DIRECT").socks), (Some("http://127.0.0.1:7890"), false));
    assert_eq!(route("HTTPS secure.example:443").proxy.as_deref(), Some("https://secure.example:443"));
    assert_eq!(route("proxy  a.example:1").proxy.as_deref(), Some("http://a.example:1"), "any case, any run of blanks");
    assert_eq!(route("SOCKS5 a:1; PROXY b:2").proxy.as_deref(), Some("http://b:2"), "SOCKS entries are skipped");
    let socks_only = route("SOCKS5 a:1; SOCKS4 b:2");
    assert_eq!((socks_only.proxy, socks_only.socks), (None, true), "a SOCKS-only answer is reported");
    assert_eq!(route("DIRECT; PROXY b:2").proxy, None, "DIRECT ends the list");
    assert_eq!(route("SOCKS5 a:1; DIRECT").proxy, None);
    assert_eq!(route("PROXY not-an-address").proxy, None);
    assert_eq!(route("").proxy, None);
}

const HANDOFF: &str =
    r#"{"proxy":{"https":"http://hand.off:3128","http":"http://hand.off:3128"},"bypass":{"hosts":["exact.example"],"suffixes":["corp.example"]}}"#;

#[tokio::test]
async fn a_handoff_from_the_launching_process_is_the_decision_with_its_exceptions() {
    let system = SystemProxy::new(Arc::new(|_: &str| {}));
    assert!(system.adopt(&no_env(), Some(HANDOFF), false, &Registry(None)).await);
    assert_eq!(system.route("https://api.example").await.proxy.as_deref(), Some("http://hand.off:3128"));
    assert_eq!(system.route("http://api.example").await.proxy.as_deref(), Some("http://hand.off:3128"));
    assert_eq!(system.route("https://exact.example").await.proxy, None, "an excepted host");
    assert_eq!(system.route("https://sub.corp.example").await.proxy, None, "a subdomain of an excepted domain");
    assert_eq!(system.route("https://corp.example").await.proxy.as_deref(), Some("http://hand.off:3128"), "the domain itself is not excepted");
    assert_eq!(system.route("https://notcorp.example").await.proxy.as_deref(), Some("http://hand.off:3128"));
    assert!(system.registered());
    // It hands the same decision on to a child.
    let (name, text) = system.handoff_env().unwrap();
    assert_eq!(name, HANDOFF_VAR);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&text).unwrap(), serde_json::from_str::<serde_json::Value>(HANDOFF).unwrap());
}

#[tokio::test]
async fn a_handoff_that_says_direct_decides_direct_and_one_that_is_malformed_is_logged_and_goes_direct() {
    let (system, lines) = logged();
    assert!(!system.adopt(&no_env(), Some(r#"{"proxy":null}"#), true, &Registry(Some(values("1", "p:1", "")))).await, "the handoff wins over the registry");
    assert_eq!(system.route("https://api.example").await.proxy, None);
    assert_eq!(system.handoff_env().unwrap().1, r#"{"proxy":null}"#);
    assert!(lines.lock().unwrap().is_empty());
    for bad in ["nope", "[]", "{}", r#"{"proxy":{}}"#, r#"{"proxy":{"https":"ftp://x:1"}}"#, r#"{"proxy":{"https":"http://x:1","http":"nonsense"}}"#] {
        let (system, lines) = logged();
        assert!(!system.adopt(&no_env(), Some(bad), true, &Registry(Some(values("1", "p:1", "")))).await, "{bad}");
        assert_eq!(system.route("https://api.example").await.proxy, None, "{bad}");
        assert_eq!(lines.lock().unwrap().as_slice(), ["[mixdog] system proxy not used: invalid handoff"], "{bad}");
    }
}

#[tokio::test]
async fn a_user_proxy_variable_or_the_opt_out_leaves_the_system_proxy_unused_and_any_resolver_inert() {
    for name in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NODE_USE_ENV_PROXY"] {
        let system = SystemProxy::new(Arc::new(|_: &str| {}));
        assert!(!system.adopt(&Env(HashMap::from([(name, "x")])), Some(HANDOFF), true, &Registry(None)).await, "{name}");
        assert_eq!(system.route("https://api.example").await.proxy, None, "{name}");
        assert!(system.handoff_env().is_none(), "{name}: no decision is made");
        let _inert = system.attach_resolver(Arc::new(Answering { answer: "PROXY a:1".into(), asked: Arc::default() }));
        assert_eq!(system.route("https://api.example").await.proxy, None, "{name}: the resolver is not consulted");
    }
    let system = SystemProxy::new(Arc::new(|_: &str| {}));
    assert!(!system.adopt(&Env(HashMap::from([("MIXDOG_SYSTEM_PROXY", "0")])), Some(HANDOFF), true, &Registry(None)).await);
    // Only the exact value 0 opts out.
    assert!(system.adopt(&Env(HashMap::from([("MIXDOG_SYSTEM_PROXY", "1")])), Some(HANDOFF), true, &Registry(None)).await);
}

#[tokio::test]
async fn without_a_handoff_only_windows_reads_the_registry_and_a_skipped_registry_logs_its_reason_unless_silent() {
    let system = SystemProxy::new(Arc::new(|_: &str| {}));
    assert!(!system.adopt(&no_env(), None, false, &Registry(Some(values("1", "p:1", "")))).await, "another platform routes nothing");
    assert!(system.handoff_env().is_none());

    for (registry, line) in [
        (None, None),
        (Some(values("0", "p:1", "")), None),
        (
            Some(RegistryValues { auto_config_url: Some("http://wpad/x.pac".into()), ..values("1", "p:1", "") }),
            Some("[mixdog] system proxy not used: a PAC script is configured"),
        ),
        (Some(values("1", "only=http:1", "")), Some("[mixdog] system proxy not used: no HTTPS proxy (HTTP-only, SOCKS-only or other entries)")),
        (Some(values("1", "nonsense", "")), Some("[mixdog] system proxy not used: unsupported proxy server")),
    ] {
        let (system, lines) = logged();
        assert!(!system.adopt(&no_env(), None, true, &Registry(registry)).await);
        assert_eq!(lines.lock().unwrap().iter().map(String::as_str).collect::<Vec<_>>(), line.into_iter().collect::<Vec<_>>());
        assert_eq!(system.handoff_env().unwrap().1, r#"{"proxy":null}"#, "decided: direct, which a child is told");
    }
    let system = SystemProxy::new(Arc::new(|_: &str| {}));
    assert!(system.adopt(&no_env(), None, true, &Registry(Some(values("1", "p:1", "<local>")))).await);
    assert_eq!(system.route("https://api.example").await.proxy.as_deref(), Some("http://p:1"));
}

struct Answering {
    answer: String,
    asked: Arc<AtomicUsize>,
}

#[async_trait]
impl SystemProxyResolver for Answering {
    async fn resolve(&self, _origin: &str) -> Result<String, String> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        Ok(self.answer.clone())
    }
}

struct Failing(Arc<AtomicUsize>);

#[async_trait]
impl SystemProxyResolver for Failing {
    async fn resolve(&self, _origin: &str) -> Result<String, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err("the app is gone".into())
    }
}

async fn adopted_with_handoff() -> (SystemProxy, Arc<Mutex<Vec<String>>>) {
    let (system, lines) = logged();
    assert!(system.adopt(&no_env(), Some(HANDOFF), false, &Registry(None)).await);
    (system, lines)
}

#[tokio::test]
async fn an_origins_answer_is_asked_once_shared_by_concurrent_requests_and_remembered() {
    let (system, _) = adopted_with_handoff().await;
    let asked = Arc::new(AtomicUsize::new(0));
    let _claim = system.attach_resolver(Arc::new(Answering { answer: "PROXY app.proxy:9".into(), asked: asked.clone() }));
    let (a, b) = tokio::join!(system.route("https://one.example"), system.route("https://one.example"));
    assert_eq!((a.proxy.as_deref(), b.proxy.as_deref()), (Some("http://app.proxy:9"), Some("http://app.proxy:9")));
    assert_eq!(asked.load(Ordering::SeqCst), 1, "concurrent requests share one lookup");
    system.route("https://one.example").await;
    assert_eq!(asked.load(Ordering::SeqCst), 1, "the answer is remembered");
    system.route("https://two.example").await;
    assert_eq!(asked.load(Ordering::SeqCst), 2, "each origin has its own answer");
}

#[tokio::test]
async fn attaching_or_detaching_a_resolver_drops_what_was_remembered_and_the_newest_resolver_answers() {
    let (system, _) = adopted_with_handoff().await;
    let first_asked = Arc::new(AtomicUsize::new(0));
    let first = system.attach_resolver(Arc::new(Answering { answer: "PROXY first:1".into(), asked: first_asked.clone() }));
    assert_eq!(system.route("https://o.example").await.proxy.as_deref(), Some("http://first:1"));
    let second = system.attach_resolver(Arc::new(Answering { answer: "DIRECT".into(), asked: Arc::default() }));
    assert_eq!(system.route("https://o.example").await.proxy, None, "the newest resolver answers, not the remembered answer");
    drop(second);
    assert_eq!(system.route("https://o.example").await.proxy.as_deref(), Some("http://first:1"), "the one before it answers again");
    assert_eq!(first_asked.load(Ordering::SeqCst), 2);
    drop(first);
    assert_eq!(system.route("https://o.example").await.proxy.as_deref(), Some("http://hand.off:3128"), "no resolver left: the decision applies");
}

#[tokio::test]
async fn a_lookup_that_fails_goes_direct_and_is_logged_once_and_a_socks_only_answer_is_logged_once() {
    let (system, lines) = adopted_with_handoff().await;
    let asked = Arc::new(AtomicUsize::new(0));
    let claim = system.attach_resolver(Arc::new(Failing(asked.clone())));
    assert_eq!(system.route("https://a.example").await.proxy, None);
    assert_eq!(system.route("https://a.example").await.proxy, None);
    assert_eq!(asked.load(Ordering::SeqCst), 1, "a failure is remembered too, for a shorter while");
    assert_eq!(system.route("https://b.example").await.proxy, None);
    assert_eq!(
        lines.lock().unwrap().as_slice(),
        ["[mixdog] system proxy lookup failed or timed out; connecting directly"],
        "one line for the whole run of failures"
    );
    drop(claim);

    let _socks = system.attach_resolver(Arc::new(Answering { answer: "SOCKS5 10.0.0.1:1080".into(), asked: Arc::default() }));
    assert_eq!(system.route("https://a.example").await.proxy, None);
    assert_eq!(system.route("https://b.example").await.proxy, None);
    let socks_lines = lines.lock().unwrap().iter().filter(|l| l.contains("SOCKS only")).count();
    assert_eq!(socks_lines, 1, "{:?}", lines.lock().unwrap());
    assert!(lines.lock().unwrap().iter().all(|l| !l.contains("10.0.0.1")), "no address in a diagnostic line");
}

#[tokio::test(start_paused = true)]
async fn a_lookup_that_never_answers_ends_after_three_seconds_as_direct() {
    struct Silent;
    #[async_trait]
    impl SystemProxyResolver for Silent {
        async fn resolve(&self, _origin: &str) -> Result<String, String> {
            std::future::pending().await
        }
    }
    let (system, lines) = adopted_with_handoff().await;
    let _claim = system.attach_resolver(Arc::new(Silent));
    let started = tokio::time::Instant::now();
    assert_eq!(system.route("https://slow.example").await.proxy, None);
    assert_eq!(started.elapsed(), Duration::from_secs(3));
    assert_eq!(lines.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_npm_spawn_gets_the_proxy_of_its_registry_except_for_a_local_one() {
    let (system, _) = adopted_with_handoff().await;
    let env = system.npm_env("https://registry.npmjs.org/").await;
    assert_eq!(
        env,
        [
            ("npm_config_proxy", "http://hand.off:3128".to_owned()),
            ("npm_config_https_proxy", "http://hand.off:3128".to_owned()),
            ("npm_config_noproxy", "localhost,127.0.0.1,::1,.local".to_owned()),
        ]
    );
    assert!(system.npm_env("http://localhost:4873/").await.is_empty(), "a local registry is never proxied");
    assert!(system.npm_env("http://127.0.0.1:4873/").await.is_empty());
    assert!(system.npm_env("not a url").await.is_empty());
    assert!(system.npm_env("https://sub.corp.example/").await.is_empty(), "an excepted registry goes direct");

    let direct = SystemProxy::new(Arc::new(|_: &str| {}));
    direct.adopt(&no_env(), Some(r#"{"proxy":null}"#), false, &Registry(None)).await;
    assert!(direct.npm_env("https://registry.npmjs.org/").await.is_empty());
    let undecided = SystemProxy::new(Arc::new(|_: &str| {}));
    assert!(undecided.npm_env("https://registry.npmjs.org/").await.is_empty());
}
