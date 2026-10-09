# Working in Backroom

The habits of every agent working in this repository, whoever assigned the work.

- Before you report ready, review your own diff (with a subagent or a review workflow, if your harness has one) and fix what it finds.
- Turn every review finding into a test that fails without the fix: a unit test where one can show it, a rehearsal state only for focus, scroll or layout.
- Build and rehearse in a worktree of your own (`git worktree add`), never in the checkout the live service runs from: `npm run build:web` there swaps the user's live page for your unfinished work, and for anyone else's in that checkout.
- Run the checks before you report ready, in that worktree; say what you ran and what it printed, and name any check you skipped:
  - `npm install` first (a fresh worktree has no `node_modules`);
  - `npm run check` (the service's types, and the tests, which run against the fake T3 adapter);
  - `npm --workspace web run typecheck` when the page changed (`npm run check` does not cover `web/`);
  - browser rehearsals only when the change reaches the page (`web/`, the engine, host or routes the page reads, or the rehearsal scripts), none for docs, test-only changes or internals the unit tests cover: `npm run build:web`, then `node scripts/rehearse.ts --step ui|room|keys --as <your rooms-browser key> --port <a free port>` for the step that covers the change (keys for keyboard, focus, scroll and layout; ui and room for what the engine and the page show; all three when unsure), each once; they may run at the same time on ports and data folders of their own. Each step starts a throwaway service of its own (`ROOMS_ADAPTER=fake`, its own data folder) on the page just built, never the live service on :4400 or the user's rooms;
  - never rerun a green step to see it pass again: a flaky state is fixed or cut, not repeated;
  - after merging main, `npm run check` again, and a step again only if the merge touched what it covers.
- Reviewers run `npm run check` in a worktree of their own, read the writer's gate logs and screenshots, run once the step the change targets, and spend the rest of the review trying the change by hand on a throwaway service.
- End every answer with a Handoff: the paths, the branch and the commit where your work is, and anything left unintegrated.
