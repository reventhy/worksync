# WorkSync Chrome Extension — Installation Guide

## Prerequisites

- Google Chrome (or Chromium-based browser)
- A Jira Cloud instance with API token
- A Slack workspace with a **user token** (xoxp-)
- (Optional) Google Cloud project for Calendar integration

---

## 1. Firebase Setup (Required for App <-> Extension Sync)

Both the Chrome extension and the mobile app share a Firestore database to sync settings, Jira issues, Slack messages, and reminders.

1. Go to [Firebase Console](https://console.firebase.google.com/) and create a new project (or use an existing one).
2. Enable **Cloud Firestore** in the project (use **test mode** rules for simplicity, or configure proper security rules).
3. Go to **Project Settings > General** and note:
   - **Project ID** (e.g. `my-worksync-project`)
   - **Web API Key** (e.g. `AIzaSy...`)

4. Open `firebase.js` and replace the placeholders:
   ```js
   const PROJECT_ID = 'my-worksync-project';       // your Firebase project ID
   const API_KEY    = 'AIzaSy...your-api-key...';   // your Web API key
   ```

> **Security note:** The API key + Firestore test-mode rules allow read/write to anyone who knows the document ID. WorkSync mitigates this with the **Sync Secret** feature — a passphrase set on both devices that makes the Firestore document ID unguessable. Always set a sync secret in production.

---

## 2. Jira Setup

1. Log in to your Atlassian account.
2. Go to [API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens) and create a new token.
3. In the extension's **Settings** page, enter:
   - **Jira Base URL**: `https://your-domain.atlassian.net`
   - **Email**: Your Atlassian account email
   - **API Token**: The token you just created

---

## 3. Slack Setup

WorkSync uses the `search.messages` API which requires a **user token** (not a bot token).

### Option A: Use an existing Slack app

If you already have a Slack app with the right scopes, grab your `xoxp-` user token from the app's OAuth page.

### Option B: Create a new Slack app

1. Go to [Slack API Apps](https://api.slack.com/apps) and click **Create New App > From Scratch**.
2. Name it (e.g. `WorkSync`) and select your workspace.
3. Go to **OAuth & Permissions** and add these **User Token Scopes**:
   - `search:read` — search messages across channels
   - `channels:read` — list public channels
   - `groups:read` — list private channels
   - `mpim:read` — list group DMs
   - `im:read` — list DMs
   - `im:history` — read DM messages
   - `users:read` — resolve user display names
4. Click **Install to Workspace** and authorize.
5. Copy the **User OAuth Token** (`xoxp-...`).
6. In the extension's **Settings**, paste it into the **Slack Token** field.

---

## 4. Google Calendar Setup (Optional)

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the **Google Calendar API** and **Google Tasks API**.
4. Go to **Credentials > Create Credentials > OAuth client ID**.
   - Application type: **Chrome Extension**
   - Item ID: Your extension's ID (visible in `chrome://extensions` after loading)
5. Copy the **Client ID** and paste it into the extension's **Settings > Google Client ID** field.
6. Click **Connect Google** in the extension popup to complete OAuth.

---

## 5. Load the Extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `work-sync-extension` folder.
4. The WorkSync icon appears in your toolbar.
5. Click the icon, then go to **Settings** (gear icon) to configure your credentials.

---

## 6. Sync Secret (Recommended)

To prevent anyone from guessing your Firestore document ID:

1. In the extension Settings, under **Sync Settings**, enter a **Sync Secret** passphrase.
2. Enter the **same passphrase** on the mobile app (Settings > Notifications & Sync > Sync Secret).
3. Both devices will derive the same Firestore document ID from your email + secret.

---

## File Structure

```
work-sync-extension/
  manifest.json       # Chrome MV3 manifest
  background.js       # Service worker — syncs Jira/Slack/Calendar on alarm
  popup.html/js/css   # Extension popup — shows issues, messages, tasks
  options.html/js/css  # Settings page — all credential & filter config
  firebase.js         # Firestore REST helper (shared config)
  theme.js            # Dark/light theme
  api/
    jira.js           # Jira REST API client
    slack.js          # Slack API client (search.messages + DM scan)
    calendar.js       # Google Calendar/Tasks API client
  utils/
    importance.js     # Slack message importance scoring
  icons/              # Extension icons (16/32/48/128px)
```
