// The DATA binding: wraps the app's internal data API. The dataKey is an argument on every call.
import { WorkerEntrypoint } from "cloudflare:workers";
export class Data extends WorkerEntrypoint {
  async call(dataKey, method, key, value) {
    const res = await this.env.APP.fetch(`http://app/internal/data/shared/${encodeURIComponent(key)}`, {
      method, headers: { authorization: `Bearer ${dataKey}`, "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify({ value }),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`data ${method} ${res.status}`);
    return (await res.json()).value ?? null;
  }
}
export default { fetch() { return new Response("no", { status: 404 }); } };
