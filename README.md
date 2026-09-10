# `@agilesyndrome/cf-genai-cli`

Safe operational commands for Cloudflare Worker repositories using Wrangler and
D1. The refresh command surface contains only local and staging targets.

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
requires `--yes`. `config check` runs a Wrangler deploy dry-run. No production
refresh or backup operation is implemented.
