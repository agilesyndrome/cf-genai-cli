# Releasing

The CLI repository runs its shared commands from source:

```sh
node bin/cf-genai.js ci
node bin/cf-genai.js release --confirm
node bin/cf-genai.js release --dry-run
```

`release` requires explicit human confirmation and a clean checkout on `main`.
It fetches and verifies that local `main` matches `origin/main`, bumps the
patch version when the current version or tag is already consumed, commits
package metadata, pushes and verifies `main`, then creates and pushes the
matching `v<version>` tag. The tag starts the GitHub Actions publish workflow.

The release tag triggers `publish.yml`, which verifies the package and publishes it to npm with GitHub OIDC and provenance.
