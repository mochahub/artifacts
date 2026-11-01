# Template: design-review

A design for people to react to: mocks of a journey, with a decision to make.

**Use it for:** Reviewing screens or flows, comparing variants, or asking for sign-off on a direction.

Start with `artifacts init --template design-review --slug <slug>`. Everything it copies is yours to change: the subject, the screens and the structure are your call, and you can skip any of this.

- One board per journey. Keep frames in flow order, left to right, so a reader can follow it without you.
- Title every frame (`data-title`) with what happens there, not the screen's internal name.
- Put variants side by side on their own board, changing one thing at a time.
- Start with the brief frame: who it's for, what changed since last time, and the decision you're asking the reviewer for.
- Use real content wherever you have it. Replace everything in the sample, and add or remove frames freely.

Replace the `summary` in `artifact.json` before publishing, and see `../theme.md` for colours and fonts.
