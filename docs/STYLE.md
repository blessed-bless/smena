# Portfolio style standard

Target look: one developer, calm and concrete. Behavior stays the same; style aligns.

## Layout

```
lib/               # server modules (core, store, bot, sync, …)
tests/             # node:test
deploy/            # VPS / systemd / Caddy helpers
docs/screenshots/  # UI captures
Makefile           # run test lint
.env.example
Dockerfile / compose.yaml
README.md
```

## JavaScript

- Runtime: **Node.js 24+** (see `.nvmrc`)
- Dependencies: **none** (stdlib only)
- Lint: `make lint` → `node --check` (optional ESLint via npx without package.json)
- Comments: English or Russian, explain *why*

## README

One sentence · screenshot · 4–6 capabilities · mermaid · stack · run · config table · security notes.

## Commits

Conventional Commits, English, short. Sole human author.
