import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Typed key-value store backed by AsyncStorage.
 * Objects/arrays are automatically JSON serialized.
 */
export const store = {
  async get(key) {
    try {
      const val = await AsyncStorage.getItem(key);
      if (val === null) return null;
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    } catch {
      return null;
    }
  },

  async set(key, value) {
    try {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      await AsyncStorage.setItem(key, serialized);
    } catch (e) {
      console.warn('[store] set error:', e);
    }
  },

  async remove(key) {
    try {
      await AsyncStorage.removeItem(key);
    } catch (e) {
      console.warn('[store] remove error:', e);
    }
  },

  async getAll(keys) {
    try {
      const pairs = await AsyncStorage.multiGet(keys);
      const result = {};
      for (const [key, val] of pairs) {
        if (val === null) continue;
        try {
          result[key] = JSON.parse(val);
        } catch {
          result[key] = val;
        }
      }
      return result;
    } catch {
      return {};
    }
  },

  async setAll(obj) {
    try {
      const pairs = Object.entries(obj).map(([k, v]) => [
        k,
        typeof v === 'string' ? v : JSON.stringify(v),
      ]);
      await AsyncStorage.multiSet(pairs);
    } catch (e) {
      console.warn('[store] setAll error:', e);
    }
  },

  async clear() {
    try {
      await AsyncStorage.clear();
    } catch (e) {
      console.warn('[store] clear error:', e);
    }
  },
};

// ── Typed helpers ─────────────────────────────────────────────────────────────

export async function getConfig() {
  const keys = [
    'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
    'jiraProjectKey', 'jiraProjectName', 'jiraCustomFieldId', 'jiraCustomFieldName',
    'jiraStatusName', 'jiraStatusNames',
    'jiraSortFieldId', 'jiraSortFieldName', 'jiraSortOrder',
    'jiraExcludeFieldIds', 'jiraExcludeValues',
    'slackToken', 'slackMyUserId', 'slackVipUsers',
    'googleClientId', 'defaultCalendarId',
    'syncSecret', // local-only — never pushed to Firestore
    'workMon', 'workMonStart', 'workMonEnd',
    'workTue', 'workTueStart', 'workTueEnd',
    'workWed', 'workWedStart', 'workWedEnd',
    'workThu', 'workThuStart', 'workThuEnd',
    'workFri', 'workFriStart', 'workFriEnd',
    'workSat', 'workSatStart', 'workSatEnd',
    'workSun', 'workSunStart', 'workSunEnd',
    'geminiApiKey',
    'syncInterval', 'enableNotifications',
    'reportEnabled', 'reportTime', 'reportChannelId', 'reportBotName',
    'reportIncludeJira', 'reportIncludeSlack',
  ];
  return store.getAll(keys);
}

export function isConfigured(config) {
  return !!(config.jiraBaseUrl && config.jiraEmail && config.jiraApiToken && config.slackToken);
}
