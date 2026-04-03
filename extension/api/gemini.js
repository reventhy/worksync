/**
 * Enrich Slack messages with AI-generated context and summary using Groq API (free tier).
 * Uses llama-3.3-70b-versatile with JSON mode. Free: 30 RPM, 14,400 RPD.
 * Processes in batches of 10 for reliable JSON output.
 */

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const BATCH_SIZE = 10;

/** Save Groq rate-limit headers to chrome.storage for cross-device display */
function _saveRateLimits(headers) {
  try {
    const info = {
      limitRequests:      headers.get('x-ratelimit-limit-requests')     || '',
      remainingRequests:  headers.get('x-ratelimit-remaining-requests') || '',
      limitTokens:        headers.get('x-ratelimit-limit-tokens')       || '',
      remainingTokens:    headers.get('x-ratelimit-remaining-tokens')   || '',
      resetRequests:      headers.get('x-ratelimit-reset-requests')     || '',
      resetTokens:        headers.get('x-ratelimit-reset-tokens')       || '',
      updatedAt:          new Date().toISOString(),
    };
    chrome.storage.local.set({ aiRateLimit: info });
  } catch { /* best-effort */ }
}

/**
 * Enrich an array of Slack messages with AI context and summary.
 * @param {string} apiKey - Groq API key (gsk_...)
 * @param {Array} messages - Array of {channelName, text, importanceLabel, reasons}
 * @returns {Promise<Array>} - Messages with added context and summary fields
 */
export async function enrichSlackMessages(apiKey, messages) {
  if (!apiKey || !messages.length) return messages;

  const result = [...messages];

  for (let start = 0; start < messages.length; start += BATCH_SIZE) {
    const batch = messages.slice(start, start + BATCH_SIZE);
    const enriched = await enrichBatch(apiKey, batch);
    for (let j = 0; j < enriched.length; j++) {
      result[start + j] = enriched[j];
    }
  }

  return result;
}

/**
 * Enrich a single batch of messages via Groq API (OpenAI-compatible).
 * @param {string} apiKey
 * @param {Array} batch
 * @returns {Promise<Array>}
 */
async function enrichBatch(apiKey, batch) {
  try {
    const msgList = batch.map((m, i) => {
      const clean = m.text.replace(/<[^>]+>/g, '').slice(0, 300);
      return `[${i}] #${m.channelName} (${m.importanceLabel}): ${clean}`;
    }).join('\n');

    const prompt = `You are a work assistant analyzing Slack messages for a busy professional.

For EACH message below, provide:
- "context": A brief description of what this message is about (1 sentence, max 15 words)
- "summary": What action or response is needed from me? (1 sentence, max 15 words)

IMPORTANT: Always provide context and summary for every message. Only set both to "" if the message is completely empty or pure bot noise with zero informational value.

Messages:
${msgList}

Respond ONLY with a JSON array of exactly ${batch.length} elements. Each element must have "index" (number), "context" (string), and "summary" (string).
Example: [{"index":0,"context":"Team discussing deployment timeline","summary":"Review and confirm the release date"}]`;

    const res = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn('[WorkSync] Groq API error:', res.status, errText.slice(0, 200));
      return batch;
    }

    // Capture rate limit headers and persist
    _saveRateLimits(res.headers);

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      console.warn('[WorkSync] Groq returned no content. Finish reason:', data.choices?.[0]?.finish_reason);
      return batch;
    }

    // Groq with json_object mode may wrap in an object — handle both array and {items: [...]}
    const parsed = JSON.parse(text);
    const enrichments = Array.isArray(parsed) ? parsed : (parsed.items || parsed.messages || parsed.results || Object.values(parsed)[0]);

    if (!Array.isArray(enrichments)) {
      console.warn('[WorkSync] Groq returned unexpected JSON shape:', text.slice(0, 100));
      return batch;
    }

    return batch.map((msg, i) => {
      const e = enrichments.find(x => x.index === i);
      return {
        ...msg,
        context: e?.context || '',
        summary: e?.summary || '',
      };
    });
  } catch (e) {
    console.warn('[WorkSync] Groq batch enrichment failed:', e.message);
    return batch;
  }
}
