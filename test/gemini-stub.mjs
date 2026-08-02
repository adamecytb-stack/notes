/**
 * Stands in for the Gemini API so the /api/ai path can be tested end to end
 * without a real key or a network call.
 *
 * Recognises magic prompts to exercise the failure branches:
 *   "TRIGGER_429"                  -> rate limited
 *   "TRIGGER_404"                  -> unknown model
 *   "TRIGGER_BLOCKED"              -> prompt blocked before generation
 *   "TRIGGER_THOUGHT_ALL_TOKENS"   -> 200, candidate with no parts, MAX_TOKENS
 *   "TRIGGER_CANDIDATE_SAFETY"     -> 200, candidate stopped for safety
 *   "TRIGGER_TRUNCATED"            -> 200, partial answer, MAX_TOKENS
 *   "TRIGGER_NO_THINKING_SUPPORT"  -> 400 unless thinkingConfig is dropped
 *
 * GET /__last returns what the worker actually sent, so a test can check the
 * system prompt is really arriving rather than assuming it is.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT || 8788);
export const received = [];

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (/\/__last$/.test(req.url)) {
      return send(200, received[received.length - 1] || {});
    }
    if (req.headers['x-goog-api-key'] !== 'stub-key') {
      return send(401, { error: { message: 'missing api key' } });
    }

    // The model list, which the worker reads to explain a 404 usefully.
    if (/\/v1beta\/models$/.test(req.url)) {
      return send(200, {
        models: [
          { name: 'models/gemini-stub-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-stub-flash-lite', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embed-only', supportedGenerationMethods: ['embedContent'] },
        ],
      });
    }

    if (!/\/v1beta\/models\/[^:]+:generateContent$/.test(req.url)) {
      return send(404, { error: { message: 'bad path' } });
    }

    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { error: { message: 'bad json' } });
    }

    const prompt = body?.contents?.[0]?.parts?.[0]?.text || '';
    // The REST API takes either spelling; accept both so the stub cannot
    // silently stop seeing the system prompt when the worker changes one.
    const systemPart = body?.systemInstruction || body?.system_instruction;
    const system = systemPart?.parts?.[0]?.text || '';
    const thinking = body?.generationConfig?.thinkingConfig;
    const maxTokens = body?.generationConfig?.maxOutputTokens;
    received.push({ prompt, system, thinking, maxTokens, url: req.url });

    if (prompt.includes('TRIGGER_429')) {
      return send(429, { error: { message: 'quota exhausted' } });
    }
    if (prompt.includes('TRIGGER_404')) {
      return send(404, { error: { message: 'model not found' } });
    }
    if (prompt.includes('TRIGGER_BLOCKED')) {
      return send(200, { promptFeedback: { blockReason: 'SAFETY' } });
    }
    /*
     * The quiet ones: a 200 carrying a candidate with no text at all. This is
     * what a thinking model does when it spends the whole output budget before
     * it starts writing, and it used to surface as a shrug.
     */
    if (prompt.includes('TRIGGER_THOUGHT_ALL_TOKENS')) {
      return send(200, {
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 900, thoughtsTokenCount: 1200, totalTokenCount: 2100 },
      });
    }
    if (prompt.includes('TRIGGER_CANDIDATE_SAFETY')) {
      return send(200, {
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }],
      });
    }
    if (prompt.includes('TRIGGER_TRUNCATED')) {
      return send(200, {
        candidates: [
          { content: { parts: [{ text: 'Začal som odpovedať a potom' }] }, finishReason: 'MAX_TOKENS' },
        ],
      });
    }
    if (prompt.includes('TRIGGER_NO_THINKING_SUPPORT')) {
      if (thinking) {
        return send(400, {
          error: { message: 'Unknown name "thinkingConfig": Cannot find field.' },
        });
      }
      return send(200, {
        candidates: [{ content: { parts: [{ text: 'Odpoveď bez premýšľania.' }] }, finishReason: 'STOP' }],
      });
    }

    send(200, {
      candidates: [
        {
          content: {
            parts: [
              { text: `Stub read ${prompt.length} characters.\n\nSecond paragraph.` },
            ],
          },
        },
      ],
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`gemini stub on :${PORT}`);
});

export default server;
