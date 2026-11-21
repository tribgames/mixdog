use mixdog_fsio::WriteProof;
use mixdog_js::{number_to_string, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_office_quality::design_review::{infer_pptx_slide_roles, review_office_design};
use mixdog_office_quality::document_brief::document_brief_issues;
use mixdog_office_quality::issue::issue_with;
use serde_json::{Map, Value, json};

use crate::actions::{Host, Machine};
use crate::batch::BatchHost;
use crate::inspect::{review_snapshot, spread};
use crate::render::RenderEngine;
use crate::session::SessionHandle;
use crate::session::open::SessionCloser;
use crate::session::registry::lock;

/// What the design stage of QA found.
pub struct DesignStage {
    pub design_review: Value,
    /// The document the review read; `None` when it could not be read.
    pub current_snapshot: Option<Value>,
    pub review_slide_plans: Vec<Value>,
    /// Page number to role.
    pub page_roles: Value,
}

fn unavailable_design_review(profile: &str, message: &str) -> Value {
    json!({
        "ok": false,
        "status": "unavailable",
        "profile": profile,
        "requiresVisualInspection": true,
        "modelReview": [],
        "issues": [issue_with("design_review_unavailable", "/", message, "design-review", "warning")],
    })
}

/// The plans the call or the session carries of the deck.
fn requested_slide_plans(design_request: Option<&Value>, design: Option<&Value>) -> Vec<Value> {
    for source in [design_request, design] {
        if let Some(plans) = source.and_then(|source| source.get("slidePlans")).and_then(Value::as_array) {
            return plans.clone();
        }
    }
    Vec::new()
}

fn page_roles_for(format: &str, plans: &[Value], document: Option<&Value>) -> Value {
    // Without composer plans (authored decks) the statement beats are read from the saved shapes so the density gates do not
    // penalise deliberate air.
    if !plans.is_empty() {
        let mut roles = Map::new();
        for plan in plans {
            let slide = to_number_of(plan.get("slide"));
            if slide.is_nan() || slide <= 0.0 {
                continue;
            }
            let mut role = Map::new();
            for (key, field) in [("slideRole", "slideRole"), ("visualType", "visualType")] {
                if let Some(value) = plan.get(field) {
                    role.insert(key.to_owned(), value.clone());
                }
            }
            roles.insert(number_to_string(slide), Value::Object(role));
        }
        return Value::Object(roles);
    }
    if format == "pptx" {
        return infer_pptx_slide_roles(document.unwrap_or(&Value::Null));
    }
    json!({})
}

impl<P: WriteProof, H: Host, C: SessionCloser, R: RenderEngine, B: BatchHost> Machine<'_, P, H, C, R, B> {
    /// The structural review of the whole document, the document it read and the slide plans it was held to; an unreadable
    /// document gives the advisory review and no snapshot.
    async fn read_design_review(&self, handle: &SessionHandle, args: &Value, profile: &str) -> (Value, Option<Value>, Vec<Value>) {
        let mut current_snapshot: Option<Value> = None;
        let mut review_slide_plans: Vec<Value> = Vec::new();
        let design_review;
        match review_snapshot(self.inspect(), handle, args).await {
            Err(error) => design_review = unavailable_design_review(profile, &error),
            Ok(read) => {
                let (format, request, library) = {
                    let session = lock(handle);
                    let state_plans = session.design_state.slide_plans.clone().unwrap_or_default();
                    review_slide_plans =
                        if state_plans.is_empty() { requested_slide_plans(session.design_request.as_ref(), session.design.as_ref()) } else { state_plans };
                    let mut request = Map::new();
                    spread(&mut request, session.design.as_ref().unwrap_or(&Value::Null));
                    spread(&mut request, session.design_request.as_ref().unwrap_or(&Value::Null));
                    if session.format == "pptx" {
                        request.insert("slidePlans".to_owned(), Value::Array(review_slide_plans.clone()));
                        if let Some(brief) = session.authored.brief.as_ref().filter(|brief| truthy(brief)) {
                            request.insert("brief".to_owned(), brief.clone());
                        }
                    }
                    request.insert("compositions".to_owned(), Value::Array(session.design_state.compositions.clone()));
                    (session.format.clone(), Value::Object(request), session.design_library.clone())
                };
                let audit_profile = args.get("auditProfile").filter(|value| truthy(value)).map(value_to_string).unwrap_or_default();
                let document = read.get("document").cloned().unwrap_or(Value::Null);
                design_review = match review_office_design(self.reads, &format, &document, Some(&request), library.as_ref(), &audit_profile) {
                    Ok(review) => review,
                    Err(error) => unavailable_design_review(profile, &error),
                };
                current_snapshot = Some(read);
            }
        }
        (design_review, current_snapshot, review_slide_plans)
    }

    /// `reviewQaDesign(session, args)`.
    pub(crate) async fn review_qa_design(&self, handle: &SessionHandle, args: &Value) -> DesignStage {
        let profile =
            lock(handle).design.as_ref().and_then(|design| design.get("profile")).filter(|profile| truthy(profile)).map(value_to_string).unwrap_or_default();
        let (mut design_review, current_snapshot, review_slide_plans) = self.read_design_review(handle, args, &profile).await;
        let (format, frame, frame_issues, brief) = {
            let session = lock(handle);
            (session.format.clone(), session.authored.frame, session.authored.frame_design_issues.clone(), session.authored.brief.clone())
        };
        // A PDF of designed pages was read against its brief on the working deck at author time (the plan count, the facts'
        // locators); those readings join the PDF's own review.
        if frame && let Some(extra) = frame_issues.as_ref().and_then(Value::as_array).filter(|extra| !extra.is_empty()) {
            design_review = with_extra_issues(&design_review, extra);
        }
        // A Word document or workbook written to a brief: its figures against the facts line, its facts against the sources.
        let document = current_snapshot.as_ref().and_then(|read| read.get("document"));
        let brief_issues = document_brief_issues(self.batch.host.brief_readings(), &format, document.unwrap_or(&Value::Null), brief.as_ref());
        if !brief_issues.is_empty() {
            design_review = with_extra_issues(&design_review, &brief_issues);
        }
        let page_roles = page_roles_for(&format, &review_slide_plans, document);
        DesignStage { design_review, current_snapshot, review_slide_plans, page_roles }
    }
}

/// `{ ...review, issues: [...(review.issues || []), ...extra] }`.
fn with_extra_issues(review: &Value, extra: &[Value]) -> Value {
    let mut fields = review.as_object().cloned().unwrap_or_default();
    let mut issues: Vec<Value> = fields.get("issues").and_then(Value::as_array).cloned().unwrap_or_default();
    issues.extend(extra.iter().cloned());
    fields.insert("issues".to_owned(), Value::Array(issues));
    Value::Object(fields)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_name_the_role_of_each_page() {
        let plans = vec![
            json!({ "slide": 2, "slideRole": "cover", "visualType": "hero" }),
            json!({ "slide": 0, "slideRole": "skipped" }),
            json!({ "slide": 3, "slideRole": "data" }),
        ];
        assert_eq!(page_roles_for("pptx", &plans, None), json!({ "2": { "slideRole": "cover", "visualType": "hero" }, "3": { "slideRole": "data" } }));
        assert_eq!(page_roles_for("docx", &[], None), json!({}));
    }

    #[test]
    fn an_unreadable_document_is_one_advisory_issue() {
        let review = unavailable_design_review("clean", "no read");
        assert_eq!(review["status"], "unavailable");
        assert_eq!(review["issues"][0]["code"], "design_review_unavailable");
        assert_eq!(review["issues"][0]["source"], "design-review");
        let extended = with_extra_issues(&review, &[json!({ "code": "x" })]);
        assert_eq!(extended["issues"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn the_session_plans_beat_the_requested_ones() {
        let request = json!({ "slidePlans": [{ "slide": 1 }] });
        let design = json!({ "slidePlans": [{ "slide": 9 }] });
        assert_eq!(requested_slide_plans(Some(&request), Some(&design)), vec![json!({ "slide": 1 })]);
        assert_eq!(requested_slide_plans(None, Some(&design)), vec![json!({ "slide": 9 })]);
        assert!(requested_slide_plans(None, None).is_empty());
    }
}
