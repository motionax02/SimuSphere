'use strict';

const express  = require('express');
const Groq     = require('groq-sdk');
const fs       = require('fs');
const path     = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const groq       = new Groq({ apiKey: process.env.GROQ_API_KEY });
const KB_PATH    = path.join(__dirname, 'knowledge.json');
const PASS_PATH  = path.join(__dirname, 'admin_pass.txt');
const STATS_PATH = path.join(__dirname, 'stats.json');

const MAX_Q_LEN  = 500;
const MAX_NM_LEN = 100;
const NAME_REGEX = /^[a-zA-Z0-9\s\-_().,']+$/;

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateMap = new Map();
function rateLimit(req, res, next) {
  const ip  = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = rateMap.get(ip) || { count: 0, start: now };
  if (now - rec.start > 60_000) { rec.count = 0; rec.start = now; }
  rec.count++;
  rateMap.set(ip, rec);
  if (rec.count > 30) return res.status(429).json({ error: 'Too many requests.' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateMap)
    if (now - rec.start > 60_000) rateMap.delete(ip);
}, 300_000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
}
function getPassword() {
  try { return fs.readFileSync(PASS_PATH, 'utf8').trim(); }
  catch { return process.env.ADMIN_PASSWORD || 'SimuSphere2025'; }
}
function sanitizeStr(val, max = 1000) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, max);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function recordQuestion(component, question) {
  try {
    const s = readJSON(STATS_PATH, { total: 0, components: {}, recent: [] });
    s.total = (s.total || 0) + 1;
    s.components[component] = (s.components[component] || 0) + 1;
    s.recent.unshift({ component, question: question.slice(0, 120), time: new Date().toISOString() });
    if (s.recent.length > 200) s.recent.length = 200;
    s.lastActivity = new Date().toISOString();
    writeJSON(STATS_PATH, s);
  } catch(e) { console.error('Stats error:', e.message); }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== getPassword())
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Admin: Knowledge ──────────────────────────────────────────────────────────
app.get('/admin/knowledge', adminAuth, (req, res) => res.json(readJSON(KB_PATH, {})));

app.post('/admin/knowledge', adminAuth, (req, res) => {
  const name = sanitizeStr(req.body.name, MAX_NM_LEN);
  if (!name)                  return res.status(400).json({ error: 'Component name required' });
  if (!NAME_REGEX.test(name)) return res.status(400).json({ error: 'Invalid component name' });

  const kb = readJSON(KB_PATH, {});
  kb[name] = {
    info:        sanitizeStr(req.body.info, 8000),
    restrictToKB: req.body.restrictToKB === true,
    buttons: (Array.isArray(req.body.buttons) ? req.body.buttons : [])
      .slice(0, 20)
      .map(b => ({
        label:    sanitizeStr(b.label,    80),
        question: sanitizeStr(b.question, 300),
      }))
      .filter(b => b.label && b.question),
  };
  try { writeJSON(KB_PATH, kb); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to save' }); }
});

app.delete('/admin/knowledge/:name', adminAuth, (req, res) => {
  const name = sanitizeStr(decodeURIComponent(req.params.name), MAX_NM_LEN);
  const kb   = readJSON(KB_PATH, {});
  if (!Object.prototype.hasOwnProperty.call(kb, name))
    return res.status(404).json({ error: 'Not found' });
  delete kb[name];
  try { writeJSON(KB_PATH, kb); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to save' }); }
});

// ── Admin: Stats ──────────────────────────────────────────────────────────────
app.get('/admin/stats', adminAuth, (req, res) =>
  res.json(readJSON(STATS_PATH, { total: 0, components: {}, recent: [], lastActivity: null })));

app.delete('/admin/stats', adminAuth, (req, res) => {
  try { writeJSON(STATS_PATH, { total: 0, components: {}, recent: [], lastActivity: null }); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to clear' }); }
});

// ── Admin: Password ───────────────────────────────────────────────────────────
app.post('/admin/change-password', adminAuth, (req, res) => {
  const pw = sanitizeStr(req.body.newPassword, 100);
  if (pw.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
  try { fs.writeFileSync(PASS_PATH, pw, 'utf8'); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to update' }); }
});

// ── Admin: Export / Import ────────────────────────────────────────────────────
app.get('/admin/export', adminAuth, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="simusphere-kb.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(readJSON(KB_PATH, {}), null, 2));
});

app.post('/admin/import', adminAuth, (req, res) => {
  const data = req.body;
  if (typeof data !== 'object' || Array.isArray(data) || !data)
    return res.status(400).json({ error: 'Invalid format' });
  try { writeJSON(KB_PATH, data); res.json({ ok: true, count: Object.keys(data).length }); }
  catch { res.status(500).json({ error: 'Failed to import' }); }
});

// ── Admin: PDF Extract ────────────────────────────────────────────────────────
app.post('/admin/extract-pdf', adminAuth, async (req, res) => {
  const text = sanitizeStr(req.body.pdfText, 15000);
  const name = sanitizeStr(req.body.componentName, MAX_NM_LEN);
  if (!text) return res.status(400).json({ error: 'No PDF text provided' });
  if (!name) return res.status(400).json({ error: 'Component name required' });
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 800,
      messages: [{
        role: 'system',
        content: `Extract structured information from a technical document and return ONLY valid JSON:
{"info":"General description (max 400 words)","buttons":[{"label":"Short label","question":"Full question to ask AI"}]}
Max 6 buttons. Return ONLY the JSON, no markdown, no explanation.`,
      }, {
        role: 'user',
        content: `Component: ${name}\n\nDocument:\n${text}`,
      }],
    });
    const raw     = completion.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const data    = JSON.parse(cleaned);
    res.json({ ok: true, data });
  } catch(e) {
    console.error('PDF extract error:', e.message);
    res.status(500).json({ error: 'Extraction failed — try again' });
  }
});

// ── Public: Component buttons ─────────────────────────────────────────────────
app.get('/component/:name', (req, res) => {
  const name = sanitizeStr(decodeURIComponent(req.params.name), MAX_NM_LEN);
  const kb   = readJSON(KB_PATH, {});
  const comp = Object.prototype.hasOwnProperty.call(kb, name) ? kb[name] : null;
  res.json({ buttons: comp?.buttons || [] });
});

// ── Public: Ask AI ────────────────────────────────────────────────────────────
app.post('/ask', rateLimit, async (req, res) => {
  const question  = sanitizeStr(req.body.question,  MAX_Q_LEN);
  const component = sanitizeStr(req.body.component, MAX_NM_LEN);
  if (!question)  return res.status(400).json({ error: 'Question required' });
  if (!component) return res.status(400).json({ error: 'Component required' });

  const kb   = readJSON(KB_PATH, {});
  const comp = Object.prototype.hasOwnProperty.call(kb, component) ? kb[component] : null;
  const hasKB      = comp?.info?.length > 0;
  const restrictToKB = comp?.restrictToKB === true;

  const lines = [
    'You are VIS-7, an AI training assistant for vessel components at Saudi Aramco CGPD.',
    `The trainee is viewing: ${component}.`,
  ];

  if (hasKB && restrictToKB) {
    lines.push('IMPORTANT: Answer ONLY using the information below. If the answer is not found, say: "This information is not available in the component knowledge base."');
    lines.push(`Component knowledge:\n${comp.info}`);
  } else if (hasKB) {
    lines.push(`Specific knowledge about this component:\n${comp.info}`);
  }

  lines.push('Answer in the same language the user asks in. Be educational, clear, and concise (under 150 words).');

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        { role: 'system', content: lines.join('\n') },
        { role: 'user',   content: question },
      ],
    });
    const answer = completion.choices?.[0]?.message?.content?.trim() || 'No response.';
    recordQuestion(component, question);
    res.json({ answer });
  } catch(e) {
    console.error('Groq error:', e.message);
    res.status(502).json({ answer: 'AI service unavailable. Please try again.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SimuSphere running on port ${PORT}`));
