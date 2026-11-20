//! What comes of a widening card's answer.

use super::*;

fn answer(approved: bool, scope: Option<&str>) -> CardOutcome {
    CardOutcome::Settled(Some(CardAnswer {
        approved,
        scope: scope.map(str::to_owned),
        response: Some(if approved { "approve" } else { "deny" }.into()),
        device: Some("phone".into()),
        ..CardAnswer::default()
    }))
}

#[tokio::test]
async fn a_request_for_a_level_the_tool_already_has_or_lower_is_no_widening_and_raises_no_card() {
    let world = world().await;
    // Only a widening asks. A request at the current level is written as it is (nothing changes),
    // and a lower one narrows at once; both answer the plain receipt of the level asked for.
    for requested in ["needs_approval", "disabled"] {
        let receipt = run(&world, "set_agent_connector_tool", tool_args(requested)).await.unwrap();
        assert_eq!(receipt, json!({ "agent": "ada", "connector": "gmail", "tool": "send", "permission": requested }), "{requested}");
        let now = world.setup.connectors.tool_permission("ada", "gmail", "send").await.unwrap();
        assert_eq!(now.name(), requested);
    }
    assert!(world.person.cards.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_approval_that_picks_no_level_the_card_offered_changes_nothing() {
    let world = world().await;
    // The card offers `auto` only: no level, a narrower one and a made-up one are not answers to it.
    for scope in [None, Some("disabled"), Some("needs_approval"), Some("everything")] {
        *world.person.outcome.lock().unwrap() = answer(true, scope);
        let receipt = run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
        assert_eq!((receipt["saved"].clone(), receipt["approved"].clone()), (json!(false), json!(false)), "{scope:?}");
        assert_eq!(receipt["note"], "The user did not approve this change; nothing changed.");
    }
    let tool = world.setup.connectors.tool_permission("ada", "gmail", "send").await.unwrap();
    assert_eq!(tool, Permission::NeedsApproval);
}

/// What the person approved on the card is what the tool becomes.
#[tokio::test]
async fn a_widening_the_person_approved_on_the_card_is_applied() {
    let world = world().await;
    *world.person.outcome.lock().unwrap() = answer(true, Some("auto"));
    let receipt = run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
    assert_eq!(receipt["approved"], true);
    assert_eq!(receipt["permission"], "auto");
    assert_eq!(receipt["note"], "The user approved on the card; send is now auto.");
    let tool = world.setup.connectors.tool_permission("ada", "gmail", "send").await.unwrap();
    assert_eq!(tool, Permission::Auto);
}

#[tokio::test]
async fn the_person_may_pick_a_lower_level_than_asked_and_that_is_what_applies() {
    let world = world().await;
    world.setup.connectors.set_tool_permission("ada", &json!("gmail"), &json!("send"), &json!("disabled"), false).await.unwrap();
    *world.person.outcome.lock().unwrap() = answer(true, Some("needs_approval"));
    let receipt = run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
    assert_eq!(receipt["permission"], "needs_approval");
    assert_eq!(world.setup.connectors.tool_permission("ada", "gmail", "send").await.unwrap(), Permission::NeedsApproval);
}

/// The person at a card who, while it is open, changes the policy the way a desktop edit or
/// another chat could: the answer is given only after that.
struct Racing {
    connectors: Arc<AgentConnectors>,
    meanwhile: Mutex<Option<(&'static str, &'static str, Value)>>,
    outcome: CardOutcome,
}

#[async_trait]
impl WidenCards for Racing {
    async fn ask(&self, _: &ThreadId, _: &WidenCard) -> CardOutcome {
        let step = self.meanwhile.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some((server, tool, permission)) = step {
            self.connectors.set_tool_permission("ada", &json!(server), &json!(tool), &permission, false).await.unwrap();
        }
        self.outcome.clone()
    }
}

/// The world's handler with its card replaced by a [`Racing`] one.
fn racing(world: &World, meanwhile: (&'static str, &'static str, Value), outcome: CardOutcome) -> AgentSettingsSetup {
    let setup = &world.setup;
    let cards = Arc::new(Racing { connectors: setup.connectors.clone(), meanwhile: Mutex::new(Some(meanwhile)), outcome });
    AgentSettingsSetup::new(setup.connectors.clone(), setup.permissions.clone(), setup.projects.clone(), cards, setup.audit.clone())
}

async fn widen(setup: &AgentSettingsSetup, args: Value) -> Value {
    let mut full = args.as_object().unwrap().clone();
    full.insert("action".into(), "set_agent_connector_tool".into());
    let full = Value::Object(full);
    setup.run(&SetupCall { action: "set_agent_connector_tool", args: &full, thread: &ThreadId::from("thread-1") }).await.unwrap()
}

async fn audit_rows(world: &World) -> Vec<(String, String, String, String)> {
    let rows = world.grants.read_audit(Some("ada"), 10).await.unwrap();
    rows.into_iter().map(|e| (e.action, e.target, e.decision, e.device)).collect()
}

fn row(action: &str, target: &str, decision: &str) -> (String, String, String, String) {
    (action.into(), target.into(), decision.into(), "phone".into())
}

#[tokio::test]
async fn an_approval_widens_only_that_tool_and_a_later_plain_write_is_judged_again() {
    let world = world().await;
    let connectors = &world.setup.connectors;
    connectors.set_tool_permission("ada", &json!("gmail"), &json!("other"), &json!("disabled"), false).await.unwrap();
    *world.person.outcome.lock().unwrap() = answer(true, Some("auto"));
    run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
    assert_eq!(connectors.tool_permission("ada", "gmail", "send").await.unwrap(), Permission::Auto);
    assert_eq!(connectors.tool_permission("ada", "gmail", "other").await.unwrap(), Permission::Disabled, "another tool is not carried along");
    // The approval was spent by its write: widening the other tool is a request of its own.
    let again = connectors.set_tool_permission("ada", &json!("gmail"), &json!("other"), &json!("auto"), true).await.unwrap_err();
    assert_eq!(again.to_string(), NO_WIDEN);
}

#[tokio::test]
async fn a_restriction_that_landed_while_the_card_was_open_wins_and_the_person_is_told() {
    let world = world().await;
    let setup = racing(&world, ("gmail", "send", json!("disabled")), answer(true, Some("auto")));
    let receipt = widen(&setup, tool_args("auto")).await;
    assert_eq!((receipt["approved"].clone(), receipt["saved"].clone(), receipt["permission"].clone()), (json!(true), json!(false), json!("disabled")));
    assert_eq!(receipt["note"], format!("The user approved auto, but it was not applied: {TOOL_NARROWED}"));
    assert_eq!(world.setup.connectors.tool_permission("ada", "gmail", "send").await.unwrap(), Permission::Disabled, "the policy is the restriction");
    assert_eq!(audit_rows(&world).await, [row("kept", "needs_approval>disabled", "approve")]);
}

#[tokio::test]
async fn a_level_granted_while_the_card_was_open_is_left_as_it_is_and_the_person_is_told() {
    let world = world().await;
    let setup = racing(&world, ("gmail", "send", json!("auto")), answer(true, Some("auto")));
    let receipt = widen(&setup, tool_args("auto")).await;
    assert_eq!((receipt["approved"].clone(), receipt["saved"].clone(), receipt["permission"].clone()), (json!(true), json!(false), json!("auto")));
    assert_eq!(receipt["note"], format!("The user approved auto, but it was not applied: {TOOL_ALREADY}"));
    assert_eq!(world.setup.connectors.tool_permission("ada", "gmail", "send").await.unwrap(), Permission::Auto);
    assert_eq!(audit_rows(&world).await, [row("already", "needs_approval>auto", "approve")]);
}

#[tokio::test]
async fn a_restriction_removed_while_the_card_was_open_leaves_the_tool_on_its_default_with_no_override() {
    let world = world().await;
    let connectors = &world.setup.connectors;
    // `custom` is no catalog connector: with no override its tools are `auto`.
    connectors.set_tool_permission("ada", &json!("custom"), &json!("run"), &json!("needs_approval"), false).await.unwrap();
    let setup = racing(&world, ("custom", "run", Value::Null), answer(true, Some("auto")));
    let args = json!({ "agent": "ada", "name": "custom", "tool": "run", "permission": "auto" });
    let receipt = widen(&setup, args).await;
    assert_eq!((receipt["approved"].clone(), receipt["saved"].clone(), receipt["permission"].clone()), (json!(true), json!(false), json!("auto")));
    assert_eq!(receipt["note"], format!("The user approved auto, but it was not applied: {TOOL_ALREADY}"));
    assert_eq!(connectors.tool_permission("ada", "custom", "run").await.unwrap(), Permission::Auto);
    let explicit = connectors.always_allowed("ada").await.unwrap();
    assert!(!explicit.as_array().unwrap().iter().any(|row| row["connector"] == "custom"), "no explicit `auto` was installed: {explicit}");
    assert_eq!(audit_rows(&world).await, [row("already", "needs_approval>auto", "approve")]);
}

#[tokio::test]
async fn a_card_for_one_account_names_the_connector_and_what_is_approved_governs_all_its_accounts() {
    let world = world().await;
    let connectors = &world.setup.connectors;
    *world.person.outcome.lock().unwrap() = answer(true, Some("auto"));
    let args = json!({ "agent": "ada", "name": "gmail-2", "tool": "send", "permission": "auto" });
    let receipt = run(&world, "set_agent_connector_tool", args).await.unwrap();
    assert_eq!(receipt["permission"], "auto");
    let cards = world.person.cards.lock().unwrap().clone();
    assert_eq!(cards[0].server, "gmail", "the card names the connector, not the account");
    assert!(cards[0].reason.contains("(gmail, all its accounts)"), "{}", cards[0].reason);
    // A tool's permission is stored once for the connector, so every account follows; a plain
    // narrowing through one account does the same.
    for account in ["gmail", "gmail-2"] {
        assert_eq!(connectors.tool_permission("ada", account, "send").await.unwrap(), Permission::Auto, "{account}");
    }
    connectors.set_tool_permission("ada", &json!("gmail-2"), &json!("send"), &json!("disabled"), true).await.unwrap();
    assert_eq!(connectors.tool_permission("ada", "gmail", "send").await.unwrap(), Permission::Disabled);
}
#[tokio::test]
async fn a_denied_card_changes_nothing_and_the_call_says_so() {
    let world = world().await;
    *world.person.outcome.lock().unwrap() = answer(false, None);
    let receipt = run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
    assert_eq!((receipt["saved"].clone(), receipt["approved"].clone()), (json!(false), json!(false)));
    assert_eq!(receipt["permission"], "needs_approval");
    assert_eq!(receipt["note"], "The user did not approve this change; nothing changed.");
    assert_eq!(world.setup.connectors.tool_permission("ada", "gmail", "send").await.unwrap(), Permission::NeedsApproval);
}

#[tokio::test]
async fn the_audit_records_the_answer_the_device_whether_it_applied_and_the_levels_in_force_after() {
    let world = world().await;
    *world.person.outcome.lock().unwrap() = answer(true, Some("auto"));
    run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
    assert_eq!(audit_rows(&world).await, [row("applied", "needs_approval>auto", "approve")]);

    // Back to asking, then a denied card: nothing applied, the level in force is unchanged.
    world.setup.connectors.set_tool_permission("ada", &json!("gmail"), &json!("send"), &json!("needs_approval"), false).await.unwrap();
    *world.person.outcome.lock().unwrap() = answer(false, None);
    run(&world, "set_agent_connector_tool", tool_args("auto")).await.unwrap();
    let rows = audit_rows(&world).await;
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(rows.contains(&row("none", "needs_approval>needs_approval", "deny")), "{rows:?}");
    assert!(rows.contains(&row("applied", "needs_approval>auto", "approve")), "{rows:?}");
}
