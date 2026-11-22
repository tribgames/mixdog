//! Tool call ids on a wire that has no id rule of its own (Gemini, Cursor, Devin). A session gives a call whose
//! provider repeated an id a distinct one (`mixdog_protocol::tool_call_ids::distinct_id`); the provider is still sent
//! the id it gave. The wires with an id rule do the same in `tool_call_ids::wire_id_map`.

use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::HashSet;

use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::tool_call_ids::provider_id;

/// `messages` with every call made distinct, and its result, under its provider's id again when no other call of
/// the request has that id; the same messages when no call was made distinct.
pub fn own_call_ids(messages: &[Message]) -> Cow<'_, [Message]> {
    let ids = || messages.iter().filter(|m| m.role == Role::Assistant).flat_map(|m| m.tool_calls.iter().map(|call| call.id.as_str()));
    if ids().all(|id| provider_id(id) == id) {
        return Cow::Borrowed(messages);
    }
    // An id that is its provider's as it came holds that id; the others take theirs in message order while it is free.
    let mut taken: HashSet<String> = ids().filter(|id| provider_id(id) == *id).map(str::to_owned).collect();
    let mut own: HashMap<&str, String> = HashMap::new();
    for id in ids() {
        let provider = provider_id(id);
        if provider != id && !own.contains_key(id) && taken.insert(provider.to_string()) {
            own.insert(id, provider.into_owned());
        }
    }
    Cow::Owned(
        messages
            .iter()
            .map(|message| {
                let mut message = message.clone();
                for call in &mut message.tool_calls {
                    if let Some(provider) = own.get(call.id.as_str()) {
                        call.id = provider.clone();
                    }
                }
                if let Some(provider) = message.tool_call_id.as_deref().and_then(|id| own.get(id)) {
                    message.tool_call_id = Some(provider.clone());
                }
                message
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::ToolCall;
    use serde_json::json;

    use super::*;

    fn turn(id: &str) -> [Message; 2] {
        let mut call = Message::new(Role::Assistant, Content::Text(String::new()));
        call.tool_calls = vec![ToolCall { id: id.to_owned(), name: "read".to_owned(), arguments: json!({}), native_type: None }];
        let mut result = Message::new(Role::Tool, Content::Text("done".into()));
        result.tool_call_id = Some(id.to_owned());
        [call, result]
    }

    /// A call made distinct goes out, with its result, under the id its provider gave while no other call of the
    /// request has that id; beside one that has, it keeps the distinct id, so the request pairs every result.
    #[test]
    fn a_call_made_distinct_and_its_result_go_out_under_the_providers_id() {
        let alone = turn("gemini_ab~2");
        let sent = own_call_ids(&alone);
        assert_eq!((sent[0].tool_calls[0].id.as_str(), sent[1].tool_call_id.as_deref()), ("gemini_ab", Some("gemini_ab")));
        let beside: Vec<Message> = turn("gemini_ab").into_iter().chain(turn("gemini_ab~2")).chain(turn("gemini_ab~3")).collect();
        let sent = own_call_ids(&beside);
        let ids: Vec<&str> = sent.iter().filter_map(|m| m.tool_call_id.as_deref()).collect();
        assert_eq!(ids, ["gemini_ab", "gemini_ab~2", "gemini_ab~3"]);
        let plain = turn("gemini_ab");
        assert!(matches!(own_call_ids(&plain), Cow::Borrowed(_)));
    }

    /// A server that issues an id shaped like one a session makes (`c~1`) gets that id back, beside its own `c` and a
    /// later call it named `c~1` again: three calls, three ids on the wire, none collapsed into another.
    #[test]
    fn a_servers_own_id_that_holds_the_mark_goes_back_as_the_server_gave_it() {
        use mixdog_protocol::tool_call_ids::distinct_id;
        let stored = [distinct_id("c", 0, 1), distinct_id("c~1", 0, 1), distinct_id("c~1", 2, 1)];
        let transcript: Vec<Message> = stored.iter().flat_map(|id| turn(id)).collect();
        let sent = own_call_ids(&transcript);
        let ids: Vec<&str> = sent.iter().filter_map(|m| m.tool_call_id.as_deref()).collect();
        assert_eq!(ids, ["c", "c~1", stored[2].as_str()], "the third keeps its session id: the server's `c~1` is taken");
        let calls: Vec<&str> = sent.iter().flat_map(|m| m.tool_calls.iter().map(|call| call.id.as_str())).collect();
        assert_eq!(calls, ids, "each result goes with its call");
        let alone = turn(&stored[2]);
        assert_eq!(own_call_ids(&alone)[1].tool_call_id.as_deref(), Some("c~1"), "alone, it goes back as the server gave it");
    }
}
