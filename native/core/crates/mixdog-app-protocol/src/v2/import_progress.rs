//! Params of `import/progress/updated`: the desktop's `conversation-import-progress` event (conversation-import-progress.ts), one changed
//! snapshot of a conversation-import job.

use mixdog_protocol::JsonValue;
use serde::Deserialize;
use serde::Serialize;

/// The job snapshot exactly as `import/getConversationImportJobs` lists it (`jobId`, `seq`, `state`, `processed`, ...).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportProgressUpdatedParams {
    pub job: JsonValue,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_job_snapshot_is_carried_as_listed() {
        let job = serde_json::json!({ "jobId": "j1", "seq": 3, "state": "running", "processed": 2 });
        let params = ImportProgressUpdatedParams { job: job.clone() };
        assert_eq!(serde_json::to_value(&params).unwrap(), serde_json::json!({ "job": job }));
        assert_eq!(serde_json::from_value::<ImportProgressUpdatedParams>(serde_json::json!({ "job": job })).unwrap(), params);
    }
}
