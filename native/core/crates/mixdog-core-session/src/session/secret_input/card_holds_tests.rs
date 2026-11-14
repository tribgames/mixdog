//! The core's holds for the cards only the person answers: Computer Use is refused while one is pending and free again
//! after the card is denied or answered, expires, loses its answering connection or its thread.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
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
use mixdog_core_api::ids::ThreadId;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::CardHolds;
use super::CardScope;
use super::GatedComputerBackend;
use super::HumanOnlyCard;
use super::HumanOnlyLock;
use super::human_only::free_lock;

/// The helper: it keeps each action it is sent.
#[derive(Default)]
struct Helper(Mutex<Vec<ComputerAction>>);

#[async_trait]
impl ComputerBackend for Helper {
    async fn run(&self, request: ComputerRequest, _: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        self.0.lock().unwrap().push(request.action);
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

fn act() -> ComputerRequest {
    ComputerRequest { action: ComputerAction::Act, input: json!({ "window_id": "w", "actions": [{ "type": "click", "x": 1, "y": 2 }] }) }
}

/// Whether a `computer` act reaches the helper now.
async fn reaches(gated: &GatedComputerBackend, helper: &Helper) -> bool {
    let before = helper.0.lock().unwrap().len();
    let _ = gated.run(act(), CancellationToken::new()).await;
    helper.0.lock().unwrap().len() > before
}

fn setup() -> (Arc<HumanOnlyLock>, CardHolds, GatedComputerBackend, Arc<Helper>) {
    let lock = free_lock();
    let helper = Arc::new(Helper::default());
    (lock.clone(), CardHolds::new(lock.clone()), GatedComputerBackend::new(helper.clone(), lock), helper)
}

#[tokio::test]
async fn an_act_is_refused_while_a_browser_approval_is_pending_and_free_after_deny() {
    let (lock, holds, gated, helper) = setup();
    assert!(reaches(&gated, &helper).await);
    holds.hold_for_request("req-1", HumanOnlyCard::BrowserApproval);
    assert!(!reaches(&gated, &helper).await);
    assert_eq!(
        gated.run(act(), CancellationToken::new()).await.unwrap_err(),
        ComputerError::Failed {
            code: "human_only_approval_pending".into(),
            message: "Computer Use is blocked while a human-only approval is pending".into()
        }
    );
    assert!(lock.begin_computer_operation().is_err(), "a secret fill's host command is refused by the same lock");
    // The card is denied: the answer releases the hold.
    assert!(holds.release("req-1"));
    assert!(reaches(&gated, &helper).await);
    assert!(lock.begin_computer_operation().is_ok());
    assert!(!holds.release("req-1"), "a hold ends once");
}

#[tokio::test]
async fn a_second_hold_for_one_request_is_the_same_hold() {
    let (_, holds, gated, helper) = setup();
    let first = holds.hold_for_request("req-1", HumanOnlyCard::SecretRequest);
    assert_eq!(holds.hold_for_request("req-1", HumanOnlyCard::SecretRequest), first);
    holds.hold_for_request("req-2", HumanOnlyCard::ScreenTakeover);
    holds.release("req-1");
    assert!(!reaches(&gated, &helper).await, "the other card still holds");
    holds.release("req-2");
    assert!(reaches(&gated, &helper).await);
}

#[tokio::test]
async fn the_hold_is_released_when_the_answering_connection_closes() {
    let (_, holds, gated, helper) = setup();
    let connection = CancellationToken::new();
    holds.hold_for_request_in("req-1", HumanOnlyCard::BrowserApproval, CardScope { answerer_closed: Some(connection.clone()), ..CardScope::default() });
    assert!(!reaches(&gated, &helper).await);
    connection.cancel();
    assert!(reaches(&gated, &helper).await);
    // The same request id can hold again once the old hold is gone.
    holds.hold_for_request("req-1", HumanOnlyCard::BrowserApproval);
    assert!(!reaches(&gated, &helper).await);
    assert!(holds.release("req-1"));
}

#[tokio::test(start_paused = true)]
async fn the_hold_is_released_at_its_expiry() {
    let (_, holds, gated, helper) = setup();
    holds.hold_for_request_in("req-1", HumanOnlyCard::BrowserApproval, CardScope { expires_after: Some(Duration::from_secs(120)), ..CardScope::default() });
    tokio::time::sleep(Duration::from_secs(119)).await;
    assert!(!reaches(&gated, &helper).await);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(reaches(&gated, &helper).await);
    assert!(!holds.release("req-1"), "the expiry ended it");
}

#[tokio::test]
async fn the_hold_is_released_when_its_thread_ends() {
    let (_, holds, gated, helper) = setup();
    let (a, b) = (ThreadId::from("A"), ThreadId::from("B"));
    holds.hold_for_request_in("req-a", HumanOnlyCard::SecretRequest, CardScope { thread: Some(a.clone()), ..CardScope::default() });
    holds.hold_for_request_in("req-b", HumanOnlyCard::BrowserApproval, CardScope { thread: Some(b.clone()), ..CardScope::default() });
    holds.release_thread(&a);
    assert!(!reaches(&gated, &helper).await, "the other thread's card still holds");
    holds.release_thread(&b);
    assert!(reaches(&gated, &helper).await);
}

#[tokio::test]
async fn drained_waits_for_the_running_operation() {
    let (lock, holds, _, _) = setup();
    let operation = lock.begin_computer_operation().unwrap();
    holds.hold_for_request("req-1", HumanOnlyCard::BrowserApproval);
    let mut drained = std::pin::pin!(holds.drained());
    assert!(futures::poll!(drained.as_mut()).is_pending());
    drop(operation);
    assert!(futures::poll!(drained.as_mut()).is_ready());
}
