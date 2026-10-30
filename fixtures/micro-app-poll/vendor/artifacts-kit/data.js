// The data API for artifact code (08). A live frame has no origin of its own, so every call goes to
// the viewer by postMessage. During `artifacts render` it reads the fixtures, and writes do nothing.
const fixtures = () => globalThis.__ARTIFACTS_FIXTURES__;
const pending = new Map();

export class Conflict extends Error {
  name = "Conflict";
}

if (typeof addEventListener === "function") {
  addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || message?.artifacts !== 1 || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) resolve(message.result);
    else if (message.error.code === "precondition_failed") reject(new Conflict(message.error.message));
    else reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
  });
}

function bridge(op) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ artifacts: 1, id, op }, "*");
  });
}

function fromFixtures(scope, op) {
  const values = fixtures()?.[scope] ?? {};
  if (op.kind === "get") {
    return op.key in values ? { value: values[op.key], etag: "fixture" } : null;
  }
  if (op.kind === "list") {
    const prefix = op.prefix ?? "";
    return { keys: Object.keys(values).filter((key) => key.startsWith(prefix)).map((key) => ({ key })), nextCursor: null };
  }
  if (op.kind === "put") return { etag: "fixture" };
  if (op.kind === "file.url") return `fixtures/files/${scope}/${op.name}`;
  if (op.kind === "file.list") return [];
  return null;
}

const call = (scope, op) =>
  fixtures() ? Promise.resolve(fromFixtures(scope, op)) : bridge({ ...op, scope });

function space(scope) {
  const store = {
    async get(key) {
      try {
        return await call(scope, { kind: "get", key });
      } catch (error) {
        if (error.code === "not_found") return null;
        throw error;
      }
    },
    put: (key, value, options = {}) => call(scope, { kind: "put", key, value, ifMatch: options.ifMatch }),
    delete: (key, options = {}) => call(scope, { kind: "delete", key, ifMatch: options.ifMatch }),
    /** Read, change, write, and retry if someone else wrote first. */
    async update(key, change, options = {}) {
      for (let attempt = 0; ; attempt++) {
        const current = await store.get(key);
        const next = change(current?.value ?? null);
        try {
          return await store.put(key, next, { ifMatch: current?.etag ?? "*" });
        } catch (error) {
          if (!(error instanceof Conflict) || attempt >= (options.retries ?? 5)) throw error;
        }
      }
    },
    async *list(prefix) {
      let cursor;
      do {
        const page = await call(scope, { kind: "list", prefix, cursor });
        for (const entry of page.keys) yield entry.key;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    },
    files: {
      put: (name, blob) => call(scope, { kind: "file.put", name, blob }),
      url: (name) => call(scope, { kind: "file.url", name }),
      list: () => call(scope, { kind: "file.list" }),
      delete: (name) => call(scope, { kind: "file.delete", name }),
    },
  };
  return store;
}

export const data = {
  shared: space("shared"),
  me: space("me"),
  whoami: () =>
    fixtures() ? Promise.resolve({ name: "Preview", kind: "preview", canWrite: false }) : bridge({ kind: "whoami" }),
};
