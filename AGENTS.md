# Working in Backroom

The habits of every agent working in this repository, whoever assigned the work.

- Before you report ready, review your own diff (with a subagent or a review workflow, if your harness has one) and fix what it finds.
- Turn every review finding into a test that fails without the fix.
- Build and rehearse in a worktree of your own (`git worktree add`), never in the checkout the live service runs from: `npm run build:web` there swaps the user's live page for your unfinished work, and for anyone else's in that checkout.
- Run the checks before you report ready, in that worktree; say what you ran and what it printed, and name any check you skipped:
  - `npm install` first (a fresh worktree has no `node_modules`);
  - `npm run check` (the service's types, and the tests, which run against the fake T3 adapter);
  - `npm --workspace web run typecheck` when the page changed (`npm run check` does not cover `web/`);
  - for what the page shows, `npm run build:web`, then `node scripts/rehearse.ts --step ui|room|keys --as <your rooms-browser key> --port <a free port>`: each step starts a throwaway service of its own (`ROOMS_ADAPTER=fake`, its own data folder) on the page just built, never the live service on :4400 or the user's rooms. One green run per step; five in a row of each when you change `scripts/rehearse.ts` or `scripts/rehearse-keys.ts`.
- End every answer with a Handoff: the paths, the branch and the commit where your work is, and anything left unintegrated.
