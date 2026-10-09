import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import OpenAI from 'openai';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Set JWT_SECRET to a random secret of at least 32 characters in .env');
  process.exit(1);
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(path.join(__dirname, 'nobi.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 title TEXT NOT NULL DEFAULT 'New chat', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function cleanEmail(v) { return String(v || '').trim().toLowerCase(); }
function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d', issuer: 'nobi' });
}
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'nobi' });
    const user = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(payload.sub);
    if (!user) return res.status(401).json({ error: 'Please sign in again.' });
    req.user = user; next();
  } catch { return res.status(401).json({ error: 'Please sign in to continue.' }); }
}
function admin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}
function newId() { return crypto.randomUUID(); }

function ensureAdmin() {
  const email = cleanEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || password.length < 12) {
    console.warn('Admin bootstrap skipped: set ADMIN_EMAIL and ADMIN_PASSWORD (12+ chars) in .env.');
    return;
  }
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (!exists) {
    const hash = bcrypt.hashSync(password, 12);
    db.prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?, 'admin')")
      .run(newId(), 'Nobi Admin', email, hash);
    console.log(`Created initial admin account for ${email}`);
  }
}
ensureAdmin();

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'Nobi' }));

app.post('/api/auth/register', rateLimit({ windowMs: 60 * 60 * 1000, limit: 12 }), async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || '');
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) {
    return res.status(400).json({ error: 'Enter a name, valid email, and password of at least 10 characters.' });
  }
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return res.status(409).json({ error: 'An account with that email already exists.' });
  const id = newId();
  const hash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (id,name,email,password_hash) VALUES (?,?,?,?)').run(id, name, email, hash);
  const user = { id, name, email, role: 'user' };
  res.status(201).json({ token: signToken(user), user });
});

app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }), async (req, res) => {
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!row || !(await bcrypt.compare(password, row.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  const user = { id: row.id, name: row.name, email: row.email, role: row.role };
  res.json({ token: signToken(user), user });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.get('/api/conversations', auth, (req, res) => {
  const rows = db.prepare('SELECT id,title,created_at,updated_at FROM conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 100').all(req.user.id);
  res.json({ conversations: rows });
});
app.post('/api/conversations', auth, (req, res) => {
  const id = newId();
  const title = String(req.body?.title || 'New chat').trim().slice(0, 80) || 'New chat';
  db.prepare('INSERT INTO conversations (id,user_id,title) VALUES (?,?,?)').run(id, req.user.id, title);
  res.status(201).json({ id, title });
});
app.get('/api/conversations/:id', auth, (req, res) => {
  const conv = db.prepare('SELECT id,title,created_at,updated_at FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
  const messages = db.prepare('SELECT role,content,created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC').all(conv.id);
  res.json({ conversation: conv, messages });
});
app.delete('/api/conversations/:id', auth, (req, res) => {
  const result = db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ ok: true });
});

app.post('/api/chat', auth, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'AI is not configured yet. Add OPENAI_API_KEY to your server .env and restart Nobi.' });
  const conversationId = String(req.body?.conversationId || '');
  const message = String(req.body?.message || '').trim().slice(0, 12000);
  if (!message) return res.status(400).json({ error: 'Type a message first.' });
  let conv = conversationId ? db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(conversationId, req.user.id) : null;
  if (conversationId && !conv) return res.status(404).json({ error: 'Conversation not found.' });
  if (!conv) {
    const id = newId();
    db.prepare('INSERT INTO conversations (id,user_id,title) VALUES (?,?,?)').run(id, req.user.id, message.slice(0, 55));
    conv = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
  }
  const history = db.prepare('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 20').all(conv.id).reverse();
  db.prepare('INSERT INTO messages (id,conversation_id,role,content) VALUES (?,?,?,?)').run(newId(), conv.id, 'user', message);
  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are Nobi, a helpful, honest, friendly AI assistant. Do not claim to have performed actions you did not perform. Keep private account data confidential.' },
        ...history,
        { role: 'user', content: message }
      ]
    });
    const answer = response.choices?.[0]?.message?.content?.trim() || 'I could not create a response. Please try again.';
    db.prepare('INSERT INTO messages (id,conversation_id,role,content) VALUES (?,?,?,?)').run(newId(), conv.id, 'assistant', answer);
    db.prepare('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(conv.id);
    res.json({ conversationId: conv.id, answer });
  } catch (err) {
    console.error('AI request failed:', err?.message || err);
    res.status(502).json({ error: 'The AI provider request failed. Check your API key, model access, and billing.' });
  }
});

app.post('/api/image', auth, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'Image generation is not configured. Add OPENAI_API_KEY to the server .env.' });
  const prompt = String(req.body?.prompt || '').trim().slice(0, 2000);
  if (!prompt) return res.status(400).json({ error: 'Describe the image you want.' });
  try {
    const result = await openai.images.generate({ model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1', prompt, size: '1024x1024' });
    const item = result.data?.[0];
    if (item?.url) return res.json({ url: item.url });
    if (item?.b64_json) return res.json({ dataUrl: `data:image/png;base64,${item.b64_json}` });
    res.status(502).json({ error: 'The image provider returned no image.' });
  } catch (err) {
    console.error('Image request failed:', err?.message || err);
    res.status(502).json({ error: 'Image generation failed. Check API access and billing.' });
  }
});

app.post('/api/search', auth, async (req, res) => {
  const query = String(req.body?.query || '').trim().slice(0, 500);
  if (!query) return res.status(400).json({ error: 'Enter a search query.' });
  if (!process.env.TAVILY_API_KEY) return res.status(503).json({ error: 'Internet search is not configured. Add TAVILY_API_KEY to .env (Tavily) and restart Nobi.' });
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 6, include_answer: true })
    });
    if (!response.ok) throw new Error(`Search provider returned ${response.status}`);
    const data = await response.json();
    res.json({ answer: data.answer || '', results: (data.results || []).map(x => ({ title: x.title, url: x.url, content: x.content })) });
  } catch (err) {
    console.error('Search request failed:', err?.message || err);
    res.status(502).json({ error: 'Internet search failed. Check the search API key and try again.' });
  }
});

app.get('/api/admin/overview', auth, admin, (_req, res) => {
  const users = db.prepare('SELECT id,name,email,role,created_at FROM users ORDER BY created_at DESC LIMIT 500').all();
  const counts = {
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    conversations: db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
  };
  res.json({ counts, users });
});
app.patch('/api/admin/users/:id/role', auth, admin, (req, res) => {
  const role = req.body?.role;
  if (!['user','admin'].includes(role)) return res.status(400).json({ error: 'Role must be user or admin.' });
  if (req.params.id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role here.' });
  const result = db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', auth, admin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own admin account.' });
  const result = db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.listen(PORT, () => console.log(`Nobi is running on http://localhost:${PORT}`));
