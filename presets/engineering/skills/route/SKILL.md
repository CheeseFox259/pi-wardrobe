---
name: route
description: Route an engineering request or problem to the right curated engineering skill.
---

# Route

Analyze the user's intent and dispatch to the appropriate engineering skill family in this preset.

## Workflow

1. Evaluate the task against the curated engineering skill families:
   - **Clarification & Interrogation**: `/grilling`
   - **Domain Modeling & ADRs**: `/domain-modeling`
   - **System Architecture & Seams**: `/project-architecture`
   - **Feature Specification**: `/to-spec`
   - **Ticket Breakdown & Ordering**: `/to-tickets`
   - **Implementation & LSP Feedback**: `/implement`
   - **Test-Driven Red-Green Cycle**: `/tdd`
   - **Standards & Spec Review**: `/code-review`
   - **Product Acceptance & Verification**: `/verify-product`
   - **Technical Investigation**: `/research`
   - **Repository Configuration**: `/setup-matt-pocock-skills`

2. **Prerequisites & Unavailability Policy**:
   Check that required workflow prerequisites exist before entering a workflow. If a skill requires interactive question tools, LSP tools, or external services that are absent:
   - Explicitly report the workflow as **UNAVAILABLE**.
   - Explain the exact prerequisite that is missing.
   - Do NOT attempt to silently install tools, packages, or background daemons.
   - Proceed with fallback local analysis only if truthful to the user.
