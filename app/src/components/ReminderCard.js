import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';

export default function ReminderCard({ reminder, selected, onToggle, onEdit, onDelete }) {
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);

  return (
    <View style={[s.card, selected && s.cardSelected]}>
      <TouchableOpacity
        onPress={onToggle}
        style={[s.checkBox, selected && s.checkBoxSelected]}
      >
        {selected && <Ionicons name="checkmark" size={11} color="#fff" />}
      </TouchableOpacity>

      <View style={s.body}>
        <Text style={s.title}>{reminder.title}</Text>
        {reminder.note ? (
          <Text style={s.note} numberOfLines={2}>{reminder.note}</Text>
        ) : null}
      </View>

      <View style={s.actions}>
        <TouchableOpacity onPress={onEdit} style={s.actionBtn}>
          <Ionicons name="create-outline" size={17} color={C.subtext} />
        </TouchableOpacity>
        <TouchableOpacity onPress={onDelete} style={s.actionBtn}>
          <Ionicons name="close-circle-outline" size={17} color={C.danger} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const makeStyles = (C) => StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: C.surface,
    marginHorizontal: 12, marginVertical: 4,
    borderRadius: 6, padding: 12,
    borderWidth: 1, borderColor: C.border,
  },
  cardSelected: { borderColor: C.accent, backgroundColor: C.accentDim },
  checkBox: {
    width: 17, height: 17, borderRadius: 3,
    borderWidth: 1.5, borderColor: C.border2,
    marginRight: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  checkBoxSelected: { backgroundColor: C.accent, borderColor: C.accent },
  body: { flex: 1 },
  title: { color: C.text, fontSize: 13, fontWeight: '500' },
  note: { color: C.subtext, fontSize: 11, marginTop: 3, lineHeight: 15 },
  actions: { flexDirection: 'row', gap: 2, marginLeft: 8 },
  actionBtn: { padding: 4 },
});
