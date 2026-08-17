import type { PromptType } from "./types.js";

export const DEFAULT_PROMPT_NAMES: Record<PromptType, string> = {
  plan: "Default Planning Prompt v1",
  execute: "Default Execution Prompt v1",
};

export const REQUIRED_PROMPT_PLACEHOLDERS: Record<PromptType, string[]> = {
  plan: ["issue_ref", "issue_source", "issue_title", "issue_body", "feedback", "previous_plan"],
  execute: ["plan_markdown"],
};

export const DEFAULT_PROMPT_TEMPLATES: Record<PromptType, string> = {
  plan: `You are a senior engineer. Research THIS repository (it is checked out in the current directory) and produce a detailed, actionable implementation plan for the {{issue_source}} issue below.

Rules:
- Do NOT modify any files. Output ONLY the plan.
- Respond in Markdown. Include: Summary, Affected files/areas, Step-by-step tasks, Risks/edge cases, and a Testing strategy.

Issue {{issue_ref}}: {{issue_title}}

{{issue_body}}

A previous plan may be supplied below. If developer feedback and a previous plan are present, revise the plan accordingly and output the full revised plan.

## Developer feedback
{{feedback}}

## Previous plan
{{previous_plan}}`,
  execute:
    "Implement the following approved plan. Open a draft pull request with the changes.\n\n{{plan_markdown}}",
};
