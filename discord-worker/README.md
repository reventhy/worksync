# Discord Worker

Standalone Discord bot worker for WorkSync. It listens to:

- guild text channels the bot can access
- direct messages sent to the bot
- explicit mentions of the bot inside guild channels

It normalizes Discord messages, builds a mention-centric summary, and writes both into the existing Firestore cache document under `worksync_cache/{docId}`.

## Why this exists

Discord bot access is not equivalent to Slack user-token access:

- bots can read guild channels they are added to and have permission for
- bots can read DMs sent directly to the bot
- bots cannot read your personal user-account DM inbox with other people

Because of that, the safest architecture is:

1. run a Discord bot worker separately
2. write normalized messages into Firestore
3. let the existing extension/app read from Firestore

This keeps the existing Slack/Jira extension logic untouched while still giving WorkSync a Discord inbox.

## Mental model: one bot represents one tracked inbox

The cleanest way to think about this integration is:

- **1 Discord bot = 1 tracked inbox / 1 tag target**
- **1 Firestore document = 1 WorkSync profile**

That means:

- if a single user wants their own Discord tracking flow, create one bot and one Firestore doc for them
- if a team wants a shared triage bot, multiple clients can point to the same Firestore doc
- the bot tracks mentions sent to **the bot**, not mentions of a normal human Discord user account

So the answer to "mỗi 1 con bot sẽ tượng trưng cho 1 user để track lượt tag đúng ko?" is:

- **yes, if you choose that deployment model**
- more precisely: each bot represents one tracked WorkSync inbox, which can map to one user or one shared team workflow

## What it writes

The worker updates the existing Firestore cache document:

- collection: `worksync_cache`
- document id: `WORKSYNC_DOC_ID` or `docIdFromEmail(WORKSYNC_JIRA_EMAIL, WORKSYNC_SYNC_SECRET)`

Fields written by this worker:

- `discordMessages`: JSON-stringified array of normalized Discord messages
- `discordMentionsSummary`: JSON-stringified mention summary used by the extension/app Discord UI
- `discordWorkerLastSync`: ISO timestamp string
- `discordWorkerStatus`: JSON-stringified worker status object
- `discordError`: error string, empty when healthy
- `_cachePushedAt`: epoch-ms string so current WorkSync clients can detect freshness

Each `discordMessages` item looks like:

```json
{
  "source": "discord",
  "messageId": "1360000000000000000",
  "ts": "1775246400000",
  "text": "Need review on the latest onboarding flow by EOD",
  "excerpt": "Need review on the latest onboarding flow by EOD",
  "user": "123456789012345678",
  "userName": "Alice",
  "authorAvatarUrl": "https://cdn.discordapp.com/...",
  "guildId": "987654321098765432",
  "guildName": "Design",
  "channelId": "112233445566778899",
  "channelName": "triage",
  "isDM": false,
  "importance": 12,
  "importanceLabel": "Critical",
  "reasons": ["Mentioned bot", "Urgent wording", "Question"],
  "mentionsBot": true,
  "botMentionCount": 1,
  "mentionCount": 1,
  "attachmentCount": 0,
  "url": "https://discord.com/channels/987654321098765432/112233445566778899/1360000000000000000"
}
```

`discordMentionsSummary` looks like:

```json
{
  "mentionMessagesCount": 6,
  "totalBotMentionCount": 8,
  "directMessagesCount": 2,
  "lastMentionAt": "1775246400000",
  "topUsers": [
    {
      "userId": "123456789012345678",
      "userName": "Alice",
      "mentionMessages": 3,
      "botMentionCount": 4,
      "lastMentionAt": "1775246400000",
      "lastMessageText": "Need review on the latest onboarding flow by EOD",
      "lastMessageUrl": "https://discord.com/channels/987654321098765432/112233445566778899/1360000000000000000",
      "guildName": "Design",
      "channelName": "triage"
    }
  ],
  "topChannels": [
    {
      "guildId": "987654321098765432",
      "guildName": "Design",
      "channelId": "112233445566778899",
      "channelName": "triage",
      "mentionMessages": 4,
      "botMentionCount": 5,
      "lastMentionAt": "1775246400000"
    }
  ],
  "recentMentions": [
    {
      "messageId": "1360000000000000000",
      "ts": "1775246400000",
      "userId": "123456789012345678",
      "userName": "Alice",
      "guildName": "Design",
      "channelName": "triage",
      "botMentionCount": 1,
      "excerpt": "Need review on the latest onboarding flow by EOD",
      "url": "https://discord.com/channels/987654321098765432/112233445566778899/1360000000000000000"
    }
  ]
}
```

## Required setup

### 1. Create a Discord bot

In the Discord Developer Portal:

- create an application and add a bot user
- copy the bot token
- go to the **Bot** page
- under **Privileged Gateway Intents**, enable:
  - `MESSAGE CONTENT INTENT`

Invite the bot to the guilds/channels you want to monitor. The bot must have:

- `View Channel`
- `Read Message History`

Notes:

- `GuildMessages` and `DirectMessages` are requested in code via `discord.js`; they are not toggles in the Developer Portal UI
- the OAuth2 permission integer is only for generating an invite URL; it does not enable `MESSAGE CONTENT`

### 2. Create a Firebase service account

This worker uses `firebase-admin`, not the public REST API key used by the extension/app.

Create a service account with Firestore access and either:

- save it to `discord-worker/service-account.json`
- or provide it through `FIREBASE_SERVICE_ACCOUNT_JSON`

### 3. Configure environment variables

Copy `.env.example` and export the values in your shell or hosting platform.

Required:

- `DISCORD_BOT_TOKEN`
- `FIREBASE_SERVICE_ACCOUNT_PATH` or `FIREBASE_SERVICE_ACCOUNT_JSON`
- `WORKSYNC_DOC_ID` or `WORKSYNC_JIRA_EMAIL`

Optional filters:

- `DISCORD_ALLOWED_GUILD_IDS`
- `DISCORD_ALLOWED_CHANNEL_IDS`
- `DISCORD_ALLOWED_DM_USER_IDS`
- `DISCORD_VIP_USER_IDS`

Behavior knobs:

- `DISCORD_IMPORTANCE_THRESHOLD`
- `DISCORD_CACHE_LIMIT`
- `DISCORD_CHANNEL_BACKFILL_LIMIT`
- `DISCORD_DEBUG`

## Run locally

```bash
cd /Users/nhungpham/worksync/discord-worker
npm install
export DISCORD_BOT_TOKEN=...
export FIREBASE_SERVICE_ACCOUNT_PATH=./service-account.json
export WORKSYNC_DOC_ID=worksync_discord_test
export DISCORD_DEBUG=1
npm start
```

If you are integrating with an existing Jira-based WorkSync profile instead of a Discord-only test profile, use:

```bash
export WORKSYNC_JIRA_EMAIL=you@company.com
export WORKSYNC_SYNC_SECRET=...
```

The worker will derive the same Firestore document id currently used by the extension/app.

## Behavior notes

- Guild messages are captured in real time through the Gateway.
- DMs are captured when users send messages directly to the bot.
- Startup backfill currently runs only for explicitly listed `DISCORD_ALLOWED_CHANNEL_IDS`.
- The worker keeps only the newest `DISCORD_CACHE_LIMIT` scored messages.
- Message scoring is intentionally simple and mention-centric:
  - DMs add score
  - bot mentions add score
  - urgent wording, questions, attachments, replies, and VIP senders add score
- `discordMentionsSummary` is built from messages where `mentionsBot === true`.

## How the clients use this

Once the worker is running:

- the Chrome extension Discord tab reads `discordMessages` and `discordMentionsSummary` from Firestore
- the Android app Discord tab reads the same fields from Firestore
- both clients can schedule tasks from Discord messages without changing existing Slack logic

Discord-only mode is supported by setting `WorkSync Doc ID` in the extension/app settings to the same `WORKSYNC_DOC_ID` used by this worker.

## Troubleshooting

- `TokenInvalid`: you pasted the wrong Discord token or an old reset token
- `Firestore GET 403`: the extension/app Firebase Web API key or Firestore rules are blocking reads
- `Cloud Firestore API has not been used`: enable Firestore API and create the Firestore database in the target Firebase project
- `Flushed 0 message(s)`: the worker received an event but the message did not pass the current importance threshold
