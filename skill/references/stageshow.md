# Stageshow in a canvas

Stageshow is a third-party skill for product demos, feature cards and cursor walkthroughs. `artifacts setup` offers it, or run `artifacts skill install --stageshow`. If it isn't installed, build with the kit and don't ask for it.

It suits presentations, case studies and launch work. For an ordinary app mock, use the kit's device frames.

Build the scene the way Stageshow's skill says. This guide covers what happens after that, because Stageshow expects a React app and a canvas page isn't one.

## Plan the frames

Reviewers see still images, and comments attach to those stills, so a person can't comment on a moment in an animation.

- Make one still frame for each beat worth a comment. A still is the same scene with that beat's state.
- Add one `data-live` frame that plays the whole scene, with `play="once"` so its payoff holds. Reviewers open it with Try it.
- Skip `compact`: a frame has one size, and the viewer scales it.

## Bundle it

Build one classic script and one stylesheet with relative paths. With Vite, in a folder outside the artifact:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    lib: {
      entry: "src/main.tsx",
      formats: ["iife"],
      name: "Scenes",
      fileName: () => "scenes.js",
      cssFileName: "scenes",
    },
    cssCodeSplit: false,
    outDir: "dist",
  },
});
```

Copy the output into the artifact, and list the stylesheet in the page's `styles`. Leave `scripts` alone: those run in `<head>`, before the page has anywhere to mount.

The server keeps only what the page uses, so `artifacts pull` brings back the build and not the scene's source. Commit the source, or nobody can address comments on it later.

## Mount it

`main.tsx` mounts every root it finds, because Try it loads only the live frame. Decide whether to play before you mount, and use `flushSync`, because the render takes its picture as soon as the page has loaded. `Stage` only finds reduced motion in an effect, which is too late.

```tsx
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { POSTER, Scene } from "./scene";

const moving = !matchMedia("(prefers-reduced-motion: reduce)").matches;

const mount = (id: string, beat: Partial<State>, play = false) => {
  const root = document.getElementById(id);
  if (root) flushSync(() => createRoot(root).render(<Scene beat={beat} play={play} />));
};

mount("scene-live", POSTER, moving);
mount("scene-comment", { pinned: true });
```

In the scene, a `Stage` with no script is a still from its first frame:

```tsx
<Stage initial={initial} poster={{ ...initial, ...beat }} script={play ? script : undefined} play="once">
```

## The board

Put each root in a frame in the board's HTML. React can't create the frame. The script goes inside the live frame, or Try it drops it.

```html
<div data-frame="demo" data-device="none" data-title="The demo" data-live style="width:720px;height:340px;overflow:hidden">
  <div id="scene-live"></div>
  <script src="../scenes.js" defer></script>
</div>
<div data-frame="comment" data-device="none" data-title="A comment lands" style="width:720px;height:340px;overflow:hidden">
  <div id="scene-comment"></div>
</div>
```

The frame's size must match the `Stage`.

## The poster

Every scene needs a `poster` that tells the story on its own, because that's what the live frame shows on the board. Anyone with Reduce Motion on sees it in Try it too.

## What the sandbox blocks

Read "The sandbox" in `references/micro-apps.md` if you have it. In short: no `localStorage` or cookies, no `eval`, no workers, no WebAssembly, no fonts in `data:` URLs, and nothing from another host. Ship every font and image in the bundle.

## The look

- Use the `light`, `dark` or `blueprint` theme, and map the product's tokens onto the kit's.
- Stageshow's quiet grays often miss 4.5:1, which `contrast/text` reports as a warning. Darken real words until it's quiet.
- Use the product's own name and words. Don't copy a real product's icons or logos into your work unless you have the right to: Stageshow's licence doesn't cover its app icons and brand marks.

Then run the gate as usual, and look at the live frame in `artifacts dev` before you publish. A faint word that the story is about may stay a warning. Say so when you hand it over.
