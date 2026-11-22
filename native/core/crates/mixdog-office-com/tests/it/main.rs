//! One test binary for the crate's integration tests: each extra binary is one more link of the whole dependency graph.
//! nextest runs every test in its own process, so a test still runs alone in its program. A stand-in a test starts from its
//! own executable is named with its module path (`containment_live::stand_in`).

#[path = "../actions.rs"]
mod actions;
#[path = "../actions_live.rs"]
mod actions_live;
#[path = "../cleanup.rs"]
mod cleanup;
#[path = "../containment.rs"]
mod containment;
#[path = "../containment_live.rs"]
mod containment_live;
#[path = "../dispatch.rs"]
mod dispatch;
#[path = "../dispatch_live.rs"]
mod dispatch_live;
#[path = "../excel_edit.rs"]
mod excel_edit;
#[path = "../excel_edit_live.rs"]
mod excel_edit_live;
#[path = "../excel_read.rs"]
mod excel_read;
#[path = "../excel_read_live.rs"]
mod excel_read_live;
#[path = "../host_protocol.rs"]
mod host_protocol;
#[path = "../no_powershell.rs"]
mod no_powershell;
#[path = "../platform.rs"]
mod platform;
#[path = "../platform_live.rs"]
mod platform_live;
#[path = "../ppt_edit.rs"]
mod ppt_edit;
#[path = "../ppt_edit_live.rs"]
mod ppt_edit_live;
#[path = "../ppt_read.rs"]
mod ppt_read;
#[path = "../ppt_read_live.rs"]
mod ppt_read_live;
#[path = "../pswire.rs"]
mod pswire;
#[path = "../session.rs"]
mod session;
#[path = "../session_live.rs"]
mod session_live;
#[path = "../switch_excel_live.rs"]
mod switch_excel_live;
#[path = "../switch_powerpoint_live.rs"]
mod switch_powerpoint_live;
#[path = "../switch_word_live.rs"]
mod switch_word_live;
#[path = "../transport.rs"]
mod transport;
#[path = "../word_edit.rs"]
mod word_edit;
#[path = "../word_edit_live.rs"]
mod word_edit_live;
#[path = "../word_read.rs"]
mod word_read;
#[path = "../word_read_live.rs"]
mod word_read_live;
#[path = "../word_save_copy.rs"]
mod word_save_copy;
