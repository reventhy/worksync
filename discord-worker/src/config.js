import fs from 'node:fs';
import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function splitCsv(value) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function integer(name, fallback) {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid integer env var ${name}: ${raw}`);
  }
  return parsed;
}

function loadServiceAccount() {
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (inlineJson) {
    return JSON.parse(inlineJson);
  }

  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (!filePath) {
    throw new Error('Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON');
  }

  const resolvedPath = path.resolve(process.cwd(), filePath);
  const contents = fs.readFileSync(resolvedPath, 'utf8');
  return JSON.parse(contents);
}

function docIdFromEmail(email, secret = '') {
  if (!email) return null;
  const base = email.toLowerCase();
  const combined = secret?.trim() ? `${base}__${secret.trim()}` : base;
  return combined.replace(/[^a-z0-9]/g, '_').slice(0, 100);
}

export function getConfig() {
  const serviceAccount = loadServiceAccount();
  const docId =
    process.env.WORKSYNC_DOC_ID?.trim() ||
    docIdFromEmail(process.env.WORKSYNC_JIRA_EMAIL?.trim(), process.env.WORKSYNC_SYNC_SECRET?.trim() || '');

  if (!docId) {
    throw new Error('Set WORKSYNC_DOC_ID or WORKSYNC_JIRA_EMAIL (optionally WORKSYNC_SYNC_SECRET)');
  }

  return {
    discordBotToken: required('DISCORD_BOT_TOKEN'),
    serviceAccount,
    firestoreCollection: process.env.WORKSYNC_FIRESTORE_COLLECTION?.trim() || 'worksync_cache',
    docId,
    allowedGuildIds: splitCsv(process.env.DISCORD_ALLOWED_GUILD_IDS),
    allowedChannelIds: splitCsv(process.env.DISCORD_ALLOWED_CHANNEL_IDS),
    allowedDmUserIds: splitCsv(process.env.DISCORD_ALLOWED_DM_USER_IDS),
    vipUserIds: splitCsv(process.env.DISCORD_VIP_USER_IDS),
    importanceThreshold: integer('DISCORD_IMPORTANCE_THRESHOLD', 3),
    cacheLimit: integer('DISCORD_CACHE_LIMIT', 150),
    channelBackfillLimit: integer('DISCORD_CHANNEL_BACKFILL_LIMIT', 25),
    debug: process.env.DISCORD_DEBUG === '1',
  };
}

export { docIdFromEmail };
