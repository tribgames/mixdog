//! The human-only hold over the computer stack as it is composed: every session's backend is the helper under
//! [`GatedComputerBackend`], and the desktop's holds come in through [`HumanOnlyService`] on its own connection. These pin what the
//! merge of the Windows computer core must not change: whoever declared a hold is the only one to end it, a hold ends with its
//! connection, and no `computer` input reaches the helper while one is open.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::CallContext;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::computer::ComputerStatus;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::computer::InputOutcome;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_base::support::testing::value;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::GatedComputerBackend;
use super::HumanOnlyService;
use super::human_only::free_lock;

const BEGIN: &str = "host/humanOnly/begin";
const END: &str = "host/humanOnly/end";
const BLOCKED: &str = "Computer Use is blocked while a human-only approval is pending";

/// The helper: it keeps each action it was sent.
#[derive(Default)]
struct Helper(Mutex<Vec<ComputerAction>>);

impl Helper {
    fn sent(&self) -> usize {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).len()
    }
}

#[async_trait]
impl ComputerBackend for Helper {
    async fn run(&self, request: ComputerRequest, _: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).push(request.action);
        Ok(Vec::new())
    }
    fn inject(&self, _: ScreenInput) -> Result<InputOutcome, ComputerError> {
        Ok(InputOutcome::Applied)
    }
    fn release_input(&self) -> Result<u32, ComputerError> {
        Ok(0)
    }
    fn input_desktop(&self) -> Option<DesktopIdentity> {
        None
    }
    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
        Ok(Vec::new())
    }
    fn screen_source(&self, _: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        Err(ComputerError::Cancelled)
    }
    fn status(&self) -> ComputerStatus {
        ComputerStatus::default()
    }
}

/// A call of `method` made on connection `connection`, which closes when `closed` is cancelled.
fn on(connection: u64, closed: &CancellationToken, method: &'static str, params: Value) -> CoreRequest {
    CoreRequest { method: Method(method), params, op: None, ctx: CallContext::connection(ConnectionId(connection), Origin::Local, closed.clone()) }
}

fn act() -> ComputerRequest {
    ComputerRequest { action: ComputerAction::Act, input: json!({ "window_id": "hwnd:0x2", "actions": [{ "type": "click", "x": 4, "y": 2 }] }) }
}

fn refused(label: &str) -> ComputerError {
    ComputerError::Failed { code: "human_only_approval_pending".into(), message: format!("{BLOCKED}: {label}") }
}

/// A second connection naming the first one's hold leaves it open, and the `computer` act stays refused.
#[tokio::test]
async fn a_second_connection_cannot_end_the_first_connections_hold() {
    let lock = free_lock();
    let service = HumanOnlyService::new(lock.clone());
    let helper = Arc::new(Helper::default());
    let gated = GatedComputerBackend::new(helper.clone(), lock.clone());
    let (first, second) = (CancellationToken::new(), CancellationToken::new());

    let begun = value(&service, on(1, &first, BEGIN, json!({ "label": "Allow all actions" }))).await.unwrap();
    let end = json!({ "holdId": begun["holdId"] });
    assert_eq!(value(&service, on(2, &second, END, end.clone())).await.unwrap(), json!({}));
    assert_eq!(gated.run(act(), CancellationToken::new()).await.unwrap_err(), refused("Allow all actions"));
    assert_eq!(helper.sent(), 0);

    assert_eq!(value(&service, on(1, &first, END, end)).await.unwrap(), json!({}));
    gated.run(act(), CancellationToken::new()).await.unwrap();
    assert_eq!(helper.sent(), 1);
}

/// A hold ends when the connection that declared it closes: a desktop that went away leaves the `computer` tool free.
#[tokio::test]
async fn a_hold_ends_when_its_connection_closes() {
    let lock = free_lock();
    let service = HumanOnlyService::new(lock.clone());
    let helper = Arc::new(Helper::default());
    let gated = GatedComputerBackend::new(helper.clone(), lock.clone());
    let connection = CancellationToken::new();

    value(&service, on(1, &connection, BEGIN, json!({ "label": "" }))).await.unwrap();
    assert_eq!(gated.run(act(), CancellationToken::new()).await.unwrap_err(), ComputerError::Failed { code: "human_only_approval_pending".into(), message: BLOCKED.into() });
    connection.cancel();
    gated.run(act(), CancellationToken::new()).await.unwrap();
    assert_eq!(helper.sent(), 1, "only the call made after the close reached the helper");
}

/// While a hold is open every `computer` call but `wait_for_user` is refused before the helper is sent anything, whatever the
/// action; the same calls run once it ends.
#[tokio::test]
async fn computer_act_is_refused_while_a_hold_is_open() {
    let lock = free_lock();
    let service = HumanOnlyService::new(lock.clone());
    let helper = Arc::new(Helper::default());
    let gated = GatedComputerBackend::new(helper.clone(), lock.clone());
    let connection = CancellationToken::new();

    let begun = value(&service, on(1, &connection, BEGIN, json!({ "label": "the browser approval card" }))).await.unwrap();
    for action in [ComputerAction::Act, ComputerAction::Capture, ComputerAction::Window, ComputerAction::Clipboard] {
        let request = ComputerRequest { action, input: json!({}) };
        assert_eq!(gated.run(request, CancellationToken::new()).await.unwrap_err(), refused("the browser approval card"));
    }
    gated.run(ComputerRequest { action: ComputerAction::WaitForUser, input: json!({}) }, CancellationToken::new()).await.unwrap();
    assert_eq!(helper.sent(), 1, "only wait_for_user reached the helper");

    value(&service, on(1, &connection, END, json!({ "holdId": begun["holdId"] }))).await.unwrap();
    gated.run(act(), CancellationToken::new()).await.unwrap();
    assert_eq!(helper.sent(), 2);
}
