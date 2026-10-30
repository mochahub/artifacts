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

**Tokens** (`tokens.css`): override `--art-accent`, `--art-bg`, `--art-card`, `--art-tx`, `--art-tx2`, `--art-sep` and `--art-radius` in your own CSS, so the project looks like itself.

**Primitives:** `.art-safe` keeps content clear of the status bar and home indicator. Also `.art-list`, `.art-row`, `.art-btn`, `.art-title`, `.art-seg`.

**Rules that lint enforces:** seed any randomness, never draw `Date.now()`, ship every font and image in the bundle, and keep touch targets apart.
