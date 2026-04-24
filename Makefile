# Dev commands for the Lampa plugin marketplace.
#
# See README.md for the user-facing story and CLAUDE.md for conventions.
# Interactive workflows (plugin registration) live in Claude Code as
# slash commands — this Makefile covers everything shell-driven.
#
# Variables:
#   PY         python interpreter        (default: python3)
#   LOG_PORT   log-server listen port    (default: 9999)
#   LOG_DIR    log-server output dir     (default: ./logs)

PY         ?= python3
LOG_PORT   ?= 9999
LOG_DIR    ?= storage/logs
CATALOG    := ./scripts/build-catalog.py
LOG_SERVER := ./log-server.py
DEV_LAMPA  := ./scripts/lampa-dev.sh

.DEFAULT_GOAL := help

.PHONY: help logs logs-tls catalog list lampa serve new-plugin install-dev clean distclean

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*##"; print "Targets:"} /^[a-zA-Z_-]+:.*##/ {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "Inside Claude Code (interactive, not make):"
	@echo "  /build-plugin <name>   register plugins/<name>.js, regen catalog, commit, push"
	@echo "  /lampa                 boot local Lampa with saved session"

logs: ## Start log-collector server on LAN (HTTP, port $(LOG_PORT))
	$(PY) $(LOG_SERVER) --port $(LOG_PORT) --dir $(LOG_DIR)

logs-tls: ## Same as 'logs' but HTTPS with self-signed cert (for HTTPS Lampa)
	$(PY) $(LOG_SERVER) --port $(LOG_PORT) --dir $(LOG_DIR) --tls

catalog: ## Regenerate extensions.json from plugins.yml
	@test -x $(CATALOG) || { echo "✗ missing $(CATALOG) (scripts/ is gitignored personal tooling)"; exit 1; }
	$(CATALOG)

list: ## Show registered plugins grouped by category
	@test -x $(CATALOG) || { echo "✗ missing $(CATALOG)"; exit 1; }
	$(CATALOG) list

lampa: ## Boot local Lampa (needs vendor/lampa-source/ + storage/dev-session.json)
	@test -x $(DEV_LAMPA) || { echo "✗ missing $(DEV_LAMPA) (personal dev tool, not tracked)"; exit 1; }
	$(DEV_LAMPA)

serve: ## Serve repo root on :8000 — preview index.html locally
	$(PY) -m http.server 8000

new-plugin: ## Reminder to run /build-plugin NAME=<slug> inside Claude Code
	@test -n "$(NAME)" || { echo "usage: make new-plugin NAME=<slug>"; exit 1; }
	@echo "Run '/build-plugin $(NAME)' inside Claude Code."
	@echo "It scaffolds plugins/$(NAME).js (if absent), registers in plugins.yml,"
	@echo "regenerates extensions.json, commits + pushes."

install-dev: ## One-time: npm install in scripts/ (puppeteer-core for session injector)
	cd scripts && npm install

clean: ## Remove Playwright artifacts and stray .DS_Store files
	rm -rf .playwright-mcp
	find . -name '.DS_Store' -not -path './.git/*' -delete

distclean: clean ## Also drop collected logs and scripts/ node_modules
	rm -rf $(LOG_DIR)
	rm -rf scripts/node_modules
