# The Railway template

`artifacts setup` deploys this with `railway deploy --template <code>`, using `TEMPLATE` in `packages/cli/src/railway/setup.ts`. A template doesn't need to be published for that. `ARTIFACTS_RAILWAY_TEMPLATE` overrides it.

## What it holds

| Service     | Source                                         | Domains                                               | Variables                                         |
| ----------- | ---------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------- |
| `artifacts` | `ghcr.io/mochahub/artifacts:<version>`, pinned | Generated, port 8080 (viewer) and port 8081 (content) | Below. Health check `/api/health`, Serverless off |
| `Postgres`  | Railway Postgres                               | none                                                  |                                                   |
| `bucket`    | Railway Storage Bucket                         | none                                                  |                                                   |

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
S3_ENDPOINT=${{bucket.ENDPOINT}}
S3_REGION=${{bucket.REGION}}
S3_BUCKET=${{bucket.BUCKET}}
S3_ACCESS_KEY_ID=${{bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY=${{bucket.SECRET_ACCESS_KEY}}
S3_FORCE_PATH_STYLE=false
PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
SETUP_TOKEN=${{secret(48)}}
SESSION_SECRET=${{secret(64)}}
OPS_SECRET=${{secret(64)}}
```

Railway drops plain values when it makes a template, so `S3_FORCE_PATH_STYLE` and six Postgres variables arrive blank and required. `artifacts setup` passes them to `railway deploy` (`TEMPLATE_VALUES` in `setup.ts`). Set the same defaults in the template editor so the Deploy button works too.

`SETUP_TOKEN` must not be sealed, because `artifacts setup` reads it. `CONTENT_URL` isn't here: no variable holds the second domain (spike S1), so `artifacts setup` sets it.

## Publishing it

1. Deploy the services above in a project, using a released image.
2. `railway templates create --project <project> --json` makes an unpublished draft.
3. Check in the template editor that the bucket, both domains and `${{secret()}}` survived.
4. Test it: `railway init --name test`, then `railway deploy --template <code>`.
5. `railway templates publish`, then set the template's code as the default in `packages/cli/src/railway/setup.ts`.

For a release, bump the image tag and republish. `artifacts upgrade --server` works without this; the template only matters for new deploys.
