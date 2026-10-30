// The small Web platform a backend sees (08). QuickJS has the language and nothing else, and this
// runs before the backend. Anything not here doesn't exist: no fetch, timers, sockets or modules.
(() => {
  const host = globalThis.__host;
  delete globalThis.__host;

  class Headers {
    #map = new Map();
    constructor(init) {
      const entries =
        init instanceof Headers
          ? [...init.entries()]
          : Array.isArray(init)
            ? init
            : Object.entries(init ?? {});
      for (const [key, value] of entries) this.set(key, value);
    }
    get(name) {
      return this.#map.get(String(name).toLowerCase()) ?? null;
    }
    set(name, value) {
      this.#map.set(String(name).toLowerCase(), String(value));
    }
    has(name) {
      return this.#map.has(String(name).toLowerCase());
    }
    delete(name) {
      this.#map.delete(String(name).toLowerCase());
    }
    forEach(fn) {
      for (const [key, value] of this.#map) fn(value, key, this);
    }
    entries() {
      return this.#map.entries();
    }
    keys() {
      return this.#map.keys();
    }
    values() {
      return this.#map.values();
    }
    [Symbol.iterator]() {
      return this.#map.entries();
    }
  }

  const encodeURIQuery = (value) => encodeURIComponent(value).replace(/%20/g, "+");
  class URLSearchParams {
    #pairs = [];
    constructor(init = "") {
      const text = String(init).replace(/^\?/, "");
      for (const part of text ? text.split("&") : []) {
        const [key, value = ""] = part.split("=");
        this.#pairs.push([
          decodeURIComponent(key.replace(/\+/g, " ")),
          decodeURIComponent(value.replace(/\+/g, " ")),
        ]);
      }
    }
    get(name) {
      return this.#pairs.find(([key]) => key === name)?.[1] ?? null;
    }
    getAll(name) {
      return this.#pairs.filter(([key]) => key === name).map(([, value]) => value);
    }
    has(name) {
      return this.#pairs.some(([key]) => key === name);
    }
    set(name, value) {
      this.delete(name);
      this.#pairs.push([name, String(value)]);
    }
    append(name, value) {
      this.#pairs.push([name, String(value)]);
    }
    delete(name) {
      this.#pairs = this.#pairs.filter(([key]) => key !== name);
    }
    entries() {
      return this.#pairs[Symbol.iterator]();
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return this.#pairs.map(([key, value]) => `${encodeURIQuery(key)}=${encodeURIQuery(value)}`).join("&");
    }
  }

  class URL {
    constructor(url, base) {
      const pattern = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
      let match = pattern.exec(String(url));
      if (!match) {
        if (!base) throw new TypeError(`Invalid URL: ${url}`);
        const parent = new URL(base);
        const path = String(url).startsWith("/")
          ? String(url)
          : `${parent.pathname.replace(/[^/]*$/, "")}${url}`;
        match = pattern.exec(`${parent.origin}${path}`);
      }
      this.protocol = match[1];
      this.host = match[2];
      this.hostname = match[2].split(":")[0];
      this.port = match[2].split(":")[1] ?? "";
      this.pathname = match[3] || "/";
      this.search = match[4] ?? "";
      this.hash = match[5] ?? "";
      this.origin = `${this.protocol}//${this.host}`;
      this.searchParams = new URLSearchParams(this.search);
    }
    get href() {
      return `${this.origin}${this.pathname}${this.search}${this.hash}`;
    }
    toString() {
      return this.href;
    }
  }

  const utf8 = {
    encode(text) {
      const out = [];
      for (const ch of String(text)) {
        const code = ch.codePointAt(0);
        if (code < 0x80) out.push(code);
        else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
        else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
        else
          out.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 63),
            0x80 | ((code >> 6) & 63),
            0x80 | (code & 63),
          );
      }
      return new Uint8Array(out);
    },
    decode(bytes) {
      let out = "";
      for (let i = 0; i < bytes.length; ) {
        const a = bytes[i++];
        if (a < 0x80) out += String.fromCodePoint(a);
        else if (a < 0xe0) out += String.fromCodePoint(((a & 31) << 6) | (bytes[i++] & 63));
        else if (a < 0xf0)
          out += String.fromCodePoint(((a & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
        else
          out += String.fromCodePoint(
            ((a & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63),
          );
      }
      return out;
    },
  };
  class TextEncoder {
    encode(text = "") {
      return utf8.encode(text);
    }
  }
  class TextDecoder {
    decode(bytes) {
      return bytes ? utf8.decode(new Uint8Array(bytes.buffer ?? bytes)) : "";
    }
  }

  class Body {
    #text;
    constructor(body) {
      this.#text =
        body === undefined || body === null
          ? ""
          : typeof body === "string"
            ? body
            : body instanceof Uint8Array || body instanceof ArrayBuffer
              ? utf8.decode(new Uint8Array(body.buffer ?? body))
              : String(body);
    }
    async text() {
      return this.#text;
    }
    async json() {
      return JSON.parse(this.#text);
    }
    async arrayBuffer() {
      return utf8.encode(this.#text).buffer;
    }
    get _text() {
      return this.#text;
    }
  }

  class Request extends Body {
    constructor(input, init = {}) {
      super(init.body);
      this.url = typeof input === "string" ? input : input.url;
      this.method = (init.method ?? "GET").toUpperCase();
      this.headers = new Headers(init.headers);
    }
  }

  class Response extends Body {
    constructor(body, init = {}) {
      super(body);
      this.status = init.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new Headers(init.headers);
      if (typeof body === "string" && !this.headers.has("content-type")) {
        this.headers.set("content-type", "text/plain; charset=utf-8");
      }
    }
    static json(value, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return new Response(JSON.stringify(value), { ...init, headers });
    }
  }

  const text = (args) => args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ");
  globalThis.console = Object.fromEntries(
    ["log", "info", "warn", "error", "debug"].map((level) => [
      level,
      (...args) => host.log(level === "info" || level === "debug" ? "log" : level, text(args)),
    ]),
  );

  const call = async (op) => {
    const answer = JSON.parse(await host.data(JSON.stringify(op)));
    if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
    return answer.value;
  };
  const env = {
    DATA: {
      get: async (key) => (await call({ op: "get", key }))?.value ?? null,
      getWithEtag: (key) => call({ op: "get", key }),
      put: (key, value, options = {}) => call({ op: "put", key, value, ifMatch: options.ifMatch }),
      delete: (key, options = {}) => call({ op: "delete", key, ifMatch: options.ifMatch }),
      list: (prefix, options = {}) => call({ op: "list", prefix, cursor: options.cursor }),
    },
  };

  Object.assign(globalThis, { Headers, URL, URLSearchParams, TextEncoder, TextDecoder, Request, Response });

  /** Runs one request. The child calls this; it isn't reachable from the backend by name. */
  const handle = async (backend, json) => {
    const input = JSON.parse(json);
    const request = new Request(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
    });
    try {
      const response = await backend.fetch(request, env);
      if (!(response instanceof Response)) throw new TypeError("fetch must return a Response");
      return JSON.stringify({
        status: response.status,
        headers: [...response.headers.entries()],
        body: response._text,
      });
    } catch (error) {
      console.error(error?.stack ? `${error.message}\n${error.stack}` : String(error));
      return JSON.stringify({
        status: 500,
        headers: [["content-type", "application/json"]],
        body: '{"error":"The backend failed."}',
      });
    }
  };
  Object.defineProperty(globalThis, "__artifactsHandle", { value: handle, configurable: true });
})();
