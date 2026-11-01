# Theme

`theme` in `artifact.json` sets the tokens that the kit and every template read. All of it is optional.

```json
"theme": {
  "accent": "#0a7f5a",
  "display": "serif",
  "font": "humanist",
  "radius": 8,
  "scale": 1,
  "mode": "light",
  "neutrals": { "bg": "#f7f5f0", "card": "#ffffff", "text": "#1a1a1a", "muted": "#5c5c5c", "line": "#dddddd" },
  "neutralsDark": { "bg": "#14161a" }
}
```

- Colours are `#rrggbb`. `radius` is 0 to 32 pixels, and `scale` 0.85 to 1.25 for template type.
- `font` and `display` take `system`, `serif`, `rounded`, `humanist`, `grotesque`, `didone`, or the name of a family the bundle ships with `@font-face`.
- `neutrals` apply in light mode, `neutralsDark` in dark. `mode` fixes one, or `auto` follows the system.
- In your own CSS, use `var(--art-accent)`, `--art-on-accent`, `--art-bg`, `--art-card`, `--art-tx`, `--art-tx2`, `--art-sep`, `--art-radius`, `--art-ui`, `--art-display` and `--art-scale`, so a brand reaches your work too.
- A template's look is its `templateTheme`. Leave that alone and set `theme`, which wins over it.
- Articles use the accent, fonts and radius inside the article body. The review UI around it keeps its own look. Prototypes aren't themed: they're your own page.
- Text must meet WCAG AA on your colours: `contrast/text` warns if it doesn't.
