use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::StreamEvent;

/// Model output: a text, reasoning or tool delta, or the progress a decoder reports for one.
pub(crate) fn output(event: &StreamEvent) -> bool {
    matches!(
        event,
        StreamEvent::TextDelta(_)
            | StreamEvent::ReasoningDelta(_)
            | StreamEvent::ProgressDelta(_)
            | StreamEvent::ToolCallStart { .. }
            | StreamEvent::ToolCallArgsDelta { .. }
            | StreamEvent::ToolCallDone(_)
            | StreamEvent::Progress(ProgressKind::Text | ProgressKind::Reasoning | ProgressKind::Tool)
    )
}

/// An item boundary: progress only after output.
pub(crate) fn boundary(event: &StreamEvent) -> bool {
    matches!(event, StreamEvent::ItemStart { .. } | StreamEvent::Progress(ProgressKind::Semantic))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use crate::providers::google::cache::policy;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
    }

    #[test]
    fn one_reader_turns_the_watchdog_off_for_every_family() {
        for off in ["0", "false", "no", "off"] {
            let get = move |name: &str| (name == "MIXDOG_ENABLE_STREAM_WATCHDOG").then(|| off.to_owned());
            assert!(!policy::stream_watchdog_enabled(&get), "{off}");
            assert_eq!(policy::semantic_idle_ms(get), None, "compat and the OpenAI HTTP stream: {off}");
            assert_eq!(policy::sse_idle_ms(get), None, "Anthropic: {off}");
            assert_eq!(policy::ws_semantic_idle_ms(get), None, "the OpenAI WebSocket: {off}");
        }
        for on in [None, Some(""), Some("1"), Some("true"), Some("yes")] {
            let get = move |name: &str| (name == "MIXDOG_ENABLE_STREAM_WATCHDOG").then(|| on.map(str::to_owned)).flatten();
            assert!(policy::stream_watchdog_enabled(&get), "{on:?}");
            assert_eq!(policy::semantic_idle_ms(get), Some(300_000.0), "{on:?}");
            assert_eq!(policy::sse_idle_ms(get), Some(120_000.0), "{on:?}");
            assert_eq!(policy::ws_semantic_idle_ms(get), Some(300_000.0), "{on:?}");
        }
    }

    #[test]
    fn the_windows_read_their_node_variables() {
        let get = env(&[("MIXDOG_PROVIDER_SSE_IDLE_TIMEOUT_MS", "45000"), ("MIXDOG_PROVIDER_WS_OUTPUT_IDLE_TIMEOUT_MS", "20000")]);
        assert_eq!(policy::sse_idle_ms(&get), Some(45_000.0));
        assert_eq!(policy::semantic_idle_ms(&get), Some(45_000.0), "the semantic window falls back to the SSE variable");
        assert_eq!(policy::ws_semantic_idle_ms(&get), Some(20_000.0));
    }

    #[test]
    fn the_ping_variables_move_the_websocket_schedule_and_nothing_else() {
        let base = mixdog_core_api::domain::keepalive::KeepaliveSchedule::SPEC.ws;
        assert_eq!(policy::ws_ping(|_| None, base), base);
        let tuned = policy::ws_ping(env(&[("MIXDOG_PROVIDER_WS_PING_INTERVAL_MS", "12000"), ("MIXDOG_PROVIDER_WS_PONG_TIMEOUT_MS", "3000")]), base);
        assert_eq!((tuned.interval, tuned.timeout, tuned.while_idle), (Duration::from_secs(12), Duration::from_secs(3), base.while_idle));
        let floor = policy::ws_ping(env(&[("MIXDOG_PROVIDER_WS_PING_INTERVAL_MS", "10"), ("MIXDOG_PROVIDER_WS_PONG_TIMEOUT_MS", "999999")]), base);
        assert_eq!((floor.interval, floor.timeout), (Duration::from_secs(5), Duration::from_secs(60)));
    }
}

/// What the stream tests script: a body that delivers chunks on a timetable and then stays silent.
#[cfg(test)]
pub(crate) mod testing {
    use std::collections::VecDeque;
    use std::time::Duration;

    use async_trait::async_trait;
    use bytes::Bytes;
    use mixdog_core_api::domain::provider::TransportFault;

    use crate::transport::link::BodyStream;

    /// `(wait, chunk)` in order, then no more bytes and no end.
    pub(crate) struct Timetable(VecDeque<(Duration, &'static str)>);

    impl Timetable {
        pub(crate) fn of(items: &[(u64, &'static str)]) -> Box<Self> {
            Box::new(Self(items.iter().map(|(secs, chunk)| (Duration::from_secs(*secs), *chunk)).collect()))
        }
    }

    #[async_trait]
    impl BodyStream for Timetable {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            match self.0.front().copied() {
                Some((wait, chunk)) => {
                    mixdog_rt::time::sleep(wait).await;
                    self.0.pop_front();
                    Some(Ok(Bytes::from_static(chunk.as_bytes())))
                }
                None => std::future::pending().await,
            }
        }
    }
}
