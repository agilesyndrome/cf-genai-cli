# Changelog

## 5.0.0

- Upgrade base, auth, LLM, and messaging packages through one canonical command.
- Vendor migrations owned by any upgraded first-party package.
- Allow `release --version` to publish an equal prepared manifest version when its tag and npm version do not exist.
- Continue rejecting older, tagged, or already-published release versions.
