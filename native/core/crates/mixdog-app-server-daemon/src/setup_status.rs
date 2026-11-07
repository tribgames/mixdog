//! The `setup` tool's `status` readers for `mcp`, `skills`, `plugins` and `hooks`
//! (`SETUP_STATUS_READERS` of `setup-tool/executor.mjs`). The first three ask the services of this
//! workspace the question Node's reader puts to the runtime (`mcpStatus`, `skillsStatus` with
//! `getDisabledSkills`, `pluginsStatus`); `hooks` reads the same `HookStatus` the doctor reads
//! (`hooksStatus`). Each answers the object Node's reader returns, without the `domain` key.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_agents::setup::StatusReader;
use mixdog_core_api::DomainService;
use mixdog_core_api::ids::ThreadId;
use mixdog_mcp::setup_actions::mcp_rows;
use mixdog_mcp::setup_runtime::call;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::domain_seams::doctor::HooksStatus;
use crate::hook_rule_setup::public_rule;

pub struct ServiceStatus {
    mcp: Arc<dyn DomainService>,
    skills: Arc<dyn DomainService>,
    plugins: Arc<dyn DomainService>,
    hooks: Arc<dyn HooksStatus>,
}

impl ServiceStatus {
    pub fn new(mcp: Arc<dyn DomainService>, skills: Arc<dyn DomainService>, plugins: Arc<dyn DomainService>, hooks: Arc<dyn HooksStatus>) -> Self {
        Self { mcp, skills, plugins, hooks }
    }
}

async fn ask(service: &Arc<dyn DomainService>, method: &'static str) -> Result<Value, PortError> {
    call(service.as_ref(), method, json!({})).await.map_err(|message| PortError::Failed { capability: "setup".into(), message })
}

/// `hookStatus(rt)`: the public part of the hooks status, in Node's key order. A key the status
/// does not carry is left out, as `undefined` is by `JSON.stringify`.
fn hook_status(status: &Value) -> Value {
    let mut out = Map::new();
    out.insert("enabled".to_owned(), Value::Bool(status["enabled"] == Value::Bool(true)));
    let copy = |out: &mut Map<String, Value>, key: &str| {
        if let Some(value) = status.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    };
    for key in ["configMode", "rulesPath", "ruleCount"] {
        copy(&mut out, key);
    }
    out.insert("rules".to_owned(), Value::Array(status["rules"].as_array().into_iter().flatten().map(public_rule).collect()));
    for key in ["configuredEvents", "configSources", "errors", "note"] {
        copy(&mut out, key);
    }
    Value::Object(out)
}

#[async_trait]
impl StatusReader for ServiceStatus {
    fn domains(&self) -> &'static [&'static str] {
        &["mcp", "skills", "plugins", "hooks"]
    }

    async fn read(&self, domain: &str, _detail: bool, _thread: &ThreadId) -> Result<Value, PortError> {
        match domain {
            "mcp" => Ok(mcp_rows(&ask(&self.mcp, "mcp/mcpStatus").await?)),
            "skills" => {
                // `{ ...skillsStatus(), disabled: getDisabledSkills().disabled || [] }`: a
                // `disabled` the status carries keeps its place.
                let Value::Object(mut out) = ask(&self.skills, "skills/skillsStatus").await? else { unreachable!("skillsStatus answers an object") };
                let disabled = ask(&self.skills, "skills/getDisabledSkills").await?;
                out.insert("disabled".to_owned(), disabled.get("disabled").filter(|list| !list.is_null()).cloned().unwrap_or_else(|| json!([])));
                Ok(Value::Object(out))
            }
            "plugins" => ask(&self.plugins, "plugins/pluginsStatus").await,
            "hooks" => Ok(hook_status(&self.hooks.status().await)),
            other => Err(PortError::Failed { capability: "setup".into(), message: format!("setup: unknown status domain \"{other}\"") }),
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::CoreError;
    use mixdog_core_api::CoreRequest;
    use mixdog_core_api::Reply;
    use mixdog_core_api::ids::ConnectionId;
    use mixdog_core_api::ids::Method;
    use mixdog_core_api::service::Admit;
    use mixdog_rt::CancellationToken;
    use mixdog_rt::LaneToken;

    use super::*;

    /// A service that answers each method with the status the case recorded for it.
    struct Canned(Value);

    #[async_trait]
    impl DomainService for Canned {
        fn methods(&self) -> &'static [&'static str] {
            &["mcp/mcpStatus", "skills/skillsStatus", "skills/getDisabledSkills", "plugins/pluginsStatus"]
        }

        async fn call(&self, request: CoreRequest) -> Result<Reply, CoreError> {
            let key = request.method.0.rsplit('/').next().unwrap();
            Ok(Reply::Value(self.0[key].clone()))
        }

        fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
            Admit::Accepted
        }
    }

    struct Hooks(Value);

    #[async_trait]
    impl HooksStatus for Hooks {
        async fn status(&self) -> Value {
            self.0.clone()
        }
    }

    /// The text of a value with `from` replaced by `{data}` in every string, keys in order.
    fn portable(value: &Value, from: &str) -> Value {
        match value {
            Value::String(text) => Value::String(text.replace(from, "{data}")),
            Value::Array(items) => Value::Array(items.iter().map(|item| portable(item, from)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), portable(item, from))).collect()),
            other => other.clone(),
        }
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("../tests/golden/setup_status.json")).unwrap()
    }

    /// `mcp`, `skills`, `plugins`: Node's reader over the runtime answers it recorded, through the
    /// real setup executor; the object is compared as text, so the key order counts.
    #[tokio::test]
    async fn the_service_domains_answer_as_nodes_executor_does() {
        let golden = golden();
        for case in golden["services"].as_array().unwrap() {
            let service: Arc<dyn DomainService> = Arc::new(Canned(case["runtime"].clone()));
            let status = ServiceStatus::new(service.clone(), service.clone(), service, Arc::new(Hooks(Value::Null)));
            let domain = case["args"]["domain"].as_str().unwrap();
            let detail = case["args"]["detail"] == true;
            let answer = status.read(domain, detail, &ThreadId::from("t1")).await.unwrap();
            let Value::Object(mut with_domain) = answer else { panic!("{domain}: not an object") };
            let mut node = Map::new();
            node.insert("domain".to_owned(), json!(domain));
            node.append(&mut with_domain);
            assert_eq!(Value::Object(node).to_string(), case["text"].as_str().unwrap(), "{}", case["name"]);
        }
    }

    /// `hooks`: the real hook-bus status of a hooks file, read as the doctor reads it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_hooks_domain_answers_as_nodes_executor_does() {
        use crate::domain_seams::hook_status::HookEventLog;
        use crate::domain_seams::hook_status::HookStatus;

        let golden = golden();
        let tokens = mixdog_rt::testing::tokens();
        for case in golden["hooks"].as_array().unwrap() {
            let dir = tempfile::tempdir().unwrap();
            let (hooks_file, project) = (dir.path().join("hooks.json"), dir.path().join("project"));
            let file = case["file"].as_str().map(str::to_owned);
            let made = project.clone();
            tokens
                .maintenance_io
                .submit_wait(&CancellationToken::new(), move |lane| {
                    if let Some(file) = file {
                        mixdog_statefile::write_file(lane, &hooks_file, file.as_bytes(), &mixdog_statefile::Opts::default()).unwrap();
                    }
                    mixdog_statefile::create_private_dir_all(lane, &made).unwrap();
                })
                .await
                .unwrap()
                .await
                .unwrap();
            let log = HookEventLog::new(project);
            let hooks = HookStatus::new(dir.path().to_path_buf(), tokens.maintenance_io, log.clone(), log);
            let unused: Arc<dyn DomainService> = Arc::new(Canned(Value::Null));
            let status = ServiceStatus::new(unused.clone(), unused.clone(), unused, hooks);
            let answer = status.read("hooks", case["args"]["detail"] == true, &ThreadId::from("t1")).await.unwrap();
            let Value::Object(mut with_domain) = answer else { panic!("hooks: not an object") };
            let mut node = Map::new();
            node.insert("domain".to_owned(), json!("hooks"));
            node.append(&mut with_domain);
            let shown = portable(&Value::Object(node), &dir.path().to_string_lossy()).to_string();
            assert_eq!(shown, case["text"].as_str().unwrap(), "{}", case["name"]);
        }
    }
}
