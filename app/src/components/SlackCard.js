import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { relativeTime, importanceLabelColor, importanceLabelBg } from '../utils/helpers';

/** Convert Slack mrkdwn markup to readable plain text */
function cleanSlackText(text) {
  return text
    .replace(/<@[A-Z0-9]+>/g, '@user')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<#[A-Z0-9]+>/g, '#channel')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

export default function SlackCard({ message, selected, onToggle }) {
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);

  const preview = cleanSlackText(message.text).slice(0, 140);
  const time = relativeTime(new Date(parseFloat(message.ts) * 1000).toISOString());
  const labelColor = importanceLabelColor(message.importanceLabel, C);
  const labelBg    = importanceLabelBg(message.importanceLabel, C);

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
        <View style={s.metaRow}>
          <View style={s.channelChip}>
            <Text style={s.channelText}>#{message.channelName}</Text>
          </View>
          <View style={[s.importanceChip, { backgroundColor: labelBg }]}>
            <Text style={[s.importanceText, { color: labelColor }]}>
              {message.importanceLabel}
            </Text>
          </View>
          <Text style={s.timeText}>{time}</Text>
        </View>

        {!!message.context && (
          <View style={s.aiRow}>
            <Text style={s.aiLabel}>Context</Text>
            <Text style={s.aiText} numberOfLines={2}>{message.context}</Text>
          </View>
        )}
        {!!message.summary && (
          <View style={s.aiRow}>
            <Text style={[s.aiLabel, s.aiLabelAction]}>Action</Text>
            <Text style={[s.aiText, s.aiTextAction]} numberOfLines={2}>{message.summary}</Text>
          </View>
        )}

        <Text style={s.preview} numberOfLines={3}>{preview}</Text>

        {message.reasons.length > 0 && (
          <Text style={s.reasons} numberOfLines={1}>
            {message.reasons.slice(0, 2).map(r => `· ${r}`).join(' ')}
          </Text>
        )}

        {message.url && (
          <TouchableOpacity style={s.link} onPress={() => Linking.openURL(message.url)}>
            <Ionicons name="open-outline" size={11} color={C.accent} />
            <Text style={s.linkText}>Open in Slack</Text>
          </TouchableOpacity>
        )}
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
  cardSelected: { borderColor: C.success, backgroundColor: C.successDim },
  checkBox: {
    width: 17, height: 17, borderRadius: 3,
    borderWidth: 1.5, borderColor: C.border2,
    marginRight: 11, marginTop: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  checkBoxSelected: { backgroundColor: C.success, borderColor: C.success },
  body: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 7, flexWrap: 'wrap' },
  channelChip: {
    backgroundColor: C.accentDim, borderRadius: 3,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  channelText: { color: C.accent, fontSize: 10, fontWeight: '600' },
  importanceChip: { borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2 },
  importanceText: { fontSize: 10, fontWeight: '600' },
  timeText: { color: C.muted, fontSize: 10 },
  aiRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginBottom: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: C.surfaceElevated || C.bg,
  },
  aiLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: C.accent,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    minWidth: 42,
    paddingTop: 1,
  },
  aiLabelAction: {
    color: C.success || '#4caf50',
  },
  aiText: {
    flex: 1,
    fontSize: 11,
    color: C.accent,
    lineHeight: 15,
  },
  aiTextAction: {
    color: C.success || '#4caf50',
  },
  preview: { color: C.text, fontSize: 13, lineHeight: 18, marginBottom: 5 },
  reasons: { color: C.subtext, fontSize: 10, marginBottom: 5 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start' },
  linkText: { color: C.accent, fontSize: 11 },
});
