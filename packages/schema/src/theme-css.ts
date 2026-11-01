/**
 * Turning a theme into CSS. No zod here, because the viewer imports this and its bundle has a budget.
 * Every value passes one of these checks on the way out, so nothing a manifest says can become CSS
 * of its own, whatever got past the schema.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 -]{0,39}$/;

export type Neutrals = { bg?: string; card?: string; text?: string; muted?: string; line?: string };
export type ThemeValues = {
  accent?: string;
  font?: string;
  display?: string;
  mode?: "light" | "dark" | "auto";
  radius?: number;
  scale?: number;
  neutrals?: Neutrals;
  neutralsDark?: Neutrals;
};

export const FONT_STACKS: Record<string, string> = {
  system: '-apple-system, "SF Pro Text", system-ui, sans-serif',
  serif: 'ui-serif, "New York", "Iowan Old Style", Charter, Georgia, serif',
  rounded: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
  humanist: '"Avenir Next", Avenir, "Gill Sans", "Segoe UI", system-ui, sans-serif',
  grotesque: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  didone: 'Didot, "Bodoni 72", "Playfair Display", ui-serif, Georgia, serif',
};

/** A stack for a font name: one we know, or a family the bundle ships, with a safe fallback. */
export function fontStack(name: unknown): string | null {
  if (typeof name !== "string" || !FONT_NAME.test(name)) return null;
  return Object.hasOwn(FONT_STACKS, name)
    ? (FONT_STACKS[name] as string)
    : `"${name}", ${FONT_STACKS.system}`;
}

const hex = (value: unknown) => (typeof value === "string" && HEX.test(value) ? value : null);
const within = (value: unknown, low: number, high: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high ? value : null;

function luminance(value: string) {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(value.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whichever of near-black or white reads better on a colour. */
export const onColor = (value: string) => {
  const light = luminance(value);
  return (light + 0.05) / 0.0533 >= 1.05 / (light + 0.05) ? "#141414" : "#ffffff";
};

function neutralTokens(neutrals: Neutrals | undefined) {
  const entries: [string, string | null][] = [
    ["--art-bg", hex(neutrals?.bg)],
    ["--art-card", hex(neutrals?.card)],
    ["--art-tx", hex(neutrals?.text)],
    ["--art-tx2", hex(neutrals?.muted)],
    ["--art-sep", hex(neutrals?.line)],
  ];
  return entries.flatMap(([name, value]) => (value ? [[name, value] as const] : []));
}

const block = (selector: string, tokens: readonly (readonly [string, string])[]) =>
  tokens.length > 0 ? `${selector}{${tokens.map(([name, value]) => `${name}:${value}`).join(";")}}` : "";

/** The tokens a theme sets, as a stylesheet that goes after every other one on a canvas page. */
export function themeCss(theme: ThemeValues | undefined): string {
  if (!theme) return "";
  const accent = hex(theme.accent);
  const radius = within(theme.radius, 0, 32);
  const scale = within(theme.scale, 0.85, 1.25);
  const font = fontStack(theme.font);
  const display = fontStack(theme.display);
  const tokens: (readonly [string, string])[] = [
    ...(accent ? [["--art-accent", accent] as const, ["--art-on-accent", onColor(accent)] as const] : []),
    ...(font ? [["--art-ui", font] as const] : []),
    ...(display ? [["--art-display", display] as const] : []),
    ...(radius === null ? [] : [["--art-radius", `${radius}px`] as const]),
    ...(scale === null ? [] : [["--art-scale", String(scale)] as const]),
  ];
  const light = neutralTokens(theme.neutrals);
  const dark = neutralTokens(theme.neutralsDark);
  return [
    block(":root", theme.mode === "dark" ? [...tokens, ...dark] : [...tokens, ...light]),
    theme.mode === "auto" || theme.mode === undefined
      ? `@media (prefers-color-scheme:dark){${block(":root", dark)}}`
      : "",
  ]
    .filter((css) => css && !css.endsWith("{}"))
    .join("\n");
}

export type ArticleThemeValues = Pick<ThemeValues, "accent" | "font" | "display" | "radius">;

/** What a published article may set, as custom properties for the article body and nothing else. */
export function articleStyle(theme: ArticleThemeValues | null | undefined): Record<string, string> {
  const style: Record<string, string> = {};
  const accent = hex(theme?.accent);
  const font = fontStack(theme?.font);
  const display = fontStack(theme?.display);
  const radius = within(theme?.radius, 0, 32);
  if (accent) style["--theme-accent"] = accent;
  if (font) style["--theme-font"] = font;
  if (display) style["--theme-display"] = display;
  if (radius !== null) style["--theme-radius"] = `${radius}px`;
  return style;
}
