export class SlackAPI {
  constructor({ token }) {
    this.token = token;
    this.base = 'https://slack.com/api';
  }

  async fetch(method, params = {}) {
    const url = new URL(`${this.base}/${method}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    return data;
  }

  async getUnreadMessages({ myUserId, vipUserIds = [], maxChannels = 20 } = {}) {
    const debug = { myUserId, method: null, channelsFound: 0, channelsScanned: 0, messagesChecked: 0, zeroScore: 0, scopeErrors: [] };

    const results = [];
    const seen = new Set();
    const lookbackDays = 7;
    const afterDate = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000).toISOString().split('T')[0];

    // ── Strategy 1: search.messages (user tokens with search:read scope) ────────
    let searchWorked = false;
    if (myUserId) {
      try {
        const queries = [
          `<@${myUserId}> after:${afterDate}`,
          `to:${myUserId} after:${afterDate}`,
        ];
        for (const query of queries) {
          const data = await this.fetch('search.messages', { query, count: 50, sort: 'timestamp', sort_dir: 'desc' });
          for (const match of data.messages?.matches || []) {
            if (seen.has(match.ts)) continue;
            seen.add(match.ts);
            debug.messagesChecked++;
            const fakeChannel = { is_im: match.channel?.is_im, is_mpim: match.channel?.is_mpim };
            const importance = scoreImportance({ text: match.text, ts: match.ts, user: match.username, reactions: match.reactions }, myUserId, fakeChannel, vipUserIds);
            if (importance.score === 0) { debug.zeroScore++; continue; }
            results.push({
              channelId: match.channel?.id,
              channelName: match.channel?.name || match.channel?.id || 'dm',
              isDM: match.channel?.is_im || match.channel?.is_mpim || false,
              ts: match.ts,
              text: match.text || '',
              user: match.user || match.username,
              importance: importance.score,
              importanceLabel: importance.label,
              reasons: importance.reasons,
              url: match.permalink || null,
            });
          }
        }
        searchWorked = true;
        debug.method = 'search.messages';
      } catch (e) {
        debug.scopeErrors.push(`search: ${e.message}`);
      }
    }

    // ── Strategy 2: scan DM channels — almost always accessible ─────────────────
    try {
      let cursor = null;
      const dmChannels = [];
      do {
        const res = await this.fetch('users.conversations', {
          types: 'im,mpim',
          exclude_archived: true,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        dmChannels.push(...(res.channels || []));
        cursor = res.response_metadata?.next_cursor || null;
      } while (cursor);

      debug.channelsFound = dmChannels.length;
      const lookbackOldest = String((Date.now() / 1000) - lookbackDays * 24 * 3600);

      for (const channel of dmChannels) {
        debug.channelsScanned++;
        try {
          const history = await this.fetch('conversations.history', { channel: channel.id, limit: 30, oldest: lookbackOldest });
          for (const msg of history.messages || []) {
            if (msg.type !== 'message' || msg.subtype) continue;
            if (msg.user === myUserId) continue;
            if (seen.has(msg.ts)) continue;
            seen.add(msg.ts);
            debug.messagesChecked++;
            const importance = scoreImportance(msg, myUserId, channel, vipUserIds);
            if (importance.score === 0) { debug.zeroScore++; continue; }
            results.push({
              channelId: channel.id,
              channelName: channel.name || 'dm',
              isDM: true,
              ts: msg.ts,
              text: msg.text || '',
              user: msg.user,
              importance: importance.score,
              importanceLabel: importance.label,
              reasons: importance.reasons,
              url: null,
            });
          }
        } catch (e) {
          debug.scopeErrors.push(`dm-${channel.id}: ${e.message}`);
        }
      }
      if (!searchWorked) debug.method = 'dm-scan-only';
    } catch (e) {
      debug.scopeErrors.push(`users.conversations(im): ${e.message}`);
    }

    results.sort((a, b) => b.importance - a.importance || b.ts - a.ts);
    return { messages: results.slice(0, 30), debug };
  }

  async getWorkspaceInfo() {
    try {
      const data = await this.fetch('auth.test');
      return { url: data.url, team: data.team, userId: data.user_id };
    } catch {
      return null;
    }
  }

  async postMessage({ channel, text, blocks, username, iconEmoji }) {
    const res = await fetch(`${this.base}/chat.postMessage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        text,
        ...(blocks ? { blocks } : {}),
        ...(username ? { username } : {}),
        ...(iconEmoji ? { icon_emoji: iconEmoji } : {}),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack post error: ${data.error}`);
    return data;
  }

  async postDailyReport({ channel, jiraIssues, slackMessages, botName = 'WorkSync Bot' }) {
    const jiraBlocks = jiraIssues.length
      ? [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*📋 Jira — Needs Your Review (${jiraIssues.length})*`,
            },
          },
          ...jiraIssues.slice(0, 10).map(issue => ({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `• <${issue.url}|${issue.key}> — ${issue.summary}\n  _${issue.project} · ${issue.priority}_`,
            },
          })),
        ]
      : [];

    const urgentSlack = slackMessages.filter(m => m.importance >= 7).slice(0, 5);
    const slackBlocks = urgentSlack.length
      ? [
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*💬 Important Slack Messages (${urgentSlack.length})*`,
            },
          },
          ...urgentSlack.map(msg => ({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `• *#${msg.channelName}* [${msg.importanceLabel}] — ${msg.text
                .slice(0, 100)
                .replace(/\n/g, ' ')}${msg.url ? ` (<${msg.url}|view>)` : ''}`,
            },
          })),
        ]
      : [];

    const hasItems = jiraIssues.length > 0 || urgentSlack.length > 0;
    const summary = hasItems
      ? `WorkSync Daily Report — ${jiraIssues.length} Jira review(s), ${urgentSlack.length} important Slack message(s)`
      : 'WorkSync Daily Report — Nothing needs your attention today 🎉';

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🔄 WorkSync Daily Report', emoji: true },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Generated at ${new Date().toLocaleString()}` }],
      },
      { type: 'divider' },
      ...(hasItems
        ? [...jiraBlocks, ...slackBlocks]
        : [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: ':white_check_mark: Nothing needs your attention today!' },
            },
          ]),
    ];

    return this.postMessage({ channel, text: summary, blocks, username: botName, iconEmoji: ':arrows_counterclockwise:' });
  }
}

export function scoreImportance(message, myUserId, channel, vipUserIds = []) {
  const text = (message.text || '').toLowerCase();
  const rawText = message.text || '';
  let score = 0;
  const reasons = [];

  if (vipUserIds.includes(message.user)) {
    score += 15;
    reasons.push('VIP sender');
  }
  if (myUserId && rawText.includes(`<@${myUserId}>`)) {
    score += 12;
    reasons.push('Mentioned you');
  }
  if (channel?.is_im) {
    score += 10;
    reasons.push('Direct message');
  }
  if (text.includes('?')) {
    score += 8;
    reasons.push('Question');
  }
  if (text.includes('<!here>') || text.includes('<!channel>')) {
    score += 5;
    reasons.push('@here / @channel');
  }
  const urgentKeywords = ['urgent', 'asap', 'immediately', 'critical', 'blocker', 'blocked', 'p0', 'p1'];
  for (const kw of urgentKeywords) {
    if (text.includes(kw)) {
      score += 6;
      reasons.push(`Urgency keyword: "${kw}"`);
      break;
    }
  }
  const importantKeywords = [
    'important', 'deadline', 'due today', 'due tomorrow', 'review', 'approval',
    'approve', 'sign off', 'help needed', 'need help', 'feedback',
  ];
  for (const kw of importantKeywords) {
    if (text.includes(kw)) {
      score += 3;
      reasons.push(`Keyword: "${kw}"`);
      break;
    }
  }
  const urgentEmojis = ['fire', 'sos', 'rotating_light', 'warning', 'exclamation', 'red_circle', 'bangbang'];
  for (const reaction of message.reactions || []) {
    if (urgentEmojis.includes(reaction.name)) {
      score += 4;
      reasons.push(`Reaction: :${reaction.name}:`);
      break;
    }
  }
  const ageMinutes = (Date.now() / 1000 - parseFloat(message.ts)) / 60;
  if (ageMinutes < 120 && score > 0) {
    score += 2;
    reasons.push('Recent (< 2h)');
  }

  const label =
    score >= 12 ? 'Critical' : score >= 7 ? 'High' : score >= 3 ? 'Medium' : 'Low';

  return { score, label, reasons };
}
