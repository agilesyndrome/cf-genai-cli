# Releasing

The CLI repository runs its shared commands from source:

```sh
node bin/cf-genai.js ci
node bin/cf-genai.js release --confirm
node bin/cf-genai.js release --first --confirm
node bin/cf-genai.js release --dry-run
```

`release` requires explicit human confirmation and a clean checkout on `main`.
It fetches and verifies that local `main` matches `origin/main`, bumps the
patch version when the current version or tag is already consumed, commits
package metadata, pushes and verifies `main`, then creates and pushes the
matching `v<version>` tag. The tag starts the GitHub Actions publish workflow.

The release tag triggers `publish.yml`, which verifies the package and publishes it to npm with GitHub OIDC and provenance.

For a package that has not yet been published, `release --first --confirm`
checks npm authentication, starts `npm login` when needed, publishes the
current version directly with public access and provenance disabled, and then
configures npm Trusted Publishing for `.github/workflows/publish.yml`. The
trust step requires npm 11.15.0 or newer, account-level 2FA, and package write
access. For an already-published package, use `release --add-trust --confirm`.
