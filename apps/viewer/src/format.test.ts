import { afterAll, describe, expect, test } from "bun:test";
import { agentShort, ago, capitalize, initials, plural, until } from "./format.ts";

// The reader's own locale and zone make the words, so these pin both (before any date below is made)
// and put them back for other files.
const zone = process.env.TZ;
const toLocaleDateString = Date.prototype.toLocaleDateString;
process.env.TZ = "Asia/Tokyo";
Date.prototype.toLocaleDateString = function (locale, options) {
  return toLocaleDateString.call(this, locale ?? "en-US", options);
};
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
  Date.prototype.toLocaleDateString = toLocaleDateString;
});

// Local times, in the pinned zone.
const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute);
const iso = (date: Date) => date.toISOString();

describe("ago", () => {
  const now = at(10, 28, 1, 0).getTime(); // Wednesday, 1 am

  test("counts minutes and hours", () => {
    expect(ago(iso(at(10, 28, 0, 59, 2026)), now)).toBe("1 min ago");
    expect(ago(iso(at(10, 27, 23, 0)), now)).toBe("2 h ago");
    expect(ago(iso(new Date(now - 10_000)), now)).toBe("just now");
  });

  test("a clock a little ahead of the server's still says just now", () => {
    expect(ago(iso(new Date(now + 30_000)), now)).toBe("just now");
  });

  test("26 hours ago at 1 am is Monday night, not yesterday", () => {
    expect(ago(iso(at(10, 26, 23, 0)), now)).toBe("Monday");
  });

  test("the day before is yesterday, however late the hour", () => {
    expect(ago(iso(at(10, 27, 0, 10)), now)).toBe("yesterday");
    expect(ago(iso(at(10, 27, 0, 10)), at(10, 28, 23, 50).getTime())).toBe("yesterday");
  });

  test("within the week it names the day; after that the date", () => {
    expect(ago(iso(at(10, 23, 9)), now)).toBe("Friday");
    expect(ago(iso(at(10, 21, 9)), now)).toBe("Oct 21");
  });

  test("adds the year when it isn't this one", () => {
    expect(ago(iso(at(10, 21, 9, 0, 2025)), now)).toBe("Oct 21, 2025");
  });

  test("a date that isn't one gives nothing rather than Invalid Date", () => {
    expect(ago("not a date", now)).toBe("");
  });
});

describe("until", () => {
  const now = at(10, 28, 1, 0).getTime(); // Wednesday, 1 am

  test("counts minutes and hours ahead", () => {
    expect(until(iso(at(10, 28, 1, 20)), now)).toBe("in 20 min");
    expect(until(iso(at(10, 28, 6, 30)), now)).toBe("in 5 h");
    expect(until(iso(new Date(now + 10_000)), now)).toBe("now");
  });

  test("an invite made a minute ago expires a week out, not just now", () => {
    const expires = new Date(now - 60_000 + 7 * 24 * 3600_000);
    expect(until(iso(expires), now)).toBe("Nov 4");
  });

  test("the next calendar day is tomorrow, then the day's name", () => {
    expect(until(iso(at(10, 29, 9)), now)).toBe("tomorrow");
    expect(until(iso(at(10, 31, 9)), now)).toBe("Saturday");
  });

  test("something already past reads as now, and a date that isn't one as nothing", () => {
    expect(until(iso(new Date(now - 3600_000)), now)).toBe("now");
    expect(until("not a date", now)).toBe("");
  });
});

describe("small formatters", () => {
  test("plural", () => {
    expect(plural(1, "page")).toBe("1 page");
    expect(plural(2, "reply", "replies")).toBe("2 replies");
  });

  test("initials", () => {
    expect(initials("Camera Buddy")).toBe("CB");
    expect(initials("perpetua")).toBe("Pe");
    expect(initials("")).toBe("");
  });

  test("capitalize", () => {
    expect(capitalize("reviewer")).toBe("Reviewer");
  });

  test("agent names", () => {
    expect(agentShort("Claude Code")).toBe("Claude");
  });
});
