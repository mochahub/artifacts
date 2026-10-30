FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile && bun run build

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=build /src/apps/server/dist/ ./
COPY --from=build /src/apps/viewer/dist ./public
COPY --from=build /src/apps/server/drizzle ./drizzle
ENV NODE_ENV=production PORT=8080 CONTENT_PORT=8081 INTERNAL_PORT=8082
EXPOSE 8080 8081 8082
HEALTHCHECK CMD bun -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1))"
CMD ["bun", "server.js"]
