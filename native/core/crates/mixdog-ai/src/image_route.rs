//! The route resolver for image input lives in the leaf crate (`mixdog_image_egress::route`), where the transport-facing
//! types of every crate can name it; this module keeps its golden fixtures next to the provider families that report facts.

pub use mixdog_image_egress::route::{RouteFacts, Vision, WireBranch, resolve};

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_image_egress::{Column, ImageKind};

    fn facts(branch: WireBranch, model: &str, vision: Vision) -> RouteFacts {
        RouteFacts { endpoint: "ep".into(), account: "acct".into(), model: model.into(), branch, operation: "send".into(), capability_revision: 1, vision }
    }

    #[test]
    fn golden_branch_to_column() {
        let cases = [
            (WireBranch::GeminiNative, Column::Gemini),
            (WireBranch::VertexGemini, Column::Gemini),
            (WireBranch::VertexClaude, Column::Messages),
            (WireBranch::VertexMaas, Column::Chat),
            (WireBranch::AnthropicMessages, Column::Messages),
            (WireBranch::OpenAiResponses, Column::Responses),
            (WireBranch::CompatChat, Column::Chat),
            (WireBranch::InlineOnly, Column::Inline),
            (WireBranch::MediaInline, Column::Inline),
        ];
        for (branch, column) in cases {
            let plan = resolve(&facts(branch, "m", Vision::Yes));
            assert_eq!(plan.policy().column, column, "{branch:?}");
            assert_eq!(plan.route().wire_branch, branch.name());
        }
    }

    #[test]
    fn unknown_route_local_without_vision_and_no_vision_models_take_nothing() {
        for f in [
            facts(WireBranch::Unknown, "m", Vision::Yes),
            RouteFacts::undeclared("ep", "m"),
            facts(WireBranch::Local, "llama", Vision::No),
            facts(WireBranch::CompatChat, "text-only", Vision::No),
        ] {
            let plan = resolve(&f);
            assert!(!plan.policy().vision, "{f:?}");
            assert_eq!(plan.policy().column, Column::None);
        }
        assert!(resolve(&facts(WireBranch::Local, "llava", Vision::Yes)).policy().vision);
    }

    #[test]
    fn heic_as_itself_goes_to_the_gemini_routes_only() {
        // Gemini reads HEIC (as 1.4.5 sent it); every other route receives the OS-converted JPEG rendition.
        for (branch, takes) in [
            (WireBranch::GeminiNative, true),
            (WireBranch::VertexGemini, true),
            (WireBranch::VertexClaude, false),
            (WireBranch::VertexMaas, false),
            (WireBranch::CompatChat, false),
        ] {
            let plan = resolve(&facts(branch, "gemini-2.5-pro", Vision::Yes));
            assert_eq!(plan.policy().takes_kind(ImageKind::Heic), takes, "{branch:?}");
            assert!(plan.policy().takes_kind(ImageKind::Jpeg));
        }
    }

    #[test]
    fn plan_key_carries_every_route_fact_so_a_change_is_a_new_plan() {
        let a = resolve(&facts(WireBranch::CompatChat, "m", Vision::Yes));
        let mut other = facts(WireBranch::CompatChat, "m", Vision::Yes);
        other.account = "acct2".into();
        assert_ne!(a.route(), resolve(&other).route());
        other.account = "acct".into();
        other.capability_revision = 2;
        assert_ne!(a.route(), resolve(&other).route());
    }
}
