const URGENT_PATTERNS = [
  /\burgent\b/i,
  /\basap\b/i,
  /\bblocker\b/i,
  /\bhigh priority\b/i,
  /\bneed(ing)? review\b/i,
  /\btoday\b/i,
  /\beod\b/i,
  /\bdeadline\b/i,
  /\bship\b/i,
];

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function labelForScore(score) {
  if (score >= 10) return 'Critical';
  if (score >= 7) return 'High';
  if (score >= 3) return 'Medium';
  return 'Low';
}

function countBotMentions(rawContent, botUserId) {
  if (!botUserId) return 0;
  const matches = String(rawContent || '').match(new RegExp(`<@!?${botUserId}>`, 'g'));
  return matches ? matches.length : 0;
}

export function scoreDiscordMessage(message, { botUserId, vipUserIds = [] }) {
  const text = cleanText(message.cleanContent || message.content);
  const lower = text.toLowerCase();
  const botMentionCount = countBotMentions(message.content, botUserId);
  let score = 0;
  const reasons = [];

  if (vipUserIds.includes(message.author.id)) {
    score += 15;
    reasons.push('VIP sender');
  }

  if (!message.guildId) {
    score += 10;
    reasons.push('Direct message');
  }

  if (botMentionCount > 0) {
    score += 12 + Math.min(6, Math.max(0, botMentionCount - 1) * 2);
    reasons.push('Mentioned bot');
  }

  if (message.mentions.everyone) {
    score += 5;
    reasons.push('@everyone / @here');
  }

  if (text.includes('?')) {
    score += 6;
    reasons.push('Question');
  }

  if (URGENT_PATTERNS.some((pattern) => pattern.test(lower))) {
    score += 5;
    reasons.push('Urgent wording');
  }

  if (message.attachments.size > 0) {
    score += 3;
    reasons.push('Attachment');
  }

  if (message.reference?.messageId) {
    score += 2;
    reasons.push('Reply');
  }

  if (Date.now() - message.createdTimestamp < 15 * 60 * 1000) {
    score += 2;
    reasons.push('Recent');
  }

  return {
    score,
    label: labelForScore(score),
    reasons: reasons.slice(0, 4),
    botMentionCount,
    mentionsBot: botMentionCount > 0,
  };
}

export function normalizeDiscordMessage(message, scoring) {
  const text = cleanText(message.cleanContent || message.content);
  const authorName = message.member?.displayName || message.author.globalName || message.author.username;
  const channelName = message.guildId ? (message.channel.name || message.channelId) : 'dm';
  const url = message.guildId
    ? `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
    : `https://discord.com/channels/@me/${message.channelId}/${message.id}`;

  return {
    source: 'discord',
    messageId: message.id,
    ts: String(message.createdTimestamp),
    text: clip(text, 900),
    excerpt: clip(text, 220),
    user: message.author.id,
    userName: authorName,
    authorAvatarUrl: message.author.displayAvatarURL(),
    guildId: message.guildId || null,
    guildName: message.guild?.name || null,
    channelId: message.channelId,
    channelName,
    isDM: !message.guildId,
    importance: scoring.score,
    importanceLabel: scoring.label,
    reasons: scoring.reasons,
    mentionsBot: scoring.mentionsBot,
    botMentionCount: scoring.botMentionCount,
    mentionCount: message.mentions.users.size,
    attachmentCount: message.attachments.size,
    url,
  };
}

export function buildDiscordMentionsSummary(messages = []) {
  const mentionMessages = messages.filter((message) => message.mentionsBot);
  const directMessages = messages.filter((message) => message.isDM);

  const users = new Map();
  const channels = new Map();

  for (const message of mentionMessages) {
    const userKey = message.user;
    const channelKey = `${message.guildId || 'dm'}:${message.channelId}`;

    const userEntry = users.get(userKey) || {
      userId: message.user,
      userName: message.userName || message.user,
      mentionMessages: 0,
      botMentionCount: 0,
      lastMentionAt: null,
      lastMessageText: '',
      lastMessageUrl: null,
      guildName: message.guildName || null,
      channelName: message.channelName,
    };
    userEntry.mentionMessages += 1;
    userEntry.botMentionCount += Number(message.botMentionCount || 0);
    if (!userEntry.lastMentionAt || Number(message.ts) > Number(userEntry.lastMentionAt)) {
      userEntry.lastMentionAt = message.ts;
      userEntry.lastMessageText = message.excerpt || message.text || '';
      userEntry.lastMessageUrl = message.url || null;
      userEntry.guildName = message.guildName || null;
      userEntry.channelName = message.channelName;
    }
    users.set(userKey, userEntry);

    const channelEntry = channels.get(channelKey) || {
      guildId: message.guildId || null,
      guildName: message.guildName || null,
      channelId: message.channelId,
      channelName: message.channelName,
      mentionMessages: 0,
      botMentionCount: 0,
      lastMentionAt: null,
    };
    channelEntry.mentionMessages += 1;
    channelEntry.botMentionCount += Number(message.botMentionCount || 0);
    if (!channelEntry.lastMentionAt || Number(message.ts) > Number(channelEntry.lastMentionAt)) {
      channelEntry.lastMentionAt = message.ts;
    }
    channels.set(channelKey, channelEntry);
  }

  const byMentionRank = (a, b) =>
    b.botMentionCount - a.botMentionCount ||
    b.mentionMessages - a.mentionMessages ||
    Number(b.lastMentionAt || 0) - Number(a.lastMentionAt || 0);

  return {
    mentionMessagesCount: mentionMessages.length,
    totalBotMentionCount: mentionMessages.reduce((sum, message) => sum + Number(message.botMentionCount || 0), 0),
    directMessagesCount: directMessages.length,
    lastMentionAt: mentionMessages[0]?.ts || null,
    topUsers: [...users.values()].sort(byMentionRank).slice(0, 5),
    topChannels: [...channels.values()].sort(byMentionRank).slice(0, 5),
    recentMentions: mentionMessages
      .slice(0, 8)
      .map((message) => ({
        messageId: message.messageId,
        ts: message.ts,
        userId: message.user,
        userName: message.userName || message.user,
        guildName: message.guildName || null,
        channelName: message.channelName,
        botMentionCount: Number(message.botMentionCount || 0),
        excerpt: message.excerpt || message.text || '',
        url: message.url || null,
      })),
  };
}
