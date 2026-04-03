import { JiraAPI } from './api/jira.js';
import { SlackAPI } from './api/slack.js';
import { CalendarAPI, getGoogleAccessToken } from './api/calendar.js';
import { firestorePatch, firestoreGet, docIdFromEmail } from './firebase.js';

const FIELDS = [
  'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
  'jiraProjectKey', 'jiraProjectName', 'jiraCustomFieldId', 'jiraCustomFieldName',
  'jiraStatusName', 'jiraStatusNames',
  'jiraSortFieldId', 'jiraSortFieldName', 'jiraSortOrder',
  'jiraExcludeFieldIds', 'jiraExcludeValues',
  // External Review — separate Jira query, same credentials
  'extProjectKey', 'extProjectName', 'extCustomFieldId', 'extCustomFieldName',
  'extStatusNames',
  'extSortFieldId', 'extSortFieldName', 'extSortOrder',
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
  'worksyncDocId', // local-only Firestore doc override
  'syncSecret', // local-only — never pushed to Firestore
];

// ── Wizard namespace descriptors ─────────────────────────────────────────────
// Each wizard (Jira / External Review) gets a namespace object W that maps logical
// names to concrete DOM element IDs and storage key names.

const JIRA_WIZ = {
  projectLabel:      'project-selected-label',
  pickBtn:           'btn-pick-project',
  clearBtn:          'btn-clear-project',
  picker:            'project-picker',
  projectList:       'project-list',
  step2Block:        'step-2-block',
  fieldChips:        'field-chips',
  step3Block:        'step-3-block',
  valueList:         'value-list',
  step4Block:        'step-4-block',
  sortChips:         'sort-field-chips',
  sortList:          'sort-order-list',
  step5Block:        'step-5-block',
  excludeChips:      'exclude-field-chips',
  excludeValueList:  'exclude-value-list',
  // hidden input IDs
  projectKeyInput:      'jiraProjectKey',
  projectNameInput:     'jiraProjectName',
  fieldIdInput:         'jiraCustomFieldId',
  fieldNameInput:       'jiraCustomFieldName',
  statusNamesInput:     'jiraStatusNames',
  sortFieldIdInput:     'jiraSortFieldId',
  sortFieldNameInput:   'jiraSortFieldName',
  sortOrderInput:       'jiraSortOrder',
  excludeFieldIdsInput: 'jiraExcludeFieldIds',
  excludeValuesInput:   'jiraExcludeValues',
};

const EXT_WIZ = {
  projectLabel:      'ext-project-selected-label',
  pickBtn:           'btn-ext-pick-project',
  clearBtn:          'btn-ext-clear-project',
  picker:            'ext-project-picker',
  projectList:       'ext-project-list',
  step2Block:        'step-ext-2-block',
  fieldChips:        'ext-field-chips',
  step3Block:        'step-ext-3-block',
  valueList:         'ext-value-list',
  step4Block:        'step-ext-4-block',
  sortChips:         'ext-sort-field-chips',
  sortList:          'ext-sort-order-list',
  step5Block:        'step-ext-5-block',
  excludeChips:      'ext-exclude-field-chips',
  excludeValueList:  'ext-exclude-value-list',
  projectKeyInput:      'extProjectKey',
  projectNameInput:     'extProjectName',
  fieldIdInput:         'extCustomFieldId',
  fieldNameInput:       'extCustomFieldName',
  statusNamesInput:     'extStatusNames',
  sortFieldIdInput:     'extSortFieldId',
  sortFieldNameInput:   'extSortFieldName',
  sortOrderInput:       'extSortOrder',
  excludeFieldIdsInput: 'extExcludeFieldIds',
  excludeValuesInput:   'extExcludeValues',
};

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await _pullFirestoreIntoStorage(); // sync from Firestore before reading local storage
  await loadSettings();
  setupTogglePasswords();
  setupForm();
  setupTestButtons();
  setupClearButton();
  setupReportToggle();
  setupWorkingDayToggles();
  showRedirectUri();
  setupProjectClear(JIRA_WIZ);
  setupProjectClear(EXT_WIZ);
});

/** Pull latest config from Firestore into chrome.storage.local (same logic as popup.js) */
async function _pullFirestoreIntoStorage() {
  try {
    const local = await new Promise(r =>
      chrome.storage.local.get(['worksyncDocId', 'jiraEmail', 'syncSecret', '_configPushedAt'], r)
    );
    const docId = local.worksyncDocId?.trim() || docIdFromEmail(local.jiraEmail, local.syncSecret);
    if (!docId) return;

    const remote = await firestoreGet('worksync_config', docId);
    if (!remote || !Object.keys(remote).length) return;

    const localTs  = Number(local._configPushedAt || 0);
    const remoteTs = Number(remote._configPushedAt || 0);
    const shouldApply = remoteTs > 0 && (localTs === 0 || remoteTs > localTs);
    if (!shouldApply) return;

    const toSet = {};
    for (const [k, v] of Object.entries(remote)) {
      if (v === null || v === undefined || v === '') continue;
      toSet[k] = v;
    }
    if (Object.keys(toSet).length) await new Promise(r => chrome.storage.local.set(toSet, r));
  } catch (e) {
    console.warn('[WorkSync] Options Firestore pull failed:', e.message);
  }
}


// ── Load / Save ───────────────────────────────────────────────────────────────

async function loadSettings() {
  const config = await new Promise(r => chrome.storage.local.get(FIELDS, r));

  for (const field of FIELDS) {
    const el = document.getElementById(field);
    if (!el) continue;
    if (el.type === 'checkbox') {
      el.checked = config[field] !== false; // default true
    } else {
      el.value = config[field] || '';
    }
  }

  // Restore step 1 space labels
  if (config.jiraProjectName) {
    document.getElementById(JIRA_WIZ.projectLabel).textContent = `Space: ${config.jiraProjectName}`;
  }

  // Auto-restore Jira wizard steps
  if (config.jiraProjectKey && config.jiraBaseUrl && config.jiraEmail && config.jiraApiToken) {
    const savedFieldId = config.jiraCustomFieldId || null;
    const savedValues = config.jiraStatusNames
      ? (() => { try { return JSON.parse(config.jiraStatusNames); } catch { return []; } })() : [];
    const savedSortFieldId = config.jiraSortFieldId || null;
    const savedSortOrder = config.jiraSortOrder
      ? (() => { try { return JSON.parse(config.jiraSortOrder); } catch { return []; } })() : [];
    const savedExcludeFieldIds = config.jiraExcludeFieldIds
      ? (() => { try { return JSON.parse(config.jiraExcludeFieldIds); } catch { return []; } })() : [];
    const savedExcludeValues = config.jiraExcludeValues
      ? (() => { try { return JSON.parse(config.jiraExcludeValues); } catch { return {}; } })() : {};
    await loadCustomFields(JIRA_WIZ, config.jiraProjectKey, savedFieldId, savedValues, savedSortFieldId, savedSortOrder, savedExcludeFieldIds, savedExcludeValues);
  }

  // Restore External Review space label
  if (config.extProjectName) {
    document.getElementById(EXT_WIZ.projectLabel).textContent = `Space: ${config.extProjectName}`;
  }

  // Auto-restore External Review wizard steps
  if (config.extProjectKey && config.jiraBaseUrl && config.jiraEmail && config.jiraApiToken) {
    const savedFieldId = config.extCustomFieldId || null;
    const savedValues = config.extStatusNames
      ? (() => { try { return JSON.parse(config.extStatusNames); } catch { return []; } })() : [];
    const savedSortFieldId = config.extSortFieldId || null;
    const savedSortOrder = config.extSortOrder
      ? (() => { try { return JSON.parse(config.extSortOrder); } catch { return []; } })() : [];
    const savedExcludeFieldIds = config.extExcludeFieldIds
      ? (() => { try { return JSON.parse(config.extExcludeFieldIds); } catch { return []; } })() : [];
    const savedExcludeValues = config.extExcludeValues
      ? (() => { try { return JSON.parse(config.extExcludeValues); } catch { return {}; } })() : {};
    await loadCustomFields(EXT_WIZ, config.extProjectKey, savedFieldId, savedValues, savedSortFieldId, savedSortOrder, savedExcludeFieldIds, savedExcludeValues);
  }

  // Set defaults for selects
  if (!config.slackImportanceThreshold) document.getElementById('slackImportanceThreshold').value = '7';
  if (!config.syncInterval) document.getElementById('syncInterval').value = '30';
  if (!config.defaultCalendarId) document.getElementById('defaultCalendarId').value = 'primary';
  if (!config.reportTime) document.getElementById('reportTime').value = '09:00';
  if (!config.reportBotName) document.getElementById('reportBotName').value = 'WorkSync Bot';
  // Default checkboxes to true if never saved
  if (config.reportIncludeJira === undefined) document.getElementById('reportIncludeJira').checked = true;
  if (config.reportIncludeSlack === undefined) document.getElementById('reportIncludeSlack').checked = true;
  if (config.reportEnabled === undefined) document.getElementById('reportEnabled').checked = false;
}

function setupForm() {
  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {};
    for (const field of FIELDS) {
      const el = document.getElementById(field);
      if (!el) continue;
      data[field] = el.type === 'checkbox' ? el.checked : el.value.trim();
    }
    const ts = String(Date.now());
    data._configPushedAt = ts;
    await new Promise(r => chrome.storage.local.set(data, r));
    showSaveResult('success', 'Settings saved! WorkSync will sync shortly.');

    // Push config to Firestore for cross-device sync (fire-and-forget)
    // Only push non-empty values so we never overwrite the app's valid data with blank fields
    const docId = data.worksyncDocId?.trim() || docIdFromEmail(data.jiraEmail, data.syncSecret);
    if (docId) {
      const filtered = { _configPushedAt: ts };
      for (const [k, v] of Object.entries(data)) {
        if (k === '_configPushedAt') continue;
        if (v === null || v === undefined || v === '') continue;
        filtered[k] = v;
      }
      firestorePatch('worksync_config', docId, filtered).catch(e =>
        console.warn('[WorkSync] Firestore config push failed:', e.message)
      );
    }

    // Trigger a sync in background
    chrome.runtime.sendMessage({ action: 'sync' });
  });
}

function setupClearButton() {
  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm('Clear all WorkSync settings?')) return;
    await new Promise(r => chrome.storage.local.clear(r));
    for (const field of FIELDS) {
      const el = document.getElementById(field);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = true;
      else el.value = '';
    }
    showSaveResult('success', 'All settings cleared.');
  });
}

// ── Password toggles ──────────────────────────────────────────────────────────

function setupTogglePasswords() {
  document.querySelectorAll('.toggle-pw').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
      }
    });
  });
}

// ── Test buttons ──────────────────────────────────────────────────────────────

function setupTestButtons() {
  document.getElementById('test-jira').addEventListener('click', testJira);
  document.getElementById(JIRA_WIZ.pickBtn).addEventListener('click', () => pickProject(JIRA_WIZ));
  document.getElementById(EXT_WIZ.pickBtn).addEventListener('click', () => pickProject(EXT_WIZ));
  document.getElementById('test-slack').addEventListener('click', testSlack);
  document.getElementById('test-gcal').addEventListener('click', testGcal);
  document.getElementById('test-report').addEventListener('click', testReport);
}

// ── Step 1: Space picker ──────────────────────────────────────────────────────

function setupProjectClear(W) {
  document.getElementById(W.clearBtn).addEventListener('click', () => {
    document.getElementById(W.projectKeyInput).value = '';
    document.getElementById(W.projectNameInput).value = '';
    document.getElementById(W.projectLabel).textContent = 'No space selected';
    document.getElementById(W.picker).classList.add('hidden');
    resetStep2(W);
    resetStep3(W);
    resetStep4(W);
    resetStep5(W);
  });
}

async function pickProject(W) {
  const btn = document.getElementById(W.pickBtn);
  const picker = document.getElementById(W.picker);
  const list = document.getElementById(W.projectList);

  const baseUrl = document.getElementById('jiraBaseUrl').value.trim();
  const email = document.getElementById('jiraEmail').value.trim();
  const token = document.getElementById('jiraApiToken').value.trim();

  if (!baseUrl || !email || !token) {
    list.innerHTML = '<li class="board-error">Fill in Jira credentials first.</li>';
    picker.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Loading…';
  list.innerHTML = '<li class="board-loading">Fetching spaces…</li>';
  picker.classList.remove('hidden');

  try {
    const jira = new JiraAPI({ baseUrl, email, apiToken: token });
    const projects = await jira.getProjects();

    if (!projects.length) {
      list.innerHTML = '<li class="board-error">No spaces found.</li>';
      return;
    }

    const currentKey = document.getElementById(W.projectKeyInput).value;
    list.innerHTML = projects.map(p => `
      <li class="board-option project-option${p.key === currentKey ? ' selected' : ''}"
          data-key="${escHtml(p.key)}" data-name="${escHtml(p.name)}">
        <span class="board-type">${escHtml(p.key)}</span>
        <span class="board-name">${escHtml(p.name)}</span>
      </li>`).join('');

    list.querySelectorAll('.project-option').forEach(el => {
      el.addEventListener('click', async () => {
        list.querySelectorAll('.project-option').forEach(o => o.classList.remove('selected'));
        el.classList.add('selected');
        const key = el.dataset.key;
        const name = el.dataset.name;
        document.getElementById(W.projectKeyInput).value = key;
        document.getElementById(W.projectNameInput).value = name;
        document.getElementById(W.projectLabel).textContent = `Space: ${name} (${key})`;
        picker.classList.add('hidden');
        resetStep2(W);
        resetStep3(W);
        resetStep4(W);
        resetStep5(W);
        await loadCustomFields(W, key, null, []);
      });
    });
  } catch (e) {
    list.innerHTML = `<li class="board-error">${e.message}</li>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Browse Spaces';
  }
}

// ── Step 2: Custom field chip selector ───────────────────────────────────────

function resetStep2(W) {
  document.getElementById(W.fieldIdInput).value = '';
  document.getElementById(W.fieldNameInput).value = '';
  document.getElementById(W.step2Block).classList.add('step-disabled');
  document.getElementById(W.fieldChips).innerHTML =
    '<span class="chip-hint">Select a space above to load available fields</span>';
}

function resetStep3(W) {
  document.getElementById(W.statusNamesInput).value = '';
  document.getElementById(W.step3Block).classList.add('step-disabled');
  document.getElementById(W.valueList).innerHTML =
    '<li class="chip-hint" style="padding:10px;font-size:12px;color:var(--text3)">Select a field above to load values</li>';
}

function resetStep4(W) {
  document.getElementById(W.sortFieldIdInput).value = '';
  document.getElementById(W.sortFieldNameInput).value = '';
  document.getElementById(W.sortOrderInput).value = '';
  document.getElementById(W.step4Block).classList.add('step-disabled');
  document.getElementById(W.sortChips).innerHTML =
    '<span class="chip-hint">Complete step 2 to load available sort fields</span>';
  document.getElementById(W.sortList).innerHTML = '';
}

function resetStep5(W) {
  document.getElementById(W.excludeFieldIdsInput).value = '';
  document.getElementById(W.excludeValuesInput).value = '';
  document.getElementById(W.step5Block).classList.add('step-disabled');
  document.getElementById(W.excludeChips).innerHTML =
    '<span class="chip-hint">Complete step 2 to load available fields</span>';
  document.getElementById(W.excludeValueList).innerHTML = '';
}

async function loadCustomFields(W, projectKey, selectedFieldId, selectedValues, selectedSortFieldId, savedSortOrder, selectedExcludeFieldIds, savedExcludeValues) {
  const step2 = document.getElementById(W.step2Block);
  const chips = document.getElementById(W.fieldChips);
  step2.classList.remove('step-disabled');
  chips.innerHTML = '<span class="chip-hint">Loading fields…</span>';

  const baseUrl = document.getElementById('jiraBaseUrl').value.trim();
  const email = document.getElementById('jiraEmail').value.trim();
  const token = document.getElementById('jiraApiToken').value.trim();

  try {
    const jira = new JiraAPI({ baseUrl, email, apiToken: token });
    const fields = await jira.getProjectCustomFields(projectKey);

    if (!fields.length) {
      chips.innerHTML = '<span class="chip-hint">No option-type custom fields found in this space</span>';
      return;
    }

    // Render step 2 filter chips
    chips.innerHTML = fields.map(f => `
      <span class="chip${f.id === selectedFieldId ? ' selected' : ''}"
            data-id="${escHtml(f.id)}" data-name="${escHtml(f.name)}">
        ${escHtml(f.name)}
      </span>`).join('');

    chips.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        chips.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
        document.getElementById(W.fieldIdInput).value = chip.dataset.id;
        document.getElementById(W.fieldNameInput).value = chip.dataset.name;
        resetStep3(W);
        await loadFieldValues(W, chip.dataset.id, projectKey, []);
      });
    });

    // Render step 4 sort chips (same field list)
    renderSortChips(W, fields, projectKey, selectedSortFieldId, savedSortOrder);

    // Render step 5 exclude chips (same field list, multi-select)
    renderExcludeChips(W, fields, projectKey, selectedExcludeFieldIds, savedExcludeValues);

    // Restore steps 3, 4 & 5 if fields were previously selected
    if (selectedFieldId) {
      await loadFieldValues(W, selectedFieldId, projectKey, selectedValues);
    }
    if (selectedSortFieldId && savedSortOrder?.length) {
      await loadSortValues(W, selectedSortFieldId, projectKey, savedSortOrder);
    }
    if (selectedExcludeFieldIds?.length) {
      for (const fieldId of selectedExcludeFieldIds) {
        const fieldName = fields.find(f => f.id === fieldId)?.name || fieldId;
        await addExcludeFieldSection(W, fieldId, fieldName, projectKey, (savedExcludeValues || {})[fieldId] || []);
      }
    }
  } catch (e) {
    chips.innerHTML = `<span class="chip-hint" style="color:var(--red)">${escHtml(e.message)}</span>`;
  }
}

// ── Step 4: Sort field + drag-and-drop order ──────────────────────────────────

function renderSortChips(W, fields, projectKey, selectedSortFieldId, savedSortOrder) {
  const step4 = document.getElementById(W.step4Block);
  const sortChips = document.getElementById(W.sortChips);
  step4.classList.remove('step-disabled');

  sortChips.innerHTML = fields.map(f => `
    <span class="chip${f.id === selectedSortFieldId ? ' selected' : ''}"
          data-id="${escHtml(f.id)}" data-name="${escHtml(f.name)}">
      ${escHtml(f.name)}
    </span>`).join('');

  sortChips.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      sortChips.querySelectorAll('.chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      document.getElementById(W.sortFieldIdInput).value = chip.dataset.id;
      document.getElementById(W.sortFieldNameInput).value = chip.dataset.name;
      document.getElementById(W.sortOrderInput).value = '';
      document.getElementById(W.sortList).innerHTML = '';
      await loadSortValues(W, chip.dataset.id, projectKey, []);
    });
  });
}

async function loadSortValues(W, fieldId, projectKey, savedOrder) {
  const list = document.getElementById(W.sortList);
  list.innerHTML = '<li style="padding:8px;font-size:12px;color:var(--text3)">Loading values…</li>';

  const baseUrl = document.getElementById('jiraBaseUrl').value.trim();
  const email = document.getElementById('jiraEmail').value.trim();
  const token = document.getElementById('jiraApiToken').value.trim();

  try {
    const jira = new JiraAPI({ baseUrl, email, apiToken: token });
    const values = await jira.getFieldValues(fieldId, projectKey);

    if (!values.length) {
      list.innerHTML = '<li style="padding:8px;font-size:12px;color:var(--text3)">No values found</li>';
      return;
    }

    // Apply saved order if available, append any new values at end
    const ordered = savedOrder.length
      ? [...savedOrder.filter(v => values.includes(v)), ...values.filter(v => !savedOrder.includes(v))]
      : values;

    renderDragList(W, list, ordered);
  } catch (e) {
    list.innerHTML = `<li style="padding:8px;font-size:12px;color:var(--red)">${escHtml(e.message)}</li>`;
  }
}

function renderDragList(W, list, values) {
  list.innerHTML = values.map((v, i) => `
    <li class="drag-item" draggable="true" data-value="${escHtml(v)}">
      <span class="drag-handle">⠿</span>
      <span class="drag-rank">${i + 1}</span>
      <span class="drag-value">${escHtml(v)}</span>
    </li>`).join('');

  let dragSrc = null;

  list.querySelectorAll('.drag-item').forEach(item => {
    item.addEventListener('dragstart', () => {
      dragSrc = item;
      setTimeout(() => item.classList.add('dragging'), 0);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.drag-item').forEach(i => i.classList.remove('drag-over'));
      dragSrc = null;
      syncDragOrder(W, list);
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!dragSrc || dragSrc === item) return;
      const rect = item.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        list.insertBefore(dragSrc, item);
      } else {
        list.insertBefore(dragSrc, item.nextSibling);
      }
      updateRanks(list);
    });
  });
}

function updateRanks(list) {
  list.querySelectorAll('.drag-item').forEach((item, i) => {
    item.querySelector('.drag-rank').textContent = i + 1;
  });
}

function syncDragOrder(W, list) {
  const order = [...list.querySelectorAll('.drag-item')].map(i => i.dataset.value);
  document.getElementById(W.sortOrderInput).value = JSON.stringify(order);
}

// ── Step 5: Exclude field multi-select chips + checkboxes ────────────────────

function renderExcludeChips(W, fields, projectKey, selectedExcludeFieldIds, savedExcludeValues) {
  const step5 = document.getElementById(W.step5Block);
  const excludeChips = document.getElementById(W.excludeChips);
  step5.classList.remove('step-disabled');

  excludeChips.innerHTML = fields.map(f => `
    <span class="chip${(selectedExcludeFieldIds || []).includes(f.id) ? ' selected' : ''}"
          data-id="${escHtml(f.id)}" data-name="${escHtml(f.name)}">
      ${escHtml(f.name)}
    </span>`).join('');

  excludeChips.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      chip.classList.toggle('selected');
      const isSelected = chip.classList.contains('selected');
      const selectedIds = [...excludeChips.querySelectorAll('.chip.selected')].map(c => c.dataset.id);
      document.getElementById(W.excludeFieldIdsInput).value = JSON.stringify(selectedIds);

      if (isSelected) {
        const current = getExcludeValuesMap(W);
        await addExcludeFieldSection(W, chip.dataset.id, chip.dataset.name, projectKey, current[chip.dataset.id] || []);
      } else {
        removeExcludeFieldSection(W, chip.dataset.id);
        const current = getExcludeValuesMap(W);
        delete current[chip.dataset.id];
        document.getElementById(W.excludeValuesInput).value = JSON.stringify(current);
      }
    });
  });
}

function getExcludeValuesMap(W) {
  try { return JSON.parse(document.getElementById(W.excludeValuesInput).value || '{}'); } catch { return {}; }
}

function removeExcludeFieldSection(W, fieldId) {
  document.getElementById(`${W.excludeValueList}-section-${CSS.escape(fieldId)}`)?.remove();
}

async function addExcludeFieldSection(W, fieldId, fieldName, projectKey, savedValues) {
  const container = document.getElementById(W.excludeValueList);
  // Remove existing section for this field if any
  removeExcludeFieldSection(W, fieldId);

  const section = document.createElement('div');
  section.id = `${W.excludeValueList}-section-${fieldId}`;
  section.className = 'exclude-section';
  section.innerHTML = `
    <div class="exclude-section-label">${escHtml(fieldName)}</div>
    <ul class="board-list exclude-options" data-field="${escHtml(fieldId)}">
      <li style="padding:8px;font-size:12px;color:var(--text3)">Loading…</li>
    </ul>`;
  container.appendChild(section);

  const baseUrl = document.getElementById('jiraBaseUrl').value.trim();
  const email = document.getElementById('jiraEmail').value.trim();
  const token = document.getElementById('jiraApiToken').value.trim();
  const list = section.querySelector('.exclude-options');

  try {
    const jira = new JiraAPI({ baseUrl, email, apiToken: token });
    const values = await jira.getFieldValues(fieldId, projectKey);

    if (!values.length) {
      list.innerHTML = '<li style="padding:8px;font-size:12px;color:var(--text3)">No values found</li>';
      return;
    }

    list.innerHTML = values.map(v => `
      <li class="board-option exclude-option" data-value="${escHtml(v)}" data-field="${escHtml(fieldId)}">
        <input type="checkbox" class="pick-check" ${savedValues.includes(v) ? 'checked' : ''} />
        <span class="board-name">${escHtml(v)}</span>
      </li>`).join('');

    const syncFieldChecked = () => {
      const current = getExcludeValuesMap(W);
      current[fieldId] = [...list.querySelectorAll('.exclude-option')]
        .filter(el => el.querySelector('.pick-check').checked)
        .map(el => el.dataset.value);
      document.getElementById(W.excludeValuesInput).value = JSON.stringify(current);
    };

    list.querySelectorAll('.exclude-option').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('pick-check')) return;
        el.querySelector('.pick-check').checked = !el.querySelector('.pick-check').checked;
        syncFieldChecked();
      });
      el.querySelector('.pick-check').addEventListener('change', syncFieldChecked);
    });

    syncFieldChecked();
  } catch (e) {
    list.innerHTML = `<li style="padding:8px;font-size:12px;color:var(--red)">${escHtml(e.message)}</li>`;
  }
}

// ── Step 3: Value checkboxes ──────────────────────────────────────────────────

async function loadFieldValues(W, fieldId, projectKey, selectedValues) {
  const step3 = document.getElementById(W.step3Block);
  const list = document.getElementById(W.valueList);
  step3.classList.remove('step-disabled');
  list.innerHTML = '<li class="board-loading" style="padding:10px;font-size:12px;color:var(--text3)">Loading values…</li>';

  const baseUrl = document.getElementById('jiraBaseUrl').value.trim();
  const email = document.getElementById('jiraEmail').value.trim();
  const token = document.getElementById('jiraApiToken').value.trim();

  try {
    const jira = new JiraAPI({ baseUrl, email, apiToken: token });
    const values = await jira.getFieldValues(fieldId, projectKey);

    if (!values.length) {
      list.innerHTML = '<li class="chip-hint" style="padding:10px;font-size:12px;color:var(--text3)">No values found for this field</li>';
      return;
    }

    list.innerHTML = values.map(v => `
      <li class="board-option status-option" data-value="${escHtml(v)}">
        <input type="checkbox" class="pick-check" ${selectedValues.includes(v) ? 'checked' : ''} />
        <span class="board-name">${escHtml(v)}</span>
      </li>`).join('');

    const syncChecked = () => {
      const checked = [...list.querySelectorAll('.status-option')]
        .filter(el => el.querySelector('.pick-check').checked)
        .map(el => el.dataset.value);
      document.getElementById(W.statusNamesInput).value = JSON.stringify(checked);
    };

    list.querySelectorAll('.status-option').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('pick-check')) return;
        el.querySelector('.pick-check').checked = !el.querySelector('.pick-check').checked;
        syncChecked();
      });
      el.querySelector('.pick-check').addEventListener('change', syncChecked);
    });

    // Sync initial state
    syncChecked();
  } catch (e) {
    list.innerHTML = `<li class="chip-hint" style="padding:10px;font-size:12px;color:var(--red)">${escHtml(e.message)}</li>`;
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function testJira() {
  const btn = document.getElementById('test-jira');
  const result = document.getElementById('jira-test-result');
  const dot = document.getElementById('jira-status');

  const baseUrl = document.getElementById('jiraBaseUrl').value.trim();
  const email = document.getElementById('jiraEmail').value.trim();
  const token = document.getElementById('jiraApiToken').value.trim();

  if (!baseUrl || !email || !token) {
    showTestResult(result, dot, 'error', 'Please fill in all Jira fields first.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Testing...';

  try {
    const jira = new JiraAPI({ baseUrl, email, apiToken: token });
    const user = await jira.getCurrentUser();
    showTestResult(result, dot, 'success', `Connected as ${user.displayName} (${user.emailAddress})`);
  } catch (e) {
    showTestResult(result, dot, 'error', `Connection failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

async function testSlack() {
  const btn = document.getElementById('test-slack');
  const result = document.getElementById('slack-test-result');
  const dot = document.getElementById('slack-status');

  const token = document.getElementById('slackToken').value.trim();
  if (!token) {
    showTestResult(result, dot, 'error', 'Please enter a Slack token first.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Testing...';

  try {
    const slack = new SlackAPI({ token });
    const info = await slack.getWorkspaceInfo();
    showTestResult(result, dot, 'success', `Connected to ${info.team} as user ${info.userId}`);
  } catch (e) {
    showTestResult(result, dot, 'error', `Connection failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  }
}

async function testGcal() {
  const btn = document.getElementById('test-gcal');
  const result = document.getElementById('gcal-test-result');
  const dot = document.getElementById('gcal-status');

  const clientId = document.getElementById('googleClientId').value.trim();
  if (!clientId) {
    showTestResult(result, dot, 'error', 'Paste your Google Client ID into the field above first.');
    return;
  }

  // Save the client ID to storage before authorizing
  await new Promise(r => chrome.storage.local.set({ googleClientId: clientId }, r));

  btn.disabled = true;
  btn.textContent = 'Authorizing...';

  try {
    const token = await getGoogleAccessToken(true, clientId);
    const calendar = new CalendarAPI({ accessToken: token });
    const calendars = await calendar.listCalendars();
    const primary = calendars.find(c => c.primary)?.summary || 'Calendar';
    showTestResult(result, dot, 'success', `Authorized! Primary calendar: ${primary}`);
  } catch (e) {
    showTestResult(result, dot, 'error', `Authorization failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Authorize Google Calendar';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function testReport() {
  const btn = document.getElementById('test-report');
  const result = document.getElementById('report-test-result');

  const channel = document.getElementById('reportChannelId').value.trim();
  const token = document.getElementById('slackToken').value.trim();
  if (!channel || !token) {
    result.className = 'test-result error';
    result.textContent = 'Slack token and Channel ID are required.';
    result.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    const res = await new Promise(resolve =>
      chrome.runtime.sendMessage({ action: 'sendDailyReport' }, resolve)
    );
    result.className = `test-result ${res?.ok ? 'success' : 'error'}`;
    result.textContent = res?.ok ? 'Report sent successfully!' : `Failed: ${res?.error}`;
    result.classList.remove('hidden');
  } catch (e) {
    result.className = 'test-result error';
    result.textContent = `Error: ${e.message}`;
    result.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Test Report Now';
  }
}

function showTestResult(el, dot, type, message) {
  el.className = `test-result ${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
  dot.className = `status-dot ${type === 'success' ? 'ok' : 'error'}`;
}

// ── Daily Report Toggle & Test ────────────────────────────────────────────────

function setupReportToggle() {
  const toggle = document.getElementById('reportEnabled');
  const fields = document.getElementById('report-fields');
  const applyState = () => {
    fields.style.opacity = toggle.checked ? '1' : '0.4';
    fields.style.pointerEvents = toggle.checked ? '' : 'none';
  };
  toggle.addEventListener('change', applyState);
  applyState();
}

function setupWorkingDayToggles() {
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  for (const day of days) {
    const checkbox = document.getElementById(`work${day}`);
    const startInput = document.getElementById(`work${day}Start`);
    const endInput = document.getElementById(`work${day}End`);
    const applyState = () => {
      const on = checkbox.checked;
      startInput.disabled = !on;
      endInput.disabled = !on;
      startInput.closest('.work-day-row').style.opacity = on ? '1' : '0.4';
    };
    checkbox.addEventListener('change', applyState);
    applyState();
  }
}

function showRedirectUri() {
  try {
    const uri = chrome.identity.getRedirectURL();
    const el = document.getElementById('redirect-uri-hint');
    if (el) el.textContent = uri;
  } catch {
    // Not in extension context (e.g. plain browser preview)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function showSaveResult(type, message) {
  const el = document.getElementById('save-result');
  el.className = `save-result ${type}`;
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}
