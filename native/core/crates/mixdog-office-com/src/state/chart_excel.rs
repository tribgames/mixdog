//! The Excel applications that the chart data of a slide starts, and their cleanup (`$script:PowerPointChartExcelApplications`,
//! `$script:PowerPointChartExcelProcessIds` and `Close-PowerPointChartExcelApplications`, `office-com-host.ps1`).
//!
//! The registry is kept in the order things were added. Registration (`Register-PowerPointChartExcelApplication`) belongs to
//! the slide operations that open the chart data; they fill it through [`ChartExcel::insert_application`] and
//! [`ChartExcel::add_process`].

use crate::com::Obj;
use crate::com::Value;
use crate::com::retry;
use crate::office::Env;

/// How long an Excel that was asked to quit has to end before it is killed.
const QUIT_WAIT_MS: u32 = 500;
/// How long a killed Excel is waited for.
const KILL_WAIT_MS: u32 = 1000;

struct Registered {
    /// `hwnd:<n>`, or `rcw:<n>` of an application without a window handle.
    key: String,
    app: Obj,
}

/// The tracked chart-data Excel applications and the process ids this host knows to be its own.
#[derive(Default)]
pub struct ChartExcel {
    applications: Vec<Registered>,
    process_ids: Vec<i32>,
}

impl ChartExcel {
    pub fn contains_application(&self, key: &str) -> bool {
        self.applications.iter().any(|entry| entry.key == key)
    }

    /// Tracks an application under its key (a key already tracked is left as it is).
    pub fn insert_application(&mut self, key: &str, app: Obj) {
        if !self.contains_application(key) {
            self.applications.push(Registered { key: key.to_owned(), app });
        }
    }

    /// `$script:PowerPointChartExcelProcessIds[$id] = $true`.
    pub fn add_process(&mut self, process_id: i32) {
        if !self.process_ids.contains(&process_id) {
            self.process_ids.push(process_id);
        }
    }

    pub fn knows_process(&self, process_id: i32) -> bool {
        self.process_ids.contains(&process_id)
    }

    /// The tracked process ids, in the order they were added.
    pub fn process_ids(&self) -> &[i32] {
        &self.process_ids
    }

    pub fn is_empty(&self) -> bool {
        self.applications.is_empty() && self.process_ids.is_empty()
    }

    /// `Close-PowerPointChartExcelApplications`: forgets every tracked application and process. When `quit`, each
    /// application is told `DisplayAlerts = false` and to quit (through the PowerPoint busy retry), every handle is
    /// released, and a tracked process that is still alive after 500 ms is killed and waited for 1 s. Answers how many
    /// applications were tracked.
    pub fn close(&mut self, quit: bool, env: &Env<'_>) -> usize {
        let records = std::mem::take(&mut self.applications);
        let process_ids = std::mem::take(&mut self.process_ids);
        let count = records.len();
        for record in records {
            if quit {
                let _ = record.app.put("DisplayAlerts", Value::Bool(false));
                let _ = retry::powerpoint(env, "PowerPoint chart Excel host", || record.app.call("Quit", &[]).map(|_| true));
            }
            drop(record);
        }
        if quit {
            for process_id in process_ids {
                if !env.platform.process_exists(process_id) {
                    continue;
                }
                if !env.platform.wait_for_exit(process_id, QUIT_WAIT_MS) && env.platform.kill_process(process_id) {
                    let _ = env.platform.wait_for_exit(process_id, KILL_WAIT_MS);
                }
            }
        }
        count
    }
}
