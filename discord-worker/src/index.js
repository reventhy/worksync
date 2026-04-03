import process from 'node:process';
import {
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { getConfig } from './config.js';
import { createFirestoreStore } from './firestore.js';
import { buildDiscordMentionsSummary, normalizeDiscordMessage, scoreDiscordMessage } from './scoring.js';

const config = getConfig();
const store = createFirestoreStore(config);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const cache = new Map();
let flushTimer = null;
let flushing = false;
let flushQueued = false;

function log(...args) {
  console.log('[discord-worker]', ...args);
}

function debug(...args) {
  if (config.debug) {
    console.log('[discord-worker:debug]', ...args);
  }
}

function getBlockReason(message) {
  if (message.author?.bot) return 'author-is-bot';
  if (message.system) return 'system-message';

  if (!message.guildId) {
    if (!config.allowedDmUserIds.length) return null;
    return config.allowedDmUserIds.includes(message.author.id) ? null : 'dm-user-not-allowed';
  }

  if (config.allowedGuildIds.length && !config.allowedGuildIds.includes(message.guildId)) {
    return 'guild-not-allowed';
  }

  if (config.allowedChannelIds.length && !config.allowedChannelIds.includes(message.channelId)) {
    return 'channel-not-allowed';
  }

  return null;
}

function snapshotMessages() {
  return [...cache.values()]
    .sort((a, b) => Number(b.ts) - Number(a.ts))
    .slice(0, config.cacheLimit);
}

async function flush(reason) {
  if (flushing) {
    flushQueued = true;
    return;
  }

  flushing = true;
  clearTimeout(flushTimer);
  flushTimer = null;

  try {
    const messages = snapshotMessages();
    const summary = buildDiscordMentionsSummary(messages);
    await store.writeMessages(messages, summary, {
      readyAt: client.readyTimestamp ? new Date(client.readyTimestamp).toISOString() : null,
      reason,
      trackedMessages: messages.length,
      mentionMessages: summary.mentionMessagesCount,
      directMessages: summary.directMessagesCount,
      botUserId: client.user?.id || null,
      filters: {
        guildIds: config.allowedGuildIds,
        channelIds: config.allowedChannelIds,
        dmUserIds: config.allowedDmUserIds,
      },
    });
    log(`Flushed ${messages.length} message(s) to Firestore (${reason})`);
  } catch (error) {
    console.error('[discord-worker] Flush failed:', error);
    await store.writeError(error.message, {
      reason,
      trackedMessages: cache.size,
      botUserId: client.user?.id || null,
    });
  } finally {
    flushing = false;
    if (flushQueued) {
      flushQueued = false;
      scheduleFlush('queued');
    }
  }
}

function scheduleFlush(reason) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flush(reason).catch((error) => console.error('[discord-worker] Deferred flush failed:', error));
  }, 800);
}

function upsertNormalizedMessage(message) {
  const scoring = scoreDiscordMessage(message, {
    botUserId: client.user?.id || '',
    vipUserIds: config.vipUserIds,
  });

  if (scoring.score < config.importanceThreshold) {
    cache.delete(message.id);
    return false;
  }

  cache.set(message.id, normalizeDiscordMessage(message, scoring));
  return true;
}

async function processMessage(message, reason) {
  if (message.partial) {
    try {
      await message.fetch();
    } catch (error) {
      log(`Skipping partial message ${message.id}: ${error.message}`);
      return;
    }
  }

  const blockReason = getBlockReason(message);
  if (blockReason) {
    debug(
      `Ignored ${message.id} (${reason})`,
      JSON.stringify({
        blockReason,
        guildId: message.guildId || null,
        channelId: message.channelId,
        authorId: message.author?.id || null,
        authorBot: message.author?.bot || false,
      })
    );
    return;
  }

  debug(
    `Accepted ${message.id} (${reason})`,
    JSON.stringify({
      guildId: message.guildId || null,
      channelId: message.channelId,
      authorId: message.author?.id || null,
      textPreview: String(message.cleanContent || message.content || '').slice(0, 80),
    })
  );
  const kept = upsertNormalizedMessage(message);
  if (kept) {
    log(`Tracked ${message.id} from ${message.guildId ? `#${message.channelId}` : 'dm'} (${reason})`);
  } else {
    debug(`Dropped ${message.id} below importance threshold ${config.importanceThreshold}`);
  }
  scheduleFlush(reason);
}

async function removeMessage(messageId, reason) {
  if (!cache.delete(messageId)) return;
  log(`Removed ${messageId} from cache (${reason})`);
  scheduleFlush(reason);
}

async function backfillAllowedChannels() {
  if (!config.allowedChannelIds.length || config.channelBackfillLimit === 0) {
    log('Skipping backfill: no allowed channel IDs or backfill disabled');
    return;
  }

  for (const channelId of config.allowedChannelIds) {
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased?.()) continue;
      const messages = await channel.messages.fetch({ limit: config.channelBackfillLimit });
      for (const message of messages.values()) {
        if (getBlockReason(message)) continue;
        upsertNormalizedMessage(message);
      }
      log(`Backfilled ${messages.size} message(s) from channel ${channelId}`);
    } catch (error) {
      console.warn(`[discord-worker] Backfill failed for channel ${channelId}:`, error.message);
    }
  }

  await flush('startup-backfill');
}

async function hydrateFromFirestore() {
  const existing = await store.loadMessages();
  for (const message of existing) {
    if (message?.messageId) cache.set(message.messageId, message);
  }
  log(`Hydrated ${cache.size} existing message(s) from Firestore`);
}

client.once('clientReady', async () => {
  log(`Logged in as ${client.user.tag} (${client.user.id})`);
  debug(
    'Startup config',
    JSON.stringify({
      docId: config.docId,
      allowedGuildIds: config.allowedGuildIds,
      allowedChannelIds: config.allowedChannelIds,
      allowedDmUserIds: config.allowedDmUserIds,
      importanceThreshold: config.importanceThreshold,
    })
  );
  debug(
    'Visible guilds',
    JSON.stringify(
      client.guilds.cache.map((guild) => ({
        id: guild.id,
        name: guild.name,
      }))
    )
  );
  const messages = snapshotMessages();
  const summary = buildDiscordMentionsSummary(messages);
  await store.writeMessages(messages, summary, {
    readyAt: new Date().toISOString(),
    reason: 'ready',
    trackedMessages: messages.length,
    mentionMessages: summary.mentionMessagesCount,
    directMessages: summary.directMessagesCount,
    botUserId: client.user.id,
    filters: {
      guildIds: config.allowedGuildIds,
      channelIds: config.allowedChannelIds,
      dmUserIds: config.allowedDmUserIds,
    },
  });
  await backfillAllowedChannels();
});

client.on('messageCreate', (message) => {
  processMessage(message, 'messageCreate').catch((error) => {
    console.error('[discord-worker] messageCreate failed:', error);
  });
});

client.on('messageUpdate', (_oldMessage, newMessage) => {
  processMessage(newMessage, 'messageUpdate').catch((error) => {
    console.error('[discord-worker] messageUpdate failed:', error);
  });
});

client.on('messageDelete', (message) => {
  removeMessage(message.id, 'messageDelete').catch((error) => {
    console.error('[discord-worker] messageDelete failed:', error);
  });
});

client.on('error', async (error) => {
  console.error('[discord-worker] Client error:', error);
  await store.writeError(error.message, {
    readyAt: client.readyTimestamp ? new Date(client.readyTimestamp).toISOString() : null,
    trackedMessages: cache.size,
    botUserId: client.user?.id || null,
  });
});

async function shutdown(signal) {
  log(`Received ${signal}, flushing before exit`);
  try {
    await flush(`shutdown:${signal}`);
  } finally {
    client.destroy();
    process.exit(0);
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error('[discord-worker] Shutdown failed:', error);
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('[discord-worker] Shutdown failed:', error);
    process.exit(1);
  });
});

hydrateFromFirestore()
  .then(() => client.login(config.discordBotToken))
  .catch(async (error) => {
    console.error('[discord-worker] Startup failed:', error);
    try {
      await store.writeError(error.message, {
        readyAt: null,
        trackedMessages: cache.size,
        botUserId: null,
      });
    } catch (writeError) {
      console.error('[discord-worker] Could not persist startup error:', writeError);
    }
    process.exit(1);
  });
