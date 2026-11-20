//! The arm and the transcript against what Node answered (`fixtures/skill-session/golden.json`,
//! recorded by `record-skill-session.mjs`): a skill load leaves the session as
//! `loadSkillToolDependencies` leaves it, and the transcript answers whether a skill body is still
//! in the conversation as `skillBodyPresentInSession` does.


use serde_json::json;

use mixdog_core::run_host::skill_session::*;
use mixdog_mcp::skill_port::TranscriptTexts as _;
use std::sync::Arc;
use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;


fn thread() -> ThreadId {
    ThreadId::from("t1")
}













/// The thread's model conversation, as `thread/messages/read` answers it.
struct Rows {
    rows: Vec<Value>,
    unreadable: bool,
}

#[async_trait]
impl ThreadMessages for Rows {
    async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
        if self.unreadable { Err(PortError::Denied("no such thread".into())) } else { Ok(self.rows.clone()) }
    }
}

fn transcript(rows: Rows) -> ThreadTranscript {
    ThreadTranscript::new(Arc::new(rows))
}

/// A transcript that cannot be read is the port's error, not an empty transcript.
#[tokio::test]
async fn an_unreadable_transcript_is_an_error() {
    let transcript = transcript(Rows { rows: vec![json!({"role": "user", "content": "hi"})], unreadable: true });
    assert_eq!(transcript.user_texts(&thread()).await, Err(PortError::Denied("no such thread".into())));
}


