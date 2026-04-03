const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

export class TasksAPI {
  constructor({ accessToken }) {
    this.accessToken = accessToken;
  }

  async fetch(path, options = {}) {
    const res = await fetch(`${TASKS_API}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Tasks API ${res.status}: ${text}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async getDefaultTaskList() {
    const data = await this.fetch('/users/@me/lists');
    return data.items?.[0]?.id || '@default';
  }

  async createTask({ tasklist = '@default', title, notes, due }) {
    // due is RFC 3339 — Google Tasks uses date-only resolution
    return this.fetch(`/lists/${encodeURIComponent(tasklist)}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        notes,
        ...(due ? { due } : {}),
      }),
    });
  }
}

/**
 * Given a date, return the next Mon–Fri working day at 9 AM.
 * If date is already a weekday and before 6 PM today, returns today.
 */
export function nextWorkday(date = new Date()) {
  const d = new Date(date);
  d.setSeconds(0, 0);

  // If today and past 6 PM, start from tomorrow
  const now = new Date();
  if (
    d.toDateString() === now.toDateString() &&
    now.getHours() >= 18
  ) {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }

  // Skip weekends
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  }

  return d;
}

/**
 * Advance to the next Mon–Fri day after the given date.
 */
export function advanceToNextWorkday(date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}
