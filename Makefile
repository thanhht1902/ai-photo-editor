.DEFAULT_GOAL := help
.PHONY: help install lint lint-fix check build test pre-commit docker-build docker-test docker-up docker-down docker-logs
.NOTPARALLEL: pre-commit

help:
	@printf '%s\n' \
	  'make install      Install locked npm dependencies' \
	  'make pre-commit   Run lint, build (including typecheck), and tests' \
	  'make lint-fix     Apply automatic lint fixes' \
	  'make docker-build Build the runtime image' \
	  'make docker-test  Run lint, build, and tests inside Docker' \
	  'make docker-up    Build and start at http://127.0.0.1:8787' \
	  'make docker-down  Stop containers, keeping project data' \
	  'make docker-logs  Follow application logs'

install:
	npm ci

lint:
	npm run lint

lint-fix:
	npm run lint:fix

check:
	npm run check

build:
	npm run build

test:
	npm test

pre-commit: lint build test

docker-build:
	docker compose build

docker-test:
	docker build --target checks -t stillroom-checks .

docker-up:
	docker compose up --build --detach --wait

docker-down:
	docker compose down

docker-logs:
	docker compose logs --follow
