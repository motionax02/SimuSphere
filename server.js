'use strict';

const express = require('express');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static('public'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const KB_PATH    = path.join(__dirname, 'knowledge.json');
const PASS_PATH  = path.join(__dirname, 'admin_pass.txt');
const STATS_PATH = path.join(__dirname, 'stats.json');
const MAX_QUESTION_LENGTH = 500;
const MAX_NAME_LENGTH     = 100;
const VALID_NAME_REGEX    = /^[a-zA-Z0-9\s\-_().,']+$/;

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > 60_000) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  if (entry.count > 30) return res.status(429).json({ error: 'Too many requests.' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap)
    if (now - entry.start > 60_000) rateLimitMap.delete(ip);
}, 300_000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPassword() {
  try { return fs.readFileSync(PASS_PATH, 'utf8').trim(); }
  catch { return process.env.ADMIN_PASSWORD || 'SimuSphere2025'; }
}
function loadKB() {
  try { return JSON.parse(fs.readFileSync(KB_PATH, 'utf8')); }
  catch { return {}; }
}
function saveKB(data) {
  fs.writeFileSync(KB_PATH, JSON.stringify(data, null, 2), 'utf8');
}
function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')); }
  catch { return { totalQuestions: 0, components: {}, questions: [], lastActivity: null }; }
}
function saveStats(data) {
  fs.writeFileSync(STATS_PATH, JSON.stringify(data, null, 2), 'utf8');
}
function recordQuestion(component, question) {
  try {
    const stats = loadStats();
    stats.totalQuestions = (stats.totalQuestions || 0) + 1;
    if (!stats.components[component]) stats.components[component] = 0;
    stats.components[component]++;
    stats.questions = stats.questions || [];
    stats.questions.unshift({ component, question: question.slice(0, 100), time: new Date().toISOString() });
    if (stats.questions.length > 200) stats.questions = stats.questions.slice(0, 200);
    stats.lastActivity = new Date().toISOString();
    saveStats(stats);
  } catch(e) { console.error('Stats error:', e.message); }
}
function sanitizeString(str, maxLen = 1000) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}
function sanitizeArray(arr, maxLen = 50, itemMaxLen = 300) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, maxLen).map(i => sanitizeString(i, itemMaxLen)).filter(Boolean);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const provided = req.headers['x-admin-password'];
  if (!provided || provided !== getPassword()) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Admin: Knowledge ──────────────────────────────────────────────────────────
app.get('/admin/knowledge', adminAuth, (req, res) => res.json(loadKB()));

app.post('/admin/knowledge', adminAuth, (req, res) => {
  const name = sanitizeString(req.body.name, MAX_NAME_LENGTH);
  if (!name) return res.status(400).json({ error: 'Component name required' });
  if (!VALID_NAME_REGEX.test(name)) return res.status(400).json({ error: 'Invalid component name' });
  const kb = loadKB();
  kb[name] = {
    info:      sanitizeString(req.body.info, 5000),
    checklist: sanitizeArray(req.body.checklist),
    hazards:   sanitizeArray(req.body.hazards),
    buttons:   (Array.isArray(req.body.buttons) ? req.body.buttons : [])
                 .slice(0, 20)
                 .map(b => ({ label: sanitizeString(b.label, 80), question: sanitizeString(b.question, 300) }))
                 .filter(b => b.label && b.question),
  };
  try { saveKB(kb); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to save' }); }
});

app.delete('/admin/knowledge/:name', adminAuth, (req, res) => {
  const name = sanitizeString(decodeURIComponent(req.params.name), MAX_NAME_LENGTH);
  const kb = loadKB();
  if (!Object.prototype.hasOwnProperty.call(kb, name)) return res.status(404).json({ error: 'Not found' });
  delete kb[name];
  try { saveKB(kb); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to save' }); }
});

// ── Admin: Stats ──────────────────────────────────────────────────────────────
app.get('/admin/stats', adminAuth, (req, res) => res.json(loadStats()));

app.delete('/admin/stats', adminAuth, (req, res) => {
  try {
    saveStats({ totalQuestions: 0, components: {}, questions: [], lastActivity: null });
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Failed to clear stats' }); }
});

// ── Admin: Settings ───────────────────────────────────────────────────────────
app.post('/admin/change-password', adminAuth, (req, res) => {
  const newPassword = sanitizeString(req.body.newPassword, 100);
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
  try { fs.writeFileSync(PASS_PATH, newPassword, 'utf8'); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Failed to update password' }); }
});

// ── Admin: Export/Import KB ───────────────────────────────────────────────────
app.get('/admin/export', adminAuth, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="simusphere-kb.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(loadKB(), null, 2));
});

app.post('/admin/import', adminAuth, (req, res) => {
  const data = req.body;
  if (typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Invalid format' });
  try { saveKB(data); res.json({ ok: true, count: Object.keys(data).length }); }
  catch { res.status(500).json({ error: 'Failed to import' }); }
});

// ── Public ────────────────────────────────────────────────────────────────────
app.get('/component/:name', (req, res) => {
  const name = sanitizeString(decodeURIComponent(req.params.name), MAX_NAME_LENGTH);
  const kb   = loadKB();
  const comp = Object.prototype.hasOwnProperty.call(kb, name) ? kb[name] : null;
  if (!comp) return res.json({ buttons: [] });
  res.json({ buttons: comp.buttons || [] });
});

app.post('/ask', rateLimit, async (req, res) => {
  const question  = sanitizeString(req.body.question,  MAX_QUESTION_LENGTH);
  const component = sanitizeString(req.body.component, MAX_NAME_LENGTH);
  if (!question)  return res.status(400).json({ error: 'Question required' });
  if (!component) return res.status(400).json({ error: 'Component required' });

  const kb   = loadKB();
  const comp = Object.prototype.hasOwnProperty.call(kb, component) ? kb[component] : {};
  const localInfo = comp.info      || '';
  const checklist = (comp.checklist || []).join('\n- ');
  const hazards   = (comp.hazards   || []).join('\n- ');

  const systemPrompt = [
    'You are VIS-7, an AI training assistant for vessel components at Saudi Aramco CGPD.',
    `The trainee is viewing: ${component}.`,
    localInfo ? `Component knowledge:\n${localInfo}` : '',
    checklist ? `Inspection checklist:\n- ${checklist}` : '',
    hazards   ? `Safety hazards:\n- ${hazards}`         : '',
    'Answer in the same language the user asks in. Be educational, clear, and concise (under 150 words).',
  ].filter(Boolean).join('\n');

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: question },
      ],
    });
    const answer = completion.choices?.[0]?.message?.content || 'No response.';
    recordQuestion(component, question);
    res.json({ answer });
  } catch (e) {
    console.error('Groq error:', e.message);
    res.status(502).json({ answer: 'AI service unavailable. Please try again.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SimuSphere running on port ${PORT}`));
