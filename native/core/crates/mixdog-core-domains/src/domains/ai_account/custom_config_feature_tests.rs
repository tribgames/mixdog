//! The custom-provider config normalizer: what a saved config becomes, or the exact refusal that names the field.

use serde_json::{Value, json};

use super::custom_config::{normalize, normalize_input};

fn v2(extra: Value) -> Value {
    let mut config = json!({ "baseURL": "http://localhost:1234/v1", "name": "P", "protocol": "openai-chat", "schemaVersion": 2 });
    config.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    config
}

fn refusal(config: Value) -> String {
    normalize(&config).expect_err("the config is refused")
}

fn normalized(config: Value) -> Value {
    normalize(&config).expect("the config is accepted")
}

#[test]
fn a_minimal_config_gets_the_defaults_and_the_current_schema_version() {
    let legacy = normalized(json!({ "baseURL": "http://localhost:1234/v1", "name": "P", "protocol": "openai-chat" }));
    assert_eq!(
        legacy,
        json!({
            "auth": "key", "baseURL": "http://localhost:1234/v1", "discovery": { "newModelsHidden": false }, "enabled": true,
            "modelOverrides": {}, "name": "P", "protocol": "openai-chat", "schemaVersion": 2, "type": "custom"
        })
    );
    assert_eq!(normalized(v2(json!({}))), legacy);
}

#[test]
fn a_legacy_models_list_becomes_manual_overrides_that_hide_new_models() {
    let config = normalized(json!({
        "baseURL": "http://localhost:1234/v1", "name": "P", "protocol": "openai-chat",
        "models": [{ "contextWindow": "8000", "id": "a", "maxOutputTokens": 512, "name": " Alpha " }, { "id": "b" }]
    }));
    assert_eq!(config["discovery"], json!({ "newModelsHidden": true }));
    assert_eq!(
        config["modelOverrides"],
        json!({ "a": { "contextWindow": 8000, "hidden": false, "manual": true, "maxOutputTokens": 512, "name": "Alpha" }, "b": { "hidden": false, "manual": true } })
    );
    let blank =
        normalized(json!({ "baseURL": "http://localhost:1234/v1", "name": "P", "protocol": "openai-chat", "models": [{ "contextWindow": "", "id": "a" }] }));
    assert_eq!(blank["modelOverrides"], json!({ "a": { "hidden": false, "manual": true } }));
    let huge =
        normalized(json!({ "baseURL": "http://localhost:1234/v1", "name": "P", "protocol": "openai-chat", "models": [{ "contextWindow": 1e300, "id": "a" }] }));
    assert_eq!(huge["modelOverrides"], json!({ "a": { "hidden": false, "manual": true } }), "an unrepresentable window is dropped");
}

#[test]
fn a_legacy_config_refuses_what_only_version_two_has_and_a_bad_models_list() {
    let legacy = |extra: Value| {
        let mut config = json!({ "baseURL": "http://localhost:1234/v1", "name": "P", "protocol": "openai-chat" });
        config.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        refusal(config)
    };
    for (extra, want) in [
        (json!({ "models": "x" }), "[custom-provider] models must be an array"),
        (json!({ "models": [{ "id": "a" }, { "id": "a" }] }), "[custom-provider] duplicate model id: a"),
        (json!({ "models": [null] }), "[custom-provider] every model id must be a non-empty string"),
        (json!({ "models": [{ "contextWindow": 1.5, "id": "a" }] }), "[custom-provider] modelOverrides[a].contextWindow must be a positive integer"),
        (json!({ "wires": ["chat"] }), "[custom-provider] wires and modelWires require schemaVersion 2"),
        (json!({ "modelOverrides": {} }), "[custom-provider] modelOverrides and discovery require schemaVersion 2"),
        (json!({ "headers": {} }), "[custom-provider] headers require schemaVersion 2"),
        (json!({ "requestBody": {} }), "[custom-provider] requestBody requires schemaVersion 2"),
    ] {
        assert_eq!(legacy(extra.clone()), want, "{extra}");
    }
    assert_eq!(normalized(json!({ "auth": "none", "baseURL": "http://localhost:1234/v1", "name": "P", "protocol": "openai-chat" }))["auth"], "none");
}

#[test]
fn the_top_level_fields_are_checked_one_by_one() {
    assert_eq!(normalize(&json!("text")).unwrap_err(), "[custom-provider] config must be an object");
    assert_eq!(normalize(&json!([])).unwrap_err(), "[custom-provider] config must be an object");
    for (extra, want) in [
        (json!({ "schemaVersion": 3 }), "[custom-provider] unsupported schemaVersion 3; update mixdog to use this provider"),
        (json!({ "schemaVersion": "two" }), "[custom-provider] invalid schemaVersion: two"),
        (json!({ "schemaVersion": 1 }), "[custom-provider] invalid schemaVersion: 1"),
        (json!({ "extra": 1 }), "[custom-provider] config has unsupported field: extra"),
        (json!({ "type": "other" }), "[custom-provider] invalid type: other"),
        (json!({ "protocol": 3 }), "[custom-provider] protocol must be a string"),
        (json!({ "protocol": "grpc" }), "[custom-provider] unsupported protocol: grpc"),
        (json!({ "auth": "maybe" }), "[custom-provider] invalid auth: maybe"),
        (json!({ "enabled": "yes" }), "[custom-provider] enabled must be a boolean"),
        (json!({ "preconnect": 1 }), "[custom-provider] preconnect must be a boolean"),
        (json!({ "name": "" }), "[custom-provider] name is required"),
        (json!({ "name": 3 }), "[custom-provider] name must be a string"),
        (json!({ "name": "x".repeat(201) }), "[custom-provider] name must be at most 200 characters"),
        (json!({ "name": "a\u{7}b" }), "[custom-provider] name must not contain control characters"),
        (json!({ "apiKeyEnv": "1BAD" }), "[custom-provider] apiKeyEnv must be a valid environment variable name"),
    ] {
        assert_eq!(refusal(v2(extra.clone())), want, "{extra}");
    }
    let mut no_protocol = v2(json!({}));
    no_protocol.as_object_mut().unwrap().remove("protocol");
    assert_eq!(refusal(no_protocol), "[custom-provider] protocol is required");
}

#[test]
fn transport_fields_are_ignored_the_name_is_trimmed_and_a_disabled_provider_stays_disabled() {
    let config = normalized(v2(json!({ "apiKey": "k", "id": "custom-x", "preconnect": true, "name": "  Spaced  ", "enabled": false })));
    assert_eq!((config["name"].clone(), config["enabled"].clone()), (json!("Spaced"), json!(false)));
    assert!(config.get("apiKey").is_none() && config.get("id").is_none() && config.get("preconnect").is_none());
}

#[test]
fn the_base_url_is_checked_and_stripped_of_trailing_slashes() {
    for (url, want) in [
        ("", "[custom-provider] baseURL is required"),
        ("not a url", "[custom-provider] invalid baseURL: not a url"),
        ("ftp://example.com", "[custom-provider] baseURL must use http or https"),
        ("https://u:p@example.com/v1", "[custom-provider] baseURL must not embed credentials"),
        ("https://example.com/v1?x=1", "[custom-provider] baseURL must not contain a query or hash"),
        ("https://example.com/v1#x", "[custom-provider] baseURL must not contain a query or hash"),
        ("https://example.com/v1?", "[custom-provider] baseURL must not contain a query or hash"),
        ("http://example.com/v1", "[provider:custom] baseURL must use https for non-localhost host (got http://example.com)"),
    ] {
        assert_eq!(refusal(v2(json!({ "baseURL": url }))), want, "{url}");
    }
    assert_eq!(
        refusal(v2(json!({ "baseURL": format!("https://example.com/{}", "x".repeat(2100)) }))),
        "[custom-provider] baseURL must be at most 2048 characters"
    );
    for (url, want) in [
        ("http://[::1]:8080/v1", "http://[::1]:8080/v1"),
        ("http://127.0.0.1/v1///", "http://127.0.0.1/v1"),
        (" https://example.com/api/// ", "https://example.com/api"),
        ("https://api.example.com/", "https://api.example.com"),
    ] {
        assert_eq!(normalized(v2(json!({ "baseURL": url })))["baseURL"], want, "{url}");
    }
}

#[test]
fn the_api_key_variable_is_kept_only_for_a_provider_that_uses_a_key() {
    assert_eq!(normalized(v2(json!({ "apiKeyEnv": "MY_KEY" })))["apiKeyEnv"], "MY_KEY");
    assert!(normalized(v2(json!({ "apiKeyEnv": "MY_KEY", "auth": "none" }))).get("apiKeyEnv").is_none());
    assert!(normalized(v2(json!({ "apiKeyEnv": null }))).get("apiKeyEnv").is_none());
}

#[test]
fn discovery_takes_only_the_new_models_hidden_switch() {
    assert_eq!(normalized(v2(json!({ "discovery": { "newModelsHidden": true } })))["discovery"], json!({ "newModelsHidden": true }));
    for (discovery, want) in [
        (json!(null), "[custom-provider] discovery must be an object"),
        (json!({ "other": 1 }), "[custom-provider] discovery has unsupported field: other"),
        (json!({ "newModelsHidden": "yes" }), "[custom-provider] discovery.newModelsHidden must be a boolean"),
    ] {
        assert_eq!(refusal(v2(json!({ "discovery": discovery }))), want);
    }
}

#[test]
fn wires_are_sorted_checked_and_must_include_the_protocol_wire() {
    assert_eq!(normalized(v2(json!({ "wires": ["messages", "chat"] })))["wires"], json!(["chat", "messages"]));
    for (extra, want) in [
        (json!({ "wires": [] }), "[custom-provider] wires must be a non-empty array"),
        (json!({ "wires": "chat" }), "[custom-provider] wires must be a non-empty array"),
        (json!({ "wires": ["chat", "grpc"] }), "[custom-provider] wires has unsupported wire: grpc"),
        (json!({ "wires": ["chat", "chat"] }), "[custom-provider] wires has duplicate wire: chat"),
        (json!({ "wires": ["responses"] }), "[custom-provider] wires must include the protocol wire: chat"),
        (json!({ "protocol": "anthropic", "wires": ["messages"] }), "[custom-provider] wires requires an 'openai-chat' or 'openai-responses' protocol"),
    ] {
        assert_eq!(refusal(v2(extra.clone())), want, "{extra}");
    }
}

#[test]
fn a_model_wire_must_be_one_of_the_served_wires() {
    assert_eq!(normalized(v2(json!({ "modelWires": { "m1": "responses" }, "wires": ["chat", "responses"] })))["modelWires"], json!({ "m1": "responses" }));
    assert_eq!(
        normalized(v2(json!({ "modelWires": { "m1": "chat" } })))["modelWires"],
        json!({ "m1": "chat" }),
        "without wires only the protocol wire is served"
    );
    for (extra, want) in [
        (json!({ "modelWires": { "m1": "responses" } }), "[custom-provider] modelWires[m1] must be one of the served wires: chat"),
        (json!({ "modelWires": [] }), "[custom-provider] modelWires must be an object"),
        (
            json!({ "protocol": "anthropic", "modelWires": { "m": "messages" } }),
            "[custom-provider] modelWires requires an 'openai-chat' or 'openai-responses' protocol",
        ),
        (json!({ "modelWires": { " m": "chat" } }), "[custom-provider] modelWires key must not have surrounding whitespace: \" m\""),
    ] {
        assert_eq!(refusal(v2(extra.clone())), want, "{extra}");
    }
}

#[test]
fn headers_are_trimmed_and_may_not_carry_authentication() {
    assert_eq!(normalized(v2(json!({ "headers": { "X-Team": " blue ", "x-other": "v" } })))["headers"], json!({ "X-Team": "blue", "x-other": "v" }));
    assert_eq!(normalized(v2(json!({ "headers": { "X-A": "é" } })))["headers"], json!({ "X-A": "é" }), "latin-1 is a valid header value");
    for (headers, want) in [
        (json!([]), "[custom-provider] headers must be an object of header names to string values"),
        (json!({ "Authorization": "x" }), "[custom-provider] headers must not set Authorization: authentication belongs to the API key field"),
        (json!({ "API-Key": "x" }), "[custom-provider] headers must not set API-Key: authentication belongs to the API key field"),
        (json!({ "X-A": "1", "x-a": "2" }), "[custom-provider] headers has duplicate header: x-a"),
        (json!({ "bad name": "1" }), "[custom-provider] headers has an invalid header name: \"bad name\""),
        (json!({ "": "1" }), "[custom-provider] headers has an invalid header name: \"\""),
        (json!({ "X-A": 1 }), "[custom-provider] headers.X-A must be a string"),
        (json!({ "X-A": "a\nb" }), "[custom-provider] headers.X-A has an invalid value"),
        (json!({ "X-A": "€" }), "[custom-provider] headers.X-A has an invalid value"),
    ] {
        assert_eq!(refusal(v2(json!({ "headers": headers }))), want);
    }
    let many: serde_json::Map<String, Value> = (0..65).map(|n| (format!("X-{n}"), json!("v"))).collect();
    assert_eq!(refusal(v2(json!({ "headers": many }))), "[custom-provider] at most 64 headers are allowed");
}

#[test]
fn the_request_body_may_not_set_what_the_app_owns_and_is_bounded() {
    assert_eq!(normalized(v2(json!({ "requestBody": { "seed": 7, "top_p": 0.5 } })))["requestBody"], json!({ "seed": 7, "top_p": 0.5 }));
    for (body, want) in [
        (json!({ "model": "x" }), "[custom-provider] requestBody must not set model: the app owns this field"),
        (json!(3), "[custom-provider] requestBody must be a JSON object"),
        (json!({ "a": "x".repeat(17000) }), "[custom-provider] requestBody must be at most 16384 characters"),
    ] {
        assert_eq!(refusal(v2(json!({ "requestBody": body }))), want);
    }
    let unsafe_key: Value =
        serde_json::from_str(r#"{"baseURL":"http://localhost:1234/v1","name":"P","protocol":"openai-chat","schemaVersion":2,"requestBody":{"__proto__":1}}"#)
            .unwrap();
    assert_eq!(refusal(unsafe_key), "[custom-provider] requestBody has an unsafe key: __proto__");
}

#[test]
fn model_overrides_keep_what_they_set_and_refuse_what_they_do_not_know() {
    let kept = json!({ "m1": { "contextWindow": 9000, "hidden": true, "manual": true, "maxOutputTokens": 800, "name": "M One", "supportsVision": false } });
    assert_eq!(normalized(v2(json!({ "modelOverrides": kept.clone() })))["modelOverrides"], kept);
    assert_eq!(normalized(v2(json!({ "modelOverrides": { "m1": { "manual": false } } })))["modelOverrides"], json!({ "m1": {} }), "manual false is dropped");
    let request = json!({ "m1": { "requestBody": { "top_k": 3 }, "requestHeaders": { "X-M": "v" } } });
    assert_eq!(normalized(v2(json!({ "modelOverrides": request.clone() })))["modelOverrides"], request);
    for (overrides, want) in [
        (json!([]), "[custom-provider] modelOverrides must be an object"),
        (json!({ "m1": 3 }), "[custom-provider] modelOverrides[m1] must be an object"),
        (json!({ "m1": { "other": 1 } }), "[custom-provider] modelOverrides[m1] has unsupported field: other"),
        (json!({ "m1": { "name": "  " } }), "[custom-provider] modelOverrides[m1].name must be non-empty"),
        (json!({ "m1": { "contextWindow": "8000" } }), "[custom-provider] modelOverrides[m1].contextWindow must be a positive integer"),
        (json!({ "m1": { "contextWindow": 0 } }), "[custom-provider] modelOverrides[m1].contextWindow must be a positive integer"),
        (json!({ "m1": { "contextWindow": 8000.5 } }), "[custom-provider] modelOverrides[m1].contextWindow must be a positive integer"),
        (json!({ "m1": { "hidden": 1 } }), "[custom-provider] modelOverrides[m1].hidden must be a boolean"),
        (json!({ "": {} }), "[custom-provider] every modelOverrides key must be a non-empty string"),
        (
            json!({ "m1": { "requestHeaders": { "Host": "x" } } }),
            "[custom-provider] modelOverrides[m1].requestHeaders must not set Host: the app owns this header",
        ),
    ] {
        assert_eq!(refusal(v2(json!({ "modelOverrides": overrides.clone() }))), want, "{overrides}");
    }
    let long_key: serde_json::Map<String, Value> = [("x".repeat(300), json!({}))].into_iter().collect();
    assert_eq!(refusal(v2(json!({ "modelOverrides": long_key }))), "[custom-provider] modelOverrides key must be at most 256 characters");
    let many: serde_json::Map<String, Value> = (0..501).map(|n| (format!("m{n}"), json!({}))).collect();
    assert_eq!(refusal(v2(json!({ "modelOverrides": many }))), "[custom-provider] at most 500 model overrides are allowed");
    let unsafe_key: Value = serde_json::from_str(
        r#"{"baseURL":"http://localhost:1234/v1","name":"P","protocol":"openai-chat","schemaVersion":2,"modelOverrides":{"__proto__":{}}}"#,
    )
    .unwrap();
    assert_eq!(refusal(unsafe_key), "[custom-provider] unsafe modelOverrides key: __proto__");
}

#[test]
fn a_model_reasoning_override_sorts_its_levels_and_trims_its_wire_values() {
    let reasoning = json!({ "levels": ["high", "ultra", "low"], "replay": true, "wireFormat": "vllm", "wireValues": { "high": " hi ", "max": "mx" } });
    let config = normalized(v2(json!({ "modelOverrides": { "m1": { "reasoning": reasoning } } })));
    assert_eq!(
        config["modelOverrides"]["m1"]["reasoning"],
        json!({ "levels": ["low", "high", "max"], "replay": true, "wireFormat": "vllm", "wireValues": { "high": "hi", "max": "mx" } })
    );
    assert_eq!(
        normalized(v2(json!({ "modelOverrides": { "m1": { "reasoning": {} } } })))["modelOverrides"],
        json!({ "m1": {} }),
        "an empty reasoning is dropped"
    );
}

#[test]
fn a_model_reasoning_override_refuses_what_it_cannot_send() {
    let reasoning = |reasoning: Value, protocol: &str| refusal(v2(json!({ "protocol": protocol, "modelOverrides": { "m1": { "reasoning": reasoning } } })));
    for (value, want) in [
        (json!([]), "[custom-provider] modelOverrides[m1].reasoning must be an object"),
        (json!({ "other": 1 }), "[custom-provider] modelOverrides[m1].reasoning has unsupported field: other"),
        (json!({ "levels": "high" }), "[custom-provider] modelOverrides[m1].reasoning.levels must be an array"),
        (json!({ "levels": ["loud"] }), "[custom-provider] modelOverrides[m1].reasoning.levels has unknown level: loud"),
        (json!({ "levels": ["high", "HIGH"] }), "[custom-provider] modelOverrides[m1].reasoning.levels has duplicate level: high"),
        (json!({ "wireFormat": "x" }), "[custom-provider] modelOverrides[m1].reasoning.wireFormat is invalid: x"),
        (json!({ "levels": ["low"], "wireValues": { "high": "x" } }), "[custom-provider] modelOverrides[m1].reasoning.wireValues level high is not in levels"),
        (json!({ "wireValues": { "loud": "x" } }), "[custom-provider] modelOverrides[m1].reasoning.wireValues has unknown level: loud"),
        (json!({ "wireValues": { "HIGH": "y", "high": "x" } }), "[custom-provider] modelOverrides[m1].reasoning.wireValues has duplicate level: high"),
        (json!({ "wireValues": { "high": " " } }), "[custom-provider] modelOverrides[m1].reasoning.wireValues.high must be non-empty"),
        (json!({ "wireValues": { "high": 1 } }), "[custom-provider] modelOverrides[m1].reasoning.wireValues.high must be a string"),
        (json!({ "wireValues": { "high": "x".repeat(65) } }), "[custom-provider] modelOverrides[m1].reasoning.wireValues.high must be at most 64 characters"),
        (json!({ "replay": "yes" }), "[custom-provider] modelOverrides[m1].reasoning.replay must be a boolean"),
    ] {
        assert_eq!(reasoning(value.clone(), "openai-chat"), want, "{value}");
    }
    assert_eq!(
        reasoning(json!({ "wireFormat": "deepseek" }), "openai-responses"),
        "[custom-provider] modelOverrides[m1].reasoning.wireFormat 'deepseek' requires protocol 'openai-chat'"
    );
}

/// A lone surrogate in a client's request body is one character here (U+FFFD) but six in Node's `JSON.stringify` (`\ud83d`),
/// so each counts five more toward the 16384-character bound.
#[test]
fn a_request_body_is_measured_with_each_lone_surrogate_as_its_six_character_escape() {
    // `{"x":"…"}` is 8 characters around the text: 8 + 2 + 2729 + 5 * 2729 is 16384, one more lone unit is one too many.
    let at_limit = format!("{}ab", "\u{fffd}".repeat(2729));
    let input = |text: &str| json!({ "name": "Lone", "protocol": "openai-chat", "baseURL": "http://127.0.0.1:1/v1", "auth": "none", "schemaVersion": 2, "requestBody": { "x": text } });
    assert!(normalize_input(&input(&at_limit), 2729).is_ok());
    let past = format!("{}ab", "\u{fffd}".repeat(2730));
    assert_eq!(normalize_input(&input(&past), 2730).unwrap_err(), "[custom-provider] requestBody must be at most 16384 characters");
    assert!(normalize_input(&input(&at_limit), 0).is_ok(), "without the lone units the same text is far under the bound");
}
