//! The production `WorkflowSurface` of the thread switches (`mixdog_core_session::session::
//! thread_switches`): the prompt side of a mid-conversation workflow or orchestration-mode
//! switch. Its four methods are ports of the Node functions `activeWorkflowContext` with
//! `leadPartsFor`, `liveDeniedTools`, `modelStandaloneTools` and `orchestrationInstructions`;
//! each piece lives in its own file, with its Node golden under `fixtures/workflow-surface/`.

pub mod context;
pub mod instructions;
