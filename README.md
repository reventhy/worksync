# WorkSync

A personal productivity suite that aggregates **Jira issues**, **Slack messages**, **Discord mentions/DMs**, and **Google Calendar tasks** into a single dashboard. Built as a Chrome extension with a companion Android app.

## What It Does

WorkSync keeps you on top of your work by pulling together:

- **Jira Reviews** — surfaces issues that need your review based on custom field filters (e.g. "Design Status = Need Review"), with configurable project, field, and sort options
- **Slack Messages** — scans your DMs and channels for important/unread messages, scores them by importance using AI (Groq LLM), and highlights what needs attention
- **Discord Mentions & DMs** — tracks messages sent directly to a Discord bot or messages that explicitly mention that bot, then summarizes who is pinging it most often
- **Google Calendar Tasks** — creates calendar events from Jira issues and Slack messages so nothing falls through the cracks
- **Scheduled Tasks & Reminders** — local task/reminder system with due dates and notifications
- **Daily Reports** — optional Slack bot that posts a daily summary of your pending items to a channel
- **Cross-Device Sync** — Firebase Firestore keeps the extension and Android app in sync

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│  Chrome Extension   │────▶│  Firebase Firestore │◀────│ Android App (Expo)  │
│  (primary client)   │     │    (sync layer)     │     │  (companion viewer) │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
        │                            ▲
        ├── Jira REST API            │
        ├── Slack Web API            │
        ├── Google Calendar API      │
        └── Groq LLM API             │
                                     │
                           ┌─────────────────────┐
                           │  Discord Worker     │
                           │  (bot + Gateway)    │
                           └─────────────────────┘
                                     │
                                     └── Discord Gateway / Bot API
```

The **Chrome extension** is the primary data source for Jira, Slack, Calendar, tasks, and reminders. It fetches from Jira, Slack, and Calendar, enriches Slack messages with AI, and pushes shared config/cache to Firestore.

The **Discord worker** is a separate bot process. It listens to Discord Gateway events, normalizes messages that matter, and writes `discordMessages` plus `discordMentionsSummary` into the same Firestore document.

The **Android app** pulls config and cache from Firestore, can independently fetch Jira, and displays everything in a native mobile UI. Slack and Discord data flow through Firestore.

## Project Structure

```
├── extension/          # Chrome Extension (Manifest V3)
│   ├── background.js   # Service worker — sync engine, alarms, Firestore push/pull
│   ├── popup.html/js   # Popup UI — quick overview of Jira, Slack, tasks
│   ├── options.html/js # Full settings page — API keys, filters, schedules
│   ├── firebase.js     # Firestore REST client (no SDK, MV3-compatible)
│   ├── api/
│   │   ├── jira.js     # Jira REST API client
│   │   ├── slack.js    # Slack Web API client
│   │   ├── calendar.js # Google Calendar + Tasks API
│   │   └── gemini.js   # Groq LLM for Slack message enrichment
│   └── manifest.json
│
├── app/                # React Native / Expo Android App
    ├── App.js          # Entry point
    ├── src/
    │   ├── api/        # Jira, Slack, Calendar, Firebase clients
    │   ├── screens/    # Jira, Slack, Discord, Tasks, Reminders, Settings
    │   ├── components/ # Card components for each data type
    │   ├── context/    # App state and theme context
    │   ├── storage/    # AsyncStorage wrapper
    │   └── utils/      # Sync engine, scheduler, helpers
    └── app.json        # Expo config
│
└── discord-worker/     # Standalone Discord bot -> Firestore bridge
    ├── src/config.js   # Env parsing, doc-id resolution
    ├── src/scoring.js  # Discord scoring + mention summary logic
    ├── src/firestore.js# firebase-admin writes into worksync_cache
    └── src/index.js    # Discord client bootstrap, event handlers
```

## Setup

### Prerequisites

- A **Firebase project** with Firestore enabled
- **Jira** account with an API token
- **Slack** user token (xoxp-...) with `search:read` scope
- Optional: a **Discord bot** token if you want Discord mention tracking
- **Google Cloud** OAuth client ID (for Calendar integration)
- **Groq** API key (for AI message enrichment — optional)

### Chrome Extension

1. Clone this repo
2. Edit `extension/firebase.js` — replace `YOUR_FIREBASE_PROJECT_ID` and `YOUR_FIREBASE_API_KEY` with your Firebase credentials
3. Go to `chrome://extensions` → Enable Developer Mode → Load Unpacked → select the `extension/` folder
4. Click the WorkSync icon → go to Settings (gear icon) → enter your Jira, Slack, and Google credentials
5. Hit "Sync Now" to verify everything connects

See [`extension/INSTALL.md`](extension/INSTALL.md) for detailed Firebase and API setup instructions.

### Discord Worker

Discord support is intentionally separate from the extension. Discord bots need a long-lived Gateway connection, which is not a good fit for a Manifest V3 service worker.

1. `cd discord-worker && npm install`
2. Create a Discord bot and enable `MESSAGE CONTENT INTENT`
3. Create a Firebase service account JSON with Firestore access
4. Export these env vars:

```bash
export DISCORD_BOT_TOKEN='...'
export FIREBASE_SERVICE_ACCOUNT_PATH='./service-account.json'
export WORKSYNC_DOC_ID='worksync_discord_test'
```

5. `npm start`

For the full setup flow, see [`discord-worker/README.md`](discord-worker/README.md).

### Android App

1. `cd app && npm install`
2. Edit `app/src/api/firebase.js` — replace `YOUR_FIREBASE_PROJECT_ID` and `YOUR_FIREBASE_API_KEY`
3. Edit `app/src/screens/SettingsScreen.js` — replace `YOUR_GOOGLE_OAUTH_CLIENT_ID` and `YOUR_EXPO_USERNAME`
4. Edit `app/app.json` — replace the placeholder values for `scheme`, `extra.eas.projectId`, and `owner`
5. Copy `google-services.json.example` to `google-services.json` and fill in your Firebase values
6. `npx expo start` to run in development, or `eas build -p android --profile preview` for an APK

See [`app/INSTALL.md`](app/INSTALL.md) for detailed setup instructions.

## Discord Tracking Model

WorkSync does **not** read a human user's private Discord inbox. It only reads what a Discord **bot** is allowed to see:

- DMs sent directly to the bot
- guild messages in channels the bot has access to
- messages that explicitly mention the bot

The recommended mental model is:

- **1 bot = 1 tracked inbox / 1 mention target**
- **1 Firestore doc = 1 WorkSync profile**

In practice, that means:

- if one person wants a personal Discord inbox inside WorkSync, give them their own bot + Firestore doc
- if a team wants a shared triage bot, multiple clients can point to the same bot-backed Firestore doc
- a bot tracks mentions **to that bot**, not arbitrary mentions of a personal Discord user account

Discord-only mode is supported in both the extension and the app through the optional `WorkSync Doc ID` setting.

## Features

### Extension Popup
- Quick view of pending Jira reviews with priority indicators
- Important Slack messages sorted by AI-scored importance
- Discord tab with mention summary, top taggers, and Discord messages pulled from Firestore
- Upcoming scheduled tasks and reminders
- One-click sync and settings access

### Extension Options Page
- Full Jira configuration: base URL, project key, custom field filters, sort order, exclude rules
- Multi-project support (primary + secondary Jira project)
- Slack token and VIP user configuration
- Optional `WorkSync Doc ID` override for Discord-only mode
- Google Calendar connection via OAuth
- AI enrichment settings with rate limit display
- Work schedule configuration (per-day start/end times)
- Daily report bot settings
- Sync interval and notification preferences
- Firebase cross-device sync with secret passphrase

### Android App
- Native Material-style dark theme UI
- Jira review list with priority badges and assignee avatars
- Slack messages with importance scoring
- Discord tab with mention-centric summary and scheduling support
- Local task management with Google Calendar integration
- Reminder system with notifications
- Background sync via Expo Background Fetch
- Settings pulled automatically from Firestore (shared with extension)

## Security Notes

- API tokens are stored in Chrome's local storage (extension) and AsyncStorage (app)
- Firebase sync uses a user-defined "sync secret" to make Firestore document IDs unguessable
- The sync secret is never stored in Firestore — it must be configured on each device
- Consider enabling Firestore Security Rules in production (the default setup uses test-mode rules)
- Discord bots can only read channels/DMs they are explicitly allowed to access; they cannot read the private inbox of a normal Discord user account

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Extension | Chrome Manifest V3, vanilla JS (ES modules) |
| App | React Native, Expo SDK 51 |
| Discord Worker | Node.js, discord.js, firebase-admin |
| Sync | Firebase Firestore (REST API in clients, Admin SDK in worker) |
| AI | Groq LLM API (Llama 3) |
| APIs | Jira REST, Slack Web API, Discord Gateway/API, Google Calendar API |

## License

MIT
