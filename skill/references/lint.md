# Lint rules

| Rule                    | Fix                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `manifest/schema`       | Fix the field it names in `artifact.json`.                                                        |
| `manifest/summary`      | Add `summary` to `artifact.json`: what it holds and why it mattered, up to 280 characters.        |
| `files/missing`         | Add the file, or fix the path.                                                                    |
| `files/absolute`        | Ship the font or image in the bundle and use a relative path.                                     |
| `files/outside`         | Move the file inside the folder that holds `artifact.json`.                                       |
| `frames/ids`            | Give every frame a unique `data-frame` of `a-z`, `0-9` and `-`.                                   |
| `frames/renamed`        | Put the old id back. If it has open comments this is an error, because they'd be orphaned.        |
| `frames/overlap`        | Move controls apart.                                                                              |
| `frames/clipped`        | Shorten the label or let it wrap.                                                                 |
| `frames/home-indicator` | Keep text and controls clear: use `.art-safe`.                                                    |
| `frames/offscreen`      | Keep content inside the frame's box.                                                              |
| `frames/deterministic`  | Seed randomness, and don't draw the clock.                                                        |
| `weight/image`          | Start from a smaller image.                                                                       |
| `weight/frame`          | Reduce what the frame draws.                                                                      |
| `weight/bundle`         | Remove what you don't need.                                                                       |
| `contrast/text`         | Darken or lighten the text to reach 4.5:1.                                                        |
| `article/blocks`        | Two headings have the same text; reword one.                                                      |
| `data/api`              | Use the kit's data API instead of `localStorage`, `indexedDB`, cookies or `fetch` to other hosts. |
| `data/fixtures`         | Add `fixtures/data.json` for frames that read data.                                               |
| `backend/size`          | Keep the bundled backend under 1 MB.                                                              |
| `backend/network`       | Backends have no network, timers or Node built-ins.                                               |
