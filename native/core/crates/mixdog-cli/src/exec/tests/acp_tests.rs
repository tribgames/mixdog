//! A Lead route on an ACP agent through the exec: the exec's own core, composed in process as `mixdogd exec` composes it, runs
//! the turn in the agent behind the host's switch of the feature, and the agent's answer is the exec's. The fake agent
//! (`mixdog-acp/fake/agent.rs`) is this test binary, started on [`the_fake_agents_process`]. The exec sets the process's
//! environment, so it runs in a child process of its own.
#![allow(clippy::disallowed_methods, reason = "test setup: the install, the host's settings and the child process")]

use std::time::Duration;

use mixdog_acp::preset::AgentPreset;
use mixdog_acp::preset::Distribution;
use mixdog_services::effort_judge::model::OrtRuntime;

use super::*;
use crate::exec::launcher::InProcessLauncher;
use crate::exec::lifecycle::system_clock;

#[allow(dead_code, reason = "the fake agent's own `main` is its binary's")]
#[path = "../../../../mixdog-acp/fake/agent.rs"]
mod fake_agent;

/// The argument that makes a run of this binary the fake agent: what follows it are the agent's own arguments.
const AGENT: &str = "acp-fake-agent";
/// Set in the child process that runs the exec: the folder the run works in.
const CHILD: &str = "EXEC_ACP_TEST_DIR";
/// The exec's whole run: the composition, the agent's check and its turn.
const LIMIT: Duration = Duration::from_secs(240);

/// The libtest name of `name` in this module.
fn test_name(name: &str) -> String {
    format!("{}::{name}", module_path!().split_once("::").expect("a module of the crate").1)
}

/// No test of anything: started with [`AGENT`] among its arguments, this binary is the fake agent on the arguments after it.
#[test]
fn the_fake_agents_process() {
    let args: Vec<String> = std::env::args().collect();
    let Some(at) = args.iter().position(|arg| arg == AGENT) else { return };
    // The harness's own line of this test ends before the agent's first.
    println!();
    fake_agent::run(args[at + 1..].to_vec());
}

/// The shipped CLI preset with this binary as its CLI, which updates itself as the shipped one does (the fake logs
/// `update`): nothing to install or sign in to.
fn fake_preset() -> AgentPreset {
    let test = test_name("the_fake_agents_process");
    let run = |argument: &str| -> Vec<String> { ["--exact", &test, "--nocapture", "--", AGENT, argument].map(str::to_owned).to_vec() };
    let shipped = mixdog_app_server_daemon::acp_tools::builtin_presets().into_iter().find(|preset| preset.id == "antigravity-cli").expect("the CLI's preset");
    AgentPreset {
        command: std::env::current_exe().expect("the test binary").to_string_lossy().into_owned(),
        args: run("acp"),
        version_args: run("--version"),
        env: Vec::new(),
        distribution: Distribution::Cli { installer: None, installed_at: Vec::new(), update_args: Some(run("update")) },
        login: None,
        usage: None,
        ..shipped
    }
}

/// The fake agent's model the run's Lead names: the CLI's preset offers no default model.
const FAKE_MODEL: &str = "m1";

/// The child's run: `mixdog exec --json --provider <the agent's> --model m1 tools`, its stdout kept in `exec.jsonl`.
fn exec_in(dir: &Path) {
    // An install as `mixdogd exec` resolves its own: the manifest beside the core, an interpreter file, this tree's package.
    let core = dir.join("core");
    std::fs::create_dir_all(&core).unwrap();
    std::fs::write(core.join("node"), "").unwrap();
    let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..").canonicalize().expect("the package root");
    let manifest = json!({ "program": "./node", "packageRoot": package }).to_string();
    std::fs::write(core.join(mixdog_app_server_daemon::js_runtime::MANIFEST_FILE), manifest).unwrap();
    let js = mixdog_app_server_daemon::js_runtime::resolve(&core.join("mixdogd"), None).expect("the install");
    // The host's settings: the ACP agents turned on, as the desktop's switch writes them.
    let host_data = dir.join("host-data");
    std::fs::create_dir_all(&host_data).unwrap();
    let settings = json!({ "agent": { "builtins": { mixdog_acp::FEATURE: { "installed": true } } } });
    std::fs::write(host_data.join("mixdog-config.json"), settings.to_string()).unwrap();
    let (ws, tmp) = (dir.join("ws"), dir.join("tmp"));
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::create_dir_all(&tmp).unwrap();

    let preset = fake_preset();
    let provider = preset.provider.clone();
    let (executors, tokens) = mixdog_app_server_daemon::boot_executors().expect("the executors");
    let launcher = InProcessLauncher::new(executors, tokens, js, OrtRuntime::NoBinding, vec![preset]);
    let sink = Arc::new(Out::default());
    let host = Host {
        launcher: &launcher,
        credentials: &Creds,
        host_env: std::env::vars().collect(),
        host_data_dir: host_data,
        agents_dir: dir.join("agents"),
        temp_dir: tmp,
        sink: sink.clone(),
        now: system_clock(),
    };
    let opts = ExecOptions {
        message: "tools".into(),
        provider: Some(provider),
        model: Some(FAKE_MODEL.into()),
        effort: None,
        fast: false,
        provider_config: None,
        route_profile: None,
        web_search: false,
        json: true,
        cwd: ws,
        usage_log: None,
        tool_mode: ToolMode::Full,
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let code = runtime.block_on(async { tokio::time::timeout(LIMIT, run_exec(opts, host, never())).await }).expect("the exec ended in time");
    std::fs::write(dir.join("exec.jsonl"), sink.stdout().concat()).unwrap();
    assert_eq!(code, 0, "{:?}", sink.stderr());
}

/// `mixdog exec --json` on an ACP agent's route: the agent is started for the run's session, is handed the session's tools
/// over its MCP server, and what it answers is the run's result. The one-shot run leaves the agent's CLI as it found it.
#[test]
fn a_lead_route_on_an_acp_agent_runs_in_the_agent_and_its_answer_is_the_execs_result() {
    if let Some(dir) = std::env::var_os(CHILD) {
        exec_in(Path::new(&dir));
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let agent_log = dir.path().join("agent.log");
    let ran = std::process::Command::new(std::env::current_exe().expect("the test binary"))
        .args(["--exact", &test_name("a_lead_route_on_an_acp_agent_runs_in_the_agent_and_its_answer_is_the_execs_result"), "--nocapture"])
        .env(CHILD, dir.path())
        // Every run of the fake agent, its version, update and ACP runs, logs what it was asked.
        .env("FAKE_AGENT_LOG", &agent_log)
        // Variables the boundary carries into the run: the core warms no catalog and no provider of its own.
        .env("MIXDOG_DISABLE_MODEL_CATALOG_WARMUP", "1")
        .env("MIXDOG_DISABLE_MODEL_PREFETCH", "1")
        .env("MIXDOG_DISABLE_PROVIDER_WARMUP", "1")
        .output()
        .expect("the child runs");
    let shown = format!("{}{}", String::from_utf8_lossy(&ran.stdout), String::from_utf8_lossy(&ran.stderr));
    assert!(ran.status.success(), "{shown}");
    let lines = std::fs::read_to_string(dir.path().join("exec.jsonl")).unwrap_or_else(|_| panic!("the child ran no exec: {shown}"));
    let result = lines
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|event| event["type"] == "result")
        .unwrap_or_else(|| panic!("no result line: {lines}"));
    assert_eq!(result["subtype"], "success", "{lines}");
    // The fake agent answers `tools` with the names its session's MCP server lists.
    let tools = result["result"].as_str().and_then(|answer| answer.strip_prefix("tools=")).unwrap_or_else(|| panic!("not the agent's answer: {lines}"));
    assert!(!tools.is_empty(), "the agent was handed no tool of the session: {lines}");
    let asked = std::fs::read_to_string(&agent_log).unwrap_or_default();
    assert!(asked.lines().any(|line| line == "session/prompt"), "{asked}");
    assert!(!asked.lines().any(|line| line == "update"), "the run updated the agent's CLI: {asked}");
}

/// The host's settings with the ACP agents switched as `agent` says, in `dir`.
fn host_settings(dir: &Path, agent: Value) -> PathBuf {
    let host = dir.join("host-data");
    std::fs::create_dir_all(&host).unwrap();
    std::fs::write(host.join("mixdog-config.json"), json!({ "agent": agent }).to_string()).unwrap();
    host
}

/// The boundary of a run whose Lead is on `provider`, with the shipped agents, the host's settings in `host` and its
/// environment `host_env`.
fn boundary_on(dir: &Path, provider: &str, host: &Path, host_env: &BTreeMap<String, String>, route_profile: Option<&str>) -> Result<Boundary, String> {
    let agents = dir.join("agents");
    std::fs::create_dir_all(agents.join("worker")).unwrap();
    std::fs::write(agents.join("worker").join("agent.json"), "{}").unwrap();
    let tmp = dir.join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    Boundary::create(&BoundaryRequest {
        provider,
        model: "default",
        effort: None,
        fast: false,
        provider_config: None,
        route_profile,
        agents_dir: &agents,
        agent_presets: &mixdog_app_server_daemon::acp_tools::builtin_presets(),
        host_env,
        host_data_dir: host,
        temp_dir: &tmp,
        credentials: &Creds,
    })
}

/// The ACP agents' switch is the host's, as the app reads it: off until the feature is installed, off again when its module is
/// turned off, and on by the environment's override. A run it refuses says so before anything starts and leaves no root.
#[test]
fn an_acp_lead_runs_only_while_the_hosts_switch_of_the_agents_is_on() {
    let off = [json!({}), json!({ "builtins": { "acpAgents": { "installed": true } }, "modules": { "acpAgents": { "enabled": false } } })];
    for agent in off {
        let dir = tempfile::tempdir().unwrap();
        let host = host_settings(dir.path(), agent.clone());
        let refused = boundary_on(dir.path(), "acp-antigravity", &host, &BTreeMap::new(), None).err().expect("refused");
        assert_eq!(refused, "route \"lead\" provider \"acp-antigravity\" is the ACP agent Antigravity: ACP agents are turned off in Settings.", "{agent}");
        assert_eq!(std::fs::read_dir(dir.path().join("tmp")).unwrap().count(), 0, "{agent}");
    }
    let dir = tempfile::tempdir().unwrap();
    let host = host_settings(dir.path(), json!({}));
    let overridden: BTreeMap<String, String> = [("MIXDOG_FEATURE_ACP_AGENTS".to_owned(), "1".to_owned())].into();
    let boundary = boundary_on(dir.path(), "acp-antigravity", &host, &overridden, None).expect("the environment turns the agents on");
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// The pristine run of an ACP Lead: the agents switched on in the run's own config, the agent no provider of it, no Mixdog
/// credential bound, and the audit saying the agent signs in on its own and that the host's switch was read.
#[test]
fn the_pristine_run_of_an_acp_lead_switches_the_agents_on_and_binds_no_credential() {
    let dir = tempfile::tempdir().unwrap();
    let host = host_settings(dir.path(), json!({ "builtins": { "acpAgents": { "installed": true } } }));
    let boundary = boundary_on(dir.path(), "acp-antigravity", &host, &BTreeMap::new(), None).expect("the switch is on");
    let written: Value = serde_json::from_str(&std::fs::read_to_string(boundary.data_dir.join("mixdog-config.json")).unwrap()).unwrap();
    let agent = &written["agent"];
    assert_eq!(agent["builtins"], json!({ "acpAgents": { "installed": true } }));
    assert_eq!(agent["providers"], json!({}), "the agent is no provider of the registry");
    assert_eq!((&agent["presets"][0]["provider"], &agent["presets"][0]["model"]), (&json!("acp-antigravity"), &json!("default")));
    assert_eq!(boundary.runtime_config, *agent);
    assert!(boundary.credential.is_none() && boundary.role_credentials.is_empty());
    assert_eq!((&boundary.audit["authMode"], &boundary.audit["personalState"]["hostConfigRead"]), (&json!("agent-cli-sign-in"), &json!(true)));
    std::fs::remove_dir_all(&boundary.root_dir).unwrap();
}

/// An ACP agent runs only the Lead's route: a route profile's role on one is refused by name, before anything starts.
#[test]
fn a_route_profiles_role_on_an_acp_agent_is_refused_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let host = host_settings(dir.path(), json!({ "builtins": { "acpAgents": { "installed": true } } }));
    let profile = r#"{"routes": {"worker": {"provider": "acp-antigravity", "model": "default"}}}"#;
    let refused = boundary_on(dir.path(), "openai", &host, &BTreeMap::new(), Some(profile)).err().expect("refused");
    assert_eq!(
        refused,
        "--route-profile route \"worker\" provider \"acp-antigravity\" is the ACP agent Antigravity; mixdog exec runs an ACP agent only on the Lead's route"
    );
    assert_eq!(std::fs::read_dir(dir.path().join("tmp")).unwrap().count(), 0);
}

/// An ACP Lead's provider is no provider whose host credentials are looked up; a route profile's other providers are.
#[test]
fn no_host_credential_is_looked_up_for_an_acp_agent() {
    let dir = tempfile::tempdir().unwrap();
    let presets = mixdog_app_server_daemon::acp_tools::builtin_presets();
    let mut opts = options(dir.path());
    opts.provider = Some("acp-antigravity".into());
    opts.route_profile = Some(r#"{"routes": {"worker": {"provider": "openai-oauth", "model": "m"}}}"#.into());
    assert_eq!(crate::exec::credential_providers(&opts, &presets), ["openai-oauth"]);
    opts.provider = Some("openai".into());
    assert_eq!(crate::exec::credential_providers(&opts, &presets), ["openai", "openai-oauth"]);
}
