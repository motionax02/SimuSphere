'use strict';

const express  = require('express');
const Groq     = require('groq-sdk');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ── Paths & Constants ─────────────────────────────────────────────────────────
const groq       = new Groq({ apiKey: process.env.GROQ_API_KEY });
const KB_PATH    = path.join(__dirname, 'knowledge.json');
const PASS_PATH  = path.join(__dirname, 'admin_pass.txt');
const STATS_PATH = path.join(__dirname, 'stats.json');

const MAX_Q_LEN   = 500;
const MAX_NM_LEN  = 100;
const NAME_REGEX  = /^[a-zA-Z0-9\s\-_().,']+$/;

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const rateMap = new Map();
function rateLimit(req, res, next) {
  const ip  = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const rec = rateMap.get(ip) || { count: 0, start: now };
  if (now - rec.start > 60_000) { rec.count = 0; rec.start = now; }
  rec.count++;
  rateMap.set(ip, rec);
  if (rec.count > 30) return res.status(429).json({ error: 'Too many requests. Please wait.' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateMap)
    if (now - rec.start > 60_000) rateMap.delete(ip);
}, 300_000);

// ── File Helpers ──────────────────────────────────────────────────────────────
function readJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
function getPassword() {
  try { return fs.readFileSync(PASS_PATH, 'utf8').trim(); }
  catch { return process.env.ADMIN_PASSWORD || 'SimuSphere2025'; }
}

// ── Sanitizers ────────────────────────────────────────────────────────────────
function sanitizeStr(val, max = 1000) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, max);
}
function sanitizeArr(val, maxItems = 50, maxItem = 300) {
  if (!Array.isArray(val)) return [];
  return val.slice(0, maxItems).map(v => sanitizeStr(v, maxItem)).filter(Boolean);
}
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function recordQuestion(component, question) {
  try {
    const stats = readJSON(STATS_PATH, { totalQuestions: 0, components: {}, recentQuestions: [] });
    stats.totalQuestions = (stats.totalQuestions || 0) + 1;
    stats.components[component] = (stats.components[component] || 0) + 1;
    stats.recentQuestions = stats.recentQuestions || [];
    stats.recentQuestions.unshift({
      component,
      question: question.slice(0, 120),
      time: new Date().toISOString(),
    });
    if (stats.recentQuestions.length > 200) stats.recentQuestions.length = 200;
    stats.lastActivity = new Date().toISOString();
    writeJSON(STATS_PATH, stats);
  } catch (e) { console.error('Stats write error:', e.message); }
}

// ── Auth Middleware ───────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const provided = req.headers['x-admin-password'];
  if (!provided || provided !== getPassword())
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Admin: Knowledge ──────────────────────────────────────────────────────────
app.get('/admin/knowledge', adminAuth, (req, res) => {
  res.json(readJSON(KB_PATH, {}));
});

app.post('/admin/knowledge', adminAuth, (req, res) => {
  const name = sanitizeStr(req.body.name, MAX_NM_LEN);
  if (!name)               return res.status(400).json({ error: 'Component name required' });
  if (!NAME_REGEX.test(name)) return res.status(400).json({ error: 'Invalid component name characters' });

  const kb = readJSON(KB_PATH, {});
  kb[name] = {
    info:        sanitizeStr(req.body.info, 8000),
    checklist:   sanitizeArr(req.body.checklist),
    hazards:     sanitizeArr(req.body.hazards),
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
  catch { res.status(500).json({ error: 'Failed to save knowledge base' }); }
});

app.delete('/admin/knowledge/:name', adminAuth, (req, res) => {
  const name = sanitizeStr(decodeURIComponent(req.params.name), MAX_NM_LEN);
  const kb   = readJSON(KB_PATH, {});
  if (!Object.prototype.hasOwnProperty.call(kb, name))
    return res.status(404).json({ error: 'Component not found' });
  delete kb[name];
  try { writeJSON(KB_PATH, kb); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to save knowledge base' }); }
});

// ── Admin: Stats ──────────────────────────────────────────────────────────────
app.get('/admin/stats', adminAuth, (req, res) => {
  res.json(readJSON(STATS_PATH, { totalQuestions: 0, components: {}, recentQuestions: [], lastActivity: null }));
});

app.delete('/admin/stats', adminAuth, (req, res) => {
  try {
    writeJSON(STATS_PATH, { totalQuestions: 0, components: {}, recentQuestions: [], lastActivity: null });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Failed to clear stats' }); }
});

// ── Admin: Password ───────────────────────────────────────────────────────────
app.post('/admin/change-password', adminAuth, (req, res) => {
  const newPw = sanitizeStr(req.body.newPassword, 100);
  if (newPw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try { fs.writeFileSync(PASS_PATH, newPw, 'utf8'); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to update password' }); }
});

// ── Admin: Export / Import ────────────────────────────────────────────────────
app.get('/admin/export', adminAuth, (req, res) => {
  const kb = readJSON(KB_PATH, {});
  res.setHeader('Content-Disposition', 'attachment; filename="simusphere-kb.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(kb, null, 2));
});

app.post('/admin/import', adminAuth, (req, res) => {
  const data = req.body;
  if (typeof data !== 'object' || Array.isArray(data) || data === null)
    return res.status(400).json({ error: 'Invalid format — expected JSON object' });
  try {
    writeJSON(KB_PATH, data);
    res.json({ ok: true, count: Object.keys(data).length });
  } catch { res.status(500).json({ error: 'Failed to import' }); }
});

// ── Admin: PDF Extract ────────────────────────────────────────────────────────
app.post('/admin/extract-pdf', adminAuth, async (req, res) => {
  const { pdfText, componentName } = req.body;
  const text = sanitizeStr(pdfText, 15000);
  const name = sanitizeStr(componentName, MAX_NM_LEN);

  if (!text) return res.status(400).json({ error: 'No PDF text provided' });
  if (!name) return res.status(400).json({ error: 'Component name required' });

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1000,
      messages: [{
        role: 'system',
        content: `You are a technical knowledge extractor for Saudi Aramco vessel components.
Extract structured information from the provided text and return ONLY valid JSON in this exact format:
{
  "info": "General description of the component and its function (max 500 words)",
  "checklist": ["inspection item 1", "inspection item 2"],
  "hazards": ["safety hazard 1", "safety hazard 2"],
  "buttons": [{"label": "Short button label", "question": "Full question to ask AI"}]
}
Return ONLY the JSON object. No markdown, no explanation, no code blocks.`,
      }, {
        role: 'user',
        content: `Component: ${name}\n\nDocument text:\n${text}`,
      }],
    });

    const raw = completion.choices?.[0]?.message?.content || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(cleaned);
    res.json({ ok: true, data: extracted });
  } catch (e) {
    console.error('PDF extract error:', e.message);
    res.status(500).json({ error: 'Failed to extract — check PDF content and try again' });
  }
});

// ── Public: Component Buttons ─────────────────────────────────────────────────
app.get('/component/:name', (req, res) => {
  const name = sanitizeStr(decodeURIComponent(req.params.name), MAX_NM_LEN);
  const kb   = readJSON(KB_PATH, {});
  const comp = Object.prototype.hasOwnProperty.call(kb, name) ? kb[name] : null;
  if (!comp) return res.json({ buttons: [] });
  res.json({ buttons: comp.buttons || [] });
});

// ── Public: Ask AI ────────────────────────────────────────────────────────────
app.post('/ask', rateLimit, async (req, res) => {
  const question  = sanitizeStr(req.body.question,  MAX_Q_LEN);
  const component = sanitizeStr(req.body.component, MAX_NM_LEN);

  if (!question)  return res.status(400).json({ error: 'Question is required' });
  if (!component) return res.status(400).json({ error: 'Component is required' });

  const kb   = readJSON(KB_PATH, {});
  const comp = Object.prototype.hasOwnProperty.call(kb, component) ? kb[component] : null;

  const hasKB       = comp && (comp.info || (comp.checklist||[]).length || (comp.hazards||[]).length);
  const restrictToKB = comp?.restrictToKB === true;

  let systemPrompt;

  if (hasKB && restrictToKB) {
    // Strict mode — answer ONLY from provided knowledge
    const parts = [
      'You are VIS-7, an AI training assistant for vessel components at Saudi Aramco CGPD.',
      `The trainee is viewing: ${component}.`,
      'IMPORTANT: You must answer ONLY using the information provided below. Do not use any external knowledge.',
      'If the answer is not found in the provided information, say: "This information is not available in the component knowledge base."',
      '',
    ];
    if (comp.info)      parts.push(`Component knowledge:\n${comp.info}`);
    if ((comp.checklist||[]).length) parts.push(`Inspection checklist:\n- ${comp.checklist.join('\n- ')}`);
    if ((comp.hazards||[]).length)   parts.push(`Safety hazards:\n- ${comp.hazards.join('\n- ')}`);
    parts.push('Answer in the same language the user asks in. Be clear and concise (under 150 words).');
    systemPrompt = parts.filter(Boolean).join('\n');
  } else {
    // General mode — AI uses KB + general knowledge
    const parts = [
      'You are VIS-7, an AI training assistant for vessel components at Saudi Aramco CGPD.',
      `The trainee is viewing: ${component}.`,
    ];
    if (hasKB) {
      if (comp.info)      parts.push(`Specific knowledge about this component:\n${comp.info}`);
      if ((comp.checklist||[]).length) parts.push(`Inspection checklist:\n- ${comp.checklist.join('\n- ')}`);
      if ((comp.hazards||[]).length)   parts.push(`Safety hazards:\n- ${comp.hazards.join('\n- ')}`);
    }
    parts.push('Answer in the same language the user asks in. Be educational, clear, and concise (under 150 words).');
    systemPrompt = parts.filter(Boolean).join('\n');
  }

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: question },
      ],
    });
    const answer = completion.choices?.[0]?.message?.content?.trim() || 'No response received.';
    recordQuestion(component, question);
    res.json({ answer });
  } catch (e) {
    console.error('Groq error:', e.message);
    res.status(502).json({ answer: 'AI service is temporarily unavailable. Please try again.' });
  }
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SimuSphere running on port ${PORT}`));
