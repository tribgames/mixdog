// Request shapes read from the daemon over stdin.

use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpawnRequest {
    pub(crate) id: u64,
    pub(crate) program: String,
    #[serde(default)]
    pub(crate) args: Vec<String>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub(crate) background: bool,
    #[serde(default)]
    pub(crate) job_id: Option<String>,
    #[serde(default)]
    pub(crate) timeout_ms: u64,
    #[serde(default)]
    pub(crate) output_limit: usize,
    #[serde(default)]
    pub(crate) merge_stderr: bool,
    #[serde(default)]
    pub(crate) raw_output: bool,
    // File capture. When BOTH paths are supplied the child's stdout/stderr are
    // opened here and handed over as fds: no pipe, no pump thread, no reader
    // that can disappear. A child the caller deliberately leaves running (a
    // task's server) then keeps writing to disk after this server exits,
    // instead of dying on its next write to a reader-less pipe.
    #[serde(default)]
    pub(crate) stdout_path: Option<String>,
    #[serde(default)]
    pub(crate) stderr_path: Option<String>,
    // Keep the child's stdin as a writable pipe (warm shell standby feeds the
    // script text after spawn). Default false preserves Stdio::null().
    #[serde(default)]
    pub(crate) stdin_pipe: bool,
    #[serde(default)]
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) shell_type: Option<String>,
    #[serde(default)]
    pub(crate) owner_session_id: Option<String>,
    #[serde(default)]
    pub(crate) client_host_pid: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrackRequest {
    pub(crate) id: u64,
    pub(crate) track: u64,
    pub(crate) job_id: String,
    #[serde(default)]
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) shell_type: Option<String>,
    #[serde(default)]
    pub(crate) owner_session_id: Option<String>,
    #[serde(default)]
    pub(crate) client_host_pid: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromoteRequest {
    pub(crate) id: u64,
    pub(crate) promote_task: String,
    #[serde(default)]
    pub(crate) timeout_ms: u64,
    #[serde(default)]
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default)]
    pub(crate) shell_type: Option<String>,
    #[serde(default)]
    pub(crate) owner_session_id: Option<String>,
    #[serde(default)]
    pub(crate) client_host_pid: Option<u32>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum WireRequest {
    Spawn(SpawnRequest),
    Cancel {
        cancel: u64,
    },
    Track(TrackRequest),
    Promote(PromoteRequest),
    StdinWrite {
        #[serde(rename = "stdinWrite")]
        stdin_write: u64,
        data: String,
        // Atomically close (EOF) after the write. A separate close message
        // could race ahead of the async write thread and hand the child an
        // empty stdin.
        #[serde(default)]
        close: bool,
    },
    StdinClose {
        #[serde(rename = "stdinClose")]
        stdin_close: u64,
    },
    CancelTask {
        id: u64,
        #[serde(rename = "cancelTask")]
        cancel_task: String,
    },
    ReleaseTask {
        id: u64,
        #[serde(rename = "releaseTask")]
        release_task: String,
    },
    CancelOwner {
        id: u64,
        #[serde(rename = "cancelOwnerSession")]
        cancel_owner_session: String,
    },
    TaskStatus {
        id: u64,
        #[serde(rename = "taskStatus")]
        task_status: String,
    },
    TaskList {
        id: u64,
        #[serde(rename = "taskList")]
        task_list: bool,
    },
}
