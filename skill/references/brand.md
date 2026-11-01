# Fitting Artifacts to a brand

Use this when someone asks you to make Artifacts match their brand guide. Everything starts with a good default, so this is optional.

For colours, corners and built-in fonts, a person can also do this by hand in Settings, Brand. You're needed for a brand guide, or for font files.

## 1. Write `brand.json`

Put it in a folder with any font files. Read the guide for real values, and don't invent them.

```json
{
  "name": "Acme",
  "theme": {
    "accent": "#d2452d",
    "display": "Acme Serif",
    "font": "Acme Sans",
    "radius": 6,
    "neutrals": {
      "bg": "#f7f4ef",
      "card": "#ffffff",
      "text": "#1a1712",
      "muted": "#5f584d",
      "line": "#ddd6c9"
    }
  },
  "fonts": [
    { "family": "Acme Sans", "weight": "400", "src": "fonts/acme-sans.woff2" },
    { "family": "Acme Serif", "weight": "700", "src": "fonts/acme-serif.woff2" }
  ]
}
```

The fields under `theme` are in `theme.md`. `font` and `display` name a family in `fonts`, or one of `system`, `serif`, `rounded`, `humanist`, `grotesque`, `didone`.

## 2. Fonts and licences

Lint bans external fonts, so brand fonts ship inside every published artifact, where anyone who can view it can download them. **Check the licence allows embedding and redistribution.** Many desktop and some web licences don't. If you can't tell, ask, and use a system stack in the meantime. Keep to the weights the brand needs: at most 8 files of 4 MB each, preferably WOFF2.

## 3. Preview and fix

```
artifacts brand preview brand.json
```

Read the contact sheet it prints. Check that text passes contrast, the accent works as a background with the text on it, and it looks like the brand rather than a recoloured template. Repeat until it does.

## 4. Propose

```
artifacts brand propose brand.json
```

This publishes a sample of every template and records a proposal. Give the person the link. **Only a person can apply a brand, in Settings, Brand.** You can't, and nothing changes until they do.

Once applied, every render uses it. A project's `theme` in `artifact.json` still wins, and a template's own look gives way to it. The CLI keeps a cached copy for working offline. Articles use the accent and radius; they name the brand's fonts but show a system font, because the viewer doesn't load publishers' font files.
