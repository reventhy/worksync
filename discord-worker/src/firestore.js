import admin from 'firebase-admin';

function parseStoredValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function createFirestoreStore(config) {
  const app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({
        credential: admin.credential.cert(config.serviceAccount),
        projectId: config.serviceAccount.project_id,
      });

  const db = app.firestore();
  const ref = db.collection(config.firestoreCollection).doc(config.docId);

  return {
    async loadMessages() {
      const snapshot = await ref.get();
      if (!snapshot.exists) return [];
      return parseStoredValue(snapshot.get('discordMessages'), []);
    },

    async writeMessages(messages, summary = {}, status = {}) {
      const now = Date.now();
      await ref.set(
        {
          discordMessages: JSON.stringify(messages),
          discordMentionsSummary: JSON.stringify(summary),
          discordWorkerLastSync: new Date(now).toISOString(),
          discordWorkerStatus: JSON.stringify(status),
          discordError: '',
          _cachePushedAt: String(now),
        },
        { merge: true }
      );
    },

    async writeError(errorMessage, status = {}) {
      const now = Date.now();
      await ref.set(
        {
          discordError: String(errorMessage || 'Unknown Discord worker error'),
          discordWorkerStatus: JSON.stringify(status),
          _cachePushedAt: String(now),
        },
        { merge: true }
      );
    },
  };
}
