//! Markdown for the terminal UI: marked 14.1.4's lexer with the TUI's pair-only `~~strike~~` tokenizer ([`lexer`]), and
//! the modules the renderer is built from (token to ANSI, tables, row measurement, streaming, healing, the REPL
//! renderer), each filled by the task that ports it.

pub mod format;
pub mod heal;
pub mod lexer;
pub mod lru;
pub mod measure;
pub mod render;
pub mod repl_render;
pub mod stream;
pub mod table;
