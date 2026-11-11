//! Node's recording `fixtures/session-sequence/recording.json` (`record-session-sequence.mjs`, test file
//! `src/runtime/agent/orchestrator/session/store/session-sequence.test.mjs`), read when the test runs and decoded with
//! [`Exact`]: one test per case. One session's lifecycle operations run in order over the real thread store: a save is the
//! session's fenced header write (`thread/header/patch` with `expectedGeneration`, `saveSessionAsync(session, { expectedGeneration })`) or, for a
//! session that is not stored, its create under the same id (the record Node's save writes anew); the debounced save is
//! the same write (the core keeps no debounced copy) and answers nothing; the close and the detach are the directory's
//! own (`SessionClose::close`, `SessionClose::detach`: `markSessionClosed`, `bumpSessionGeneration`), answered with the
//! generation they resolved; the delete is `thread/delete`, Node's client delete. Node's injected unlink failure is the delete mark's durable write
//! failing (rolled back), asked of the case's plan once per mark as Node asks it once per unlink. Each case compares the
//! answers, the plan left, the marks written with their failure, and the whole stored record, as the manifest declares.

use mixdog_core_api::ids::ThreadId;
use mixdog_testkit::exact::Exact;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::address_replay::Real;
use super::address_replay::real;
use super::testing::awaiting;
use super::testing::lock;

fn recording() -> Exact {
    let text = mixdog_testkit::fixture!("../../fixtures/session-sequence/recording.json");
    Exact::decode(&serde_json::from_str(text).expect("the recording is JSON")).expect("the recording decodes")
}

/// Node's clock (`Date.now()` is 1700000000000 for the whole run).
const NOW: u64 = 1_700_000_000_000;

struct World {
    real: Real,
    id: ThreadId,
}

impl World {
    async fn new(id: &str) -> World {
        let real = real().await;
        real.rig.clock.0.store(NOW, std::sync::atomic::Ordering::SeqCst);
        World { real, id: ThreadId::from(id) }
    }

    /// The case's first save: the record created under its id.
    async fn create(&self, messages: &[Value]) -> Exact {
        let header = json!({ "id": self.id, "generation": 0, "closed": false, "tools": [], "messages": messages });
        self.real.directory.create_with_id(self.id.clone(), header.as_object().cloned().unwrap(), json!({})).await.expect("the record is created");
        Exact::String("saved".into())
    }

    /// `saveSessionAsync({ id, generation: 0, closed: false, messages }, { expectedGeneration: 0 })` after the first: the
    /// fenced write of the messages (dropped for a deleted session, whose writes the delete fenced).
    async fn save(&self, messages: &[Value]) -> Exact {
        let mut set = Map::new();
        set.insert("messages".into(), Value::Array(messages.to_vec()));
        Exact::String(super::lifecycle_replay::save_fenced(&self.real, &self.id, Some(0.0), set, Vec::new()).await.into())
    }

    /// The barrier's answer: the generation it wrote, `null` when no session is stored (`closeSession` answers true
    /// there: nothing is left to close).
    async fn barrier(&self, landed: bool) -> Exact {
        assert!(landed, "the barrier landed");
        match self.stored().await {
            Exact::Null => Exact::Null,
            stored => stored.get("generation").clone(),
        }
    }

    /// `markSessionClosed(id, 'test')`: no client entry takes the reason a random case records (`test`, stored as
    /// `closedReason`): every client close fixes its own (`thread/delete`, `thread/switchContext`, the exit, the idle sweep),
    /// and Node's test calls the store function directly (`session-sequence.test.mjs:187`). The directory's close writes it.
    async fn close(&self, reason: &str) -> Exact {
        let landed = super::lifecycle_replay::close_of(&self.real).close(self.id.as_str(), reason).await;
        self.barrier(landed).await
    }

    /// `bumpSessionGeneration(id, 'detach')`: likewise no client entry carries the reason `detach`
    /// (`session-sequence.test.mjs:188`); the directory's detach writes it.
    async fn detach(&self, reason: &str) -> Exact {
        let landed = super::lifecycle_replay::close_of(&self.real).detach(self.id.as_str(), reason, false).await;
        self.barrier(landed).await
    }

    /// thread/delete's answer (the client's `deleteSession`).
    async fn delete(&self) -> Exact {
        Exact::Bool(super::address_replay::delete(&self.real.directory, self.id.as_str()).await.expect("thread/delete"))
    }

    async fn stored(&self) -> Exact {
        match self.real.directory.stored_header(&self.id).await {
            Some(header) => Exact::plain(&Value::Object(header)),
            None => Exact::Null,
        }
    }

    /// The delete marks written, as Node's `unlinks` list them.
    fn unlinks(&self) -> Exact {
        Exact::Array(
            lock(&self.real.marks.seen)
                .iter()
                .map(|(id, fails)| Exact::Object(vec![("id".into(), Exact::String(id.clone())), ("fails".into(), Exact::Bool(*fails))]))
                .collect(),
        )
    }

    /// The stored record compared whole, `messages` at the place Node's record holds it (as in `lifecycle_replay.rs`).
    async fn same_stored(&self, want: &Exact, what: &str) {
        match (self.stored().await, want) {
            (Exact::Null, Exact::Null) => {}
            (got @ Exact::Object(_), Exact::Object(_)) => super::lifecycle_replay::same(&got, want, what),
            (got, want) => panic!("{what}: stored {got:?}, recorded {want:?}"),
        }
    }
}

fn message(content: &str) -> Value {
    json!({ "role": "user", "content": content })
}

/// What every case records the same way in the replay: no barrier failed (`commitError`), no timer armed before the ops and
/// no clock moved (`initial`, `clockSteps`).
fn same_quiet(result: &Exact, name: &str) {
    assert_eq!(result.get("commitError"), &Exact::Null, "{name}: commitError");
    let none = Exact::Object(vec![("timersArmed".into(), Exact::Array(Vec::new())), ("clockSteps".into(), Exact::Array(Vec::new()))]);
    assert_eq!(result.get("initial"), &none, "{name}: initial");
    assert_eq!(result.get("clockSteps"), &Exact::Array(Vec::new()), "{name}: clockSteps");
}

/// The first save of every case: `{ messages: [m0], generation: 0, closed: false }`.
async fn first_save(world: &World, input: &Exact) -> Exact {
    let initial = input.get("initialSave");
    assert_eq!(initial.get("generation"), &Exact::Number(0.0));
    assert_eq!(initial.get("closed"), &Exact::Bool(false));
    let messages: Vec<Value> = initial.get("messages").as_array().iter().map(|content| message(content.as_str())).collect();
    world.create(&messages).await
}

/// Line 64: `deleteSession(id)` accepted, then `closeSession(id, 'desktop-context-switch', { tombstone: false })` while it
/// runs; the delete's mark fails or not as recorded.
async fn detach_while_deleting(name: &str) {
    let recording = recording();
    let case = recording.get("cases").as_array().iter().find(|case| case.get("name").as_str() == name).cloned().expect("the case");
    let (input, result) = (case.get("input"), case.get("result"));
    let world = World::new(input.get("id").as_str()).await;
    let first = first_save(&world, input).await;
    let mut plan: std::collections::VecDeque<bool> = input.get("unlinkPlan").as_array().iter().map(|fails| *fails == Exact::Bool(true)).collect();
    *lock(&world.real.marks.plan) = Some(Box::new(move |_: &str| plan.pop_front() == Some(true)));
    let ops = input.get("ops").as_array();
    assert_eq!(ops[0].get("op").as_str(), "deleteSession");
    let close = &ops[1];
    assert_eq!((close.get("op").as_str(), close.get("options").get("tombstone")), ("closeSession", &Exact::Bool(false)));
    // Node's client delete detaches the session first and the closeSession issued right after it lands next, before the
    // delete's unlink: the delete is held once its detach landed, the detach runs, then the delete goes on.
    let held = super::address_replay::begin_delete(&world.real, &world.id).await;
    // The recorded `desktop-context-switch` detach is the one the client's context switch makes (`thread/switchContext`,
    // `SessionContextSwitch::leave`). That entry decides detach or tombstone from the thread's stored conversation rows, which
    // this recording holds only as its header's `messages` field (Node's `session.messages`): the switch would tombstone it,
    // so the detach it makes is replayed through the directory's own (see the case table).
    let closer = super::lifecycle_replay::close_of(&world.real);
    let closed = awaiting(|| "the detach to answer".to_owned(), closer.detach(world.id.as_str(), close.get("reason").as_str(), false)).await;
    let deleted = held.finish().await;
    let what = |field: &str| format!("{name}: {field}");
    assert_eq!(first, *result.get("firstSave"), "{}", what("firstSave"));
    assert_eq!(Exact::Bool(deleted), *result.get("deleted"), "{}", what("deleted"));
    assert_eq!(Exact::Bool(closed), *result.get("closed"), "{}", what("closed"));
    assert_eq!(world.unlinks(), *result.get("unlinks"), "{}", what("unlinks"));
    same_quiet(result, name);
    world.same_stored(result.get("stored"), &what("stored")).await;
}

/// Line 168, seed `seed`: the case's ops in order, each awaited before the next, against the plan of failing marks.
async fn random(seed: u32) {
    let recording = recording();
    let name = format!("random-seed-{seed}");
    let case = recording.get("cases").as_array().iter().find(|case| case.get("name").as_str() == name).cloned().expect("the case");
    let (input, result) = (case.get("input"), case.get("result"));
    let world = World::new(input.get("id").as_str()).await;
    // The recording holds no answer for a random case's first save (only the ops' results): the create is the save and
    // fails the test when the record is not stored.
    first_save(&world, input).await;
    let plan = std::sync::Arc::new(std::sync::Mutex::new(input.get("unlinkPlan").as_array().iter().map(|fails| *fails == Exact::Bool(true)).collect::<std::collections::VecDeque<_>>()));
    let queue = plan.clone();
    *lock(&world.real.marks.plan) = Some(Box::new(move |_: &str| lock(&queue).pop_front() == Some(true)));
    let mut client = vec![message(input.get("initialSave").get("messages").as_array()[0].as_str())];
    let mut results = Vec::new();
    for op in input.get("ops").as_array() {
        let answer = match op.get("kind").as_str() {
            "save" | "debounced" => {
                client.push(message(op.get("content").as_str()));
                let saved = world.save(&client).await;
                if op.get("kind").as_str() == "save" { saved } else { Exact::Undefined }
            }
            "close" => world.close("test").await,
            "detach" => world.detach("detach").await,
            "delete" | "deleteFail" => world.delete().await,
            other => panic!("unknown op {other}"),
        };
        results.push(answer);
    }
    let left = Exact::Array(lock(&plan).iter().map(|fails| Exact::Bool(*fails)).collect());
    assert_eq!(Exact::Array(results), *result.get("results"), "{name}: results");
    assert_eq!(left, *result.get("unlinkPlanLeft"), "{name}: unlinkPlanLeft");
    assert_eq!(world.unlinks(), *result.get("unlinks"), "{name}: unlinks");
    same_quiet(result, &name);
    world.same_stored(result.get("stored"), &format!("{name}: stored")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_64_detach_accepted_while_a_delete_succeeds() {
    detach_while_deleting("detach-accepted-while-a-delete-succeeds").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_64_detach_accepted_while_a_delete_fails() {
    detach_while_deleting("detach-accepted-while-a-delete-fails").await;
}

macro_rules! seeds {
    ($($name:ident = $seed:literal),* $(,)?) => {
        $(
            #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
            async fn $name() {
                random($seed).await;
            }
        )*
    };
}

seeds! {
    line_168_random_seed_1 = 1, line_168_random_seed_2 = 2, line_168_random_seed_3 = 3, line_168_random_seed_4 = 4,
    line_168_random_seed_5 = 5, line_168_random_seed_6 = 6, line_168_random_seed_7 = 7, line_168_random_seed_8 = 8,
    line_168_random_seed_9 = 9, line_168_random_seed_10 = 10, line_168_random_seed_11 = 11, line_168_random_seed_12 = 12,
    line_168_random_seed_13 = 13, line_168_random_seed_14 = 14, line_168_random_seed_15 = 15, line_168_random_seed_16 = 16,
    line_168_random_seed_17 = 17, line_168_random_seed_18 = 18, line_168_random_seed_19 = 19, line_168_random_seed_20 = 20,
    line_168_random_seed_21 = 21, line_168_random_seed_22 = 22, line_168_random_seed_23 = 23, line_168_random_seed_24 = 24,
    line_168_random_seed_25 = 25, line_168_random_seed_26 = 26, line_168_random_seed_27 = 27, line_168_random_seed_28 = 28,
    line_168_random_seed_29 = 29, line_168_random_seed_30 = 30, line_168_random_seed_31 = 31, line_168_random_seed_32 = 32,
    line_168_random_seed_33 = 33, line_168_random_seed_34 = 34, line_168_random_seed_35 = 35, line_168_random_seed_36 = 36,
    line_168_random_seed_37 = 37, line_168_random_seed_38 = 38, line_168_random_seed_39 = 39, line_168_random_seed_40 = 40,
    line_168_random_seed_41 = 41, line_168_random_seed_42 = 42, line_168_random_seed_43 = 43, line_168_random_seed_44 = 44,
    line_168_random_seed_45 = 45, line_168_random_seed_46 = 46, line_168_random_seed_47 = 47, line_168_random_seed_48 = 48,
    line_168_random_seed_49 = 49, line_168_random_seed_50 = 50, line_168_random_seed_51 = 51, line_168_random_seed_52 = 52,
    line_168_random_seed_53 = 53, line_168_random_seed_54 = 54, line_168_random_seed_55 = 55, line_168_random_seed_56 = 56,
    line_168_random_seed_57 = 57, line_168_random_seed_58 = 58, line_168_random_seed_59 = 59, line_168_random_seed_60 = 60,
}
