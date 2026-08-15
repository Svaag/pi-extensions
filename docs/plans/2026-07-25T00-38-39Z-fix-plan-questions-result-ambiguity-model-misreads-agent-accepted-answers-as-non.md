---
created: 2026-07-25T00:38:39.361Z
source: pi-plan-mode
status: accepted-for-execution
---

# Fix plan_questions result ambiguity: model misreads agent-accepted answers as non-decisive

## Summary

When a user accepts a plan-review agent recommendation via the `plan_questions` TUI wizard, the tool result text shown to the LLM currently says only `agent recommended: Recommendation: …`. This phrasing omits any user-action verb, causing models to waste tokens second-guessing whether the answer is authoritative — exactly the metacognitive spiral quoted in the user's report. Additionally, neither the tool's `promptGuidelines` nor the injected Plan Mode context instructs models on how to interpret `plan_questions` results.

The fix: rephrase the LLM-facing result text to present all answers uniformly as the user's final decisions with no internal provenance, strip the redundant `Recommendation:` prefix from agent text, and add interpretation guidance to both the tool guidelines and the Plan Mode system context. Extract the formatting logic into a pure exported helper in `plan-mode/utils.ts` so it can be unit-tested.

## Implementation Steps

1. Add a pure exported `formatPlanQuestionsResult` helper to `plan-mode/utils.ts` plus minimal structural format types.
2. Replace the inline answer-line formatting in the `plan_questions` `execute` handler with a call to the new helper.
3. Strip the leading `Recommendation:` / `Recommend:` prefix from agent-sourced answer labels in the new formatter.
4. Add an interpretation guideline to the tool's `promptGuidelines` array.
5. Add a matching interpretation bullet to the `## Asking questions` section of the `[PLAN MODE ACTIVE]` injected context.
6. Add unit tests for `formatPlanQuestionsResult` covering agent-accepted, user-selected, user-typed, and mixed scenarios.
7. Update the README "Agent-Assisted Planning Questions" section to note the new result framing.

## Key Details

### `formatPlanQuestionsResult` — new exported helper in `plan-mode/utils.ts`

**Signature:**
```ts
export function formatPlanQuestionsResult(
    questions: Array<{ id: string; label: string }>,
    answers: Array<{ id: string; value: string; label: string; source?: "agent" | "user" }>,
): string
```

**Behavior:**
- Prefaced with header: `The user answered your planning questions (final decisions — do not re-ask):`
- One `- <label> (<id>): <cleaned answer>` bullet per answer.
- For answers with `source === "agent"`: strips a leading `Recommendation:` / `Recommend:` prefix (case-insensitive, with optional whitespace before and after the colon) from `answer.label`.
- Normalizes embedded newlines to spaces and collapses runs of whitespace for LLM readability (keeps the label compact in a single bullet).
- No parenthetical source annotations (`[selected]`, `[agent]`, etc.) appear in the LLM-facing output. Provenance remains in the structured `details` object (available for TUI rendering and session history) but is excluded from `content`.

**Example output:**
```
The user answered your planning questions (final decisions — do not re-ask):
- approach (scope): Hybrid — verify + rename (option 3).
- tests (test_scope): Both — new focused tests + extend existing where natural.
```

### Changes in `plan-mode/index.ts`

**Import addition** (line ~25 after existing utils imports):
```ts
formatPlanQuestionsResult,
```

**`execute` handler** — replace lines ~838–846 (the `answerLines.map` + return) with:
```ts
const llmText = formatPlanQuestionsResult(
    questions.map(q => ({ id: q.id, label: q.label })),
    result.answers.map(a => ({ id: a.id, value: a.value, label: a.label, source: a.source })),
);
return { content: [{ type: "text" as const, text: llmText }], details: result };
```

**`promptGuidelines`** (line ~437) — add as 3rd entry:
```
"plan_questions results are the user's authoritative decisions. Answers accepted from a plan-review agent recommendation were explicitly approved by the user in the TUI wizard — treat them as final user input. Never re-ask or second-guess them.",
```

**`[PLAN MODE ACTIVE]` injected context** — after the two existing bullets under `## Asking questions` (line ~1240–1241), append:
```
* \`plan_questions\` results are the user's final decisions. Every answer in the result was approved by the user in the TUI wizard — including answers that came from a plan-review agent recommendation. Treat them like other user input: authoritative, not advisory. Never re-ask or second-guess them.
```

### Safe whitespace / newline handling

Agent responses from `complete()` may include newlines. `formatPlanQuestionsResult` normalizes:
- `answer.label.replace(/[\n\r]+/g, " ").replace(/\s+/g, " ").trim()` — ensures each answer is a single-line bullet, readable by any LLM.
- The `Recommendation:` prefix strip is a `replace` before whitespace normalization, so multi-line agent responses are handled: the regex `replace(/^\s*recommend(?:ation)?:\s*/i, "")` matches only at the very start.

### What is NOT changed

- `renderResult` TUI display: keeps `(agent)` / `(wrote)` markers — human-facing, correct.
- `details` (structured `PlanQuestionsResult`): unchanged — backward-compatible with existing sessions.
- `formatExistingAnswers` (used by the plan-review agent's prompt during recommendation): unaffected — uses `answer.label` directly, which is correct there.
- `saveAnswer` calls in the TUI event handlers: unchanged (they populate details/answers correctly).
- Bash allowlist, step extraction, or any other plan-mode subsystem.

## Test Plan

All new tests in `tests/plan-mode.test.ts`, importing `formatPlanQuestionsResult` from `../plan-mode/utils.ts`.

| Test case | Input | Expected assertion |
|---|---|---|
| Agent-accepted answer (with "Recommendation:" prefix) | source="agent", label="Recommendation: Hybrid — option 3." | output contains "Hybrid — option 3." and header; no "Recommendation:", "agent recommended" |
| Agent-accepted answer ("Recommend:" variant) | source="agent", label="Recommend: Do X." | output contains "Do X." without "Recommend:" |
| Agent-accepted answer (no prefix) | source="agent", label="Just do Y." | output contains "Just do Y." unchanged |
| User-selected answer | source undefined, label="3. Both approaches" | output contains "3. Both approaches"; no parentheses around provenance |
| User-typed answer | source undefined, wasCustom, label="my custom text" | output contains "my custom text" |
| Mixed three answers (agent + selected + typed) | 3 answers with different sources | 3 bullet lines under header; all answer text preserved; no "agent", "wrote", or "selected" annotations |
| Multi-line agent label | source="agent", label="Recommendation: A\nbecause B." | output is single-line: "A because B." |
| Header presence | any non-empty answers | first line starts with "The user answered your planning questions" |
| Empty answers array | answers=[] | header line only |

## Assumptions

- The plan-review agent reliably produces text starting with "Recommendation:" (per `PLAN_AGENT_SYSTEM_PROMPT`). The prefix strip is best-effort — if the agent deviates, the raw agent text is still shown.
- No downstream code parses the tool result's `content` text structurally; only the LLM reads it. `details` remain the canonical structured representation.
- The `[PLAN MODE ACTIVE]` injected context is the same template string used for both initial planning and plan-refinement (the refinement variant `[PLAN MODE ACTIVE - REFINING PLAN]` on line ~1150 is a separate, shorter string that inherits no plan_questions interpretation guidance — acceptable since the tool's persistent `promptGuidelines` cover every mode).





<!-- pi-plan-progress:start -->
## Progress

Status legend: `[x]` done, `[~]` in progress, `[-]` skipped, `[>]` deferred, `[!]` blocked, `[ ]` pending.

- [x] 1. Add a pure exported formatPlanQuestionsResult helper to plan-mode/utils.ts plus minimal structural format types. _(done)_
- [x] 2. Replace the inline answer-line formatting in the plan_questions execute handler with a call to the new helper. _(done)_
- [x] 3. Strip the leading Recommendation: / Recommend: prefix from agent-sourced answer labels in the new formatter. _(done)_
- [x] 4. Add an interpretation guideline to the tool's promptGuidelines array. _(done)_
- [x] 5. Add a matching interpretation bullet to the ## Asking questions section of the [PLAN MODE ACTIVE] injected context. _(done)_
- [x] 6. Add unit tests for formatPlanQuestionsResult covering agent-accepted, user-selected, user-typed, and mixed scenarios. _(done)_
- [x] 7. Update the README "Agent-Assisted Planning Questions" section to note the new result framing. _(done)_

<!-- pi-plan-progress:end -->
