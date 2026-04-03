# WorkSync

A personal productivity suite that aggregates **Jira issues**, **Slack messages**, and **Google Calendar tasks** into a single dashboard. Built as a Chrome extension with a companion Android app.

## What It Does

WorkSync keeps you on top of your work by pulling together:

- **Jira Reviews** — surfaces issues that need your review based on custom field filters (e.g. "Design Status = Need Review"), with configurable project, field, and sort options
- **Slack Messages** — scans your DMs and channels for important/unread messages, scores them by importance using AI (Groq LLM), and highlights what needs attention
- **Google Calendar Tasks** — creates calendar events from Jira issues and Slack messages so nothing falls through the cracks
- **Scheduled Tasks & Reminders** — local task/reminder system with due dates and notifications
- **Daily Reports** — optional Slack bot that posts a daily summary of your pending items to a channel
- **Cross-Device Sync** — Firebase Firestore keeps the extension and Android app in sync

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│  Chrome Extension    │────▶│   Firebase Firestore  │◀────│  Android App (Expo)  │
│  (source of truth)   │     │   (sync layer)        │     │  (companion viewer)  │
└─────────────────────┘     └───────────────────────┘     └─────────────────────┘
        │                                                          │
        ├── Jira REST API                                          ├── Jira REST API
        ├── Slack Web API                                          └── Reads Slack from Firestore
        ├── Google Calendar API
        └── Groq LLM API (AI enrichment)
```

The **Chrome extension** is the primary data source — it fetches from Jira, Slack, and Calendar, enriches messages with AI, and pushes everything to Firestore.

The **Android app** pulls config and cache from Firestore, can independently fetch Jira, and displays everything in a native mobile UI. Slack data flows from the extension through Firestore.

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
└── app/                # React Native / Expo Android App
    ├── App.js          # Entry point
    ├── src/
    │   ├── api/        # Jira, Slack, Calendar, Firebase clients
    │   ├── screens/    # Jira, Slack, Tasks, Reminders, Settings
    │   ├── components/ # Card components for each data type
    │   ├── context/    # App state and theme context
    │   ├── storage/    # AsyncStorage wrapper
    │   └── utils/      # Sync engine, scheduler, helpers
    └── app.json        # Expo config
```

## Setup

### Prerequisites

- A **Firebase project** with Firestore enabled
- **Jira** account with an API token
- **Slack** user token (xoxp-...) with `search:read` scope
- **Google Cloud** OAuth client ID (for Calendar integration)
- **Groq** API key (for AI message enrichment — optional)

### Chrome Extension

1. Clone this repo
2. Edit `extension/firebase.js` — replace `YOUR_FIREBASE_PROJECT_ID` and `YOUR_FIREBASE_API_KEY` with your Firebase credentials
3. Go to `chrome://extensions` → Enable Developer Mode → Load Unpacked → select the `extension/` folder
4. Click the WorkSync icon → go to Settings (gear icon) → enter your Jira, Slack, and Google credentials
5. Hit "Sync Now" to verify everything connects

See [`extension/INSTALL.md`](extension/INSTALL.md) for detailed Firebase and API setup instructions.

### Android App

1. `cd app && npm install`
2. Edit `app/src/api/firebase.js` — replace `YOUR_FIREBASE_PROJECT_ID` and `YOUR_FIREBASE_API_KEY`
3. Edit `app/src/screens/SettingsScreen.js` — replace `YOUR_GOOGLE_OAUTH_CLIENT_ID` and `YOUR_EXPO_USERNAME`
4. Edit `app/app.json` — replace the placeholder values for `scheme`, `extra.eas.projectId`, and `owner`
5. Copy `google-services.json.example` to `google-services.json` and fill in your Firebase values
6. `npx expo start` to run in development, or `eas build -p android --profile preview` for an APK

See [`app/INSTALL.md`](app/INSTALL.md) for detailed setup instructions.

## Features

### Extension Popup
- Quick view of pending Jira reviews with priority indicators
- Important Slack messages sorted by AI-scored importance
- Upcoming scheduled tasks and reminders
- One-click sync and settings access

### Extension Options Page
- Full Jira configuration: base URL, project key, custom field filters, sort order, exclude rules
- Multi-project support (primary + secondary Jira project)
- Slack token and VIP user configuration
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
- Local task management with Google Calendar integration
- Reminder system with notifications
- Background sync via Expo Background Fetch
- Settings pulled automatically from Firestore (shared with extension)

## Security Notes

- API tokens are stored in Chrome's local storage (extension) and AsyncStorage (app)
- Firebase sync uses a user-defined "sync secret" to make Firestore document IDs unguessable
- The sync secret is never stored in Firestore — it must be configured on each device
- Consider enabling Firestore Security Rules in production (the default setup uses test-mode rules)

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Extension | Chrome Manifest V3, vanilla JS (ES modules) |
| App | React Native, Expo SDK 51 |
| Sync | Firebase Firestore (REST API, no SDK) |
| AI | Groq LLM API (Llama 3) |
| APIs | Jira REST, Slack Web API, Google Calendar API |

## License

MIT
