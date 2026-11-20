//! The route resolver for image input: from the facts of one resolved send (wire branch, deployment, model, operation) to the
//! pinned [`Plan`] that both preparation and transport use. The provider's name and its codec are not evidence of support; the
//! wire branch the request actually takes is. Unknown is no support.

use crate::policy::{Column, InputImagePolicy, RouteKey};
use crate::prepared::Plan;

/// The wire branch a send resolves to. Wrappers (Antigravity, Vertex) report the branch of the route inside them.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WireBranch {
    GeminiNative,
    VertexGemini,
    VertexClaude,
    VertexMaas,
    AnthropicMessages,
    OpenAiResponses,
    CompatChat,
    /// Cursor binary image and Devin chat/router prompts: inline-only.
    InlineOnly,
    /// A local runtime (Chat-compatible), with the vision its adapter declares.
    Local,
    /// A media endpoint that takes inline images (data URL or inlineData).
    MediaInline,
    /// A route this table does not know.
    Unknown,
}

impl WireBranch {
    pub fn name(self) -> &'static str {
        match self {
            WireBranch::GeminiNative => "gemini",
            WireBranch::VertexGemini => "vertex-gemini",
            WireBranch::VertexClaude => "vertex-claude",
            WireBranch::VertexMaas => "vertex-maas",
            WireBranch::AnthropicMessages => "messages",
            WireBranch::OpenAiResponses => "responses",
            WireBranch::CompatChat => "chat",
            WireBranch::InlineOnly => "inline",
            WireBranch::Local => "local",
            WireBranch::MediaInline => "media-inline",
            WireBranch::Unknown => "unknown",
        }
    }
}

/// Whether the resolved model reads images, as its adapter declares it. There is no "unknown": a route that cannot say it reads
/// images declares `No`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Vision {
    Yes,
    No,
}

/// Everything the resolver reads. `account` is opaque; `model` is the resolved deployment, not a requested alias.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RouteFacts {
    pub endpoint: String,
    pub account: String,
    pub model: String,
    pub branch: WireBranch,
    pub operation: String,
    pub capability_revision: u32,
    pub vision: Vision,
}

impl RouteFacts {
    /// The facts of a send an adapter knows the wire of. The account is whatever the adapter pins sends to (opaque).
    pub fn declared(endpoint: &str, model: &str, branch: WireBranch, vision: Vision) -> Self {
        Self {
            endpoint: endpoint.to_owned(),
            account: String::new(),
            model: model.to_owned(),
            branch,
            operation: "send".to_owned(),
            capability_revision: 1,
            vision,
        }
    }

    /// The facts of a route that declared none: it takes no image.
    pub fn undeclared(endpoint: &str, model: &str) -> Self {
        Self {
            endpoint: endpoint.to_owned(),
            account: String::new(),
            model: model.to_owned(),
            branch: WireBranch::Unknown,
            operation: "send".to_owned(),
            capability_revision: 0,
            vision: Vision::No,
        }
    }
}

fn column_of(branch: WireBranch) -> Column {
    match branch {
        WireBranch::GeminiNative | WireBranch::VertexGemini => Column::Gemini,
        WireBranch::VertexClaude | WireBranch::AnthropicMessages => Column::Messages,
        WireBranch::OpenAiResponses => Column::Responses,
        WireBranch::VertexMaas | WireBranch::CompatChat | WireBranch::Local => Column::Chat,
        WireBranch::InlineOnly | WireBranch::MediaInline => Column::Inline,
        WireBranch::Unknown => Column::None,
    }
}

/// The pinned plan of one send. A different key (failover, account rotation, media fallback, model change) needs a new call.
pub fn resolve(facts: &RouteFacts) -> Plan {
    let key = RouteKey {
        endpoint: facts.endpoint.clone(),
        account: facts.account.clone(),
        model: facts.model.clone(),
        wire_branch: facts.branch.name().to_owned(),
        operation: facts.operation.clone(),
        capability_revision: facts.capability_revision,
    };
    if facts.vision != Vision::Yes || facts.branch == WireBranch::Unknown {
        return Plan::new(key, InputImagePolicy::unknown());
    }
    Plan::new(key, InputImagePolicy::for_column(column_of(facts.branch)))
}
