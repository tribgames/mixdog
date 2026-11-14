//! Owner: s4-engine-actions-page
//! Device emulation (`emulation-validation.ts` and the order of `emulation-overrides.ts`): viewport, touch, user agent, locale,
//! timezone, media preferences, CPU, network conditions, geolocation and request headers. The compound command is validated before
//! the host is asked for anything, so a rejected command never leaves the page half reset. The host turns the switches into its CDP
//! overrides and keeps the siblings of a partial change (`host/browser/emulation`); what is decided here is what the command may
//! ask, which switches it names (in the order the agent reads them back) and the words of the reply.
//!
//! A JSON `null` in a field is read as the field being absent: a client that lists every optional field with `null` asks for nothing
//! by it.

use std::collections::BTreeMap;

use mixdog_app_protocol::v2::browser_engine::EmulationSpec;
use mixdog_app_protocol::v2::browser_engine::HostBrowserEmulationParams;
use mixdog_js::time::Tz;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;

use super::page::PageActionError;
use super::page::PageCall;
use super::page::finite;
use super::page::truthy;
use crate::reply::reply::ToolReply;

const NETWORK_PROFILES: [&str; 4] = ["none", "offline", "slow3g", "fast3g"];
const NO_ACTION: &str = "emulate requires reset and/or a viewport, touch, userAgent, locale, timezone, media, CPU, network, geolocation, or headers setting";

/// What an `emulate` command asks of the page: the reset, the overrides to lay over it, and the names of what changed.
#[derive(Debug, Clone, PartialEq)]
pub struct EmulationPlan {
    /// The page goes back to what it had before any override (the pane's own viewport).
    pub reset: bool,
    /// The overrides to apply after the reset; `None` when the command only resets.
    pub spec: Option<EmulationSpec>,
    /// What changed, in the order the command defines (`reset`, the viewport, touch, userAgent, locale, timezone, media, cpu, network,
    /// geolocation, headers).
    pub applied: Vec<String>,
}

/// A field of the command that is present (a `null` is absent).
fn field<'a>(input: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    input.get(key).filter(|value| !value.is_null())
}

/// `String(value)`.
fn text(value: &Value) -> String {
    mixdog_js::value_to_string(value)
}

fn number(value: &Value) -> f64 {
    mixdog_js::to_number(value)
}

fn assert_viewport(input: &Map<String, Value>) -> Result<bool, PageActionError> {
    let has_width = field(input, "width").and_then(finite).is_some();
    let has_height = field(input, "height").and_then(finite).is_some();
    if has_width != has_height {
        return Err(PageActionError::invalid("emulate requires width and height together"));
    }
    if !has_width && ["deviceScaleFactor", "mobile", "orientation"].iter().any(|key| field(input, key).is_some()) {
        return Err(PageActionError::invalid("deviceScaleFactor, mobile, and orientation require width and height"));
    }
    Ok(has_width)
}

fn assert_geolocation(input: &Map<String, Value>) -> Result<bool, PageActionError> {
    let latitude = field(input, "latitude");
    let longitude = field(input, "longitude");
    if latitude.is_some() != longitude.is_some() {
        return Err(PageActionError::invalid("emulate geolocation requires latitude and longitude together"));
    }
    if let (Some(latitude), Some(longitude)) = (latitude, longitude) {
        let (latitude, longitude) = (number(latitude), number(longitude));
        if !latitude.is_finite() || !longitude.is_finite() || latitude.abs() > 90.0 || longitude.abs() > 180.0 {
            return Err(PageActionError::invalid("emulate geolocation requires latitude within ±90 and longitude within ±180"));
        }
    }
    if field(input, "accuracy").is_some() && latitude.is_none() {
        return Err(PageActionError::invalid("emulate accuracy requires latitude and longitude"));
    }
    Ok(latitude.is_some())
}

fn assert_media(input: &Map<String, Value>) -> Result<(), PageActionError> {
    if field(input, "cpuThrottlingRate").is_some_and(|rate| !number(rate).is_finite()) {
        return Err(PageActionError::invalid("cpuThrottlingRate must be a finite number"));
    }
    if field(input, "orientation").is_some_and(|value| !matches!(value.as_str(), Some("portrait" | "landscape"))) {
        return Err(PageActionError::invalid("orientation must be portrait or landscape"));
    }
    if field(input, "colorScheme").is_some_and(|value| !matches!(value.as_str(), Some("auto" | "light" | "dark"))) {
        return Err(PageActionError::invalid("colorScheme must be auto, light, or dark"));
    }
    Ok(())
}

/// A header name is an HTTP token: `[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}`.
fn is_header_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 256 && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

fn assert_headers(headers: &Value) -> Result<(), PageActionError> {
    let Some(entries) = headers.as_object() else {
        return Err(PageActionError::invalid("headers must be an object"));
    };
    let valid = entries.len() <= 20
        && entries.iter().all(|(name, value)| is_header_name(name) && value.as_str().is_some_and(|value| utf16_len(value) <= 8_192 && !value.contains(['\r', '\n'])));
    if !valid {
        return Err(PageActionError::invalid("headers require at most 20 valid names and bounded single-line values"));
    }
    Ok(())
}

/// `new Intl.Locale(tag)` accepts a well-formed BCP 47 tag with `-` separators.
fn is_locale(tag: &str) -> bool {
    !tag.contains('_') && tag.parse::<icu_locale_core::Locale>().is_ok()
}

fn assert_identity(input: &Map<String, Value>) -> Result<(), PageActionError> {
    if let Some(locale) = field(input, "locale").filter(|value| truthy(value))
        && !is_locale(&text(locale))
    {
        return Err(PageActionError::invalid("locale must be a valid BCP 47 locale"));
    }
    if let Some(zone) = field(input, "timezone").filter(|value| truthy(value))
        && text(zone).parse::<Tz>().is_err()
    {
        return Err(PageActionError::invalid("timezone must be a valid IANA timezone"));
    }
    if let Some(agent) = field(input, "userAgent").and_then(Value::as_str)
        && (utf16_len(agent) > 2_048 || agent.contains(['\r', '\n']))
    {
        return Err(PageActionError::invalid("userAgent must be at most 2048 characters without line breaks"));
    }
    if let Some(headers) = field(input, "headers") {
        assert_headers(headers)?;
    }
    Ok(())
}

/// The viewport the command asks for, clamped as the host applies it: `(width, height, deviceScaleFactor)`.
fn viewport(input: &Map<String, Value>) -> (f64, f64, f64) {
    let side = |key: &str| field(input, key).and_then(finite).map_or(200.0, |size| size.trunc().clamp(200.0, 3840.0));
    let scale = field(input, "deviceScaleFactor").and_then(finite).map_or(1.0, |factor| factor.clamp(0.5, 4.0));
    (side("width"), side("height"), scale)
}

/// `validateEmulationCommand` and the order of the overrides: the whole command is checked, then described. Nothing is sent to the
/// host here.
pub fn plan(input: &Map<String, Value>) -> Result<EmulationPlan, PageActionError> {
    let has_viewport = assert_viewport(input)?;
    let has_geolocation = assert_geolocation(input)?;
    assert_media(input)?;
    assert_identity(input)?;
    let network_profile = field(input, "networkProfile").map(text);
    if let Some(profile) = &network_profile
        && !NETWORK_PROFILES.contains(&mixdog_js::js_to_lowercase(profile).as_str())
    {
        return Err(PageActionError::invalid("networkProfile must be none, offline, slow3g, or fast3g"));
    }
    let reset_is_true = input.get("reset") == Some(&Value::Bool(true));
    let names_a_switch = [
        "touch",
        "userAgent",
        "locale",
        "timezone",
        "colorScheme",
        "reducedMotion",
        "cpuThrottlingRate",
        "networkProfile",
        "headers",
    ]
    .iter()
    .any(|key| field(input, key).is_some());
    if !(reset_is_true || has_viewport || has_geolocation || names_a_switch) {
        return Err(PageActionError::invalid(NO_ACTION));
    }

    let reset = input.get("reset").is_some_and(truthy);
    let mut applied = Vec::new();
    if reset {
        applied.push("reset".to_owned());
    }
    let mut spec = EmulationSpec {
        width: None,
        height: None,
        device_scale_factor: None,
        mobile: None,
        touch: None,
        user_agent: None,
        locale: None,
        timezone: None,
        color_scheme: None,
        reduced_motion: None,
        network_profile: None,
        cpu_throttling_rate: None,
        orientation: None,
        latitude: None,
        longitude: None,
        accuracy: None,
        headers: None,
    };
    if has_viewport {
        let (width, height, scale) = viewport(input);
        let mobile = field(input, "mobile");
        spec.width = Some(width);
        spec.height = Some(height);
        spec.device_scale_factor = Some(scale);
        spec.mobile = Some(mobile == Some(&Value::Bool(true)));
        spec.orientation = field(input, "orientation").map(text);
        applied.push(format!(
            "{}x{}@{}{}",
            mixdog_js::number_to_string(width),
            mixdog_js::number_to_string(height),
            mixdog_js::number_to_string(scale),
            if mobile.is_some_and(truthy) { " mobile" } else { "" }
        ));
    }
    if let Some(touch) = field(input, "touch") {
        spec.touch = Some(truthy(touch));
        applied.push(format!("touch={}", text(touch)));
    }
    if let Some(agent) = field(input, "userAgent") {
        spec.user_agent = Some(text(agent));
        applied.push("userAgent".to_owned());
    }
    if let Some(locale) = field(input, "locale") {
        spec.locale = Some(text(locale));
        applied.push(format!("locale={}", if truthy(locale) { text(locale) } else { "default".to_owned() }));
    }
    if let Some(zone) = field(input, "timezone") {
        spec.timezone = Some(text(zone));
        applied.push(format!("timezone={}", if truthy(zone) { text(zone) } else { "default".to_owned() }));
    }
    let scheme = field(input, "colorScheme").filter(|value| truthy(value));
    let motion = field(input, "reducedMotion");
    if scheme.is_some() || motion.is_some() {
        spec.color_scheme = scheme.map(text);
        spec.reduced_motion = motion.map(truthy);
        applied.push("media".to_owned());
    }
    if let Some(rate) = field(input, "cpuThrottlingRate") {
        let rate = number(rate).clamp(1.0, 20.0);
        spec.cpu_throttling_rate = Some(rate);
        applied.push(format!("cpu={}x", mixdog_js::number_to_string(rate)));
    }
    if let Some(profile) = network_profile {
        applied.push(format!("network={profile}"));
        spec.network_profile = Some(profile);
    }
    if let (Some(latitude), Some(longitude)) = (field(input, "latitude"), field(input, "longitude")) {
        let (latitude, longitude) = (number(latitude), number(longitude));
        spec.latitude = Some(latitude);
        spec.longitude = Some(longitude);
        spec.accuracy = Some(field(input, "accuracy").and_then(finite).map_or(10.0, |accuracy| accuracy.clamp(1.0, 10_000.0)));
        applied.push(format!("geolocation={},{}", mixdog_js::number_to_string(latitude), mixdog_js::number_to_string(longitude)));
    }
    if let Some(Value::Object(headers)) = field(input, "headers") {
        let names: Vec<&String> = mixdog_js::js_object_keys(headers);
        applied.push(if names.is_empty() { "headers cleared".to_owned() } else { format!("headers={}", names.iter().map(|name| name.as_str()).collect::<Vec<_>>().join(",")) });
        spec.headers = Some(headers.iter().filter_map(|(name, value)| Some((name.clone(), value.as_str()?.to_owned()))).collect::<BTreeMap<_, _>>());
    }
    if applied.is_empty() {
        return Err(PageActionError::invalid(NO_ACTION));
    }
    let only_resets = applied == ["reset"];
    Ok(EmulationPlan { reset, spec: (!only_resets).then_some(spec), applied })
}

/// `emulate`: validates the command, then asks the host to reset the page's overrides and to lay the new ones over them. Returns what
/// changed; the caller reports the page afterwards and puts [`configured_reply`] around it. The caller also drops the refs it holds:
/// an override changes the page.
pub async fn emulate(call: &PageCall<'_>, input: &Map<String, Value>) -> Result<Vec<String>, PageActionError> {
    let plan = plan(input)?;
    if plan.reset {
        let clear = HostBrowserEmulationParams { page_id: call.page_id.to_owned(), overrides: None };
        call.host.emulation(clear, call.cancel).await?;
    }
    if let Some(spec) = plan.spec {
        let overrides = HostBrowserEmulationParams { page_id: call.page_id.to_owned(), overrides: Some(spec) };
        call.host.emulation(overrides, call.cancel).await?;
    }
    Ok(plan.applied)
}

/// The reply of an emulation: what was configured, ahead of the page's own reply.
pub fn configured_reply(applied: &[String], snapshot: ToolReply) -> ToolReply {
    ToolReply { text: format!("Emulation configured: {}\n\n{}", applied.join(", "), snapshot.text), ..snapshot }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use mixdog_rt::CancellationToken;

    fn input(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    fn refused(value: Value) -> String {
        plan(&input(value)).expect_err("refused").to_string()
    }

    #[test]
    fn compound_input_is_validated_before_anything_is_applied() {
        assert!(refused(json!({"reset": true, "width": 390})).contains("requires width and height together"));
        assert!(refused(json!({"width": 390, "height": 844, "networkProfile": "satellite"})).contains("networkProfile must be none, offline, slow3g, or fast3g"));
        assert!(refused(json!({"latitude": 37.5})).contains("latitude and longitude together"));
        assert!(refused(json!({"reset": true, "timezone": "Not/A_Real_Zone"})).contains("timezone must be a valid IANA timezone"));
        assert_eq!(refused(json!({"mobile": true})), "deviceScaleFactor, mobile, and orientation require width and height");
        assert_eq!(refused(json!({"latitude": 91, "longitude": 0})), "emulate geolocation requires latitude within ±90 and longitude within ±180");
        assert_eq!(refused(json!({"accuracy": 5, "touch": true})), "emulate accuracy requires latitude and longitude");
        assert_eq!(refused(json!({"cpuThrottlingRate": "fast"})), "cpuThrottlingRate must be a finite number");
        assert_eq!(refused(json!({"width": 300, "height": 300, "orientation": "diagonal"})), "orientation must be portrait or landscape");
        assert_eq!(refused(json!({"colorScheme": "sepia"})), "colorScheme must be auto, light, or dark");
        assert_eq!(refused(json!({"locale": "not a locale"})), "locale must be a valid BCP 47 locale");
        assert_eq!(refused(json!({"locale": "en_US"})), "locale must be a valid BCP 47 locale");
        assert_eq!(refused(json!({"userAgent": "a\nb"})), "userAgent must be at most 2048 characters without line breaks");
        assert_eq!(refused(json!({"userAgent": "x".repeat(2_049)})), "userAgent must be at most 2048 characters without line breaks");
        assert_eq!(refused(json!({"headers": []})), "headers must be an object");
        assert_eq!(refused(json!({})), NO_ACTION);
    }

    #[test]
    fn headers_need_valid_names_and_bounded_single_line_values() {
        let message = "headers require at most 20 valid names and bounded single-line values";
        assert_eq!(refused(json!({"headers": {"bad name": "x"}})), message);
        assert_eq!(refused(json!({"headers": {"X-A": "a\r\nb"}})), message);
        assert_eq!(refused(json!({"headers": {"X-A": 1}})), message);
        assert_eq!(refused(json!({"headers": {"X-A": "y".repeat(8_193)}})), message);
        let many: Map<String, Value> = (0..21).map(|index| (format!("X-{index}"), json!("v"))).collect();
        assert_eq!(refused(json!({"headers": many})), message);
        assert!(plan(&input(json!({"headers": {"X-Agent": "1", "accept-language": "ko"}}))).is_ok());
    }

    #[test]
    fn the_switches_are_named_in_the_order_the_command_defines() {
        let plan = plan(&input(json!({
            "reset": true, "width": 5000, "height": 100, "deviceScaleFactor": 9, "mobile": true, "touch": true, "userAgent": "Custom/2.0", "locale": "ko-KR",
            "timezone": "Asia/Seoul", "colorScheme": "dark", "reducedMotion": true, "cpuThrottlingRate": 50, "networkProfile": "Slow3G",
            "latitude": 37.5, "longitude": 127, "accuracy": 99999, "headers": {"X-Agent": "1", "X-B": "2"}
        })))
        .expect("plan");
        assert!(plan.reset);
        assert_eq!(
            plan.applied,
            [
                "reset",
                "3840x200@4 mobile",
                "touch=true",
                "userAgent",
                "locale=ko-KR",
                "timezone=Asia/Seoul",
                "media",
                "cpu=20x",
                "network=Slow3G",
                "geolocation=37.5,127",
                "headers=X-Agent,X-B"
            ]
        );
        let spec = plan.spec.expect("spec");
        assert_eq!((spec.width, spec.height, spec.device_scale_factor, spec.mobile), (Some(3840.0), Some(200.0), Some(4.0), Some(true)));
        assert_eq!((spec.cpu_throttling_rate, spec.accuracy), (Some(20.0), Some(10_000.0)));
        assert_eq!((spec.color_scheme.as_deref(), spec.reduced_motion, spec.network_profile.as_deref()), (Some("dark"), Some(true), Some("Slow3G")));
        assert_eq!(spec.headers.map(|headers| headers.len()), Some(2));
    }

    #[test]
    fn an_empty_value_names_the_default_and_a_command_may_only_reset() {
        let cleared = plan(&input(json!({"locale": "", "timezone": "", "headers": {}, "touch": false}))).expect("plan");
        assert_eq!(cleared.applied, ["touch=false", "locale=default", "timezone=default", "headers cleared"]);
        assert!(!cleared.reset);
        let only = plan(&input(json!({"reset": true}))).expect("plan");
        assert_eq!((only.reset, only.spec, only.applied), (true, None, vec!["reset".to_owned()]));
        let viewport = plan(&input(json!({"width": 390, "height": 844, "orientation": "landscape"}))).expect("plan");
        assert_eq!(viewport.applied, ["390x844@1"]);
        assert_eq!(viewport.spec.and_then(|spec| spec.orientation).as_deref(), Some("landscape"));
    }

    #[test]
    fn a_null_field_asks_for_nothing() {
        let plan = plan(&input(json!({"width": null, "latitude": null, "touch": true, "locale": null}))).expect("plan");
        assert_eq!(plan.applied, ["touch=true"]);
    }

    #[tokio::test]
    async fn a_rejected_command_never_reaches_the_host() {
        let host = FakeHost::scripted(Vec::new());
        let cancel = CancellationToken::new();
        let call = PageCall { host: &host, page_id: "p1", cancel: &cancel };
        let error = emulate(&call, &input(json!({"reset": true, "width": 390}))).await.expect_err("rejected");
        assert!(error.to_string().contains("requires width and height together"));
        assert!(host.calls().is_empty());
    }

    #[tokio::test]
    async fn a_reset_clears_the_overrides_before_the_new_ones_are_laid_over() {
        let host = FakeHost::scripted(vec![
            Expect::ok("host/browser/emulation", json!({"applied": null, "facts": page_facts("p1", 2)})).with_params(json!({"pageId": "p1", "overrides": null})),
            Expect::ok("host/browser/emulation", json!({"applied": {"locale": "ko-KR"}, "facts": page_facts("p1", 3)})).with_params(json!({"overrides": {"locale": "ko-KR"}})),
        ]);
        let cancel = CancellationToken::new();
        let call = PageCall { host: &host, page_id: "p1", cancel: &cancel };
        let applied = emulate(&call, &input(json!({"reset": true, "locale": "ko-KR"}))).await.expect("emulated");
        assert_eq!(applied, ["reset", "locale=ko-KR"]);
        host.finish().expect("script");

        let only = FakeHost::scripted(vec![Expect::ok("host/browser/emulation", json!({"applied": null, "facts": page_facts("p1", 2)}))]);
        let call = PageCall { host: &only, page_id: "p1", cancel: &cancel };
        assert_eq!(emulate(&call, &input(json!({"reset": true}))).await.expect("emulated"), ["reset"]);
        only.finish().expect("script");
    }

    #[test]
    fn the_reply_names_what_was_configured_ahead_of_the_page() {
        let reply = configured_reply(&["reset".to_owned(), "touch=true".to_owned()], ToolReply::text("Snapshot: p1-s3"));
        assert_eq!(reply.text, "Emulation configured: reset, touch=true\n\nSnapshot: p1-s3");
    }
}
