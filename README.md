# Backpack Server

Backend for **Backpack** — a mobile gear-weight tracker for hikers (Flutter, Android).
The app works fully offline; this server adds optional accounts and syncs a user's
gear, categories and trips between their devices.

## Stack

- **Node.js** + **TypeScript**
- **Fastify** — HTTP server
- **PostgreSQL** — server database
- **Docker** — local development and deployment

## How sync works

The phone is the source of truth (offline-first). Every synced record carries a
`uuid` shared across devices and an `updatedAt` timestamp. Devices push their
changes and pull everything changed since their last sync; when two devices edited
the same record, the later edit wins. Deletions are synced too, so a deleted item
doesn't come back from another device's copy.

## Status

Early development.
