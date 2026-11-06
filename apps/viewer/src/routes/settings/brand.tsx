import type { Brand, BrandProposal, OrgBrand } from "@artifacts/schema";
import { BRAND_PROMPT } from "@artifacts/schema/brand-prompt";
import { BRAND_NAME_MAX, HEX_COLOR } from "@artifacts/schema/constants";
import {
  contrast,
  FONT_STACKS,
  type Neutrals,
  type ThemeValues,
  themeStyle,
} from "@artifacts/schema/theme-css";
import { useSignal } from "@preact/signals";
import { ChevronDown, ChevronRight, Copy } from "lucide-preact";
import { api, del } from "../../api.ts";
import { copy } from "../../clipboard.ts";
import { useAction } from "../../components/reauth.tsx";
import { capitalize } from "../../format.ts";
import { artifactHref } from "../../paths.ts";
import { usePoll } from "../../poll.ts";
import { meta } from "../../session.ts";
import { Frame, isAdmin } from "./frame.tsx";

type BrandTheme = Omit<ThemeValues, "mode">;

const CORNERS: [string, number | undefined][] = [
  ["Template", undefined],
  ["Tight", 4],
  ["Soft", 10],
  ["Round", 20],
];
const NEUTRALS: [keyof Neutrals, string, string][] = [
  ["bg", "Background", "#f5f6f8"],
  ["card", "Cards", "#ffffff"],
  ["text", "Text", "#121418"],
  ["muted", "Quiet text", "#5e6470"],
  ["line", "Lines", "#e4e6ea"],
];
const fallback = (key: keyof Neutrals) => NEUTRALS.find(([name]) => name === key)?.[2] as string;
/** Pasting from a brand guide often leaves the # behind. */
const asHex = (value: string) => {
  const text = value.trim();
  return !text || text.startsWith("#") ? text : `#${text}`;
};
/** Safari's property is a boolean, and any string turns it on. The types only allow a string. */
const OFF_AUTOCORRECT: object = { autocorrect: false };

function ColorRow({
  label,
  value,
  shown,
  onChange,
}: {
  label: string;
  value: string;
  shown: string;
  onChange: (value: string) => void;
}) {
  return (
    <div class="li">
      <span class="grow tt">{label}</span>
      <input
        class="hex"
        aria-label={`${label}, as a hex colour`}
        autocapitalize="off"
        {...OFF_AUTOCORRECT}
        spellcheck={false}
        placeholder="Not set"
        value={value}
        onInput={(e) => onChange(asHex(e.currentTarget.value))}
      />
      <input
        class="swatch"
        type="color"
        aria-label={`Pick ${label.toLowerCase()}`}
        value={HEX_COLOR.test(value) ? value : shown}
        onInput={(e) => onChange(e.currentTarget.value)}
      />
    </div>
  );
}

function FontField({
  id,
  label,
  value,
  own,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  own: string[];
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label class="gh" for={id}>
        {label}
      </label>
      <div class="select">
        <select id={id} class="field" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
          <option value="">Template's own</option>
          {[...Object.keys(FONT_STACKS), ...own].map((name) => (
            <option key={name} value={name}>
              {own.includes(name) ? name : capitalize(name)}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden="true" />
      </div>
    </>
  );
}

function BrandForm({
  brand,
  orgName,
  onSaved,
}: {
  brand: Brand | null;
  orgName: string;
  onSaved: () => Promise<void>;
}) {
  const name = useSignal(brand?.name ?? orgName);
  const accent = useSignal(brand?.theme.accent ?? "");
  const display = useSignal(brand?.theme.display ?? "");
  const font = useSignal(brand?.theme.font ?? "");
  const radius = useSignal(brand?.theme.radius);
  const neutrals = useSignal<Neutrals>(brand?.theme.neutrals ?? {});
  const dirty = useSignal(brand === null);
  const own = brand?.fonts.map((row) => row.family).filter(unique) ?? [];
  const action = useAction();
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      dirty.value = true;
    };
  const colors = [accent.value, ...Object.values(neutrals.value)].filter(Boolean) as string[];
  const valid = colors.every((color) => HEX_COLOR.test(color));
  // What the form can't show, such as dark colours from an agent, stays as it was.
  const theme: BrandTheme = {
    ...(brand && { scale: brand.theme.scale, neutralsDark: brand.theme.neutralsDark }),
    ...(accent.value && { accent: accent.value }),
    ...(display.value && { display: display.value }),
    ...(font.value && { font: font.value }),
    ...(radius.value !== undefined && { radius: radius.value }),
    ...(colors.length > (accent.value ? 1 : 0) && {
      neutrals: Object.fromEntries(Object.entries(neutrals.value).filter(([, color]) => color)),
    }),
  };
  const { text, bg } = neutrals.value;
  const shade = (key: "text" | "bg") => {
    const color = neutrals.value[key];
    return color && HEX_COLOR.test(color) ? color : fallback(key);
  };
  const ratio = text || bg ? contrast(shade("text"), shade("bg")) : 21;
  const save = () =>
    action.run(async () => {
      await api("/api/brand", { method: "PUT", json: { name: name.value.trim(), theme } });
      dirty.value = false;
      await onSaved();
    });
  return (
    <>
      <figure class="specimen" style={themeStyle(theme)} aria-label="Preview">
        <div class="specimen-card">
          <h2>{name.value.trim() || "Your brand"}</h2>
          <p>This is how your templates will read.</p>
          <small>Dates, captions and other quiet text.</small>
          <hr />
          <span class="specimen-action">Primary action</span>
        </div>
      </figure>
      <label class="gh" for="brand-name">
        Name
      </label>
      <input
        id="brand-name"
        class="field"
        maxLength={BRAND_NAME_MAX}
        value={name.value}
        onInput={(e) => edit((value: string) => (name.value = value))(e.currentTarget.value)}
      />
      <span class="gh">Colour</span>
      <div class="group">
        <ColorRow
          label="Accent"
          value={accent.value}
          shown="#0a84ff"
          onChange={edit((value: string) => (accent.value = value))}
        />
      </div>
      <FontField
        id="brand-display"
        label="Headings"
        value={display.value}
        own={own}
        onChange={edit((value: string) => (display.value = value))}
      />
      <FontField
        id="brand-font"
        label="Body text"
        value={font.value}
        own={own}
        onChange={edit((value: string) => (font.value = value))}
      />
      <span class="gh">Corners</span>
      <div class="seg">
        {CORNERS.map(([label, value]) => (
          <button
            type="button"
            key={label}
            aria-pressed={radius.value === value}
            onClick={() => edit((next: number | undefined) => (radius.value = next))(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <details class="more" open={Object.keys(neutrals.value).length > 0}>
        <summary>
          More colours
          <ChevronRight aria-hidden="true" />
        </summary>
        <div class="group">
          {NEUTRALS.map(([key, label, shown]) => (
            <ColorRow
              key={key}
              label={label}
              value={neutrals.value[key] ?? ""}
              shown={shown}
              onChange={edit((value: string) => {
                neutrals.value = { ...neutrals.value, [key]: value };
              })}
            />
          ))}
        </div>
      </details>
      {!valid && <p class="err">Use a colour like #d2452d.</p>}
      {ratio < 4.5 && <p class="err">Text will be hard to read on this background.</p>}
      {action.error.value && <p class="err">{action.error.value}</p>}
      <button
        type="button"
        class="btn ink"
        disabled={!dirty.value || !valid || !name.value.trim()}
        onClick={save}
      >
        {brand ? "Save changes" : "Use this brand"}
      </button>
      <p class="fn">
        This changes what you publish next. Published work keeps its look until it's published again.
      </p>
      {action.sheet}
    </>
  );
}

const unique = (value: string, index: number, list: string[]) => list.indexOf(value) === index;

export function BrandSettings() {
  const current = usePoll<OrgBrand>("/api/brand", 60_000);
  const proposals = usePoll<BrandProposal[]>("/api/brand/proposals", 60_000);
  const copied = useSignal(false);
  const refresh = async () => {
    await Promise.all([current.refresh(), proposals.refresh()]);
  };
  const action = useAction({ after: refresh });
  const loaded = current.data.value;
  const brand = loaded?.brand ?? null;
  const list = proposals.data.value ?? [];
  const admin = isAdmin();
  return (
    <Frame title="Brand">
      <p class="fn">
        {brand
          ? `Templates use ${brand.name}. A project's own theme still wins.`
          : "Templates use their own look."}
      </p>
      {admin && loaded && (
        <BrandForm
          key={JSON.stringify(brand)}
          brand={brand}
          orgName={meta.value?.orgName ?? ""}
          onSaved={refresh}
        />
      )}
      {admin && (
        <>
          <span class="gh">Or ask an agent</span>
          <p class="fn">Best when you have a brand guide, or your own font files.</p>
          <button
            type="button"
            class="btn soft"
            onClick={() => {
              copy(BRAND_PROMPT);
              copied.value = true;
            }}
          >
            <Copy />
            {copied.value ? "Copied" : "Copy the prompt"}
          </button>
        </>
      )}
      {list.length > 0 && <span class="gh">Brands</span>}
      {list.length > 0 && (
        <div class="group">
          {list.map((row) => (
            <div class="li" key={row.id}>
              <span
                aria-hidden="true"
                style={`width:22px;height:22px;border-radius:50%;flex:none;background:${HEX_COLOR.test(row.brand.theme.accent ?? "") ? row.brand.theme.accent : "transparent"}`}
              />
              <div class="grow">
                <div class="tt">{row.name}</div>
                <div class="ss">
                  {row.agent ? `${row.agent} for ${row.proposedBy}` : row.proposedBy}
                  {row.sample && (
                    <>
                      {", "}
                      <a href={artifactHref(row.sample)}>see the sample</a>
                    </>
                  )}
                </div>
              </div>
              {row.current ? (
                <span class="word ok">Current</span>
              ) : (
                admin && (
                  <button
                    type="button"
                    class="btn fit"
                    onClick={() =>
                      action.run(() => api(`/api/brand/proposals/${row.id}/apply`, { method: "POST" }))
                    }
                  >
                    Apply
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {action.error.value && <p class="err">{action.error.value}</p>}
      {admin && brand && (
        <button type="button" class="btn" onClick={() => action.run(() => del("/api/brand"))}>
          Go back to the default
        </button>
      )}
      {action.sheet}
    </Frame>
  );
}
