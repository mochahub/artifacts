# The manifest

`artifact.json` sits next to the source.

```json
{
  "project": "camerabuddy",
  "projectName": "Camera Buddy",
  "slug": "roadmap",
  "title": "Camera Buddy roadmap",
  "visibility": "org",
  "pages": [
    { "id": "plan", "kind": "article", "src": "README.md" },
    {
      "id": "research-01",
      "kind": "article",
      "src": "research/01.md",
      "group": "Research",
      "title": "Wi-Fi API"
    },
    {
      "id": "mocks",
      "kind": "canvas",
      "title": "Mocks",
      "boards": [
        { "id": "shoot", "title": "Shoot", "subtitle": "Taking the picture", "src": "boards/shoot.html" }
      ],
      "styles": ["mock.css"],
      "scripts": ["vendor/artifacts-kit/frames.js"]
    }
  ]
}
```

- `project` and `slug`: `a-z`, `0-9` and `-`, up to 40 characters.
- `visibility`: `me` or `org`. Leave it out for the organization's default.
- Page ids: `a-z`, `0-9` and `-`. Changing one breaks its link.
- Paths are relative, and stay inside this folder.

**Page kinds:** `article` (Markdown), `canvas` (HTML boards), `prototype` (one live HTML page, with `device`), `gallery` (`items` with `src` and `caption`).

**Canvas boards:** every screen is an element with `data-frame="id"`, and optionally `data-device` (`iphone`, `ipad`, `watch`, `mac`, `browser`, `none`), `data-title`, and `data-live` to offer Try it.

**Articles:** GFM, plus `> [!NOTE]` callouts, an image followed by an italic line as a figure, Mermaid code blocks, `::frame{ref="page/board/frame"}`, `::chart{src="charts/x.json"}` and `{Verified}` / `{Unverified}`.

A chart file: `{ "type": "bar", "labels": ["A", "B"], "series": [{ "name": "Use", "values": [1, 2] }] }`.
