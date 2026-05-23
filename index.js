const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'superSecretKey123';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Пул підключень до PostgreSQL (використовує DATABASE_URL з Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.static(__dirname));

// Ініціалізація таблиць
const initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name_uk VARCHAR(100) NOT NULL,
        name_en VARCHAR(100),
        color VARCHAR(7) DEFAULT '#FF9800',
        sort_order INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE
      );
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        start_date DATE NOT NULL,
        start_time TIME,
        place VARCHAR(200),
        image_url VARCHAR(500),
        is_online BOOLEAN DEFAULT FALSE,
        is_free BOOLEAN DEFAULT TRUE,
        price DECIMAL(10,2),
        organizer_name VARCHAR(200),
        status VARCHAR(20) DEFAULT 'approved',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS event_categories (
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
        PRIMARY KEY (event_id, category_id)
      );
    `);

    const res = await client.query('SELECT COUNT(*) FROM categories');
    if (parseInt(res.rows[0].count) === 0) {
      const categories = [
        ['Театр', 'Theater', '#9C27B0'],
        ['Концерти', 'Concerts', '#F44336'],
        ['Сімейні', 'Family', '#4CAF50'],
        ['Спорт', 'Sports', '#2196F3'],
        ['Молодіжні', 'Youth', '#FF9800'],
        ['Громадські', 'Community', '#795548'],
        ['Освіта', 'Education', '#3F51B5']
      ];
      for (const [uk, en, color] of categories) {
        await client.query('INSERT INTO categories (name_uk, name_en, color) VALUES ($1, $2, $3)', [uk, en, color]);
      }
    }
    console.log('✅ PostgreSQL ready');
  } catch (err) {
    console.error('DB init error:', err);
  } finally {
    client.release();
  }
};
initDb();

// API маршрути
app.get('/api/categories', async (req, res) => {
  const result = await pool.query('SELECT * FROM categories WHERE is_active = true ORDER BY sort_order');
  res.json(result.rows);
});

app.get('/api/events', async (req, res) => {
  let { categories, date_from, date_to, search, limit = 20, offset = 0 } = req.query;
  let sql = `
    SELECT e.*, array_agg(DISTINCT c.id) as category_ids, array_agg(DISTINCT c.name_uk) as category_names
    FROM events e
    LEFT JOIN event_categories ec ON e.id = ec.event_id
    LEFT JOIN categories c ON ec.category_id = c.id
    WHERE e.status = 'approved'
  `;
  let params = [];
  let idx = 1;

  if (categories) {
    const cats = categories.split(',').map(Number);
    sql += ` AND e.id IN (SELECT event_id FROM event_categories WHERE category_id = ANY($${idx}::int[]))`;
    params.push(cats);
    idx++;
  }
  if (date_from) {
    sql += ` AND e.start_date >= $${idx}`;
    params.push(date_from);
    idx++;
  }
  if (date_to) {
    sql += ` AND e.start_date <= $${idx}`;
    params.push(date_to);
    idx++;
  }
  if (search) {
    sql += ` AND (e.title ILIKE $${idx} OR e.description ILIKE $${idx})`;
    params.push(`%${search}%`);
    idx++;
  }
  sql += ` GROUP BY e.id ORDER BY e.start_date ASC LIMIT $${idx} OFFSET $${idx+1}`;
  params.push(Number(limit), Number(offset));

  const result = await pool.query(sql, params);
  const rows = result.rows.map(row => ({
    ...row,
    category_ids: row.category_ids ? row.category_ids.filter(v => v !== null) : [],
    category_names: row.category_names ? row.category_names.filter(v => v !== null) : []
  }));
  res.json(rows);
});

app.get('/api/events/:id', async (req, res) => {
  const result = await pool.query(`
    SELECT e.*, array_agg(DISTINCT c.id) as category_ids, array_agg(DISTINCT c.name_uk) as category_names
    FROM events e
    LEFT JOIN event_categories ec ON e.id = ec.event_id
    LEFT JOIN categories c ON ec.category_id = c.id
    WHERE e.id = $1 AND e.status = 'approved'
    GROUP BY e.id
  `, [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
  const ev = result.rows[0];
  ev.category_ids = ev.category_ids ? ev.category_ids.filter(v => v !== null) : [];
  ev.category_names = ev.category_names ? ev.category_names.filter(v => v !== null) : [];
  res.json(ev);
});

// Адмін маршрути
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
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
  const result = await pool.query('SELECT * FROM events ORDER BY start_date DESC');
  res.json(result.rows);
});

app.post('/api/admin/events', authenticateAdmin, async (req, res) => {
  const { title, description, start_date, start_time, place, image_url, category_ids, is_online, is_free, price, organizer_name } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertRes = await client.query(`
      INSERT INTO events (title, description, start_date, start_time, place, image_url, is_online, is_free, price, organizer_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
    `, [title, description, start_date, start_time, place, image_url, is_online || false, is_free !== undefined ? is_free : true, price, organizer_name]);
    const eventId = insertRes.rows[0].id;
    if (category_ids && category_ids.length) {
      for (const catId of category_ids) {
        await client.query('INSERT INTO event_categories (event_id, category_id) VALUES ($1, $2)', [eventId, catId]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ id: eventId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/events/:id', authenticateAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM events WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Event not found' });
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));