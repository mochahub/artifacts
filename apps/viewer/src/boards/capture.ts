import type {
  BoardCaptureThread,
  BoardImage,
  BoardObject,
  BoardRenders,
  BoardSnapshot,
} from "@artifacts/schema/boards";
import { api, post } from "../api.ts";
import {
  anchorPoint,
  connectorPath,
  type Point,
  type Rect,
  type Scene,
  sceneBounds,
  sceneOf,
  worldPose,
} from "./geometry.ts";

/**
 * Pictures of a checkpoint (14, "Browser capture protocol"): the browser draws **the snapshot the
 * server fenced**, never the live DOM, so ghosts and selection can't get in. A clean offscreen canvas,
 * images only from this origin's validated bytes, no HTML screenshots. A 1200×630 thumbnail of the
 * whole board, and a 480×320 crop (a 240×160 world window at 2×) around each open object pin.
 */

type Pictures = Map<string, ImageBitmap>;
const THUMB = { w: 1200, h: 630 };
const CROP = { w: 480, h: 320, world: { w: 240, h: 160 } };

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  align: string,
) {
  ctx.textAlign = align as CanvasTextAlign;
  const ax = align === "center" ? x + width / 2 : align === "right" ? x + width : x;
  let line = "";
  let at = y + size;
  for (const paragraph of text.split("\n")) {
    line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > width && line) {
        ctx.fillText(line, ax, at);
        at += size * 1.3;
        line = word;
      } else line = next;
    }
    ctx.fillText(line, ax, at);
    at += size * 1.3;
  }
}

function drawObject(ctx: CanvasRenderingContext2D, scene: Scene, object: BoardObject, pictures: Pictures) {
  const s = object.style;
  ctx.save();
  ctx.globalAlpha = s.opacity;
  ctx.strokeStyle = s.stroke;
  ctx.lineWidth = Math.max(1, s.strokeWidth);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (object.kind === "connector") {
    const path = connectorPath(scene, object);
    ctx.beginPath();
    path.forEach((p, i) => {
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke();
    const head = (at: Point, from: Point) => {
      const angle = Math.atan2(at.y - from.y, at.x - from.x);
      const size = 8 + ctx.lineWidth * 2;
      ctx.beginPath();
      ctx.moveTo(at.x - size * Math.cos(angle - 0.45), at.y - size * Math.sin(angle - 0.45));
      ctx.lineTo(at.x, at.y);
      ctx.lineTo(at.x - size * Math.cos(angle + 0.45), at.y - size * Math.sin(angle + 0.45));
      ctx.stroke();
    };
    if (object.data.endArrow) head(path.at(-1) as Point, path.at(-2) as Point);
    if (object.data.startArrow) head(path[0] as Point, path[1] as Point);
    ctx.restore();
    return;
  }
  const pose = worldPose(scene, object.id) ?? object.pose;
  ctx.translate(pose.x + pose.w / 2, pose.y + pose.h / 2);
  ctx.rotate(pose.angle);
  ctx.translate(-pose.w / 2, -pose.h / 2);
  const fill = s.fill === "transparent" ? null : s.fill;
  ctx.font = `600 ${s.fontSize}px -apple-system, system-ui, sans-serif`;
  switch (object.kind) {
    case "sticky":
      ctx.fillStyle = fill ?? "#fff2a8";
      ctx.fillRect(0, 0, pose.w, pose.h);
      ctx.fillStyle = "#1c1d20";
      wrap(ctx, object.text, 16, 10, pose.w - 32, s.fontSize, s.align);
      break;
    case "text":
      ctx.fillStyle = s.stroke;
      wrap(ctx, object.text, 0, 0, pose.w, s.fontSize, s.align);
      break;
    case "shape":
      ctx.beginPath();
      if (object.shape === "rect") ctx.roundRect(0, 0, pose.w, pose.h, 10);
      else if (object.shape === "ellipse")
        ctx.ellipse(pose.w / 2, pose.h / 2, pose.w / 2, pose.h / 2, 0, 0, Math.PI * 2);
      else if (object.shape === "diamond") {
        ctx.moveTo(pose.w / 2, 0);
        ctx.lineTo(pose.w, pose.h / 2);
        ctx.lineTo(pose.w / 2, pose.h);
        ctx.lineTo(0, pose.h / 2);
        ctx.closePath();
      } else {
        ctx.moveTo(0, 0);
        ctx.lineTo(pose.w, pose.h);
      }
      if (fill && object.shape !== "line") {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.stroke();
      ctx.fillStyle = "#1c1d20";
      if (object.text) wrap(ctx, object.text, 10, pose.h / 2 - s.fontSize, pose.w - 20, s.fontSize, "center");
      break;
    case "frame":
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, pose.w, pose.h);
      }
      ctx.beginPath();
      ctx.roundRect(0, 0, pose.w, pose.h, 14);
      ctx.stroke();
      ctx.fillStyle = "#1c1d20";
      ctx.font = "700 22px ui-serif, Georgia, serif";
      ctx.fillText(object.label || "Frame", 0, -8);
      break;
    case "stroke":
      ctx.beginPath();
      object.points.forEach((p, i) => {
        if (i) ctx.lineTo(p.u * pose.w, p.v * pose.h);
        else ctx.moveTo(p.u * pose.w, p.v * pose.h);
      });
      ctx.stroke();
      break;
    case "image":
    case "rendered_frame": {
      const hash = object.kind === "image" ? object.asset : object.data.renders["2x"];
      const picture = pictures.get(hash);
      if (picture) ctx.drawImage(picture, 0, 0, pose.w, pose.h);
      else {
        ctx.fillStyle = "#e4e6ea";
        ctx.fillRect(0, 0, pose.w, pose.h);
      }
      break;
    }
  }
  ctx.restore();
}

/** Draws a whole snapshot into a world-space window of a canvas. Pure apart from the canvas. */
export function drawSnapshot(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  window: Rect,
  size: { w: number; h: number },
  pictures: Pictures,
) {
  ctx.fillStyle = "#f6f6f3";
  ctx.fillRect(0, 0, size.w, size.h);
  const scale = Math.min(size.w / window.w, size.h / window.h);
  ctx.save();
  ctx.translate((size.w - window.w * scale) / 2, (size.h - window.h * scale) / 2);
  ctx.scale(scale, scale);
  ctx.translate(-window.x, -window.y);
  for (const object of scene.order) drawObject(ctx, scene, object, pictures);
  ctx.restore();
}

function canvas(size: { w: number; h: number }) {
  const el = document.createElement("canvas");
  el.width = size.w;
  el.height = size.h;
  return el;
}

async function encode(el: HTMLCanvasElement): Promise<{ image: BoardImage; bytes: Blob }> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    el.toBlob((b) => (b ? resolve(b) : reject(new Error("no picture"))), "image/png"),
  );
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    image: { hash, type: "image/png", bytes: blob.size, width: el.width, height: el.height },
    bytes: blob,
  };
}

/** Uploads validated rasters through the board asset routes: prepare, PUT, commit. */
export async function uploadImages(artifactId: string, files: { image: BoardImage; bytes: Blob }[]) {
  if (files.length === 0) return [];
  const base = `/api/artifacts/${artifactId}/board/assets`;
  const prepared = await post<{
    images: { hash: string; url: string | null; headers: Record<string, string> }[];
  }>(`${base}/prepare`, { images: files.map((f) => f.image) });
  for (const target of prepared.images) {
    const file = files.find((f) => f.image.hash === target.hash);
    if (!file || !target.url) continue;
    const response = await fetch(target.url, { method: "PUT", headers: target.headers, body: file.bytes });
    if (!response.ok) throw new Error("upload failed");
  }
  const committed = await post<{ images: BoardImage[] }>(`${base}/commit`, {
    images: files.map((f) => f.image),
  });
  return committed.images;
}

/** Draws the ticket's snapshot: a thumbnail and one crop per listed thread, uploaded, as `BoardRenders`. */
export async function capturePictures(
  artifactId: string,
  snapshot: BoardSnapshot,
  threads: BoardCaptureThread[],
  urls: { asset(hash: string): string; render(hash: string): string },
): Promise<BoardRenders> {
  const scene = sceneOf(snapshot);
  const pictures: Pictures = new Map();
  await Promise.all(
    snapshot.objects.map(async (object) => {
      const hash =
        object.kind === "image"
          ? object.asset
          : object.kind === "rendered_frame"
            ? object.data.renders["2x"]
            : null;
      if (!hash || pictures.has(hash)) return;
      const url = object.kind === "image" ? urls.asset(hash) : urls.render(hash);
      const response = await fetch(url).catch(() => null);
      if (response?.ok) pictures.set(hash, await createImageBitmap(await response.blob()));
    }),
  );
  const bounds = sceneBounds(scene);
  const pad = 40;
  const thumbEl = canvas(THUMB);
  drawSnapshot(
    thumbEl.getContext("2d") as CanvasRenderingContext2D,
    scene,
    { x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + pad * 2, h: bounds.h + pad * 2 },
    THUMB,
    pictures,
  );
  const thumbnail = await encode(thumbEl);
  const crops: { thread: number; file: Awaited<ReturnType<typeof encode>> }[] = [];
  for (const thread of threads) {
    const at = anchorPoint(scene, thread.anchor.object, thread.anchor.u, thread.anchor.v) ?? { x: 0, y: 0 };
    const el = canvas(CROP);
    const ctx = el.getContext("2d") as CanvasRenderingContext2D;
    drawSnapshot(
      ctx,
      scene,
      { x: at.x - CROP.world.w / 2, y: at.y - CROP.world.h / 2, ...CROP.world },
      CROP,
      pictures,
    );
    ctx.fillStyle = "#ffd84d";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(CROP.w / 2, CROP.h / 2, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    crops.push({ thread: thread.n, file: await encode(el) });
  }
  await uploadImages(artifactId, [thumbnail, ...crops.map((c) => c.file)]);
  return { thumbnail: thumbnail.image, crops: crops.map((c) => ({ thread: c.thread, image: c.file.image })) };
}

/** Fills in pictures for a version saved without a browser (an agent's or a quiet checkpoint). */
export async function captureVersion(
  artifactId: string,
  version: number,
  urls: Parameters<typeof capturePictures>[3],
  existing: BoardRenders | null = null,
) {
  const base = `/api/artifacts/${artifactId}/board`;
  const ticket = await post<{ ticket: string; snapshot: BoardSnapshot; threads: BoardCaptureThread[] }>(
    `${base}/captures`,
    {
      target: { kind: "version", version },
    },
  );
  if (existing && ticket.threads.length === 0) return;
  const renders = await capturePictures(artifactId, ticket.snapshot, ticket.threads, urls);
  if (existing) renders.thumbnail = existing.thumbnail;
  return api(`${base}/captures/commit`, { method: "POST", json: { ticket: ticket.ticket, renders } });
}
