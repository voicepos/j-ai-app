# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**J-AI** is an AI-powered salon management system for Riverland Nails Spa (Fort Lauderdale, FL). It has two distinct parts:

1. **`index.html`** — A self-contained single-page application (no build step) for in-salon use: kiosk check-in, online booking, owner dashboard, staff queue view, and AI settings.
2. **`server/`** — A Node.js Express backend that connects Twilio phone/SMS to Claude AI, enabling voice and text appointment booking without human staff.

## Development Commands

```bash
# Backend server (from server/ directory)
cd server
npm install
cp .env.example .env   # fill in keys before starting
npm start              # production
npm run dev            # nodemon watch mode

# Test TwiML without Twilio
curl http://localhost:3000/test-twiml

# Health check
curl http://localhost:3000/health

# Local dev: expose to Twilio via ngrok
npx ngrok http 3000    # copy URL → set PUBLIC_URL in .env
```

The frontend (`index.html`) needs no build step — open directly in a browser or serve statically.

## Architecture

### Frontend (`index.html`)
A monolithic HTML/CSS/JS file (~2700 lines). All state is in-memory (no persistence):

- **`DB` object** — runtime data store: `customers[]`, `appointments[]`, `checkins[]`, `activities[]`
- **Screen routing** — `go(id, btn)` toggles `.screen.on` CSS class; each screen is a fixed `<div>`
- **Screens**: `#kiosk` (check-in flow), `#booking` (4-step wizard), `#dashboard` (owner KPIs + AI insights), `#staff` (live queue), `#ai-config` (settings)
- **`CLAUDE_CFG`** — runtime object holding the Claude API key (saved to `localStorage`), AI toggles, and model config (`claude-sonnet-4-6`)
- **Claude integration points in the frontend**:
  - `buildGreetingAI(cust)` — calls Claude directly from the browser to personalize kiosk greetings (API key stored in localStorage)
  - `sendChatMsg()` — powers the floating chat widget (calls Claude from browser)
  - `loadDashInsights()` — generates business insights on the dashboard
  - All three make direct `fetch` calls to `https://api.anthropic.com/v1/messages` with the stored API key and model `claude-sonnet-4-6`
- **Voice AI**: ElevenLabs (preferred) or Web Speech API fallback, called from `speakGreeting()` after check-in
- **Kiosk flow**: method select → phone numpad OR new guest form → `kLookup()` → `showGreeting()` → upsell chips → success

### Backend (`server/server.js`)
Single-file Express app. Key design decisions:

- **In-memory session store** (`Map` keyed by Twilio `CallSid`) — not persistent; a comment says to use Redis in production
- **Twilio signature validation** is skipped when `NODE_ENV=development` or `PUBLIC_URL` is unset; enforced in production
- **Claude prompt caching** — the system prompt is sent with `cache_control: { type: 'ephemeral' }` on every call to reduce token costs across multi-turn calls within one phone session
- **AI control tags** parsed from Claude's response text:
  - `[FORWARD]` → dial `SALON_PHONE_NUMBER` via Twilio `<Dial>`
  - `[DONE]` → `<Hangup>` the call
  - `[BOOKED: name=X, service=X, date=X, time=X]` → log booking (TODO hook for external booking API at the comment in `server.js`)
  - `[NEEDS_HUMAN]` (SMS only) → reply with staff follow-up message
- **Voice**: always `Polly.Joanna` (en-US); language switching was removed
- **Max no-speech attempts**: 4 before forwarding to salon

### Environment Variables
All required vars are listed in `server/.env.example`. The four **required** ones (validated at startup):
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `SALON_PHONE_NUMBER`

Optional ones with defaults: `SALON_NAME`, `BUSINESS_HOURS`, `SERVICES`, `PORT`, `PUBLIC_URL`.

## Key Conventions

- **English only** throughout — the server is hard-coded to `language: 'en-US'` and `Polly.Joanna`; do not add language-switching logic
- **Claude model**: `claude-sonnet-4-6` — used in both the frontend (direct browser API calls) and the backend
- **Frontend API key handling**: the Claude API key is entered by the user in the AI Settings screen and stored in `localStorage` (`j-ai-claude-key`); it is never server-side in the frontend context
- **Booking integration hook**: when a `[BOOKED:]` tag is detected in `server.js` (~line 214), there is a `// TODO: call your booking API here` comment — this is the intended extension point
- **No test framework** is present; test manually with `curl` against `/health` and `/test-twiml`, or via actual Twilio test calls
