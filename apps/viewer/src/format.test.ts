import { describe, expect, test } from "bun:test";
import { agentInitials, agentShort, ago, initials, plural } from "./format.ts";

// Local times, so the answers hold in any time zone the tests run in.
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
    const monday = at(10, 26, 23, 0);
    expect(ago(iso(monday), now)).toBe(monday.toLocaleDateString(undefined, { weekday: "long" }));
  });

  test("the day before is yesterday, however late the hour", () => {
    expect(ago(iso(at(10, 27, 0, 10)), now)).toBe("yesterday");
    expect(ago(iso(at(10, 27, 0, 10)), at(10, 28, 23, 50).getTime())).toBe("yesterday");
  });

  test("within the week it names the day; after that the date", () => {
    expect(ago(iso(at(10, 23, 9)), now)).toBe(at(10, 23).toLocaleDateString(undefined, { weekday: "long" }));
    expect(ago(iso(at(10, 21, 9)), now)).toBe(
      at(10, 21).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });

  test("adds the year when it isn't this one", () => {
    expect(ago(iso(at(10, 21, 9, 0, 2025)), now)).toBe(
      at(10, 21, 9, 0, 2025).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    );
  });

  test("a date that isn't one gives nothing rather than Invalid Date", () => {
    expect(ago("not a date", now)).toBe("");
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

  test("agent marks", () => {
    expect(agentInitials("Claude Code")).toBe("Cl");
    expect(agentInitials("Codex")).toBe("Cx");
    expect(agentShort("Claude Code")).toBe("Claude");
  });
});
