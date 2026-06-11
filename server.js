const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const KB_PATH = path.join(__dirname, 'knowledge.json');
const PASS_PATH = path.join(__dirname, 'admin_pass.txt');

function getPassword() {
  try { return fs.readFileSync(PASS_PATH, 'utf8').trim(); }
  catch(e) { return process.env.ADMIN_PASSWORD || 'SimuSphere2025'; }
}
function loadKB() {
  try { return JSON.parse(fs.readFileSync(KB_PATH, 'utf8')); }
  catch(e) { return {}; }
}
function saveKB(data) {
  fs.writeFileSync(KB_PATH, JSON.stringify(data, null, 2));
}
function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== getPassword()) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/admin/knowledge', adminAuth, (req, res) => res.json(loadKB()));
app.post('/admin/knowledge', adminAuth, (req, res) => {
  const { name, info, checklist, hazards, buttons } = req.body;
  const kb = loadKB();
  kb[name] = { info: info || '', checklist: checklist || [], hazards: hazards || [], buttons: buttons || [] };
  saveKB(kb);
  res.json({ ok: true });
});
app.delete('/admin/knowledge/:name', adminAuth, (req, res) => {
  const kb = loadKB();
  delete kb[decodeURIComponent(req.params.name)];
  saveKB(kb);
  res.json({ ok: true });
});

app.post('/admin/change-password', adminAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Password too short' });
  fs.writeFileSync(PASS_PATH, newPassword);
  res.json({ ok: true });
});

app.get('/component/:name', (req, res) => {
  const kb = loadKB();
  const comp = kb[decodeURIComponent(req.params.name)];
  if (!comp) return res.json({ buttons: [] });
  res.json({ buttons: comp.buttons || [] });
});

app.post('/ask', async (req, res) => {
  const { question, component } = req.body;
  const kb = loadKB();
  const comp = kb[component] || {};
  const localInfo = comp.info || '';
  const checklist = (comp.checklist || []).join('\n- ');
  const hazards = (comp.hazards || []).join('\n- ');
  const systemPrompt = `You are VIS-7, an AI training assistant for vessel components at Saudi Aramco CGPD.
The trainee is viewing: ${component}.
${localInfo ? `Component knowledge:\n${localInfo}\n` : ''}${checklist ? `Inspection checklist:\n- ${checklist}\n` : ''}${hazards ? `Safety hazards:\n- ${hazards}\n` : ''}
Answer in the same language the user asks in. Be educational, clear, and concise (under 150 words).`;
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: question }]
    });
    res.json({ answer: completion.choices[0].message.content });
  } catch(e) { res.json({ answer: 'Error: ' + e.message }); }
});

app.listen(3000, () => console.log('SimuSphere running on http://localhost:3000'));
