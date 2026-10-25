# LEGA

LEGA is an accounting and inventory application built with NestJS, React, BlueprintJS, and MariaDB. The interface defaults to a light green theme, supports an explicit dark preference, and places company switching in the right sidebar.

## Local development

Use Node.js 18 and pnpm. Copy `.env.example` to the root `.env`, start dependencies with `docker compose up -d`, then run:

```sh
pnpm install
pnpm run build:server
pnpm run system:migrate:latest
pnpm run dev:server
pnpm run dev:webapp
```

Build the server before using migration commands. System and tenant databases have separate migrations. The webapp runs on port 4000 and proxies API requests to the server (port 3000 by default). Configure a different backend using `VITE_API_PROXY_TARGET` in the root `.env`.

## Standalone QuickBooks Online extraction

Run `pnpm qbo:import connect`, then `pnpm qbo:import extract --out ./qbo-data/company-backup` to save QBO records and reconciliation reports for a later lega-v2 import. This CLI runs independently of the API and databases. Configure the `QBO_*` values in the root `.env` first; see [the CLI setup and bundle documentation](packages/qbo-import/README.md). Use `resume --out DIR` after interruption and `validate --out DIR` for offline verification.

## Branding

LEGA assets are bundled locally. Optional `VITE_BRAND_WEBSITE_URL`, `VITE_BRAND_DOCS_URL`, and `VITE_BRAND_SUPPORT_URL` settings enable external website/help links; unset destinations are hidden. Set `PLAID_CLIENT_NAME` to override the LEGA display name shown in Plaid. Tenant company names, uploaded logos, and customized documents take precedence over application defaults.

New visitors start in light mode. The account menu and Shift+H shortcut persist an explicit theme choice. Payment pages use light mode without changing that preference. Developer query tools are opt-in with `VITE_REACT_QUERY_DEVTOOLS=true` in development.

## Checks

```sh
node --test packages/webapp/tests/*.test.cjs
pnpm run typecheck
pnpm run build
pnpm run e2e:webapp
```

See [AGENTS.md](AGENTS.md) for the repository structure, data transformations, and additional commands.

## License and attribution

This project is derived from [Bigcapital](https://github.com/bigcapitalhq/bigcapital). Original copyright and license notices are retained. See [LICENSE](LICENSE) for the GNU Affero General Public License. Internal package names retain the `@bigcapital` namespace for compatibility.
