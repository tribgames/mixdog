//! The session's tool and prompt surface (MCP fold, re-arm, turn reminders, prompt, config hosts) against Node's recordings.

#[cfg(node_twin)]
mod config_hosts;
#[cfg(node_twin)]
mod mcp_fold;
#[cfg(node_twin)]
mod prompt_session;
#[cfg(node_twin)]
mod rearm;
#[cfg(node_twin)]
mod roster_rows;
mod skill_session;
#[cfg(node_twin)]
mod turn_reminders;
mod prompt_session_rules;
mod rearm_rules;
mod room_send_rules;
mod turn_reminder_rules;
mod skill_arm_rules;
