<img src="assets/icon.svg" width="64" height="64" alt="">

# Artifacts

Created in [T3 Code](https://t3.codes).

## Development

You need [Bun](https://bun.sh) 1.4.2 and Docker.

```
bun install
bun run dev      # Postgres, SeaweedFS, the server on 8080, Vite on 5173
bun run test     # unit, data-model and API tests
bun run e2e      # the viewer in WebKit (first: cd apps/viewer && bunx playwright install webkit)
bun run lint
```

The design is in [`docs/SPEC.md`](docs/SPEC.md), and the build guides are in [`docs/implementation/`](docs/implementation/README.md).
