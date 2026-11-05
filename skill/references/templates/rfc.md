# Template: rfc

A proposed technical change, open for comment.

**Use it for:** A change others need to weigh in on, especially one that's hard to undo.

Start with `artifacts init --template rfc --slug <slug>`. Everything it copies is yours to change: the subject, the screens and the structure are your call, and you can skip any of this.

- The first paragraph says what you propose and what you need from readers.
- Be precise enough that someone else could build it.
- Compare at least one real alternative with `:::compare`, including doing nothing.
- Plan the rollout and how to undo it, in `:::steps`.
- Ask specific questions. People can comment on any paragraph.

Replace the `summary` in `artifact.json` before publishing, and see `../theme.md` for colours and fonts.
