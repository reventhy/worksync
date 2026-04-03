import { JiraAPI } from './api/jira.js';
import { SlackAPI } from './api/slack.js';
import { CalendarAPI, getGoogleAccessToken, silentlyRefreshGoogleToken } from './api/calendar.js';
import { enrichSlackMessages } from './api/gemini.js';
import { firestorePatch, firestoreGet, docIdFromEmail } from './firebase.js';

// ── Firestore sync helpers ────────────────────────────────────────────────────

const CONFIG_KEYS = [
  'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
  'jiraProjectKey', 'jiraProjectName', 'jiraCustomFieldId', 'jiraCustomFieldName',
  'jiraStatusName', 'jiraStatusNames',
  'jiraSortFieldId', 'jiraSortFieldName', 'jiraSortOrder',
  'jiraExcludeFieldIds', 'jiraExcludeValues',
  // External Review
  'extProjectKey', 'extProjectName', 'extCustomFieldId', 'extCustomFieldName',
  'extStatusNames', 'extSortFieldId', 'extSortFieldName', 'extSortOrder',
  'extExcludeFieldIds', 'extExcludeValues',
  'slackToken', 'slackMyUserId', 'slackVipUsers', 'slackImportanceThreshold',
  'geminiApiKey',
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
  'worksyncDocId',
];

const CACHE_KEYS = [
  'jiraIssues', 'slackMessages', 'scheduledTasks', 'reminders',
  'jiraCustomFieldValues', 'jiraCustomFieldId', 'jiraCustomFieldName',
  'jiraBaseUrl', 'lastSync',
  'extIssues', 'extDoneKeys',
  'aiRateLimit',
];

async function _firebaseDocId() {
  const { worksyncDocId, jiraEmail, syncSecret } = await new Promise(r =>
    chrome.storage.local.get(['worksyncDocId', 'jiraEmail', 'syncSecret'], r)
  );
  return worksyncDocId?.trim() || docIdFromEmail(jiraEmail, syncSecret);
}

async function pushCacheToFirestore() {
  try {
    const docId = await _firebaseDocId();
    if (!docId) return;
    const [data, local] = await Promise.all([
      new Promise(r => chrome.storage.local.get(CACHE_KEYS, r)),
      new Promise(r => chrome.storage.local.get('_cachePushedAt', r)),
    ]);

    // Best-effort: merge reminders/scheduledTasks from Firestore if it's newer
    // (e.g. app added reminders since last extension startup)
    // Wrapped in try/catch — a failed GET must never block the Slack/Jira push
    try {
      const remote = await firestoreGet('worksync_cache', docId);
      if (remote && Number(remote._cachePushedAt || 0) > Number(local._cachePushedAt || 0)) {
        if (remote.reminders)      data.reminders      = remote.reminders;
        if (remote.scheduledTasks) data.scheduledTasks = remote.scheduledTasks;
        await new Promise(r => chrome.storage.local.set({
          reminders:      data.reminders,
          scheduledTasks: data.scheduledTasks,
        }, r));
      }
    } catch (e) {
      console.warn('[WorkSync] Pre-push Firestore merge skipped:', e.message);
    }

    const ts = String(Date.now());
    data._cachePushedAt = ts;
    await firestorePatch('worksync_cache', docId, data);
    await chrome.storage.local.set({ _cachePushedAt: ts });
    console.log('[WorkSync] Cache pushed to Firestore');
  } catch (e) {
    console.warn('[WorkSync] Firestore cache push failed:', e.message);
  }
}

async function pushConfigToFirestore(config) {
  try {
    const docId = config.worksyncDocId?.trim() || docIdFromEmail(config.jiraEmail, config.syncSecret);
    if (!docId) return;
    const data = {};
    for (const k of CONFIG_KEYS) {
      if (config[k] !== undefined && config[k] !== null) data[k] = config[k];
    }
    const ts = String(Date.now());
    data._configPushedAt = ts;
    await firestorePatch('worksync_config', docId, data);
    await chrome.storage.local.set({ _configPushedAt: ts });
    console.log('[WorkSync] Config pushed to Firestore');
  } catch (e) {
    console.warn('[WorkSync] Firestore config push failed:', e.message);
  }
}

async function pullFromFirestore() {
  try {
    const docId = await _firebaseDocId();
    if (!docId) return; // not configured yet

    const [remoteConfig, remoteCache, local] = await Promise.all([
      firestoreGet('worksync_config', docId),
      firestoreGet('worksync_cache', docId),
      new Promise(r => chrome.storage.local.get(['_configPushedAt', '_cachePushedAt'], r)),
    ]);

    // ── Config: only apply if Firestore is strictly newer ─────────────────────
    if (remoteConfig && Object.keys(remoteConfig).length) {
      const localTs  = Number(local._configPushedAt || 0);
      const remoteTs = Number(remoteConfig._configPushedAt || 0);
      const shouldApply = remoteTs > 0 && (localTs === 0 || remoteTs > localTs);
      if (shouldApply) {
        const toSet = {};
        for (const [k, v] of Object.entries(remoteConfig)) {
          if (v === null || v === undefined || v === '') continue;
          toSet[k] = v;
        }
        if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
        console.log('[WorkSync] Config pulled from Firestore (remote ts:', remoteTs, '> local ts:', localTs, ')');
      } else {
        console.log('[WorkSync] Config pull skipped — local is same or newer');
      }
    }

    // ── Cache: only apply if Firestore is strictly newer ──────────────────────
    // NEVER pull slackMessages or jiraIssues from Firestore — the extension is
    // the source of truth for those. Only pull tasks, reminders, and metadata
    // that other devices (macOS app, Android) may have updated.
    const cacheSkipKeys = new Set(['slackMessages', 'jiraIssues', 'extIssues']);
    if (remoteCache && Object.keys(remoteCache).length) {
      const localTs  = Number(local._cachePushedAt || 0);
      const remoteTs = Number(remoteCache._cachePushedAt || 0);
      const shouldApply = remoteTs > 0 && (localTs === 0 || remoteTs > localTs);
      if (shouldApply) {
        const toSet = {};
        for (const [k, v] of Object.entries(remoteCache)) {
          if (v === null || v === undefined) continue;
          if (cacheSkipKeys.has(k)) continue; // extension owns these
          toSet[k] = v;
        }
        if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
        console.log('[WorkSync] Cache pulled from Firestore (remote ts:', remoteTs, '> local ts:', localTs, ') — skipped extension-owned keys');
      } else {
        console.log('[WorkSync] Cache pull skipped — local is same or newer');
      }
    }
  } catch (e) {
    console.warn('[WorkSync] Firestore pull failed:', e.message);
  }
}

const ALARM_NAME = 'worksync-sync';
const DAILY_REPORT_ALARM = 'worksync-daily-report';
const RESCHEDULE_ALARM = 'worksync-reschedule';
const CONFIG_POLL_ALARM = 'worksync-config-poll';
const TOKEN_REFRESH_ALARM = 'worksync-token-refresh';
const SLACK_DAILY_ALARM = 'worksync-slack-daily';
const SYNC_INTERVAL_MINUTES = 30;
const CONFIG_POLL_MINUTES = 5;
const TOKEN_REFRESH_MINUTES = 50; // refresh before 60-min expiry

// ── Startup ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  migrateFromSyncToLocal();
  pullFromFirestore();
  scheduleAlarm();
  scheduleConfigPollAlarm();
  scheduleTokenRefreshAlarm();
  scheduleSlackDailyAlarm();
  scheduleDailyReport();
  scheduleRescheduleAlarm();
  // Push any existing token immediately so the app can use it right away
  silentlyRefreshGoogleToken();
  console.log('[WorkSync] Installed. Alarms scheduled.');
});

chrome.runtime.onStartup.addListener(() => {
  migrateFromSyncToLocal();
  pullFromFirestore();
  scheduleAlarm();
  scheduleConfigPollAlarm();
  scheduleTokenRefreshAlarm();
  scheduleSlackDailyAlarm();
  scheduleDailyReport();
  scheduleRescheduleAlarm();
  // Push a fresh token on every browser startup
  silentlyRefreshGoogleToken();
});

// ── Migrate settings from storage.sync → storage.local (one-time) ─────────────

async function migrateFromSyncToLocal() {
  // If local already has settings, migration already done
  const local = await new Promise(r => chrome.storage.local.get('jiraBaseUrl', r));
  if (local.jiraBaseUrl) return;

  // Check if sync has settings to migrate
  const synced = await new Promise(r => chrome.storage.sync.get(null, r));
  if (!synced.jiraBaseUrl) return;

  // Copy all synced settings to local, then clear sync
  await new Promise(r => chrome.storage.local.set(synced, r));
  await new Promise(r => chrome.storage.sync.clear(r));
  console.log('[WorkSync] Migrated settings from storage.sync to storage.local.');
}

// ── Alarm ────────────────────────────────────────────────────────────────────

function scheduleAlarm() {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: 1,
        periodInMinutes: SYNC_INTERVAL_MINUTES,
      });
    }
  });
}

function scheduleTokenRefreshAlarm() {
  chrome.alarms.get(TOKEN_REFRESH_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(TOKEN_REFRESH_ALARM, {
        delayInMinutes: TOKEN_REFRESH_MINUTES,
        periodInMinutes: TOKEN_REFRESH_MINUTES,
      });
    }
  });
}

function scheduleConfigPollAlarm() {
  chrome.alarms.get(CONFIG_POLL_ALARM, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(CONFIG_POLL_ALARM, {
        delayInMinutes: CONFIG_POLL_MINUTES,
        periodInMinutes: CONFIG_POLL_MINUTES,
      });
    }
  });
}

function scheduleSlackDailyAlarm() {
  // Calculate minutes until next 10:30 AM
  const now = new Date();
  const target = new Date(now);
  target.setHours(10, 30, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1); // next day if past 10:30
  const delayMinutes = (target - now) / 60000;

  chrome.alarms.create(SLACK_DAILY_ALARM, {
    delayInMinutes: delayMinutes,
    periodInMinutes: 24 * 60, // repeat every 24 hours
  });
}

// Re-schedule daily report when settings change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.reportTime || changes.reportEnabled || changes.reportChannelId)) {
    scheduleDailyReport();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    syncAll({ includeSlack: false });
  }
  if (alarm.name === SLACK_DAILY_ALARM) {
    syncAll({ includeSlack: true });
  }
  if (alarm.name === TOKEN_REFRESH_ALARM) {
    silentlyRefreshGoogleToken();
  }
  if (alarm.name === CONFIG_POLL_ALARM) {
    pullFromFirestore();
  }
  if (alarm.name === DAILY_REPORT_ALARM) {
    sendDailyReport();
    scheduleDailyReport();
  }
  if (alarm.name === RESCHEDULE_ALARM) {
    rescheduleOverdue();
    scheduleRescheduleAlarm();
  }
});

// ── Message handler from popup ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'sync') {
    syncAll({ includeSlack: true }).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // async
  }
  if (msg.action === 'pullConfig') {
    pullFromFirestore().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'getCache') {
    chrome.storage.local.get(['jiraIssues', 'slackMessages', 'discordMessages', 'lastSync', 'jiraError', 'slackError'], sendResponse);
    return true;
  }
  if (msg.action === 'createCalendarEvent') {
    createCalendarEvent(msg.payload).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'findFreeSlot') {
    findFreeSlot(msg.payload).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'scheduleTaskItems') {
    scheduleTaskItems(msg.payload).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'fetchJiraFieldValues') {
    fetchAndCacheJiraFieldValues().then(sendResponse).catch(e => sendResponse({ ok: false, values: [] }));
    return true;
  }
  if (msg.action === 'updateJiraField') {
    updateJiraIssueField(msg.issueKey, msg.fieldId, msg.value)
      .then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'markTaskDone') {
    markTaskDone(msg.id).then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'rescheduleOverdue') {
    rescheduleOverdue().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'sendDailyReport') {
    sendDailyReport().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.action === 'scheduleDailyReport') {
    scheduleDailyReport();
    sendResponse({ ok: true });
  }
});

// ── Core sync ────────────────────────────────────────────────────────────────

async function syncAll({ includeSlack = false } = {}) {
  // Skip sync when offline — keep whatever is cached
  if (!navigator.onLine) {
    console.log('[WorkSync] Offline — skipping sync, showing cached data.');
    return;
  }

  const config = await getConfig();
  if (!isConfigured(config)) {
    console.warn('[WorkSync] Not configured — skipping sync.');
    return;
  }

  const tasks = [syncJira(config)];
  if (includeSlack && config.slackToken) {
    tasks.push(syncSlack(config));
  } else {
    tasks.push(Promise.resolve(null)); // placeholder to keep index alignment
  }
  tasks.push(syncExt(config));
  const results = await Promise.allSettled(tasks);

  const jiraResult  = results[0];
  const slackResult = results[1];
  const extResult   = results[2];

  if (jiraResult.status === 'rejected')  console.error('[WorkSync] Jira sync failed:', jiraResult.reason);
  if (slackResult.status === 'rejected') console.error('[WorkSync] Slack sync failed:', slackResult.reason);
  if (extResult.status === 'rejected')   console.warn('[WorkSync] External Review sync failed:', extResult.reason);

  // Only update storage for services that succeeded — preserve cache for failed ones
  const cached = await new Promise(r => chrome.storage.local.get(['jiraIssues', 'slackMessages', 'extIssues'], r));
  const jiraIssues  = jiraResult.status  === 'fulfilled' ? jiraResult.value  : (cached.jiraIssues  || []);
  // If Slack was skipped (null placeholder), preserve cached messages
  const slackMessages = (slackResult.status === 'fulfilled' && slackResult.value !== null) ? slackResult.value : (cached.slackMessages || []);
  const extIssues   = extResult.status   === 'fulfilled' ? extResult.value   : (cached.extIssues   || []);

  const totalCount = jiraIssues.length + slackMessages.filter(m => m.importance >= 7).length + extIssues.length;

  await chrome.storage.local.set({
    jiraIssues,
    slackMessages,
    extIssues,
    lastSync: new Date().toISOString(),
    jiraError: jiraResult.status === 'rejected' ? jiraResult.reason.message : null,
    slackError: slackResult.status === 'rejected' ? slackResult.reason.message : null,
  });

  // Push synced data to Firestore for cross-device sync (fire-and-forget)
  pushCacheToFirestore();

  // Update badge
  chrome.action.setBadgeText({ text: totalCount > 0 ? String(totalCount) : '' });
  chrome.action.setBadgeBackgroundColor({ color: totalCount > 0 ? '#E53E3E' : '#4A5568' });

  // Notify if new urgent items
  if (totalCount > 0) {
    notifyIfNeeded(jiraIssues, slackMessages);
  }
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
  const excludeFieldIds = config.jiraExcludeFieldIds
    ? (() => { try { return JSON.parse(config.jiraExcludeFieldIds); } catch { return []; } })()
    : [];
  const designStatusValues = config.jiraStatusNames
    ? (() => { try { return JSON.parse(config.jiraStatusNames); } catch { return ['Need Your Review']; } })()
    : (config.jiraStatusName ? [config.jiraStatusName] : ['Need Your Review']);

  let issues = await jira.getReviewIssues(designStatusValues, config.jiraProjectKey || null, fieldName, sortFieldId, excludeFieldIds, filterFieldId);

  // Cache all possible values for the filter field (used by popup dropdown)
  if (filterFieldId && config.jiraProjectKey) {
    try {
      const values = await jira.getFieldValues(filterFieldId, config.jiraProjectKey);
      await chrome.storage.local.set({ jiraCustomFieldValues: values });
    } catch (e) { console.warn('[WorkSync] Could not cache field values:', e); }
  }

  // Filter out excluded issues (per-field exclude values map)
  if (excludeFieldIds.length && config.jiraExcludeValues) {
    const excludeMap = (() => { try { return JSON.parse(config.jiraExcludeValues); } catch { return {}; } })();
    issues = issues.filter(issue =>
      !excludeFieldIds.some(fid => {
        const excluded = excludeMap[fid];
        return excluded?.length && excluded.includes(issue.excludeFieldValues?.[fid]);
      })
    );
  }

  // Apply custom sort order if configured
  if (sortFieldId && config.jiraSortOrder) {
    const sortOrder = (() => { try { return JSON.parse(config.jiraSortOrder); } catch { return []; } })();
    issues.sort((a, b) => {
      const ai = sortOrder.indexOf(a.sortFieldValue ?? '');
      const bi = sortOrder.indexOf(b.sortFieldValue ?? '');
      return (ai === -1 ? sortOrder.length : ai) - (bi === -1 ? sortOrder.length : bi);
    });
  }

  return issues;
}

// ── External Review sync — same Jira credentials, separate query config ────────────

async function syncExt(config) {
  // Skip if External Review not configured
  if (!config.extProjectKey && !config.extStatusNames) return [];

  const jira = new JiraAPI({
    baseUrl: config.jiraBaseUrl,
    email: config.jiraEmail,
    apiToken: config.jiraApiToken,
  });

  const fieldName    = config.extCustomFieldName || 'Design Status';
  const sortFieldId  = config.extSortFieldId || null;
  const filterFieldId = config.extCustomFieldId || null;
  const excludeFieldIds = config.extExcludeFieldIds
    ? (() => { try { return JSON.parse(config.extExcludeFieldIds); } catch { return []; } })()
    : [];
  const statusValues = config.extStatusNames
    ? (() => { try { return JSON.parse(config.extStatusNames); } catch { return []; } })()
    : [];

  if (!statusValues.length) return [];

  let issues = await jira.getReviewIssues(statusValues, config.extProjectKey || null, fieldName, sortFieldId, excludeFieldIds, filterFieldId);

  // Filter excluded issues
  if (excludeFieldIds.length && config.extExcludeValues) {
    const excludeMap = (() => { try { return JSON.parse(config.extExcludeValues); } catch { return {}; } })();
    issues = issues.filter(issue =>
      !excludeFieldIds.some(fid => {
        const excluded = excludeMap[fid];
        return excluded?.length && excluded.includes(issue.excludeFieldValues?.[fid]);
      })
    );
  }

  // Apply custom sort order
  if (sortFieldId && config.extSortOrder) {
    const sortOrder = (() => { try { return JSON.parse(config.extSortOrder); } catch { return []; } })();
    issues.sort((a, b) => {
      const ai = sortOrder.indexOf(a.sortFieldValue ?? '');
      const bi = sortOrder.indexOf(b.sortFieldValue ?? '');
      return (ai === -1 ? sortOrder.length : ai) - (bi === -1 ? sortOrder.length : bi);
    });
  }

  console.log(`[WorkSync] External Review synced: ${issues.length} issues`);
  return issues;
}

async function syncSlack(config) {
  if (!config.slackToken) throw new Error('Slack token not configured.');
  const slack = new SlackAPI({ token: config.slackToken });
  const workspace = await slack.getWorkspaceInfo();
  const vipUserIds = config.slackVipUsers
    ? config.slackVipUsers.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  // Use workspace userId from auth.test — guaranteed to match the token owner
  // Fall back to manually configured ID if set (e.g. when using a bot token)
  const myUserId = workspace?.userId || config.slackMyUserId?.trim();
  console.log('[WorkSync] Slack sync — token present:', !!config.slackToken, '| myUserId:', myUserId, '| workspace:', workspace?.team);
  const { messages, debug } = await slack.getUnreadMessages({ myUserId, vipUserIds });
  console.log('[WorkSync] Slack sync done —', messages.length, 'messages | debug:', JSON.stringify(debug));

  // Enrich with workspace URL for deep links
  if (workspace?.url) {
    for (const msg of messages) {
      msg.workspaceUrl = workspace.url;
      msg.url = `${workspace.url.replace(/\/$/, '')}/archives/${msg.channelId}/p${msg.ts.replace('.', '')}`;
    }
  }

  await chrome.storage.local.set({ slackDebug: debug });

  // Enrich with AI context & summary via Gemini (best-effort, non-blocking)
  if (config.geminiApiKey) {
    console.log('[WorkSync] AI enrichment starting for', messages.length, 'messages (Groq)');
    try {
      const enriched = await enrichSlackMessages(config.geminiApiKey, messages);
      const withContext = enriched.filter(m => m.context);
      console.log('[WorkSync] AI enrichment done:', withContext.length, '/', enriched.length, 'messages got context');
      return enriched;
    } catch (e) {
      console.warn('[WorkSync] AI enrichment failed:', e.message);
    }
  } else {
    console.log('[WorkSync] AI API key not set — skipping enrichment');
  }

  return messages;
}

// ── Calendar event creation ───────────────────────────────────────────────────

async function createCalendarEvent(payload) {
  try {
    const token = await getGoogleAccessToken(true);
    const calendar = new CalendarAPI({ accessToken: token });

    const event = await calendar.createTaskEvent({
      title: payload.title,
      description: payload.description,
      startTime: payload.startTime,
      endTime: payload.endTime,
      calendarId: payload.calendarId || 'primary',
      color: payload.color || '11',
      reminders: payload.reminders || [10],
    });

    return { ok: true, event };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Free slot finder ─────────────────────────────────────────────────────────

async function findFreeSlot(payload = {}) {
  try {
    const token = await getGoogleAccessToken(true);
    const calendar = new CalendarAPI({ accessToken: token });
    const config = await getConfig();
    const calendarId = payload.calendarId || config.defaultCalendarId || 'primary';

    const slotStart = await calendar.findFreeSlot({
      durationMinutes: payload.durationMinutes || 30,
      workStart: payload.workStart || 9,
      workEnd: payload.workEnd || 18,
      daysAhead: payload.daysAhead || 5,
      calendarId,
    });

    if (!slotStart) return { ok: false, error: 'No free slot found in the next 5 working days.' };
    return { ok: true, slotStart };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Task scheduler ───────────────────────────────────────────────────────────

const TASK_DURATION_MINUTES = 20;

/**
 * Create one 20-min calendar event per item, placed in sequential free slots
 * across Mon–Fri 9 AM–6 PM. Fetches freebusy once, then walks the list.
 */
async function scheduleTaskItems({ items = [] } = {}) {
  if (!items.length) return { ok: false, error: 'No items to schedule.' };

  const token = await getGoogleAccessToken(true);
  const calendar = new CalendarAPI({ accessToken: token });
  const config = await getConfig();
  const calendarId = config.defaultCalendarId || 'primary';

  // Build work schedule from config: { dayIndex: { enabled, start, end } }
  // JS day indices: 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  const DAY_KEYS = [
    ['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3],
    ['Thu', 4], ['Fri', 5], ['Sat', 6],
  ];
  const workSchedule = {};
  for (const [key, idx] of DAY_KEYS) {
    const enabled = config[`work${key}`] !== false && config[`work${key}`] !== 'false';
    const startStr = config[`work${key}Start`] || '09:00';
    const endStr = config[`work${key}End`] || '18:00';
    workSchedule[idx] = {
      enabled,
      start: parseInt(startStr.split(':')[0], 10),
      end: parseInt(endStr.split(':')[0], 10),
    };
  }

  // Fetch busy slots once for all items
  const busySlots = await calendar.getBusySlots({ daysAhead: 14, calendarId });

  const created = [];
  let searchFrom = new Date();

  for (const item of items) {
    const slot = calendar.findNextFreeSlot({
      busySlots,
      startAfter: searchFrom,
      durationMinutes: TASK_DURATION_MINUTES,
      daysAhead: 14,
      workSchedule,
    });

    if (!slot) {
      return { ok: false, error: `No free slot found for item ${created.length + 1} — calendar is fully booked for 14 days.` };
    }

    const endTime = new Date(slot.getTime() + TASK_DURATION_MINUTES * 60 * 1000);

    let title, description;
    if (item.type === 'reminder') {
      title = item.title;
      description = item.note || '';
    } else if (item.type === 'jira') {
      title = `[Jira] ${item.key}: ${item.summary}`;
      description = [
        item.project ? `Project: ${item.project}` : null,
        item.priority ? `Priority: ${item.priority}` : null,
        item.url ? `→ ${item.url}` : null,
      ].filter(Boolean).join('\n');
    } else if (item.type === 'discord') {
      const preview = (item.text || item.excerpt || '').replace(/\s+/g, ' ').slice(0, 200);
      const scopeLabel = item.isDM
        ? `DM with ${item.userName || item.user || 'user'}`
        : `${item.guildName || 'Server'} · #${item.channelName}`;
      title = item.isDM
        ? `[Discord] DM: ${(item.userName || item.user || 'message').slice(0, 40)}`
        : `[Discord] #${item.channelName}: ${(item.excerpt || item.text || '').replace(/\s+/g, ' ').slice(0, 60)}`;
      description = [
        `Scope: ${scopeLabel}`,
        `Importance: ${item.importanceLabel}`,
        preview ? `\n${preview}` : null,
        item.url ? `→ ${item.url}` : null,
      ].filter(Boolean).join('\n');
    } else {
      const preview = item.text.replace(/<[^>]+>/g, '').slice(0, 200);
      title = `[Slack] #${item.channelName}: ${item.text.replace(/<[^>]+>/g, '').slice(0, 60)}`;
      description = [
        `Channel: #${item.channelName}`,
        `Importance: ${item.importanceLabel}`,
        `\n${preview}`,
        item.url ? `→ ${item.url}` : null,
      ].filter(Boolean).join('\n');
    }

    const event = await calendar.createTaskEvent({
      title,
      description,
      startTime: slot.toISOString(),
      endTime: endTime.toISOString(),
      calendarId,
      color: '11',
      reminders: [10],
    });

    const task = {
      id: `ws_${Date.now()}_${created.length}`,
      title,
      description,
      startTime: slot.toISOString(),
      endTime: endTime.toISOString(),
      calendarEventId: event?.id || null,
      calendarId,
      done: false,
      createdAt: new Date().toISOString(),
      sourceType: item.type,
      sourceId: item.type === 'jira' ? item.key : (item.ts || item.id || item.messageId),
      filterFieldValue: item.type === 'jira' ? (item.filterFieldValue ?? null) : null,
    };
    created.push(task);

    // Mark this slot as busy so the next item doesn't overlap
    busySlots.push({ start: slot, end: endTime });
    busySlots.sort((a, b) => a.start - b.start);

    // Next item starts searching from the end of this slot
    searchFrom = endTime;
  }

  // Persist to storage (append to existing tasks)
  const { scheduledTasks = [] } = await new Promise(r => chrome.storage.local.get('scheduledTasks', r));
  await chrome.storage.local.set({ scheduledTasks: [...scheduledTasks, ...created] });
  pushCacheToFirestore();

  return { ok: true, created };
}

// ── Task done / reschedule ────────────────────────────────────────────────────

async function fetchAndCacheJiraFieldValues() {
  const config = await getConfig();
  const fieldId = config.jiraCustomFieldId;
  const projectKey = config.jiraProjectKey;
  if (!fieldId || !projectKey || !config.jiraBaseUrl) return { ok: false, values: [] };
  const jira = new JiraAPI({ baseUrl: config.jiraBaseUrl, email: config.jiraEmail, apiToken: config.jiraApiToken });
  const values = await jira.getFieldValues(fieldId, projectKey);
  await chrome.storage.local.set({ jiraCustomFieldValues: values });
  return { ok: true, values };
}

async function updateJiraIssueField(issueKey, fieldId, value) {
  const config = await getConfig();
  const jira = new JiraAPI({ baseUrl: config.jiraBaseUrl, email: config.jiraEmail, apiToken: config.jiraApiToken });
  await jira.updateIssueField(issueKey, fieldId, value);
  // Keep local jiraIssues cache consistent
  const { jiraIssues = [] } = await new Promise(r => chrome.storage.local.get('jiraIssues', r));
  await chrome.storage.local.set({
    jiraIssues: jiraIssues.map(i => i.key === issueKey ? { ...i, filterFieldValue: value } : i),
  });
  return { ok: true };
}

async function markTaskDone(taskId) {
  const { scheduledTasks = [] } = await new Promise(r => chrome.storage.local.get('scheduledTasks', r));
  const task = scheduledTasks.find(t => t.id === taskId);

  // Delete the calendar event
  if (task?.calendarEventId) {
    try {
      const token = await getGoogleAccessToken(true);
      const calendar = new CalendarAPI({ accessToken: token });
      await calendar.deleteEvent(task.calendarEventId, task.calendarId || 'primary');
    } catch (e) {
      console.warn('[WorkSync] Could not delete calendar event:', e.message);
    }
  }

  // Remove the task from storage entirely (no need to keep it as "done")
  const remaining = scheduledTasks.filter(t => t.id !== taskId);
  await chrome.storage.local.set({ scheduledTasks: remaining });
  pushCacheToFirestore();
  return { ok: true };
}

/**
 * Find all undone tasks whose startTime has passed (before now).
 * Delete their calendar events and reschedule them into new free slots.
 * Triggered automatically at 6 PM or manually from popup.
 */
async function rescheduleOverdue() {
  const { scheduledTasks = [] } = await new Promise(r => chrome.storage.local.get('scheduledTasks', r));
  const now = new Date();

  const overdue = scheduledTasks.filter(t => !t.done && new Date(t.startTime) < now);
  if (!overdue.length) return { ok: true, rescheduled: 0 };

  // Mark all overdue tasks immediately so they remain visible offline
  const markedTasks = scheduledTasks.map(t =>
    overdue.find(o => o.id === t.id) ? { ...t, overdue: true } : t
  );
  await chrome.storage.local.set({ scheduledTasks: markedTasks });

  // Try to reschedule via calendar (requires network)
  let calendar, busySlots, config, calendarId;
  try {
    const token = await getGoogleAccessToken(true);
    if (!token) throw new Error('No Google token');
    calendar = new CalendarAPI({ accessToken: token });
    config = await getConfig();
    calendarId = config.defaultCalendarId || 'primary';
    busySlots = await calendar.getBusySlots({ daysAhead: 14, calendarId });
  } catch (e) {
    // Offline or no token — tasks stay marked overdue, retry next time
    console.warn('[WorkSync] rescheduleOverdue offline/no-token, will retry later:', e.message);
    pushCacheToFirestore();
    return { ok: true, rescheduled: 0, offline: true };
  }

  // Best-effort: delete old calendar events
  await Promise.allSettled(
    overdue.map(t => t.calendarEventId ? calendar.deleteEvent(t.calendarEventId, t.calendarId || calendarId) : Promise.resolve())
  );

  let searchFrom = new Date();
  const rescheduled = [];

  for (const task of overdue) {
    const slot = calendar.findNextFreeSlot({
      busySlots,
      startAfter: searchFrom,
      durationMinutes: TASK_DURATION_MINUTES,
      workStart: 9,
      workEnd: 18,
      daysAhead: 14,
    });

    if (!slot) break;

    const endTime = new Date(slot.getTime() + TASK_DURATION_MINUTES * 60 * 1000);

    let event = null;
    try {
      event = await calendar.createTaskEvent({
        title: task.title,
        description: task.description,
        startTime: slot.toISOString(),
        endTime: endTime.toISOString(),
        calendarId,
        color: '11',
        reminders: [10],
      });
    } catch (e) {
      console.warn('[WorkSync] Could not create calendar event:', e.message);
    }

    rescheduled.push({
      ...task,
      id: `ws_${Date.now()}_r${rescheduled.length}`,
      startTime: slot.toISOString(),
      endTime: endTime.toISOString(),
      calendarEventId: event?.id || null,
      overdue: false, // cleared now that it's rescheduled
      done: false,
      createdAt: new Date().toISOString(),
    });

    busySlots.push({ start: slot, end: endTime });
    busySlots.sort((a, b) => a.start - b.start);
    searchFrom = endTime;
  }

  // Replace overdue tasks with rescheduled ones (keep non-overdue tasks untouched)
  const rescheduledIds = new Set(overdue.map(t => t.id));
  const { scheduledTasks: fresh = [] } = await new Promise(r => chrome.storage.local.get('scheduledTasks', r));
  const withoutOverdue = fresh.filter(t => !rescheduledIds.has(t.id));
  const finalTasks = [...withoutOverdue, ...rescheduled];
  await chrome.storage.local.set({ scheduledTasks: finalTasks });
  pushCacheToFirestore();

  if (rescheduled.length > 0) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'WorkSync — Tasks Rescheduled',
      message: `${rescheduled.length} overdue task${rescheduled.length !== 1 ? 's' : ''} moved to new slots.`,
      priority: 1,
    });
  }

  return { ok: true, rescheduled: rescheduled.length };
}

function scheduleRescheduleAlarm() {
  const now = new Date();
  const next6pm = new Date(now);
  next6pm.setHours(18, 0, 0, 0);
  if (next6pm <= now) next6pm.setDate(next6pm.getDate() + 1);
  // Skip to next weekday if it lands on weekend
  while (next6pm.getDay() === 0 || next6pm.getDay() === 6) {
    next6pm.setDate(next6pm.getDate() + 1);
  }
  const delayMinutes = (next6pm.getTime() - now.getTime()) / 60_000;
  chrome.alarms.clear(RESCHEDULE_ALARM, () => {
    chrome.alarms.create(RESCHEDULE_ALARM, { delayInMinutes: delayMinutes });
  });
}

// ── Notifications ────────────────────────────────────────────────────────────

async function notifyIfNeeded(jiraIssues, slackMessages) {
  const { lastNotified } = await chrome.storage.local.get('lastNotified');
  const now = Date.now();
  // Notify at most once per hour
  if (lastNotified && now - lastNotified < 60 * 60 * 1000) return;

  const criticalSlack = slackMessages.filter(m => m.importance >= 10);
  const urgentJira = jiraIssues.filter(i => i.priority === 'Highest' || i.priority === 'High');

  if (criticalSlack.length === 0 && urgentJira.length === 0) return;

  const lines = [];
  if (urgentJira.length) lines.push(`${urgentJira.length} Jira issue(s) need your review`);
  if (criticalSlack.length) lines.push(`${criticalSlack.length} critical Slack message(s)`);

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'WorkSync — Action Required',
    message: lines.join('\n'),
    priority: 2,
  });

  await chrome.storage.local.set({ lastNotified: now });
}

// ── Daily Slack Report ────────────────────────────────────────────────────────

/**
 * Schedule the daily report alarm at the user-configured time.
 * Calculates exact minutes until the next occurrence.
 */
async function scheduleDailyReport() {
  const config = await getConfig();
  if (!config.reportEnabled || !config.reportTime || !config.reportChannelId) return;

  const [hours, minutes] = config.reportTime.split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  // If time has already passed today, schedule for tomorrow
  if (next <= now) next.setDate(next.getDate() + 1);

  const delayMinutes = (next.getTime() - now.getTime()) / 60_000;

  // Clear existing alarm and create new one
  chrome.alarms.clear(DAILY_REPORT_ALARM, () => {
    chrome.alarms.create(DAILY_REPORT_ALARM, { delayInMinutes: delayMinutes });
  });
}

async function sendDailyReport() {
  const config = await getConfig();
  if (!config.reportEnabled || !config.reportChannelId || !config.slackToken) return;

  const { jiraIssues = [], slackMessages = [] } = await new Promise(r =>
    chrome.storage.local.get(['jiraIssues', 'slackMessages'], r)
  );

  const slack = new SlackAPI({ token: config.slackToken });

  await slack.postDailyReport({
    channel: config.reportChannelId,
    jiraIssues: config.reportIncludeJira !== false ? jiraIssues : [],
    slackMessages: config.reportIncludeSlack !== false ? slackMessages : [],
    botName: config.reportBotName || 'WorkSync Bot',
  });

  await chrome.storage.local.set({ lastDailyReport: new Date().toISOString() });
  console.log('[WorkSync] Daily report posted to', config.reportChannelId);
}

// ── Config helpers ────────────────────────────────────────────────────────────

function getConfig() {
  return new Promise(resolve => chrome.storage.local.get(null, resolve));
}

function isConfigured(config) {
  return !!(config.jiraBaseUrl && config.jiraEmail && config.jiraApiToken && config.slackToken);
}
