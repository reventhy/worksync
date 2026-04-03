/**
 * Firestore REST helper for React Native — mirrors the Chrome extension's firebase.js.
 * Uses the same project/API key so both apps share the same Firestore documents.
 *
 * Two collections:
 *   worksync_config/{docId}  — settings/credentials
 *   worksync_cache/{docId}   — jiraIssues, slackMessages, scheduledTasks, reminders
 *
 * docId = jiraEmail with non-alphanumeric chars replaced by underscores.
 * Both apps derive the same docId from the same jiraEmail → automatic sync.
 */

import { store } from '../storage/store';

const PROJECT_ID = 'YOUR_FIREBASE_PROJECT_ID';
const API_KEY    = 'YOUR_FIREBASE_API_KEY';
const BASE       = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

/**
 * Derive a Firestore document ID from email + optional sync secret.
 * The secret is never stored in Firestore — must be set on each device manually.
 */
export function docIdFromEmail(email, secret = '') {
  if (!email) return null;
  const base = email.toLowerCase();
  const combined = secret?.trim() ? `${base}__${secret.trim()}` : base;
  return combined.replace(/[^a-z0-9]/g, '_').slice(0, 100);
}

// Config keys that get synced (excludes device-specific tokens)
export const CONFIG_SYNC_KEYS = [
  'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
  'jiraProjectKey', 'jiraProjectName', 'jiraCustomFieldId', 'jiraCustomFieldName',
  'jiraStatusName', 'jiraStatusNames',
  'jiraSortFieldId', 'jiraSortFieldName', 'jiraSortOrder',
  'jiraExcludeFieldIds', 'jiraExcludeValues',
  'extProjectKey', 'extProjectName', 'extCustomFieldId', 'extCustomFieldName',
  'extStatusNames', 'extSortFieldId', 'extSortFieldName', 'extSortOrder',
  'extExcludeFieldIds', 'extExcludeValues',
  'slackToken', 'slackMyUserId', 'slackVipUsers', 'slackImportanceThreshold', 'geminiApiKey',
  'googleClientId', 'defaultCalendarId',
  'workMon', 'workMonStart', 'workMonEnd',
  'workTue', 'workTueStart', 'workTueEnd',
  'workWed', 'workWedStart', 'workWedEnd',
  'workThu', 'workThuStart', 'workThuEnd',
  'workFri', 'workFriStart', 'workFriEnd',
  'workSat', 'workSatStart', 'workSatEnd',
  'workSun', 'workSunStart', 'workSunEnd',
  'syncInterval', 'enableNotifications',
  'reportEnabled', 'reportTime', 'reportChannelId', 'reportBotName',
  'reportIncludeJira', 'reportIncludeSlack',
  'googleAccessToken', 'googleTokenExpiry',
];

export const CACHE_SYNC_KEYS = [
  'jiraIssues', 'slackMessages', 'scheduledTasks', 'reminders',
  'jiraCustomFieldValues', 'jiraCustomFieldId', 'jiraCustomFieldName',
  'jiraBaseUrl', 'lastSync',
  'extIssues', 'extDoneKeys',
  'aiRateLimit',
];

async function getDocId() {
  const [email, secret] = await Promise.all([
    store.get('jiraEmail'),
    store.get('syncSecret'),
  ]);
  return docIdFromEmail(email, secret);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Push config fields to Firestore (fire-and-forget safe) */
export async function pushConfig(data) {
  try {
    const docId = await getDocId();
    if (!docId) return;
    // Only push known config keys with non-empty values — never push '' to Firestore
    // as it would wipe valid data on the other device
    const filtered = {};
    for (const k of CONFIG_SYNC_KEYS) {
      const v = data[k];
      if (v === undefined || v === null || v === '') continue;
      filtered[k] = v;
    }
    // Timestamp so conflict resolution can decide which side is newer
    const ts = String(Date.now());
    filtered._configPushedAt = ts;
    await _firestorePatch('worksync_config', docId, filtered);
    await store.set('_configPushedAt', ts); // remember our own push time locally
    console.log('[Firebase] Config pushed at', ts);
  } catch (e) {
    console.warn('[Firebase] pushConfig failed:', e.message);
  }
}

/** Push cache fields to Firestore (fire-and-forget safe) */
export async function pushCache(data) {
  try {
    const docId = await getDocId();
    if (!docId) return;
    const filtered = {};
    for (const k of CACHE_SYNC_KEYS) {
      if (data[k] !== undefined) filtered[k] = data[k];
    }
    const ts = String(Date.now());
    filtered._cachePushedAt = ts;
    await _firestorePatch('worksync_cache', docId, filtered);
    await store.set('_cachePushedAt', ts);
    console.log('[Firebase] Cache pushed at', ts);
  } catch (e) {
    console.warn('[Firebase] pushCache failed:', e.message);
  }
}

/**
 * Pull ONLY the Google token from Firestore — no timestamp check, always overwrites.
 * Called on every loadInitial so the app always has the freshest token the extension pushed.
 */
export async function pullGoogleToken() {
  try {
    const docId = await getDocId();
    if (!docId) return null;
    const remote = await _firestoreGet('worksync_config', docId);
    if (!remote) return null;
    const token  = remote.googleAccessToken;
    const expiry = remote.googleTokenExpiry;
    if (token && expiry) {
      await store.set('googleAccessToken', token);
      await store.set('googleTokenExpiry', String(expiry));
      console.log('[Firebase] Google token pulled directly from Firestore');
      return token;
    }
    return null;
  } catch (e) {
    console.warn('[Firebase] pullGoogleToken failed:', e.message);
    return null;
  }
}

/** Pull config from Firestore and merge into local store. Returns merged config or null. */
export async function pullConfig() {
  try {
    const docId = await getDocId();
    if (!docId) return null;
    const remote = await _firestoreGet('worksync_config', docId);
    if (!remote) return null;

    // ── Conflict resolution: only apply if Firestore is strictly newer ──────────
    const localTs  = Number(await store.get('_configPushedAt') || 0);
    const remoteTs = Number(remote._configPushedAt || 0);
    // Only apply remote when it has a real timestamp AND is newer than local.
    // If localTs === 0 (fresh install), still apply remote — but only if remote has a
    // real timestamp (avoids legacy/empty Firestore docs wiping freshly entered settings).
    const shouldApply = remoteTs > 0 && (localTs === 0 || remoteTs > localTs);
    if (!shouldApply) {
      console.log('[Firebase] Config pull skipped — local is same or newer');
      return null;
    }

    // Apply only non-empty values
    const toStore = {};
    for (const [k, v] of Object.entries(remote)) {
      if (v === null || v === undefined || v === '') continue;
      toStore[k] = v;
    }
    if (Object.keys(toStore).length) await store.setAll(toStore);
    console.log('[Firebase] Config pulled (remote ts:', remoteTs, '> local ts:', localTs, ')');
    return remote;
  } catch (e) {
    console.warn('[Firebase] pullConfig failed:', e.message);
    return null;
  }
}

/** Pull cache from Firestore and merge into local store. Returns merged cache or null. */
export async function pullCache() {
  try {
    const docId = await getDocId();
    if (!docId) return null;
    const remote = await _firestoreGet('worksync_cache', docId);
    if (!remote) return null;

    // ── Conflict resolution: only apply if Firestore is strictly newer ──────────
    const localTs  = Number(await store.get('_cachePushedAt') || 0);
    const remoteTs = Number(remote._cachePushedAt || 0);
    const shouldApply = remoteTs > 0 && (localTs === 0 || remoteTs > localTs);
    if (!shouldApply) {
      console.log('[Firebase] Cache pull skipped — local is same or newer');
      return null;
    }

    // Merge all non-null values from remote (including empty arrays — a clear is intentional)
    const toStore = {};
    for (const [k, v] of Object.entries(remote)) {
      if (v === null || v === undefined) continue;
      toStore[k] = v;
    }
    if (Object.keys(toStore).length) await store.setAll(toStore);
    console.log('[Firebase] Cache pulled (remote ts:', remoteTs, '> local ts:', localTs, ')');
    return remote;
  } catch (e) {
    console.warn('[Firebase] pullCache failed:', e.message);
    return null;
  }
}

// ── REST internals ────────────────────────────────────────────────────────────

async function _firestorePatch(collection, docId, data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    fields[k] = { stringValue: typeof v === 'string' ? v : JSON.stringify(v) };
  }
  if (!Object.keys(fields).length) return;

  const mask = Object.keys(fields)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');
  const url = `${BASE}/${collection}/${docId}?${mask}&key=${API_KEY}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore PATCH ${res.status}: ${err}`);
  }
}

async function _firestoreGet(collection, docId) {
  const url = `${BASE}/${collection}/${docId}?key=${API_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore GET ${res.status}: ${text.slice(0, 100)}`);
  }
  let doc;
  try {
    doc = await res.json();
  } catch (e) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore response not JSON: ${text.slice(0, 100)}`);
  }
  return _parseDoc(doc);
}

function _parseDoc(doc) {
  const result = {};
  for (const [k, v] of Object.entries(doc.fields || {})) {
    const raw =
      v.stringValue  !== undefined ? v.stringValue  :
      v.booleanValue !== undefined ? String(v.booleanValue) :
      v.integerValue !== undefined ? String(v.integerValue) :
      v.doubleValue  !== undefined ? String(v.doubleValue)  : null;
    if (raw === null) continue;
    try { result[k] = JSON.parse(raw); } catch { result[k] = raw; }
  }
  return result;
}
