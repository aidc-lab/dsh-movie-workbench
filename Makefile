SHELL := /bin/bash

NODE      ?= node
NPM       ?= npm
DSH       ?= dsh
PROFILE   ?= desktop
PKG       := dsh-movie-workbench
REGISTRY  ?= https://registry.npmjs.org
NPM_CACHE ?=

SOURCES := index.js client.js lib/host.js lib/providers.js scripts/dev-server.mjs \
           $(wildcard lib/host/*.js) $(wildcard lib/host/routes/*.js) \
           $(wildcard lib/providers/*.js) \
           tests/client-smoke.mjs tests/render-smoke.mjs tests/pick-smoke.mjs \
           tests/access-smoke.mjs tests/browse-smoke.mjs tests/torrent-smoke.mjs

NPMFLAGS = $(if $(NPM_CACHE),--cache $(NPM_CACHE))

.DEFAULT_GOAL := help
.PHONY: help check smoke test live pack publish install uninstall clean

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

check: ## Syntax-check every JavaScript file
	@for file in $(SOURCES); do $(NODE) --check $$file || exit 1; done
	@echo "syntax ok"

smoke: check ## Offline tests: panel registration and rendered page states
	$(NODE) tests/client-smoke.mjs
	$(NODE) tests/render-smoke.mjs
	$(NODE) tests/access-smoke.mjs
	$(NODE) tests/browse-smoke.mjs
	$(NODE) tests/torrent-smoke.mjs
	$(NODE) tests/pick-smoke.mjs

test: smoke ## Alias for the offline test suite (no network)

live: check ## Live end-to-end harness against TMDB, IMDb, 豆瓣 and the BT indexes
	$(NODE) scripts/dev-server.mjs

pack: ## Show the files and size npm would publish
	$(NPM) $(NPMFLAGS) pack --dry-run --registry=$(REGISTRY)

publish: ## Publish to npm (prompts for a 2FA one-time password)
	$(NPM) $(NPMFLAGS) publish --registry=$(REGISTRY) --access public

install: ## Install into the DSH profile through the CLI (quit DSH Desktop first)
	$(DSH) plugin --profile $(PROFILE) add "$(CURDIR)"

uninstall: ## Remove it from the DSH profile through the CLI (quit DSH Desktop first)
	$(DSH) plugin --profile $(PROFILE) remove $(PKG)

clean: ## Remove local npm tarballs
	rm -f $(PKG)-*.tgz
