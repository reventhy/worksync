import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { View, Text, SectionList, StyleSheet, TouchableOpacity, ActivityIndicator, AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { useTheme } from '../context/ThemeContext';
import TaskItem from '../components/TaskItem';
import { markTaskDone, rescheduleOverdue } from '../utils/scheduler';

export default function TasksScreen() {
  const { scheduledTasks, loadFromCache, jiraIssues, jiraBaseUrl, jiraCustomFieldId, jiraCustomFieldValues, jiraCustomFieldName } = useApp();
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);

  const [rescheduling, setRescheduling] = useState(false);
  const [statusMsg, setStatusMsg]       = useState(null);
  const appStateRef = useRef(AppState.currentState);

  useFocusEffect(useCallback(() => { loadFromCache(); }, [loadFromCache]));

  useEffect(() => {
    const sub = AppState.addEventListener('change', async nextState => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        await loadFromCache();
        const now = new Date();
        const hasOverdue = scheduledTasks.some(t => !t.done && (t.overdue || new Date(t.startTime) < now));
        if (hasOverdue && !rescheduling) handleReschedule(true);
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, [scheduledTasks, rescheduling]);

  const now     = new Date();
  const todayStr = now.toDateString();
  const visible  = scheduledTasks.filter(t => !t.done || new Date(t.startTime).toDateString() === todayStr);
  const overdue  = scheduledTasks.filter(t => !t.done && (t.overdue || new Date(t.startTime) < now));

  const groups = {};
  for (const task of visible) {
    const key = new Date(task.startTime).toDateString();
    if (!groups[key]) groups[key] = [];
    groups[key].push(task);
  }
  const tomorrow = new Date(now.getTime() + 86400000).toDateString();
  const sections = Object.entries(groups).map(([dateKey, data]) => ({
    title: dateKey === todayStr ? 'Today' : dateKey === tomorrow ? 'Tomorrow'
      : new Date(dateKey).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    data,
  }));

  async function handleMarkDone(taskId) {
    await markTaskDone(taskId);
    await loadFromCache();
  }

  async function handleReschedule(silent = false) {
    if (rescheduling) return;
    setRescheduling(true);
    if (!silent) setStatusMsg(null);
    try {
      const result = await rescheduleOverdue();
      await loadFromCache();
      if (!silent) {
        setStatusMsg(result.offline
          ? { type: 'error', text: 'Offline — tasks saved locally, will reschedule when connected.' }
          : { type: 'success', text: result.rescheduled > 0 ? `${result.rescheduled} task${result.rescheduled !== 1 ? 's' : ''} rescheduled.` : 'No overdue tasks.' }
        );
      }
    } catch (e) {
      if (!silent) setStatusMsg({ type: 'error', text: e.message });
    } finally {
      setRescheduling(false);
      if (!silent) setTimeout(() => setStatusMsg(null), 5000);
    }
  }

  return (
    <View style={s.container}>
      <View style={s.toolbar}>
        <Text style={s.countLabel}>{visible.length} task{visible.length !== 1 ? 's' : ''}</Text>
        {overdue.length > 0 && (
          <TouchableOpacity onPress={() => handleReschedule(false)} disabled={rescheduling} style={s.rescheduleBtn}>
            {rescheduling ? <ActivityIndicator size="small" color={C.warning} /> : <Ionicons name="time-outline" size={15} color={C.warning} />}
            <Text style={s.rescheduleBtnText}>{rescheduling ? 'Rescheduling…' : `Reschedule ${overdue.length} overdue`}</Text>
          </TouchableOpacity>
        )}
      </View>

      {statusMsg && (
        <View style={[s.statusBanner, statusMsg.type === 'error' ? s.statusError : s.statusSuccess]}>
          <Text style={s.statusText}>{statusMsg.text}</Text>
        </View>
      )}

      <SectionList
        sections={sections}
        keyExtractor={t => t.id}
        renderSectionHeader={({ section }) => (
          <View style={s.sectionHeader}>
            <Text style={s.sectionLabel}>{section.title}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <TaskItem
            task={item}
            jiraBaseUrl={jiraBaseUrl}
            jiraCustomFieldId={jiraCustomFieldId}
            jiraCustomFieldValues={jiraCustomFieldValues}
            jiraCustomFieldName={jiraCustomFieldName}
            jiraIssues={jiraIssues}
            onMarkDone={handleMarkDone}
          />
        )}
        contentContainerStyle={sections.length === 0 ? s.emptyList : s.list}
        ListEmptyComponent={
          <View style={s.emptyState}>
            <Ionicons name="calendar-outline" size={40} color={C.muted} />
            <Text style={s.emptyTitle}>No tasks scheduled</Text>
            <Text style={s.emptyText}>Select Jira issues or Slack messages and tap "Schedule Tasks" to create calendar events.</Text>
          </View>
        }
      />
    </View>
  );
}

const makeStyles = (C) => StyleSheet.create({
  container:       { flex: 1, backgroundColor: C.bg },
  toolbar:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.surface },
  countLabel:      { color: C.subtext, fontSize: 12 },
  rescheduleBtn:   { flexDirection: 'row', alignItems: 'center', gap: 5, padding: 4 },
  rescheduleBtnText:{ color: C.warning, fontSize: 12, fontWeight: '500' },
  sectionHeader:   { paddingHorizontal: 14, paddingVertical: 5, paddingTop: 14, backgroundColor: C.bg },
  sectionLabel:    { color: C.subtext, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  list:            { paddingBottom: 20 },
  emptyList:       { flex: 1, justifyContent: 'center' },
  emptyState:      { alignItems: 'center', padding: 40 },
  emptyTitle:      { color: C.text, fontSize: 16, fontWeight: '600', marginTop: 12, marginBottom: 6 },
  emptyText:       { color: C.subtext, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  statusBanner:    { padding: 9, paddingHorizontal: 14 },
  statusSuccess:   { backgroundColor: C.successDim },
  statusError:     { backgroundColor: C.dangerDim },
  statusText:      { color: C.text, fontSize: 12 },
});
