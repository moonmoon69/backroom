# Jev routing and sequencing feasibility

Test date: 2026-09-21  
Requested model: `jev-1.13.0`  
Scope: synthetic routing decisions through the real TypeSafe API; no T3 sessions or queue execution.

Design update: the PRD now defines an action catalog with complete direct UI controls and optional Jev mapping to those actions. The measurements below describe the earlier broad question set. They have not been rerun for the action-first design and must not be presented as validation of it.

## Result

Jev can supply the bounded decisions needed for a room to route a request and record prerequisites. The tested question set recognized direct addressing, spoken aliases, independent fan-out, a review after one task, and a comparison after both tasks.

The first implementation should retain explicit recipient/timing controls and a clarification path. Free-form interpretation is not ready to run unattended based on this experiment. Some results varied between repeated calls, and one earlier question version confidently chose a prerequisite for an ambiguous pronoun. Code-level reference validation caught that case in the final version.

Across the final v3 development and held-out runs:

- 21 of 28 outcomes exactly matched the predefined expectation.
- 13 requests produced a complete automatically actionable plan; all 13 matched the fixture expectation.
- Of 19 runs expected to produce an actionable plan, 13 did so; six unnecessarily asked for clarification.
- One additional mismatch unnecessarily asked about a quoted example instead of treating it as a note.
- These are small, author-labeled synthetic samples. Zero observed incorrect actionable plans is not a guarantee or a calibrated error rate.

## API and design facts verified

The probe sends an authenticated `POST` to `https://api.typesafe.ai/v1/systemone`. `JEV_API_KEY` is read locally and supplied in the bearer header. Requests contain only the synthetic fixture message, roster, task list, and questions. No repository contents, real T3 transcripts, or other `.env` values were sent.

Choice options and Noul propositions map naturally to application decisions. The API returns all question answers together. Each question must be self-contained because sibling answers are unavailable during its evaluation. Question IDs identify results but do not communicate their meaning to the model. [API reference](https://docs.typesafe.ai/api), [parallel question pattern](https://docs.typesafe.ai/patterns/fan-out).

The test retains the original instruction and asks Jev to choose recipients/timing and evaluate known task IDs. Jev does not produce rewritten instructions, arbitrary dependency IDs, or summaries. This follows the documented bounded-decision design. [Function-calling example](https://docs.typesafe.ai/cookbooks/function_calling), [model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).

## Method

The development set contains 16 cases. Each API request evaluates one message against three participants and two task candidates. Its 13 questions comprise one input-kind Choice, a recipient and timing Choice per participant, and one dependency Noul per participant/task pair.

Expected results are defined in the fixture file before that run. A pass requires the correct overall state and, for actionable requests, the exact recipient set, timing mode, and prerequisite set. A correct model-selected dependency that is blocked by the application gate is still an exact-outcome failure when the expected result was actionable.

The policy uses Choice confidence ≥ 0.80, Noul ≥ 0.85 for a prerequisite, and Noul ≤ 0.15 for absence. Intermediate values trigger clarification. These settings were chosen as initial experimental thresholds and were not lowered to improve the scores. They are not interchangeable probabilities: Choice confidence is a distribution statistic, and Noul has no separate confidence property. [Confidence documentation](https://docs.typesafe.ai/confidence).

After v3 was fixed, six new phrasing cases were authored and each sent twice. Neither questions nor thresholds were changed using those results. The holdout is a small phrasing check, not an independently labeled or blinded evaluation.

## Runs and cost

| Run | Version | Requests | Exact expected outcomes | Median client latency | Raw evidence |
| --- | --- | ---: | ---: | ---: | --- |
| Initial conditional-work smoke test | v1 | 3 | 0/3 | 661.14 ms | [JSON](jev-smoke.json) |
| Simplified recipient wording smoke test | v2 | 3 | 2/3 | 642.95 ms | [JSON](jev-smoke-v2.json) |
| Development suite | v2 | 16 | 13/16 | 608.36 ms | [JSON](jev-results-v2.json) |
| Refined input-kind wording and reference guard | v3 | 16 | 14/16 | 600.39 ms | [JSON](jev-results-v3.json) |
| New phrasing, two repeats per case | v3 | 12 | 7/12 | 634.78 ms | [JSON](jev-holdout-v3.json) |

All 50 API requests completed without a recorded HTTP/transport/schema error. There were no automatic request retries. Total reported usage was 176,302 input tokens and 22,383 output tokens. Median latency over all calls was 613.60 ms; latency includes the client's network/request time and is not a server-only inference benchmark.

At the documented input price of $0.042 per million tokens and free output, the estimated total is **$0.007405**. This is an estimate from usage fields and the published rate, not an invoice. [Model pricing and version information](https://docs.typesafe.ai/models).

## What changed between versions

**v1:** Recipient instructions used “NEW work” and an indirect distinction between assignments and mentions. Jev identified `after_tasks` but hesitated over whether the delayed reviewer was a recipient. All three smoke cases were held for clarification. This was a failed wording experiment, not a failed API connection.

**v2:** The question became “Is the user asking this participant to do something, either now OR later?” and explicitly counted conditional assignments. The main delayed-review and fan-in cases worked. However, `@sol2 review once it is done` selected `task41` with dependency Noul 0.87 even though the fixture had two possible tasks and no selected antecedent. The unguarded interpreter accepted that plan incorrectly. Manual hold and a mixed negative/positive instruction caused unnecessary clarification.

**v3:** Input-kind wording more clearly distinguished new held work from controlling an existing task, and exclusion of a participant from cancelling existing work. A conservative code check rejected a multi-candidate prerequisite reference unless the message contained a recognizable author/topic or the room had an explicit focused task. That check stopped the ambiguous-pronoun case even though Jev still preferred `task41`.

The reference check is an illustrative lexical guard, not a complete semantic resolver. It establishes that confidence alone is insufficient. Production must ground every dependency and handle multiple tasks per author, quoted names, conflicting references, and changing room state.

## Final development outcomes

| Case | Observed outcome |
| --- | --- |
| Direct review now | Correct: sol2, now |
| Review after sol1's parser task | Correct: sol2, after task41 |
| Spoken “Sol two … sol one …” | Correct: sol2, after task41 |
| Two independent recipients | Correct: sol1 and sol2, now |
| Compare after both tasks | Correct: claude, after task41 and task43 |
| Room note | Correct: note |
| Quoted command example | Unnecessary clarification |
| Missing prerequisite owner sol3 | Correct: clarification |
| Ambiguous “it” | Correct: clarification enforced by code |
| Unique “reviewer” and “implementer” roles | Correct: sol2, after task41 |
| Cancel a queued review | Correct control classification; target selection and cancellation were not tested |
| Save a new review for manual release | Unnecessary clarification |
| Tell sol1 not to act and sol2 to review now | Correct: sol2, now |
| Tomorrow morning | Correct clarification because calendar scheduling is out of scope |
| Unaddressed task with no unique recipient | Correct: clarification |
| Historical assistant text containing a command | Correct: only the current user request was routed |

## Held-out outcomes and remaining friction

| New phrasing | Repeat 1 | Repeat 2 |
| --- | --- | --- |
| Voice-style review “as soon as sol one has wrapped up” | Correct plan | Correct plan |
| Reviewer checks after authentication architecture is complete | Unnecessary clarification | Unnecessary clarification |
| Busy sol1 gets an explicit new task now | Unnecessary clarification | Correct plan |
| Dependency clause comes before `@sol2` | Unnecessary clarification | Correct plan |
| “Leave it on hold until I say go” | Unnecessary clarification | Correct plan |
| Unknown alias `sol10` | Correct clarification | Correct clarification |

Much of the remaining friction comes from composing the answers conservatively. Uncertainty about a participant who should not receive the task can block the whole message. A speculative dependency answer can also introduce unnecessary friction for a manually held task. Those are application-policy issues as well as model-question issues; the tables report the combined behavior rather than attributing every mismatch solely to Jev.

The next iteration should exploit explicit recipient chips, ask only semantically relevant questions, and evaluate reference resolution separately. It should be tested on a fresh larger set, rather than repeatedly adjusting thresholds until these fixtures pass. The current 7/12 held-out result does not meet the PRD's proposed release gate.

## Reproduce

Requirements: Python 3.10+ and an authorized TypeSafe key. No SDK installation is needed. Keep `JEV_API_KEY` in the project `.env` or process environment. The script reads the file without executing shell statements.

```sh
python3 scripts/probe_jev.py --output research/jev-rerun.json
python3 scripts/probe_jev.py --cases research/jev-holdout-cases.json --repeat 2 --output research/jev-holdout-rerun.json
```

Each command makes new billable API requests. Repetitions are bounded to three. Reports save full synthetic requests and responses, question version, script hash, expected outcomes, actual interpretations, latency, and usage. They do not save authorization headers or keys. Use a new output name to retain the existing evidence.

The script returns nonzero when an expected outcome differs or a request fails. The supplied evidence therefore contains intentional research failures; it is not a passing production test suite. The latest script generates v3 questions. Earlier wording remains available in the full requests stored in the v1/v2 reports.

## Not tested

- A real T3 adapter, its authentication, or native provider execution.
- Queue persistence, retries, restart recovery, or task completion correlation.
- Creation of prospective task nodes from a compound multi-step sentence.
- Calendar conditions, “after either,” alias pools, or a large task roster.
- Audio transcription, multilingual accuracy, full-history delivery, or summarization.
- Cancellation target resolution or an actual permission-response workflow.

The experiment establishes that the API and decision pattern are usable for the proposed product. It does not establish that the room, scheduler, or unrestricted natural-language sequencing is complete.
