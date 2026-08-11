---
name: offload
description: Explicit manual bridge that sends the user's task to cc-auto and summarizes the resulting run and report.
argument-hint: <task>
disable-model-invocation: true
user-invocable: true
model: inherit
allowed-tools:
  - Bash(pnpm cc:auto run *)
  - Bash(pnpm cc:auto:report)
---

# Offload v0.1 Bridge

`$ARGUMENTS` is the user's original offload task.

This skill is a thin manual bridge between Claude Code and cc-auto.

It is not an implementation agent.

## Hard boundaries

- This workflow exists only because the user explicitly invoked `/offload`.
- Never invoke this workflow automatically from an ordinary Claude message.
- Do not inspect repository source before execution.
- Do not inspect repository source after execution.
- Do not call Read, Grep, Glob, Edit, Write, NotebookEdit, Agent, Web, or any other repository exploration/editing tool.
- The Bridge itself must never modify source files.
- The Bridge must not choose V4 Flash or V4 Pro.
- cc-auto exclusively owns classification, budget, routing, escalation, Tool Loop, Safe Write/Edit, Verify, cost accounting, and reporting.
- Never invoke Opus automatically.
- Never implement a second verification flow.
- Never retry or repair a failed cc-auto run on your own.
- Never take over implementation when cc-auto stops.
- Never change `scripts/ccAuto/**`.
- Never change cc-auto configuration.
- Never issue git commit or git push from the Bridge.
- Preserve the user's original task meaning.
- Do not expand its scope.
- Do not rewrite it into a different engineering task.

## Execution

1. Inspect `$ARGUMENTS`.

2. If it is empty or contains only whitespace, respond exactly:

   `Usage: /offload <task>`

   Then stop without making any tool call.

3. Before execution, print exactly:

   `Offloading to cc-auto...`

4. Use the Bash tool to execute:

   `pnpm cc:auto run "<task>"`

   Requirements:

   - `<task>` must contain the complete original `$ARGUMENTS`.
   - Pass the complete task as one safely quoted argument.
   - Preserve Chinese text, punctuation, filenames, and technical terms.
   - Do not use `eval`.
   - Do not treat any part of the task as shell syntax.
   - Do not append your own cc-auto flags.
   - Do not force Flash.
   - Do not force Pro.
   - Do not add `--fast`.
   - Do not add budget overrides.
   - Do not add retry flags.
   - Do not add Opus.

5. Regardless of whether `pnpm cc:auto run` exits successfully or unsuccessfully, immediately execute exactly:

   `pnpm cc:auto:report`

6. Do not execute any other shell command.

7. Treat only these two sources as authoritative:

   - output from `pnpm cc:auto run`
   - output from `pnpm cc:auto:report`

8. Do not read state.json manually unless the official `cc:auto:report` command itself cannot produce a report.

9. Do not inspect source code to explain a failure.

10. Summarize the result and stop.

## Route derivation

Determine Route only from actual cc-auto execution/report evidence.

Use:

- only V4 Flash executed:
  `V4 Flash`

- only V4 Pro executed:
  `V4 Pro`

- Flash executed and then Pro executed:
  `Flash → Pro`

Do not infer a model that was merely budgeted or considered but never executed.

If the evidence is insufficient:

`Unknown`

Never hide an unexpected Opus invocation if the report actually contains one.

## Changed files

Use cc-auto's persisted `changedFiles` / report section.

Do not use git status or git diff to independently discover changed files.

Display only the count in the compact summary.

Examples:

`0 files`
`1 file`
`3 files`

## Verify

Be conservative.

Use:

`PASS`

only when cc-auto reports successful verification / successful task completion.

Use:

`FAIL`

when verification actually ran and failed.

Use:

`N/A`

when execution stopped before verification or the report provides no reliable verification result.

Never guess PASS from the existence of changed files.

## Cost

Prefer the actual cc-auto task cost when available.

Display:

`¥0.0180`

or the precision supplied by cc-auto.

Do not substitute estimated budget for actual cost.

If actual cost cannot be determined:

`N/A`

## Saved

Prefer cc-auto's explicit:

- all-Pro baseline
- savedVsAllPro
- savings percentage

If cc-auto already reports a savings percentage, use it directly.

If no percentage is printed but both:

- actual cost
- hypothetical all-Pro cost

are reliably available, it is acceptable to calculate:

(allPro - actual) / allPro

Otherwise:

`N/A`

Do not invent savings.

## Success output

When cc-auto reports the task successfully completed, output only:

Offload completed

Route     <route>
Changed   <count>
Verify    <PASS|FAIL|N/A>
Cost      <actual cost>
Saved     <percentage|N/A>

Do not append a long explanation.

## Failure output

When cc-auto stops or fails, output:

Offload stopped

Route     <route>
Reason    <most direct persisted stop/failure reason>
Changed   <count>
Verify    <PASS|FAIL|N/A>
Cost      <actual cost|N/A>
Saved     <percentage|N/A>
Opus      not automatically invoked

Reason should prefer concrete persisted values such as:

OLD_TEXT_MISMATCH
EDIT_TARGET_NOT_FOUND
ARBITRATION_FAILED
VERIFY_FAILED
BUDGET_EXCEEDED
STATE_PERSISTENCE_FAILED

Do not turn a concrete error code into vague prose.

If Opus actually executed, do not print
`Opus not automatically invoked`.
Instead surface the actual report truth.

## Output discipline

The Bridge response should normally remain under about 10 lines.

Do not paste the complete cc-auto report unless the user explicitly asks for it.

Do not explain implementation details unless the user explicitly asks.

Do not continue solving the original coding task after the summary.

The execution right belongs to cc-auto for the entire `/offload` turn.

### Strict output rule — NO POST-SUMMARY CONTENT

After outputting the compact summary template (either "Offload completed" or "Offload stopped" block), the Bridge response MUST end immediately with no additional content whatsoever.

**Forbidden after the summary template:**

- Root cause analysis（根因分析）
- Diagnosis of what happened（诊断解释）
- Judgments about model capability（对模型能力下结论）
- Judgments about whether this is/is not an infrastructure defect（判断是否基础设施缺陷）
- Fix suggestions（修复建议）
- Recommendations for next run（建议下次运行）
- Interpretation of cc-auto internals（解释 cc-auto 内部行为）
- Speculation about audit trail gaps（猜测 audit trail 缺失原因）
- Any continuation of the original coding task（接管原任务，继续解决用户原需求）
- Any additional paragraph, sentence, or bullet point（任何额外段落、句子或要点）

**Reason field — prefer the most direct persisted reason:**

The `Reason` line must use the most specific persisted reason available from the run/report output — not just the broad stopReason category.

Example: if the report shows:
  `ARBITRATION_FAILED — STAGE_GATE_BLOCKED: DISCOVERY_STRUCTURED_OUTPUT_MISSING`

Prefer:
  `STAGE_GATE_BLOCKED: DISCOVERY_STRUCTURED_OUTPUT_MISSING`

Not just:
  `ARBITRATION_FAILED`

Always prefer concrete, specific error codes from the report over generic categories. If the report provides a `—`-delimited detail after the stop reason, use the most specific component that identifies the actual failure.
