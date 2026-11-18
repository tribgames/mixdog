use std::sync::Arc;

use crate::*;

fn origin(role: Role, ordinal: u32) -> Origin {
    Origin {
        session: "s".into(),
        branch: "b".into(),
        message_id: "m1".into(),
        role,
        tool_call_id: (role == Role::Tool).then(|| "call".to_string()),
        part_path: vec![0, ordinal],
        display_name: "scan.heic".into(),
        turn: 8,
        tool_label: (role == Role::Tool).then(|| "Read file".to_string()),
    }
}

fn route(model: &str) -> RouteKey {
    RouteKey {
        endpoint: "e".into(),
        account: "a".into(),
        model: model.into(),
        wire_branch: "chat".into(),
        operation: "send".into(),
        capability_revision: 1,
    }
}

fn facts(kind: ImageKind, frames: u32, png: bool) -> ImageFacts {
    ImageFacts::for_test(kind, 100, 80, frames, 4, png.then_some((100, 80, 2)))
}

fn plan(column: Column) -> Plan {
    Plan::new(route("m"), InputImagePolicy::for_column(column))
}

fn choice(column: Column, f: &ImageFacts) -> Result<Choice, Reason> {
    decide_local(&origin(Role::User, 0), f, &InputImagePolicy::for_column(column)).map_err(|r| r.reason)
}

const VISION: [Column; 5] = [Column::Gemini, Column::Messages, Column::Responses, Column::Chat, Column::Inline];

#[test]
fn inline_png_is_accepted_by_every_vision_column_and_refused_by_none() {
    for column in VISION {
        assert_eq!(choice(column, &facts(ImageKind::Png, 1, false)), Ok(Choice::Original), "{column:?}");
    }
    assert_eq!(choice(Column::None, &facts(ImageKind::Png, 1, false)), Err(Reason::NoVision));
    let unknown = InputImagePolicy::unknown();
    assert!(decide_local(&origin(Role::User, 0), &facts(ImageKind::Png, 1, false), &unknown).is_err());
}

#[test]
fn avif_tiff_svg_convert_to_png_when_a_rendition_exists_else_refuse() {
    for kind in [ImageKind::Avif, ImageKind::Tiff, ImageKind::Svg] {
        for column in VISION {
            assert_eq!(choice(column, &facts(kind, 1, true)), Ok(Choice::Rendition), "{kind:?} {column:?}");
            assert_eq!(choice(column, &facts(kind, 1, false)), Err(Reason::UnsupportedKind(kind)));
        }
    }
}

#[test]
fn a_gif_goes_as_it_is_wherever_the_destination_takes_gif_and_an_animation_is_never_flattened() {
    // A still GIF, rendition at hand: sent as itself where GIF is taken, converted only where it is not.
    for (column, want) in [
        (Column::Chat, Choice::Original),
        (Column::Messages, Choice::Original),
        (Column::Responses, Choice::Original),
        (Column::Gemini, Choice::Rendition),
        (Column::Inline, Choice::Rendition),
    ] {
        assert_eq!(choice(column, &facts(ImageKind::Gif, 1, true)), Ok(want), "{column:?}");
    }
    // Animated: as it is where the destination takes the whole file, refused where it takes only a still or no GIF at all.
    assert_eq!(choice(Column::Chat, &facts(ImageKind::Gif, 3, false)), Ok(Choice::Original));
    assert_eq!(choice(Column::Messages, &facts(ImageKind::Gif, 3, false)), Ok(Choice::Original));
    assert_eq!(choice(Column::Responses, &facts(ImageKind::Gif, 3, true)), Err(Reason::Animated(ImageKind::Gif)));
    assert_eq!(choice(Column::Gemini, &facts(ImageKind::Gif, 3, true)), Err(Reason::Animated(ImageKind::Gif)));
    assert_eq!(choice(Column::Responses, &facts(ImageKind::Webp, 2, false)), Ok(Choice::Original), "only GIF is still-only there");
    assert_eq!(choice(Column::Chat, &facts(ImageKind::Tiff, 2, true)), Err(Reason::Animated(ImageKind::Tiff)));
}

#[test]
fn a_heic_goes_to_gemini_as_itself_and_everywhere_else_as_its_jpeg_rendition() {
    let heic = ImageFacts::for_test_with(ImageKind::Heic, 100, 80, 1, 4, Some((ImageKind::Jpeg, 100, 80, 2)));
    assert_eq!(choice(Column::Gemini, &heic), Ok(Choice::Original));
    for column in [Column::Messages, Column::Responses, Column::Chat, Column::Inline] {
        assert_eq!(choice(column, &heic), Ok(Choice::Rendition), "{column:?}");
    }
    assert_eq!(choice(Column::None, &heic), Err(Reason::NoVision));
}

#[test]
fn only_a_limit_the_destination_declares_refuses_and_a_fitting_rendition_stands_in() {
    let mut photo = facts(ImageKind::Jpeg, 1, true);
    photo.width = 20_000;
    // No declared edge limit: the original goes as it is.
    for column in [Column::Chat, Column::Responses, Column::Gemini] {
        assert_eq!(choice(column, &photo), Ok(Choice::Original), "{column:?}");
    }
    assert_eq!(choice(Column::Messages, &photo), Ok(Choice::Rendition));
    photo.rendition = None;
    assert_eq!(choice(Column::Messages, &photo), Err(Reason::TooLarge));
    // Anthropic measures base64: 5 MiB of it is 3 932 160 bytes.
    let at = |len: u64| ImageFacts::for_test(ImageKind::Png, 100, 80, 1, len, None);
    assert_eq!(choice(Column::Messages, &at(3_932_160)), Ok(Choice::Original));
    assert_eq!(choice(Column::Messages, &at(3_932_161)), Err(Reason::TooLarge));
    assert_eq!(choice(Column::Chat, &at(3_932_161)), Ok(Choice::Original));
    // The tightest declared limits are what an import's rendition is made within.
    assert_eq!(crate::policy::tightest_limits(), (2000, 5 * 1024 * 1024));
}

#[test]
fn a_new_start_is_offered_only_when_it_leaves_every_blocker_out() {
    let early = Refusal::new(Origin { part_path: vec![1, 0], ..origin(Role::Tool, 0) }, Reason::NoVision);
    let late = Refusal::new(Origin { part_path: vec![4, 1], ..origin(Role::User, 1) }, Reason::NoVision);
    let mut not_sent = NotSent::new(vec![early.clone()]);
    not_sent.offer_new_context(4);
    assert!(not_sent.new_context_offered);
    let mut not_sent = NotSent::new(vec![early, late]);
    not_sent.offer_new_context(4);
    assert!(!not_sent.new_context_offered, "an image in the message it would start from stays refused");
}

#[test]
fn an_image_in_a_messages_recorded_form_can_only_be_left_out() {
    let recorded = Refusal::new(Origin { part_path: vec![2, crate::origin::RECORDED_FORM, 0], ..origin(Role::Assistant, 0) }, Reason::NoVision);
    assert_eq!(recorded.actions, vec![RecoveryAction::ContinueWithout]);
    assert!(!recorded.message().contains("Replace"), "{}", recorded.message());
    assert_eq!(Refusal::new(origin(Role::User, 0), Reason::NoVision).actions, vec![RecoveryAction::ReplaceImage, RecoveryAction::ContinueWithout]);
}

#[test]
fn bmp_and_ico_are_never_model_input() {
    for kind in [ImageKind::Bmp, ImageKind::Ico] {
        assert_eq!(choice(Column::Gemini, &facts(kind, 1, true)), Err(Reason::UnsupportedKind(kind)));
    }
}

#[test]
fn links_and_file_ids_follow_the_matrix() {
    let o = origin(Role::User, 0);
    let p = |column| InputImagePolicy::for_column(column);
    // Mutable link refused even where links are carried; trusted link accepted there; refused on inline-only.
    assert_eq!(decide_pointer(&o, SourceForm::Link, &p(Column::Chat), false, None).map_err(|r| r.reason), Err(Reason::MutableLink));
    assert_eq!(decide_pointer(&o, SourceForm::Link, &p(Column::Chat), true, None).map_err(|r| r.reason), Ok(Pointer::Native));
    assert_eq!(
        decide_pointer(&o, SourceForm::Link, &p(Column::Inline), true, None).map_err(|r| r.reason),
        Err(Reason::SourceFormNotCarried)
    );
    // File ids: only Messages and Responses carry them.
    for (column, ok) in [(Column::Messages, true), (Column::Responses, true), (Column::Gemini, false), (Column::Chat, false), (Column::Inline, false)] {
        assert_eq!(decide_pointer(&o, SourceForm::FileId, &p(column), true, None).is_ok(), ok, "{column:?}");
    }
    // An owned local original replaces an ineligible pointer.
    let local = facts(ImageKind::Png, 1, false);
    assert_eq!(decide_pointer(&o, SourceForm::FileId, &p(Column::Chat), true, Some(&local)).map_err(|r| r.reason), Ok(Pointer::UseLocal));
}

#[test]
fn every_role_is_checked_not_only_the_user() {
    let mut policy = InputImagePolicy::for_column(Column::Chat);
    policy.roles = vec![Role::User];
    let f = facts(ImageKind::Png, 1, false);
    assert!(decide_local(&origin(Role::User, 0), &f, &policy).is_ok());
    for role in [Role::Assistant, Role::Tool] {
        assert_eq!(decide_local(&origin(role, 0), &f, &policy).map_err(|r| r.reason), Err(Reason::RoleNotAccepted));
    }
}

#[test]
fn batch_accounts_for_every_occurrence_once_and_keeps_order() {
    let plan = plan(Column::Chat);
    let f = facts(ImageKind::Png, 1, false);
    let (a, b) = (origin(Role::Tool, 0), origin(Role::Tool, 1));
    let bytes: Arc<[u8]> = Arc::from(&[1u8, 2, 3, 4][..]);
    let mut batch = plan.batch(vec![a.clone(), b.clone()]);
    batch.accept(plan.prepare_local(&b, &f, bytes.clone(), None).unwrap());
    // Second tool image is missing: the whole batch is NotSent, nothing silently dropped.
    let not_sent = batch.seal().unwrap_err();
    assert_eq!(not_sent.blockers.len(), 1);
    assert_eq!(not_sent.blockers[0].origin, a);

    let mut batch = plan.batch(vec![a.clone(), b.clone()]);
    batch.accept(plan.prepare_local(&b, &f, bytes.clone(), None).unwrap());
    batch.accept(plan.prepare_local(&a, &f, bytes.clone(), None).unwrap());
    let sealed = batch.seal().unwrap();
    assert_eq!(sealed.images().iter().map(|i| i.origin().clone()).collect::<Vec<_>>(), vec![a, b]);
    assert!(sealed.matches(&plan));
}

#[test]
fn duplicate_answer_and_foreign_plan_block_the_batch() {
    let one = plan(Column::Chat);
    let other = Plan::new(route("other"), InputImagePolicy::for_column(Column::Chat));
    let f = facts(ImageKind::Png, 1, false);
    let a = origin(Role::User, 0);
    let bytes: Arc<[u8]> = Arc::from(&[1u8, 2, 3, 4][..]);
    let mut batch = one.batch(vec![a.clone()]);
    batch.accept(other.prepare_local(&a, &f, bytes.clone(), None).unwrap());
    assert!(batch.seal().is_err());
    let sealed = {
        let mut batch = one.batch(vec![a.clone()]);
        batch.accept(one.prepare_local(&a, &f, bytes, None).unwrap());
        batch.seal().unwrap()
    };
    assert!(!sealed.matches(&other));
}

#[test]
fn stored_length_disagreeing_with_facts_is_corrupt() {
    let plan = plan(Column::Chat);
    let f = facts(ImageKind::Png, 1, false);
    let wrong: Arc<[u8]> = Arc::from(&[1u8][..]);
    let err = plan.prepare_local(&origin(Role::User, 0), &f, wrong, None).unwrap_err();
    assert_eq!(err.reason, Reason::Corrupt);
}

#[test]
fn over_count_is_refused_not_truncated() {
    let mut policy = InputImagePolicy::for_column(Column::Chat);
    policy.limits.max_images = Some(1);
    let plan = Plan::new(route("m"), policy);
    let f = facts(ImageKind::Png, 1, false);
    let bytes: Arc<[u8]> = Arc::from(&[1u8, 2, 3, 4][..]);
    let (a, b) = (origin(Role::User, 0), origin(Role::User, 1));
    let mut batch = plan.batch(vec![a.clone(), b.clone()]);
    batch.accept(plan.prepare_local(&a, &f, bytes.clone(), None).unwrap());
    batch.accept(plan.prepare_local(&b, &f, bytes, None).unwrap());
    let not_sent = batch.seal().unwrap_err();
    assert_eq!(not_sent.blockers[0].reason, Reason::OverCount { limit: 1 });
}

#[test]
fn refusal_message_names_image_and_actions_without_compact() {
    let refusal = Refusal::new(origin(Role::Tool, 0), Reason::UnsupportedKind(ImageKind::Heic));
    let text = refusal.message();
    assert!(text.contains("`scan.heic` in tool result 'Read file', turn 8"), "{text}");
    assert!(text.contains("HEIC") && text.contains("continue without it"), "{text}");
    assert!(!text.contains("compact"));
    let link = Refusal::new(origin(Role::User, 0), Reason::MutableLink).message();
    assert!(link.contains("Replace the link with an image file"), "{link}");
    let all = NotSent::new(vec![refusal]).message();
    assert!(all.starts_with("Nothing was sent."));
}

#[test]
fn an_inline_only_destination_takes_images_of_the_user_and_of_tool_results_never_of_an_assistant_turn() {
    for (role, ok) in [(Role::User, true), (Role::Tool, true), (Role::Assistant, false), (Role::System, false)] {
        let result = decide_local(&origin(role, 0), &facts(ImageKind::Png, 1, false), &InputImagePolicy::for_column(Column::Inline)).map_err(|r| r.reason);
        assert_eq!(result.is_ok(), ok, "{role:?}");
        if !ok {
            assert_eq!(result, Err(Reason::RoleNotAccepted));
        }
    }
    // Every other vision column takes all three message roles.
    for column in [Column::Gemini, Column::Messages, Column::Responses, Column::Chat] {
        for role in [Role::User, Role::Assistant, Role::Tool] {
            assert!(decide_local(&origin(role, 0), &facts(ImageKind::Png, 1, false), &InputImagePolicy::for_column(column)).is_ok(), "{column:?} {role:?}");
        }
    }
}

#[test]
fn an_occurrence_is_the_same_whatever_name_it_is_shown_under() {
    let mut named = origin(Role::User, 0);
    let bare = Origin { display_name: String::new(), turn: 1, tool_label: None, ..named.clone() };
    assert_eq!(named, bare, "display fields are not identity");
    named.part_path = vec![0, 1];
    assert_ne!(named, bare, "a second image of the same message is another occurrence");
    let batch_plan = plan(Column::Chat);
    let mut builder = batch_plan.batch(vec![bare.clone()]);
    builder.accept(batch_plan.prepare_local(&named_like(&bare), &facts(ImageKind::Png, 1, false), Arc::from(&[1u8, 2, 3, 4][..]), None).unwrap());
    assert!(builder.seal().is_ok(), "an image prepared under its stored name fills the occurrence the request holds unnamed");
}

fn named_like(origin: &Origin) -> Origin {
    Origin { display_name: "scan.png".into(), ..origin.clone() }
}
