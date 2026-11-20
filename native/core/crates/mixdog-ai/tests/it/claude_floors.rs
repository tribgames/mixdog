//! The Claude capabilities a family gains from a first version on, the generation number of a model id, and the
//! process-wide record of the features a model refused.

use mixdog_ai::claude_floors::ADAPTIVE_FLOOR;
use mixdog_ai::claude_floors::Feature;
use mixdog_ai::claude_floors::MAX_FLOOR;
use mixdog_ai::claude_floors::XHIGH_FLOOR;
use mixdog_ai::claude_floors::claude_generation;
use mixdog_ai::claude_floors::emits_progress_updates;
use mixdog_ai::claude_floors::enabled;
use mixdog_ai::claude_floors::family_version;
use mixdog_ai::claude_floors::mark_unsupported;
use mixdog_ai::claude_floors::model_key;
use mixdog_ai::claude_floors::rejection;
use mixdog_ai::claude_floors::supports_turn_scoped_system_messages;
use mixdog_ai::claude_floors::threads_support_model;
use mixdog_ai::claude_floors::version_at_least;

#[test]
fn a_model_key_is_trimmed_lowercase_dashed_and_without_its_release_date() {
    assert_eq!(model_key("  Claude-Opus-4.8  "), "claude-opus-4-8");
    assert_eq!(model_key("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
    assert_eq!(model_key("claude-haiku-4-5-2025-10-01"), "claude-haiku-4-5");
    assert_eq!(model_key("claude-opus-4-1234567"), "claude-opus-4-1234567", "seven digits are not a date");
    assert_eq!(model_key("claude-opus-4-20251"), "claude-opus-4-20251");
}

#[test]
fn the_family_and_version_are_read_from_claude_family_major_minor_only() {
    assert_eq!(family_version("claude-opus-4-8"), Some(("opus".to_owned(), 4.0, 8.0)));
    assert_eq!(family_version("Claude-Sonnet-5"), Some(("sonnet".to_owned(), 5.0, 0.0)), "no minor is minor zero");
    assert_eq!(family_version("claude-haiku-4-5-20251001"), Some(("haiku".to_owned(), 4.0, 5.0)));
    for other in ["claude-opus-4-100", "claude-3-5-sonnet", "claude-opus", "claude-opus-x", "claude--4", "claude-opus-4-", "gpt-5", "claude-opus-4-5-1", ""] {
        assert_eq!(family_version(other), None, "{other}");
    }
    let (_, major, _) = family_version(&format!("claude-opus-{}", "9".repeat(400))).expect("a very large major still reads");
    assert!(major.is_infinite(), "a major past the double range is infinite, as a JavaScript number reads it");
}

#[test]
fn a_version_is_at_least_a_floor_by_major_then_minor() {
    assert!(version_at_least((4.0, 8.0), (4, 8)));
    assert!(version_at_least((4.0, 9.0), (4, 8)));
    assert!(version_at_least((5.0, 0.0), (4, 8)));
    assert!(!version_at_least((4.0, 7.0), (4, 8)));
    assert!(!version_at_least((3.0, 99.0), (4, 0)));
}

#[test]
fn turn_scoped_system_messages_start_at_each_familys_floor_and_every_later_version_inherits_them() {
    for (id, on) in [
        ("claude-opus-4-7", false),
        ("claude-opus-4-8", true),
        ("claude-opus-5", true),
        ("claude-sonnet-5-4", false),
        ("claude-sonnet-5-5", true),
        ("claude-haiku-5-5-20260101", true),
        ("claude-haiku-4-5", false),
        ("claude-fable-5", true),
        ("claude-mythos-5", true),
        ("claude-zeta-9", false),
        ("gpt-5", false),
    ] {
        assert_eq!(supports_turn_scoped_system_messages(id), on, "{id}");
    }
}

#[test]
fn progress_updates_start_at_five_five_for_opus_and_sonnet_and_earlier_for_the_newer_families() {
    for (id, on) in [
        ("claude-opus-5-4", false),
        ("claude-opus-5-5", true),
        ("claude-sonnet-6", true),
        ("claude-sonnet-5", false),
        ("claude-fable-5", true),
        ("claude-mythos-5", false),
        ("claude-mythos-5-1", true),
        ("claude-haiku-9", false),
    ] {
        assert_eq!(emits_progress_updates(id), on, "{id}");
    }
}

#[test]
fn message_threads_start_at_four_five_and_the_unversioned_mythos_preview_is_named() {
    for (id, on) in [
        ("claude-opus-4-4", false),
        ("claude-opus-4-5", true),
        ("claude-sonnet-4-5-20250929", true),
        ("claude-haiku-4-5", true),
        ("claude-fable-4-9", false),
        ("claude-fable-5", true),
        ("claude-mythos-preview", true),
        ("Claude-Mythos-Preview", true),
        ("claude-mythos-4", false),
        ("claude-3-5-sonnet", false),
    ] {
        assert_eq!(threads_support_model(id), on, "{id}");
    }
}

#[test]
fn a_generation_is_major_times_a_hundred_plus_minor_and_unversioned_claude_ids_are_infinitely_new() {
    for (id, generation) in [
        ("claude-opus-4-7", 407.0),
        ("claude-opus-4-7-20251001", 407.0),
        ("claude-opus-4", 400.0),
        ("claude-opus-4-20250514", 400.0),
        ("claude-sonnet-4-5@20250929", 405.0),
        ("claude-3-5-sonnet-20241022", 305.0),
        ("claude-3-opus", 300.0),
        ("anthropic.claude-opus-4-1-v1:0", 401.0),
        ("CLAUDE-OPUS-4.6", 406.0),
    ] {
        assert_eq!(claude_generation(id), Some(generation), "{id}");
    }
    for unversioned in ["claude-opus-latest", "claude-opus", "claude-"] {
        assert_eq!(claude_generation(unversioned), Some(f64::INFINITY), "{unversioned}");
    }
    assert_eq!(claude_generation("gpt-5.5"), None);
    assert_eq!(claude_generation(""), None);
}

#[test]
fn the_effort_floors_are_ordered_max_then_adaptive_then_xhigh() {
    assert!(MAX_FLOOR < ADAPTIVE_FLOOR && ADAPTIVE_FLOOR < XHIGH_FLOOR);
    assert!(claude_generation("claude-opus-4-6").unwrap() >= ADAPTIVE_FLOOR);
    assert!(claude_generation("claude-opus-4-5").unwrap() < ADAPTIVE_FLOOR);
    assert!(claude_generation("claude-opus-4-7").unwrap() >= XHIGH_FLOOR);
}

#[test]
fn only_a_400_naming_the_field_or_beta_is_a_floor_feature_rejection() {
    assert_eq!(rejection(Some(400), "messages.1.clear_at: Extra inputs are not permitted"), Some(Feature::TurnScopedSystem));
    assert_eq!(rejection(Some(400), "Unknown beta: turn-scoped-system"), Some(Feature::TurnScopedSystem));
    assert_eq!(rejection(Some(400), "CLEAR-AT is not accepted"), Some(Feature::TurnScopedSystem), "matching ignores case");
    assert_eq!(rejection(Some(400), "thinking.adaptive.display: Extra inputs are not permitted"), Some(Feature::ProgressUpdates));
    assert_eq!(rejection(Some(400), "thinking.display: Extra inputs are not permitted"), Some(Feature::ProgressUpdates));
    assert_eq!(rejection(Some(400), "unknown beta header thinking-display-updates"), Some(Feature::ProgressUpdates));
    assert_eq!(rejection(Some(400), "clear_at and thinking.display both"), Some(Feature::ProgressUpdates), "the progress field is named first");
    assert_eq!(
        rejection(Some(400), "messages.1.clear_at: a turn-scoped message supports text blocks only"),
        None,
        "a rule about the content is the model taking the message"
    );
    assert_eq!(rejection(Some(400), "not permitted on a turn-scoped message: clear_at"), None);
    assert_eq!(rejection(Some(400), "max_tokens: too large"), None);
    assert_eq!(rejection(Some(400), "thinkingxdisplay"), None);
    for status in [None, Some(200), Some(401), Some(429), Some(500)] {
        assert_eq!(rejection(status, "messages.1.clear_at: Extra inputs are not permitted"), None, "{status:?}");
    }
}

#[test]
fn a_refused_feature_is_off_for_that_model_on_that_provider_whatever_the_dating_of_its_id() {
    let model = "claude-sonnet-9-1-20991231";
    assert!(enabled(Feature::TurnScopedSystem, "anthropic", model));
    mark_unsupported(Feature::TurnScopedSystem, "anthropic", model);
    assert!(!enabled(Feature::TurnScopedSystem, "anthropic", "claude-sonnet-9-1"), "the key is the undated, lowercase id");
    assert!(!enabled(Feature::TurnScopedSystem, "anthropic", " Claude-Sonnet-9.1 "));
    assert!(enabled(Feature::ProgressUpdates, "anthropic", model), "another feature is unaffected");
    assert!(enabled(Feature::TurnScopedSystem, "anthropic-oauth", model), "another provider is unaffected");
    assert!(enabled(Feature::TurnScopedSystem, "anthropic", "claude-sonnet-9-2"), "another model is unaffected");
}
