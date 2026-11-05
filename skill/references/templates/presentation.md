# Template: presentation

Slides: a canvas board of 16:9 frames, in order.

**Use it for:** A talk, a readout or anything presented to a room.

Start with `artifacts init --template presentation --slug <slug>`. Everything it copies is yours to change: the subject, the screens and the structure are your call, and you can skip any of this.

- Each frame is one `<section class="slide">` at 1280×720. There's no separate deck kind.
- One idea on a slide. The title says the point, not the topic: "Churn halved", not "Churn".
- Numbers go in `.art-stats`, bars in `.bars` (set each height), and two-sided slides in `.two`.
- `.slide.accent` is for section breaks. Use it sparingly, so it still means something.
- Publishing gives you comments per slide.

Replace the `summary` in `artifact.json` before publishing, and see `../theme.md` for colours and fonts.
