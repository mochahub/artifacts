## What and why

<!-- What changes, and why. Link the issue if there is one. -->

## Checklist

- [ ] The title is a Conventional Commit, such as `fix(viewer): keep the sheet above the keyboard`. `feat` and `fix` set the release.
- [ ] Every commit is a Conventional Commit. CI checks them.
- [ ] Tests cover the change, and a bug fix has a test that fails without it. `bun run test` passes (and `bun run e2e` for viewer changes).
- [ ] `bun run lint` passes.
- [ ] The contract documents (02 to 05 and 07 to 09 in `docs/implementation/`) are updated in this PR for any route, flag, variable, table, lint rule or limit that changed.
- [ ] A schema change comes with a generated migration that only adds.
- [ ] Viewer changes follow the design rules in `docs/implementation/06-viewer.md`: yellow for people, violet for agents, and none of the forbidden patterns (edge bars, sparkles, tinted pills, middle dots, arrows in link text, gradient washes).
- [ ] A new dependency is explained above.
