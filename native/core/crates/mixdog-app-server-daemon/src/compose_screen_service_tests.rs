use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_core_api::CoreError;
use mixdog_core_api::HostError;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_domains::domains::pc_access::KeyOutcome;

use super::*;
use crate::compose_screen::ScreenEventsCell;

/// A desktop that keeps every request it is sent and answers each with `reply`.
struct Desktop {
    seen: Mutex<Vec<(String, Value)>>,
    reply: Mutex<Result<Value, ()>>,
}

impl Desktop {
    fn answering(reply: Value) -> Arc<Self> {
        Arc::new(Self { seen: Mutex::default(), reply: Mutex::new(Ok(reply)) })
    }

    fn refusing() -> Arc<Self> {
        Arc::new(Self { seen: Mutex::default(), reply: Mutex::new(Err(())) })
    }

    fn seen(&self) -> Vec<(String, Value)> {
        lock(&self.seen).clone()
    }

    /// The requests are sent by a task of their own: waits until `count` have arrived.
    async fn until(&self, count: usize) -> Vec<(String, Value)> {
        for _ in 0..2_000 {
            if self.seen().len() >= count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        self.seen()
    }
}

#[async_trait]
impl HostChannel for Desktop {
    async fn request(&self, _capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
        lock(&self.seen).push((method.as_str().to_owned(), params));
        lock(&self.reply).clone().map_err(|()| HostError::Core(CoreError::Cancelled { by: "test".into() }))
    }

    fn notify(&self, _capability: HostCapability, _method: Method, _params: Value) -> Result<(), CoreError> {
        Ok(())
    }
}

struct Blobs(HashMap<String, Vec<u8>>);

#[async_trait]
impl ComputerBlobs for Blobs {
    async fn read(&self, digest: &str) -> Result<Vec<u8>, ComputerError> {
        self.0.get(digest).cloned().ok_or_else(|| ComputerError::Failed { code: "blob_missing".into(), message: digest.to_owned() })
    }
}

fn stop_counter() -> (Arc<dyn Fn() + Send + Sync>, Arc<AtomicU32>) {
    let count = Arc::new(AtomicU32::new(0));
    let seen = count.clone();
    (Arc::new(move || {
        seen.fetch_add(1, Ordering::SeqCst);
    }), count)
}

fn shown(screen_id: &str, on_stop: Arc<dyn Fn() + Send + Sync>) -> IndicatorState {
    IndicatorState { client_label: "Phone".into(), controlling: false, screen_id: screen_id.into(), on_stop }
}

/// A session's places on the pill reach the desktop in the order the session made them, each with the label and what the pill needs.
#[tokio::test]
async fn the_pill_is_driven_in_the_order_the_session_made_its_calls() {
    // The pill's requests go out on a task of their own (mixdog_rt::spawn).
    let _ = mixdog_rt::testing::tokens();
    let desktop = Desktop::answering(json!({}));
    let indicator = DesktopIndicator::new(desktop.clone(), Arc::default());
    indicator.show(shown("1", stop_counter().0));
    indicator.update(true);
    indicator.hide();
    let seen = desktop.until(3).await;
    assert_eq!(
        seen,
        vec![
            ("host/screen/indicator".to_owned(), json!({"state": "show", "screenId": "1", "clientLabel": "Phone", "controlling": false})),
            ("host/screen/indicator".to_owned(), json!({"state": "update", "screenId": "1", "clientLabel": "Phone", "controlling": true})),
            ("host/screen/indicator".to_owned(), json!({"state": "hide", "screenId": "1"})),
        ]
    );
}

/// An update or a hide of a session that showed nothing asks nothing of the desktop, and a desktop that refuses the pill does not
/// stop the session's later calls.
#[tokio::test]
async fn a_pill_that_was_never_shown_asks_nothing_and_a_refusing_desktop_is_not_a_failure() {
    // The pill's requests go out on a task of their own (mixdog_rt::spawn).
    let _ = mixdog_rt::testing::tokens();
    let desktop = Desktop::refusing();
    let indicator = DesktopIndicator::new(desktop.clone(), Arc::default());
    indicator.update(true);
    indicator.hide();
    indicator.show(shown("2", stop_counter().0));
    indicator.hide();
    let seen = desktop.until(2).await;
    assert_eq!(seen.len(), 2, "the show and the hide were both sent although the first was refused");
}

/// The pill's Stop ends the session of the display it names, only while that session is shown; a later session of the display keeps its
/// Stop when an earlier one hides.
#[test]
fn the_pills_stop_ends_the_session_of_its_display() {
    let stops = IndicatorStops::default();
    let (first, first_count) = stop_counter();
    let (second, second_count) = stop_counter();
    stops.stopped("1");
    stops.set("1", first.clone());
    stops.stopped("1");
    stops.stopped("2");
    assert_eq!((first_count.load(Ordering::SeqCst), second_count.load(Ordering::SeqCst)), (1, 0));
    stops.set("1", second.clone());
    stops.clear("1", &first);
    stops.stopped("1");
    assert_eq!((first_count.load(Ordering::SeqCst), second_count.load(Ordering::SeqCst)), (1, 1), "an older session's hide leaves the newer Stop");
    stops.clear("1", &second);
    stops.stopped("1");
    assert_eq!(second_count.load(Ordering::SeqCst), 1);
}

/// The desktop's Stop reaches the session through the same port the session showed its place by.
#[tokio::test]
async fn a_stop_reported_by_the_desktop_ends_the_shown_session() {
    // The pill's requests go out on a task of their own (mixdog_rt::spawn).
    let _ = mixdog_rt::testing::tokens();
    let stops = Arc::new(IndicatorStops::default());
    let indicator = DesktopIndicator::new(Desktop::answering(json!({})), stops.clone());
    let (on_stop, count) = stop_counter();
    indicator.show(shown("3", on_stop));
    stops.stopped("3");
    assert_eq!(count.load(Ordering::SeqCst), 1);
    indicator.hide();
    stops.stopped("3");
    assert_eq!(count.load(Ordering::SeqCst), 1, "a hidden session has no Stop");
}

#[test]
fn every_install_state_of_pc_access_keeps_its_name_for_the_phone() {
    use HelperState as From;
    use InstallState as To;
    for (from, to) in [
        (From::Installed, To::Installed),
        (From::Outdated, To::Outdated),
        (From::NotInstalled, To::NotInstalled),
        (From::NotEnrolled, To::NotEnrolled),
        (From::OtherUser, To::OtherUser),
        (From::Unavailable, To::Unavailable),
    ] {
        assert_eq!(install_state(from), to);
    }
}

#[test]
fn a_password_request_is_answered_busy_or_by_the_installers_outcome_name() {
    let busy = answered(CredentialAnswer { outcome: CredentialOutcome::Busy, state: HelperState::NotInstalled, detail: Some("another request is running".into()) });
    assert_eq!((busy.outcome.as_str(), busy.state, busy.detail.as_deref()), ("busy", InstallState::NotInstalled, Some("another request is running")));
    let ran = answered(CredentialAnswer { outcome: CredentialOutcome::Ran(KeyOutcome::Enrolled), state: HelperState::Installed, detail: None });
    assert_eq!((ran.outcome.as_str(), ran.state, ran.detail), ("enrolled", InstallState::Installed, None));
}

#[test]
fn the_input_desktop_keeps_its_name_and_both_flags() {
    let watched = mixdog_tools::desktop::computer_screen_input::InputDesktop { name: Some("Winlogon".into()), consent: true, logon_ui: false };
    assert_eq!(input_desktop(&watched), InputDesktop { input_desktop: Some("Winlogon".into()), consent: true, logon_ui: false });
    let unreadable = mixdog_tools::desktop::computer_screen_input::InputDesktop { name: None, consent: false, logon_ui: true };
    assert_eq!(input_desktop(&unreadable), InputDesktop { input_desktop: None, consent: false, logon_ui: true });
}

fn pixels(desktop: Arc<Desktop>, stored: &[(&str, &[u8])]) -> HostPixels {
    HostPixels { desktop, blobs: Arc::new(Blobs(stored.iter().map(|(digest, bytes)| ((*digest).to_owned(), bytes.to_vec())).collect())), origin: Instant::now() }
}

fn reply(digest: &str, byte_length: u64, mime: &str, width: u32, height: u32) -> Value {
    json!({ "blob": { "digest": digest, "byteLength": byte_length, "mimeType": mime }, "captureWidth": width, "captureHeight": height, "source": { "x": 0, "y": 0, "width": width, "height": height, "scaleFactor": 1.0 } })
}

/// A display's picture is the JPEG the desktop uploaded, read back with the size of its capture, and asked of the desktop by the
/// display's id and index.
#[tokio::test]
async fn a_display_is_captured_by_the_desktop_and_read_back_from_the_blob_store() {
    let desktop = Desktop::answering(reply("sha256:a", 3, "image/jpeg", 1_920, 1_080));
    let source = pixels(desktop.clone(), &[("sha256:a", &[1, 2, 3])]);
    let frame = source.frame(DisplayId(2)).await.unwrap();
    assert_eq!((frame.width, frame.height, frame.stride, frame.format, frame.data.as_ref()), (1_920, 1_080, 0, PixelFormat::Jpeg, &[1u8, 2, 3][..]));
    let seen = desktop.seen();
    assert_eq!(seen[0].0, "host/computer/pixels");
    assert_eq!(seen[0].1["target"], json!({"kind": "display", "displayId": "2", "index": 2}));
    assert_eq!((seen[0].1["backend"].as_str(), seen[0].1["format"].as_str()), (Some("screen"), Some("jpeg")));
}

/// A reply that is not a sized JPEG of the length the desktop stored, a blob that is gone and a desktop that refuses are each a frame
/// that does not come, never a picture of something else.
#[tokio::test]
async fn a_capture_that_is_not_what_the_desktop_stored_is_no_frame() {
    let stored: &[(&str, &[u8])] = &[("sha256:a", &[1, 2, 3])];
    for (what, answer) in [
        ("a png", reply("sha256:a", 3, "image/png", 10, 10)),
        ("no size", reply("sha256:a", 3, "image/jpeg", 0, 10)),
        ("another length", reply("sha256:a", 4, "image/jpeg", 10, 10)),
        ("a missing blob", reply("sha256:b", 3, "image/jpeg", 10, 10)),
        ("a malformed reply", json!({"blob": 1})),
    ] {
        let refused = pixels(Desktop::answering(answer), stored).frame(DisplayId(0)).await;
        assert!(matches!(refused, Err(MediaError::Unavailable { .. })), "{what}: {refused:?}");
    }
    let refused = pixels(Desktop::refusing(), stored).frame(DisplayId(0)).await;
    assert!(matches!(refused, Err(MediaError::Unavailable { .. })));
}

/// The desktop's reports reach the screen sessions only once they are composed; before that they are dropped.
#[test]
fn the_desktops_screen_reports_wait_for_the_composition() {
    #[derive(Default)]
    struct Told(Mutex<Vec<String>>);

    impl ScreenEvents for Told {
        fn displays_changed(&self) {
            lock(&self.0).push("changed".to_owned());
        }

        fn indicator_stopped(&self, screen_id: &str) {
            lock(&self.0).push(format!("stopped {screen_id}"));
        }
    }

    let cell = ScreenEventsCell::default();
    cell.displays_changed();
    cell.indicator_stopped("1");
    let told = Arc::new(Told::default());
    assert!(cell.target.set(told.clone()).is_ok());
    cell.displays_changed();
    cell.indicator_stopped("2");
    assert_eq!(*lock(&told.0), vec!["changed".to_owned(), "stopped 2".to_owned()]);
}
