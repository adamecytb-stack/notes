/**
 * Stands in for the Gemini API so the /api/ai path can be tested end to end
 * without a real key or a network call.
 *
 * Recognises a few magic prompts to exercise the failure branches:
 *   "TRIGGER_429"     -> rate limited
 *   "TRIGGER_404"     -> unknown model
 *   "TRIGGER_BLOCKED" -> safety block
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

    if (!/\/v1beta\/models\/[^:]+:generateContent$/.test(req.url)) {
      return send(404, { error: { message: 'bad path' } });
    }
    if (req.headers['x-goog-api-key'] !== 'stub-key') {
      return send(401, { error: { message: 'missing api key' } });
    }

    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { error: { message: 'bad json' } });
    }

    const prompt = body?.contents?.[0]?.parts?.[0]?.text || '';
    const system = body?.system_instruction?.parts?.[0]?.text || '';
    received.push({ prompt, system, url: req.url });

    if (prompt.includes('TRIGGER_429')) {
      return send(429, { error: { message: 'quota exhausted' } });
    }
    if (prompt.includes('TRIGGER_404')) {
      return send(404, { error: { message: 'model not found' } });
    }
    if (prompt.includes('TRIGGER_BLOCKED')) {
      return send(200, { promptFeedback: { blockReason: 'SAFETY' } });
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
