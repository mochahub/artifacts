// Spike S4 fallback, round 2: the host has the permissions a real runner needs
// (net to the app, env RUNNER_SECRET, read of its folder). Do workers with permissions "none" still get nothing?
const app = Deno.serve({ port: 18082, hostname: "127.0.0.1", onListen() {} }, () => new Response("app reached"));
const probe = `
const r = {};
const t = async (k, f) => { try { r[k] = "REACHED: " + String(await f()).slice(0, 60); } catch (e) { r[k] = "denied: " + e.name; } };
await t("fetchApp", async () => (await fetch("http://127.0.0.1:18082/")).text());
await t("fetchInternet", async () => (await fetch("https://example.com/")).status);
await t("envSecret", () => Deno.env.get("RUNNER_SECRET"));
await t("envAll", () => JSON.stringify(Deno.env.toObject()));
await t("readHostFile", () => Deno.readTextFileSync("./host2.ts"));
await t("readEtc", () => Deno.readTextFileSync("/etc/hosts"));
await t("writeFile", () => { Deno.writeTextFileSync("./pwned.txt", "x"); return "wrote"; });
await t("spawn", async () => new TextDecoder().decode((await new Deno.Command("id").output()).stdout));
await t("dlopen", () => Deno.dlopen("/usr/lib/libSystem.B.dylib", {}));
await t("listen", () => { const l = Deno.listen({ port: 18099 }); l.close(); return "listened"; });
await t("connectTcp", async () => { const c = await Deno.connect({ hostname: "127.0.0.1", port: 18082 }); c.close(); return "connected"; });
await t("importHttps", async () => Object.keys(await import("https://esm.sh/ms@2.1.3")));
await t("importNpm", async () => Object.keys(await import("npm:ms@2.1.3")));
await t("importFile", async () => Object.keys(await import("file://" + "${Deno.cwd()}/host2.ts")));
await t("nestedWorkerWithPerms", async () => { const w = new Worker("data:application/javascript,self.postMessage(Deno.env.get('RUNNER_SECRET'))", { type: "module", deno: { permissions: "inherit" } }); return await new Promise((ok, no) => { w.onmessage = (e) => ok(e.data); w.onerror = (e) => { e.preventDefault(); no(new Error(e.message)); }; }); });
self.postMessage(r);`;
const w = new Worker(`data:application/javascript,${encodeURIComponent(probe)}`, { type: "module", deno: { permissions: "none" } } as WorkerOptions);
const result = await new Promise((ok) => { w.onmessage = (e) => ok(e.data); w.onerror = (e) => { e.preventDefault(); ok({ workerError: e.message }); }; setTimeout(() => ok({ timeout: true }), 20000); });
w.terminate();
// Sanity check: the host itself does have these permissions.
const host = { fetchApp: await (await fetch("http://127.0.0.1:18082/")).text(), envSecret: Deno.env.get("RUNNER_SECRET")?.length, readOwnFile: Deno.readTextFileSync("./host2.ts").length > 0 };
console.log(JSON.stringify({ host, worker: result }, null, 1));
await app.shutdown();
