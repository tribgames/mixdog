//! The production [`ComputerCommands`]: the secret fill's Computer Use commands (`find`, `type`),
//! run on the session's computer helper with the command names and shapes the desktop host
//! takes (`computer-bridge` `executeSerialized`; `ProcessComputerBackend` is the helper).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_tools::state::secrets::ComputerSecretHost;
use serde_json::Value;

use super::ComputerCommands;

/// The computer helper of a thread's session; `None` when no desktop control is attached to it.
pub trait ComputerSecretHosts: Send + Sync {
    fn secret_host(&self, thread: &ThreadId) -> Option<Arc<dyn ComputerSecretHost>>;
}

/// [`ComputerCommands`] over the session's computer helper.
pub struct HostComputerCommands {
    hosts: Arc<dyn ComputerSecretHosts>,
}

impl HostComputerCommands {
    pub fn new(hosts: Arc<dyn ComputerSecretHosts>) -> Self {
        Self { hosts }
    }
}

#[async_trait]
impl ComputerCommands for HostComputerCommands {
    /// The only commands sent here are the fill's own: a `find` read of the bound window and the
    /// `type` of the secret. The helper withholds captures once a secret may hold focus
    /// (`arm_focus`), so it is armed just before the secret is typed, as Node arms its registry
    /// (`armFocus`) after taking the value.
    async fn execute(&self, thread: &ThreadId, command: Value) -> Result<Value, String> {
        let host = self
            .hosts
            .secret_host(thread)
            .ok_or_else(|| "computer_backend_unavailable: no desktop control is attached to this session".to_owned())?;
        let Value::Object(command) = command else {
            return Err("computer command must be an object".to_owned());
        };
        if command.get("action").and_then(Value::as_str) == Some("type") {
            host.arm_focus();
        }
        host.execute(command).await.map(Value::Object)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::PoisonError;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    use mixdog_core_api::CoreError;
    use mixdog_core_api::ClaimedHostChannel;
    use mixdog_core_api::HostClaim;
    use mixdog_core_api::HostChannel;
    use mixdog_core_api::HostCapability;
    use mixdog_core_api::HostError;
    use mixdog_core_api::ids::Method;
    use serde_json::Map;
    use serde_json::json;

    use super::super::FillGates;
    use super::super::SecretFill;
    use super::super::SecretSlots;
    use super::*;

    const ID: &str = "secret_0123456789ab";

    /// The helper, answering a recorded script and keeping what it was sent.
    struct Helper {
        script: Vec<Value>,
        sent: Mutex<Vec<Value>>,
        armed: AtomicUsize,
    }

    #[async_trait]
    impl ComputerSecretHost for Helper {
        async fn execute(&self, command: Map<String, Value>) -> Result<Map<String, Value>, String> {
            let mut sent = self.sent.lock().unwrap_or_else(PoisonError::into_inner);
            sent.push(Value::Object(command));
            match self.script.get(sent.len() - 1) {
                None => Ok(Map::new()),
                Some(step) => match step.get("throw").and_then(Value::as_str) {
                    Some("string") => Err("a thrown string stale_target".to_owned()),
                    Some(message) => Err(message.to_owned()),
                    None => Ok(step.get("reply").and_then(Value::as_object).cloned().unwrap_or_default()),
                },
            }
        }

        fn arm_focus(&self) {
            self.armed.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct Hosts(Option<Arc<Helper>>);

    impl ComputerSecretHosts for Hosts {
        fn secret_host(&self, _: &ThreadId) -> Option<Arc<dyn ComputerSecretHost>> {
            self.0.clone().map(|helper| helper as Arc<dyn ComputerSecretHost>)
        }
    }

    struct Open(bool);

    impl FillGates for Open {
        fn browser_free(&self, _: &ThreadId) -> bool {
            true
        }
        fn computer_free(&self) -> bool {
            self.0
        }
    }

    /// A computer fill never asks the desktop.
    struct NoDesktop;

    #[async_trait]
    impl HostChannel for NoDesktop {
        async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
    }

    #[async_trait]
    impl ClaimedHostChannel for NoDesktop {
        async fn request_claimed(&self, _: HostCapability, _: Method, _: Value) -> Result<(HostClaim, Value), HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
        async fn request_to(&self, _: &HostClaim, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            unreachable!("a computer fill sends nothing to the desktop")
        }
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../../fixtures/secret-input/computer.json")).unwrap()
    }

    /// The commands the helper receives are the ones the real Node `typeComputerSecret` sent
    /// (`fixtures/secret-input/computer.json`), and the helper is armed exactly when Node armed focus.
    #[tokio::test]
    async fn the_helper_gets_the_commands_the_recorded_node_fill_sent() {
        let mut replayed = 0;
        for case in golden()["type"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let Some(session) = case["command"]["session_id"].as_str().filter(|s| !s.is_empty()) else { continue };
            let helper = Arc::new(Helper { script: case["script"].as_array().unwrap().clone(), sent: Mutex::new(Vec::new()), armed: AtomicUsize::new(0) });
            let slots = Arc::new(SecretSlots::new(Duration::from_secs(3600)));
            let commands = Arc::new(HostComputerCommands::new(Arc::new(Hosts(Some(helper.clone())))));
            let fill = SecretFill::new(slots.clone(), Arc::new(Open(case["gateHeld"] != json!(true))), commands, Arc::new(NoDesktop));
            let thread = ThreadId::from(session);
            if let Some(provided) = case["provide"].as_str() {
                assert!(slots.provide(ID, provided), "{name}");
            }
            if let Some(bind) = case["bind"].as_object() {
                let got = |key: &str| bind[key].as_str().unwrap().to_owned();
                assert!(slots.bind_computer(ID, &got("session"), &got("windowId"), &got("ref")), "{name}");
            }
            let command = &case["command"];
            let named = |key: &str| command.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
            let outcome = fill.computer_input(&thread, command["request_id"].as_str().unwrap(), &named("window_id"), &named("ref")).await;
            assert_eq!(json!(outcome), case["outcome"], "{name}");
            assert_eq!(json!(helper.sent.lock().unwrap().clone()), case["commands"], "{name}");
            assert_eq!(json!(helper.armed.load(Ordering::SeqCst) > 0), case["after"]["focusArmed"], "{name}");
            replayed += 1;
        }
        assert!(replayed > 10, "{replayed}");
    }

    #[tokio::test]
    async fn no_helper_or_a_non_object_command_is_an_error_text_the_fill_blocks_on() {
        let thread = ThreadId::from("S1");
        let none = HostComputerCommands::new(Arc::new(Hosts(None)));
        assert!(none.execute(&thread, json!({ "action": "find" })).await.unwrap_err().starts_with("computer_backend_unavailable"));
        let helper = Arc::new(Helper { script: Vec::new(), sent: Mutex::new(Vec::new()), armed: AtomicUsize::new(0) });
        let some = HostComputerCommands::new(Arc::new(Hosts(Some(helper.clone()))));
        assert!(some.execute(&thread, json!("type")).await.is_err());
        assert!(helper.sent.lock().unwrap().is_empty() && helper.armed.load(Ordering::SeqCst) == 0);
        some.execute(&thread, json!({ "action": "find" })).await.unwrap();
        assert_eq!(helper.armed.load(Ordering::SeqCst), 0, "a read does not arm focus");
    }
}