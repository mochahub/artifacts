const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

export type Logger = {
  [L in LogLevel]: (msg: string, fields?: Record<string, unknown>) => void;
};

/** JSON lines on stdout (09, "Operations"). */
export function createLogger(minimum: LogLevel, write: (line: string) => void = console.log): Logger {
  const at =
    (level: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      if (LEVELS[level] >= LEVELS[minimum]) write(JSON.stringify({ level, msg, ...fields }));
    };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
