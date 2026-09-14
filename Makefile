.PHONY: test test-backend test-frontend deploy release dev-backend dev-frontend

test: test-backend test-frontend

test-backend:
	cd backend && uv run pytest -q

test-frontend:
	cd frontend && npm run typecheck && npm test && npm run build

dev-backend:
	cd backend && DATA_DIR=$(PWD)/data ENV=dev uv run uvicorn app.main:app --reload --port 8000

dev-frontend:
	cd frontend && npm run dev

deploy:
	scripts/deploy.sh

# make release v=0.2.0
release:
	scripts/release.sh v$(v)
