import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { relativeTime } from '../utils/helpers';

export default function JiraCard({ issue, selected, onToggle }) {
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);

  return (
    <TouchableOpacity
      onPress={onToggle}
      activeOpacity={0.75}
      style={[s.card, selected && s.cardSelected]}
    >
      <View style={[s.checkBox, selected && s.checkBoxSelected]}>
        {selected && <Ionicons name="checkmark" size={11} color="#fff" />}
      </View>

      <View style={s.body}>
        <View style={s.keyRow}>
          <Text style={s.key}>{issue.key}</Text>
          {issue.priority && (
            <View style={s.priorityChip}>
              <Text style={s.chipText}>{issue.priority}</Text>
            </View>
          )}
        </View>

        <Text style={s.summary}>
          {issue.sortFieldValue
            ? <Text style={s.sortValue}>{issue.sortFieldValue} · </Text>
            : null}
          {issue.summary}
        </Text>

        <View style={s.meta}>
          {issue.project && (
            <View style={s.chip}>
              <Text style={s.chipText}>{issue.project}</Text>
            </View>
          )}
          {issue.updated && (
            <Text style={s.dateText}>{relativeTime(issue.updated)}</Text>
          )}
        </View>

        <TouchableOpacity style={s.link} onPress={() => Linking.openURL(issue.url)}>
          <Ionicons name="open-outline" size={11} color={C.accent} />
          <Text style={s.linkText}>Open in Jira</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const makeStyles = (C) => StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: C.surface,
    marginHorizontal: 12, marginVertical: 4,
    borderRadius: 6, padding: 12,
    borderWidth: 1, borderColor: C.border,
  },
  cardSelected: { borderColor: C.accent, backgroundColor: C.accentDim },
  checkBox: {
    width: 17, height: 17, borderRadius: 3,
    borderWidth: 1.5, borderColor: C.border2,
    marginRight: 11, marginTop: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  checkBoxSelected: { backgroundColor: C.accent, borderColor: C.accent },
  body: { flex: 1 },
  keyRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 3 },
  key: { color: C.jira, fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  priorityChip: {
    backgroundColor: C.accentDim, borderRadius: 3,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  summary: { color: C.text, fontSize: 13, lineHeight: 18, marginBottom: 7 },
  sortValue: { color: C.subtext },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 7, alignItems: 'center' },
  chip: {
    backgroundColor: C.surfaceElevated, borderRadius: 3,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  chipText: { color: C.subtext, fontSize: 10 },
  dateText: { color: C.muted, fontSize: 10 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start' },
  linkText: { color: C.accent, fontSize: 11 },
});
