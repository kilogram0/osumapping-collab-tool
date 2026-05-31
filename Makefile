# Local development helpers.
# All commands run through docker compose, matching the project's workflow.

COMPOSE := docker compose

.DEFAULT_GOAL := help

.PHONY: help run stop migrate tests frontend-tests backend-tests

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

run: ## Build and start the full stack (db, backend, frontend)
	$(COMPOSE) up --build

stop: ## Stop and remove the running containers
	$(COMPOSE) down

# Apply migrations. With no argument, upgrades to head.
# With `rev=<id>`, moves to that revision in whichever direction is needed:
# upgrades forward, or reverts back if the revision is already applied.
#   make migrate
#   make migrate rev=abc123
migrate: ## Run alembic migrations (optional rev=<id> to up/downgrade to)
	@if [ -z "$(rev)" ]; then \
		$(COMPOSE) exec backend alembic upgrade head; \
	elif $(COMPOSE) exec -T backend alembic history -r base:current | grep -q "$(rev)"; then \
		echo "Revision $(rev) already applied — downgrading to it"; \
		$(COMPOSE) exec backend alembic downgrade $(rev); \
	else \
		echo "Upgrading to $(rev)"; \
		$(COMPOSE) exec backend alembic upgrade $(rev); \
	fi

tests: backend-tests frontend-tests ## Run the full test suite (backend + frontend)

# Pass `path=<dir-or-file>` to run a subset, e.g.
#   make backend-tests path=tests/test_auth.py
#   make frontend-tests path=src/components/PostCard.test.tsx
backend-tests: ## Run backend pytest suite (optional path=<dir/file>)
	$(COMPOSE) exec backend pytest $(path)

frontend-tests: ## Run frontend vitest suite (optional path=<dir/file>)
	$(COMPOSE) exec frontend npx vitest run $(path)
