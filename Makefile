.PHONY: run test lint

run:
	npm start

test:
	npm test

# No ESLint config in-repo and no new package.json deps.
# Optional one-off: npx --yes eslint@9 server.mjs shared.mjs lib/*.mjs --no-eslintrc --env es2024 --parser-options=ecmaVersion:2024
lint:
	node --check server.mjs
	node --check shared.mjs
	node --check app.js
	node --check lib/core.mjs
	node --check lib/store.mjs
	node --check lib/bot.mjs
	node --check lib/sync.mjs
	node --check lib/views.mjs
	node --check lib/reminders.mjs
