const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const groq = new Groq({apiKey: process.env.GROQ_API_KEY});
const KB_PATH = path.join(__dirname, 'knowledge.json');

function loadKB() {
  try { return JSON.parse(fs.readFileSync(KB_PATH, 'utf8')); }
  catch(e) { return {}; }
}

function saveKB(data) {
  fs.writeFileSync(KB_PATH, JSON.stringify(data, null, 2));
}

// Admin routes
app.get('/admin/knowledge', (req, res) => res.json(loadKB()));

app.post('/admin/knowledge', (req, res) => {
  const {name, info} = req.body;
  const kb = loadKB();
  kb[name] = info;
  saveKB(kb);
  res.json({ok: true});
});

app.delete('/admin/knowledge/:name', (req, res) => {
  const kb = loadKB();
  delete kb[decodeURIComponent(req.params.name)];
  saveKB(kb);
  res.json({ok: true});
});

// Main AI route
app.post('/ask', async (req, res) => {
  const {question, component} = req.body;
  const kb = loadKB();
  const localInfo = kb[component] || '';

  const systemPrompt = `You are VIS-7, an AI training assistant for vessel components at Saudi Aramco CGPD.
The trainee is viewing: ${component}.
${localInfo ? `Specific knowledge about this component:\n${localInfo}\n` : ''}
Answer in the same language the user asks in. Be educational, clear, and concise (under 150 words).`;

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: question}
      ]
    });
    res.json({answer: completion.choices[0].message.content});
  } catch(e) {
    res.json({answer: 'Error: ' + e.message});
  }
});

app.listen(3000, () => console.log('SimuSphere running on http://localhost:3000'));
