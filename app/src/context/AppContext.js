import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { store, getConfig, isConfigured } from '../storage/store';
import { syncAll } from '../utils/sync';
import { pullConfig, pullCache, pullGoogleToken, pushCache } from '../api/firebase';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [jiraIssues, setJiraIssues] = useState([]);
  const [slackMessages, setSlackMessages] = useState([]);
  const [scheduledTasks, setScheduledTasks] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [jiraCustomFieldValues, setJiraCustomFieldValues] = useState([]);
  const [jiraCustomFieldId, setJiraCustomFieldId] = useState(null);
  const [jiraCustomFieldName, setJiraCustomFieldName] = useState(null);
  const [jiraBaseUrl, setJiraBaseUrl] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [jiraError, setJiraError] = useState(null);
  const [slackError, setSlackError] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  const loadFromCache = useCallback(async () => {
    // Read local store first
    const local = await store.getAll([
      'jiraIssues', 'slackMessages', 'lastSync',
      'jiraError', 'slackError', 'scheduledTasks', 'reminders',
      'jiraCustomFieldValues', 'jiraCustomFieldId', 'jiraCustomFieldName',
      'jiraBaseUrl',
    ]);

    // Pull config + cache from Firestore on every load (timestamp-gated — skips if not newer)
    await pullConfig();
    await pullGoogleToken();
    await pullCache();

    const data = await store.getAll([
      'jiraIssues', 'slackMessages', 'lastSync',
      'jiraError', 'slackError', 'scheduledTasks', 'reminders',
      'jiraCustomFieldValues', 'jiraCustomFieldId', 'jiraCustomFieldName',
      'jiraBaseUrl',
    ]);

    setJiraIssues(data.jiraIssues || []);
    setSlackMessages(data.slackMessages || []);
    setScheduledTasks(data.scheduledTasks || []);
    setReminders(data.reminders || []);
    setJiraCustomFieldValues(data.jiraCustomFieldValues || []);
    setJiraCustomFieldId(data.jiraCustomFieldId || null);
    setJiraCustomFieldName(data.jiraCustomFieldName || null);
    setJiraBaseUrl(data.jiraBaseUrl || null);
    setLastSync(data.lastSync || null);
    setJiraError(data.jiraError || null);
    setSlackError(data.slackError || null);

    const config = await getConfig();
    const cfg = isConfigured(config);
    setConfigured(cfg);
    setConfigLoaded(true);
  }, []);

  const triggerSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      // Pull latest from Firestore first (Slack data comes from extension via Firestore)
      await pullCache();
      const result = await syncAll();
      setJiraIssues(result.jiraIssues || []);
      setSlackMessages(result.slackMessages || []);
      setJiraError(result.jiraError || null);
      setLastSync(new Date().toISOString());
    } catch (e) {
      console.error('[AppContext] Sync error:', e);
    } finally {
      setSyncing(false);
    }
  }, [syncing]);

  const saveReminders = useCallback(async (updated) => {
    setReminders(updated);
    await store.set('reminders', updated);
    // Push to Firestore so reminders survive cache overwrites from the extension
    pushCache({ reminders: updated });
  }, []);

  const updateScheduledTasks = useCallback(async (updated) => {
    setScheduledTasks(updated);
    await store.set('scheduledTasks', updated);
  }, []);

  // ── Real-time Firestore sync ──────────────────────────────────────────────────
  // Pull fresh data from Firestore every 60 s while app is open,
  // and immediately whenever the app returns to the foreground.

  const _refreshFromFirestore = useCallback(async () => {
    try {
      await pullConfig();
      await pullGoogleToken();
      await pullCache();
      const data = await store.getAll([
        'jiraIssues', 'slackMessages', 'lastSync',
        'jiraError', 'slackError', 'scheduledTasks', 'reminders',
        'jiraCustomFieldValues', 'jiraCustomFieldId', 'jiraCustomFieldName',
        'jiraBaseUrl',
      ]);
      setJiraIssues(data.jiraIssues || []);
      setSlackMessages(data.slackMessages || []);
      setScheduledTasks(data.scheduledTasks || []);
      setReminders(data.reminders || []);
      setJiraCustomFieldValues(data.jiraCustomFieldValues || []);
      setJiraCustomFieldId(data.jiraCustomFieldId || null);
      setJiraCustomFieldName(data.jiraCustomFieldName || null);
      setJiraBaseUrl(data.jiraBaseUrl || null);
      setLastSync(data.lastSync || null);
      setJiraError(data.jiraError || null);
      setSlackError(data.slackError || null);
      const config = await getConfig();
      setConfigured(isConfigured(config));
    } catch (e) {
      console.warn('[AppContext] Firestore refresh error:', e.message);
    }
  }, []);

  const appStateRef = useRef(AppState.currentState);
  useEffect(() => {
    // Poll every 60 seconds
    const interval = setInterval(_refreshFromFirestore, 60 * 1000);

    // Also refresh when app returns to foreground
    const sub = AppState.addEventListener('change', nextState => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        _refreshFromFirestore();
      }
      appStateRef.current = nextState;
    });

    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [_refreshFromFirestore]);

  return (
    <AppContext.Provider
      value={{
        jiraIssues,
        slackMessages,
        scheduledTasks,
        reminders,
        jiraCustomFieldValues,
        jiraCustomFieldId,
        jiraCustomFieldName,
        jiraBaseUrl,
        lastSync,
        syncing,
        jiraError,
        slackError,
        configured,
        configLoaded,
        loadFromCache,
        triggerSync,
        saveReminders,
        updateScheduledTasks,
        setScheduledTasks,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
