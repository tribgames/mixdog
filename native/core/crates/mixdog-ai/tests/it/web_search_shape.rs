//! The hosted web-search tool of each provider family, the allowed-domain filter, the tool types a route tries, the
//! prompt and the flattening of the cited sources (Node 1.4.5 `session-runtime/native-web-search/tool-shape.mjs`).
//! The tables are the rules written out: each row is one input and the exact text it must give, so the key order of a
//! wire body is compared too.

use mixdog_ai::service::web_search::flatten_sources;
use mixdog_ai::service::web_search::native_web_search_messages;
use mixdog_ai::service::web_search::native_web_search_tool;
use mixdog_ai::service::web_search::native_web_search_tool_types;
use mixdog_ai::service::web_search::normalize_allowed_domain;
use mixdog_ai::service::web_search::normalize_allowed_domains;
use serde_json::Value;
use serde_json::json;

fn parsed(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn a_site_is_reduced_to_a_lowercase_hostname_and_a_site_filter_names_each_domain_once() {
    let single: [(&str, &str); 14] = [
        ("", ""),
        ("  ", ""),
        ("Example.COM", "example.com"),
        ("https://Foo.com/a/b", "foo.com"),
        ("http://x.org:8080/p", "x.org"),
        ("a.com/path?q=1", "a.com"),
        ("HTTPS://UP.com", "up.com"),
        ("site:a.com", "site:a.com"),
        ("[::1]", "[::1]"),
        ("münchen.de", "xn--mnchen-3ya.de"),
        ("a.b.", "a.b."),
        ("https://", ""),
        ("ftp://x.com", "ftp"),
        ("a b", "a b"),
    ];
    for (site, host) in single {
        assert_eq!(normalize_allowed_domain(site), host, "{site:?}");
    }
    let several: [(&str, &[&str]); 9] = [
        ("", &[]),
        ("a.com OR b.com", &["a.com","b.com"]),
        ("a.com, b.com", &["a.com","b.com"]),
        ("site:a.com SITE:b.com", &["a.com","b.com"]),
        ("a.com|b.com a.com", &["a.com","b.com"]),
        ("or OR Or", &[]),
        (" https://x.com/p , y.org ", &["x.com","y.org"]),
        ("site:", &[]),
        ("A.com a.COM", &["a.com"]),
    ];
    for (site, hosts) in several {
        assert_eq!(normalize_allowed_domains(site), hosts, "{site:?}");
    }
}

#[test]
fn the_tool_of_each_family_takes_its_own_fields_in_the_wire_order() {
    // (arguments, OpenAI-family tool, Anthropic tool, xAI tool); the Gemini tool is its type alone.
    let rows: [(&str, &str, &str, &str); 20] = [
        (r#"{}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"site":"a.com OR b.com"}"#, r#"{"type":"web_search","search_context_size":"low","filters":{"allowed_domains":["a.com","b.com"]}}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5,"allowed_domains":["a.com","b.com"]}"#, r#"{"type":"web_search","filters":{"allowed_domains":["a.com","b.com"]}}"#),
        (r#"{"site":"x.org","maxResults":3}"#, r#"{"type":"web_search","search_context_size":"low","filters":{"allowed_domains":["x.org"]}}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":3,"allowed_domains":["x.org"]}"#, r#"{"type":"web_search","filters":{"allowed_domains":["x.org"]}}"#),
        (r#"{"maxResults":"7"}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":7}"#, r#"{"type":"web_search"}"#),
        (r#"{"maxResults":0}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"maxResults":99}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":10}"#, r#"{"type":"web_search"}"#),
        (r#"{"maxResults":-4}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":1}"#, r#"{"type":"web_search"}"#),
        (r#"{"maxResults":7.5}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":7.5}"#, r#"{"type":"web_search"}"#),
        (r#"{"maxResults":"abc"}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"maxResults":"0x10"}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":10}"#, r#"{"type":"web_search"}"#),
        (r#"{"maxResults":true}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":1}"#, r#"{"type":"web_search"}"#),
        (r#"{"maxResults":null}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"maxResults":[]}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"contextSize":" high "}"#, r#"{"type":"web_search","search_context_size":"high"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"contextSize":5}"#, r#"{"type":"web_search","search_context_size":"5"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"locale":{"country":"KR","city":" Seoul ","zip":"1"}}"#, r#"{"type":"web_search","search_context_size":"low","user_location":{"type":"approximate","country":"KR","city":"Seoul"}}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5,"user_location":{"type":"approximate","country":"KR","city":"Seoul"}}"#, r#"{"type":"web_search"}"#),
        (r#"{"locale":{}}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"locale":[]}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"locale":{"country":""}}"#, r#"{"type":"web_search","search_context_size":"low"}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":5}"#, r#"{"type":"web_search"}"#),
        (r#"{"site":"a.com","locale":{"timezone":"Asia/Seoul"},"contextSize":"medium","maxResults":2}"#, r#"{"type":"web_search","search_context_size":"medium","filters":{"allowed_domains":["a.com"]},"user_location":{"type":"approximate","timezone":"Asia/Seoul"}}"#, r#"{"type":"web_search_20250305","name":"web_search","max_uses":2,"allowed_domains":["a.com"],"user_location":{"type":"approximate","timezone":"Asia/Seoul"}}"#, r#"{"type":"web_search","filters":{"allowed_domains":["a.com"]}}"#),
    ];
    for (args, openai, anthropic, xai) in rows {
        let args = parsed(args);
        for (family, want) in [("openai", openai), ("", openai), ("anthropic", anthropic), ("xai", xai)] {
            assert_eq!(native_web_search_tool(&args, "web_search", family).to_string(), parsed(want).to_string(), "{family:?} {args}");
        }
        assert_eq!(native_web_search_tool(&args, " google_search ", "gemini"), json!({"type": "google_search"}), "gemini {args}");
    }
    // A preview type carries no context size; Anthropic names its own type whatever was asked; a blank type is `web_search`.
    let args = json!({"site": "a.com OR b.com"});
    assert_eq!(native_web_search_tool(&args, "web_search_preview", "openai"), json!({"type": "web_search_preview"}));
    assert_eq!(
        native_web_search_tool(&args, "web_search_preview", "xai").to_string(),
        json!({"type": "web_search_preview", "filters": {"allowed_domains": ["a.com", "b.com"]}}).to_string()
    );
    assert_eq!(
        native_web_search_tool(&args, "", "anthropic").to_string(),
        json!({"type": "web_search_20250305", "name": "web_search", "max_uses": 5, "allowed_domains": ["a.com", "b.com"]}).to_string()
    );
    assert_eq!(native_web_search_tool(&args, "", "gemini"), json!({"type": "web_search"}));
}

#[test]
fn the_tool_types_a_route_tries_follow_its_family_unless_the_route_or_the_environment_names_one() {
    let rows: [(&str, &str, &[&str]); 15] = [
        (r#"{}"#, "", &["web_search","web_search_preview"]),
        (r#"{}"#, "gemini", &["google_search"]),
        (r#"{}"#, "anthropic", &["web_search"]),
        (r#"{}"#, "xai", &["web_search"]),
        (r#"{}"#, "openai", &["web_search","web_search_preview"]),
        (r#"{"toolType":" x "}"#, "", &["x"]),
        (r#"{"toolType":" x "}"#, "gemini", &["x"]),
        (r#"{"toolType":" x "}"#, "anthropic", &["x"]),
        (r#"{"toolType":" x "}"#, "xai", &["x"]),
        (r#"{"toolType":" x "}"#, "openai", &["x"]),
        (r#"{"toolType":5}"#, "", &["5"]),
        (r#"{"toolType":5}"#, "gemini", &["5"]),
        (r#"{"toolType":5}"#, "anthropic", &["5"]),
        (r#"{"toolType":5}"#, "xai", &["5"]),
        (r#"{"toolType":5}"#, "openai", &["5"]),
    ];
    for (route, family, want) in rows {
        assert_eq!(native_web_search_tool_types(&parsed(route), family, None), want, "{route} {family:?}");
    }
    assert_eq!(native_web_search_tool_types(&json!({"toolType": "x"}), "gemini", Some(" env ")), ["env"]);
}

#[test]
fn the_search_prompt_is_the_fixed_system_message_and_the_callers_prompt_as_it_is() {
    let system = "You are Mixdog native web search.\nUse the hosted web_search tool for current or external facts.\nAnswer concisely, cite source URLs, and do not request local tools or file edits.";
    let rows: [(&str, Value); 6] = [
        (r#"{}"#, parsed(r#""""#)),
        (r#"{"prompt":"hi"}"#, parsed(r#""hi""#)),
        (r#"{"prompt":" hi "}"#, parsed(r#"" hi ""#)),
        (r#"{"prompt":5}"#, parsed(r#"5"#)),
        (r#"{"prompt":0}"#, parsed(r#""""#)),
        (r#"{"prompt":["a"]}"#, parsed(r#"["a"]"#)),
    ];
    for (args, user) in rows {
        assert_eq!(native_web_search_messages(&parsed(args)), [json!({"role": "system", "content": system}), json!({"role": "user", "content": user})], "{args}");
    }
}

#[test]
fn cited_sources_are_flattened_once_per_url_in_citation_then_search_call_order() {
    let rows: [(&str, &str); 5] = [
        (r#"{}"#, r#"[]"#),
        (r#"{"citations":[{"url":"https://a.com","title":"A","snippet":"s"},{"uri":"https://b.com","query":"qq","text":"tx"},{"href":"h://c","name":"N","description":"d","source":"src","provider":"prov"},{"source_url":"https://a.com"},{"title":"no url"},"str",null,{"url":" ","title":"blank"},{"url":5},{"url":"https://d.com","source":0,"provider":""}]}"#, r#"[{"title":"A","url":"https://a.com","snippet":"s","source":"native-web-search","provider":"native-web-search"},{"title":"qq","url":"https://b.com","snippet":"tx","source":"native-web-search","provider":"native-web-search"},{"title":"N","url":"h://c","snippet":"d","source":"src","provider":"prov"},{"title":"5","url":"5","snippet":"","source":"native-web-search","provider":"native-web-search"},{"title":"https://d.com","url":"https://d.com","snippet":"","source":"native-web-search","provider":"native-web-search"}]"#),
        (r#"{"webSearchCalls":[{"action":{"query":"find","sources":[{"url":"https://s1.com"},{"url":"https://s2.com","title":"T2"}],"url":"https://u.com","urls":["https://x1.com","https://s1.com",7]}},{"action":null},null,{"action":{"query":5,"url":"https://q.com"}},{"action":"str"}]}"#, r#"[{"title":"find","url":"https://s1.com","snippet":"","source":"native-web-search","provider":"native-web-search"},{"title":"T2","url":"https://s2.com","snippet":"","source":"native-web-search","provider":"native-web-search"},{"title":"find","url":"https://u.com","snippet":"","source":"native-web-search","provider":"native-web-search"},{"title":"find","url":"https://x1.com","snippet":"","source":"native-web-search","provider":"native-web-search"},{"title":"find","url":"7","snippet":"","source":"native-web-search","provider":"native-web-search"},{"title":"5","url":"https://q.com","snippet":"","source":"native-web-search","provider":"native-web-search"}]"#),
        (r#"{"citations":[{"url":"https://a.com","title":"first"}],"webSearchCalls":[{"action":{"query":"zz","url":"https://a.com"}}]}"#, r#"[{"title":"first","url":"https://a.com","snippet":"","source":"native-web-search","provider":"native-web-search"}]"#),
        (r#"{"citations":"x","webSearchCalls":{}}"#, r#"[]"#),
    ];
    for (result, want) in rows {
        assert_eq!(Value::Array(flatten_sources(&parsed(result))).to_string(), parsed(want).to_string(), "{result}");
    }
}
