//! Get-RefRecord's checks, over fake elements and a fake desktop.

use crate::a11y::{Accessibility, Element, MenuOutcome, Node, Stale};
use crate::config::Config;
use crate::host::Host;
use crate::keys::{Key, Mod};
use crate::observer::Observer;
use crate::platform::{
    window_id, AppEntry, Background, Button, Desktop, Launched, Wid, WinState, WindowInfo,
};
use crate::protocol::{Obj, Req};
use crate::session::RefRecord;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

/// A control of window 1 whose live state a test changes.
struct El {
    identity: &'static str,
    top: Cell<Wid>,
    name: RefCell<String>,
    enabled: Cell<bool>,
    offscreen: Cell<bool>,
    native: Wid,
    source: &'static str,
}

impl El {
    fn new(identity: &'static str, name: &str) -> El {
        El {
            identity,
            top: Cell::new(1),
            name: RefCell::new(name.into()),
            enabled: Cell::new(true),
            offscreen: Cell::new(false),
            native: 0,
            source: "uia",
        }
    }
}

impl Element for El {
    fn identity(&self) -> String {
        self.identity.into()
    }
    fn window(&self) -> Wid {
        1
    }
    fn top_window(&self) -> Wid {
        self.top.get()
    }
    fn bounds(&self) -> Option<(f64, f64, f64, f64)> {
        Some((0.0, 0.0, 10.0, 10.0))
    }
    fn enabled(&self) -> bool {
        self.enabled.get()
    }
    fn offscreen(&self) -> bool {
        self.offscreen.get()
    }
    fn alive(&self) -> bool {
        true
    }
    fn source(&self) -> &'static str {
        self.source
    }
    fn control_type(&self) -> String {
        "Button".into()
    }
    fn name(&self) -> String {
        self.name.borrow().clone()
    }
    fn native_handle(&self) -> Wid {
        self.native
    }
    fn stale_message(&self, kind: Stale) -> Option<&'static str> {
        (self.source == "msaa" && kind == Stale::Target).then_some("is stale or its MSAA target changed")
    }
    fn press(&self) -> Result<(), String> {
        Err("fake".into())
    }
    fn can_press(&self) -> bool {
        false
    }
    fn toggle_state(&self) -> Option<String> {
        None
    }
    fn expand_state(&self) -> Option<String> {
        None
    }
    fn set_expanded(&self, _: bool) -> Result<(), String> {
        Err("fake".into())
    }
    fn value(&self) -> Option<String> {
        None
    }
    fn settable(&self) -> bool {
        false
    }
    fn set_value(&self, _: &str) -> Result<(), String> {
        Err("fake".into())
    }
    fn can_select(&self) -> bool {
        false
    }
    fn select(&self) -> Result<(), String> {
        Err("fake".into())
    }
    fn scroll(&self, _: bool, _: i32) -> Result<Option<(String, String)>, String> {
        Ok(None)
    }
    fn structure(&self) -> Obj {
        Obj::new()
    }
}

/// Windows 1 and 2, where any ref that asks for a stand-in gets `rebound`
/// and native controls hold `native_text`.
struct Screen {
    rebound: Option<Rc<El>>,
    rebinds: Rc<Cell<u32>>,
    native_text: Option<&'static str>,
}

impl Accessibility for Screen {
    fn available(&self) -> Result<(), String> {
        Ok(())
    }
    fn snapshot(&self, _: &WindowInfo, _: bool, _: usize) -> Result<Vec<Node>, String> {
        Err("fake".into())
    }
    fn focused_masked(&self) -> bool {
        false
    }
    fn invoke_menu(
        &self,
        _: &WindowInfo,
        _: &[String],
        _: &dyn Fn() -> Result<(), String>,
    ) -> Result<MenuOutcome, String> {
        Err("fake".into())
    }
    fn rebind(&self, _: Wid, _: &RefRecord) -> Option<Rc<dyn Element>> {
        self.rebinds.set(self.rebinds.get() + 1);
        self.rebound.clone().map(|found| found as Rc<dyn Element>)
    }
}

impl Background for Screen {
    fn validate(&self, _: Wid, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn pointer(&self, _: Wid, _: i32, _: i32, _: &str, _: &[Mod]) -> Result<String, String> {
        Err("fake".into())
    }
    fn wheel(&self, _: Wid, _: i32, _: i32, _: i32, _: bool, _: &[Mod]) -> Result<String, String> {
        Err("fake".into())
    }
    fn drag(&self, _: Wid, _: &[(i32, i32)], _: &[Mod]) -> Result<String, String> {
        Err("fake".into())
    }
    fn keys(&self, _: Wid, _: &str) -> Result<String, String> {
        Err("fake".into())
    }
    fn text(&self, _: Wid, _: &str) -> Result<String, String> {
        Err("fake".into())
    }
    fn native_state(&self, _: Wid, action: &str) -> Option<String> {
        if action != "type" {
            return None;
        }
        self.native_text.map(|text| format!("native_text={text}"))
    }
}

impl Desktop for Screen {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn windows(&self) -> Result<Vec<WindowInfo>, String> {
        Ok(self.info(1).into_iter().collect())
    }
    fn info(&self, handle: Wid) -> Option<WindowInfo> {
        (handle == 1 || handle == 2).then(|| WindowInfo {
            handle,
            ..Default::default()
        })
    }
    fn foreground(&self) -> Wid {
        1
    }
    fn focus(&self, _: Wid) -> bool {
        false
    }
    fn window_at_point(&self, _: i32, _: i32) -> Wid {
        0
    }
    fn related_windows(&self, _: Wid) -> Vec<Wid> {
        Vec::new()
    }
    fn is_owned_by(&self, _: Wid, _: Wid) -> bool {
        false
    }
    fn move_window(&self, _: Wid, _: i32, _: i32, _: i32, _: i32) -> Result<(), String> {
        Err("fake".into())
    }
    fn set_window_state(&self, _: Wid, _: WinState) -> Result<(), String> {
        Err("fake".into())
    }
    fn close_window(&self, _: Wid) -> Result<bool, String> {
        Err("fake".into())
    }
    fn is_responding(&self, _: Wid) -> bool {
        true
    }
    fn cursor(&self) -> (i32, i32) {
        (0, 0)
    }
    fn move_pointer(&self, _: i32, _: i32) -> Result<(), String> {
        Err("fake".into())
    }
    fn button(&self, _: Button, _: bool, _: i32, _: i32, _: u32) -> Result<(), String> {
        Err("fake".into())
    }
    fn drag_move(&self, _: i32, _: i32) -> Result<(), String> {
        Err("fake".into())
    }
    fn wheel(&self, _: i32, _: i32, _: i32, _: bool) -> Result<(), String> {
        Err("fake".into())
    }
    fn key(&self, _: Key, _: bool) -> Result<(), String> {
        Err("fake".into())
    }
    fn text(&self, _: &str) -> Result<(), String> {
        Err("fake".into())
    }
    fn input_held(&self) -> bool {
        false
    }
    fn background(&self) -> Option<&dyn Background> {
        Some(self)
    }
    fn accessibility(&self) -> Option<&dyn Accessibility> {
        Some(self)
    }
    fn clipboard_read(&self) -> Result<String, String> {
        Err("fake".into())
    }
    fn clipboard_write(&self, _: &str) -> Result<bool, String> {
        Err("fake".into())
    }
    fn launch(&self, _: &str, _: Option<&AppEntry>) -> Result<Launched, String> {
        Err("fake".into())
    }
    fn installed_apps(&self) -> Result<Vec<AppEntry>, String> {
        Err("fake".into())
    }
    fn ocr(&self, _: &[u8], _: &str, _: usize) -> Result<Value, String> {
        Err("fake".into())
    }
    fn ocr_status(&self, _: &str) -> Value {
        Value::Null
    }
}

/// A host whose ref `r1` was handed out for `seen` as a "Save" button of window 1.
fn host(screen: Screen, seen: &Rc<El>, continuation: bool) -> Host {
    let host = Host::new(
        Config {
            read_actions: Default::default(),
            retain_ref_actions: Default::default(),
            sequence_settle_ms: 0,
            max_foreground_text: 4000,
            input_marker: 0,
        },
        Box::new(screen),
        Observer::new(),
        Box::new(crate::lease_api::NoLease),
    );
    host.session(|session| {
        session.refs.insert(
            "r1".into(),
            RefRecord {
                identity: seen.identity.into(),
                element: seen.clone(),
                window_id: window_id(1),
                generation: session.generation,
                role: "Button".into(),
                name: "Save".into(),
                automation_id: String::new(),
                bounds: Some((0.0, 0.0, 10.0, 10.0)),
                source: "",
            },
        );
    });
    host.request
        .replace(Req(json!({ "sequence_continuation": continuation })));
    host
}

fn screen(rebound: Option<Rc<El>>) -> (Screen, Rc<Cell<u32>>) {
    let rebinds = Rc::new(Cell::new(0));
    let screen = Screen {
        rebound,
        rebinds: rebinds.clone(),
        native_text: None,
    };
    (screen, rebinds)
}

fn refusal(host: &Host) -> Option<String> {
    host.ref_record("r1").err()
}

const TARGET: &str = "ref r1 is stale or its target changed; take a fresh snapshot/find";
const IDENTITY: &str = "ref r1 no longer identifies the same element; take a fresh snapshot/find";
const DISABLED: &str =
    "ref r1 is disabled or off screen after an earlier step; take a fresh snapshot/find";

#[test]
fn a_relabelled_control_is_refused() {
    let seen = Rc::new(El::new("a", "Save"));
    let host = host(screen(None).0, &seen, false);
    assert!(host.ref_record("r1").is_ok());
    *seen.name.borrow_mut() = "Delete".into();
    assert_eq!(refusal(&host).as_deref(), Some(IDENTITY));
}

#[test]
fn a_name_that_is_the_native_text_is_not_a_relabel() {
    let mut desk = screen(None).0;
    desk.native_text = Some("typed");
    let seen = Rc::new(El {
        native: 5,
        ..El::new("a", "Save")
    });
    let host = host(desk, &seen, false);
    *seen.name.borrow_mut() = "typed".into();
    assert!(host.ref_record("r1").is_ok());
    // The match is exact, so the same words in another case are a relabel.
    *seen.name.borrow_mut() = "Typed".into();
    assert_eq!(refusal(&host).as_deref(), Some(IDENTITY));
}

#[test]
fn a_control_without_a_native_window_is_never_named_by_its_text() {
    let mut desk = screen(None).0;
    desk.native_text = Some("typed");
    let seen = Rc::new(El::new("a", "Save"));
    let host = host(desk, &seen, false);
    *seen.name.borrow_mut() = "typed".into();
    assert_eq!(refusal(&host).as_deref(), Some(IDENTITY));
}

#[test]
fn a_control_that_moved_to_another_top_window_is_stale() {
    let seen = Rc::new(El::new("a", "Save"));
    let (desk, rebinds) = screen(None);
    let host = host(desk, &seen, false);
    seen.top.set(2);
    assert_eq!(refusal(&host).as_deref(), Some(TARGET));
    assert_eq!(rebinds.get(), 1);
}

#[test]
fn a_rebuilt_twin_replaces_the_element_when_the_provider_finds_one() {
    let seen = Rc::new(El::new("a", "Save"));
    let host = host(screen(Some(Rc::new(El::new("b", "Save")))).0, &seen, false);
    seen.top.set(2);
    let (element, window) = host.ref_record("r1").expect("rebound");
    assert_eq!(element.identity(), "b");
    assert_eq!(window, window_id(1));
    // The record follows the twin.
    host.session(|session| assert_eq!(session.refs["r1"].identity, "b"));
    assert!(host.ref_record("r1").is_ok());
}

#[test]
fn a_continuation_never_rebinds() {
    let seen = Rc::new(El::new("a", "Save"));
    let (desk, rebinds) = screen(Some(Rc::new(El::new("b", "Save"))));
    let host = host(desk, &seen, true);
    seen.top.set(2);
    assert_eq!(refusal(&host).as_deref(), Some(TARGET));
    assert_eq!(rebinds.get(), 0);
}

#[test]
fn a_continuation_refuses_a_disabled_or_offscreen_element() {
    let seen = Rc::new(El::new("a", "Save"));
    let host = host(screen(None).0, &seen, true);
    assert!(host.ref_record("r1").is_ok());
    seen.enabled.set(false);
    assert_eq!(refusal(&host).as_deref(), Some(DISABLED));
    seen.enabled.set(true);
    seen.offscreen.set(true);
    assert_eq!(refusal(&host).as_deref(), Some(DISABLED));
    // A plain command does not ask.
    host.request.replace(Req(json!({})));
    assert!(host.ref_record("r1").is_ok());
}

#[test]
fn an_msaa_ref_uses_its_own_wording_and_never_rebinds() {
    let seen = Rc::new(El {
        source: "msaa",
        ..El::new("a", "Save")
    });
    let (desk, rebinds) = screen(Some(Rc::new(El::new("b", "Save"))));
    let host = host(desk, &seen, false);
    host.session(|session| session.refs.get_mut("r1").expect("ref").source = "msaa");
    seen.top.set(2);
    assert_eq!(
        refusal(&host).as_deref(),
        Some("ref r1 is stale or its MSAA target changed; take a fresh snapshot/find")
    );
    assert_eq!(rebinds.get(), 0);
}


#[test]
fn a_tree_without_a_live_role_and_name_is_not_checked_for_a_relabel() {
    // An AT-SPI or AX element reports neither, and the desktop's own source.
    let seen = Rc::new(El {
        source: "",
        ..El::new("a", "Save")
    });
    let host = host(screen(None).0, &seen, false);
    *seen.name.borrow_mut() = "Delete".into();
    assert!(host.ref_record("r1").is_ok());
}
