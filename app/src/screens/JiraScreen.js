import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { useTheme } from '../context/ThemeContext';
import JiraCard from '../components/JiraCard';
import { scheduleTaskItems } from '../utils/scheduler';

export default function JiraScreen() {
  const navigation = useNavigation();
  const { jiraIssues, scheduledTasks, jiraError, syncing, triggerSync, loadFromCache, configured, configLoaded } = useApp();
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);

  const [selected, setSelected]     = useState(new Set());
  const [scheduling, setScheduling] = useState(false);
  const [statusMsg, setStatusMsg]   = useState(null);

  useFocusEffect(useCallback(() => { loadFromCache(); }, [loadFromCache]));

  const scheduledJiraKeys = new Set(scheduledTasks.filter(t => !t.done && t.sourceType === 'jira').map(t => t.sourceId));
  const visibleIssues = jiraIssues.filter(i => !scheduledJiraKeys.has(i.key));

  function toggleSelect(key) {
    setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleAll() {
    setSelected(selected.size === visibleIssues.length ? new Set() : new Set(visibleIssues.map(i => i.key)));
  }

  async function handleSchedule() {
    const items = jiraIssues.filter(i => selected.has(i.key)).map(i => ({ ...i, type: 'jira' }));
    if (!items.length) return;
    setScheduling(true); setStatusMsg(null);
    try {
      const created = await scheduleTaskItems(items);
      setSelected(new Set());
      setStatusMsg({ type: 'success', text: `${created.length} task${created.length !== 1 ? 's' : ''} scheduled!` });
      await loadFromCache();
    } catch (e) {
      setStatusMsg({ type: 'error', text: e.message });
    } finally {
      setScheduling(false);
      setTimeout(() => setStatusMsg(null), 5000);
    }
  }

  if (!configLoaded) return <View style={s.center}><ActivityIndicator color={C.accent} size="large" /></View>;

  if (!configured) return (
    <View style={s.center}>
      <Ionicons name="settings-outline" size={44} color={C.muted} />
      <Text style={s.emptyTitle}>Not set up yet</Text>
      <Text style={s.emptyText}>Import your settings from the Chrome extension to get started.</Text>
      <TouchableOpacity style={s.setupBtn} onPress={() => navigation.navigate('Settings')}>
        <Ionicons name="cloud-download-outline" size={16} color="#fff" />
        <Text style={s.setupBtnText}>Go to Settings →</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={s.container}>
      <View style={s.toolbar}>
        <View style={s.toolbarLeft}>
          <Text style={s.countLabel}>{visibleIssues.length} issue{visibleIssues.length !== 1 ? 's' : ''}</Text>
          {visibleIssues.length > 0 && (
            <TouchableOpacity onPress={toggleAll} style={s.selectAllBtn}>
              <Text style={s.selectAllText}>{selected.size === visibleIssues.length ? 'Deselect all' : 'Select all'}</Text>
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity onPress={triggerSync} disabled={syncing} style={s.syncBtn}>
          {syncing ? <ActivityIndicator size="small" color={C.accent} /> : <Ionicons name="refresh" size={19} color={C.accent} />}
        </TouchableOpacity>
      </View>

      {jiraError && <View style={s.errorBanner}><Text style={s.errorText}>{jiraError}</Text></View>}
      {statusMsg && (
        <View style={[s.statusBanner, statusMsg.type === 'error' ? s.statusError : s.statusSuccess]}>
          <Text style={s.statusText}>{statusMsg.text}</Text>
        </View>
      )}

      <FlatList
        data={visibleIssues}
        keyExtractor={i => i.key}
        renderItem={({ item }) => <JiraCard issue={item} selected={selected.has(item.key)} onToggle={() => toggleSelect(item.key)} />}
        contentContainerStyle={visibleIssues.length === 0 ? s.emptyList : s.list}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={triggerSync} tintColor={C.accent} />}
        ListEmptyComponent={
          <View style={s.emptyState}>
            <Ionicons name="checkmark-circle-outline" size={40} color={C.muted} />
            <Text style={s.emptyTitle}>No issues to review</Text>
            <Text style={s.emptyText}>Issues with your configured review status will appear here.</Text>
          </View>
        }
      />

      {selected.size > 0 && (
        <View style={s.bottomBar}>
          <Text style={s.selectedCount}>{selected.size} selected</Text>
          <TouchableOpacity style={[s.scheduleBtn, scheduling && s.scheduleBtnDisabled]} onPress={handleSchedule} disabled={scheduling}>
            {scheduling ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="calendar" size={15} color="#fff" />}
            <Text style={s.scheduleBtnText}>{scheduling ? 'Scheduling…' : 'Schedule Tasks'}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const makeStyles = (C) => StyleSheet.create({
  container:   { flex: 1, backgroundColor: C.bg },
  center:      { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, padding: 32 },
  toolbar:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.surface },
  toolbarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  countLabel:  { color: C.subtext, fontSize: 12 },
  selectAllBtn:{ paddingHorizontal: 7, paddingVertical: 3 },
  selectAllText:{ color: C.accent, fontSize: 12 },
  syncBtn:     { padding: 7 },
  list:        { paddingVertical: 6 },
  emptyList:   { flex: 1, justifyContent: 'center' },
  emptyState:  { alignItems: 'center', padding: 40 },
  emptyTitle:  { color: C.text, fontSize: 16, fontWeight: '600', marginTop: 12, marginBottom: 6 },
  emptyText:   { color: C.subtext, fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 20 },
  setupBtn:    { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.accent, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 8 },
  setupBtnText:{ color: '#fff', fontWeight: '600', fontSize: 14 },
  errorBanner: { backgroundColor: C.dangerDim, padding: 9, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: C.danger },
  errorText:   { color: C.danger, fontSize: 12 },
  statusBanner:{ padding: 9, paddingHorizontal: 14 },
  statusSuccess:{ backgroundColor: C.successDim },
  statusError: { backgroundColor: C.dangerDim },
  statusText:  { color: C.text, fontSize: 12 },
  bottomBar:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 11, paddingHorizontal: 14, backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.border },
  selectedCount:{ color: C.subtext, fontSize: 13 },
  scheduleBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.accent, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 6 },
  scheduleBtnDisabled: { opacity: 0.5 },
  scheduleBtnText:     { color: '#fff', fontWeight: '600', fontSize: 13 },
});
