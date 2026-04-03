import * as WebBrowser from 'expo-web-browser';
import { store } from '../storage/store';

WebBrowser.maybeCompleteAuthSession();

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export class CalendarAPI {
  constructor({ accessToken }) {
    this.accessToken = accessToken;
  }

  async fetch(path, options = {}) {
    const res = await fetch(`${CALENDAR_API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
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
    const data = await this.fetch(
      `/calendars/${encodeURIComponent(calendarId)}/events?${params}`
    );
    return data.items || [];
  }

  async createTaskEvent({
    title,
    description,
    startTime,
    endTime,
    calendarId = 'primary',
    color = '5',
    reminders = [10],
  }) {
    const start = new Date(startTime);
    const end = endTime ? new Date(endTime) : new Date(start.getTime() + 30 * 60 * 1000);

    const event = {
      summary: title,
      description: description || '',
      start: {
        dateTime: start.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
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

  findNextFreeSlot({
    busySlots,
    startAfter,
    durationMinutes = 20,
    workStart = 9,
    workEnd = 18,
    daysAhead = 10,
    workSchedule = null,
  }) {
    const durationMs = durationMinutes * 60 * 1000;
    let candidate = new Date(startAfter);

    const m = candidate.getMinutes();
    const rm = Math.ceil(m / 15) * 15;
    candidate.setMinutes(rm, 0, 0);

    const limit = new Date(candidate.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const getDayHours = dayIndex => {
      if (!workSchedule)
        return { enabled: dayIndex >= 1 && dayIndex <= 5, start: workStart, end: workEnd };
      return workSchedule[dayIndex] || { enabled: false, start: workStart, end: workEnd };
    };

    const advanceToNextDay = () => {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
    };

    while (candidate < limit) {
      const dayHours = getDayHours(candidate.getDay());

      if (!dayHours.enabled) {
        advanceToNextDay();
        continue;
      }

      if (
        candidate.getHours() < dayHours.start ||
        (candidate.getHours() === 0 && candidate.getMinutes() === 0)
      ) {
        candidate.setHours(dayHours.start, 0, 0, 0);
      }

      const dayEnd = new Date(candidate);
      dayEnd.setHours(dayHours.end, 0, 0, 0);

      if (candidate.getTime() + durationMs > dayEnd.getTime()) {
        advanceToNextDay();
        continue;
      }

      const slotEnd = new Date(candidate.getTime() + durationMs);
      const conflict = busySlots.find(b => b.start < slotEnd && b.end > candidate);

      if (!conflict) {
        return new Date(candidate);
      }

      candidate = new Date(conflict.end);
      const cm = candidate.getMinutes();
      const rounded = Math.ceil(cm / 15) * 15;
      candidate.setMinutes(rounded, 0, 0);
    }

    return null;
  }

  async findFreeSlot({
    durationMinutes = 20,
    workStart = 9,
    workEnd = 18,
    daysAhead = 10,
    calendarId = 'primary',
  } = {}) {
    const busySlots = await this.getBusySlots({ daysAhead, calendarId });
    const slot = this.findNextFreeSlot({
      busySlots,
      startAfter: new Date(),
      durationMinutes,
      workStart,
      workEnd,
      daysAhead,
    });
    return slot ? slot.toISOString() : null;
  }

  async deleteEvent(eventId, calendarId = 'primary') {
    try {
      await this.fetch(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        { method: 'DELETE' }
      );
    } catch (_) {
      // Ignore — event may already be deleted
    }
  }
}

// ── Google OAuth2 for React Native (Expo) ────────────────────────────────────

/**
 * Get the Google OAuth2 authorization URL params.
 * Call this from a component using expo-auth-session hooks.
 */
export function getGoogleAuthConfig(clientId) {
  return {
    clientId,
    scopes: GOOGLE_SCOPES,
    redirectUri: AuthSession.makeRedirectUri({ scheme: 'worksync' }),
  };
}

/**
 * Get a cached access token from storage, or null if expired/missing.
 */
export async function getCachedGoogleToken() {
  const token = await store.get('googleAccessToken');
  const expiry = await store.get('googleTokenExpiry');
  if (token && expiry && Date.now() < Number(expiry) - 60_000) {
    return token;
  }
  return null;
}

export async function cacheGoogleToken(token, expiresInSeconds = 3600) {
  await store.set('googleAccessToken', token);
  await store.set('googleTokenExpiry', String(Date.now() + expiresInSeconds * 1000));
}

export async function revokeGoogleToken() {
  await store.remove('googleAccessToken');
  await store.remove('googleTokenExpiry');
}

/**
 * Build a CalendarAPI instance from the stored token.
 * Throws if no valid token is cached.
 */
export async function getCalendarAPI() {
  const token = await getCachedGoogleToken();
  if (!token) throw new Error('Google Calendar not connected. Please connect in Settings.');
  return new CalendarAPI({ accessToken: token });
}
