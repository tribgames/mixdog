//! Tool policy and the approval pipeline (T §1.2–§1.4, SPEC §4.12).
//!
//! Behaviour is today's, exactly: no workspace boundary (D-PATH), `git`,
//! `github` and `session` keep their approval behaviour (D-GH, D-SESSION), and
//! the only calls that ask by default are outbound ones. What an outbound call
//! is comes from the tool itself (`Tool::outbound_kind`); this module never
//! looks at a tool name to classify a call.
//!
//! * [`ToolPolicy::authorize`] runs `hook → gate → approval → connector`.
//! * [`gate`] is the human-gate rule; [`grants`] and [`session_grants`] are
//!   what a person may choose to remember; [`run_policy`] is the schedule and
//!   webhook rule; [`card`] is what an outbound card shows.
//! * [`exec`] is the verdict a shell command receives before it is spawned.

pub mod action;
pub mod card;
pub mod exec;
pub mod file_store;
pub mod gate;
pub mod grants;
pub mod pipeline;
pub mod run_policy;
pub mod session_grants;
pub mod surface;

pub use surface::SessionSurface;
pub use action::GrantKey;
pub use card::CardEnricher;
pub use card::OutboundCard;
pub use exec::CommandPolicy;
pub use exec::ExecFinding;
pub use exec::ExecVerdict;
pub use file_store::FileGrantStore;
pub use gate::HookAction;
pub use gate::PolicySettings;
pub use gate::SessionFacts;
pub use grants::AuditEntry;
pub use grants::Grant;
pub use grants::GrantStore;
pub use grants::GrantTable;
pub use grants::MemoryGrantStore;
pub use grants::PermissionMode;
pub use grants::StoreError;
pub use pipeline::AuthorizeRequest;
pub use pipeline::Authorized;
pub use pipeline::ConnectorPermissions;
pub use pipeline::HookCall;
pub use pipeline::HookDecision;
pub use pipeline::HookFailure;
pub use pipeline::PreToolHook;
pub use pipeline::ToolPolicy;
pub use pipeline::ToolResolver;
pub use run_policy::RunKind;
pub use session_grants::SessionGrantRegistry;
pub use session_grants::SessionGrants;
