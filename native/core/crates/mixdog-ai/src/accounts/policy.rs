//! The roster's pure decisions, ported from `provider-accounts.mjs`: which
//! models a quota window or a refusal block gates, whether an account is
//! exhausted for a model, when it can serve again, and which account the
//! roster picks. Time is always an argument (Unix ms).

use std::collections::HashSet;

use mixdog_js::js_trim;
use mixdog_js::js_trim_start;

use super::model::Account;
use super::model::Block;
use super::model::Policy;
use super::model::Pool;
use super::model::Usage;
use super::model::Window;

/// How old a recorded reading may be and still steer the roster.
const USAGE_EVIDENCE_MAX_AGE_MS: i64 = 60 * 60_000;
/// A full window with no reset time counts for this long after its reading.
const FULL_WINDOW_FRESH_MS: i64 = 60_000;

/// Labels every current reading scopes with `models`/`except`. A stored window
/// carrying one without a scope predates per-model gating, so its whole
/// reading is stale.
pub fn scoped_window_labels(provider: &str) -> &'static [&'static str] {
    match provider {
        "anthropic-oauth" => &["EXTRA"],
        "antigravity-oauth" => &["7D Argon", "5H Claude/GPT", "7D Claude/GPT"],
        "cursor-oauth" => &["Basic", "API"],
        _ => &[],
    }
}

pub fn stale_quota_windows(provider: &str, windows: &[Window]) -> bool {
    let labels = scoped_window_labels(provider);
    windows.iter().any(|w| {
        labels.contains(&js_trim(&w.label)) && w.models.is_none() && w.except.is_none()
    })
}

/// `7D <Family>` → the family (a single token starting with a letter).
fn family_of_label(label: &str) -> Option<&str> {
    let label = js_trim(label);
    let rest = label.get(..2).filter(|p| p.eq_ignore_ascii_case("7d"))?;
    let after = &label[rest.len()..];
    let family = js_trim_start(after);
    if family.len() == after.len() {
        return None; // `\s+` needs at least one space
    }
    let mut chars = family.chars();
    let first = chars.next()?;
    (first.is_ascii_alphabetic() && chars.all(|c| c.is_ascii_alphanumeric())).then_some(family)
}

enum Scope<'a> {
    Models(Vec<String>),
    Except(&'a [String]),
}

fn window_scope(window: &Window) -> Option<Scope<'_>> {
    if let Some(models) = &window.models {
        return Some(Scope::Models(models.clone()));
    }
    if let Some(except) = window.except.as_deref().filter(|e| !e.is_empty()) {
        return Some(Scope::Except(except));
    }
    family_of_label(&window.label).map(|f| Scope::Models(vec![f.to_ascii_lowercase()]))
}

fn is_scoped(window: &Window) -> bool {
    window_scope(window).is_some()
}

fn display_only(window: &Window) -> bool {
    window.models.as_ref().is_some_and(Vec::is_empty)
}

fn separator(c: char) -> bool {
    matches!(c, '-' | '_' | '/' | '.' | '@')
}

/// Whether `token` appears in `model` bounded by separators or the ends.
fn names_model(model: &str, tokens: &[String]) -> bool {
    let id = model.to_lowercase();
    tokens.iter().any(|token| {
        let token = token.to_lowercase();
        id.char_indices().any(|(at, _)| {
            id[at..].starts_with(&token) && {
                let before = id[..at].chars().next_back();
                let after = id[at + token.len()..].chars().next();
                before.is_none_or(separator) && after.is_none_or(separator)
            }
        })
    })
}

pub fn quota_window_applies_to_model(window: &Window, model: &str) -> bool {
    match window_scope(window) {
        None => true,
        Some(_) if model.is_empty() => false,
        Some(Scope::Models(tokens)) => names_model(model, &tokens),
        Some(Scope::Except(tokens)) => !names_model(model, tokens),
    }
}

fn windows_of(usage: &Option<Usage>) -> &[Window] {
    usage.as_ref().map_or(&[], |u| u.windows.as_slice())
}

/// The meters a block stands for: the windows of the limit the refusal named,
/// else the scoped windows that gate the model that earned it.
fn block_windows<'a>(usage: &'a Option<Usage>, block: &Block) -> Vec<&'a Window> {
    let windows = windows_of(usage);
    let limit = block.blocked_limit.as_deref().unwrap_or("");
    if !limit.is_empty() {
        let named: Vec<_> = windows
            .iter()
            .filter(|w| w.limit.as_deref() == Some(limit))
            .collect();
        if !named.is_empty() {
            return named;
        }
    }
    let earned = js_trim(block.blocked_model.as_deref().unwrap_or(""));
    if earned.is_empty() {
        return Vec::new();
    }
    windows
        .iter()
        .filter(|w| is_scoped(w) && quota_window_applies_to_model(w, earned))
        .collect()
}

/// The windows a fresh reading must show below 100% to lift a block.
pub fn block_evidence_windows<'a>(usage: &'a Option<Usage>, block: &Block) -> Vec<&'a Window> {
    let earned = js_trim(block.blocked_model.as_deref().unwrap_or(""));
    let mut out = block_windows(usage, block);
    for window in windows_of(usage) {
        let gates = if earned.is_empty() {
            !display_only(window)
        } else {
            quota_window_applies_to_model(window, earned)
        };
        if gates && !out.iter().any(|w| std::ptr::eq(*w, window)) {
            out.push(window);
        }
    }
    out
}

/// A refusal earned by one model must not idle a model drawing on another
/// meter. With no scoped meter to attribute it to, the block is account-wide.
fn block_applies_to_model(usage: &Option<Usage>, block: &Block, model: &str) -> bool {
    let earned = js_trim(block.blocked_model.as_deref().unwrap_or(""));
    if earned.is_empty() || model.is_empty() || earned == model {
        return true;
    }
    let windows = block_windows(usage, block);
    windows.is_empty() || windows.iter().any(|w| quota_window_applies_to_model(w, model))
}

/// When the blocks holding `model` lift (every block when none is named): the
/// latest of their deadlines. Past deadlines are returned as they are.
pub fn account_blocked_until(row: &Account, model: &str) -> Option<i64> {
    row.blocks()
        .iter()
        .filter(|b| block_applies_to_model(&row.usage, b, model))
        .map(|b| b.blocked_until)
        .max()
}

fn window_full(row: &Account, window: &Window, now: i64) -> bool {
    window.used_pct.is_some_and(|p| p >= 100.0)
        && match window.reset_at.filter(|r| *r != 0) {
            Some(reset) => reset > now,
            None => now - row.usage.as_ref().map_or(0, |u| u.checked_at) < FULL_WINDOW_FRESH_MS,
        }
}

pub fn account_exhausted(row: &Account, now: i64, model: &str, use_credits: bool) -> bool {
    if row
        .blocks()
        .iter()
        .any(|b| b.blocked_until > now && block_applies_to_model(&row.usage, b, model))
    {
        return true;
    }
    if use_credits {
        return false;
    }
    windows_of(&row.usage)
        .iter()
        .any(|w| quota_window_applies_to_model(w, model) && window_full(row, w, now))
}

/// Earliest moment any of the exhausted `rows` can serve `model` again, or
/// `None` when unknown. Per account the latest blocking reset counts; across
/// accounts the earliest account does. An inferred block, or a full window
/// without a reset time, leaves that account's reset unknown.
pub fn accounts_reset_at(rows: &[Account], now: i64, model: &str, use_credits: bool) -> Option<i64> {
    let mut known = Vec::new();
    for row in rows {
        if !account_exhausted(row, now, model, use_credits) {
            continue;
        }
        let mut times = Vec::new();
        let mut unknown = false;
        for block in row.blocks() {
            if block.blocked_until <= now || !block_applies_to_model(&row.usage, &block, model) {
                continue;
            }
            if block.blocked_source.as_deref() == Some("retry-after") {
                times.push(block.blocked_until);
            } else {
                unknown = true;
            }
        }
        if !use_credits {
            for window in windows_of(&row.usage) {
                if !window.used_pct.is_some_and(|p| p >= 100.0)
                    || !quota_window_applies_to_model(window, model)
                {
                    continue;
                }
                match window.reset_at.filter(|r| *r != 0) {
                    Some(reset) if reset > now => times.push(reset),
                    Some(_) => {}
                    None => {
                        if now - row.usage.as_ref().map_or(0, |u| u.checked_at) < FULL_WINDOW_FRESH_MS {
                            unknown = true;
                        }
                    }
                }
            }
        }
        if !unknown && let Some(latest) = times.into_iter().max() {
            known.push(latest);
        }
    }
    known.into_iter().min()
}

/// The display name of a scoped limit: the family of a `7D Fable` label, else
/// the label without its window prefix (`5H Claude/GPT` → `Claude/GPT`).
fn window_family(window: &Window) -> String {
    let label = js_trim(&window.label);
    if let Some(family) = family_of_label(label) {
        return family.to_owned();
    }
    let stripped = label
        .get(..2)
        .filter(|p| p.eq_ignore_ascii_case("5h") || p.eq_ignore_ascii_case("7d"))
        .map(|p| &label[p.len()..])
        .filter(|rest| rest.starts_with(char::is_whitespace))
        .map(str::trim_start)
        .filter(|rest| !rest.is_empty());
    stripped.unwrap_or(label).to_owned()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Limit {
    /// Every request is refused.
    Account,
    /// Only the named model families are; other models still run.
    Model(Vec<String>),
}

/// Which limit currently holds the account, independent of any one model.
pub fn account_limit(row: &Account, now: i64, use_credits: bool) -> Option<Limit> {
    let windows = windows_of(&row.usage);
    let covering: Vec<Vec<&Window>> = row
        .blocks()
        .iter()
        .filter(|b| b.blocked_until > now)
        .map(|b| block_windows(&row.usage, b))
        .collect();
    if covering
        .iter()
        .any(|meters| meters.is_empty() || meters.iter().any(|w| !is_scoped(w)))
    {
        return Some(Limit::Account);
    }
    if !use_credits && windows.iter().any(|w| !is_scoped(w) && window_full(row, w, now)) {
        return Some(Limit::Account);
    }
    let mut families: Vec<String> = Vec::new();
    let mut add = |family: String| {
        if !families.contains(&family) {
            families.push(family);
        }
    };
    for window in covering.iter().flatten() {
        add(window_family(window));
    }
    if !use_credits {
        for window in windows {
            if is_scoped(window) && !display_only(window) && window_full(row, window, now) {
                add(window_family(window));
            }
        }
    }
    (!families.is_empty()).then_some(Limit::Model(families))
}

/// The account refuses `model` only through a model-scoped limit: it still
/// serves other models.
pub fn account_exhausted_for_model_only(row: &Account, now: i64, model: &str, use_credits: bool) -> bool {
    account_exhausted(row, now, model, use_credits)
        && matches!(account_limit(row, now, use_credits), Some(Limit::Model(_)))
}

/// Whether a reading taken at `checked_at` may still steer a decision.
pub fn quota_reading_fresh(checked_at: i64, now: i64) -> bool {
    checked_at > 0 && now - checked_at <= USAGE_EVIDENCE_MAX_AGE_MS
}

/// Remaining headroom across every window applying to `model`, or `None` when
/// nothing recent measured the account. The fullest window decides.
fn account_headroom(row: &Account, now: i64, model: &str) -> Option<f64> {
    let usage = row.usage.as_ref()?;
    if now - usage.checked_at > USAGE_EVIDENCE_MAX_AGE_MS {
        return None;
    }
    usage
        .windows
        .iter()
        .filter(|w| quota_window_applies_to_model(w, model))
        .filter_map(|w| w.used_pct)
        .fold(None, |max: Option<f64>, used| Some(max.map_or(used, |m| m.max(used))))
        .map(|max| 100.0 - max)
}

/// The account a request of `model` should go to. `session_account_id` is the
/// account the requesting session already runs on (headroom policy only):
/// kept while usable, so a session switches only on a limit.
pub fn choose_account<'a>(
    pool: &'a Pool,
    excluded: &HashSet<String>,
    now: i64,
    model: &str,
    session_account_id: Option<&str>,
) -> Option<&'a Account> {
    let credits = pool.uses_credits();
    let usable = |row: &Account| !excluded.contains(&row.id) && !account_exhausted(row, now, model, credits);
    let selected = pool.selected();
    let policy = pool.policy();
    if policy == Policy::Manual {
        let selected = selected?;
        if excluded.contains(&selected.id) {
            return None;
        }
        return (credits || usable(selected)).then_some(selected);
    }
    let preferred = if policy == Policy::Headroom {
        session_account_id.and_then(|id| pool.account(id))
    } else {
        selected
    };
    if let Some(row) = preferred.filter(|r| usable(r)) {
        return Some(row);
    }
    // Ranking needs evidence for EVERY candidate: with a partial roster it
    // would keep picking the one measured account while unmeasured ones never
    // take their turn.
    let candidates: Vec<&Account> = pool.accounts.iter().filter(|r| usable(r)).collect();
    if candidates.len() < 2 {
        return candidates.first().copied();
    }
    let headroom: Option<Vec<f64>> = candidates
        .iter()
        .map(|row| account_headroom(row, now, model))
        .collect();
    let Some(headroom) = headroom else {
        return Some(candidates[0]);
    };
    let best = headroom
        .iter()
        .enumerate()
        .fold((0, f64::MIN), |(bi, bv), (i, v)| if *v > bv { (i, *v) } else { (bi, bv) })
        .0;
    Some(candidates[best])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(label: &str, used: f64, reset: Option<i64>) -> Window {
        Window {
            label: label.into(),
            used_pct: Some(used),
            reset_at: reset,
            ..Window::default()
        }
    }

    fn row(id: &str, windows: Vec<Window>, checked_at: i64) -> Account {
        Account {
            usage: Some(Usage { windows, checked_at }),
            ..Account::new(id)
        }
    }

    const NOW: i64 = 1_000_000_000;

    #[test]
    fn family_labels_gate_only_their_model_and_shared_windows_gate_all() {
        let fable = win("7D Fable", 100.0, Some(NOW + 1));
        assert!(quota_window_applies_to_model(&fable, "claude-fable-4"));
        assert!(!quota_window_applies_to_model(&fable, "claude-opus-4"));
        assert!(!quota_window_applies_to_model(&fable, ""), "scoped window gates no unnamed model");
        assert!(quota_window_applies_to_model(&win("5H", 1.0, None), "anything"));
        assert!(quota_window_applies_to_model(&win("7D OAuth apps", 1.0, None), "x"), "multi-word label is shared");
        let except = Window { except: Some(vec!["haiku".into()]), ..win("EXTRA", 1.0, None) };
        assert!(!quota_window_applies_to_model(&except, "claude-haiku-4"));
        assert!(quota_window_applies_to_model(&except, "claude-opus-4"));
        let display = Window { models: Some(vec![]), ..win("EXTRA", 1.0, None) };
        assert!(!quota_window_applies_to_model(&display, "claude-opus-4"));
    }

    #[test]
    fn a_full_scoped_window_is_a_model_limit_not_an_account_limit() {
        let acct = row("a", vec![win("5H", 10.0, None), win("7D Fable", 100.0, Some(NOW + 5))], NOW);
        assert!(account_exhausted(&acct, NOW, "fable-1", false));
        assert!(!account_exhausted(&acct, NOW, "opus-1", false));
        assert_eq!(account_limit(&acct, NOW, false), Some(Limit::Model(vec!["Fable".into()])));
        assert!(account_exhausted_for_model_only(&acct, NOW, "fable-1", false));
        let shared = row("b", vec![win("5H", 100.0, Some(NOW + 5))], NOW);
        assert_eq!(account_limit(&shared, NOW, false), Some(Limit::Account));
        assert!(!account_exhausted(&shared, NOW, "x", true), "credits ignore full windows");
    }

    #[test]
    fn blocks_stack_per_model_and_a_fresh_reading_lifts_only_what_it_shows_free() {
        let mut acct = row("a", vec![win("5H", 100.0, Some(NOW + 9))], NOW);
        let early = Block { blocked_until: NOW + 10, blocked_model: Some("m1".into()), ..Block::default() };
        let late = Block {
            blocked_until: NOW + 20,
            blocked_source: Some("retry-after".into()),
            ..Block::default()
        };
        acct.set_blocks(vec![early.clone(), late.clone()]);
        assert_eq!(acct.blocks(), vec![early.clone(), late.clone()]);
        assert_eq!(acct.blocked_buckets, Some(vec![early]));
        assert_eq!(account_blocked_until(&acct, ""), Some(NOW + 20));
        let evidence = block_evidence_windows(&acct.usage, &late);
        assert!(evidence.iter().all(|w| w.used_pct == Some(100.0)));
        // The inferred block of m1 has no narrower meter, so it holds every
        // model and its end is unknown.
        assert_eq!(accounts_reset_at(&[acct.clone()], NOW, "other", false), None);
        acct.set_blocks(vec![late]);
        assert_eq!(accounts_reset_at(&[acct.clone()], NOW, "other", false), Some(NOW + 20));
        assert_eq!(accounts_reset_at(&[acct], NOW, "other", true), Some(NOW + 20));
    }

    #[test]
    fn rotation_prefers_the_selected_account_then_the_most_headroom() {
        let fresh = |used| row("x", vec![win("5H", used, None)], NOW);
        let mut a = fresh(100.0);
        a.id = "a".into();
        let mut b = fresh(80.0);
        b.id = "b".into();
        let mut c = fresh(20.0);
        c.id = "c".into();
        let mut pool = Pool { accounts: vec![a, b, c], selected_id: Some("a".into()), ..Pool::default() };
        let none = HashSet::new();
        assert_eq!(choose_account(&pool, &none, NOW, "", None).map(|r| r.id.as_str()), Some("c"));
        pool.accounts[2].usage.as_mut().unwrap().checked_at = NOW - 2 * USAGE_EVIDENCE_MAX_AGE_MS;
        assert_eq!(
            choose_account(&pool, &none, NOW, "", None).map(|r| r.id.as_str()),
            Some("b"),
            "one unmeasured candidate means roster order, not ranking"
        );
        pool.set_policy(Policy::Manual);
        assert!(choose_account(&pool, &none, NOW, "", None).is_none(), "manual serves the selected only");
        pool.set_policy(Policy::Headroom);
        let excluded: HashSet<String> = ["b".to_owned()].into();
        assert_eq!(choose_account(&pool, &excluded, NOW, "", Some("b")).map(|r| r.id.as_str()), Some("c"));
    }

    #[test]
    fn stale_readings_are_those_with_an_unscoped_label_of_a_scoped_family() {
        let plain = win("EXTRA", 1.0, None);
        assert!(stale_quota_windows("anthropic-oauth", std::slice::from_ref(&plain)));
        assert!(!stale_quota_windows("grok-oauth", &[plain]));
        assert!(quota_reading_fresh(NOW - 1, NOW) && !quota_reading_fresh(0, NOW));
    }
}
