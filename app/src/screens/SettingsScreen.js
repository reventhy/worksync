import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  View, Text, TextInput, StyleSheet, ScrollView,
  TouchableOpacity, Switch, ActivityIndicator, Alert,
  Modal, FlatList, AppState, Animated, LayoutAnimation,
  UIManager, Platform,
} from 'react-native';
import RAnimated, {
  useSharedValue, useAnimatedStyle, runOnJS,
} from 'react-native-reanimated';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { Ionicons } from '@expo/vector-icons';
import { store, getConfig } from '../storage/store';
import { useTheme } from '../context/ThemeContext';
import { cacheGoogleToken, revokeGoogleToken, getCachedGoogleToken } from '../api/calendar';
import { useApp } from '../context/AppContext';
import { pushConfig, pullConfig, pullCache, pullGoogleToken, docIdFromEmail } from '../api/firebase';
import { JiraAPI } from '../api/jira';

WebBrowser.maybeCompleteAuthSession();

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

// Expo auth proxy — valid HTTPS URI that Google Cloud Console accepts.
// ONE-TIME SETUP: add this exact URI to your GCC OAuth client → Authorized redirect URIs:
//   https://auth.expo.io/@YOUR_EXPO_USERNAME/work-sync-app
const NATIVE_CLIENT_ID    = 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';
const GOOGLE_REDIRECT_URI = 'https://auth.expo.io/@YOUR_EXPO_USERNAME/work-sync-app';

// ── Collapsible Section ───────────────────────────────────────────────────────

/** Format ISO timestamp to relative time string */
function formatAiTime(iso) {
  try {
    const date = new Date(iso);
    const elapsed = (Date.now() - date.getTime()) / 1000;
    if (elapsed < 60) return 'just now';
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
    if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function Section({ id, title, defaultOpen = true, children }) {
  const { colors: C } = useTheme();
  const s = useMemo(() => makeSectionStyles(C), [C]);
  const [open, setOpen] = useState(defaultOpen);
  const rotation = useRef(new Animated.Value(defaultOpen ? 1 : 0)).current;

  function toggle() {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    const next = !open;
    setOpen(next);
    Animated.timing(rotation, { toValue: next ? 1 : 0, duration: 200, useNativeDriver: true }).start();
  }

  const rotate = rotation.interpolate({ inputRange: [0, 1], outputRange: ['-90deg', '0deg'] });

  return (
    <View style={s.section}>
      <TouchableOpacity style={s.sectionHeader} onPress={toggle} activeOpacity={0.7}>
        <Text style={s.sectionTitle}>{title}</Text>
        <Animated.View style={{ transform: [{ rotate }] }}>
          <Ionicons name="chevron-down" size={16} color={C.muted} />
        </Animated.View>
      </TouchableOpacity>
      {open && <View style={s.sectionBody}>{children}</View>}
    </View>
  );
}

// ── Drag-and-drop sort list ───────────────────────────────────────────────────

const DRAG_ITEM_H = 52; // fixed item height — used for snap calculation

/** Single draggable row. Drag handle triggers a Pan gesture via Reanimated + GestureHandler. */
function DraggableItem({ value, index, count, onMove, colors: C }) {
  const dy     = useSharedValue(0);
  const active = useSharedValue(false);

  const pan = Gesture.Pan()
    .onBegin(() => { active.value = true; })
    .onChange(e  => { dy.value += e.changeY; })
    .onFinalize(() => {
      // Snap to nearest slot and reorder on JS thread
      const steps = Math.round(dy.value / DRAG_ITEM_H);
      const toIdx = Math.min(Math.max(0, index + steps), count - 1);
      dy.value = 0;       // reset immediately so there's no visual snap-back
      active.value = false;
      if (toIdx !== index) runOnJS(onMove)(index, toIdx);
    });

  const animStyle = useAnimatedStyle(() => ({
    transform:  [{ translateY: dy.value }],
    zIndex:     active.value ? 100 : 1,
    elevation:  active.value ? 10 : 0,
    opacity:    active.value ? 0.88 : 1,
    shadowOpacity: active.value ? 0.25 : 0,
    shadowRadius:  active.value ? 6 : 0,
  }));

  return (
    <RAnimated.View style={[
      dndStyles.item,
      { backgroundColor: C.surfaceElevated, borderColor: C.border },
      animStyle,
    ]}>
      {/* Drag handle — only this area captures the pan gesture */}
      <GestureDetector gesture={pan}>
        <View style={dndStyles.handle} hitSlop={{ top: 10, bottom: 10, left: 6, right: 10 }}>
          <Ionicons name="menu" size={20} color={C.subtext} />
        </View>
      </GestureDetector>
      <View style={dndStyles.rankBadge}>
        <Text style={[dndStyles.rankText, { color: C.muted }]}>{index + 1}</Text>
      </View>
      <Text style={[dndStyles.value, { color: C.text }]} numberOfLines={1}>{value}</Text>
    </RAnimated.View>
  );
}

function DraggableSortList({ items, onReorder, colors: C }) {
  const [order, setOrder] = useState(items);
  useEffect(() => { setOrder(items); }, [items]);

  function moveItem(from, to) {
    setOrder(prev => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      onReorder(next);
      return next;
    });
  }

  if (!order.length) return null;

  return (
    <View style={{ marginTop: 6 }}>
      {order.map((value, index) => (
        <DraggableItem
          key={value}
          value={value}
          index={index}
          count={order.length}
          onMove={moveItem}
          colors={C}
        />
      ))}
    </View>
  );
}

const dndStyles = StyleSheet.create({
  item:      { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 6,
               paddingHorizontal: 10, height: DRAG_ITEM_H, marginBottom: 4 },
  handle:    { paddingRight: 12, alignSelf: 'stretch', justifyContent: 'center' },
  rankBadge: { width: 20, height: 20, borderRadius: 3, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  rankText:  { fontSize: 10, fontWeight: '700' },
  value:     { flex: 1, fontSize: 13 },
});

// ── Main SettingsScreen ───────────────────────────────────────────────────────

export default function SettingsScreen() {
  const { loadFromCache, triggerSync, syncing } = useApp();
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);

  const [config, setConfig] = useState({
    jiraBaseUrl: '', jiraEmail: '', jiraApiToken: '',
    jiraProjectKey: '', jiraProjectName: '',
    jiraCustomFieldId: '', jiraCustomFieldName: '',
    jiraStatusName: '', jiraStatusNames: '',
    jiraSortFieldId: '', jiraSortFieldName: '', jiraSortOrder: '',
    jiraExcludeFieldIds: '', jiraExcludeValues: '',
    slackToken: '', slackMyUserId: '', slackVipUsers: '',
    syncSecret: '',
    googleClientId: '', defaultCalendarId: 'primary',
    workMonStart: '09:00', workMonEnd: '18:00',
    workTueStart: '09:00', workTueEnd: '18:00',
    workWedStart: '09:00', workWedEnd: '18:00',
    workThuStart: '09:00', workThuEnd: '18:00',
    workFriStart: '09:00', workFriEnd: '18:00',
    syncInterval: '30', enableNotifications: true,
    reportEnabled: false, reportTime: '09:00',
    reportChannelId: '', reportBotName: 'WorkSync Bot',
  });

  const [googleConnected, setGoogleConnected]   = useState(false);
  const [saving, setSaving]                     = useState(false);
  const [connectingGoogle, setConnectingGoogle] = useState(false);
  const [testingJira, setTestingJira]           = useState(false);
  const [testingSlack, setTestingSlack]         = useState(false);
  const [aiRateLimit, setAiRateLimit]           = useState(null);
  const [saveMsg, setSaveMsg]                   = useState(null);
  const [showImportModal, setShowImportModal]   = useState(false);
  const [importEmail, setImportEmail]           = useState('');
  const [importing, setImporting]               = useState(false);

  // Jira wizard state
  const [showProjectModal, setShowProjectModal]       = useState(false);
  const [jiraProjects, setJiraProjects]               = useState([]);
  const [jiraProjectsLoading, setJiraProjectsLoading] = useState(false);
  const [jiraCustomFields, setJiraCustomFields]       = useState([]);
  const [jiraFieldsLoading, setJiraFieldsLoading]     = useState(false);
  const [jiraFilterValues, setJiraFilterValues]       = useState([]);
  const [jiraFilterValuesLoading, setJiraFilterValuesLoading] = useState(false);
  const [jiraSelectedStatusValues, setJiraSelectedStatusValues] = useState([]);
  const [jiraSortValues, setJiraSortValues]           = useState([]);
  const [jiraSortValuesLoading, setJiraSortValuesLoading] = useState(false);
  const [jiraExcludeFieldIds, setJiraExcludeFieldIds] = useState([]);
  const [jiraExcludeAvailValues, setJiraExcludeAvailValues] = useState({});
  const [jiraExcludeSelValues, setJiraExcludeSelValues] = useState({});
  const [jiraExcludeValuesLoading, setJiraExcludeValuesLoading] = useState({});

  // ── Google OAuth — Expo proxy with web client ─────────────────────────────────
  const [googleRequest, googleResponse, googlePromptAsync] = AuthSession.useAuthRequest(
    {
      clientId: config.googleClientId || undefined,
      scopes: GOOGLE_SCOPES,
      redirectUri: GOOGLE_REDIRECT_URI,
      usePKCE: true,
      extraParams: { prompt: 'consent', access_type: 'offline' },
    },
    GOOGLE_DISCOVERY,
  );

  useEffect(() => {
    if (!googleResponse) return;
    if (googleResponse.type === 'success') {
      const { code } = googleResponse.params;
      _exchangeGoogleCode(code, googleRequest?.codeVerifier);
    } else if (googleResponse.type === 'error') {
      showMsg('error', `Google auth error: ${googleResponse.error?.description || 'Unknown'}`);
      setConnectingGoogle(false);
    } else {
      setConnectingGoogle(false); // cancel / dismiss
    }
  }, [googleResponse]);
  // ─────────────────────────────────────────────────────────────────────────────

  const appStateRef     = useRef(AppState.currentState);
  const loadInitialRef  = useRef(loadInitial);
  // Keep ref current so useFocusEffect never captures a stale closure
  useEffect(() => { loadInitialRef.current = loadInitial; });

  // Reload settings whenever this tab comes into focus (catches changes from extension)
  useFocusEffect(useCallback(() => { loadInitialRef.current(); }, []));

  // Also reload when app returns from background
  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') loadInitialRef.current();
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, []);

  async function loadInitial() {
    await pullConfig();
    await pullGoogleToken(); // always fetch freshest token regardless of timestamps
    const saved = await getConfig();
    const safeConfig = {};
    for (const [k, v] of Object.entries(saved)) {
      // Skip null, undefined, AND empty strings — empty strings are either never-set
      // defaults or corrupted values written by an old buggy save; treat them as absent
      if (v === null || v === undefined || v === '') continue;
      // Keep booleans as-is; keep arrays/objects as-is (don't String() them — that
      // would turn ["a","b"] into "a,b" which breaks JSON parsing downstream)
      safeConfig[k] = v;
    }
    setConfig(prev => ({ ...prev, ...safeConfig }));
    // Load AI rate limit info (synced from extension via Firestore)
    const rateLimitStr = await store.get('aiRateLimit');
    if (rateLimitStr) {
      try {
        const parsed = typeof rateLimitStr === 'string' ? JSON.parse(rateLimitStr) : rateLimitStr;
        setAiRateLimit(parsed);
      } catch { /* ignore parse error */ }
    }
    // Use the raw token from storage (synced from extension) — don't reject on expiry
    // because the extension refreshes its own token; a sync will bring a fresh one.
    const rawToken  = await store.get('googleAccessToken');
    const rawExpiry = await store.get('googleTokenExpiry');
    const tokenValid = rawToken && rawExpiry && Date.now() < Number(rawExpiry) - 60_000;
    setGoogleConnected(!!tokenValid);

    // If no credentials are found at all, auto-open the Import modal so the user
    // can bootstrap from their Chrome extension config without manually hunting for the button
    if (!safeConfig.jiraEmail && !safeConfig.jiraBaseUrl) {
      setTimeout(() => setShowImportModal(true), 400);
      return;
    }

    const { jiraBaseUrl, jiraEmail, jiraApiToken, jiraProjectKey,
            jiraCustomFieldId, jiraStatusNames, jiraSortFieldId, jiraSortOrder,
            jiraExcludeFieldIds: rawExcIds, jiraExcludeValues: rawExcVals } = safeConfig;

    if (jiraProjectKey && jiraBaseUrl && jiraEmail && jiraApiToken) {
      // jiraStatusNames etc. may be arrays (from JSON.parse in store.getAll) or JSON strings
      const _toStr = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
      const savedStatusValues = _parseJSON(_toStr(jiraStatusNames), []);
      const savedSortOrder    = _parseJSON(_toStr(jiraSortOrder), []);
      const savedExcludeIds   = _parseJSON(_toStr(rawExcIds), []);
      const savedExcludeVals  = _parseJSON(_toStr(rawExcVals), {});
      setJiraSelectedStatusValues(savedStatusValues);
      setJiraExcludeFieldIds(savedExcludeIds);
      setJiraExcludeSelValues(savedExcludeVals);
      _loadJiraFieldsWith(jiraBaseUrl, jiraEmail, jiraApiToken, jiraProjectKey,
        jiraCustomFieldId, savedStatusValues, jiraSortFieldId, savedSortOrder, savedExcludeIds, savedExcludeVals);
    }
  }

  function _parseJSON(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
  }
  function _makeJira(baseUrl, email, apiToken) {
    return new JiraAPI({ baseUrl: baseUrl || config.jiraBaseUrl, email: email || config.jiraEmail, apiToken: apiToken || config.jiraApiToken });
  }
  function update(key, value) { setConfig(prev => ({ ...prev, [key]: value })); }
  function updateMany(patch)  { setConfig(prev => ({ ...prev, ...patch })); }

  // Step 1
  async function pickProject() {
    if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraApiToken) {
      showMsg('error', 'Fill in Jira credentials first.'); return;
    }
    setShowProjectModal(true); setJiraProjectsLoading(true); setJiraProjects([]);
    try {
      const projects = await _makeJira().getProjects();
      setJiraProjects(projects);
    } catch (e) {
      showMsg('error', `Could not load spaces: ${e.message}`);
      setShowProjectModal(false);
    } finally { setJiraProjectsLoading(false); }
  }

  function selectProject(project) {
    setShowProjectModal(false);
    updateMany({ jiraProjectKey: project.key, jiraProjectName: project.name,
      jiraCustomFieldId: '', jiraCustomFieldName: '', jiraStatusNames: '',
      jiraSortFieldId: '', jiraSortFieldName: '', jiraSortOrder: '',
      jiraExcludeFieldIds: '', jiraExcludeValues: '' });
    setJiraCustomFields([]); setJiraFilterValues([]); setJiraSelectedStatusValues([]);
    setJiraSortValues([]); setJiraExcludeFieldIds([]); setJiraExcludeAvailValues({}); setJiraExcludeSelValues({});
    _loadJiraFieldsWith(config.jiraBaseUrl, config.jiraEmail, config.jiraApiToken, project.key, null, [], null, [], [], {});
  }

  function clearProject() {
    updateMany({ jiraProjectKey: '', jiraProjectName: '',
      jiraCustomFieldId: '', jiraCustomFieldName: '', jiraStatusNames: '',
      jiraSortFieldId: '', jiraSortFieldName: '', jiraSortOrder: '',
      jiraExcludeFieldIds: '', jiraExcludeValues: '' });
    setJiraCustomFields([]); setJiraFilterValues([]); setJiraSelectedStatusValues([]);
    setJiraSortValues([]); setJiraExcludeFieldIds([]); setJiraExcludeAvailValues({}); setJiraExcludeSelValues({});
  }

  // Step 2
  async function _loadJiraFieldsWith(baseUrl, email, apiToken, projectKey, selectedFieldId, selectedValues, selectedSortFieldId, savedSortOrder, selectedExcludeIds, savedExcludeVals) {
    setJiraFieldsLoading(true);
    try {
      const jira   = _makeJira(baseUrl, email, apiToken);
      const fields = await jira.getProjectCustomFields(projectKey);
      setJiraCustomFields(fields);
      if (selectedFieldId) _loadFilterValuesWith(baseUrl, email, apiToken, selectedFieldId, projectKey, selectedValues);
      if (selectedSortFieldId) _loadSortValuesWith(baseUrl, email, apiToken, selectedSortFieldId, projectKey, savedSortOrder);
      for (const fid of (selectedExcludeIds || [])) {
        _loadExcludeValuesWith(baseUrl, email, apiToken, fid, projectKey, (savedExcludeVals || {})[fid] || []);
      }
    } catch (e) {
      showMsg('error', `Could not load Jira fields: ${e.message}`);
    } finally { setJiraFieldsLoading(false); }
  }

  function selectFilterField(field) {
    update('jiraCustomFieldId', field.id); update('jiraCustomFieldName', field.name);
    update('jiraStatusNames', ''); setJiraSelectedStatusValues([]); setJiraFilterValues([]);
    _loadFilterValuesWith(config.jiraBaseUrl, config.jiraEmail, config.jiraApiToken, field.id, config.jiraProjectKey, []);
  }

  // Step 3
  async function _loadFilterValuesWith(baseUrl, email, apiToken, fieldId, projectKey, savedValues) {
    setJiraFilterValuesLoading(true);
    try {
      const values = await _makeJira(baseUrl, email, apiToken).getFieldValues(fieldId, projectKey);
      setJiraFilterValues(values);
      if (savedValues.length) setJiraSelectedStatusValues(savedValues);
    } catch (e) { showMsg('error', `Could not load field values: ${e.message}`); }
    finally { setJiraFilterValuesLoading(false); }
  }

  function toggleStatusValue(value) {
    setJiraSelectedStatusValues(prev => {
      const next = prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value];
      update('jiraStatusNames', JSON.stringify(next));
      return next;
    });
  }

  // Step 4
  function selectSortField(field) {
    if (config.jiraSortFieldId === field.id) {
      updateMany({ jiraSortFieldId: '', jiraSortFieldName: '', jiraSortOrder: '' });
      setJiraSortValues([]); return;
    }
    updateMany({ jiraSortFieldId: field.id, jiraSortFieldName: field.name, jiraSortOrder: '' });
    setJiraSortValues([]);
    _loadSortValuesWith(config.jiraBaseUrl, config.jiraEmail, config.jiraApiToken, field.id, config.jiraProjectKey, []);
  }

  async function _loadSortValuesWith(baseUrl, email, apiToken, fieldId, projectKey, savedOrder) {
    setJiraSortValuesLoading(true);
    try {
      const values  = await _makeJira(baseUrl, email, apiToken).getFieldValues(fieldId, projectKey);
      const ordered = savedOrder.length
        ? [...savedOrder.filter(v => values.includes(v)), ...values.filter(v => !savedOrder.includes(v))]
        : values;
      setJiraSortValues(ordered);
      update('jiraSortOrder', JSON.stringify(ordered));
    } catch (e) { showMsg('error', `Could not load sort values: ${e.message}`); }
    finally { setJiraSortValuesLoading(false); }
  }

  function handleSortReorder(newOrder) {
    setJiraSortValues(newOrder);
    update('jiraSortOrder', JSON.stringify(newOrder));
  }

  // Step 5
  function toggleExcludeField(field) {
    setJiraExcludeFieldIds(prev => {
      if (prev.includes(field.id)) {
        const next = prev.filter(id => id !== field.id);
        setJiraExcludeAvailValues(av => { const n = { ...av }; delete n[field.id]; return n; });
        setJiraExcludeSelValues(sv => { const n = { ...sv }; delete n[field.id]; update('jiraExcludeValues', JSON.stringify(n)); return n; });
        update('jiraExcludeFieldIds', JSON.stringify(next));
        return next;
      } else {
        const next = [...prev, field.id];
        update('jiraExcludeFieldIds', JSON.stringify(next));
        _loadExcludeValuesWith(config.jiraBaseUrl, config.jiraEmail, config.jiraApiToken, field.id, config.jiraProjectKey, []);
        return next;
      }
    });
  }

  async function _loadExcludeValuesWith(baseUrl, email, apiToken, fieldId, projectKey, savedValues) {
    setJiraExcludeValuesLoading(prev => ({ ...prev, [fieldId]: true }));
    try {
      const values = await _makeJira(baseUrl, email, apiToken).getFieldValues(fieldId, projectKey);
      setJiraExcludeAvailValues(prev => ({ ...prev, [fieldId]: values }));
      if (savedValues.length) {
        setJiraExcludeSelValues(prev => { const n = { ...prev, [fieldId]: savedValues }; update('jiraExcludeValues', JSON.stringify(n)); return n; });
      }
    } catch (e) { showMsg('error', `Could not load exclude values: ${e.message}`); }
    finally { setJiraExcludeValuesLoading(prev => ({ ...prev, [fieldId]: false })); }
  }

  function toggleExcludeValue(fieldId, value) {
    setJiraExcludeSelValues(prev => {
      const current = prev[fieldId] || [];
      const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
      const updated = { ...prev, [fieldId]: next };
      update('jiraExcludeValues', JSON.stringify(updated));
      return updated;
    });
  }

  // Save / Sync
  async function saveSettings() {
    setSaving(true);
    try {
      // Only write non-empty values so we never wipe valid stored/Firestore data
      // with the empty string defaults that exist in the initial config state
      const toSave = {};
      for (const [k, v] of Object.entries(config)) {
        if (v === null || v === undefined || v === '') continue;
        toSave[k] = v;
      }
      await store.setAll(toSave);
      await pushConfig(toSave); // must await so _configPushedAt is written before pullConfig runs
      await loadFromCache();
      showMsg('success', 'Settings saved!');
    } catch (e) { showMsg('error', `Save failed: ${e.message}`); }
    finally { setSaving(false); }
  }

  async function connectGoogle() {
    const clientId = (config.googleClientId || '').trim();
    if (!clientId) {
      showMsg('error', 'Google Client ID not synced yet. Open Settings and sync from the extension first.');
      return;
    }
    setConnectingGoogle(true);
    // Opens browser via Expo proxy; result handled in useEffect above
    await googlePromptAsync({ useProxy: true });
  }

  async function _exchangeGoogleCode(code, codeVerifier) {
    try {
      const clientId = (config.googleClientId || '').trim();
      const parts = [
        `code=${encodeURIComponent(code)}`,
        `client_id=${encodeURIComponent(clientId)}`,
        `redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}`,
        'grant_type=authorization_code',
      ];
      if (codeVerifier) parts.push(`code_verifier=${encodeURIComponent(codeVerifier)}`);
      const tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: parts.join('&'),
      });
      const tokenData = await tokenRes.json();
      if (tokenData.access_token) {
        await cacheGoogleToken(tokenData.access_token, tokenData.expires_in || 3600);
        setGoogleConnected(true);
        showMsg('success', 'Google Calendar connected!');
      } else {
        showMsg('error', `Token error: ${tokenData.error_description || tokenData.error}`);
      }
    } catch (e) {
      showMsg('error', `Token exchange error: ${e.message}`);
    } finally {
      setConnectingGoogle(false);
    }
  }

  async function testJira() {
    if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraApiToken) { showMsg('error', 'Fill in Jira credentials first.'); return; }
    setTestingJira(true);
    try { const user = await _makeJira().getCurrentUser(); showMsg('success', `Jira OK — ${user.displayName}`); }
    catch (e) { showMsg('error', `Jira error: ${e.message}`); }
    finally { setTestingJira(false); }
  }

  async function testSlack() {
    if (!config.slackToken) { showMsg('error', 'Enter your Slack token first.'); return; }
    setTestingSlack(true);
    try { const { SlackAPI } = await import('../api/slack'); const info = await new SlackAPI({ token: config.slackToken }).getWorkspaceInfo(); showMsg('success', `Slack OK — ${info?.team || 'connected'}`); }
    catch (e) { showMsg('error', `Slack error: ${e.message}`); }
    finally { setTestingSlack(false); }
  }

  async function disconnectGoogle() {
    Alert.alert('Disconnect Google', 'Remove Google Calendar connection?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: async () => { await revokeGoogleToken(); setGoogleConnected(false); showMsg('success', 'Google Calendar disconnected.'); } },
    ]);
  }

  async function handleSyncNow() { await saveSettings(); await triggerSync(); }

  function showMsg(type, text) { setSaveMsg({ type, text }); setTimeout(() => setSaveMsg(null), 4000); }

  async function importFromChrome() {
    const email = importEmail.trim().toLowerCase();
    if (!email) { showMsg('error', 'Enter your Jira email first.'); return; }
    const docId = docIdFromEmail(email);
    if (!docId) { showMsg('error', 'Invalid email.'); return; }
    setImporting(true);
    try {
      await store.set('jiraEmail', email);
      const remote = await pullConfig();
      if (!remote || Object.keys(remote).length === 0) { showMsg('error', 'No config found for that email.'); setImporting(false); return; }
      await pullCache();
      setShowImportModal(false); setImportEmail('');
      await loadInitial();
      showMsg('success', 'Settings imported! Scroll down and tap Connect Google to re-link your calendar.');
    } catch (e) { showMsg('error', `Import failed: ${e.message}`); }
    finally { setImporting(false); }
  }

  const str = (key) => {
    const v = config[key];
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'boolean') return String(v);
    return JSON.stringify(v); // arrays/objects → JSON string
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

      {saveMsg && (
        <View style={[s.banner, saveMsg.type === 'error' ? s.bannerError : s.bannerSuccess]}>
          <Text style={s.bannerText}>{saveMsg.text}</Text>
        </View>
      )}

      <TouchableOpacity style={s.importBtn} onPress={() => setShowImportModal(true)}>
        <Ionicons name="cloud-download-outline" size={17} color={C.accent} />
        <Text style={s.importBtnText}>Import Settings from Chrome Extension</Text>
      </TouchableOpacity>

      {/* ── Jira ── */}
      <Section id="jira" title="Jira">
        <Field label="Base URL" colors={C}>
          <TextInput style={s.input} value={str('jiraBaseUrl')} onChangeText={v => update('jiraBaseUrl', v)}
            placeholder="https://yourcompany.atlassian.net" placeholderTextColor={C.muted}
            autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        </Field>
        <Field label="Email" colors={C}>
          <TextInput style={s.input} value={str('jiraEmail')} onChangeText={v => update('jiraEmail', v)}
            placeholder="you@company.com" placeholderTextColor={C.muted}
            autoCapitalize="none" keyboardType="email-address" />
        </Field>
        <Field label="API Token" hint="Create at id.atlassian.com → Security → API tokens" colors={C}>
          <TextInput style={s.input} value={str('jiraApiToken')} onChangeText={v => update('jiraApiToken', v)}
            placeholder="Your Jira API token" placeholderTextColor={C.muted}
            secureTextEntry autoCapitalize="none" />
        </Field>

        <TouchableOpacity style={[s.testBtn, testingJira && s.testBtnDisabled]} onPress={testJira} disabled={testingJira}>
          {testingJira ? <ActivityIndicator size="small" color={C.accent} /> : <Ionicons name="flash-outline" size={14} color={C.accent} />}
          <Text style={s.testBtnText}>Test Connection</Text>
        </TouchableOpacity>

        <Divider C={C} />

        {/* Step 1 */}
        <StepHeader num="1" title="Choose a Space" C={C} />
        <View style={s.spaceRow}>
          <Text style={[s.spaceLabel, !config.jiraProjectKey && s.spaceLabelMuted]}>
            {config.jiraProjectKey ? `${config.jiraProjectName} (${config.jiraProjectKey})` : 'No space selected'}
          </Text>
          <View style={s.spaceButtons}>
            <TouchableOpacity style={s.stepBtn} onPress={pickProject}>
              <Text style={s.stepBtnText}>Browse Spaces</Text>
            </TouchableOpacity>
            {!!config.jiraProjectKey && (
              <TouchableOpacity style={[s.stepBtn, s.stepBtnDanger]} onPress={clearProject}>
                <Text style={s.stepBtnTextDanger}>Clear</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Step 2 */}
        {!!config.jiraProjectKey && (
          <>
            <Divider C={C} />
            <StepHeader num="2" title="Choose a Field to Filter By" C={C} />
            {jiraFieldsLoading ? <LoadingRow text="Loading fields…" C={C} /> :
              jiraCustomFields.length === 0 ? <HintText C={C}>No option-type custom fields found.</HintText> :
              <ChipGroup items={jiraCustomFields} selectedId={config.jiraCustomFieldId}
                onSelect={selectFilterField} getKey={f => f.id} getLabel={f => f.name} C={C} />}
          </>
        )}

        {/* Step 3 */}
        {!!config.jiraCustomFieldId && (
          <>
            <Divider C={C} />
            <StepHeader num="3" title="Choose Values to Sync" C={C} />
            {jiraFilterValuesLoading ? <LoadingRow text="Loading values…" C={C} /> :
              jiraFilterValues.length === 0 ? <HintText C={C}>No values found for this field.</HintText> :
              jiraFilterValues.map(value => (
                <CheckRow key={value} label={value} checked={jiraSelectedStatusValues.includes(value)} onToggle={() => toggleStatusValue(value)} C={C} />
              ))}
          </>
        )}

        {/* Step 4 */}
        {!!config.jiraCustomFieldId && jiraCustomFields.length > 0 && (
          <>
            <Divider C={C} />
            <StepHeader num="4" title="Sort Issues By Field (optional)" C={C} />
            <ChipGroup items={jiraCustomFields} selectedId={config.jiraSortFieldId}
              onSelect={selectSortField} getKey={f => f.id} getLabel={f => f.name} deselectable C={C} />
            {!!config.jiraSortFieldId && (
              jiraSortValuesLoading ? <LoadingRow text="Loading sort values…" C={C} /> :
              <DraggableSortList items={jiraSortValues} onReorder={handleSortReorder} colors={C} />
            )}
          </>
        )}

        {/* Step 5 */}
        {!!config.jiraCustomFieldId && jiraCustomFields.length > 0 && (
          <>
            <Divider C={C} />
            <StepHeader num="5" title="Exclude Issues By Field Value (optional)" C={C} />
            <ChipGroup items={jiraCustomFields} selectedIds={jiraExcludeFieldIds}
              onToggle={toggleExcludeField} getKey={f => f.id} getLabel={f => f.name} multiSelect C={C} />
            {jiraExcludeFieldIds.map(fieldId => {
              const fieldName = jiraCustomFields.find(f => f.id === fieldId)?.name || fieldId;
              const avail = jiraExcludeAvailValues[fieldId] || [];
              const sel   = jiraExcludeSelValues[fieldId] || [];
              const loading = jiraExcludeValuesLoading[fieldId];
              return (
                <View key={fieldId} style={s.excludeSection}>
                  <Text style={s.excludeSectionTitle}>{fieldName}</Text>
                  {loading ? <LoadingRow text="Loading…" C={C} /> :
                    avail.length === 0 ? <HintText C={C}>No values found.</HintText> :
                    avail.map(value => (
                      <CheckRow key={value} label={value} checked={sel.includes(value)} onToggle={() => toggleExcludeValue(fieldId, value)} C={C} />
                    ))}
                </View>
              );
            })}
          </>
        )}
      </Section>

      {/* ── Slack ── */}
      <Section id="slack" title="Slack">
        <Field label="Bot/User Token" hint="Starts with xoxb- or xoxp-" colors={C}>
          <TextInput style={s.input} value={str('slackToken')} onChangeText={v => update('slackToken', v)}
            placeholder="xoxb-…" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" />
        </Field>
        <Field label="My Slack User ID" hint="Your Slack user ID for mention detection" colors={C}>
          <TextInput style={s.input} value={str('slackMyUserId')} onChangeText={v => update('slackMyUserId', v)}
            placeholder="U01234ABC" placeholderTextColor={C.muted} autoCapitalize="none" />
        </Field>
        <Field label="VIP User IDs (comma-separated)" hint="Messages from these users are always high priority" colors={C}>
          <TextInput style={s.input} value={str('slackVipUsers')} onChangeText={v => update('slackVipUsers', v)}
            placeholder="U01234, U05678" placeholderTextColor={C.muted} autoCapitalize="none" />
        </Field>
        <TouchableOpacity style={[s.testBtn, testingSlack && s.testBtnDisabled]} onPress={testSlack} disabled={testingSlack}>
          {testingSlack ? <ActivityIndicator size="small" color={C.accent} /> : <Ionicons name="flash-outline" size={14} color={C.accent} />}
          <Text style={s.testBtnText}>Test Slack Connection</Text>
        </TouchableOpacity>

        {/* AI Rate Limit (from extension via Firestore) */}
        <View style={{ marginTop: 12, padding: 10, backgroundColor: C.surface, borderRadius: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: C.muted, marginBottom: 6 }}>AI API Usage (Groq — synced from extension)</Text>
          {aiRateLimit ? (
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ fontSize: 13, color: C.text }}>Requests</Text>
                <Text style={{ fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'], color: C.text }}>
                  {aiRateLimit.remainingRequests || '—'} / {aiRateLimit.limitRequests || '—'}
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ fontSize: 13, color: C.text }}>Tokens</Text>
                <Text style={{ fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'], color: C.text }}>
                  {aiRateLimit.remainingTokens || '—'} / {aiRateLimit.limitTokens || '—'}
                </Text>
              </View>
              {aiRateLimit.resetRequests ? (
                <Text style={{ fontSize: 10, color: C.muted }}>Resets in {aiRateLimit.resetRequests}</Text>
              ) : null}
              {aiRateLimit.updatedAt ? (
                <Text style={{ fontSize: 10, color: C.muted }}>Last checked: {formatAiTime(aiRateLimit.updatedAt)}</Text>
              ) : null}
            </View>
          ) : (
            <Text style={{ fontSize: 12, color: C.muted }}>No data yet — sync from extension first</Text>
          )}
        </View>
      </Section>

      {/* ── Google Calendar ── */}
      <Section id="gcal" title="Google Calendar">
        <Field label="Default Calendar ID" colors={C}>
          <TextInput style={s.input} value={str('defaultCalendarId')} onChangeText={v => update('defaultCalendarId', v)}
            placeholder="primary" placeholderTextColor={C.muted} autoCapitalize="none" />
        </Field>
        {googleConnected ? (
          <View style={s.connectedRow}>
            <View style={s.connectedBadge}>
              <Ionicons name="checkmark-circle" size={15} color={C.success} />
              <Text style={s.connectedText}>Connected via Extension</Text>
            </View>
            <TouchableOpacity onPress={disconnectGoogle}>
              <Text style={s.disconnectText}>Disconnect</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={s.gcalNotConnected}>
            <Ionicons name="warning-outline" size={20} color={C.danger} />
            <Text style={[s.gcalInfoText, { color: C.text }]}>
              <Text style={{ fontWeight: '700' }}>Not connected.{'\n'}</Text>
              In your Dia extension → Options → Google Calendar section → tap <Text style={{ fontWeight: '600' }}>"Authorize Google Calendar"</Text>.{'\n\n'}
              Then come back and tap ↻ to sync.
            </Text>
          </View>
        )}
      </Section>

      {/* ── Working Hours ── */}
      <Section id="hours" title="Working Hours">
        {[['Mon','Monday'],['Tue','Tuesday'],['Wed','Wednesday'],['Thu','Thursday'],['Fri','Friday']].map(([key, label]) => (
          <View key={key} style={s.dayRow}>
            <Text style={s.dayLabel}>{label}</Text>
            <View style={s.dayTimes}>
              <TextInput style={s.timeInput} value={str(`work${key}Start`) || '09:00'} onChangeText={v => update(`work${key}Start`, v)} placeholder="09:00" placeholderTextColor={C.muted} />
              <Text style={s.timeSep}>–</Text>
              <TextInput style={s.timeInput} value={str(`work${key}End`) || '18:00'} onChangeText={v => update(`work${key}End`, v)} placeholder="18:00" placeholderTextColor={C.muted} />
            </View>
          </View>
        ))}
      </Section>

      {/* ── Daily Report ── */}
      <Section id="report" title="Daily Slack Report" defaultOpen={false}>
        <View style={s.switchRow}>
          <Text style={s.switchLabel}>Enable daily report</Text>
          <Switch value={!!config.reportEnabled} onValueChange={v => update('reportEnabled', v)}
            trackColor={{ true: C.accent, false: C.muted }} thumbColor="#fff" />
        </View>
        {!!config.reportEnabled && (
          <>
            <Field label="Report Time" colors={C}>
              <TextInput style={s.input} value={str('reportTime')} onChangeText={v => update('reportTime', v)} placeholder="09:00" placeholderTextColor={C.muted} />
            </Field>
            <Field label="Slack Channel ID" colors={C}>
              <TextInput style={s.input} value={str('reportChannelId')} onChangeText={v => update('reportChannelId', v)} placeholder="C01234ABC" placeholderTextColor={C.muted} autoCapitalize="none" />
            </Field>
            <Field label="Bot Name" colors={C}>
              <TextInput style={s.input} value={str('reportBotName')} onChangeText={v => update('reportBotName', v)} placeholder="WorkSync Bot" placeholderTextColor={C.muted} />
            </Field>
          </>
        )}
      </Section>

      {/* ── Notifications ── */}
      <Section id="notif" title="Notifications &amp; Sync" defaultOpen={false}>
        <View style={s.switchRow}>
          <Text style={s.switchLabel}>Push notifications</Text>
          <Switch
            value={config.enableNotifications !== false && config.enableNotifications !== 'false'}
            onValueChange={v => update('enableNotifications', v)}
            trackColor={{ true: C.accent, false: C.muted }} thumbColor="#fff" />
        </View>
        <Field label="Sync interval (minutes)" colors={C}>
          <TextInput style={s.input} value={str('syncInterval') || '30'} onChangeText={v => update('syncInterval', v)}
            placeholder="30" placeholderTextColor={C.muted} keyboardType="number-pad" />
        </Field>
        <Field label="🔒 Sync Secret" hint="Same value on extension + app. Never uploaded to cloud." colors={C}>
          <TextInput
            style={s.input}
            value={str('syncSecret')}
            onChangeText={v => update('syncSecret', v)}
            placeholder="Enter a secret passphrase"
            placeholderTextColor={C.muted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
      </Section>

      {/* ── Actions ── */}
      <View style={s.actions}>
        <TouchableOpacity style={[s.saveBtn, saving && s.saveBtnDisabled]} onPress={saveSettings} disabled={saving}>
          {saving ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="save-outline" size={17} color="#fff" />}
          <Text style={s.saveBtnText}>{saving ? 'Saving…' : 'Save Settings'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.syncBtn, syncing && s.saveBtnDisabled]} onPress={handleSyncNow} disabled={syncing}>
          {syncing ? <ActivityIndicator size="small" color={C.accent} /> : <Ionicons name="refresh" size={17} color={C.accent} />}
          <Text style={s.syncBtnText}>{syncing ? 'Syncing…' : 'Save & Sync Now'}</Text>
        </TouchableOpacity>
      </View>

      <View style={{ height: 40 }} />

      {/* Import modal */}
      <Modal visible={showImportModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowImportModal(false)}>
        <View style={s.modalContainer}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Import from Chrome Extension</Text>
            <TouchableOpacity onPress={() => setShowImportModal(false)}>
              <Ionicons name="close" size={22} color={C.text} />
            </TouchableOpacity>
          </View>
          <View style={{ padding: 22, gap: 14 }}>
            <Text style={{ color: C.subtext, fontSize: 13, lineHeight: 19 }}>
              Enter the same Jira email you used in the Chrome extension. Your settings will be pulled from the cloud.
            </Text>
            <TextInput style={[s.input, { fontSize: 15, padding: 13 }]}
              value={importEmail} onChangeText={setImportEmail}
              placeholder="you@company.com" placeholderTextColor={C.muted}
              autoCapitalize="none" keyboardType="email-address" autoFocus />
            <TouchableOpacity style={[s.saveBtn, importing && s.saveBtnDisabled]} onPress={importFromChrome} disabled={importing}>
              {importing ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="cloud-download-outline" size={17} color="#fff" />}
              <Text style={s.saveBtnText}>{importing ? 'Importing…' : 'Import Settings'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Project picker modal */}
      <Modal visible={showProjectModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowProjectModal(false)}>
        <View style={s.modalContainer}>
          <View style={s.modalHeader}>
            <Text style={s.modalTitle}>Choose a Space</Text>
            <TouchableOpacity onPress={() => setShowProjectModal(false)}>
              <Ionicons name="close" size={22} color={C.text} />
            </TouchableOpacity>
          </View>
          {jiraProjectsLoading ? (
            <View style={s.modalCenter}>
              <ActivityIndicator size="large" color={C.accent} />
              <Text style={s.modalLoadingText}>Fetching spaces…</Text>
            </View>
          ) : jiraProjects.length === 0 ? (
            <View style={s.modalCenter}><Text style={s.modalEmptyText}>No spaces found.</Text></View>
          ) : (
            <FlatList
              data={jiraProjects}
              keyExtractor={p => p.key}
              renderItem={({ item }) => (
                <TouchableOpacity style={[s.projectItem, item.key === config.jiraProjectKey && s.projectItemSelected]} onPress={() => selectProject(item)}>
                  <View style={s.projectKey}>
                    <Text style={s.projectKeyText}>{item.key}</Text>
                  </View>
                  <Text style={s.projectName}>{item.name}</Text>
                  {item.key === config.jiraProjectKey && <Ionicons name="checkmark" size={17} color={C.accent} />}
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </Modal>

    </ScrollView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({ label, hint, children, colors: C }) {
  return (
    <View style={{ paddingVertical: 9 }}>
      <Text style={{ color: C.subtext, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{label}</Text>
      {children}
      {hint ? <Text style={{ color: C.muted, fontSize: 11, marginTop: 4 }}>{hint}</Text> : null}
    </View>
  );
}

function StepHeader({ num, title, C }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9, paddingTop: 11, paddingBottom: 7 }}>
      <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{num}</Text>
      </View>
      <Text style={{ color: C.text, fontSize: 13, fontWeight: '600', flex: 1 }}>{title}</Text>
    </View>
  );
}

function Divider({ C }) {
  return <View style={{ height: 1, backgroundColor: C.border, marginVertical: 3 }} />;
}

function LoadingRow({ text, C }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9 }}>
      <ActivityIndicator size="small" color={C.accent} />
      <Text style={{ color: C.muted, fontSize: 12 }}>{text}</Text>
    </View>
  );
}

function HintText({ children, C }) {
  return <Text style={{ color: C.muted, fontSize: 12, paddingVertical: 7 }}>{children}</Text>;
}

function ChipGroup({ items, selectedId, selectedIds, onSelect, onToggle, getKey, getLabel, multiSelect = false, deselectable = false, C }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingVertical: 7 }}>
      {items.map(item => {
        const key = getKey(item);
        const isSelected = multiSelect ? (selectedIds || []).includes(key) : selectedId === key;
        return (
          <TouchableOpacity
            key={key}
            style={[chipSt.chip, { borderColor: isSelected ? C.accent : C.border, backgroundColor: isSelected ? C.accentDim : C.surfaceElevated }]}
            onPress={() => multiSelect ? onToggle(item) : onSelect(item)}
          >
            <Text style={[chipSt.chipText, { color: isSelected ? C.accent : C.text }, isSelected && { fontWeight: '600' }]}>
              {getLabel(item)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
const chipSt = StyleSheet.create({
  chip:     { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 4, borderWidth: 1 },
  chipText: { fontSize: 12 },
});

function CheckRow({ label, checked, onToggle, C }) {
  return (
    <TouchableOpacity
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.border }}
      onPress={onToggle}
    >
      <View style={[checkSt.box, { borderColor: checked ? C.accent : C.border }, checked && { backgroundColor: C.accent }]}>
        {checked && <Ionicons name="checkmark" size={12} color="#fff" />}
      </View>
      <Text style={{ color: C.text, fontSize: 13, flex: 1 }}>{label}</Text>
    </TouchableOpacity>
  );
}
const checkSt = StyleSheet.create({
  box: { width: 19, height: 19, borderRadius: 4, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
});

// ── Section styles (dynamic) ──────────────────────────────────────────────────
const makeSectionStyles = (C) => StyleSheet.create({
  section: { marginTop: 20 },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 10,
    backgroundColor: C.surface,
    borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.border,
  },
  sectionTitle: { color: C.subtext, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  sectionBody:  { backgroundColor: C.surface, paddingHorizontal: 16, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.border },
});

// ── Main styles ───────────────────────────────────────────────────────────────
const makeStyles = (C) => StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content:   { paddingTop: 8, paddingBottom: 40 },
  banner:    { margin: 14, padding: 11, borderRadius: 6 },
  bannerSuccess: { backgroundColor: C.successDim },
  bannerError:   { backgroundColor: C.dangerDim },
  bannerText:    { color: C.text, fontSize: 13 },
  input: { backgroundColor: C.surfaceElevated, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 10, color: C.text, fontSize: 13 },
  importBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, margin: 14, padding: 13, borderRadius: 8, borderWidth: 1.5, borderColor: C.accent, borderStyle: 'dashed' },
  importBtnText: { color: C.accent, fontSize: 13, fontWeight: '600' },
  testBtn:        { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, marginVertical: 3 },
  testBtnDisabled:{ opacity: 0.5 },
  testBtnText:    { color: C.accent, fontSize: 13, fontWeight: '500' },
  spaceRow:       { paddingVertical: 9, gap: 7 },
  spaceLabel:     { color: C.text, fontSize: 13, fontWeight: '500' },
  spaceLabelMuted:{ color: C.muted },
  spaceButtons:   { flexDirection: 'row', gap: 7, marginTop: 5 },
  stepBtn:        { paddingHorizontal: 13, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: C.accent },
  stepBtnText:    { color: C.accent, fontSize: 12, fontWeight: '500' },
  stepBtnDanger:  { borderColor: C.danger },
  stepBtnTextDanger: { color: C.danger, fontSize: 12 },
  excludeSection: { marginTop: 9, borderRadius: 6, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  excludeSectionTitle: { color: C.subtext, fontSize: 11, fontWeight: '600', paddingHorizontal: 11, paddingVertical: 7, backgroundColor: C.bg, borderBottomWidth: 1, borderBottomColor: C.border },
  connectedRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9 },
  connectedBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  connectedText:  { color: C.success, fontSize: 13, fontWeight: '500' },
  disconnectText: { color: C.danger, fontSize: 13 },
  gcalNotConnected: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10 },
  gcalInfoText:   { color: C.muted, fontSize: 12, lineHeight: 18, flex: 1 },
  dayRow:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.border },
  dayLabel:       { color: C.text, fontSize: 13, width: 84 },
  dayTimes:       { flexDirection: 'row', alignItems: 'center', gap: 7 },
  timeInput:      { backgroundColor: C.surfaceElevated, borderWidth: 1, borderColor: C.border, borderRadius: 5, paddingHorizontal: 9, paddingVertical: 5, color: C.text, fontSize: 12, width: 68, textAlign: 'center' },
  timeSep:        { color: C.subtext },
  switchRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9 },
  switchLabel:    { color: C.text, fontSize: 13 },
  actions:        { marginTop: 20, paddingHorizontal: 14, gap: 10 },
  saveBtn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: C.accent, padding: 13, borderRadius: 8 },
  saveBtnDisabled:{ opacity: 0.5 },
  saveBtnText:    { color: '#fff', fontWeight: '700', fontSize: 15 },
  syncBtn:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1, borderColor: C.accent, padding: 13, borderRadius: 8 },
  syncBtnText:    { color: C.accent, fontWeight: '600', fontSize: 15 },
  modalContainer: { flex: 1, backgroundColor: C.bg },
  modalHeader:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  modalTitle:     { color: C.text, fontSize: 17, fontWeight: '700' },
  modalCenter:    { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 11 },
  modalLoadingText:{ color: C.muted, fontSize: 13 },
  modalEmptyText: { color: C.muted, fontSize: 13 },
  projectItem:    { flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.border },
  projectItemSelected: { backgroundColor: C.surface },
  projectKey:     { backgroundColor: C.accentDim, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4, minWidth: 46, alignItems: 'center' },
  projectKeyText: { color: C.accent, fontSize: 11, fontWeight: '700' },
  projectName:    { color: C.text, fontSize: 14, flex: 1 },
});
