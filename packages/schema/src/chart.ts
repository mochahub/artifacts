type Chart = { type: "bar" | "line"; labels: string[]; series: { name: string; values: number[] }[] };

const WIDTH = 640;
const HEIGHT = 320;
const PAD = 36;
/** A neutral, colour-blind-safe order; the viewer's marks stay yellow and violet. */
const COLORS = ["#2a78d6", "#d9792a", "#1f9d8b", "#a64fa8"];

const esc = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** `::chart` (05): a plain SVG with no script, so it survives the article allowlist. */
export function chartSvg(chart: Chart): string {
  const values = chart.series.flatMap((series) => series.values);
  const max = Math.max(1, ...values);
  const plotW = WIDTH - PAD * 2;
  const plotH = HEIGHT - PAD * 2;
  const n = Math.max(1, chart.labels.length);
  const y = (value: number) => HEIGHT - PAD - (value / max) * plotH;
  const marks: string[] = [`<path d="M${PAD} ${HEIGHT - PAD}H${WIDTH - PAD}" stroke="#9aa0aa"/>`];

  chart.labels.forEach((label, i) => {
    const x = PAD + (plotW * (i + 0.5)) / n;
    marks.push(
      `<text x="${x}" y="${HEIGHT - 14}" text-anchor="middle" font-size="12" fill="#5e6470">${esc(label)}</text>`,
    );
  });
  chart.series.forEach((series, s) => {
    const color = COLORS[s % COLORS.length] as string;
    if (chart.type === "bar") {
      const band = plotW / n;
      const width = (band * 0.7) / chart.series.length;
      series.values.forEach((value, i) => {
        const x = PAD + band * i + band * 0.15 + width * s;
        marks.push(
          `<rect x="${x.toFixed(1)}" y="${y(value).toFixed(1)}" width="${width.toFixed(1)}" height="${(HEIGHT - PAD - y(value)).toFixed(1)}" fill="${color}"/>`,
        );
      });
    } else {
      const points = series.values
        .map((value, i) => `${(PAD + (plotW * (i + 0.5)) / n).toFixed(1)},${y(value).toFixed(1)}`)
        .join(" ");
      marks.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>`);
    }
    marks.push(
      `<text x="${PAD + s * 120}" y="16" font-size="12" font-weight="600" fill="${color}">${esc(series.name)}</text>`,
    );
  });
  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img">${marks.join("")}</svg>`;
}
