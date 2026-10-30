const probe = `
const r = {};
const t = async (k, f) => { try { r[k] = "REACHED: " + String(await f()).slice(0, 50); } catch (e) { r[k] = "denied: " + e.name + " " + String(e.message).slice(0, 80); } };
const v = "2.1." + String(3);
await t("computedEsmSh", async () => Object.keys(await import("https://esm.sh/ms@" + v + "?x=" + Date.now())));
await t("otherHost", async () => Object.keys(await import("https://example.com/x.js?" + Date.now())));
await t("jsr", async () => Object.keys(await import("jsr:@std/fmt@1/colors")));
self.postMessage(r);`;
const w = new Worker(`data:application/javascript,${encodeURIComponent(probe)}`, { type: "module", deno: { permissions: "none" } } as WorkerOptions);
console.log(JSON.stringify(await new Promise((ok) => { w.onmessage = (e) => ok(e.data); setTimeout(() => ok({ timeout: true }), 20000); }), null, 1));
w.terminate();
