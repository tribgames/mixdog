//! Server-sent-event framing for the OpenAI-compatible wires: lines split at
//! `\n` (a trailing `\r` is dropped), comment lines reported as keepalives,
//! `data:` lines joined with `\n` and dispatched at the blank line. Bytes are
//! buffered until a line is whole, so a chunk may end anywhere, including
//! inside a multi-byte character.

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum SseItem {
    Event { event: Option<String>, data: String },
    /// A `:` comment line: informational only, never progress.
    Comment,
}

#[derive(Default, Debug)]
pub struct SseDecoder {
    line: Vec<u8>,
    event: Option<String>,
    data: String,
    has_data: bool,
}

impl SseDecoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<SseItem> {
        let mut out = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                self.take_line(&mut out);
            } else {
                self.line.push(byte);
            }
        }
        out
    }

    /// Whether a partial line or an undispatched event is buffered: the body
    /// ended inside an event.
    pub fn has_pending(&self) -> bool {
        !self.line.is_empty() || self.has_data || self.event.is_some()
    }

    fn take_line(&mut self, out: &mut Vec<SseItem>) {
        let mut line = std::mem::take(&mut self.line);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if line.is_empty() {
            if self.has_data || self.event.is_some() {
                out.push(SseItem::Event {
                    event: self.event.take(),
                    data: std::mem::take(&mut self.data),
                });
                self.has_data = false;
            }
            return;
        }
        if line[0] == b':' {
            out.push(SseItem::Comment);
            return;
        }
        let text = String::from_utf8_lossy(&line);
        let (field, value) = match text.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (text.as_ref(), ""),
        };
        match field {
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            "event" => self.event = Some(value.to_owned()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(items: &[SseItem]) -> Vec<&str> {
        items
            .iter()
            .filter_map(|item| match item {
                SseItem::Event { data, .. } => Some(data.as_str()),
                SseItem::Comment => None,
            })
            .collect()
    }

    #[test]
    fn splits_events_across_arbitrary_chunks() {
        let body = "data: {\"a\":1}\r\n\r\n: ping\n\ndata: [DONE]\n\n".as_bytes();
        for cut in 0..body.len() {
            let mut decoder = SseDecoder::default();
            let mut items = decoder.feed(&body[..cut]);
            items.extend(decoder.feed(&body[cut..]));
            assert_eq!(data(&items), ["{\"a\":1}", "[DONE]"], "cut at {cut}");
            assert!(items.contains(&SseItem::Comment));
            assert!(!decoder.has_pending());
        }
    }

    #[test]
    fn joins_multiline_data_and_reports_a_pending_event() {
        let mut decoder = SseDecoder::default();
        let items = decoder.feed(b"event: x\ndata: a\ndata: b\n\ndata: c");
        assert_eq!(
            items,
            [SseItem::Event {
                event: Some("x".into()),
                data: "a\nb".into()
            }]
        );
        assert!(decoder.has_pending());
    }

    #[test]
    fn multibyte_character_split_between_chunks() {
        let mut decoder = SseDecoder::default();
        let bytes = "data: 한\n\n".as_bytes();
        let mut items = decoder.feed(&bytes[..7]);
        items.extend(decoder.feed(&bytes[7..]));
        assert_eq!(data(&items), ["한"]);
    }
}
