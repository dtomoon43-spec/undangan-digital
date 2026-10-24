# Digital Invitation Control Room — Online Starter v0.5

This package begins the online/backend phase. It contains the existing v0.4 HTML prototype plus an Express API starter for account registration/login, event membership, invitation image uploads, queue statuses, and activity history.

## Important status
- The HTML prototype is copied into `public/index.html` and still operates in local-demo mode. It is **not yet wired to these API endpoints**.
- This is a deployable starter, not a live hosted service. You must configure a PostgreSQL database, environment variables, and hosting before accounts/data are available online.
- OBS/vMix and the Local Bridge are not connected yet.

## Requirements
- Node.js 20+
- PostgreSQL 13+

## Setup
1. Create a PostgreSQL database.
2. Enable UUID generation and apply schema:
   ```sql
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   ```
   Then run `server/sql/schema.sql` using `psql` or your database console.
3. In `server/`, copy `.env.example` to `.env` and set `DATABASE_URL`, a random `JWT_SECRET` of at least 32 characters, and `CORS_ORIGIN`.
4. Install and start:
   ```bash
   npm install
   npm start
   ```
5. Open `http://localhost:8080` for the existing prototype and `http://localhost:8080/api/health` to check the API.

## API overview
- `POST /api/auth/register` — create account and first event. Password minimum 10 characters.
- `POST /api/auth/login` — login, returns 12-hour bearer token.
- `GET /api/me` — current account.
- `GET /api/events` — events current user can access.
- `GET /api/events/:eventId/invitations` — queue metadata.
- `POST /api/events/:eventId/invitations` — multipart upload with field `image` (JPEG/PNG/WebP) and optional `name`.
- `PATCH /api/events/:eventId/invitations/:id/status` — update status to DRAFT, QUEUED, APPROVED, ON_AIR, COMPLETED, or FAILED.
- `GET /api/events/:eventId/history` — latest 200 activity records.

For authenticated requests, send `Authorization: Bearer <token>`.

## Production hardening before a real event
- Put the app behind HTTPS; use a managed PostgreSQL service and persistent private object storage for uploads.
- Do not expose OBS WebSocket or vMix API ports to the public internet.
- Add rate limiting, email verification/password reset, admin invitation flows, audit retention, CSRF strategy if cookies are adopted, malware/image decoding checks, backups, and monitoring.
- Uploaded files are stored on the server filesystem in this starter. Many serverless hosts do not persist local files; use private object storage for production.
- Add an authenticated Local Bridge and then wire the dashboard UI to the API before claiming cross-device synchronization.
