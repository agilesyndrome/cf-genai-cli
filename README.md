# `@agilesyndrome/cf-genai-cli`

Safe operational commands for Cloudflare Worker repositories using Wrangler and
D1. The refresh command surface contains only local and staging targets.

It also provides shared project automation so dependent repositories do not
need to duplicate their build and release logic:

```sh
cf-genai check
cf-genai test
cf-genai ci
cf-genai dev
cf-genai release --confirm-release
cf-genai version
```

`dev` runs the repository's `npm run dev` script when present, otherwise it
starts `wrangler dev`. `release` owns versioning, tagging, and pushing the
release trigger used by GitHub Actions. `version` shows the installed CLI
version and the latest npm version, with an upgrade command when one is
available.

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
requires `--yes`. Releases require `--confirm-release`; the CLI verifies a
clean checkout on `main`, fetches and compares `origin/main`, pushes and
verifies the release commit before creating the tag, and only then pushes the
tag that triggers npm publishing. Initial direct publishing requires
`--confirm-publish`. `config check` runs a Wrangler deploy dry-run. No
production refresh or backup operation is implemented.
Operational status can be read directly from the current site directory through Wrangler (no CLI login prompt):
  cf-genai healthcheck:list --env local
  cf-genai healthcheck:list --env staging
  cf-genai circuit-breaker:list --env prod
  cf-genai circuit-breaker:set llm:openai-models on --env staging
