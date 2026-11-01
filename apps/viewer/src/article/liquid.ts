import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";

/** Each picture's brightness, as a small grid of 0 to 1 values read once. */
const GRID_W = 32;
const GRID_H = 15;
/** How far the page must move before the chrome reacts, so a resting thumb doesn't flicker it. */
const SCROLL_SLOP = 6;
/** Near the top the chrome stays out, and the last screen brings it back. */
const TOP = 80;
const END = 40;
/** Two thresholds, so a bar over a mid-grey picture doesn't flip on every frame. */
const DARK_BELOW = 0.4;
const LIGHT_ABOVE = 0.55;
/** Under this share of a bar over a picture, the page behind it is mostly paper. */
const MIN_COVER = 0.3;

export type Tone = "dark" | "light";
type Box = Pick<DOMRect, "top" | "bottom" | "height">;

/** Whether the chrome should be drawn back after this scroll. Scrolling down does it; up undoes it. */
export function nextReading(reading: boolean, y: number, last: number, atEnd: boolean) {
  if (y < TOP || atEnd || y < last - SCROLL_SLOP) return false;
  return y > last + SCROLL_SLOP ? true : reading;
}

/** The bar's ink for this brightness. Null is paper, so the theme decides. */
export function nextTone(tone: Tone | null, lum: number | null): Tone | null {
  if (lum === null) return null;
  if (lum < DARK_BELOW) return "dark";
  return lum > LIGHT_ABOVE ? "light" : tone;
}

/** The average brightness of the grid rows a bar covers, or null if it's barely over the picture. */
export function brightnessUnder(grid: Float32Array, picture: Box, bar: Box) {
  const top = Math.max(bar.top, picture.top);
  const bottom = Math.min(bar.bottom, picture.bottom);
  if (bottom <= top || (bottom - top) / bar.height < MIN_COVER) return null;
  const first = Math.floor(((top - picture.top) / picture.height) * GRID_H);
  const last = Math.ceil(((bottom - picture.top) / picture.height) * GRID_H);
  let sum = 0;
  let count = 0;
  for (let row = first; row < last; row++) {
    for (let column = 0; column < GRID_W; column++) {
      sum += grid[row * GRID_W + column] ?? 0;
      count += 1;
    }
  }
  return count ? sum / count : null;
}

// `?via=app` is the same picture from this origin: a redirect to the bucket would taint the canvas (06).
async function readGrid(src: string) {
  const url = new URL(src, location.href);
  url.searchParams.set("via", "app");
  const answer = await fetch(url, { credentials: "same-origin" });
  if (!answer.ok) return null;
  const bitmap = await createImageBitmap(await answer.blob());
  const canvas = document.createElement("canvas");
  canvas.width = GRID_W;
  canvas.height = GRID_H;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, GRID_W, GRID_H);
  const { data } = context.getImageData(0, 0, GRID_W, GRID_H);
  const grid = new Float32Array(GRID_W * GRID_H);
  for (let i = 0; i < grid.length; i++) {
    const [r, g, b] = [data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0];
    grid[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  return grid;
}

type Options = {
  capsule: RefObject<HTMLElement | null>;
  bar: RefObject<HTMLElement | null>;
  body: RefObject<HTMLElement | null>;
  /** Bumps when the article's HTML is in, which is when its pictures exist. */
  loaded: number;
};

/** The reader's glass: draws the chrome back on the way down, and fits its ink to the picture behind it. */
export function useLiquidChrome({ capsule, bar, body, loaded }: Options) {
  useEffect(() => {
    const root = document.documentElement;
    const grids = new Map<HTMLImageElement, Float32Array>();
    const tones = new Map<HTMLElement, Tone | null>();
    let last = scrollY;
    let queued = false;

    const paint = () => {
      queued = false;
      for (const surface of [capsule.current, bar.current]) {
        if (!surface) continue;
        const box = surface.getBoundingClientRect();
        let sum = 0;
        let count = 0;
        for (const [picture, grid] of grids) {
          const lum = brightnessUnder(grid, picture.getBoundingClientRect(), box);
          if (lum === null) continue;
          sum += lum;
          count += 1;
        }
        const tone = nextTone(tones.get(surface) ?? null, count ? sum / count : null);
        tones.set(surface, tone);
        if (tone) surface.dataset.tone = tone;
        else delete surface.dataset.tone;
      }
    };
    const queue = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(paint);
    };

    // A picture is read when it's about to matter, because reading it downloads it a second time.
    const near = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const picture = entry.target as HTMLImageElement;
          near.unobserve(picture);
          readGrid(picture.currentSrc || picture.src)
            .then((grid) => {
              if (grid) grids.set(picture, grid);
              queue();
            })
            // A picture we can't read leaves the ink to the theme.
            .catch(() => {});
        }
      },
      { rootMargin: "100% 0px" },
    );
    for (const picture of body.current?.querySelectorAll("img") ?? []) near.observe(picture);

    const onScroll = () => {
      const y = scrollY;
      const atEnd = y + innerHeight > root.scrollHeight - END;
      root.classList.toggle("reading", nextReading(root.classList.contains("reading"), y, last, atEnd));
      last = y;
      queue();
    };
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      near.disconnect();
      root.classList.remove("reading");
    };
  }, [capsule, bar, body, loaded]);
}

/** Slides the bar's bead of light to a control, or to the one that's on when nothing is held. */
export function usePool(bar: RefObject<HTMLElement | null>, pool: RefObject<HTMLElement | null>, on: unknown[]) {
  useEffect(() => {
    const host = bar.current;
    const bead = pool.current;
    if (!host || !bead) return;
    const place = (control: Element) => {
      const a = control.getBoundingClientRect();
      const b = host.getBoundingClientRect();
      bead.style.setProperty("--x", `${a.left - b.left}px`);
      bead.style.setProperty("--w", `${a.width}px`);
    };
    const settle = () => {
      const pressed = host.querySelector(".vb[aria-pressed='true']");
      bead.classList.remove("down");
      bead.classList.toggle("on", !!pressed);
      bead.classList.toggle("mark", !!pressed);
      if (pressed) place(pressed);
    };
    const onDown = (event: PointerEvent) => {
      const control = (event.target as HTMLElement).closest(".vb");
      if (!control) return;
      place(control);
      bead.classList.add("on", "down");
    };
    let timer = 0;
    const onUp = () => {
      clearTimeout(timer);
      timer = window.setTimeout(settle, 90);
    };
    settle();
    const sized = new ResizeObserver(settle);
    sized.observe(host);
    host.addEventListener("pointerdown", onDown);
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) host.addEventListener(type, onUp);
    return () => {
      clearTimeout(timer);
      sized.disconnect();
      host.removeEventListener("pointerdown", onDown);
      for (const type of ["pointerup", "pointercancel", "pointerleave"]) host.removeEventListener(type, onUp);
    };
  }, [bar, pool, ...on]);
}
