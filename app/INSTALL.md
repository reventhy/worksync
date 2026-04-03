# WorkSync Android App — Installation Guide

## Prerequisites

- **Node.js 18+**
- **Java 17+** (bundled with Android Studio)
- **Android Studio** (for SDK, emulator, and building the APK)
- **Expo CLI**: `npm install -g expo-cli`
- A physical Android device or Android emulator

---

## 1. Firebase Setup (Required for App <-> Extension Sync)

The app shares a Firestore database with the Chrome extension to sync settings and data.

1. Go to [Firebase Console](https://console.firebase.google.com/) and create a new project.
2. Enable **Cloud Firestore** (start in **test mode** for initial setup).
3. Add an **Android app** to the project:
   - Package name: `com.worksync.app`
   - Download the generated `google-services.json`
   - Place it at `work-sync-app/google-services.json`
   (See `google-services.json.example` for the expected structure.)
4. Note your **Project ID** and **Web API Key** (found in Project Settings > General).
5. Open `src/api/firebase.js` and replace the placeholders:
   ```js
   const PROJECT_ID = 'your-firebase-project-id';
   const API_KEY    = 'your-firebase-web-api-key';
   ```
   > Use the **same values** in the Chrome extension's `firebase.js`.

---

## 2. Google Calendar Setup (Optional)

1. In [Google Cloud Console](https://console.cloud.google.com/), enable:
   - **Google Calendar API**
   - **Google Tasks API**
2. Go to **Credentials > Create Credentials > OAuth 2.0 Client ID**.
   - Application type: **Web application** (for Expo auth proxy)
   - Authorized redirect URI: `https://auth.expo.io/@YOUR_EXPO_USERNAME/work-sync-app`
3. Copy the **Client ID**.
4. Open `src/screens/SettingsScreen.js` and replace:
   ```js
   const NATIVE_CLIENT_ID    = 'your-client-id.apps.googleusercontent.com';
   const GOOGLE_REDIRECT_URI = 'https://auth.expo.io/@YOUR_EXPO_USERNAME/work-sync-app';
   ```
5. Update `app.json`:
   - `scheme` array: replace `com.googleusercontent.apps.YOUR_GOOGLE_OAUTH_CLIENT_ID` with your actual reversed client ID
   - `extra.eas.projectId`: your EAS project ID (run `npx eas init` to get one)
   - `owner`: your Expo username

---

## 3. Install Dependencies

```bash
cd work-sync-app
npm install
```

---

## 4. Run in Development

### Expo Go (quick testing)
```bash
npx expo start
```
Scan the QR code with **Expo Go** on your Android device.

### Android emulator
```bash
npx expo start --android
```

---

## 5. Build Release APK

```bash
# Make sure JAVA_HOME points to your JDK (Android Studio bundles one):
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"  # macOS
# export JAVA_HOME="$HOME/Android/android-studio/jbr"  # Linux

cd android
./gradlew assembleRelease
```

The APK will be at:
```
android/app/build/outputs/apk/release/app-release.apk
```

Transfer it to your Android device and install.

---

## 6. Configure In-App (Settings Tab)

After launching the app, go to the **Settings** tab:

| Field | Where to get it |
|---|---|
| **Jira Base URL** | `https://your-domain.atlassian.net` |
| **Jira Email** | Your Atlassian account email |
| **Jira API Token** | [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| **Slack Token** | User token (`xoxp-...`) — see Slack setup below |
| **My Slack User ID** | Slack > click your name > Profile > three-dot menu > Copy member ID |
| **Google Client ID** | From step 2 above |
| **Sync Secret** | Any passphrase — must match the extension's sync secret |

### Slack User Token

WorkSync requires a **user token** (`xoxp-`), not a bot token (`xoxb-`), because it uses `search.messages` to find mentions across all channels.

1. Go to [Slack API Apps](https://api.slack.com/apps) > Create New App > From Scratch.
2. Add these **User Token Scopes** under OAuth & Permissions:
   - `search:read` — search messages
   - `channels:read` — list public channels
   - `groups:read` — list private channels
   - `mpim:read` — list group DMs
   - `im:read` — list DMs
   - `im:history` — read DM messages
   - `users:read` — resolve user names
3. Install to workspace and copy the **User OAuth Token** (`xoxp-...`).

---

## 7. Import from Extension (Shortcut)

If you already configured the Chrome extension, the app can pull all settings from Firestore automatically:

1. Open the app's Settings tab.
2. Tap **Import from Chrome Extension**.
3. Enter the same Jira email used in the extension.
4. All settings sync over instantly.

---

## File Structure

```
work-sync-app/
  App.js                  # Root component
  app.json                # Expo config (schemes, plugins, permissions)
  google-services.json    # Firebase config (YOU create this — see step 1)
  src/
    api/
      firebase.js         # Firestore REST helper (PROJECT_ID + API_KEY here)
      jira.js             # Jira REST API client
      slack.js            # Slack API client (search.messages + DM scan)
      calendar.js         # Google Calendar/Tasks API client
    components/
      JiraCard.js         # Jira issue card
      SlackCard.js        # Slack message card
      ReminderCard.js     # Reminder card
      TaskItem.js         # Scheduled task item
    context/
      AppContext.js        # Global state + data loading
      ThemeContext.js       # Dark/light theme
    navigation/
      TabNavigator.js      # Bottom tab navigator
    screens/
      JiraScreen.js        # Jira issues list
      SlackScreen.js       # Slack messages (VIP + regular sections)
      RemindersScreen.js   # Reminders
      TasksScreen.js       # Scheduled tasks
      SettingsScreen.js    # All settings + Jira/Slack/Google config
    storage/
      store.js             # AsyncStorage wrapper
    utils/
      sync.js              # Background sync (Jira + Slack fetch + Firestore push)
      scheduler.js         # Task scheduling
      helpers.js           # Shared utilities
```
