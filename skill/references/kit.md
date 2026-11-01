# The kit

`artifacts init` copies the kit to `vendor/artifacts-kit/`, pinned to this CLI's version. List its files in a canvas page's `styles` and `scripts`.

**Device frames** (`frames.js`): `<a-phone>`, `<a-ipad>`, `<a-watch>`, `<a-mac>`, `<a-browser>`. Give one a `data-frame` id. `time="9:41"` sets the clock and `dark` the theme.

```html
<a-phone data-frame="welcome" data-title="Welcome">
  <main class="art-safe" style="padding-inline:20px">
    <h1 class="art-title">Welcome</h1>
  </main>
</a-phone>
```

**Tokens** (`tokens.css`): set `theme` in `artifact.json` (`references/theme.md`), and use `var(--art-accent)` and the other tokens in your own CSS, so a brand reaches your work.

**Primitives:** `.art-safe` keeps content clear of the status bar and home indicator. Also `.art-list`, `.art-row`, `.art-btn`, `.art-title`, `.art-seg`.

**Components** (`components.css`): `.art-nav` with `.art-iconbtn` and `.art-grow`, `.art-tabbar` (`aria-current` on the active tab), `.art-sheet`, `.art-toggle` (`role="switch"`, `aria-checked`), and `.art-stats`.

**Icons** (`icons.js`): `<a-icon name="search" size="24"></a-icon>`. Names: search, arrow-left, chevron-right, check, house, settings, bell, user, plus, x, heart, star, share, camera, image, message-circle, calendar, bookmark, menu, ellipsis, pencil, play, download, sliders-horizontal, map-pin. They take the text colour.

**Templates:** `artifacts init --template <name>` copies an editable starter: `design-review`, `presentation`, `case-study`, `prd`, `rfc`, `research-report` or `weekly-status`. Each has a guide in `references/templates/`. They're starting points, so skip them whenever your own design serves better.

**Article components** work from Markdown. Leave a blank line between a table and the closing `:::`, or the fence reads as a table row:

```markdown
:::stats
- **41%** fewer steps
- **2.3×** faster
:::

:::compare
| Option one    | Option two    |
| ------------- | ------------- |
| Where it wins | Where it wins |

:::

:::steps
1. **First.** What happens.
2. **Then.** What happens next.
:::
```

**Rules that lint enforces:** seed any randomness, never draw `Date.now()`, ship every font and image in the bundle, and keep touch targets apart.
