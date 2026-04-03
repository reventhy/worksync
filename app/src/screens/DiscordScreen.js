import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, SectionList, StyleSheet, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { useTheme } from '../context/ThemeContext';
import DiscordCard from '../components/DiscordCard';
import { scheduleTaskItems } from '../utils/scheduler';

export default function DiscordScreen() {
  const { discordMessages, discordMentionsSummary, scheduledTasks, syncing, triggerSync, loadFromCache } = useApp();
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);

  const [selected, setSelected] = useState(new Set());
  const [scheduling, setScheduling] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  useFocusEffect(useCallback(() => { loadFromCache(); }, [loadFromCache]));

  const scheduledDiscordIds = new Set(
    scheduledTasks.filter(t => !t.done && t.sourceType === 'discord').map(t => t.sourceId)
  );

  const visible = discordMessages.filter(m => m.importance >= 3 && !scheduledDiscordIds.has(m.ts));
  const directMessages = visible.filter(m => m.isDM);
  const serverMessages = visible.filter(m => !m.isDM);
  const sections = [
    ...(directMessages.length ? [{ key: 'dm', title: 'Direct Messages', data: directMessages }] : []),
    ...(serverMessages.length ? [{ key: 'server', title: 'Server Messages', data: serverMessages }] : []),
  ];

  function toggleSelect(ts) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(ts) ? next.delete(ts) : next.add(ts);
      return next;
    });
  }

  function toggleAll() {
    setSelected(selected.size === visible.length ? new Set() : new Set(visible.map(m => m.ts)));
  }

  async function handleSchedule() {
    const items = discordMessages.filter(m => selected.has(m.ts)).map(m => ({ ...m, type: 'discord' }));
    if (!items.length) return;
    setScheduling(true);
    setStatusMsg(null);
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

  return (
    <View style={s.container}>
      <View style={s.toolbar}>
        <View style={s.toolbarLeft}>
          <Text style={s.countLabel}>{visible.length} message{visible.length !== 1 ? 's' : ''}</Text>
          {visible.length > 0 && (
            <TouchableOpacity onPress={toggleAll} style={s.selectAllBtn}>
              <Text style={s.selectAllText}>{selected.size === visible.length ? 'Deselect all' : 'Select all'}</Text>
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity onPress={triggerSync} disabled={syncing} style={s.syncBtn}>
          {syncing ? <ActivityIndicator size="small" color={C.accent} /> : <Ionicons name="refresh" size={19} color={C.accent} />}
        </TouchableOpacity>
      </View>

      {statusMsg && (
        <View style={[s.statusBanner, statusMsg.type === 'error' ? s.statusError : s.statusSuccess]}>
          <Text style={s.statusText}>{statusMsg.text}</Text>
        </View>
      )}

      {!!discordMentionsSummary && (
        <View style={s.summaryCard}>
          <View style={s.summaryStats}>
            <View style={s.summaryStat}>
              <Text style={s.summaryValue}>{discordMentionsSummary.totalBotMentionCount || 0}</Text>
              <Text style={s.summaryLabel}>Bot Mentions</Text>
            </View>
            <View style={s.summaryStat}>
              <Text style={s.summaryValue}>{discordMentionsSummary.mentionMessagesCount || 0}</Text>
              <Text style={s.summaryLabel}>Mention Msgs</Text>
            </View>
            <View style={s.summaryStat}>
              <Text style={s.summaryValue}>{discordMentionsSummary.directMessagesCount || 0}</Text>
              <Text style={s.summaryLabel}>DMs</Text>
            </View>
          </View>

          {!!discordMentionsSummary.topUsers?.length && (
            <View style={s.summaryBlock}>
              <Text style={s.summaryBlockTitle}>Top mentioners</Text>
              {discordMentionsSummary.topUsers.slice(0, 3).map(user => (
                <Text key={user.userId} style={s.summaryLine}>
                  {user.userName} • {user.botMentionCount} tag{user.botMentionCount !== 1 ? 's' : ''}
                </Text>
              ))}
            </View>
          )}

          {!!discordMentionsSummary.recentMentions?.length && (
            <View style={s.summaryBlock}>
              <Text style={s.summaryBlockTitle}>Recent mention content</Text>
              {discordMentionsSummary.recentMentions.slice(0, 2).map(item => (
                <Text key={item.messageId} style={s.summaryLine} numberOfLines={2}>
                  {item.userName}: {item.excerpt}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}

      <SectionList
        sections={sections}
        keyExtractor={m => m.messageId}
        renderItem={({ item }) => (
          <DiscordCard message={item} selected={selected.has(item.ts)} onToggle={() => toggleSelect(item.ts)} />
        )}
        renderSectionHeader={({ section }) => (
          <View style={s.sectionHeader}>
            <Text style={s.sectionHeaderText}>{section.title}</Text>
            <Text style={s.sectionCount}>{section.data.length}</Text>
          </View>
        )}
        contentContainerStyle={visible.length === 0 ? s.emptyList : s.list}
        refreshControl={<RefreshControl refreshing={syncing} onRefresh={triggerSync} tintColor={C.accent} />}
        ListEmptyComponent={
          <View style={s.emptyState}>
            <Ionicons name="logo-discord" size={40} color={C.muted} />
            <Text style={s.emptyTitle}>{discordMessages.length === 0 ? 'No Discord messages synced yet' : 'All caught up!'}</Text>
            <Text style={s.emptyText}>
              {discordMessages.length === 0
                ? 'Keep the Discord worker running and send a new server message or DM to the bot.'
                : 'All Discord messages have been scheduled or cleared.'}
            </Text>
            {discordMessages.length === 0 && (
              <TouchableOpacity style={s.setupBtn} onPress={triggerSync} disabled={syncing}>
                {syncing ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="refresh" size={16} color="#fff" />}
                <Text style={s.setupBtnText}>Refresh cache</Text>
              </TouchableOpacity>
            )}
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
  container: { flex: 1, backgroundColor: C.bg },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.surface },
  toolbarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  countLabel: { color: C.subtext, fontSize: 12 },
  selectAllBtn: { paddingHorizontal: 7, paddingVertical: 3 },
  selectAllText: { color: C.accent, fontSize: 12 },
  syncBtn: { padding: 7 },
  list: { paddingVertical: 6 },
  emptyList: { flex: 1, justifyContent: 'center' },
  emptyState: { alignItems: 'center', padding: 40 },
  emptyTitle: { color: C.text, fontSize: 16, fontWeight: '600', marginTop: 12, marginBottom: 6 },
  emptyText: { color: C.subtext, fontSize: 13, textAlign: 'center', lineHeight: 19, marginBottom: 20 },
  setupBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.accent, paddingHorizontal: 18, paddingVertical: 11, borderRadius: 8 },
  setupBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  statusBanner: { padding: 9, paddingHorizontal: 14 },
  statusSuccess: { backgroundColor: C.successDim },
  statusError: { backgroundColor: C.dangerDim },
  statusText: { color: C.text, fontSize: 12 },
  summaryCard: { margin: 12, marginBottom: 6, padding: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 8, gap: 10 },
  summaryStats: { flexDirection: 'row', gap: 10 },
  summaryStat: { flex: 1, backgroundColor: C.surfaceElevated || C.bg, borderRadius: 6, padding: 10 },
  summaryValue: { color: C.text, fontSize: 18, fontWeight: '700', marginBottom: 2 },
  summaryLabel: { color: C.subtext, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 },
  summaryBlock: { gap: 4 },
  summaryBlockTitle: { color: C.subtext, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  summaryLine: { color: C.text, fontSize: 12, lineHeight: 17 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 7, backgroundColor: C.bg, borderBottomWidth: 1, borderBottomColor: C.border },
  sectionHeaderText: { color: C.subtext, fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  sectionCount: { color: C.muted, fontSize: 11, fontWeight: '600' },
  bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 11, paddingHorizontal: 14, backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.border },
  selectedCount: { color: C.subtext, fontSize: 13 },
  scheduleBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.accent, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 6 },
  scheduleBtnDisabled: { opacity: 0.5 },
  scheduleBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
