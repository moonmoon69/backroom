# Can Jev split one message into assignments?

Test date: 2026-09-24 · Model: `jev-1.13.0` · Probe: [`scripts/probe-jev-split.ts`](../scripts/probe-jev-split.ts)

## Method

Jev answers only bounded questions (Choice and Noul), so it never writes instruction text. Code does the text work:

1. Code finds every occurrence of a participant name: `@alice` (URLs and paths excluded) and plain `alice`.
2. Jev answers, per occurrence: is the user giving this person a task here, or only mentioning them (`assign` / `mention` / `unclear`), with the occurrence marked `⟦ ⟧` inside the message.
3. Jev answers, per ordered pair of participants: must X's task from this message wait for Y's task from this message (Noul).
4. Code cuts the text at the occurrences marked `assign` (adjacent addresses joined only by "and"/","/"&" share one assignment), keeps waits between groups that exist, and applies the same thresholds as the earlier routing probe: Choice confidence ≥ 0.80, Noul ≥ 0.85 for a wait, ≤ 0.15 for no wait. Anything between asks the user. A wait cycle also asks.

Every case is also run through the deterministic parser (`src/parser/explicit.ts`) for comparison. Three participants (alice, bob, carol), no existing tasks.

## Results

| Set | Cases × runs | Jev exact | Jev asked | Jev wrong but confident | Rules exact | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development ([cases](jev-split-cases.json), [results](jev-split-cases-results.json)) | 15 × 2 | 28/30 | 2 | 0 | 9/15 | 264 ms |
| Holdout ([cases](jev-split-holdout.json), [results](jev-split-holdout-results.json)) | 10 × 2 | 20/20 | 0 | 0 | 6/10 | 283 ms |

Both runs of each case agreed. The two "asked" results are the same case (`group_then_single`: "@alice and @bob, each independently estimate…; @carol then pick the lower estimate"), where the wait scored 0.84 against the 0.85 bar: correct direction, just under the threshold. Total cost ≈ $0.004 for 50 requests (92k input tokens at the documented $0.042/M; output is free). About 9–13 questions per message.

Where the rules fail and Jev succeeds:

- **Reference after a verb or preposition not in the list:** "take a look at @alice changes", "double-check the numbers @alice posted", "don't start until @alice has pushed".
- **Negation:** "@bob don't touch alice's files", where the rules add a wait because alice is named.
- **Waits phrased with pronouns or plurals:** "once she's done", "review both once they're finished", "can test it afterwards".
- **Addresses without @ or a comma:** "alice please build it and bob can test it afterwards".
- **Forward waits:** "@alice, when bob is done with the schema, migrate the data. @bob finish the schema first". The room's `message.create` currently only allows waiting for earlier assignments, so this would need a small extension (any order, rejecting cycles).
- **Pleasantries:** "@carol thanks for the help earlier!", which the rules turn into an assignment.

The text spans code cut from Jev's decisions were right. They only needed the same trimming of dangling joiners ("and", "then", a leading comma) that the rule parser already does.

## Caveats

- The development cases were written knowing where the rules are weak, so the development comparison flatters Jev. The holdout was written before running and nothing was tuned afterwards, but it is small and author-labeled. Neither set is a calibrated error rate.
- Only three participants and short messages. The question count grows with occurrences plus pairs (n·(n−1)); with 8 participants that is 56 wait questions per message. That is affordable, but the pair questions could be limited to people Jev marked `assign`, at the cost of a second request.
- It has not been tested with messages that also contain `/after taskN` or other existing tasks, with long multi-paragraph messages, or with real dictation output.

## Suggested use

Rules run on every keystroke and highlight what they will do, free and instantly. Jev is an optional second opinion when the message has signals the rules handle poorly: plain names without @, pronouns after "once"/"when"/"after", "both"/"they", or negation near a name. Its result is shown as a diff against the rule plan ("Jev: bob waits for alice"), and the user accepts it with one click, which rewrites the text (e.g. inserts `/after @alice`), so the text stays the single source of truth. At about 270 ms and under $0.0001 per message this can run on a typing pause rather than on send.
