# Bases are pinned by digest (the tag says which release the digest is). Dependabot's docker ecosystem bumps both
# together. Keep the tag in step with .bun-version and the root package.json's packageManager.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build

# sharp has native parts, and the sandbox child loads QuickJS itself, so neither is bundled. Rather than
# `bun add` them (no lockfile, so whatever the registry serves that day), copy exactly what bun.lock
# installed above: each package and everything it depends on, found the way Node would find it.
COPY <<'EOF' /opt/runtime-deps.js
import { cpSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
const found = new Map();
const locate = (name, from) => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dir === dirname(dir)) return null;
  }
};
const add = (name, from, optional) => {
  const dir = locate(name, from);
  if (!dir) {
    if (optional) return; // the sharp builds for other platforms
    throw new Error(`${name} is not installed`);
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (found.has(name)) {
    if (found.get(name) !== pkg.version) throw new Error(`${name} resolves to two versions`);
    return;
  }
  found.set(name, pkg.version);
  cpSync(dir, join("/runtime/node_modules", name), { recursive: true, dereference: true });
  for (const dep of Object.keys(pkg.dependencies ?? {})) add(dep, dir, false);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) add(dep, dir, true);
};
add("sharp", "/src/apps/server", false);
add("quickjs-emscripten", "/src/packages/sandbox", false);
console.log([...found].map(([name, version]) => `${name}@${version}`).join("\n"));
EOF
RUN bun /opt/runtime-deps.js

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
# Everything stays owned by root, so a compromised server can't rewrite its own code. It writes nothing to disk.
COPY --from=build /src/apps/server/dist/ ./
COPY --from=build /src/apps/viewer/dist ./public
COPY --from=build /src/apps/server/drizzle ./drizzle
COPY --from=build /runtime/node_modules ./node_modules
# Fails the build if sharp's native build or QuickJS didn't come through.
RUN bun --eval 'await import("sharp"); await import("quickjs-emscripten"); console.log("runtime dependencies load")'
USER bun
ENV NODE_ENV=production PORT=8080 CONTENT_PORT=8081 INTERNAL_PORT=8082
# 8082 is the operators' port (OPS_SECRET). It's deliberately not listed, and Compose doesn't publish it.
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["bun", "server.js"]
