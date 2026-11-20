//! The trigger that arms a compaction regardless of the token threshold: tool-result media the
//! provider would refuse, judged at the moment a request is built. (A cold transcript cache is not
//! a trigger: the session's cache owner refuses the attempt at admission, and the loop's cold pass
//! answers that refusal.)

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Role;

use crate::message::AgentMessage;

/// Anthropic refuses a request body over 32 MB however few tokens it holds,
/// and inline media is what gets there. Tool-result media is the part
/// compaction drops, so it alone arms the trigger; attachments the user sent
/// survive compaction and would only make it repeat.
const REQUEST_MEDIA_COMPACT_BYTES: u64 = 24_000_000;
/// Providers also cap the number of images plus native documents one request
/// may carry (100 on Anthropic).
const REQUEST_MEDIA_COMPACT_COUNT: u64 = 100;

/// The wire media one tool result carries, as the attachment store sizes it
/// (a stored attachment by its recorded size, never by reading the blob).
pub trait ToolMediaMeter: Send + Sync {
    /// Base64 bytes of the images and native documents in `content`.
    fn bytes(&self, content: &Content, native_pdf: bool) -> u64;
    /// Images plus native documents in `content`.
    fn count(&self, content: &Content, native_pdf: bool) -> u64;
}

/// Whether tool-result media alone would make the next request too large.
pub fn should_compact_for_request_media(messages: &[AgentMessage], native_pdf: bool, media: &dyn ToolMediaMeter) -> bool {
    let mut bytes = 0;
    let mut count = 0;
    for message in messages.iter().filter(|m| m.role() == Role::Tool) {
        bytes += media.bytes(&message.message.content, native_pdf);
        count += media.count(&message.message.content, native_pdf);
        if bytes >= REQUEST_MEDIA_COMPACT_BYTES || count > REQUEST_MEDIA_COMPACT_COUNT {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(u64, u64);
    impl ToolMediaMeter for Fixed {
        fn bytes(&self, _: &Content, _: bool) -> u64 {
            self.0
        }
        fn count(&self, _: &Content, _: bool) -> u64 {
            self.1
        }
    }

    fn tools(n: usize) -> Vec<AgentMessage> {
        (0..n).map(|i| AgentMessage::tool_text(format!("c{i}"), "x", crate::message::ToolKind::Normal)).collect()
    }

    #[test]
    fn media_arms_on_bytes_or_count() {
        assert!(should_compact_for_request_media(&tools(1), true, &Fixed(24_000_000, 1)));
        assert!(!should_compact_for_request_media(&tools(1), true, &Fixed(23_999_999, 100)));
        assert!(should_compact_for_request_media(&tools(1), true, &Fixed(0, 101)));
        // Bytes accumulate across tool results; user messages never count.
        assert!(should_compact_for_request_media(&tools(3), true, &Fixed(8_000_000, 0)));
        let user = vec![AgentMessage::user("x")];
        assert!(!should_compact_for_request_media(&user, true, &Fixed(u64::MAX / 2, 1000)));
    }
}
