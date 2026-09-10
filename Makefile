.PHONY: check test build bump publish wait release

PACKAGE_NAME := $(shell node -p "require('./package.json').name")
VERSION = $(shell node -p "require('./package.json').version")
MAX_ATTEMPTS ?= 30
WAIT_SECONDS ?= 10

check:
	npm run check

test:
	npm test

build:
	npm run build

bump:
	@test -z "$$(git status --porcelain)" || (echo "Working tree must be clean before bumping." >&2; exit 1)
	npm version patch --no-git-tag-version
	git add package.json
	@test ! -e package-lock.json || git add package-lock.json
	git commit -m "Release $(PACKAGE_NAME) v$$(node -p "require('./package.json').version")"
	git tag "v$$(node -p "require('./package.json').version")"

publish:
	git push origin main "v$(VERSION)"

wait:
	@echo "Waiting for $(PACKAGE_NAME)@$(VERSION) to appear on npm..."
	@attempt=0; \
	until test "$$(npm view "$(PACKAGE_NAME)@$(VERSION)" version 2>/dev/null || true)" = "$(VERSION)"; do \
		attempt=$$((attempt + 1)); \
		if test "$$attempt" -ge "$(MAX_ATTEMPTS)"; then \
			echo "Timed out waiting for $(PACKAGE_NAME)@$(VERSION) on npm." >&2; exit 1; \
		fi; \
		sleep "$(WAIT_SECONDS)"; \
	done
	@echo "$(PACKAGE_NAME)@$(VERSION) is available on npm."

release: bump
	$(MAKE) publish wait
