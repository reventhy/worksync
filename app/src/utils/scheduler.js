import { store, getConfig } from '../storage/store';
import { getCalendarAPI } from '../api/calendar';
import { pushCache } from '../api/firebase';

const TASK_DURATION_MINUTES = 20;

function buildWorkSchedule(config) {
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
  return workSchedule;
}

export async function scheduleTaskItems(items = []) {
  if (!items.length) throw new Error('No items to schedule.');

  const config = await getConfig();
  const calendarId = config.defaultCalendarId || 'primary';
  const workSchedule = buildWorkSchedule(config);

  const calendar = await getCalendarAPI();
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
      throw new Error(
        `No free slot found for item ${created.length + 1} within the next 14 days.`
      );
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
      ]
        .filter(Boolean)
        .join('\n');
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
      ]
        .filter(Boolean)
        .join('\n');
    } else {
      const preview = item.text.replace(/<[^>]+>/g, '').slice(0, 200);
      title = `[Slack] #${item.channelName}: ${item.text.replace(/<[^>]+>/g, '').slice(0, 60)}`;
      description = [
        `Channel: #${item.channelName}`,
        `Importance: ${item.importanceLabel}`,
        `\n${preview}`,
        item.url ? `→ ${item.url}` : null,
      ]
        .filter(Boolean)
        .join('\n');
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
      sourceId: item.type === 'jira' ? item.key : (item.ts || item.id),
      filterFieldValue: item.type === 'jira' ? (item.filterFieldValue ?? null) : null,
    };
    created.push(task);

    busySlots.push({ start: slot, end: endTime });
    busySlots.sort((a, b) => a.start - b.start);
    searchFrom = endTime;
  }

  const existing = (await store.get('scheduledTasks')) || [];
  const updated = [...existing, ...created];
  await store.set('scheduledTasks', updated);
  pushCache({ scheduledTasks: updated });

  return created;
}

export async function markTaskDone(taskId) {
  const tasks = (await store.get('scheduledTasks')) || [];
  const task = tasks.find(t => t.id === taskId);

  if (task?.calendarEventId) {
    try {
      const calendar = await getCalendarAPI();
      await calendar.deleteEvent(task.calendarEventId, task.calendarId || 'primary');
    } catch (e) {
      console.warn('[scheduler] Could not delete calendar event:', e.message);
    }
  }

  const remaining = tasks.filter(t => t.id !== taskId);
  await store.set('scheduledTasks', remaining);
  pushCache({ scheduledTasks: remaining });
}

export async function rescheduleOverdue() {
  const tasks = (await store.get('scheduledTasks')) || [];
  const now = new Date();
  const overdue = tasks.filter(t => !t.done && new Date(t.startTime) < now);

  if (!overdue.length) return { rescheduled: 0 };

  // Mark all overdue tasks immediately so they remain visible offline
  const markedTasks = tasks.map(t =>
    overdue.find(o => o.id === t.id) ? { ...t, overdue: true } : t
  );
  await store.set('scheduledTasks', markedTasks);
  pushCache({ scheduledTasks: markedTasks });

  // Try to reschedule via calendar (requires network)
  let calendar, busySlots;
  try {
    const config = await getConfig();
    const calendarId = config.defaultCalendarId || 'primary';
    calendar = await getCalendarAPI();
    busySlots = await calendar.getBusySlots({ daysAhead: 14, calendarId });
  } catch (e) {
    // Offline or token missing — tasks stay marked overdue, will auto-retry on next foreground
    console.warn('[scheduler] rescheduleOverdue offline, will retry later:', e.message);
    return { rescheduled: 0, offline: true };
  }

  const config = await getConfig();
  const calendarId = config.defaultCalendarId || 'primary';

  // Best-effort: delete old calendar events
  await Promise.allSettled(
    overdue.map(t =>
      t.calendarEventId
        ? calendar.deleteEvent(t.calendarEventId, t.calendarId || calendarId)
        : Promise.resolve()
    )
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
      console.warn('[scheduler] Could not create calendar event:', e.message);
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
  const fresh = (await store.get('scheduledTasks')) || [];
  const withoutOverdue = fresh.filter(t => !rescheduledIds.has(t.id));
  const finalTasks = [...withoutOverdue, ...rescheduled];
  await store.set('scheduledTasks', finalTasks);
  pushCache({ scheduledTasks: finalTasks });

  return { rescheduled: rescheduled.length };
}
