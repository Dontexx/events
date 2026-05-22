const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3000;
const JWT_SECRET = 'secretkeychangeit';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123'; // змініть за бажанням

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // для HTML, CSS, JS

// === SQLite база даних ===
const db = new sqlite3.Database('./events.db');

// створення таблиць
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_uk TEXT NOT NULL,
    name_en TEXT,
    color TEXT,
    sort_order INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    start_date TEXT NOT NULL,
    start_time TEXT,
    place TEXT,
    image_url TEXT,
    is_online INTEGER DEFAULT 0,
    is_free INTEGER DEFAULT 1,
    price REAL,
    organizer_name TEXT,
    status TEXT DEFAULT 'approved',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS event_categories (
    event_id INTEGER,
    category_id INTEGER,
    FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
    FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY(event_id, category_id)
  )`);

  // додавання категорій за замовчуванням, якщо їх немає
  db.get(`SELECT COUNT(*) as cnt FROM categories`, (err, row) => {
    if (row.cnt === 0) {
      const categories = [
        ['Театр', 'Theater', '#9C27B0', 1],
        ['Концерти', 'Concerts', '#F44336', 2],
        ['Сімейні', 'Family', '#4CAF50', 3],
        ['Спорт', 'Sports', '#2196F3', 4],
        ['Молодіжні', 'Youth', '#FF9800', 5],
        ['Громадські', 'Community', '#795548', 6],
        ['Освіта', 'Education', '#3F51B5', 7]
      ];
      const stmt = db.prepare(`INSERT INTO categories (name_uk, name_en, color, sort_order) VALUES (?, ?, ?, ?)`);
      categories.forEach(c => stmt.run(c));
      stmt.finalize();
    }
  });
});

// === допоміжна функція для виконання запитів ===
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// === API для категорій ===
app.get('/api/categories', async (req, res) => {
  const cats = await runQuery('SELECT * FROM categories ORDER BY sort_order');
  res.json(cats);
});

// === API для подій (публічний) ===
app.get('/api/events', async (req, res) => {
  let { categories, date_from, date_to, search, limit = 20, offset = 0 } = req.query;
  let sql = `SELECT e.*, 
             GROUP_CONCAT(c.id) as category_ids, 
             GROUP_CONCAT(c.name_uk) as category_names
             FROM events e
             LEFT JOIN event_categories ec ON e.id = ec.event_id
             LEFT JOIN categories c ON ec.category_id = c.id
             WHERE e.status = 'approved'`;
  let params = [];

  if (categories) {
    const cats = categories.split(',').map(Number);
    sql += ` AND e.id IN (SELECT event_id FROM event_categories WHERE category_id IN (${cats.map(() => '?').join(',')}))`;
    params.push(...cats);
  }
  if (date_from) {
    sql += ` AND e.start_date >= ?`;
    params.push(date_from);
  }
  if (date_to) {
    sql += ` AND e.start_date <= ?`;
    params.push(date_to);
  }
  if (search) {
    sql += ` AND (e.title LIKE ? OR e.description LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  sql += ` GROUP BY e.id ORDER BY e.start_date ASC LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));

  const events = await runQuery(sql, params);
  const result = events.map(ev => ({
    ...ev,
    category_ids: ev.category_ids ? ev.category_ids.split(',').map(Number) : [],
    category_names: ev.category_names ? ev.category_names.split(',') : []
  }));
  res.json(result);
});

app.get('/api/events/:id', async (req, res) => {
  const sql = `SELECT e.*, 
               GROUP_CONCAT(c.id) as category_ids, 
               GROUP_CONCAT(c.name_uk) as category_names
               FROM events e
               LEFT JOIN event_categories ec ON e.id = ec.event_id
               LEFT JOIN categories c ON ec.category_id = c.id
               WHERE e.id = ? AND e.status = 'approved'
               GROUP BY e.id`;
  const events = await runQuery(sql, [req.params.id]);
  if (events.length === 0) return res.status(404).json({ error: 'Not found' });
  const ev = events[0];
  ev.category_ids = ev.category_ids ? ev.category_ids.split(',').map(Number) : [];
  ev.category_names = ev.category_names ? ev.category_names.split(',') : [];
  res.json(ev);
});

// === Адмін API (захищені) ===
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') throw new Error();
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/admin/events', authenticateAdmin, async (req, res) => {
  const events = await runQuery('SELECT * FROM events ORDER BY start_date DESC');
  res.json(events);
});

app.post('/api/admin/events', authenticateAdmin, async (req, res) => {
  const { title, description, start_date, start_time, place, image_url, category_ids, is_online, is_free, price, organizer_name } = req.body;
  const insertStmt = db.prepare(`INSERT INTO events (title, description, start_date, start_time, place, image_url, is_online, is_free, price, organizer_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertStmt.run(title, description, start_date, start_time, place, image_url, is_online ? 1 : 0, is_free ? 1 : 0, price, organizer_name, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    const eventId = this.lastID;
    if (category_ids && category_ids.length) {
      const stmt = db.prepare(`INSERT INTO event_categories (event_id, category_id) VALUES (?, ?)`);
      category_ids.forEach(catId => stmt.run(eventId, catId));
      stmt.finalize();
    }
    res.status(201).json({ id: eventId });
  });
  insertStmt.finalize();
});

app.delete('/api/admin/events/:id', authenticateAdmin, (req, res) => {
  db.run('DELETE FROM events WHERE id = ?', req.params.id, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// === Віддача статичних HTML-сторінок ===
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));