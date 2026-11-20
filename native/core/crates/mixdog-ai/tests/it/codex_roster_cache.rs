//! The Codex (`openai-oauth`) roster is kept per signed-in identity in `openai-oauth-models.<key>.json`, read back for the
//! route's effort ladder, and a model the account lists but the bundled catalog does not carries its levels all the way to
//! Auto. No roster is ever read as another account's, however the credential moves while a fetch is in flight, and a
//! switch of account discards the lists kept for the others.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_ai::catalog::Cached;
use mixdog_ai::catalog::ModelSource;
use mixdog_ai::catalog::OauthModelCache;
use mixdog_ai::catalog::Published;
use mixdog_ai::catalog::Roster;
use mixdog_ai::catalog::RosterAccounts;
use mixdog_ai::catalog::Rosters;
use mixdog_ai::effort::auto_effort_ladder;
use mixdog_ai::effort::effort_items_for;
use mixdog_ai::effort::effort_options_for;
use mixdog_ai::effort::ladder_row;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::service::admin_models::HydrationFacts;
use mixdog_ai::service::admin_models::hydrate_provider_model_row;
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_ai::service::effort_configuration::effort_configuration_mode;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ListedRoster;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::Provenance;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RosterIdentity;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

const HOUR: i64 = 60 * 60 * 1000;
const FETCHED_AT: i64 = 1_800_000_000_000;
const LEGACY_FILE: &str = "openai-oauth-models.json";

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

/// What the account lists: a model no bundled catalog knows, with the levels the backend states for it.
fn listed() -> Vec<ModelRecord> {
    let mut astra = ModelRecord::new("gpt-6.2-astra");
    astra.display_name = Some("GPT-6.2 Astra".into());
    astra.context_window = Some(272_000);
    astra.supports_reasoning = Some(true);
    astra.reasoning_levels = ["low", "medium", "high", "xhigh"].map(str::to_owned).to_vec();
    astra.picker.reasoning_options = vec![mixdog_core_api::domain::provider::ReasoningOption { kind: "effort".into(), values: astra.reasoning_levels.clone() }];
    astra.supports_reasoning_effort_updates = Some(true);
    vec![astra]
}

fn private_model(id: &str) -> Vec<ModelRecord> {
    let mut other = ModelRecord::new(id);
    other.reasoning_levels = vec!["low".into(), "high".into()];
    vec![other]
}

/// A listing whose identity is sampled (`roster_identity`) as `sampled` and whose request carries the credential of `used`:
/// they differ when the account moves between the sample and the authorisation (the account signed in is then `used`).
struct Fetch {
    calls: Arc<AtomicUsize>,
    answer: Result<Vec<ModelRecord>, ErrorKind>,
    sampled: std::sync::Mutex<RosterIdentity>,
    used: Option<RosterIdentity>,
    seed: bool,
    /// Held until released: a fetch that is in flight.
    gate: Option<Arc<tokio::sync::Notify>>,
    delay: Option<std::time::Duration>,
}

impl Fetch {
    fn new(answer: Option<Vec<ModelRecord>>, sampled: RosterIdentity) -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            answer: answer.ok_or(ErrorKind::Transient),
            sampled: std::sync::Mutex::new(sampled),
            used: None,
            seed: false,
            gate: None,
            delay: None,
        }
    }
}

#[async_trait]
impl ModelListing for Fetch {
    async fn roster_identity(&self) -> RosterIdentity {
        self.sampled.lock().unwrap().clone()
    }

    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        Ok(self.list_roster().await?.rows)
    }

    async fn list_roster(&self) -> Result<ListedRoster, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(delay) = self.delay {
            tokio::time::sleep(delay).await;
        }
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        if let Some(used) = &self.used {
            used.clone_into(&mut self.sampled.lock().unwrap());
        }
        let rows = self.answer.clone().map_err(|kind| ProviderError::new(kind, DeliveryState::NotSent))?;
        Ok(ListedRoster { rows, provenance: if self.seed { Provenance::Seed } else { Provenance::Fetched }, identity: self.sampled.lock().unwrap().clone() })
    }
}

struct Setup {
    dir: tempfile::TempDir,
    calls: Arc<AtomicUsize>,
    source: ModelSource,
    identity: RosterIdentity,
}

fn setup(dir: tempfile::TempDir, answer: Option<Vec<ModelRecord>>, now: i64) -> Setup {
    setup_for(dir, answer, now, who("acct-a", "0.166.0"))
}

fn setup_for(dir: tempfile::TempDir, answer: Option<Vec<ModelRecord>>, now: i64, identity: RosterIdentity) -> Setup {
    setup_with(dir, Fetch::new(answer, identity.clone()), now, identity, RosterAccounts::default())
}

fn setup_with(dir: tempfile::TempDir, fetch: Fetch, now: i64, identity: RosterIdentity, accounts: RosterAccounts) -> Setup {
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(move || now)).with_accounts(accounts);
    let calls = fetch.calls.clone();
    let source = ModelSource::new(ProviderId::from("openai-oauth"), Arc::new(fetch)).with_oauth_cache(cache);
    Setup { dir, calls, source, identity }
}

fn file_of(dir: &std::path::Path, identity: &RosterIdentity) -> PathBuf {
    dir.join(Roster::Codex.keyed_file(&mixdog_ai::catalog::roster_key(identity).expect("an identity of an account")))
}

impl Setup {
    fn path(&self) -> PathBuf {
        file_of(self.dir.path(), &self.identity)
    }
    fn fetches(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    fn file(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.path()).unwrap()).unwrap()
    }
}

fn ids(rows: &[mixdog_ai::catalog::ModelRecord]) -> Vec<String> {
    rows.iter().map(|r| r.id.clone()).collect()
}

struct Real(UnsupportedEfforts);

impl HydrationFacts for Real {
    fn fast_capable(&self, _: &str, _: &Value) -> bool {
        false
    }
    fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
        false
    }
    fn effort_items(&self, provider: &str, row: &Value) -> Value {
        Value::Array(effort_items_for(provider, row, None, None).into_iter().map(|i| json!({ "value": i.value })).collect())
    }
    fn effort_configuration_mode(&self, provider: &str, model: &str, opts: &Value) -> bool {
        effort_configuration_mode(provider, &Value::from(model), opts, &self.0, &|_| None).is_some()
    }
    fn custom_auto_effort_capable(&self, _: &str, _: Option<&Value>, _: &Value) -> bool {
        false
    }
    fn provider_config(&self, _: &str) -> Obj {
        Obj::new()
    }
}

fn who(account: &str, client: &str) -> RosterIdentity {
    RosterIdentity { account: Some(mixdog_ai::catalog::account_fingerprint(&[account])), client_version: Some(client.to_owned()), ..Default::default() }
}

#[tokio::test]
async fn a_fetched_roster_is_written_as_the_version_7_file_and_a_fresh_one_answers_without_a_fetch() {
    let first = setup(tempfile::tempdir().unwrap(), Some(listed()), FETCHED_AT);
    assert_eq!(ids(&first.source.list().await.unwrap()), ["gpt-6.2-astra"]);
    assert_eq!(first.fetches(), 1);
    let file = first.file();
    assert_eq!((file["version"].clone(), file["fetchedAt"].clone()), (json!(7), json!(FETCHED_AT)));
    assert_eq!(file["provenance"], "fetched");
    assert_eq!(file["account"], json!(mixdog_ai::catalog::roster_key(&first.identity).unwrap()));
    assert_eq!(file["models"][0]["id"], "gpt-6.2-astra");
    assert_eq!(file["models"][0]["reasoningLevels"], json!(["low", "medium", "high", "xhigh"]));

    // Within the TTL another process (a new source over the same directory) is served from the file.
    let again = setup(first.dir, Some(Vec::new()), FETCHED_AT + 23 * HOUR);
    assert_eq!(ids(&again.source.list().await.unwrap()), ["gpt-6.2-astra"]);
    assert_eq!(again.fetches(), 0, "a fresh roster is not fetched again");
}

#[tokio::test]
async fn an_expired_roster_is_fetched_again_and_replaced() {
    let first = setup(tempfile::tempdir().unwrap(), Some(listed()), FETCHED_AT);
    first.source.list().await.unwrap();
    let later = setup(first.dir, Some(private_model("gpt-6.3-astra")), FETCHED_AT + 25 * HOUR);
    assert_eq!(ids(&later.source.list().await.unwrap()), ["gpt-6.3-astra"]);
    assert_eq!(later.fetches(), 1);
    assert_eq!(later.file()["fetchedAt"], json!(FETCHED_AT + 25 * HOUR));
}

/// `listCodexModels`: a failed fetch shows no expired list; the picker gets an unavailable list and its retry state.
#[tokio::test]
async fn a_failed_fetch_past_the_ttl_shows_no_list_and_leaves_the_file() {
    let first = setup(tempfile::tempdir().unwrap(), Some(listed()), FETCHED_AT);
    assert!(first.source.listing().await.unwrap().stale.is_none(), "a fetched roster is not stale");
    let before = first.file();
    let failing = setup(first.dir, None, FETCHED_AT + 30 * HOUR);
    let shown = failing.source.listing().await.unwrap();
    assert!(shown.rows.is_empty(), "the expired roster is not the answer");
    assert!(shown.stale.is_some(), "and the list says why it is empty");
    assert_eq!(failing.fetches(), 1);
    assert_eq!(failing.file(), before, "the file is not rewritten by a failed fetch");
}

#[tokio::test]
async fn a_failed_fetch_with_no_roster_is_an_unavailable_list() {
    let none = setup(tempfile::tempdir().unwrap(), None, FETCHED_AT);
    let shown = none.source.listing().await.unwrap();
    assert!(shown.rows.is_empty() && shown.stale.is_some());
}

/// A rejected credential shows no list, not even one kept within its TTL for an older client.
#[tokio::test]
async fn a_rejected_credential_shows_no_list_not_a_kept_one() {
    let first = setup_for(tempfile::tempdir().unwrap(), Some(listed()), FETCHED_AT, who("acct-a", "0.166.0"));
    first.source.list().await.unwrap();
    let before = first.file();
    let mut rejected = Fetch::new(None, who("acct-a", "0.170.0"));
    rejected.answer = Err(ErrorKind::Auth);
    let rig = setup_with(first.dir, rejected, FETCHED_AT + HOUR, who("acct-a", "0.170.0"), RosterAccounts::default());
    let shown = rig.source.listing().await.unwrap();
    assert!(shown.rows.is_empty() && shown.stale.is_some(), "the rejection shows no list");
    assert_eq!(rig.file(), before, "the last good roster stays on disk");
}

#[tokio::test]
async fn an_empty_answer_does_not_replace_a_roster_and_the_kept_roster_is_shown_stale() {
    let first = setup(tempfile::tempdir().unwrap(), Some(listed()), FETCHED_AT);
    first.source.list().await.unwrap();
    let before = first.file();
    let empty = setup(first.dir, Some(Vec::new()), FETCHED_AT + 30 * HOUR);
    let shown = empty.source.listing().await.unwrap();
    assert_eq!(ids(&shown.rows), ["gpt-6.2-astra"]);
    assert!(shown.stale.is_some());
    assert_eq!(empty.file(), before, "a successful answer of nothing does not destroy the good list");
}

#[tokio::test]
async fn a_seed_is_never_written_and_never_replaces_a_fetched_roster() {
    let first = setup(tempfile::tempdir().unwrap(), Some(listed()), FETCHED_AT);
    first.source.list().await.unwrap();
    let before = first.file();
    let mut seeded = Fetch::new(Some(private_model("seed-model")), first.identity.clone());
    seeded.seed = true;
    let rig = setup_with(first.dir, seeded, FETCHED_AT + 30 * HOUR, first.identity.clone(), RosterAccounts::default());
    let shown = rig.source.listing().await.unwrap();
    assert_eq!(ids(&shown.rows), ["gpt-6.2-astra"]);
    assert!(shown.stale.is_some());
    assert_eq!(rig.file(), before);

    // With nothing fetched before, the seed is what there is, and still nothing is written.
    let mut seeded = Fetch::new(Some(private_model("seed-model")), who("acct-z", "0.166.0"));
    seeded.seed = true;
    let fresh = setup_with(tempfile::tempdir().unwrap(), seeded, FETCHED_AT, who("acct-z", "0.166.0"), RosterAccounts::default());
    assert_eq!(ids(&fresh.source.list().await.unwrap()), ["seed-model"]);
    assert!(!fresh.path().exists());
}

#[tokio::test]
async fn a_zero_filled_file_is_reported_damaged_and_replaced_by_a_fetch() {
    let dir = tempfile::tempdir().unwrap();
    let identity = who("acct-a", "0.166.0");
    std::fs::write(file_of(dir.path(), &identity), vec![0u8; 4096]).unwrap();
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).for_roster(Roster::Codex);
    match cache.read_for(&identity).await {
        Cached::Damaged(why) => assert!(why.contains("openai-oauth-models."), "{why}"),
        other => panic!("a zero-filled file is damaged, not an empty roster: {other:?}"),
    }
    let rig = setup(dir, Some(listed()), FETCHED_AT);
    assert_eq!(ids(&rig.source.list().await.unwrap()), ["gpt-6.2-astra"]);
    assert_eq!(rig.fetches(), 1, "the damaged file is refetched, not read as an empty roster");
    assert_eq!(rig.file()["version"], json!(7));
}

#[tokio::test]
async fn an_unbundled_model_the_account_lists_reaches_its_ladder_and_the_label_says_auto() {
    let accounts = RosterAccounts::default();
    let rig =
        setup_with(tempfile::tempdir().unwrap(), Fetch::new(Some(listed()), who("acct-a", "0.166.0")), FETCHED_AT, who("acct-a", "0.166.0"), accounts.clone());
    rig.source.list().await.unwrap();

    // The saved roster is what `getCachedModelInfo` answers for the route.
    let stored = Rosters::in_dir(rig.dir.path().to_path_buf()).with_accounts(accounts).row("openai-oauth", "gpt-6.2-astra").expect("the roster row");
    let row = ladder_row("gpt-6.2-astra", stored.as_object().cloned());
    let options = effort_options_for("openai-oauth", &row, None);
    assert_eq!(options, ["low", "medium", "high", "xhigh"]);
    assert_eq!(auto_effort_ladder(&options), ["low", "medium", "high", "xhigh"], "the judge has a ladder to move along");

    // The model row the picker and the cards read says Auto, from the same options.
    let facts = Real(UnsupportedEfforts::default());
    let listing_row = json!({ "id": "gpt-6.2-astra", "provider": "openai-oauth", "reasoningLevels": options });
    let hydrated = hydrate_provider_model_row(&Obj::new(), &listing_row, &facts);
    assert_eq!(hydrated["autoEffortCapable"], json!(true));
}

#[tokio::test]
async fn the_roster_records_its_client_version_and_a_newer_client_fetches_again() {
    let first = setup_for(tempfile::tempdir().unwrap(), Some(listed()), FETCHED_AT, who("acct-a", "0.166.0"));
    first.source.list().await.unwrap();
    assert_eq!(first.file()["clientVersion"], json!("0.166.0"));

    let same = setup_for(first.dir, Some(Vec::new()), FETCHED_AT + HOUR, who("acct-a", "0.166.0"));
    same.source.list().await.unwrap();
    assert_eq!(same.fetches(), 0, "the same client version is served from the file");

    // The backend lists what the reported client unlocks: a newer client asks again.
    let newer = setup_for(same.dir, Some(listed()), FETCHED_AT + HOUR, who("acct-a", "0.170.0"));
    newer.source.list().await.unwrap();
    assert_eq!(newer.fetches(), 1);
    assert_eq!(newer.file()["clientVersion"], json!("0.170.0"));

    // ...and when that fetch fails, the roster fetched for the older client is still the answer.
    let failing = setup_for(newer.dir, None, FETCHED_AT + 2 * HOUR, who("acct-a", "0.171.0"));
    assert_eq!(ids(&failing.source.list().await.unwrap()), ["gpt-6.2-astra"]);
}

/// A switch of account discards the list kept for the one signed out: A -> B -> A fetches A's list again, though A's was
/// within its TTL, and B's failing fetch never shows A's models.
#[tokio::test]
async fn an_account_switch_discards_the_list_and_a_return_fetches_it_again() {
    let accounts = RosterAccounts::default();
    let (a, b) = (who("acct-a", "0.166.0"), who("acct-b", "0.166.0"));
    let first = setup_with(tempfile::tempdir().unwrap(), Fetch::new(Some(listed()), a.clone()), FETCHED_AT, a.clone(), accounts.clone());
    first.source.list().await.unwrap();

    accounts.forget_all();
    let b_failing = setup_with(first.dir, Fetch::new(None, b.clone()), FETCHED_AT + HOUR, b.clone(), accounts.clone());
    let shown = b_failing.source.listing().await.unwrap();
    assert!(shown.rows.is_empty(), "B is never shown A's models");
    assert!(!file_of(b_failing.dir.path(), &a).exists(), "A's list was discarded when B signed in");

    let b = setup_with(b_failing.dir, Fetch::new(Some(private_model("gpt-9-private")), b.clone()), FETCHED_AT + HOUR, b.clone(), accounts.clone());
    assert_eq!(ids(&b.source.list().await.unwrap()), ["gpt-9-private"]);

    accounts.forget_all();
    let back = setup_with(b.dir, Fetch::new(Some(private_model("gpt-6.3-astra")), a.clone()), FETCHED_AT + 2 * HOUR, a.clone(), accounts.clone());
    assert_eq!(ids(&back.source.list().await.unwrap()), ["gpt-6.3-astra"], "A's list is fetched again");
    assert_eq!(back.fetches(), 1);
    assert!(!file_of(back.dir.path(), &who("acct-b", "0.166.0")).exists(), "B's list was discarded when A signed in again");
}

/// A listing for one account that is identity-scoped per sample: the account signed in can move while a fetch is held.
struct Switching {
    signed_in: std::sync::Mutex<RosterIdentity>,
    /// The answer of each account's fetch (`None`: it fails), and how many fetches each one saw.
    answers: Vec<(RosterIdentity, Option<Vec<ModelRecord>>)>,
    fetched: std::sync::Mutex<Vec<RosterIdentity>>,
    /// A's fetch waits here; the account moves to B while it waits.
    gate: Arc<tokio::sync::Notify>,
    entered: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl ModelListing for Switching {
    async fn roster_identity(&self) -> RosterIdentity {
        self.signed_in.lock().unwrap().clone()
    }

    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        Ok(self.list_roster().await?.rows)
    }

    async fn list_roster(&self) -> Result<ListedRoster, ProviderError> {
        let identity = self.signed_in.lock().unwrap().clone();
        let first = self.fetched.lock().unwrap().is_empty();
        self.fetched.lock().unwrap().push(identity.clone());
        if first {
            self.entered.notify_one();
            self.gate.notified().await;
        }
        let answer = self.answers.iter().find(|(who, _)| *who == identity).and_then(|(_, rows)| rows.clone());
        let rows = answer.ok_or_else(|| ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))?;
        Ok(ListedRoster { rows, provenance: Provenance::Fetched, identity })
    }
}

/// The account switches from A to B while A's fetch is out and failing: the failure is not delivered (A's kept list is
/// not shown for B), and the listing is B's.
#[tokio::test]
async fn a_switch_during_a_failing_fetch_delivers_the_new_accounts_list() {
    let (a, b) = (who("acct-a", "0.166.0"), who("acct-b", "0.166.0"));
    let accounts = RosterAccounts::default();
    let dir = tempfile::tempdir().unwrap();
    // A's list, within its TTL but for an older client: what a failure of A's fetch would show.
    let older =
        setup_with(tempfile::tempdir().unwrap(), Fetch::new(Some(listed()), who("acct-a", "0.160.0")), FETCHED_AT, who("acct-a", "0.160.0"), accounts.clone());
    older.source.list().await.unwrap();
    std::fs::copy(file_of(older.dir.path(), &a), file_of(dir.path(), &a)).unwrap();

    let listing = Arc::new(Switching {
        signed_in: std::sync::Mutex::new(a.clone()),
        answers: vec![(a.clone(), None), (b.clone(), Some(private_model("gpt-9-private")))],
        fetched: std::sync::Mutex::default(),
        gate: Arc::new(tokio::sync::Notify::new()),
        entered: Arc::new(tokio::sync::Notify::new()),
    });
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(|| FETCHED_AT + HOUR)).with_accounts(accounts.clone());
    let source = ModelSource::new(ProviderId::from("openai-oauth"), listing.clone()).with_oauth_cache(cache);
    let listed = tokio::spawn(async move { source.listing().await });
    listing.entered.notified().await;
    *listing.signed_in.lock().unwrap() = b.clone();
    accounts.forget_all();
    listing.gate.notify_one();

    let shown = listed.await.unwrap().unwrap();
    assert_eq!(ids(&shown.rows), ["gpt-9-private"], "the listing is B's");
    assert!(shown.stale.is_none());
    assert_eq!(*listing.fetched.lock().unwrap(), [a.clone(), b.clone()]);
    assert!(file_of(dir.path(), &b).exists() && !file_of(dir.path(), &a).exists(), "B's list is kept, A's discarded");
}

/// A -> B -> A while A's first fetch is still out: B's listing discarded A's list, so the return to A fetches anew and does
/// not join the fetch started before the discard.
#[tokio::test]
async fn a_return_to_an_account_does_not_join_its_fetch_from_before_the_discard() {
    let (a, b) = (who("acct-a", "0.166.0"), who("acct-b", "0.166.0"));
    let accounts = RosterAccounts::default();
    let dir = tempfile::tempdir().unwrap();
    let listing = Arc::new(Switching {
        signed_in: std::sync::Mutex::new(a.clone()),
        answers: vec![(a.clone(), Some(listed())), (b.clone(), Some(private_model("gpt-9-private")))],
        fetched: std::sync::Mutex::default(),
        gate: Arc::new(tokio::sync::Notify::new()),
        entered: Arc::new(tokio::sync::Notify::new()),
    });
    let source = || {
        let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(|| FETCHED_AT)).with_accounts(accounts.clone());
        ModelSource::new(ProviderId::from("openai-oauth"), listing.clone()).with_oauth_cache(cache)
    };
    let first = source();
    let held = tokio::spawn(async move { first.listing().await });
    listing.entered.notified().await;

    *listing.signed_in.lock().unwrap() = b.clone();
    accounts.forget_all();
    assert_eq!(ids(&source().listing().await.unwrap().rows), ["gpt-9-private"]);

    *listing.signed_in.lock().unwrap() = a.clone();
    accounts.forget_all();
    let back = tokio::time::timeout(std::time::Duration::from_secs(10), source().listing()).await.expect("the return fetches on its own");
    assert_eq!(ids(&back.unwrap().rows), ["gpt-6.2-astra"]);
    assert_eq!(*listing.fetched.lock().unwrap(), [a.clone(), b.clone(), a.clone()], "A is fetched again");

    listing.gate.notify_one();
    held.await.unwrap().unwrap();
}

/// A listing signed in as A when its identity is first sampled, and as B from then on.
struct MovesAfterSample {
    samples: AtomicUsize,
    a: RosterIdentity,
    b: RosterIdentity,
}

#[async_trait]
impl ModelListing for MovesAfterSample {
    async fn roster_identity(&self) -> RosterIdentity {
        if self.samples.fetch_add(1, Ordering::SeqCst) == 0 { self.a.clone() } else { self.b.clone() }
    }

    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        Ok(self.list_roster().await?.rows)
    }

    async fn list_roster(&self) -> Result<ListedRoster, ProviderError> {
        Ok(ListedRoster { rows: private_model("gpt-9-private"), provenance: Provenance::Fetched, identity: self.b.clone() })
    }
}

/// The account moves to B while A's fresh list is read from disk: A's list is not delivered, and the listing is B's.
#[tokio::test]
async fn a_switch_during_the_disk_read_does_not_deliver_the_previous_accounts_list() {
    let (a, b) = (who("acct-a", "0.166.0"), who("acct-b", "0.166.0"));
    let accounts = RosterAccounts::default();
    let first = setup_with(tempfile::tempdir().unwrap(), Fetch::new(Some(listed()), a.clone()), FETCHED_AT, a.clone(), accounts.clone());
    first.source.list().await.unwrap();
    accounts.forget_all();

    let cache = OauthModelCache::new(first.dir.path().to_path_buf(), io()).with_clock(Arc::new(|| FETCHED_AT + 1)).with_accounts(accounts.clone());
    let listing = MovesAfterSample { samples: AtomicUsize::new(0), a: a.clone(), b: b.clone() };
    let source = ModelSource::new(ProviderId::from("openai-oauth"), Arc::new(listing)).with_oauth_cache(cache);

    let shown = source.listing().await.unwrap();
    assert_eq!(ids(&shown.rows), ["gpt-9-private"], "the listing is B's, not A's fresh list");
    assert!(file_of(first.dir.path(), &b).exists() && !file_of(first.dir.path(), &a).exists(), "B's list is kept, A's discarded");
}

/// The account moves between sampling the identity and authorising the request: the answer is nobody's, and the listing
/// is made again for B, stored as B's.
#[tokio::test]
async fn a_response_fetched_with_bs_credential_is_never_stored_or_read_as_as() {
    let (a, b) = (who("acct-a", "0.166.0"), who("acct-b", "0.166.0"));
    let accounts = RosterAccounts::default();
    let mut switching = Fetch::new(Some(private_model("gpt-b-only")), a.clone());
    switching.used = Some(b.clone());
    let rig = setup_with(tempfile::tempdir().unwrap(), switching, FETCHED_AT, a.clone(), accounts.clone());
    let judge = |model: &str| Rosters::in_dir(rig.dir.path().to_path_buf()).with_accounts(accounts.clone()).row("openai-oauth", model);

    assert_eq!(ids(&rig.source.list().await.unwrap()), ["gpt-b-only"]);
    assert!(!file_of(rig.dir.path(), &a).exists(), "nothing was written for A");
    let stored: Value = serde_json::from_slice(&std::fs::read(file_of(rig.dir.path(), &b)).unwrap()).unwrap();
    assert_eq!(stored["models"][0]["id"], "gpt-b-only");
    assert_eq!(stored["account"], json!(mixdog_ai::catalog::roster_key(&b).unwrap()));
    // The readers follow the credential that was used: B's roster is B's, and A's reader finds nothing of it.
    assert!(judge("gpt-b-only").is_some(), "the roster shown is the roster the readers describe");
    let cache = OauthModelCache::new(rig.dir.path().to_path_buf(), io()).for_roster(Roster::Codex);
    assert!(matches!(cache.read_for(&b).await, Cached::Fresh(_)));
    assert!(matches!(cache.read_for(&a).await, Cached::Missing), "A's identity reads no roster");
}

#[tokio::test]
async fn a_signed_out_credential_names_no_account_and_nothing_is_written_for_it() {
    let anonymous = RosterIdentity::default();
    let rig = setup_with(tempfile::tempdir().unwrap(), Fetch::new(Some(listed()), anonymous.clone()), FETCHED_AT, anonymous, RosterAccounts::default());
    assert_eq!(ids(&rig.source.list().await.unwrap()), ["gpt-6.2-astra"]);
    let written: Vec<_> = std::fs::read_dir(rig.dir.path()).unwrap().collect();
    assert!(written.is_empty(), "a roster of nobody is not kept");
}

/// What 1.4.5 left (one shared file, no account) proves nothing about the account signed in now: no reader serves it.
#[tokio::test]
async fn a_shared_file_a_1_4_5_install_left_is_served_to_no_reader_and_the_first_fetch_replaces_it() {
    let dir = tempfile::tempdir().unwrap();
    let old = json!({ "version": 7, "fetchedAt": FETCHED_AT, "clientVersion": "0.166.0", "models": [{ "id": "gpt-5.5", "reasoningLevels": ["low", "high"] }] });
    std::fs::write(dir.path().join(LEGACY_FILE), old.to_string()).unwrap();
    let accounts = RosterAccounts::default();
    let identity = who("acct-a", "0.166.0");

    // Offline right after the upgrade: the fetch fails and the old roster is not shown as this account's. The picker gets an
    // unavailable list (its retry state), as a first start with no roster would.
    let offline = setup_with(dir, Fetch::new(None, identity.clone()), FETCHED_AT + 2 * HOUR, identity.clone(), accounts.clone());
    assert!(offline.source.list().await.unwrap().is_empty());
    let judged = Rosters::in_dir(offline.dir.path().to_path_buf()).with_accounts(accounts.clone()).row("openai-oauth", "gpt-5.5");
    assert!(judged.is_none(), "the metadata reader does not open it either");
    assert!(offline.dir.path().join(LEGACY_FILE).exists(), "a failed fetch leaves the old file as it was");

    // The first successful fetch writes the identity's own file and replaces the old one.
    let online = setup_with(offline.dir, Fetch::new(Some(listed()), identity.clone()), FETCHED_AT + 2 * HOUR, identity.clone(), accounts);
    assert_eq!(ids(&online.source.list().await.unwrap()), ["gpt-6.2-astra"]);
    assert_eq!(online.fetches(), 1);
    assert!(online.path().exists());
    assert!(!online.dir.path().join(LEGACY_FILE).exists());
}

#[tokio::test]
async fn the_row_keeps_what_1_4_5s_normalized_row_carried() {
    let mut astra = listed().remove(0);
    astra.supports_reasoning_summaries = Some(true);
    astra.raw = Some(json!({
        "slug": "gpt-6.2-astra", "priority": 3, "visibility": "list", "support_verbosity": true, "default_verbosity": "low",
        "auto_compact_token_limit": 200000, "effective_context_window_percent": 95, "supports_image_generation": false,
        "supported_tools": ["shell", {"type": "apply_patch"}],
        "upgrade": {"model": "gpt-6.3-astra", "retirement_at": "2027-01-01T00:00:00Z"},
    }));
    let rig = setup(tempfile::tempdir().unwrap(), Some(vec![astra]), FETCHED_AT);
    rig.source.list().await.unwrap();
    let row = rig.file()["models"][0].clone();
    for (key, value) in [
        ("supportsReasoningSummaries", json!(true)),
        ("priority", json!(3)),
        ("visibility", json!("list")),
        ("supportVerbosity", json!(true)),
        ("defaultVerbosity", json!("low")),
        ("autoCompactTokenLimit", json!(200000)),
        ("effectiveContextWindowPercent", json!(95)),
        ("supportsImageGeneration", json!(false)),
        ("supportedTools", json!(["shell", "apply_patch"])),
        ("upgrade", json!({"model": "gpt-6.3-astra", "retirementAt": "2027-01-01T00:00:00Z"})),
        ("provider", json!("openai-oauth")),
    ] {
        assert_eq!(row[key], value, "{key}");
    }
    // Read back, the summaries flag is the record's again.
    let cache = OauthModelCache::new(rig.dir.path().to_path_buf(), io()).for_roster(Roster::Codex).with_clock(Arc::new(|| FETCHED_AT));
    match cache.read_for(&rig.identity).await {
        Cached::Fresh(rows) => assert_eq!(rows[0].supports_reasoning_summaries, Some(true)),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn a_forced_refresh_ignores_the_ttl_and_a_failed_one_keeps_the_roster() {
    let first = setup(tempfile::tempdir().unwrap(), Some(listed()), FETCHED_AT);
    first.source.list().await.unwrap();
    let forced = setup(first.dir, Some(private_model("gpt-6.3-astra")), FETCHED_AT + HOUR);
    let source = forced.source.clone().bypassing_cache();
    assert_eq!(ids(&source.list().await.unwrap()), ["gpt-6.3-astra"], "a fresh roster is fetched again when refresh is asked for");
    assert_eq!(forced.fetches(), 1);

    let failing = setup(forced.dir, None, FETCHED_AT + 2 * HOUR);
    let source = failing.source.clone().bypassing_cache();
    assert_eq!(ids(&source.list().await.unwrap()), ["gpt-6.3-astra"], "a failed forced fetch leaves the roster in use");
}

/// Every reader of the files — the listing and the judge's row — reads the identity the listings last sampled and no other:
/// a real switch (B's listing runs while A's roster stands on disk) moves them together.
#[tokio::test]
async fn the_judges_row_follows_the_listing_across_a_real_account_switch() {
    let accounts = RosterAccounts::default();
    let dir = tempfile::tempdir().unwrap();
    let source = |fetch: Fetch, now: i64| {
        let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(move || now)).with_accounts(accounts.clone());
        ModelSource::new(ProviderId::from("openai-oauth"), Arc::new(fetch)).with_oauth_cache(cache)
    };
    let judge = |model: &str| Rosters::in_dir(dir.path().to_path_buf()).with_accounts(accounts.clone()).row("openai-oauth", model);
    let (a, b) = (who("acct-a", "0.166.0"), who("acct-b", "0.166.0"));

    assert!(judge("gpt-6.2-astra").is_none(), "no identity is known before the first listing");
    source(Fetch::new(Some(listed()), a.clone()), FETCHED_AT).list().await.unwrap();
    assert!(judge("gpt-6.2-astra").is_some(), "A's own row, for A");

    source(Fetch::new(Some(private_model("gpt-9-private")), b.clone()), FETCHED_AT + HOUR).list().await.unwrap();
    assert!(judge("gpt-6.2-astra").is_none() && judge("gpt-9-private").is_some(), "B reads B's roster alone");

    // A signs in again and A's listing runs offline: A's copy was discarded by the switch, and B's is not read.
    assert!(source(Fetch::new(None, a.clone()), FETCHED_AT + 2 * HOUR).list().await.unwrap().is_empty());
    assert!(judge("gpt-6.2-astra").is_none() && judge("gpt-9-private").is_none(), "A does not read B's roster");
}

/// An older refresh finishing last must not replace a newer publication (in one process by ticket, across processes by when
/// the fetch began).
#[tokio::test]
async fn an_older_refresh_that_finishes_last_does_not_replace_a_newer_publication() {
    let identity = who("acct-a", "0.166.0");
    let dir = tempfile::tempdir().unwrap();
    let accounts = RosterAccounts::default();
    let cache = |now: i64, accounts: &RosterAccounts| {
        OauthModelCache::new(dir.path().to_path_buf(), io()).for_roster(Roster::Codex).with_clock(Arc::new(move || now)).with_accounts(accounts.clone())
    };
    for (older_clock, newer_clock, shared) in [(FETCHED_AT, FETCHED_AT, true), (FETCHED_AT, FETCHED_AT + 5, false)] {
        let _ = std::fs::remove_file(file_of(dir.path(), &identity));
        let (older_accounts, newer_accounts) =
            if shared { (accounts.clone(), accounts.clone()) } else { (RosterAccounts::default(), RosterAccounts::default()) };
        let gate = Arc::new(tokio::sync::Notify::new());
        let mut older = Fetch::new(Some(private_model("older")), identity.clone());
        older.gate = Some(gate.clone());
        let older_calls = older.calls.clone();
        let older_cache = cache(older_clock, &older_accounts);
        let newer_cache = cache(newer_clock, &newer_accounts);
        // Each refresh is of the identity its listing read.
        older_cache.read_for(&identity).await;
        newer_cache.read_for(&identity).await;
        let in_flight = tokio::spawn(async move { older_cache.refresh(Arc::new(older), None).await });
        while older_calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let newer = newer_cache.refresh(Arc::new(Fetch::new(Some(private_model("newer")), identity.clone())), None).await.unwrap();
        assert_eq!(newer.published, Published::Written);
        gate.notify_one();
        let older = in_flight.await.unwrap().unwrap();
        assert_eq!(older.published, Published::Superseded, "shared={shared}");
        let file: Value = serde_json::from_slice(&std::fs::read(file_of(dir.path(), &identity)).unwrap()).unwrap();
        assert_eq!(file["models"][0]["id"], "newer", "shared={shared}: the newer publication stands");
    }
}

/// Refreshes of one identity that overlap share one fetch.
#[tokio::test]
async fn overlapping_refreshes_of_one_identity_share_one_fetch() {
    let identity = who("acct-a", "0.166.0");
    let accounts = RosterAccounts::default();
    let dir = tempfile::tempdir().unwrap();
    let mut slow = Fetch::new(Some(listed()), identity.clone());
    slow.delay = Some(std::time::Duration::from_millis(50));
    let calls = slow.calls.clone();
    let cache = OauthModelCache::new(dir.path().to_path_buf(), io()).with_clock(Arc::new(|| FETCHED_AT)).with_accounts(accounts);
    let source = ModelSource::new(ProviderId::from("openai-oauth"), Arc::new(slow)).with_oauth_cache(cache);
    let (first, second) = tokio::join!(source.list(), source.list());
    assert_eq!((ids(&first.unwrap()), ids(&second.unwrap())), (vec!["gpt-6.2-astra".to_owned()], vec!["gpt-6.2-astra".to_owned()]));
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the second caller joined the fetch in flight");
}
