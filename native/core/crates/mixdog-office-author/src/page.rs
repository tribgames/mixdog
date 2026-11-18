//! A browser page driven over [`Cdp`]: what the authoring routes called on a puppeteer `Page` and on the elements they
//! took from it. The parameters sent to the browser are the ones puppeteer-core 25.16 sends for the same call, so the
//! browser lays out, photographs and prints as it did for Node.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_js::math::round as js_round;
use serde_json::Value;
use serde_json::json;

use crate::cdp::Cdp;
use crate::cdp::timed_out;

/// puppeteer's default navigation and wait limit.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// A rectangle in CSS px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    /// puppeteer's `roundRectangle`: the corner rounded, and the size so that the far corner is rounded too.
    pub fn rounded(self) -> Self {
        let x = js_round(self.x);
        let y = js_round(self.y);
        Self { x, y, width: js_round(self.width + self.x - x), height: js_round(self.height + self.y - y) }
    }
}

/// `page.setViewport` with the fields the routes set (not mobile, no touch, portrait).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
}

/// The lifecycle event a navigation waits for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitUntil {
    Load,
    DomContentLoaded,
}

impl WaitUntil {
    fn event(self) -> &'static str {
        match self {
            Self::Load => "load",
            Self::DomContentLoaded => "DOMContentLoaded",
        }
    }
}

/// `page.screenshot` options. With a clip the browser captures beyond the viewport, as puppeteer does; without one it
/// captures the viewport.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ScreenshotOptions {
    pub clip: Option<Rect>,
    pub omit_background: bool,
}

/// A page length: a number is CSS px, a string carries its unit (`px`, `in`, `cm`, `mm`, `pt`, `pc`; none is px).
#[derive(Clone, Debug, PartialEq)]
pub enum Length {
    Pixels(f64),
    Text(String),
}

/// The margins of a printed page.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Margin {
    pub top: Option<Length>,
    pub right: Option<Length>,
    pub bottom: Option<Length>,
    pub left: Option<Length>,
}

/// `page.pdf` options and puppeteer's defaults for what is not given: tagged, fonts awaited, scale 1.
#[derive(Clone, Debug, PartialEq)]
pub struct PdfOptions {
    pub format: Option<String>,
    pub width: Option<Length>,
    pub height: Option<Length>,
    pub margin: Margin,
    pub scale: f64,
    pub landscape: bool,
    pub print_background: bool,
    pub prefer_css_page_size: bool,
    pub tagged: bool,
    pub outline: bool,
    pub display_header_footer: bool,
    pub header_template: String,
    pub footer_template: String,
    pub page_ranges: String,
    pub omit_background: bool,
    pub wait_for_fonts: bool,
    pub timeout: Duration,
}

impl Default for PdfOptions {
    fn default() -> Self {
        Self {
            format: None,
            width: None,
            height: None,
            margin: Margin::default(),
            scale: 1.0,
            landscape: false,
            print_background: false,
            prefer_css_page_size: false,
            tagged: true,
            outline: false,
            display_header_footer: false,
            header_template: String::new(),
            footer_template: String::new(),
            page_ranges: String::new(),
            omit_background: false,
            wait_for_fonts: true,
            timeout: DEFAULT_TIMEOUT,
        }
    }
}

/// `paperFormats` in inches.
fn paper_inches(format: &str) -> Option<(f64, f64)> {
    Some(match format.to_lowercase().as_str() {
        "letter" => (8.5, 11.0),
        "legal" => (8.5, 14.0),
        "tabloid" => (11.0, 17.0),
        "ledger" => (17.0, 11.0),
        "a0" => (33.1102, 46.811),
        "a1" => (23.3858, 33.1102),
        "a2" => (16.5354, 23.3858),
        "a3" => (11.6929, 16.5354),
        "a4" => (8.2677, 11.6929),
        "a5" => (5.8268, 8.2677),
        "a6" => (4.1339, 5.8268),
        _ => return None,
    })
}

/// `convertPrintParameterToInches`.
fn inches(length: Option<&Length>) -> Result<Option<f64>, String> {
    let Some(length) = length else { return Ok(None) };
    let pixels = match length {
        Length::Pixels(pixels) => *pixels,
        Length::Text(text) => {
            let chars: Vec<char> = text.chars().collect();
            let tail: String = chars[chars.len().saturating_sub(2)..].iter().collect::<String>().to_lowercase();
            let per_pixel = |unit: &str| match unit {
                "px" => Some(1.0),
                "in" => Some(96.0),
                "cm" => Some(96.0 / 2.54),
                "mm" => Some(96.0 / 25.4),
                "pt" => Some(96.0 / 72.0),
                "pc" => Some(16.0),
                _ => None,
            };
            let (unit, number) = match per_pixel(&tail) {
                Some(unit) => (unit, chars[..chars.len() - 2].iter().collect::<String>()),
                None => (1.0, text.clone()),
            };
            let value = mixdog_js::string_to_number(&number);
            if value.is_nan() {
                return Err(format!("Failed to parse parameter value: {text}"));
            }
            value * unit
        }
    };
    Ok(Some(pixels / 96.0))
}

impl PdfOptions {
    /// The parameters of `Page.printToPDF` puppeteer-core sends for these options.
    pub fn print_params(&self) -> Result<Value, String> {
        let (mut width, mut height) = (8.5, 11.0);
        if let Some(format) = &self.format {
            (width, height) = paper_inches(format).ok_or_else(|| format!("Unknown paper format: {format}"))?;
        } else {
            width = inches(self.width.as_ref())?.unwrap_or(width);
            height = inches(self.height.as_ref())?.unwrap_or(height);
        }
        let margin = |side: &Option<Length>| inches(side.as_ref()).map(|value| value.unwrap_or(0.0));
        // Chromium bug 840455: an outline needs the tagged structure.
        let tagged = self.tagged || self.outline;
        Ok(json!({
            "transferMode": "ReturnAsStream",
            "landscape": self.landscape,
            "displayHeaderFooter": self.display_header_footer,
            "headerTemplate": self.header_template,
            "footerTemplate": self.footer_template,
            "printBackground": self.print_background,
            "scale": mixdog_js::json_number(self.scale),
            "paperWidth": mixdog_js::json_number(width),
            "paperHeight": mixdog_js::json_number(height),
            "marginTop": mixdog_js::json_number(margin(&self.margin.top)?),
            "marginBottom": mixdog_js::json_number(margin(&self.margin.bottom)?),
            "marginLeft": mixdog_js::json_number(margin(&self.margin.left)?),
            "marginRight": mixdog_js::json_number(margin(&self.margin.right)?),
            "pageRanges": self.page_ranges,
            "preferCSSPageSize": self.prefer_css_page_size,
            "generateTaggedPDF": tagged,
            "generateDocumentOutline": self.outline,
        }))
    }
}

/// The message of an exception thrown in the page, as puppeteer's evaluation error gives it: an error object's
/// description without its stack and its `Error: ` name, anything else its value.
fn exception_message(details: &Value) -> String {
    let Some(exception) = details.get("exception") else {
        return details.get("text").and_then(Value::as_str).unwrap_or("Evaluation failed").to_string();
    };
    if let Some(description) = exception.get("description").and_then(Value::as_str) {
        let head = description.split("\n    at ").next().unwrap_or(description);
        return match head.split_once(": ") {
            Some((name, message)) if name.ends_with("Error") && !name.contains(' ') => message.to_string(),
            _ => head.to_string(),
        };
    }
    match exception.get("value") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => "Evaluation failed".to_string(),
    }
}

/// The by-value result of an evaluation: a value the page could not serialise (NaN, infinity) is `null`, as in JSON,
/// and `-0` is 0.
fn remote_value(result: &Value) -> Value {
    match result.get("unserializableValue").and_then(Value::as_str) {
        Some("-0") => json!(0),
        Some(_) => Value::Null,
        None => result.get("value").cloned().unwrap_or(Value::Null),
    }
}

/// One page of the browser (a tab of the run's own browser context).
pub struct Page {
    cdp: Arc<Cdp>,
    session: String,
    target_id: String,
    main_frame: String,
}

/// An element of the page, found by selector. It is looked up again by every call, so it stays valid while the page's
/// markup does not change under it.
pub struct Element<'a> {
    page: &'a Page,
    selector: String,
    index: usize,
}

impl Element<'_> {
    /// The call of `function` on this element as an expression of the page.
    fn call(&self, function: &str) -> String {
        format!("({function})(document.querySelectorAll({})[{}])", json!(self.selector), self.index)
    }

    /// `element.boundingBox()`: the box in CSS px of the page's frame, or `None` when it has no layout box.
    pub async fn bounding_box(&self) -> Result<Option<Rect>, String> {
        Ok(self.measure().await?.map(|(rect, _, _)| rect))
    }

    async fn measure(&self) -> Result<Option<(Rect, f64, f64)>, String> {
        let function = "(element) => { if (!(element instanceof Element)) return null; if (element.getClientRects().length === 0) return null; \
             const rect = element.getBoundingClientRect(); \
             return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, pageLeft: window.visualViewport.pageLeft, pageTop: window.visualViewport.pageTop }; }";
        let found = self.page.evaluate_expression(&self.call(function)).await?;
        if found.is_null() {
            return Ok(None);
        }
        let number = |key: &str| found.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        Ok(Some((
            Rect { x: number("x"), y: number("y"), width: number("width"), height: number("height") },
            number("pageLeft"),
            number("pageTop"),
        )))
    }

    /// `element.screenshot({ omitBackground })` as a PNG: the element is scrolled into view when it is not wholly in
    /// it, and photographed by its box.
    pub async fn screenshot(&self, omit_background: bool) -> Result<Vec<u8>, String> {
        let scroll = "async (element) => { if (!element || !element.isConnected) throw new Error('Node is detached from document'); \
             if (element.nodeType !== Node.ELEMENT_NODE) throw new Error('Node is not of type HTMLElement'); \
             const target = element instanceof SVGElement ? (element.ownerSVGElement || element) : element; \
             const ratio = await new Promise((resolve) => { const observer = new IntersectionObserver((entries) => { resolve(entries[0].intersectionRatio); observer.disconnect(); }); observer.observe(target); }); \
             if (ratio !== 1) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }";
        self.page.evaluate_expression(&self.call(scroll)).await?;
        let Some((mut rect, page_left, page_top)) = self.measure().await? else {
            return Err("Node is either not visible or not an HTMLElement".to_string());
        };
        if rect.width == 0.0 {
            return Err("Node has 0 width.".to_string());
        }
        if rect.height == 0.0 {
            return Err("Node has 0 height.".to_string());
        }
        rect.x += page_left;
        rect.y += page_top;
        self.page.screenshot(ScreenshotOptions { clip: Some(rect), omit_background }).await
    }
}

/// The source of a function expression that defines the page script `script` (an extract of the Node module: plain
/// function declarations that need nothing outside themselves) and calls its function `name` with its own arguments:
/// what `page.evaluate(name, ...args)` shipped as the function's text.
pub fn page_function(script: &str, name: &str) -> String {
    format!("function () {{
{script}
return {name}.apply(null, arguments);
}}")
}

fn call_expression(function: &str, args: &[Value]) -> String {
    let list: Vec<String> = args.iter().map(Value::to_string).collect();
    format!("({function})({})", list.join(", "))
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn decode(value: &Value, key: &str) -> Result<Vec<u8>, String> {
    STANDARD.decode(value.get(key).and_then(Value::as_str).unwrap_or_default()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clip_is_rounded_at_both_corners() {
        let clip = Rect { x: 10.4, y: 20.5, width: 100.3, height: 50.4 }.rounded();
        assert_eq!(clip, Rect { x: 10.0, y: 21.0, width: 101.0, height: 50.0 });
        // Math.round takes a tie toward +infinity.
        assert_eq!(Rect { x: -0.5, y: 0.0, width: 1.0, height: 1.0 }.rounded().x, 0.0);
    }

    #[test]
    fn the_default_print_parameters_are_puppeteers() {
        let params = PdfOptions::default().print_params().unwrap();
        assert_eq!(params["paperWidth"], json!(8.5));
        assert_eq!(params["paperHeight"], json!(11));
        assert_eq!(params["generateTaggedPDF"], json!(true));
        assert_eq!(params["generateDocumentOutline"], json!(false));
        assert_eq!(params["preferCSSPageSize"], json!(false));
        assert_eq!(params["printBackground"], json!(false));
        assert_eq!(params["scale"], json!(1));
        assert_eq!(params["transferMode"], json!("ReturnAsStream"));
        assert_eq!(params["pageRanges"], json!(""));
        for side in ["marginTop", "marginBottom", "marginLeft", "marginRight"] {
            assert_eq!(params[side], json!(0), "{side}");
        }
    }

    #[test]
    fn the_authoring_pdf_call_maps_to_the_browsers_parameters() {
        let options = PdfOptions { prefer_css_page_size: true, print_background: true, tagged: true, outline: true, ..PdfOptions::default() };
        let params = options.print_params().unwrap();
        assert_eq!(params["preferCSSPageSize"], json!(true));
        assert_eq!(params["printBackground"], json!(true));
        assert_eq!(params["generateTaggedPDF"], json!(true));
        assert_eq!(params["generateDocumentOutline"], json!(true));
    }

    #[test]
    fn an_outline_turns_tagging_on() {
        let options = PdfOptions { tagged: false, outline: true, ..PdfOptions::default() };
        assert_eq!(options.print_params().unwrap()["generateTaggedPDF"], json!(true));
        let options = PdfOptions { tagged: false, ..PdfOptions::default() };
        assert_eq!(options.print_params().unwrap()["generateTaggedPDF"], json!(false));
    }

    #[test]
    fn lengths_are_read_in_the_units_puppeteer_knows() {
        let options = PdfOptions {
            width: Some(Length::Text("210mm".into())),
            height: Some(Length::Pixels(960.0)),
            margin: Margin { top: Some(Length::Text("1in".into())), left: Some(Length::Text("96".into())), ..Margin::default() },
            ..PdfOptions::default()
        };
        let params = options.print_params().unwrap();
        assert_eq!(params["paperHeight"], json!(10));
        assert_eq!(params["marginTop"], json!(1));
        assert_eq!(params["marginLeft"], json!(1));
        let width = params["paperWidth"].as_f64().unwrap();
        assert!((width - 210.0 / 25.4).abs() < 1e-12, "{width}");
        let bad = PdfOptions { width: Some(Length::Text("wide".into())), ..PdfOptions::default() };
        assert_eq!(bad.print_params().unwrap_err(), "Failed to parse parameter value: wide");
    }

    #[test]
    fn a_named_format_wins_and_an_unknown_one_is_refused() {
        let options = PdfOptions { format: Some("A4".into()), width: Some(Length::Pixels(1.0)), ..PdfOptions::default() };
        let params = options.print_params().unwrap();
        assert_eq!(params["paperWidth"], json!(8.2677));
        assert_eq!(params["paperHeight"], json!(11.6929));
        let unknown = PdfOptions { format: Some("poster".into()), ..PdfOptions::default() };
        assert_eq!(unknown.print_params().unwrap_err(), "Unknown paper format: poster");
    }

    #[test]
    fn an_exception_reads_as_its_message() {
        let thrown = json!({ "exception": { "type": "object", "subtype": "error", "description": "Error: no such slide\n    at <anonymous>:1:7" } });
        assert_eq!(exception_message(&thrown), "no such slide");
        let typed = json!({ "exception": { "description": "TypeError: x is not a function\n    at f" } });
        assert_eq!(exception_message(&typed), "x is not a function");
        let value = json!({ "exception": { "type": "string", "value": "plain" } });
        assert_eq!(exception_message(&value), "plain");
    }

    #[test]
    fn a_value_the_page_cannot_serialise_is_null() {
        assert_eq!(remote_value(&json!({ "type": "number", "unserializableValue": "NaN" })), Value::Null);
        assert_eq!(remote_value(&json!({ "type": "number", "unserializableValue": "-0" })), json!(0));
        assert_eq!(remote_value(&json!({ "type": "number", "value": 3 })), json!(3));
        assert_eq!(remote_value(&json!({ "type": "undefined" })), Value::Null);
    }

    #[test]
    fn a_page_script_is_called_through_a_wrapper() {
        let wrapped = page_function("function pick(a, b) { return b; }", "pick");
        assert_eq!(call_expression(&wrapped, &[json!(1), json!(2)]), "(function () {
function pick(a, b) { return b; }
return pick.apply(null, arguments);
})(1, 2)");
    }

    #[test]
    fn a_call_expression_carries_its_arguments_as_json() {
        assert_eq!(call_expression("(a, b) => a", &[json!(1), json!("x\"y")]), "((a, b) => a)(1, \"x\\\"y\")");
        assert_eq!(call_expression("() => 1", &[]), "(() => 1)()");
    }
}


impl Page {
    /// Opens a blank page in the browser context `context_id`.
    pub async fn open(cdp: Arc<Cdp>, context_id: &str) -> Result<Self, String> {
        let target = cdp.send("Target.createTarget", json!({ "url": "about:blank", "browserContextId": context_id }), None).await?;
        let target_id = text(&target, "targetId");
        let attached = cdp.send("Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }), None).await?;
        let session = text(&attached, "sessionId");
        cdp.send("Page.enable", json!({}), Some(session.as_str())).await?;
        cdp.send("Page.setLifecycleEventsEnabled", json!({ "enabled": true }), Some(session.as_str())).await?;
        let tree = cdp.send("Page.getFrameTree", json!({}), Some(session.as_str())).await?;
        let main_frame = tree.pointer("/frameTree/frame/id").and_then(Value::as_str).unwrap_or_default().to_string();
        Ok(Self { cdp, session, target_id, main_frame })
    }

    async fn send(&self, method: &str, params: Value) -> Result<Value, String> {
        self.cdp.send(method, params, Some(self.session.as_str())).await
    }

    /// Closes the page.
    pub async fn close(&self) -> Result<(), String> {
        self.cdp.send("Target.closeTarget", json!({ "targetId": self.target_id }), None).await.map(|_| ())
    }

    /// `page.setViewport`.
    pub async fn set_viewport(&self, viewport: Viewport) -> Result<(), String> {
        self.send(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "mobile": false,
                "width": viewport.width,
                "height": viewport.height,
                "deviceScaleFactor": mixdog_js::json_number(viewport.device_scale_factor),
                "screenOrientation": { "angle": 0, "type": "portraitPrimary" },
            }),
        )
        .await?;
        self.send("Emulation.setTouchEmulationEnabled", json!({ "enabled": false })).await.map(|_| ())
    }

    /// `page.emulateMediaType`.
    pub async fn emulate_media_type(&self, media: &str) -> Result<(), String> {
        self.send("Emulation.setEmulatedMedia", json!({ "media": media })).await.map(|_| ())
    }

    /// `page.goto(url, { waitUntil })`: fails with the browser's `net::ERR_…` text, or when the page has not reached
    /// the event in 30 seconds.
    pub async fn goto(&self, url: &str, until: WaitUntil) -> Result<(), String> {
        let mut events = self.cdp.subscribe();
        let navigated = self.send("Page.navigate", json!({ "url": url, "frameId": self.main_frame })).await?;
        if let Some(reason) = navigated.get("errorText").and_then(Value::as_str) {
            return Err(format!("{reason} at {url}"));
        }
        let Some(loader) = navigated.get("loaderId").and_then(Value::as_str) else { return Ok(()) };
        let (session, frame, name) = (self.session.as_str(), self.main_frame.as_str(), until.event());
        self.cdp
            .wait_event(&mut events, DEFAULT_TIMEOUT, |event| {
                event.method == "Page.lifecycleEvent"
                    && event.session.as_deref() == Some(session)
                    && text(&event.params, "name") == name
                    && text(&event.params, "frameId") == frame
                    && text(&event.params, "loaderId") == loader
            })
            .await
            .map(|_| ())
            .map_err(|error| if error.starts_with("Timed out") { "Navigation timeout of 30000 ms exceeded".to_string() } else { error })
    }

    /// `page.setContent(html, { waitUntil: 'load' })`: the document is rewritten and the page waits for its load.
    pub async fn set_content(&self, html: &str) -> Result<(), String> {
        let mut events = self.cdp.subscribe();
        self.evaluate("(html) => { document.open(); document.write(html); document.close(); }", &[json!(html)]).await?;
        let (session, frame) = (self.session.as_str(), self.main_frame.as_str());
        self.cdp
            .wait_event(&mut events, DEFAULT_TIMEOUT, |event| {
                event.method == "Page.lifecycleEvent"
                    && event.session.as_deref() == Some(session)
                    && text(&event.params, "name") == "load"
                    && text(&event.params, "frameId") == frame
            })
            .await
            .map(|_| ())
    }

    /// Evaluates the JavaScript expression `expression` in the page: its value (a promise is awaited) by value.
    pub async fn evaluate_expression(&self, expression: &str) -> Result<Value, String> {
        let reply = self
            .send("Runtime.evaluate", json!({ "expression": expression, "returnByValue": true, "awaitPromise": true, "userGesture": true }))
            .await?;
        if let Some(details) = reply.get("exceptionDetails") {
            return Err(exception_message(details));
        }
        Ok(reply.get("result").map(remote_value).unwrap_or(Value::Null))
    }

    /// `page.evaluate(function, ...args)`: `function` is the source of a function expression, called in the page with
    /// the JSON `args`.
    pub async fn evaluate(&self, function: &str, args: &[Value]) -> Result<Value, String> {
        self.evaluate_expression(&call_expression(function, args)).await
    }

    /// `page.waitForFunction(function, { timeout }, ...args)`: calls the function on every animation frame until it
    /// answers truthy and returns the answer.
    pub async fn wait_for_function(&self, function: &str, args: &[Value], limit: Duration) -> Result<Value, String> {
        let expression = format!(
            "new Promise((resolve, reject) => {{ const timer = setTimeout(() => reject(new Error('Waiting failed: {ms}ms exceeded')), {ms}); \
             const poll = async () => {{ try {{ const value = await {call}; if (value) {{ clearTimeout(timer); resolve(value); return; }} }} \
             catch (error) {{ clearTimeout(timer); reject(error); return; }} requestAnimationFrame(poll); }}; poll(); }})",
            ms = limit.as_millis(),
            call = call_expression(function, args),
        );
        self.evaluate_expression(&expression).await
    }

    /// `page.addStyleTag({ content })`.
    pub async fn add_style_tag(&self, content: &str) -> Result<(), String> {
        let function = "(content) => new Promise((resolve, reject) => { const element = document.createElement('style'); \
             element.appendChild(document.createTextNode(content)); \
             element.addEventListener('load', () => resolve(true), { once: true }); \
             element.addEventListener('error', (event) => reject(new Error(event.message ?? 'Could not load style')), { once: true }); \
             document.head.appendChild(element); })";
        self.evaluate(function, &[json!(content)]).await.map(|_| ())
    }

    /// `page.title()`.
    pub async fn title(&self) -> Result<String, String> {
        Ok(self.evaluate_expression("document.title").await?.as_str().unwrap_or_default().to_string())
    }

    /// `page.$$eval(selector, (nodes) => nodes.length)`.
    pub async fn count(&self, selector: &str) -> Result<usize, String> {
        let found = self.evaluate("(selector) => document.querySelectorAll(selector).length", &[json!(selector)]).await?;
        Ok(found.as_u64().unwrap_or(0) as usize)
    }

    /// `page.$(selector)`: the first match.
    pub async fn query(&self, selector: &str) -> Result<Option<Element<'_>>, String> {
        Ok((self.count(selector).await? > 0).then(|| Element { page: self, selector: selector.to_string(), index: 0 }))
    }

    /// `page.$$(selector)`: every match.
    pub async fn query_all(&self, selector: &str) -> Result<Vec<Element<'_>>, String> {
        let count = self.count(selector).await?;
        Ok((0..count).map(|index| Element { page: self, selector: selector.to_string(), index }).collect())
    }

    /// `page.screenshot` as a PNG.
    pub async fn screenshot(&self, options: ScreenshotOptions) -> Result<Vec<u8>, String> {
        if let Some(clip) = options.clip {
            if clip.width <= 0.0 {
                return Err("'width' in 'clip' must be positive.".to_string());
            }
            if clip.height <= 0.0 {
                return Err("'height' in 'clip' must be positive.".to_string());
            }
        }
        if options.omit_background {
            self.set_transparent_background(true).await?;
        }
        let mut params = json!({ "format": "png", "optimizeForSpeed": false, "fromSurface": true, "captureBeyondViewport": options.clip.is_some() });
        if let Some(clip) = options.clip {
            let clip = clip.rounded();
            params["clip"] = json!({
                "x": mixdog_js::json_number(clip.x),
                "y": mixdog_js::json_number(clip.y),
                "width": mixdog_js::json_number(clip.width),
                "height": mixdog_js::json_number(clip.height),
                "scale": 1,
            });
        }
        let shot = self.send("Page.captureScreenshot", params).await;
        if options.omit_background {
            let _ = self.set_transparent_background(false).await;
        }
        decode(&shot?, "data")
    }

    async fn set_transparent_background(&self, on: bool) -> Result<(), String> {
        let params = if on { json!({ "color": { "r": 0, "g": 0, "b": 0, "a": 0 } }) } else { json!({}) };
        self.send("Emulation.setDefaultBackgroundColorOverride", params).await.map(|_| ())
    }

    /// `page.pdf(options)`: the PDF's bytes.
    pub async fn pdf(&self, options: &PdfOptions) -> Result<Vec<u8>, String> {
        let params = options.print_params()?;
        if options.omit_background {
            self.set_transparent_background(true).await?;
        }
        let printed = self.print(options, params).await;
        if options.omit_background {
            let _ = self.set_transparent_background(false).await;
        }
        printed
    }

    async fn print(&self, options: &PdfOptions, params: Value) -> Result<Vec<u8>, String> {
        if options.wait_for_fonts {
            let fonts = self.evaluate_expression("document.fonts.ready.then(() => true)");
            mixdog_rt::time::timeout(options.timeout, fonts).await.unwrap_or_else(|_| Err(timed_out(options.timeout.as_millis())))?;
        }
        let printed = mixdog_rt::time::timeout(options.timeout, self.send("Page.printToPDF", params))
            .await
            .unwrap_or_else(|_| Err(timed_out(options.timeout.as_millis())))?;
        let handle = printed.get("stream").and_then(Value::as_str).ok_or("`stream` is missing from `Page.printToPDF")?.to_string();
        let mut bytes = Vec::new();
        loop {
            let chunk = self.cdp.send("IO.read", json!({ "handle": handle }), Some(self.session.as_str())).await?;
            let data = chunk.get("data").and_then(Value::as_str).unwrap_or_default();
            if chunk.get("base64Encoded").and_then(Value::as_bool).unwrap_or(false) {
                bytes.extend(STANDARD.decode(data).map_err(|error| error.to_string())?);
            } else {
                bytes.extend_from_slice(data.as_bytes());
            }
            if chunk.get("eof").and_then(Value::as_bool).unwrap_or(false) {
                self.cdp.send("IO.close", json!({ "handle": handle }), Some(self.session.as_str())).await?;
                return Ok(bytes);
            }
        }
    }
}
