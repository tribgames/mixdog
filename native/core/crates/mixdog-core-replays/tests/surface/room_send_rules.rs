//! `room/send`: a user's message into a room log is read and checked before anything happens. Each malformed field is
//! refused with its own message and nothing else; what passes goes on as the checks return it (an image's type lower-cased, a
//! file's type canonical, a file name cut at 160 UTF-16 units).

use mixdog_core_rooms::rooms::RoomError;
use mixdog_core_rooms::rooms::user_send::UserMessage;
use serde_json::Value;
use serde_json::json;

const ROOM_LOG: &str = "sess_room_abc123";

fn refused(input: Value) -> String {
    match UserMessage::of(&input) {
        Err(RoomError::Refused(message)) => message,
        other => panic!("{input} should be refused, got {other:?}"),
    }
}

fn read(input: Value) -> UserMessage {
    UserMessage::of(&input).unwrap_or_else(|error| panic!("{input} should be accepted: {error:?}"))
}

#[test]
fn a_text_message_is_read_with_its_submission_id_and_side_tables() {
    let message = read(json!({
        "threadId": format!(" {ROOM_LOG} "),
        "prompt": "hello @worker",
        "options": { "clientSubmissionId": "sub-1", "pastedTexts": { "t1": "pasted" }, "kickoff": true, "priority": "next" },
    }));
    assert_eq!(message.session_id, ROOM_LOG, "the id is trimmed");
    assert_eq!(message.prompt, json!("hello @worker"));
    assert_eq!(message.submission_id, "sub-1");
    assert_eq!(message.pasted_texts, Some(json!({ "t1": "pasted" })));
    assert_eq!(message.pasted_images, None);

    let bare = read(json!({ "threadId": ROOM_LOG, "prompt": "hi" }));
    assert_eq!((bare.submission_id.as_str(), bare.pasted_images, bare.pasted_texts), ("", None, None), "no options: no submission id");
}

#[test]
fn every_malformed_argument_is_refused_with_its_own_message() {
    let ok = |overrides: Value| {
        let mut input = json!({ "threadId": ROOM_LOG, "prompt": "hi", "options": {} });
        for (key, value) in overrides.as_object().unwrap() {
            input[key] = value.clone();
        }
        input
    };
    let options = |options: Value| ok(json!({ "options": options }));
    let prompt = |prompt: Value| ok(json!({ "prompt": prompt }));
    let cases = [
        (json!("not an object"), "room/send input is invalid."),
        (ok(json!({ "roomId": "abc123" })), "room/send input contains an unsupported field."),
        (ok(json!({ "threadId": 7 })), "session id must be a string."),
        (ok(json!({ "threadId": "" })), "session id is invalid."),
        (ok(json!({ "threadId": "sess room" })), "session id is invalid."),
        (ok(json!({ "threadId": "s".repeat(257) })), "session id is invalid."),
        (prompt(json!("   ")), "prompt is invalid."),
        (prompt(json!("x".repeat(1_000_001))), "prompt is invalid."),
        (prompt(json!(5)), "prompt content is invalid."),
        (prompt(json!([])), "prompt content is invalid."),
        (prompt(json!([1])), "prompt part is invalid."),
        (prompt(json!([{ "type": "audio" }])), "prompt part type is unsupported."),
        (prompt(json!([{ "type": "text", "text": 1 }])), "prompt text part is invalid."),
        (prompt(json!([{ "type": "text", "text": "  " }])), "prompt is empty."),
        (prompt(json!([{ "type": "image", "mimeType": "image/bmp", "data": "AAAA" }])), "image type is unsupported."),
        (prompt(json!([{ "type": "image", "mimeType": "image/png", "data": "" }])), "image data is invalid."),
        (prompt(json!([{ "type": "image", "mimeType": "image/png", "data": "not base64!" }])), "image data is invalid."),
        (options(json!("x")), "submit options are invalid."),
        (options(json!({ "target": "x" })), "submit options contains an unsupported field."),
        (options(json!({ "clientSubmissionId": "" })), "submit id is invalid."),
        (options(json!({ "clientSubmissionId": "a\nb" })), "submit id is invalid."),
        (options(json!({ "submittedAt": 0 })), "submit timestamp is invalid."),
        (options(json!({ "submittedAt": 1.5 })), "submit timestamp is invalid."),
        (options(json!({ "retryFailedTurn": "yes" })), "submit retryFailedTurn is invalid."),
        (options(json!({ "kickoff": 1 })), "submit kickoff is invalid."),
        (options(json!({ "priority": "soon" })), "submit priority is invalid."),
        (options(json!({ "displayText": 3 })), "submit display text is invalid."),
        (options(json!({ "goalCommand": "  " })), "goal command is invalid."),
        (options(json!({ "pastedTexts": { "__proto__": "x" } })), "structured input contains an invalid field."),
    ];
    for (input, message) in cases {
        assert_eq!(refused(input.clone()), message, "{input}");
    }
}

#[test]
fn the_limits_on_parts_and_files_are_counted() {
    let image = json!({ "type": "image", "mimeType": "image/png", "data": "AAAA" });
    assert_eq!(refused(json!({ "threadId": ROOM_LOG, "prompt": vec![image.clone(); 9] })), "too many prompt images.");
    assert!(UserMessage::of(&json!({ "threadId": ROOM_LOG, "prompt": vec![image.clone(); 8] })).is_ok());
    assert_eq!(refused(json!({ "threadId": ROOM_LOG, "prompt": vec![image; 33] })), "prompt content is invalid.", "at most 32 parts");
    let text = json!({ "type": "text", "text": "x".repeat(600_000) });
    assert_eq!(refused(json!({ "threadId": ROOM_LOG, "prompt": [text.clone(), text] })), "prompt text is too large.");
}

#[test]
fn an_accepted_prompt_goes_on_as_the_checks_return_it() {
    let long_name = "n".repeat(200);
    let message = read(json!({
        "threadId": ROOM_LOG,
        "prompt": [
            { "type": "text", "text": "look" },
            { "type": "image", "mimeType": "IMAGE/PNG", "data": "AAAA", "path": "/etc/passwd" },
            { "type": "file", "mimeType": "Application/PDF; charset=x", "data": "BBBB", "filename": long_name },
        ],
    }));
    let parts = message.prompt.as_array().expect("parts");
    assert_eq!(parts[0], json!({ "type": "text", "text": "look" }));
    assert_eq!(parts[1], json!({ "type": "image", "data": "AAAA", "mimeType": "image/png" }), "the type lower-cased, no path carried");
    // Only a PDF or an office document is a file part; its type is returned in canonical case, parameters dropped
    // (`canonical_prompt_file_mime`, `mixdog-app-protocol/src/boundary/validate/prompt.rs:291`).
    assert_eq!(parts[2]["mimeType"], json!("application/pdf"));
    assert_eq!(parts[2]["filename"], json!("n".repeat(160)));
}

#[test]
fn a_lone_surrogate_is_free_text_in_a_prompt_but_never_in_an_id() {
    // `JSON.parse` of the wire text keeps the unit; a Rust string cannot, so the wire parser stands in for it.
    let wire = |text: &str| mixdog_js::json_parse(text).expect("a wire value");
    let accepted = wire(r#"{"threadId":"sess_room_abc123","prompt":"a\ud800b","options":{"clientSubmissionId":"s\ud800"}}"#);
    assert!(UserMessage::of(&accepted).is_ok());
    let refused = wire(r#"{"threadId":"sess_room_abc\ud800","prompt":"a"}"#);
    assert_eq!(UserMessage::of(&refused), Err(RoomError::Refused("session id is invalid.".into())));
}
