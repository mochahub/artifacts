# The manifest

`artifact.json` sits next to the source: in `.artifacts/work/<slug>/` by default, or wherever you ran `artifacts init --in-repo`.

```json
{
  "project": "camerabuddy",
  "projectName": "Camera Buddy",
  "slug": "roadmap",
  "title": "Camera Buddy roadmap",
  "summary": "The plan, seven research reports and 26 mock screens. Wi-Fi pairing won over Bluetooth; the plan starts with the live view.",
  "tags": ["roadmap", "camera", "wi-fi"],
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

- `summary`: required by lint, up to 280 characters. Say what the artifact holds and why it mattered, including what was decided or rejected, because a later agent reads this first and often reads nothing else. Be specific: "Six art style studies for the forest level; gouache won" beats "Art styles". It matters most for image-only work, which has little other text. Don't mention instructions for agents.
- `tags`: up to 8, each up to 32 characters. Use words someone would search for.
- `project` and `slug`: `a-z`, `0-9` and `-`, up to 40 characters.
- `visibility`: `me` or `org`. Leave it out for the organization's default.
- Page ids: `a-z`, `0-9` and `-`. Changing one breaks its link.
- Paths are relative, and stay inside this folder.

**Page kinds:** `article` (Markdown), `canvas` (HTML boards), `prototype` (one live HTML page, with `device` and optional `title`), `gallery` (optional `title`, and `items` with `src` and `caption`; images or video).

**Canvas boards:** every screen is an element with `data-frame="id"`, and optionally `data-device` (`iphone`, `ipad`, `watch`, `mac`, `browser`, `none`), `data-title`, and `data-live` to offer Try it.

**Articles:** GFM, plus `> [!NOTE]` callouts, an image followed by an italic line as a figure, Mermaid code blocks, `::frame{ref="page/board/frame"}`, `::chart{src="charts/x.json"}` and `{Verified}` / `{Unverified}`.

A chart file: `{ "type": "bar", "labels": ["A", "B"], "series": [{ "name": "Use", "values": [1, 2] }] }`.
