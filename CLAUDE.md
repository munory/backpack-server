# Backpack Server — context for Claude

Backend for the Backpack app. Read this first; the app's own decision log has the
full history.

## The project

- **App:** Flutter gear-weight tracker for hikers, at `C:\learning\backpack`
  (GitHub `munory/backpack`). Read its `DECISIONS.md` for why things are the way
  they are — server decisions are logged there too (newest on top).
- **Owner:** a designer moving into development (frontend/React background), new to
  backend. This is a pet/portfolio project and a way to *learn* backend. Talk to her
  in Russian, in plain words, explain every step (what, why, how it works, typical
  pitfalls). She asked that Claude write the code in small explained steps.
- **Why our own server** (not Firebase/PocketBase/Supabase): personal data of Russian
  users must be stored in Russia (152-FZ) → self-hosted on a Russian VPS; and writing
  it ourselves is the learning/portfolio goal.

## Stack and conventions

- Node.js 22 + TypeScript, Fastify, PostgreSQL. Docker for Postgres locally and for
  deployment (VPS + Caddy for https + scheduled backups) — VPS/domain bought later.
- Security-critical parts come from proven libraries, never hand-rolled: password
  hashing (argon2), Google ID-token verification, token signing.
- Commits: only when she asks; authored as her (git global identity "munory"), **no
  Co-Authored-By line**, English message with a short description. Never commit
  `.claude/` or `.env`.

## What the app needs from the server

- **Accounts are optional** — the app works fully without signing in.
- Sign in with **Google** or **email + password** (with password reset by email);
  sign out; **delete account** (Google Play requirement).
- **Sync everything** except per-device settings (theme, language, weight units):
  categories (tree via parent), items, trips, trip items (per-trip quantity, inBag).
- **Offline-first:** the phone's SQLite (Drift) is the source of truth; the server
  holds a copy.

## Data model on the app side (schema 20) — what sync builds on

- `categories`, `items`, `trips`: each row has `uuid` (TEXT, same on all devices —
  local integer ids differ per device) and `updated_at` (INTEGER, ms since epoch).
- `trip_items`: no uuid of its own — identified across devices by
  `"<tripUuid>/<itemUuid>"`; has `updated_at`.
- References between tables are local integer ids on the phone; over the wire they
  must be uuids (item.categoryUuid, category.parentUuid, tripItem trip/item uuids).
- SQLite triggers bump `updated_at` on any update that doesn't set it, and log every
  delete into `sync_deletions (entity, entity_key, deleted_at)`.
- Weights are integer grams. Enums are stored as ints (packType, condition) — keep
  their meaning in sync with the app's `lib/data/database.dart`.

## Sync rules (agreed with the owner)

- Conflict: **the later `updatedAt` wins** (last-write-wins, per row).
- Deletions propagate (from `sync_deletions`); a delete newer than the row wins.
- **First sign-in with data on both sides = merge:** match by name + category name
  (case-insensitive; same-named items pair up one-to-one), keep one copy, newer edit
  wins; categories and trips merge by name. After that, match by uuid only. The
  local deletion log is cleared on first sign-in (the cloud never saw those rows).

## API contract (draft — refine as we build)

- `POST /auth/register` `{email, password}` → `{accessToken, refreshToken, user}`
- `POST /auth/login` `{email, password}` → same
- `POST /auth/google` `{idToken}` → same
- `POST /auth/refresh` `{refreshToken}` → new tokens
- `POST /auth/logout` `{refreshToken}`
- `POST /auth/password-reset/request` `{email}`; `POST /auth/password-reset/confirm`
  `{token, newPassword}`
- `GET /me`, `DELETE /me` (deletes the account and all its data)
- `POST /sync` `{cursor, changes: {categories, items, trips, tripItems}, deletions}`
  → `{cursor, changes, deletions}` — one call pushes local changes and pulls
  everything changed on the server since `cursor`.
- `GET /health` — liveness check.
