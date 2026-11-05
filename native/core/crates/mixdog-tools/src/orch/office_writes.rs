//! The real [`OfficeWrites`]: the files an office call wrote join the thread's turn review as that
//! call's own changes (counted, and undoable where their bytes were captured), as Node's
//! `recordOfficeWrites` did. The review itself is the thread layer's; this crate hands it each call's
//! changes through the small [`ReviewRecorder`] port.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;

use super::office::OfficeWrites;
use super::office::WriteReceipt;
use super::office::WriteSide;

/// One side of a changed file as the review keeps it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReviewSide {
    Absent,
    Bytes(Vec<u8>),
    /// The file changed but its bytes were not captured: the review shows an explicit omitted
    /// marker (never empty bytes) and offers no undo.
    Omitted,
}

/// A file a tool call changed, for the thread's turn review.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReviewChange {
    pub path: String,
    pub before: ReviewSide,
    pub after: ReviewSide,
}

/// The turn review's intake of tool writes (implemented by the thread layer).
#[async_trait]
pub trait ReviewRecorder: Send + Sync {
    /// Folds one call's changes into the thread's current turn review. Best effort: it never
    /// fails the tool call that wrote the files.
    async fn record(&self, thread: &ThreadId, call: &ToolCallId, changes: Vec<ReviewChange>);
}

pub struct TurnReviewWrites {
    recorder: Arc<dyn ReviewRecorder>,
}

impl TurnReviewWrites {
    pub fn new(recorder: Arc<dyn ReviewRecorder>) -> Self {
        Self { recorder }
    }
}

fn side(side: WriteSide) -> ReviewSide {
    match side {
        WriteSide::Absent => ReviewSide::Absent,
        WriteSide::Bytes(bytes) => ReviewSide::Bytes(bytes),
        WriteSide::Uncaptured => ReviewSide::Omitted,
    }
}

#[async_trait]
impl OfficeWrites for TurnReviewWrites {
    async fn record(&self, thread: &ThreadId, call: &ToolCallId, writes: Vec<WriteReceipt>) {
        let changes: Vec<ReviewChange> = writes
            .into_iter()
            .map(|w| ReviewChange { path: w.path, before: side(w.before), after: side(w.after) })
            .collect();
        if !changes.is_empty() {
            self.recorder.record(thread, call, changes).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    struct Recorded(Mutex<Vec<(String, String, Vec<ReviewChange>)>>);

    #[async_trait]
    impl ReviewRecorder for Recorded {
        async fn record(&self, thread: &ThreadId, call: &ToolCallId, changes: Vec<ReviewChange>) {
            self.0.lock().unwrap().push((thread.as_str().to_owned(), call.as_str().to_owned(), changes));
        }
    }

    #[tokio::test]
    async fn receipts_become_the_calls_review_changes_with_uncaptured_marked_omitted() {
        let recorder = Arc::new(Recorded::default());
        let writes = TurnReviewWrites::new(recorder.clone());
        let receipts = vec![
            WriteReceipt { path: "/a.docx".into(), before: WriteSide::Absent, after: WriteSide::Bytes(b"new".to_vec()) },
            WriteReceipt { path: "/b.xlsx".into(), before: WriteSide::Bytes(b"old".to_vec()), after: WriteSide::Uncaptured },
        ];
        writes.record(&ThreadId::from("t1"), &ToolCallId::from("c1"), receipts).await;

        let got = recorder.0.lock().unwrap();
        assert_eq!((got[0].0.as_str(), got[0].1.as_str()), ("t1", "c1"));
        assert_eq!(
            got[0].2,
            vec![
                ReviewChange { path: "/a.docx".into(), before: ReviewSide::Absent, after: ReviewSide::Bytes(b"new".to_vec()) },
                ReviewChange { path: "/b.xlsx".into(), before: ReviewSide::Bytes(b"old".to_vec()), after: ReviewSide::Omitted },
            ]
        );
    }

    #[tokio::test]
    async fn a_call_that_wrote_nothing_records_nothing() {
        let recorder = Arc::new(Recorded::default());
        TurnReviewWrites::new(recorder.clone()).record(&ThreadId::from("t"), &ToolCallId::from("c"), Vec::new()).await;
        assert!(recorder.0.lock().unwrap().is_empty());
    }
}
