# `@agilesyndrome/cf-genai-cli`

Safe operational commands for Cloudflare Worker repositories using Wrangler and
D1. The refresh command surface contains only local and staging targets.

It also provides shared project automation so dependent repositories do not
need to duplicate their build and release logic:

```sh
cf-genai check
cf-genai lint data-access
cf-genai test
cf-genai ci
cf-genai dev
cf-genai release --confirm
cf-genai release --first --confirm
cf-genai release --dry-run
cf-genai version
  cf-genai status
  cf-genai status --json
```

`dev` runs through `op run --env-file=.env.dev --`, using the repository's
`npm run dev` script when present, otherwise starting `wrangler dev`. This
loads all `.env.dev` variables and resolves any `op://` values automatically.
`check` also rejects direct `env.DB.prepare(...)` and `DB.prepare(...)` calls
in `cf-genai-*` application source; domain code must use the scoped data reader
provided by `cf-genai-base`. Tests and migrations are excluded from this lint.
`release` owns versioning, tagging, and pushing the release trigger used by
GitHub Actions. `version` shows the installed CLI version and the latest npm
version, with an upgrade command when one is available.

For the initial npm publication only, use `cf-genai release --first --confirm`.
It checks npm authentication first and starts `npm login` for the package scope when credentials are missing or invalid. It publishes the current package once with public access and provenance disabled so npm can prompt for your interactive 2FA code;
subsequent releases should use the normal tag-triggered workflow.

```sh
cf-genai d1 refresh local
cf-genai d1 refresh staging --yes
cf-genai d1 migrate local
cf-genai d1 migrate staging
cf-genai d1 migrate production --confirm-production
cf-genai d1 status staging
cf-genai d1 check production
cf-genai config check
```

`refresh local` exports production data, applies local migrations, clears local
application tables, and imports the data. `refresh staging` does the same for a
remote staging environment. Both exclude Wrangler's migration ledger and
internal tables. The default D1 binding is `DB`; override it with `--database`.

Credential loading stays outside the CLI, so repositories can use their normal
wrapper:

```sh
op run --env-file=.env.op -- cf-genai d1 refresh local
```

Production migration requires `--confirm-production`. Remote staging refresh
requires `--yes`. Releases require `--confirm` (or can be inspected
with `--dry-run`); the CLI verifies a
clean checkout on `main`, fetches and compares `origin/main`, pushes and
verifies the release commit before creating the tag, and only then pushes the
tag that triggers npm publishing. The release tag publishes the package through GitHub Actions with provenance. `config check` runs a Wrangler deploy dry-run. Production refresh remains intentionally unavailable; backups and restores are available with explicit file paths.
Operational status can be read directly from the current site directory through Wrangler (no CLI login prompt):
  cf-genai healthcheck:list --env local
  cf-genai healthcheck:list --env staging
  cf-genai circuit-breaker:list --env prod
  cf-genai circuit-breaker:set llm:openai-models on --env staging
The standardized admin surface mirrors cf-genai-base and uses Wrangler authentication from the current machine:
  cf-genai admin status --env staging
  cf-genai admin features --env staging
  cf-genai admin users --env staging
  cf-genai admin scopes --env staging
  cf-genai admin groups --env staging
  cf-genai admin healthchecks --env staging
  cf-genai admin circuit-breakers --env staging
  cf-genai healthchecks set llm:provider red --env staging
  cf-genai circuit-breakers set llm:provider tripped --env staging
Back up and restore a complete D1 database with explicit files:
  cf-genai d1 backup production --output ./backup.sql --confirm-production
  cf-genai d1 restore staging --file ./backup.sql --yes
`release` is the only release command. It creates the version commit and tag; the tag-triggered workflow publishes to npm.
