<div align="center">

<img src="assets/logo.svg" width="160" height="160" alt="nano-cloud logo" />

# nano-cloud

**A small cloud drive. A simple way to share.**

Lightweight · Self-hosted · Powered by Cloudflare · Claude-inspired interface

<p>
  <a href="https://developers.cloudflare.com/workers/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" /></a>
  <a href="https://developers.cloudflare.com/r2/"><img src="https://img.shields.io/badge/Storage-R2%20%2F%20S3%20%2F%20WebDAV-a64f36?style=flat-square" alt="R2, S3 and WebDAV" /></a>
  <a href="https://developers.cloudflare.com/d1/"><img src="https://img.shields.io/badge/Database-D1-302e29?style=flat-square" alt="Cloudflare D1" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-35664c?style=flat-square" alt="MIT license" /></a>
</p>

[中文](README.md) · English

[Features](#features) · [Getting started](#getting-started) · [Deployment](#deployment) · [Acknowledgments](#acknowledgments)

A lightweight file-sharing drive built on Cloudflare Workers, R2 and D1, with S3-compatible and remote WebDAV storage options. The native HTML frontend uses Claude-inspired warm paper colors, restrained spacing and clear typography.

</div>

---

## Features

- File uploads, management and storage browsing.
- Password-protected shares, expiration, download limits, revocation and direct links.
- Public marketplace with search and sorting.
- Monthly traffic quotas, per-IP limits, automatic bans and activation codes.
- Admin sessions, TOTP, recovery codes and login auditing.
- Cloudflare Turnstile and OAuth download authentication.
- R2, S3-compatible and remote WebDAV storage, plus an authenticated WebDAV server.
- Download logs, daily traffic and country distribution, with optional Analytics Engine.
- Chinese/English, responsive layouts and light/dark admin themes.

Production code has no npm runtime dependencies. This version updates upstream styling and branding, with targeted fixes for admin JavaScript, sharing, global distribution, traffic accounting and prepaid activation quotas. It also fixes concurrent limits, storage changes, WebDAV operations, OAuth callbacks and database migrations.

## Getting started

Install Node.js compatible with the locked Wrangler version, npm and a Cloudflare account. From the project root:

```bash
npm ci
```

Create an ignored `.dev.vars` file with your own long random admin key:

```dotenv
admin=replace-with-your-own-long-random-key
```

```bash
npm run dev -- --local --config wrangler.jsonc
```

Open [http://localhost:8787/admin](http://localhost:8787/admin). The current configuration declares D1/R2 bindings, allowing Wrangler to emulate them locally. Database initialization runs on first access. Do not commit `.dev.vars`.

## Deployment

See [DEPLOY.md](DEPLOY.md) and [DEPLOY-S3.md](DEPLOY-S3.md). Use the current `wrangler.jsonc` and verify that its bindings point to your intended resources.

```bash
npx wrangler login
npx wrangler d1 create nano-cloud
npx wrangler r2 bucket create nano-cloud
```

Fill in the returned D1 database ID under `database_id`, confirm resource names, then set the admin secret and deploy:

```bash
npx wrangler secret put admin --config wrangler.jsonc
npm run deploy -- --config wrangler.jsonc
```

Reuse existing resources if available; do not recreate them. CLI deployments use binding declarations from the configuration, so do not rely only on dashboard settings.

| Configuration | Value / purpose |
| --- | --- |
| Worker name | `nano-cloud` |
| `db` | D1 database, example name `nano-cloud` |
| `r2` | R2 bucket, example name `nano-cloud` |
| `analytics` | Optional Analytics Engine; current dataset `r2pan_downloads` |
| `admin` | Secret for admin login and encryption |
| Turnstile | Configure the corresponding secrets or admin settings when enabled |
| `totp_recovery` | Optional two-factor recovery secret |

Renaming the project does not rename existing Cloudflare resources or migrate data. Keep the actual Worker name, database ID, bucket name and secrets when updating an existing instance. A new Worker needs its own secrets and domain configuration. An existing site title stored in D1 must be changed manually in the admin settings.

## Verification

Check admin login, file upload/listing and a test share download. Check the marketplace, direct links, OAuth, Turnstile and WebDAV if enabled. Inspect live logs with:

```bash
npm run tail -- --config wrangler.jsonc
```

Using Node.js 24 after installing dependencies:

```bash
node scripts/check-downloads.mjs
node scripts/check-global.mjs
```

Tests use in-memory SQLite, simulated storage and the real chart engine without accessing Cloudflare or live data. There is no `npm run check`; full TypeScript checking still reports known storage type errors.

### Download accounting

After authorization and object lookup, a D1 transaction reserves the download allowance and activation quota before returning a file. Insufficient quota blocks the file; unauthorized requests, missing objects, invalid ranges and HEAD do not spend quota. Range requests reserve only the requested bytes. Interrupted downloads are not automatically refunded.

Traffic totals record server response lengths asynchronously, aggregate by UTC day, and reset at the first write in a new month. Country statistics use download logs; old entries without country metadata remain unknown. Map data and chart scripts are served by this Worker.

## Project structure

- `assets/logo.svg`: README logo.
- `public/admin.html`, `share.html`, `market.html`: frontend pages.
- `src/`: Worker routes, admin APIs, sharing, storage, authentication and database logic.
- `wrangler.jsonc`: configuration used by this guide.
- `wrangler.toml`: alternative configuration retained from upstream.

Routes: `/admin`, `/market`, `/s/:token`, `/d/:token` and `/webdav/`.

## Acknowledgments

nano-cloud is based on [Admin666pro/cloud-r2pan](https://github.com/Admin666pro/cloud-r2pan). Thank you to **Admin666pro** for the Workers/R2/D1 architecture, file sharing, authentication and storage implementations. This version builds on the upstream architecture, updates the interface and branding, and fixes download, authentication, storage and accounting flows. The README layout follows FlareDrive.

## License

[MIT](LICENSE), with the upstream copyright and license preserved.
