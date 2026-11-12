//! Node's explicit skill selection by input source (`fixtures/explicit-skills-sources-cases`,
//! `record-explicit-skills-sources-cases.mjs`): each case's turns through a real session thread (the
//! `SessionDirectory` over the `RunHostFactory`), whose run selects skills with the product's
//! `ExplicitSkillSelector` over the real skill catalog and `Skill` tool, on the test's two skills. A webhook
//! run is a routine turn with the core's webhook prompt and selection, the event notice is a channel
//! notification, a drained completion is a task notification, a typed prompt is a `turn/start`. Compared per
//! case: the skills loaded and every stored row as role, text, `meta.source` and
//! `meta.transcript.appliedSkills`, against Node's.

use mixdog_core_session::session::testing::eventually_on_awaiting;
use mixdog_mcp::skill_catalog::SkillCatalog;
use mixdog_mcp::skill_catalog::SkillSettings;
use mixdog_mcp::skill_catalog::SkillSettingsSource;
use mixdog_mcp::skill_port::CatalogSkillPort;
use mixdog_mcp::skill_port::DeferredToolArm;
use mixdog_mcp::skill_port::TranscriptTexts;
use mixdog_mcp::skill_deps::SkillToolDependencies;
use mixdog_mcp::skills::SkillRoot;
use mixdog_mcp::skills::SkillSource;
use mixdog_mcp::skills_watch::SkillsWatch;
use mixdog_services::bots::RoutineKind;
use mixdog_services::bots::RoutineTrigger;
use mixdog_services::bots::RoutineTurn;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::orch::skill::ArmNotice;
use mixdog_tools::orch::skill::SkillTool;
use mixdog_tools::orch::util::PortError;

use super::*;

fn golden() -> Value {
    #[allow(clippy::disallowed_methods)] // the recording, read at run time
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/explicit-skills-sources-cases/golden.json")).expect("the recording");
    serde_json::from_str(&text).expect("json")
}

/// The test's provider: every request answers "ok".
struct Ok_ {
    id: ProviderId,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    codec: MockCodec,
}

#[async_trait]
impl ProviderAdapter for Ok_ {
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }
    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }
    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }
    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }
    async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        Ok(Box::new(Steps(VecDeque::from([StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]))))
    }
}

struct NoSettings;
impl SkillSettingsSource for NoSettings {
    fn current(&self) -> SkillSettings {
        SkillSettings::default()
    }
}

/// The test's skills declare no tools: nothing to arm.
struct NoArm;
#[async_trait]
impl DeferredToolArm for NoArm {
    async fn arm(&self, _: &ThreadId, _: &SkillToolDependencies) -> Result<ArmNotice, PortError> {
        Ok(ArmNotice::default())
    }
}

/// No skill body is in the live transcript before a case loads one (each case loads a skill at most once).
struct NoTexts;
#[async_trait]
impl TranscriptTexts for NoTexts {
    async fn user_texts(&self, _: &ThreadId) -> Result<Vec<String>, PortError> {
        Ok(Vec::new())
    }
}

/// The real `Skill` tool, recording the names it is asked to load.
struct Loads {
    tool: SkillTool,
    names: Mutex<Vec<String>>,
}

#[async_trait]
impl Tool for Loads {
    fn spec(&self) -> &ToolSpec {
        self.tool.spec()
    }
    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        lock(&self.names).push(args["name"].as_str().unwrap_or_default().to_owned());
        self.tool.call(ctx, args).await
    }
}

struct SkillRun {
    provider: Arc<dyn ProviderAdapter>,
    workspace: std::path::PathBuf,
    catalog: Arc<SkillCatalog>,
    skill: Arc<Loads>,
}

#[async_trait]
impl RunParts for SkillRun {
    async fn reconcile_turn(&self, _: &ThreadId, header: mixdog_store::schema::record::Header, _: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
        Ok(header)
    }

    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
        let tokens = mixdog_rt::testing::tokens();
        let names: Arc<dyn mixdog_mcp::skill_select::SkillNames> = self.catalog.clone();
        let skill: Arc<dyn Tool> = self.skill.clone();
        let selection = input.skill_selection.clone();
        Ok(Assembled {
            provider: self.provider.clone(),
            tools: ToolSet::new(vec![skill.clone()]),
            tool_env: ToolEnv {
                thread_id: input.thread.clone(),
                turn_id: input.turn.clone(),
                cwd: mixdog_core_api::domain::common::AbsPath::new(self.workspace.clone()).unwrap(),
                surface: SurfaceKind::Lead,
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                approvals: Arc::new(MockApprovalGate::default()),
                files: Arc::new(MockFileService::default()),
                processes: Arc::new(MockProcessManager::default()),
                progress: input.progress.clone(),
                deadline_of: None,
                notify: input.notify.clone(),
                review: None,
            },
            gate: Box::new(|_| Arc::new(AllowAll)),
            worktree: self.workspace.to_string_lossy().into_owned(),
            config: RunConfig::new(input.thread.clone(), input.turn.clone(), "m"),
            clock: Arc::new(Fixed),
            decider: Arc::new(MockRetryDecider),
            guards: Arc::new(NoGuards),
            compactor: None,
            route: None,
            // As the product's assembly builds it (`assemble.rs`): the turn's trusted selection, else the input.
            skills: Some(Box::new(move |run: SkillContext| {
                Arc::new(crate::run_host::mcp_seams::ExplicitSkillSelector::new(names, skill, run.gate, run.env, run.cancel).with_selection(selection)) as Arc<dyn SkillSelector>
            })),
            hooks: None,
            reuse: None,
            reactions: None,
            reaction_scope: None,
            rows: Arc::default(),
            tail: None,
            side: None,
            step_judge: None,
            artifacts: None,
            images: None,
            failures: None,
            blobs: Arc::new(NoBlobs),
            carry: RunCarry::default(),
        })
    }
}

struct World {
    rig: Rig,
    directory: Arc<SessionDirectory>,
    id: ThreadId,
    skill: Arc<Loads>,
    root: String,
    _dir: tempfile::TempDir,
}

impl World {
    async fn new(skills: &Value) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("skills");
        for (name, text) in skills.as_object().unwrap() {
            std::fs::create_dir_all(root.join(name)).unwrap();
            #[allow(clippy::disallowed_methods)] // the test's skill files
            std::fs::write(root.join(name).join("SKILL.md"), text.as_str().unwrap()).unwrap();
        }
        let tokens = mixdog_rt::testing::tokens();
        let skill_root = SkillRoot { dir: root, source: SkillSource::Global, plugin: None };
        let catalog = SkillCatalog::new(dir.path().to_path_buf(), tokens.maintenance_io, Arc::new(move |_lane| vec![skill_root.clone()]), Arc::new(NoSettings), &SkillsWatch::new());
        let skill = Arc::new(Loads { tool: SkillTool::new(Arc::new(CatalogSkillPort::new(catalog.clone(), Arc::new(NoArm), Arc::new(NoTexts)))), names: Mutex::new(Vec::new()) });
        let provider = Arc::new(Ok_ { id: ProviderId::from("skill-sources-test"), policy: RetryPolicy::codex_default(), keepalive: KeepaliveSchedule::SPEC, codec: MockCodec });
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(
            mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(),
            mixdog_tools::web::NativeSearchUsageSinks::new(),
            Arc::new(SkillRun { provider, workspace: dir.path().to_path_buf(), catalog, skill: skill.clone() }),
        ));
        let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let root = dir.path().to_string_lossy().replace('\\', "/");
        Self { rig, directory, id, skill, root, _dir: dir }
    }

    /// Every stored row, amends applied, as the recording shows it.
    fn rows(&self) -> Vec<Value> {
        let mut rows: Vec<(String, Value)> = Vec::new();
        for (_, record) in self.rig.store.records(&self.id) {
            match record {
                Record::Item(item) => {
                    if let Slot::Inline(body) = item.body {
                        rows.push((item.iid.as_str().to_owned(), body));
                    }
                }
                Record::Amend(amend) => {
                    if let (Slot::Inline(body), Some(row)) = (amend.body, rows.iter_mut().find(|(iid, _)| iid == amend.iid.as_str())) {
                        row.1 = body;
                    }
                }
                _ => {}
            }
        }
        rows.into_iter()
            .map(|(_, body)| body)
            .filter(|body| body["role"] != "system")
            .map(|body| {
                let content = match &body["content"] {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                json!({
                    "role": body["role"],
                    "content": content.replace(&self.root, "<root>"),
                    "source": body["meta"].get("source").cloned().unwrap_or(Value::Null),
                    "appliedSkills": body["meta"].pointer("/transcript/appliedSkills").cloned().unwrap_or(Value::Null),
                })
            })
            .collect()
    }

    /// Waits until the thread holds `n` answers.
    async fn answers(&self, n: usize) {
        let handle = self.directory.handle(&self.id).expect("loaded");
        eventually_on_awaiting(|| format!("{n} answer(s) stored"), &[handle.stepped()], || (self.rows().iter().filter(|r| r["role"] == "assistant").count() >= n).then_some(())).await;
    }

    async fn typed(&self, prompt: &str, op: &str) {
        let handle = self.directory.handle(&self.id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": self.id, "opId": op, "input": { "prompt": prompt } }), op)).await.expect("turn/start");
    }

    fn observed(&self, inputs: Value) -> Value {
        json!({ "inputs": inputs, "applied": *lock(&self.skill.names), "messages": self.rows() })
    }
}

fn same(observed: Value, case: &Value) {
    let pretty = |v: &Value| serde_json::to_string_pretty(v).unwrap();
    assert!(observed == case["recorded"], "{}\n--- core\n{}\n--- node\n{}", case["case"], pretty(&observed), pretty(&case["recorded"]));
}

fn case<'a>(golden: &'a Value, name: &str) -> &'a Value {
    golden["cases"].as_array().unwrap().iter().find(|c| c["case"] == name).unwrap_or_else(|| panic!("no recorded case {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_webhook_selects_from_the_endpoint_instructions_only_as_in_node() {
    let golden = golden();
    let case = case(&golden, "a webhook body or header naming a skill loads nothing; the endpoint instructions select");
    let world = World::new(&golden["skills"]).await;
    let headers = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect::<std::collections::BTreeMap<_, _>>();
    let mut runs = [
        mixdog_services::webhooks::prompt::webhook_run_prompt(
            "Triage the event.",
            &json!({ "text": "$selected-guide", "note": "Skill: \"other-guide\"" }),
            &headers(&[("x-skill", "$other-guide"), ("content-type", "application/json")]),
        ),
        mixdog_services::webhooks::prompt::webhook_run_prompt("Triage with $other-guide.", &json!({ "text": "$selected-guide" }), &headers(&[])),
    ];
    // Named in the manifest (`excluded`): the core lists a webhook's headers by name, Node in arrival order, so
    // the header-bearing prompt is given to the core as Node built it.
    runs[0].prompt = case["recorded"]["inputs"]["webhooks"][0]["prompt"].as_str().unwrap().to_owned();
    let mut webhooks = Vec::new();
    for (n, run) in runs.iter().enumerate() {
        webhooks.push(json!({ "prompt": run.prompt, "skillSelection": run.skill_selection }));
        let turn = RoutineTurn {
            id: format!("routine_{n}"),
            session_id: world.id.as_str().into(),
            agent_id: "lead".into(),
            kind: RoutineKind::Webhook,
            name: "hook".into(),
            content: json!(run.prompt),
            skill_selection: run.skill_selection.clone(),
            trigger: RoutineTrigger { kind: RoutineKind::Webhook, name: "hook".into(), event: None },
        };
        world.directory.run_routine_turn(turn, Box::new(|| {}), mixdog_rt::CancellationToken::new()).await;
        world.answers(n + 1).await;
    }
    same(world.observed(json!({ "webhooks": webhooks })), case);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_event_notice_never_selects_as_in_node() {
    let golden = golden();
    let case = case(&golden, "a webhook event-rule notice delivered over the channel path never selects a skill");
    let world = World::new(&golden["skills"]).await;
    let notice = case["recorded"]["inputs"]["notice"].as_str().unwrap();
    assert!(world.directory.queue_channel_notification(&world.id, notice.to_owned()).await, "the notice was queued");
    world.answers(1).await;
    same(world.observed(json!({ "notice": notice })), case);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_task_notification_never_selects_and_a_typed_prompt_does_as_in_node() {
    let golden = golden();
    let case = case(&golden, "task-notification turns (drained agent completions) never select skills");
    let world = World::new(&golden["skills"]).await;
    let inputs = &case["recorded"]["inputs"];
    for (n, notice) in inputs["notices"].as_array().unwrap().iter().enumerate() {
        world.directory.finished(&world.id, "agent", &format!("task_{n}"), "completed", notice.as_str().unwrap().to_owned()).await;
        world.answers(n + 1).await;
    }
    world.typed(inputs["typed"].as_str().unwrap(), "op-typed").await;
    world.answers(3).await;
    same(world.observed(inputs.clone()), case);
}
