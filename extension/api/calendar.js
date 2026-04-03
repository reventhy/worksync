const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks',
].join(' ');

export class CalendarAPI {
  constructor({ accessToken }) {
    this.accessToken = accessToken;
  }

  async fetch(path, options = {}) {
    const res = await fetch(`${CALENDAR_API}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Calendar API ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async listCalendars() {
    const data = await this.fetch('/users/me/calendarList');
    return data.items || [];
  }

  async listUpcomingEvents(calendarId = 'primary', days = 7) {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    });
    const data = await this.fetch(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
    return data.items || [];
  }

  async createTaskEvent({ title, description, startTime, endTime, calendarId = 'primary', color = '5', reminders = [10] }) {
    const start = new Date(startTime);
    const end = endTime ? new Date(endTime) : new Date(start.getTime() + 30 * 60 * 1000);

    const event = {
      summary: title,
      description: description || '',
      start: { dateTime: start.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      end: { dateTime: end.toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      colorId: color,
      reminders: {
        useDefault: false,
        overrides: reminders.map(m => ({ method: 'popup', minutes: m })),
      },
    };

    return this.fetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  /**
   * Fetch busy slots once for a date range — use this when scheduling multiple items
   * so you only make one freebusy API call.
   */
  async getBusySlots({ startFrom, daysAhead = 10, calendarId = 'primary' } = {}) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const from = startFrom ? new Date(startFrom) : new Date();
    const to = new Date(from.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const busyData = await this.fetch('/freeBusy', {
      method: 'POST',
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        timeZone: tz,
        items: [{ id: calendarId }],
      }),
    });

    return (busyData?.calendars?.[calendarId]?.busy || [])
      .map(b => ({ start: new Date(b.start), end: new Date(b.end) }))
      .sort((a, b) => a.start - b.start);
  }

  /**
   * Find the next free slot given a pre-fetched busy list.
   * startAfter: Date — search from this point forward (Mon–Fri, workStart–workEnd only).
   * Returns a Date for the slot start, or null if none found within daysAhead.
   */
  findNextFreeSlot({ busySlots, startAfter, durationMinutes = 20, workStart = 9, workEnd = 18, daysAhead = 10, workSchedule = null }) {
    const durationMs = durationMinutes * 60 * 1000;
    let candidate = new Date(startAfter);

    // Round up to next 15-min mark
    const m = candidate.getMinutes();
    const rm = Math.ceil(m / 15) * 15;
    candidate.setMinutes(rm, 0, 0);

    const limit = new Date(candidate.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    // Helper: get work hours for a given JS day index (0=Sun…6=Sat)
    const getDayHours = (dayIndex) => {
      if (!workSchedule) return { enabled: dayIndex >= 1 && dayIndex <= 5, start: workStart, end: workEnd };
      return workSchedule[dayIndex] || { enabled: false, start: workStart, end: workEnd };
    };

    // Helper: advance to start of next enabled day
    const advanceToNextDay = () => {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
    };

    while (candidate < limit) {
      const dayHours = getDayHours(candidate.getDay());

      // Skip disabled days
      if (!dayHours.enabled) {
        advanceToNextDay();
        continue;
      }

      // Enforce work start
      if (candidate.getHours() < dayHours.start || (candidate.getHours() === 0 && candidate.getMinutes() === 0)) {
        candidate.setHours(dayHours.start, 0, 0, 0);
      }

      const dayEnd = new Date(candidate);
      dayEnd.setHours(dayHours.end, 0, 0, 0);

      if (candidate.getTime() + durationMs > dayEnd.getTime()) {
        // No room today — try next day
        advanceToNextDay();
        continue;
      }

      const slotEnd = new Date(candidate.getTime() + durationMs);
      const conflict = busySlots.find(b => b.start < slotEnd && b.end > candidate);

      if (!conflict) {
        return new Date(candidate);
      }

      // Jump past this conflict, round up to 15-min
      candidate = new Date(conflict.end);
      const cm = candidate.getMinutes();
      const rounded = Math.ceil(cm / 15) * 15;
      candidate.setMinutes(rounded, 0, 0);
    }

    return null;
  }

  /**
   * Single-item convenience: find next free slot (fetches busy slots internally).
   */
  async findFreeSlot({ durationMinutes = 20, workStart = 9, workEnd = 18, daysAhead = 10, calendarId = 'primary' } = {}) {
    const busySlots = await this.getBusySlots({ daysAhead, calendarId });
    const slot = this.findNextFreeSlot({ busySlots, startAfter: new Date(), durationMinutes, workStart, workEnd, daysAhead });
    return slot ? slot.toISOString() : null;
  }

  async deleteEvent(eventId, calendarId = 'primary') {
    try {
      await this.fetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
        method: 'DELETE',
      });
    } catch (_) {
      // Ignore — event may already be deleted
    }
  }

  async createWorkSyncEvent({ items, scheduledTime, calendarId = 'primary' }) {
    const description = items.map(item => {
      if (item.type === 'jira') {
        return `[JIRA] ${item.key}: ${item.summary}\n→ ${item.url}`;
      } else if (item.type === 'slack') {
        return `[SLACK] #${item.channelName} (${item.importanceLabel}): ${item.text.slice(0, 120)}...`;
      }
      return item.title;
    }).join('\n\n');

    const title = `WorkSync Review (${items.length} item${items.length !== 1 ? 's' : ''})`;

    return this.createTaskEvent({
      title,
      description,
      startTime: scheduledTime,
      calendarId,
      color: '11',
      reminders: [10, 5],
    });
  }
}

/**
 * Get a cached Google access token, or null if expired/missing.
 */
async function getCachedToken() {
  const { googleAccessToken, googleTokenExpiry } = await new Promise(r =>
    chrome.storage.local.get(['googleAccessToken', 'googleTokenExpiry'], r)
  );
  if (googleAccessToken && googleTokenExpiry && Date.now() < googleTokenExpiry - 60_000) {
    return googleAccessToken;
  }
  return null;
}

async function cacheToken(token, expiresInSeconds = 3600) {
  const googleTokenExpiry = Date.now() + expiresInSeconds * 1000;
  await new Promise(r => chrome.storage.local.set({ googleAccessToken: token, googleTokenExpiry }, r));
  // Push token to Firestore so Android app can use it without its own OAuth
  try {
    const { firestorePatch, docIdFromEmail } = await import('../firebase.js');
    const { jiraEmail } = await new Promise(r => chrome.storage.local.get('jiraEmail', r));
    const docId = docIdFromEmail(jiraEmail);
    if (docId) {
      const ts = String(Date.now());
      await firestorePatch('worksync_config', docId, {
        googleAccessToken: token,
        googleTokenExpiry: String(googleTokenExpiry),
        _configPushedAt: ts,
      });
      // Update local timestamp too so our own next pullConfig doesn't overwrite the push
      await new Promise(r => chrome.storage.local.set({ _configPushedAt: ts }, r));
    }
  } catch (e) {
    console.warn('[WorkSync] Could not push Google token to Firestore:', e.message);
  }
}

/**
 * Silently refresh the Google token in the background and push to Firestore.
 * Called by an alarm every 50 min so the Android app always has a fresh token.
 * Does nothing if not previously authenticated.
 */
export async function silentlyRefreshGoogleToken() {
  const { googleClientId } = await new Promise(r => chrome.storage.local.get('googleClientId', r));
  if (!googleClientId) return;

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', googleClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', GOOGLE_SCOPES);
  // No prompt=consent — silent re-auth only

  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: false },
      async (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          // Silent refresh not possible (user not signed in) — ignore
          resolve(null);
          return;
        }
        const hash = new URL(responseUrl).hash.slice(1);
        const params = new URLSearchParams(hash);
        const token = params.get('access_token');
        const expiresIn = parseInt(params.get('expires_in') || '3600');
        if (token) {
          await cacheToken(token, expiresIn); // also pushes to Firestore
          console.log('[WorkSync] Google token silently refreshed and pushed to Firestore');
        }
        resolve(token || null);
      }
    );
  });
}

/**
 * Get a Google OAuth2 access token using launchWebAuthFlow.
 * Works in any Chromium-based browser (Chrome, Dia, Edge, Brave, etc.)
 */
export async function getGoogleAccessToken(interactive = false, overrideClientId = null) {
  // Return cached token if still valid
  const cached = await getCachedToken();
  if (cached) return cached;

  if (!interactive) throw new Error('No cached token — re-authorization required.');

  const { googleClientId: storedId } = await new Promise(r => chrome.storage.local.get('googleClientId', r));
  const googleClientId = overrideClientId || storedId;
  if (!googleClientId) throw new Error('Google Client ID not configured. Paste your Client ID into the field above and try again.');

  const redirectUri = chrome.identity.getRedirectURL();

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', googleClientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', GOOGLE_SCOPES);
  authUrl.searchParams.set('prompt', 'consent');

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      async (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message || 'Auth cancelled'));
          return;
        }
        // Token is in the URL fragment: #access_token=...&expires_in=...
        const hash = new URL(responseUrl).hash.slice(1);
        const params = new URLSearchParams(hash);
        const token = params.get('access_token');
        const expiresIn = parseInt(params.get('expires_in') || '3600');
        if (!token) {
          reject(new Error('No access token in response'));
          return;
        }
        await cacheToken(token, expiresIn);
        resolve(token);
      }
    );
  });
}

export async function revokeGoogleToken() {
  await new Promise(r => chrome.storage.local.remove(['googleAccessToken', 'googleTokenExpiry'], r));
}
