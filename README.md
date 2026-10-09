# Nobi AI — setup guide

Nobi is a starter implementation for a public AI assistant website with installable Progressive Web App (PWA) support. It includes account registration/login, saved chat history, AI chat, browser voice input/output, image generation, web search integration, and an admin dashboard.

## Requirements

- Node.js 20 or newer
- An AI API key for chat and image generation
- A Tavily API key for web search (optional until you enable search)
- Hosting that supports a persistent Node.js process and persistent disk storage

## Run locally

1. Install Node.js 20+.
2. Extract this project.
3. Copy `.env.example` to `.env`.
4. Generate a strong random JWT secret (at least 32 characters) and fill in `.env`.
5. Set `ADMIN_EMAIL` and a unique `ADMIN_PASSWORD` of at least 12 characters. The first start creates the admin account if it does not already exist.
6. Set `OPENAI_API_KEY`. Keep it only in `.env` on the server. Never put API keys in `public/` or browser JavaScript.
7. Optional: set `TAVILY_API_KEY` to enable Internet Search.
8. In this folder, run:
   ```bash
   npm install
   npm start
   ```
9. Open `http://localhost:3000`.

**Important:** Do not open `public/index.html` directly from Downloads or a file manager (`file://` / Android `content://`). That loads only the frontend; it does not run the Node.js API, so signup/login will fail with “Failed to fetch”. You must run/deploy the Node.js server and open Nobi using the server's website URL. For use on Android from anywhere, deploy it to an HTTPS host first.

## API keys and costs

- **AI chat + image generation:** create an API key with your chosen AI provider. This implementation uses the OpenAI Node SDK. Chat and image requests may be billed separately according to your provider/model account and current pricing. API access is separate from a ChatGPT subscription.
- **Internet search:** create a Tavily API key and set `TAVILY_API_KEY`. If missing, Nobi displays setup guidance instead of pretending it searched.
- **Voice:** uses browser SpeechRecognition (when supported and permitted) and SpeechSynthesis. Support varies by browser/device. It does not require a separate key for these browser features.

## Deploy publicly

Deploy the Node app to a service that supports Node.js and a persistent disk (examples include a VPS or a Node-capable host). Steps vary by provider:

1. Upload the project or connect its repository.
2. Set the environment variables in the host's secret/environment settings (do not upload `.env`).
3. Set `NODE_ENV=production`, `APP_ORIGIN=https://your-domain.example`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and your API keys.
4. Attach persistent storage for `nobi.sqlite` or use a managed production database. SQLite is suitable for a small starter deployment; for larger public use, migrate to PostgreSQL.
5. Configure HTTPS. Browsers generally require a secure context for microphone access and PWA installation.
6. Test registration, login, saved chats, admin access, image generation, and web search before sharing the URL.

## Android app

The website is a PWA. On Android, open the deployed HTTPS URL in Chrome and use **Install app** or **Add to Home screen**. This gives an app-like installed experience. A Play Store APK/AAB requires an additional packaging/release workflow (for example, Trusted Web Activity or Capacitor), signing, and Play Console setup; this project does not automatically produce a Play Store binary.

## Security notes before inviting the public

- The server hashes passwords with bcrypt, verifies signed tokens, scopes chat access to the owner, and checks admin roles on the server.
- Use HTTPS, strong unique secrets, provider-side spending limits, backups, and host-level rate limiting in production.
- Admin bootstrap only creates the first admin when the configured email does not exist. Changing `.env` does not automatically change an existing admin password.
- This starter uses bearer tokens in browser localStorage for simplicity. For a hardened production release, consider secure HttpOnly SameSite cookies, CSRF protection, email verification, password reset, account deletion/export, abuse monitoring, and a managed database.
- Do not put private keys in frontend code. Do not use the same password for admin and personal accounts.
- Public registration is open by design; the admin dashboard and its API routes require an admin role.

## What is implemented vs. needs configuration

Implemented in this source: responsive chat UI, account creation/login, server-side password hashing, JWT authentication, SQLite chat storage, AI chat endpoint, image generation endpoint, web-search endpoint, browser voice controls, admin user list/role/delete controls, and PWA manifest/service worker.

Requires your own setup: API keys, hosting/domain/HTTPS, backups and production monitoring. Browser voice support varies. The image model must be enabled for your API account.
