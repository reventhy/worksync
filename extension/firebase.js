/**
 * Firestore REST helper — no SDK, works in MV3 service workers.
 * Uses API key + test-mode rules (no OAuth required).
 *
 * Two collections:
 *   worksync_config/{docId}  — settings/credentials
 *   worksync_cache/{docId}   — jiraIssues, slackMessages, scheduledTasks, reminders
 *
 * docId is derived from the user's jiraEmail so both devices share the same doc.
 */

const PROJECT_ID = 'YOUR_FIREBASE_PROJECT_ID';
const API_KEY    = 'YOUR_FIREBASE_API_KEY';
const BASE       = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

/**
 * Derive a Firestore document ID from email + optional sync secret.
 * The secret is never stored in Firestore — it must be set on each device manually.
 * Using a secret makes the docId unguessable even if the API key is extracted.
 */
export function docIdFromEmail(email, secret = '') {
  if (!email) return null;
  const base = email.toLowerCase();
  const combined = secret?.trim() ? `${base}__${secret.trim()}` : base;
  return combined.replace(/[^a-z0-9]/g, '_').slice(0, 100);
}

/**
 * PATCH (merge) a Firestore document with the given key/value pairs.
 * Only the supplied fields are written — other fields are untouched.
 * All values are stored as stringValues (JSON-stringified if not already a string).
 */
export async function firestorePatch(collection, docId, data) {
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

/** GET all fields from a Firestore document. Returns null if doc doesn't exist. */
export async function firestoreGet(collection, docId) {
  const url = `${BASE}/${collection}/${docId}?key=${API_KEY}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET ${res.status}`);
  const doc = await res.json();
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
