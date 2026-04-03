import React, { useCallback, useState, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, Modal, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '../context/AppContext';
import { useTheme } from '../context/ThemeContext';
import ReminderCard from '../components/ReminderCard';
import { scheduleTaskItems } from '../utils/scheduler';

export default function RemindersScreen() {
  const { reminders, saveReminders, loadFromCache, scheduledTasks } = useApp();
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);

  const [selected, setSelected]         = useState(new Set());
  const [editorVisible, setEditorVisible] = useState(false);
  const [editTarget, setEditTarget]     = useState(null);
  const [titleInput, setTitleInput]     = useState('');
  const [noteInput, setNoteInput]       = useState('');
  const [scheduling, setScheduling]     = useState(false);
  const [statusMsg, setStatusMsg]       = useState(null);

  useFocusEffect(useCallback(() => { loadFromCache(); }, [loadFromCache]));

  const scheduledReminderIds = new Set(
    scheduledTasks.filter(t => !t.done && t.sourceType === 'reminder').map(t => t.sourceId)
  );
  const visibleReminders = reminders.filter(r => !scheduledReminderIds.has(r.id));

  function toggleSelect(id) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function openEditor(existing = null) {
    setEditTarget(existing);
    setTitleInput(existing?.title || '');
    setNoteInput(existing?.note || '');
    setEditorVisible(true);
  }

  async function saveEdited() {
    const title = titleInput.trim();
    if (!title) return;
    const note = noteInput.trim();
    const updated = editTarget
      ? reminders.map(r => r.id === editTarget.id ? { ...r, title, note } : r)
      : [...reminders, { id: `rem_${Date.now()}`, title, note, createdAt: new Date().toISOString() }];
    await saveReminders(updated);
    setEditorVisible(false);
    setEditTarget(null);
    setTitleInput('');
    setNoteInput('');
  }

  async function deleteReminder(id) {
    const updated = reminders.filter(r => r.id !== id);
    selected.delete(id);
    setSelected(new Set(selected));
    await saveReminders(updated);
  }

  async function handleSchedule() {
    const items = visibleReminders.filter(r => selected.has(r.id)).map(r => ({ ...r, type: 'reminder' }));
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

  return (
    <View style={s.container}>
      <View style={s.toolbar}>
        <Text style={s.countLabel}>{visibleReminders.length} reminder{visibleReminders.length !== 1 ? 's' : ''}</Text>
        <TouchableOpacity onPress={() => openEditor()} style={s.addBtn}>
          <Ionicons name="add" size={19} color={C.accent} />
          <Text style={s.addBtnText}>Add</Text>
        </TouchableOpacity>
      </View>

      {statusMsg && (
        <View style={[s.statusBanner, statusMsg.type === 'error' ? s.statusError : s.statusSuccess]}>
          <Text style={s.statusText}>{statusMsg.text}</Text>
        </View>
      )}

      <FlatList
        data={visibleReminders}
        keyExtractor={r => r.id}
        renderItem={({ item }) => (
          <ReminderCard
            reminder={item}
            selected={selected.has(item.id)}
            onToggle={() => toggleSelect(item.id)}
            onEdit={() => openEditor(item)}
            onDelete={() => deleteReminder(item.id)}
          />
        )}
        contentContainerStyle={visibleReminders.length === 0 ? s.emptyList : s.list}
        ListEmptyComponent={
          <View style={s.emptyState}>
            <Ionicons name="bookmark-outline" size={40} color={C.muted} />
            <Text style={s.emptyTitle}>No reminders yet</Text>
            <Text style={s.emptyText}>Tap "+ Add" to create reminders you can schedule as calendar tasks.</Text>
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

      <Modal visible={editorVisible} transparent animationType="slide" onRequestClose={() => setEditorVisible(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{editTarget ? 'Edit Reminder' : 'Add Reminder'}</Text>
            <TextInput
              style={s.input}
              placeholder="Reminder title…"
              placeholderTextColor={C.muted}
              value={titleInput}
              onChangeText={setTitleInput}
              maxLength={200}
              autoFocus
            />
            <TextInput
              style={[s.input, s.textArea]}
              placeholder="Notes (optional)…"
              placeholderTextColor={C.muted}
              value={noteInput}
              onChangeText={setNoteInput}
              maxLength={1000}
              multiline
              numberOfLines={3}
            />
            <View style={s.modalActions}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setEditorVisible(false)}>
                <Text style={s.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.saveBtn, !titleInput.trim() && s.saveBtnDisabled]}
                onPress={saveEdited}
                disabled={!titleInput.trim()}
              >
                <Text style={s.saveBtnText}>{editTarget ? 'Save' : 'Add'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (C) => StyleSheet.create({
  container:   { flex: 1, backgroundColor: C.bg },
  toolbar:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.surface },
  countLabel:  { color: C.subtext, fontSize: 12 },
  addBtn:      { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4 },
  addBtnText:  { color: C.accent, fontSize: 13, fontWeight: '500' },
  list:        { paddingVertical: 6 },
  emptyList:   { flex: 1, justifyContent: 'center' },
  emptyState:  { alignItems: 'center', padding: 40 },
  emptyTitle:  { color: C.text, fontSize: 16, fontWeight: '600', marginTop: 12, marginBottom: 6 },
  emptyText:   { color: C.subtext, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  statusBanner: { padding: 9, paddingHorizontal: 14 },
  statusSuccess:{ backgroundColor: C.successDim },
  statusError:  { backgroundColor: C.dangerDim },
  statusText:   { color: C.text, fontSize: 12 },
  bottomBar:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 11, paddingHorizontal: 14, backgroundColor: C.surface, borderTopWidth: 1, borderTopColor: C.border },
  selectedCount:{ color: C.subtext, fontSize: 13 },
  scheduleBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.accent, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 6 },
  scheduleBtnDisabled: { opacity: 0.5 },
  scheduleBtnText:     { color: '#fff', fontWeight: '600', fontSize: 13 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  modalCard:    { backgroundColor: C.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 22, gap: 11 },
  modalTitle:   { color: C.text, fontSize: 17, fontWeight: '700', marginBottom: 4 },
  input:        { backgroundColor: C.surfaceElevated, borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 11, color: C.text, fontSize: 14 },
  textArea:     { height: 75, textAlignVertical: 'top' },
  modalActions: { flexDirection: 'row', gap: 9, marginTop: 4 },
  cancelBtn:    { flex: 1, padding: 11, borderRadius: 6, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
  cancelBtnText:{ color: C.subtext, fontWeight: '500' },
  saveBtn:      { flex: 1, padding: 11, borderRadius: 6, backgroundColor: C.accent, alignItems: 'center' },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText:  { color: '#fff', fontWeight: '600' },
});
