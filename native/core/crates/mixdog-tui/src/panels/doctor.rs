//! `/doctor` (`app/doctor.mjs` and `app/doctor-session-log.mjs`, called through `runDoctor({ notice: true })` of the slash
//! dispatch).
//!
//! The checks themselves are the core's: `diagnostics/runDoctor` (`mixdog_core_domains::domains::diagnostics`) runs the sixteen
//! checks side by side under one deadline each, in the order of the Node report (mixdog, node, providers, mcp, memory, local
//! provider, built-ins, voice, automation, skills, plugins, hooks, data folder, config, logs, session log), reads the
//! json-to-log session migration for the session-log row, shows the data folder with its hint (`create the folder or point
//! MIXDOG_DATA_DIR at an existing one`), and, when it is asked for the notice, writes the text report to the session as an
//! info notice. A run that finds another one in progress answers `{ busy: true }` and writes nothing. The terminal UI keeps
//! only what is presentation here: the request, and the error notice of a failed one.

use serde_json::json;

use super::PanelsHost;

/// The store action that runs the checks.
pub const RUN_DOCTOR_ACTION: &str = "runDoctor";

/// `runDoctor({ notice: true })`: asks the core for the checks and for the report as a notice of the session. The answer (the
/// structured rows, or `{ busy: true }`) is not needed, the notice is the report. `Err` carries the rejection text, which the
/// slash dispatch shows; a store without the action does nothing, as the optional call of the Node code.
pub fn run_doctor<H: PanelsHost>(host: &mut H) -> Result<(), String> {
    match host.read_store(RUN_DOCTOR_ACTION, json!([{ "notice": true }])) {
        Some(Err(error)) => Err(error),
        Some(Ok(_)) | None => Ok(()),
    }
}
