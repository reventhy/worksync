import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';

import { JiraAPI } from '../api/jira';
import { store, getConfig, isConfigured } from '../storage/store';
import { pushCache } from '../api/firebase';

export const SYNC_TASK_NAME = 'worksync-background-sync';

// ── Background task definition ────────────────────────────────────────────────

TaskManager.defineTask(SYNC_TASK_NAME, async () => {
  try {
    await syncAll();
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (e) {
    console.error('[WorkSync] Background sync failed:', e);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerSyncTask() {
  try {
    const config = await getConfig();
    const intervalMinutes = parseInt(config.syncInterval || '30', 10);
    await BackgroundFetch.registerTaskAsync(SYNC_TASK_NAME, {
      minimumInterval: intervalMinutes * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch (e) {
    console.warn('[WorkSync] Could not register background sync:', e.message);
  }
}

// ── Core sync ─────────────────────────────────────────────────────────────────
//
// Android only syncs Jira. Slack data comes from Firestore (pushed by the
// Chrome extension which adds workspace URLs, deep links, and Gemini enrichment).

export async function syncAll() {
  const config = await getConfig();
  if (!isConfigured(config)) {
    console.warn('[WorkSync] Not configured — skipping sync.');
    return { ok: false, error: 'Not configured' };
  }

  const jiraResult = await Promise.allSettled([syncJira(config)]);
  const result = jiraResult[0];

  const cachedJira = (await store.get('jiraIssues')) || [];
  const jiraIssues =
    result.status === 'fulfilled' ? result.value : cachedJira;

  // Slack data is read from cache (pulled from Firestore, written by extension)
  const slackMessages = (await store.get('slackMessages')) || [];

  const syncedAt = new Date().toISOString();
  await store.setAll({
    jiraIssues,
    lastSync: syncedAt,
    jiraError:
      result.status === 'rejected' ? result.reason.message : null,
  });

  // Push only Jira to Firestore — never push slackMessages (extension owns those)
  pushCache({ jiraIssues, lastSync: syncedAt });

  const totalCount =
    jiraIssues.length + slackMessages.filter(m => m.importance >= 7).length;

  if (totalCount > 0 && config.enableNotifications !== false) {
    await notifyIfNeeded(jiraIssues, slackMessages);
  }

  return {
    ok: true,
    jiraIssues,
    slackMessages,
    jiraError: result.status === 'rejected' ? result.reason.message : null,
  };
}

/**
 * Safe JSON parse that handles values already parsed by AsyncStorage auto-parse.
 * store.getAll() runs JSON.parse on every stored value, so a field stored as
 * '["a","b"]' comes back as ['a','b'] — calling JSON.parse on it again would
 * coerce it to a string like 'a,b' or '[object Object]' and then fail.
 */
function _safeParse(val, fallback) {
  if (val === null || val === undefined || val === '') return fallback;
  if (typeof val !== 'string') return val; // already parsed by AsyncStorage
  try { return JSON.parse(val); } catch { return fallback; }
}

async function syncJira(config) {
  const jira = new JiraAPI({
    baseUrl: config.jiraBaseUrl,
    email: config.jiraEmail,
    apiToken: config.jiraApiToken,
  });

  const fieldName = config.jiraCustomFieldName || 'Design Status';
  const sortFieldId = config.jiraSortFieldId || null;
  const filterFieldId = config.jiraCustomFieldId || null;
  const excludeFieldIds = _safeParse(config.jiraExcludeFieldIds, []);
  const designStatusValues = config.jiraStatusNames
    ? _safeParse(config.jiraStatusNames, ['Need Your Review'])
    : config.jiraStatusName
    ? [config.jiraStatusName]
    : ['Need Your Review'];

  let issues = await jira.getReviewIssues(
    designStatusValues,
    config.jiraProjectKey || null,
    fieldName,
    sortFieldId,
    excludeFieldIds,
    filterFieldId
  );

  if (filterFieldId && config.jiraProjectKey) {
    try {
      const values = await jira.getFieldValues(filterFieldId, config.jiraProjectKey);
      await store.set('jiraCustomFieldValues', values);
    } catch (e) {
      console.warn('[WorkSync] Could not cache field values:', e);
    }
  }

  if (excludeFieldIds.length && config.jiraExcludeValues) {
    const excludeMap = _safeParse(config.jiraExcludeValues, {});
    issues = issues.filter(
      issue =>
        !excludeFieldIds.some(fid => {
          const excluded = excludeMap[fid];
          return excluded?.length && excluded.includes(issue.excludeFieldValues?.[fid]);
        })
    );
  }

  if (sortFieldId && config.jiraSortOrder) {
    const sortOrder = _safeParse(config.jiraSortOrder, []);
    issues.sort((a, b) => {
      const ai = sortOrder.indexOf(a.sortFieldValue ?? '');
      const bi = sortOrder.indexOf(b.sortFieldValue ?? '');
      return (ai === -1 ? sortOrder.length : ai) - (bi === -1 ? sortOrder.length : bi);
    });
  }

  return issues;
}

// ── Notifications ─────────────────────────────────────────────────────────────

async function notifyIfNeeded(jiraIssues, slackMessages) {
  const lastNotified = await store.get('lastNotified');
  const now = Date.now();
  if (lastNotified && now - Number(lastNotified) < 60 * 60 * 1000) return;

  const criticalSlack = slackMessages.filter(m => m.importance >= 10);
  const urgentJira = jiraIssues.filter(
    i => i.priority === 'Highest' || i.priority === 'High'
  );

  if (criticalSlack.length === 0 && urgentJira.length === 0) return;

  const lines = [];
  if (urgentJira.length) lines.push(`${urgentJira.length} Jira issue(s) need your review`);
  if (criticalSlack.length) lines.push(`${criticalSlack.length} critical Slack message(s)`);

  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'WorkSync — Action Required',
      body: lines.join('\n'),
      sound: true,
    },
    trigger: null,
  });

  await store.set('lastNotified', String(now));
}
