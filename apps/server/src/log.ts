const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export type Logger = {
  [L in LogLevel]: (msg: string, fields?: Record<string, unknown>) => void;
};

/**
 * A failed query's error message lists every parameter it was sent, and those can be emails, comment
 * bodies or token hashes. The logs keep the query and the stack, and drop the values.
 */
const PARAMS = /\nparams: [\s\S]*?(?=\n\s+at |$)/g;
const withoutParams = (value: unknown) =>
  typeof value === "string" ? value.replace(PARAMS, "\nparams: (hidden)") : value;

/** JSON lines on stdout (09, "Operations"). */
export function createLogger(minimum: LogLevel, write: (line: string) => void = console.log): Logger {
  const at =
    (level: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      if (LEVELS[level] < LEVELS[minimum]) return;
      const clean = Object.entries(fields).map(([key, value]) => [key, withoutParams(value)] as const);
      write(JSON.stringify({ level, msg: withoutParams(msg), ...Object.fromEntries(clean) }));
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
