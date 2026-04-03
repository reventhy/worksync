import { firestorePatch, firestoreGet, docIdFromEmail } from './firebase.js';

// State
const selected = { jira: new Set(), slack: new Set(), reminder: new Set() };
let jiraIssues = [];
let slackMessages = [];
let scheduledTasks = [];
let reminders = [];
let jiraCustomFieldValues = [];
let jiraCustomFieldId = null;
let jiraCustomFieldName = null;
let jiraBaseUrl = null;
// External Review state
let extIssues = [];
let extDoneKeys = new Set();

// ── Firestore real-time pull ──────────────────────────────────────────────────

const CONFIG_KEYS = [
  'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
  'jiraProjectKey', 'jiraProjectName', 'jiraCustomFieldId', 'jiraCustomFieldName',
  'jiraStatusName', 'jiraStatusNames',
  'jiraSortFieldId', 'jiraSortFieldName', 'jiraSortOrder',
  'jiraExcludeFieldIds', 'jiraExcludeValues',
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
  'googleAccessToken', 'googleTokenExpiry',
];

const CACHE_KEYS = [
  'jiraIssues', 'slackMessages', 'scheduledTasks', 'reminders',
  'jiraCustomFieldValues', 'jiraBaseUrl', 'lastSync',
];

async function _pullFirestoreOnOpen() {
  try {
    const local = await new Promise(r =>
      chrome.storage.local.get(['jiraEmail', 'syncSecret', '_configPushedAt', '_cachePushedAt'], r)
    );
    const docId = docIdFromEmail(local.jiraEmail, local.syncSecret);
    if (!docId) return;

    const [remoteConfig, remoteCache] = await Promise.all([
      firestoreGet('worksync_config', docId),
      firestoreGet('worksync_cache', docId),
    ]);

    // ── Config: only apply if Firestore is strictly newer ─────────────────────
    if (remoteConfig && Object.keys(remoteConfig).length) {
      const localTs  = Number(local._configPushedAt || 0);
      const remoteTs = Number(remoteConfig._configPushedAt || 0);
      // Only apply remote if it has a real timestamp AND is newer than local.
      // If localTs === 0 (never pushed from this device), treat remote as authoritative
      // only when remote also has a real timestamp (avoids empty/legacy docs wiping local data).
      const shouldApply = remoteTs > 0 && (localTs === 0 || remoteTs > localTs);
      if (shouldApply) {
        const toSet = {};
        for (const k of CONFIG_KEYS) {
          const v = remoteConfig[k];
          if (v === undefined || v === null || v === '') continue;
          toSet[k] = v;
        }
        if (remoteConfig._configPushedAt) toSet._configPushedAt = remoteConfig._configPushedAt;
        if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
      }
    }

    // ── Cache: only apply if Firestore is strictly newer ──────────────────────
    if (remoteCache && Object.keys(remoteCache).length) {
      const localTs  = Number(local._cachePushedAt || 0);
      const remoteTs = Number(remoteCache._cachePushedAt || 0);
      const shouldApply = remoteTs > 0 && (localTs === 0 || remoteTs > localTs);
      if (shouldApply) {
        const toSet = {};
        for (const [k, v] of Object.entries(remoteCache)) {
          if (!CACHE_KEYS.includes(k) && k !== '_cachePushedAt') continue;
          if (v === null || v === undefined) continue;
          toSet[k] = v;
        }
        if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
      }
    }
  } catch (e) {
    console.warn('[WorkSync] Popup Firestore pull failed:', e.message);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();

  // Settings buttons must work even before configuration
  document.getElementById('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.getElementById('btn-open-settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Pull latest config + cache from Firestore on every popup open for real-time sync
  await _pullFirestoreOnOpen();

  const config = await getConfig();
  if (!isConfigured(config)) {
    document.getElementById('not-configured').classList.remove('hidden');
    return;
  }

  await loadFromCache();
  setupActions();
  setupReminders();
  updateOnlineStatus();

  window.addEventListener('online', () => {
    updateOnlineStatus();
    handleSync();
    // Auto-reschedule any tasks that were marked overdue while offline
    chrome.storage.local.get('scheduledTasks', ({ scheduledTasks = [] }) => {
      const hasOverdue = scheduledTasks.some(t => !t.done && (t.overdue || new Date(t.startTime) < new Date()));
      if (hasOverdue) {
        chrome.runtime.sendMessage({ action: 'rescheduleOverdue' });
      }
    });
  });
  window.addEventListener('offline', updateOnlineStatus);

  // Auto-sync if cache is empty or older than 10 minutes (only when online)
  if (navigator.onLine) {
    const { lastSync } = await new Promise(r => chrome.storage.local.get('lastSync', r));
    const stale = !lastSync || (Date.now() - new Date(lastSync).getTime() > 10 * 60 * 1000);
    if (stale) handleSync();
  }
});

function isConfigured(config) {
  return !!(config.jiraBaseUrl && config.jiraEmail && config.jiraApiToken && config.slackToken);
}

async function getConfig() {
  return new Promise(r => chrome.storage.local.get(null, r));
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      tab.classList.add('active');
      document.getElementById(`tab-${name}`).classList.remove('hidden');
    });
  });
}

// ── Load cache ────────────────────────────────────────────────────────────────

async function loadFromCache() {
  // Read directly from storage — avoids service worker wake-up issues in MV3
  const data = await new Promise(r =>
    chrome.storage.local.get(['jiraIssues', 'slackMessages', 'lastSync', 'jiraError', 'slackError', 'slackDebug', 'scheduledTasks', 'reminders', 'jiraCustomFieldValues', 'jiraCustomFieldId', 'jiraCustomFieldName', 'jiraBaseUrl', 'extIssues', 'extDoneKeys'], r)
  );
  jiraIssues = data.jiraIssues || [];
  slackMessages = data.slackMessages || [];
  scheduledTasks = data.scheduledTasks || [];
  reminders = data.reminders || [];
  jiraCustomFieldId = data.jiraCustomFieldId || null;
  jiraCustomFieldName = data.jiraCustomFieldName || null;
  jiraBaseUrl = data.jiraBaseUrl || null;
  jiraCustomFieldValues = data.jiraCustomFieldValues || [];
  extIssues = data.extIssues || [];
  extDoneKeys = new Set(Array.isArray(data.extDoneKeys) ? data.extDoneKeys : []);

  // If field is configured but values haven't been cached yet, fetch them now
  if (jiraCustomFieldId && !jiraCustomFieldValues.length) {
    chrome.runtime.sendMessage({ action: 'fetchJiraFieldValues' }, (res) => {
      if (res?.values?.length) {
        jiraCustomFieldValues = res.values;
        renderScheduledTasks(scheduledTasks);
      }
    });
  }
  window._slackDebug = data.slackDebug || null;

  const scheduledJiraKeys = new Set(
    scheduledTasks.filter(t => !t.done && t.sourceType === 'jira').map(t => t.sourceId)
  );
  const scheduledSlackIds = new Set(
    scheduledTasks.filter(t => !t.done && t.sourceType === 'slack').map(t => t.sourceId)
  );

  renderJira(jiraIssues.filter(i => !scheduledJiraKeys.has(i.key)));
  renderSlack(slackMessages.filter(m => !scheduledSlackIds.has(m.ts)));
  renderScheduledTasks(scheduledTasks);
  renderReminders();
  renderExtReview();
  updateLastSync(data.lastSync);
  updateCounts();

  if (data.jiraError || data.slackError) {
    const errors = [data.jiraError, data.slackError].filter(Boolean).join(' | ');
    showError(errors);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

function setupActions() {
  document.getElementById('btn-sync').addEventListener('click', handleSync);
  document.getElementById('jira-select-all').addEventListener('click', () => toggleSelectAll('jira'));
  document.getElementById('slack-select-all').addEventListener('click', () => toggleSelectAll('slack'));
  document.getElementById('btn-create-event').addEventListener('click', handleScheduleTasks);
  document.getElementById('btn-reschedule-overdue').addEventListener('click', handleRescheduleOverdue);
  document.getElementById('ext-reschedule-overdue').addEventListener('click', handleRescheduleOverdue);
}

async function handleSync() {
  if (!navigator.onLine) return;
  const btn = document.getElementById('btn-sync');
  const spinner = document.getElementById('sync-spinner');
  btn.disabled = true;
  spinner.classList.remove('hidden');
  document.getElementById('last-sync-text').textContent = 'Syncing...';

  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'sync' }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (res?.ok) resolve();
        else reject(new Error(res?.error || 'Sync failed'));
      });
    });
  } catch (e) {
    showError(e.message);
  } finally {
    btn.disabled = false;
    spinner.classList.add('hidden');
    await loadFromCache();
  }
}

// ── Render Jira ───────────────────────────────────────────────────────────────

function renderJira(issues) {
  const list = document.getElementById('jira-list');
  if (!issues.length) {
    list.innerHTML = `<div class="empty-state"><p>No Jira issues found.</p><small>Issues with "Need Your Review" status will appear here.</small></div>`;
    return;
  }

  list.innerHTML = '';
  for (const issue of issues) {
    const card = document.createElement('div');
    card.className = 'jira-card';
    card.dataset.id = issue.key;

    const date = issue.updated ? relativeTime(issue.updated) : '';

    card.innerHTML = `
      <div class="card-check"></div>
      <div class="card-body">
        <div class="card-key">${escHtml(issue.key)}</div>
        <div class="card-title" title="${escHtml(issue.summary)}">
          ${issue.sortFieldValue ? `<span class="card-sort-value">${escHtml(issue.sortFieldValue)}</span><span class="card-sort-sep">|</span>` : ''}${escHtml(issue.summary)}
        </div>
        <div class="card-meta">
          ${issue.project ? `<span class="meta-chip chip-project">${escHtml(issue.project)}</span>` : ''}
          ${date ? `<span class="meta-chip chip-date">${date}</span>` : ''}
        </div>
        <a class="card-link" href="${escHtml(issue.url)}" target="_blank" rel="noopener">↗ Open in Jira</a>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      toggleSelect(card, 'jira', issue.key);
    });

    list.appendChild(card);
  }
}

// ── Render Slack ──────────────────────────────────────────────────────────────

function renderSlack(messages) {
  const list = document.getElementById('slack-list');
  const important = messages.filter(m => m.importance >= 3);

  if (!important.length) {
    const d = window._slackDebug;
    const rawCount = slackMessages.length;
    let debugLines;
    if (!d) {
      debugLines = `<b>Sync has not run yet.</b> Click ↻ to sync.<br>Raw messages in storage: ${rawCount}`;
    } else {
      const lines = [
        `Raw messages in storage: <b>${rawCount}</b>`,
        `User ID: <b>${d.myUserId || '⚠️ NOT SET — go to Options → Slack → My Slack User ID'}</b>`,
        `Method: <b>${d.method || 'none'}</b> · DM channels: ${d.channelsFound} found · ${d.channelsScanned} scanned`,
        `Messages: ${d.messagesChecked} checked · ${d.zeroScore ?? 0} scored 0`,
      ];
      if (d.scopeErrors && d.scopeErrors.length) {
        lines.push(`<span style="color:#e55">Errors (${d.scopeErrors.length}): ${d.scopeErrors.slice(0, 3).join(' | ')}</span>`);
      }
      debugLines = lines.join('<br>');
    }
    list.innerHTML = `<div class="empty-state"><p>No Slack messages.</p><small style="text-align:left;display:block;line-height:1.7">${debugLines}</small></div>`;
    return;
  }

  // Debug: count how many messages have Gemini enrichment
  const enrichedCount = important.filter(m => m.context || m.summary).length;
  console.log(`[WorkSync] Rendering ${important.length} messages, ${enrichedCount} with Gemini context`);

  const isVip = m => m.reasons?.includes('VIP sender') && m.reasons?.includes('Mentioned you');
  const vipMsgs     = important.filter(m => isVip(m));
  const regularMsgs = important.filter(m => !isVip(m));

  list.innerHTML = '';

  function appendSection(msgs, sectionTitle, isVipSection) {
    if (!msgs.length) return;
    const header = document.createElement('div');
    header.className = `slack-section-header${isVipSection ? ' slack-section-vip' : ''}`;
    header.innerHTML = `<span>${escHtml(sectionTitle)}</span><span class="slack-section-count">${msgs.length}</span>`;
    list.appendChild(header);

    for (const msg of msgs) {
      const card = document.createElement('div');
      const importanceClass = `importance-${msg.importanceLabel.toLowerCase()}`;
      card.className = `slack-card ${importanceClass}${isVipSection ? ' slack-card-vip' : ''}`;
      card.dataset.id = msg.ts;

      const preview = cleanSlackText(msg.text).slice(0, 140);
      const time = relativeTime(new Date(parseFloat(msg.ts) * 1000).toISOString());

      card.innerHTML = `
        <div class="card-check"></div>
        <div class="card-body">
          <div class="card-meta">
            <span class="meta-chip chip-channel">#${escHtml(msg.channelName)}</span>
            <span class="meta-chip chip-importance-${msg.importanceLabel.toLowerCase()}">${escHtml(msg.importanceLabel)}</span>
            <span class="meta-chip chip-date">${time}</span>
          </div>
          ${msg.context ? `<div class="card-context"><span class="context-label">Context:</span> ${escHtml(msg.context)}</div>` : ''}
          ${msg.summary ? `<div class="card-summary"><span class="summary-label">Action:</span> ${escHtml(msg.summary)}</div>` : ''}
          ${preview ? `<div class="card-text">${escHtml(preview)}</div>` : ''}
          <div class="card-reasons">${msg.reasons.slice(0, 2).map(r => `· ${escHtml(r)}`).join(' ')}</div>
          ${msg.url ? `<a class="card-link" href="${escHtml(msg.url)}" target="_blank" rel="noopener">↗ Open in Slack</a>` : ''}
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        toggleSelect(card, 'slack', msg.ts);
      });

      list.appendChild(card);
    }
  }

  appendSection(vipMsgs,     '⭐ VIP — Mentioned You', true);
  appendSection(regularMsgs, '💬 Important Messages',  false);
}

// ── Selection ─────────────────────────────────────────────────────────────────

function toggleSelect(card, type, id) {
  if (selected[type].has(id)) {
    selected[type].delete(id);
    card.classList.remove('selected');
  } else {
    selected[type].add(id);
    card.classList.add('selected');
  }
  updateSelectedPreview();
}

function toggleSelectAll(type) {
  const cards = document.querySelectorAll(`#tab-${type} .${type}-card`);
  const items = type === 'jira' ? jiraIssues : slackMessages;
  const allSelected = items.every(item => selected[type].has(type === 'jira' ? item.key : item.ts));

  cards.forEach(card => {
    const id = card.dataset.id;
    if (allSelected) {
      selected[type].delete(id);
      card.classList.remove('selected');
    } else {
      selected[type].add(id);
      card.classList.add('selected');
    }
  });
  updateSelectedPreview();
}

function updateSelectedPreview() {
  const preview = document.getElementById('selected-preview');
  const btn = document.getElementById('btn-create-event');
  const items = getSelectedItems();

  if (!items.length) {
    preview.innerHTML = '<p class="preview-empty">No items selected. Go to Jira or Slack tabs to select items.</p>';
    if (btn) btn.disabled = true;
    return;
  }

  if (btn) btn.disabled = false;

  // Compute proposed slots: next weekday 9 AM, each item gets the next free 20-min block
  // (approximate — actual slots resolved against real freebusy in background)
  const slots = [];
  let d = nextWeekday(new Date());
  for (let i = 0; i < items.length; i++) {
    slots.push(new Date(d));
    d = advanceWeekday(d);
  }

  preview.innerHTML = items.map((item, i) => {
    const slot = slots[i];
    const dateLabel = slot.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const timeLabel = slot.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const tag = item.type === 'jira'
      ? `<strong>[${escHtml(item.key)}]</strong> ${escHtml(item.summary)}`
      : item.type === 'reminder'
      ? `<strong>[Reminder]</strong> ${escHtml(item.title)}`
      : `<strong>[#${escHtml(item.channelName)}]</strong> ${escHtml(item.text.replace(/<[^>]+>/g, '').slice(0, 55))}…`;
    return `<div class="preview-item"><span class="preview-date">${dateLabel} ~${timeLabel}</span>${tag}</div>`;
  }).join('');
}

// Mirror of the weekday helpers in tasks.js (popup can't import background modules)
function nextWeekday(date) {
  const d = new Date(date);
  const now = new Date();
  if (d.toDateString() === now.toDateString() && now.getHours() >= 18) {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }
  return d;
}

function advanceWeekday(date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function getSelectedItems() {
  const items = [];
  for (const key of selected.jira) {
    const issue = jiraIssues.find(i => i.key === key);
    if (issue) items.push({ ...issue, type: 'jira' });
  }
  for (const ts of selected.slack) {
    const msg = slackMessages.find(m => m.ts === ts);
    if (msg) items.push({ ...msg, type: 'slack' });
  }
  for (const id of selected.reminder) {
    const r = reminders.find(r => r.id === id);
    if (r) items.push({ ...r, type: 'reminder' });
  }
  return items;
}

// ── Reminders ─────────────────────────────────────────────────────────────────

function setupReminders() {
  document.getElementById('btn-add-reminder').addEventListener('click', () => openReminderEditor());
}

function renderReminders() {
  const list = document.getElementById('reminder-list');
  if (!reminders.length) {
    list.innerHTML = `<div class="empty-state"><p>No reminders yet.</p><small>Click "+ Add" to create a reminder you can schedule as a task.</small></div>`;
    return;
  }

  list.innerHTML = '';
  for (const r of reminders) {
    const card = document.createElement('div');
    card.className = 'reminder-card';
    card.dataset.id = r.id;
    card.innerHTML = `
      <div class="card-check"></div>
      <div class="card-body">
        <div class="card-title" title="${escHtml(r.title)}">${escHtml(r.title)}</div>
        ${r.note ? `<div class="reminder-note">${escHtml(r.note)}</div>` : ''}
      </div>
      <div class="reminder-actions">
        <button class="reminder-edit-btn" data-id="${escHtml(r.id)}" title="Edit">✎</button>
        <button class="reminder-delete-btn" data-id="${escHtml(r.id)}" title="Delete">✕</button>
      </div>
    `;

    card.querySelector('.card-check').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelect(card, 'reminder', r.id);
    });
    card.querySelector('.reminder-edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openReminderEditor(r);
    });
    card.querySelector('.reminder-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      reminders = reminders.filter(x => x.id !== r.id);
      selected.reminder.delete(r.id);
      await saveReminders();
      renderReminders();
      updateSelectedPreview();
      updateCounts();
    });

    list.appendChild(card);
  }
}

function openReminderEditor(existing = null) {
  // Remove any existing editor
  document.getElementById('reminder-editor')?.remove();

  const editor = document.createElement('div');
  editor.id = 'reminder-editor';
  editor.className = 'reminder-editor';
  editor.innerHTML = `
    <input class="reminder-input" id="reminder-title-input" type="text"
      placeholder="Reminder title…" maxlength="200" value="${existing ? escHtml(existing.title) : ''}" />
    <textarea class="reminder-textarea" id="reminder-note-input"
      placeholder="Notes (optional)…" maxlength="1000">${existing ? escHtml(existing.note || '') : ''}</textarea>
    <div class="reminder-editor-actions">
      <button class="primary-btn reminder-save-btn">${existing ? 'Save' : 'Add'}</button>
      <button class="text-btn reminder-cancel-btn">Cancel</button>
    </div>
  `;

  document.getElementById('reminder-list').before(editor);
  editor.querySelector('#reminder-title-input').focus();

  editor.querySelector('.reminder-cancel-btn').addEventListener('click', () => editor.remove());
  editor.querySelector('.reminder-save-btn').addEventListener('click', async () => {
    const title = editor.querySelector('#reminder-title-input').value.trim();
    if (!title) return;
    const note = editor.querySelector('#reminder-note-input').value.trim();
    if (existing) {
      existing.title = title;
      existing.note = note;
    } else {
      reminders.push({ id: `rem_${Date.now()}`, title, note, createdAt: new Date().toISOString() });
    }
    await saveReminders();
    editor.remove();
    renderReminders();
    updateCounts();
  });
}

async function saveReminders() {
  const ts = String(Date.now());
  await new Promise(r => chrome.storage.local.set({ reminders, _cachePushedAt: ts }, r));
  // Push reminders to Firestore for cross-device sync with updated timestamp
  const config = await getConfig();
  const docId = docIdFromEmail(config.jiraEmail, config.syncSecret);
  if (docId) {
    firestorePatch('worksync_cache', docId, { reminders, _cachePushedAt: ts }).catch(e =>
      console.warn('[WorkSync] Firestore reminders push failed:', e.message)
    );
  }
}

// ── Scheduled task list ───────────────────────────────────────────────────────

function renderScheduledTasks(tasks) {
  const list = document.getElementById('task-list');
  const rescheduleBtn = document.getElementById('btn-reschedule-overdue');
  const now = new Date();

  // Keep only undone + done from today
  const todayStr = now.toDateString();
  const visible = tasks.filter(t =>
    !t.done || new Date(t.startTime).toDateString() === todayStr
  );

  const overdue = tasks.filter(t => !t.done && new Date(t.startTime) < now);
  rescheduleBtn.classList.toggle('hidden', overdue.length === 0);

  if (!visible.length) {
    list.innerHTML = '<p class="preview-empty">No tasks scheduled yet.</p>';
    return;
  }

  // Group by date
  const groups = {};
  for (const task of visible) {
    const d = new Date(task.startTime);
    const key = d.toDateString();
    if (!groups[key]) groups[key] = [];
    groups[key].push(task);
  }

  const todayLabel = now.toDateString();
  const tomorrowLabel = new Date(now.getTime() + 86400000).toDateString();

  list.innerHTML = Object.entries(groups).map(([dateKey, dayTasks]) => {
    const label = dateKey === todayLabel ? 'Today'
      : dateKey === tomorrowLabel ? 'Tomorrow'
      : new Date(dateKey).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

    const items = dayTasks.map(task => {
      const start = new Date(task.startTime);
      const end = new Date(task.endTime);
      const timeStr = `${start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
      const isOverdue = !task.done && start < now;
      const cls = task.done ? 'done' : isOverdue ? 'overdue' : '';
      // Infer Jira source for tasks created before sourceType was stored
      const isJiraTask = task.sourceType === 'jira' || (!task.sourceType && task.title?.startsWith('[Jira]'));
      const jiraKey = task.sourceId || (isJiraTask ? task.title?.match(/\[Jira\] ([^:]+):/)?.[1] : null);
      const jiraLinkHtml = isJiraTask && jiraBaseUrl && jiraKey
        ? `<a class="task-jira-link" href="${escHtml(jiraBaseUrl)}/browse/${escHtml(jiraKey)}" target="_blank" rel="noopener">↗ Open in Jira</a>`
        : '';
      const showDropdown = isJiraTask && jiraKey && jiraCustomFieldId && jiraCustomFieldValues.length;
      // Current value: prefer live jiraIssues cache, fall back to value stored on task
      const currentFieldValue = jiraIssues.find(i => i.key === jiraKey)?.filterFieldValue
        ?? task.filterFieldValue
        ?? null;
      const dropdownHtml = showDropdown ? `
        <div class="task-field-wrap">
          <select class="task-field-select" data-task-id="${escHtml(task.id)}" data-issue-key="${escHtml(jiraKey)}">
            <option value="">— ${escHtml(jiraCustomFieldName || 'Field')} —</option>
            ${jiraCustomFieldValues.map(v =>
              `<option value="${escHtml(v)}"${currentFieldValue === v ? ' selected' : ''}>${escHtml(v)}</option>`
            ).join('')}
          </select>
          <span class="task-field-status" data-task-id="${escHtml(task.id)}"></span>
        </div>` : '';
      return `
        <div class="task-item ${cls}" data-id="${escHtml(task.id)}">
          <button class="task-check${task.done ? ' checked' : ''}" title="${task.done ? 'Done' : 'Mark done'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </button>
          <div class="task-info">
            <div class="task-title">${escHtml(task.title)}</div>
            <div class="task-time">${timeStr}${isOverdue ? ' · <span class="overdue-label">overdue</span>' : ''}${jiraLinkHtml}</div>
            ${dropdownHtml}
          </div>
        </div>`;
    }).join('');

    return `<div class="task-group"><div class="task-group-label">${label}</div>${items}</div>`;
  }).join('');

  // Wire up check buttons
  list.querySelectorAll('.task-check').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const taskId = e.target.closest('.task-item').dataset.id;
      handleMarkDone(taskId);
    });
  });

  // Wire up field value dropdowns
  list.querySelectorAll('.task-field-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const newValue = sel.value;
      if (!newValue) return;
      const statusEl = list.querySelector(`.task-field-status[data-task-id="${sel.dataset.taskId}"]`);
      const task = scheduledTasks.find(t => t.id === sel.dataset.taskId);
      const prevValue = task?.filterFieldValue || '';
      sel.disabled = true;
      if (statusEl) statusEl.textContent = '…';
      const res = await new Promise(r =>
        chrome.runtime.sendMessage({
          action: 'updateJiraField',
          issueKey: sel.dataset.issueKey,
          fieldId: jiraCustomFieldId,
          value: newValue,
        }, r)
      );
      sel.disabled = false;
      if (res?.ok) {
        if (task) task.filterFieldValue = newValue;
        if (statusEl) {
          statusEl.textContent = '✓';
          setTimeout(() => { statusEl.textContent = ''; }, 2000);
        }
      } else {
        sel.value = prevValue;
        if (statusEl) {
          statusEl.textContent = '✗';
          setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
      }
    });
  });
}

async function handleMarkDone(taskId) {
  const task = scheduledTasks.find(t => t.id === taskId);
  if (!task || task.done) return;

  // Optimistic UI update
  task.done = true;
  renderScheduledTasks(scheduledTasks);

  // Re-render lists so the now-done item reappears
  const scheduledJiraKeys = new Set(
    scheduledTasks.filter(t => !t.done && t.sourceType === 'jira').map(t => t.sourceId)
  );
  const scheduledSlackIds = new Set(
    scheduledTasks.filter(t => !t.done && t.sourceType === 'slack').map(t => t.sourceId)
  );
  renderJira(jiraIssues.filter(i => !scheduledJiraKeys.has(i.key)));
  renderSlack(slackMessages.filter(m => !scheduledSlackIds.has(m.ts)));
  updateCounts();

  await new Promise(resolve =>
    chrome.runtime.sendMessage({ action: 'markTaskDone', id: taskId }, resolve)
  );
}

async function handleRescheduleOverdue() {
  const btn = document.getElementById('btn-reschedule-overdue');
  btn.disabled = true;
  btn.textContent = 'Rescheduling…';

  const res = await new Promise(resolve =>
    chrome.runtime.sendMessage({ action: 'rescheduleOverdue' }, resolve)
  );

  btn.disabled = false;
  btn.textContent = 'Reschedule overdue';

  if (res?.ok) {
    showEventResult('success', res.rescheduled > 0
      ? `${res.rescheduled} task${res.rescheduled !== 1 ? 's' : ''} rescheduled into new slots.`
      : 'No overdue tasks to reschedule.');
    await loadFromCache();
  } else {
    showEventResult('error', `Reschedule failed: ${res?.error || 'Unknown error'}`);
  }
}

// ── Task scheduling ────────────────────────────────────────────────────────────

async function handleScheduleTasks() {
  const btn = document.getElementById('btn-create-event');
  const items = getSelectedItems();

  if (!items.length) {
    showEventResult('error', 'Select at least one Jira or Slack item first.');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>Scheduling…`;

  const res = await new Promise(resolve =>
    chrome.runtime.sendMessage({ action: 'scheduleTaskItems', payload: { items } }, resolve)
  );

  btn.disabled = false;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>Schedule Tasks`;

  if (res?.ok) {
    showEventResult('success', `${res.created.length} task${res.created.length !== 1 ? 's' : ''} scheduled on your calendar!`);
    // Clear selection and reload task list
    selected.jira.clear();
    selected.slack.clear();
    document.querySelectorAll('.jira-card.selected, .slack-card.selected').forEach(c => c.classList.remove('selected'));
    await loadFromCache();
  } else {
    showEventResult('error', `Failed: ${res?.error || 'Unknown error'}`);
  }
}

function showEventResult(type, message) {
  const el = document.getElementById('event-result');
  el.className = `event-result ${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function updateLastSync(iso) {
  if (!navigator.onLine) return; // don't overwrite the offline label
  const el = document.getElementById('last-sync-text');
  if (!iso) { el.textContent = 'Never synced'; return; }
  el.textContent = `Last sync: ${relativeTime(iso)}`;
}

function updateOnlineStatus() {
  const el = document.getElementById('last-sync-text');
  const btn = document.getElementById('btn-sync');
  if (!navigator.onLine) {
    el.textContent = 'Offline — showing cached data';
    btn.disabled = true;
    btn.title = 'No internet connection';
  } else {
    btn.disabled = false;
    btn.title = 'Sync now';
  }
}

// ── External Review ────────────────────────────────────────────────────────────────

function renderExtReview() {
  const list = document.getElementById('ext-list');
  const rescheduleBtn = document.getElementById('ext-reschedule-overdue');
  const now = new Date();

  // Visible = not done AND not in extDoneKeys
  const visible = extIssues.filter(i => !extDoneKeys.has(i.key));

  // Check if any scheduled task from External Review is overdue
  const extScheduledKeys = new Set(
    scheduledTasks.filter(t => !t.done && t.sourceType === 'jira').map(t => t.sourceId)
  );
  const hasExtOverdue = scheduledTasks.some(t =>
    !t.done && t.extSource && (t.overdue || new Date(t.startTime) < now)
  );
  rescheduleBtn.style.display = hasExtOverdue ? '' : 'none';

  if (!visible.length) {
    list.innerHTML = `<div class="empty-state"><p>No External Review issues.</p><small>Configure External Review in Settings, then sync.</small></div>`;
    return;
  }

  list.innerHTML = '';
  for (const issue of visible) {
    const isScheduled = extScheduledKeys.has(issue.key);
    const task = isScheduled ? scheduledTasks.find(t => !t.done && t.sourceId === issue.key) : null;
    const timeStr = task ? (() => {
      const s = new Date(task.startTime);
      const e = new Date(task.endTime);
      const isOverdue = s < now;
      const dateLabel = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const timeLabel = `${s.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} – ${e.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
      return `<span class="task-time">${dateLabel} · ${timeLabel}${isOverdue ? ' · <span class="overdue-label">overdue</span>' : ''}</span>`;
    })() : '';

    const date = issue.updated ? relativeTime(issue.updated) : '';
    const card = document.createElement('div');
    card.className = `task-item ext-card${isScheduled ? ' ext-scheduled' : ''}`;
    card.dataset.key = issue.key;

    card.innerHTML = `
      <button class="task-check ext-done-btn" data-key="${escHtml(issue.key)}" title="Mark done (remove from list)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </button>
      <div class="task-info">
        <div class="task-title">
          <span class="card-key" style="color:var(--accent);font-size:11px;font-weight:600;margin-right:6px">${escHtml(issue.key)}</span>
          ${issue.sortFieldValue ? `<span class="card-sort-value">${escHtml(issue.sortFieldValue)}</span> ` : ''}
          ${escHtml(issue.summary)}
        </div>
        <div class="task-time" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:3px">
          ${issue.project ? `<span class="meta-chip chip-project" style="font-size:10px">${escHtml(issue.project)}</span>` : ''}
          ${date ? `<span style="color:var(--text3);font-size:11px">${date}</span>` : ''}
          ${timeStr}
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:5px">
          <a class="card-link" href="${escHtml(issue.url)}" target="_blank" rel="noopener" style="font-size:11px">↗ Open in Jira</a>
          ${!isScheduled
            ? `<button class="ext-schedule-btn text-btn" data-key="${escHtml(issue.key)}" style="font-size:11px;color:var(--green)">📅 Schedule</button>`
            : `<span style="font-size:11px;color:var(--text3)">✓ Scheduled</span>`
          }
        </div>
      </div>
    `;

    // Mark done
    card.querySelector('.ext-done-btn').addEventListener('click', async () => {
      extDoneKeys.add(issue.key);
      await chrome.storage.local.set({ extDoneKeys: [...extDoneKeys] });
      renderExtReview();
      updateCounts();
    });

    // Schedule this single issue
    const schedBtn = card.querySelector('.ext-schedule-btn');
    if (schedBtn) {
      schedBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        schedBtn.disabled = true;
        schedBtn.textContent = 'Scheduling…';
        const item = { ...issue, type: 'jira', extSource: true };
        const res = await new Promise(resolve =>
          chrome.runtime.sendMessage({ action: 'scheduleTaskItems', payload: { items: [item] } }, resolve)
        );
        if (res?.ok) {
          showExtResult('success', `Scheduled: ${issue.key}`);
          await loadFromCache();
        } else {
          schedBtn.disabled = false;
          schedBtn.textContent = '📅 Schedule';
          showExtResult('error', res?.error || 'Schedule failed');
        }
      });
    }

    list.appendChild(card);
  }
}

function showExtResult(type, message) {
  const el = document.getElementById('ext-result');
  el.className = `event-result ${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function updateCounts() {
  document.getElementById('jira-count').textContent = jiraIssues.length || '';
  document.getElementById('slack-count').textContent = slackMessages.filter(m => m.importance >= 3).length || '';
  const reminderBadge = document.getElementById('reminder-count');
  if (reminders.length) {
    reminderBadge.textContent = reminders.length;
    reminderBadge.style.display = '';
  } else {
    reminderBadge.style.display = 'none';
  }
  const extVisible = extIssues.filter(i => !extDoneKeys.has(i.key)).length;
  const extBadge = document.getElementById('ext-count');
  if (extVisible) {
    extBadge.textContent = extVisible;
    extBadge.style.display = '';
  } else {
    extBadge.style.display = 'none';
  }
}

function showError(msg) {
  const el = document.getElementById('error-banner');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Convert Slack mrkdwn markup to readable plain text */
function cleanSlackText(text) {
  return text
    .replace(/<@[A-Z0-9]+>/g, '@user')                       // <@U123> → @user
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')                // <#C123|general> → #general
    .replace(/<#[A-Z0-9]+>/g, '#channel')                     // <#C123> → #channel
    .replace(/<!(here|channel|everyone)>/g, '@$1')             // <!here> → @here
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')         // <url|label> → label
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')                   // <url> → url
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')               // <mailto:x|email> → email
    .replace(/<[^>]+>/g, '')                                   // strip any remaining markup
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
