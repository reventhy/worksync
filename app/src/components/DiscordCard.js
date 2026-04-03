import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { relativeTime, importanceLabelColor, importanceLabelBg } from '../utils/helpers';

export default function DiscordCard({ message, selected, onToggle }) {
  const { colors: C } = useTheme();
  const s = useMemo(() => makeStyles(C), [C]);

  const preview = String(message.excerpt || message.text || '').trim().slice(0, 160);
  const time = relativeTime(new Date(Number(message.ts)).toISOString());
  const labelColor = importanceLabelColor(message.importanceLabel, C);
  const labelBg = importanceLabelBg(message.importanceLabel, C);
  const scopeLabel = message.isDM
    ? `DM • ${message.userName || 'Unknown user'}`
    : `${message.guildName || 'Discord'} • #${message.channelName}`;

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
          <View style={s.scopeChip}>
            <Ionicons name={message.isDM ? 'mail-outline' : 'logo-discord'} size={10} color={C.accent} />
            <Text style={s.scopeText}>{scopeLabel}</Text>
          </View>
          <View style={[s.importanceChip, { backgroundColor: labelBg }]}>
            <Text style={[s.importanceText, { color: labelColor }]}>
              {message.importanceLabel}
            </Text>
          </View>
          <Text style={s.timeText}>{time}</Text>
        </View>

        <Text style={s.author}>{message.userName || message.user}</Text>
        <Text style={s.preview} numberOfLines={4}>{preview}</Text>

        {!!message.reasons?.length && (
          <Text style={s.reasons} numberOfLines={2}>
            {message.reasons.slice(0, 3).map(r => `· ${r}`).join(' ')}
          </Text>
        )}

        {message.url && (
          <TouchableOpacity style={s.link} onPress={() => Linking.openURL(message.url)}>
            <Ionicons name="open-outline" size={11} color={C.accent} />
            <Text style={s.linkText}>Open in Discord</Text>
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
    marginHorizontal: 12,
    marginVertical: 4,
    borderRadius: 6,
    padding: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  cardSelected: { borderColor: C.accent, backgroundColor: C.accentDim },
  checkBox: {
    width: 17,
    height: 17,
    borderRadius: 3,
    borderWidth: 1.5,
    borderColor: C.border2,
    marginRight: 11,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkBoxSelected: { backgroundColor: C.accent, borderColor: C.accent },
  body: { flex: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 7, flexWrap: 'wrap' },
  scopeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: C.accentDim,
    borderRadius: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  scopeText: { color: C.accent, fontSize: 10, fontWeight: '600' },
  importanceChip: { borderRadius: 3, paddingHorizontal: 6, paddingVertical: 2 },
  importanceText: { fontSize: 10, fontWeight: '600' },
  timeText: { color: C.muted, fontSize: 10 },
  author: { color: C.subtext, fontSize: 11, marginBottom: 5, fontWeight: '600' },
  preview: { color: C.text, fontSize: 13, lineHeight: 18, marginBottom: 5 },
  reasons: { color: C.subtext, fontSize: 10, marginBottom: 5 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start' },
  linkText: { color: C.accent, fontSize: 11 },
});
