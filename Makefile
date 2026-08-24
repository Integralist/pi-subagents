# pi-subagents — development tasks.
#
# `make` on its own lists the targets. `make verify` is what to run before
# committing: it is the four checks the plan's verification section names.

.DEFAULT_GOAL := help
.PHONY: help install test watch typecheck lint format load-check verify try agents clean

PI ?= pi

help: ## List the available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

test: ## Run the test suite once
	npx vitest --run

watch: ## Run the test suite and re-run it on every change
	npx vitest

typecheck: ## Check types without emitting anything
	npx tsc --noEmit

lint: ## Check formatting and lint rules
	npx biome check src test

format: ## Apply the formatter and every safe lint fix
	npx biome check --write src test

load-check: ## Load the extension through pi's own loader, as pi will
	node scripts/load-check.mjs

verify: test typecheck lint load-check ## Everything above, in one go

try: ## Open a pi session with this extension loaded, for a live walkthrough
	$(PI) -e ./src/index.ts

agents: ## Copy the example agents into this project's .pi/agents (keeps yours)
	@mkdir -p .pi/agents
	@cp -n examples/*.md .pi/agents/ 2>/dev/null || true
	@echo "example agents are in .pi/agents:" && ls .pi/agents

clean: ## Remove build output and test scratch
	rm -rf dist node_modules/.vite
