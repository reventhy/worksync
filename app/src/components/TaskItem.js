import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { store, getConfig } from '../storage/store';
import { JiraAPI } from '../api/jira';

export default function TaskItem({
  task, jiraBaseUrl, jiraCustomFieldId,
  jiraCustomFieldValues, jiraCustomFieldName,
  jiraIssues, onMarkDone,
}) {
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);
  const [fieldStatus, setFieldStatus] = useState(null);

  const start = new Date(task.startTime);
  const end   = new Date(task.endTime);
  const now   = new Date();
  const isOverdue       = !task.done && (task.overdue || start < now);
  const isQueuedOffline = task.overdue && start >= now;

  const timeStr = `${start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  const dateStr = start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  const isJiraTask = task.sourceType === 'jira' || (!task.sourceType && task.title?.startsWith('[Jira]'));
  const jiraKey   = task.sourceId || (isJiraTask ? task.title?.match(/\[Jira\] ([^:]+):/)?.[1] : null);
  const currentFieldValue =
    jiraIssues?.find(i => i.key === jiraKey)?.filterFieldValue ?? task.filterFieldValue ?? null;
  const showDropdown = isJiraTask && jiraKey && jiraCustomFieldId && jiraCustomFieldValues?.length > 0;

  async function handleFieldChange(newValue) {
    if (!newValue || !jiraKey || !jiraCustomFieldId) return;
    setFieldStatus('saving');
    try {
      const config = await getConfig();
      const jira = new JiraAPI({ baseUrl: config.jiraBaseUrl, email: config.jiraEmail, apiToken: config.jiraApiToken });
      await jira.updateIssueField(jiraKey, jiraCustomFieldId, newValue);
      const issues = (await store.get('jiraIssues')) || [];
      await store.set('jiraIssues', issues.map(i => i.key === jiraKey ? { ...i, filterFieldValue: newValue } : i));
      setFieldStatus('ok');
      setTimeout(() => setFieldStatus(null), 2000);
    } catch (e) {
      setFieldStatus('error');
      setTimeout(() => setFieldStatus(null), 3000);
    }
  }

  return (
    <View style={[s.item, task.done && s.itemDone, isOverdue && s.itemOverdue]}>
      <TouchableOpacity
        onPress={() => !task.done && onMarkDone(task.id)}
        style={[s.checkBtn, task.done && s.checkBtnDone]}
        disabled={task.done}
      >
        {task.done
          ? <Ionicons name="checkmark" size={13} color={C.success} />
          : <View style={s.checkInner} />}
      </TouchableOpacity>

      <View style={s.info}>
        <Text style={[s.title, task.done && s.titleDone]} numberOfLines={2}>
          {task.title}
        </Text>

        <View style={s.timeRow}>
          <Text style={s.dateText}>{dateStr}</Text>
          <Text style={s.timeText}>{timeStr}</Text>
          {isOverdue && (
            <View style={[s.overdueChip, isQueuedOffline && s.queuedChip]}>
              <Text style={[s.overdueText, isQueuedOffline && s.queuedText]}>
                {isQueuedOffline ? '⏳ queued' : 'overdue'}
              </Text>
            </View>
          )}
        </View>

        {isJiraTask && jiraBaseUrl && jiraKey && (
          <TouchableOpacity style={s.jiraLink} onPress={() => Linking.openURL(`${jiraBaseUrl}/browse/${jiraKey}`)}>
            <Ionicons name="open-outline" size={11} color={C.accent} />
            <Text style={s.jiraLinkText}>Open in Jira</Text>
          </TouchableOpacity>
        )}

        {showDropdown && (
          <View style={s.fieldRow}>
            <Text style={s.fieldLabel}>{jiraCustomFieldName || 'Field'}:</Text>
            <View style={s.fieldPicker}>
              {jiraCustomFieldValues.map(v => (
                <TouchableOpacity
                  key={v}
                  onPress={() => handleFieldChange(v)}
                  style={[s.fieldOption, currentFieldValue === v && s.fieldOptionActive]}
                >
                  <Text style={[s.fieldOptionText, currentFieldValue === v && s.fieldOptionTextActive]}>
                    {v}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {fieldStatus === 'saving' && <Text style={s.fieldSaving}>…</Text>}
            {fieldStatus === 'ok'     && <Text style={s.fieldOk}>✓</Text>}
            {fieldStatus === 'error'  && <Text style={s.fieldError}>✗</Text>}
          </View>
        )}
      </View>
    </View>
  );
}

const makeStyles = (C) => StyleSheet.create({
  item: {
    flexDirection: 'row',
    paddingHorizontal: 16, paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: C.border,
    backgroundColor: C.bg,
  },
  itemDone:    { opacity: 0.4 },
  itemOverdue: { backgroundColor: C.warningDim },
  checkBtn: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 1.5, borderColor: C.border2,
    marginRight: 12, marginTop: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  checkBtnDone: { borderColor: C.success },
  checkInner:   { width: 7, height: 7, borderRadius: 3.5 },
  info:  { flex: 1 },
  title: { color: C.text, fontSize: 13, fontWeight: '500', lineHeight: 18, marginBottom: 4 },
  titleDone: { textDecorationLine: 'line-through', color: C.muted },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4, flexWrap: 'wrap' },
  dateText: { color: C.subtext, fontSize: 11 },
  timeText: { color: C.subtext, fontSize: 11 },
  overdueChip: {
    backgroundColor: C.warningDim, borderRadius: 3,
    paddingHorizontal: 5, paddingVertical: 2,
  },
  overdueText:  { color: C.warning, fontSize: 10, fontWeight: '600' },
  queuedChip:   { backgroundColor: C.accentDim },
  queuedText:   { color: C.accent },
  jiraLink:     { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start', marginBottom: 5 },
  jiraLinkText: { color: C.accent, fontSize: 11 },
  fieldRow:     { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: 4 },
  fieldLabel:   { color: C.subtext, fontSize: 10 },
  fieldPicker:  { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  fieldOption:  { borderRadius: 3, borderWidth: 1, borderColor: C.border, paddingHorizontal: 7, paddingVertical: 2 },
  fieldOptionActive:     { borderColor: C.accent, backgroundColor: C.accentDim },
  fieldOptionText:       { color: C.subtext, fontSize: 10 },
  fieldOptionTextActive: { color: C.accent, fontWeight: '600' },
  fieldSaving: { color: C.subtext, fontSize: 12 },
  fieldOk:     { color: C.success,  fontSize: 12 },
  fieldError:  { color: C.danger,   fontSize: 12 },
});
