# Releasing

The CLI repository runs its shared commands from source:

```sh
node bin/cf-genai.js ci
node bin/cf-genai.js release
```

`release` requires a clean tree, bumps the patch version when the current
version or tag is already consumed, commits package metadata, creates the
matching `v<version>` tag, and pushes both `main` and the tag.

For the one-time npm bootstrap, run `node bin/cf-genai.js publish:first` and
complete npm's interactive prompts. Then configure npm Trusted Publishing for
organization `agilesyndrome`, this repository, workflow `publish.yml`, and
`npm publish`. Later releases use GitHub OIDC and require no npm token.
