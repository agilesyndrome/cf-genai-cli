# Releasing

The CLI repository runs its shared commands from source:

```sh
node bin/cf-genai.js ci
node bin/cf-genai.js release --confirm-release
node bin/cf-genai.js release --dry-run
```

`release` requires explicit human confirmation and a clean checkout on `main`.
It fetches and verifies that local `main` matches `origin/main`, bumps the
patch version when the current version or tag is already consumed, commits
package metadata, pushes and verifies `main`, then creates and pushes the
matching `v<version>` tag. The tag starts the GitHub Actions publish workflow.

For the one-time npm bootstrap, run
`node bin/cf-genai.js publish:first --confirm-publish` and complete npm's
interactive prompts. Then configure npm Trusted Publishing for organization
`agilesyndrome`, this repository, workflow `publish.yml`, and `npm publish`.
Later releases use GitHub OIDC and require no npm token.
