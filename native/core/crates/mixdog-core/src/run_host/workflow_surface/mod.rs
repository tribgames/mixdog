//! The production `WorkflowSurface` of the thread switches (`mixdog_core_session::session::
//! thread_switches`): the prompt side of a mid-conversation workflow or orchestration-mode
//! switch. Its four methods are ports of the Node functions `activeWorkflowContext` with
//! `leadPartsFor`, `liveDeniedTools`, `modelStandaloneTools` and `orchestrationInstructions`;
//! each piece lives in its own file, with its Node golden under `fixtures/workflow-surface/`.

pub mod catalog;
pub mod context;
pub mod denials;
pub mod instructions;
mod surface;

pub use self::denials::FeatureFacts;
pub use self::denials::FeatureProbes;
pub use self::surface::FeatureEnv;
pub use self::surface::RunWorkflowSurface;
pub use self::surface::SurfaceParts;
