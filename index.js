const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'superSecretKey123';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '10mb' })); // збільшено ліміт для base64
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Ініціалізація таблиць (та ж сама)
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
        image_url TEXT,
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

// ------------------- API (ті самі) -------------------
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
  const { title, description, start_date, start_time, place, image_data, category_ids, is_online, is_free, price, organizer_name } = req.body;
  // image_data – це base64 рядок (якщо відправляється)
  let image_url = null;
  if (image_data && image_data.startsWith('data:image')) {
    image_url = image_data; // зберігаємо base64 безпосередньо в БД
  }
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

// ==================== АДМІН-ПАНЕЛЬ (HTML з підтримкою завантаження зображень) ====================
const adminHtml = `<!DOCTYPE html>
<html lang="uk">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Адмін-панель заходів</title>
    <style>
        * { box-sizing: border-box; }
        body { font-family: system-ui; background: #f5f7fb; margin: 0; padding: 2rem; }
        .container { max-width: 1000px; margin: 0 auto; }
        .card { background: white; border-radius: 24px; padding: 1.5rem; margin-bottom: 2rem; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
        .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        input, select, textarea, button { width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 16px; font-size: 1rem; }
        button { background: #3AA0E6; color: white; font-weight: bold; border: none; cursor: pointer; }
        button:hover { background: #2b7ab3; }
        .event-item { background: #f9f9f9; border-radius: 20px; padding: 1rem; margin-bottom: 0.75rem; display: flex; justify-content: space-between; align-items: center; }
        .delete-btn { background: #e74c3c; width: auto; padding: 0.5rem 1rem; margin-left: 1rem; }
        .token-section { background: #eef2ff; border-radius: 20px; padding: 1rem; margin-bottom: 1.5rem; display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
        #tokenInput { flex: 2; background: white; }
        .success { color: #2e7d32; }
        .error { color: #c62828; }
        select[multiple] { height: auto; min-height: 120px; }
        .file-label { background: #3AA0E6; color: white; padding: 0.5rem; text-align: center; border-radius: 16px; cursor: pointer; margin-bottom: 0.5rem; display: inline-block; width: 100%; }
        #imagePreview { max-width: 100%; max-height: 150px; margin-top: 0.5rem; display: none; }
    </style>
</head>
<body>
<div class="container">
    <h1> Адмін-панель заходів</h1>
    <div class="token-section">
        <input type="text" id="tokenInput" placeholder="Admin Token" readonly>
        <button id="getTokenBtn"> Отримати токен</button>
    </div>
    <div class="card">
        <h2>➕ Додати подію</h2>
        <form id="eventForm" class="form-grid">
            <input type="text" id="title" placeholder="Назва *" required>
            <textarea id="description" placeholder="Опис" rows="2"></textarea>
            <input type="date" id="start_date" required>
            <input type="time" id="start_time">
            <input type="text" id="place" placeholder="Місце">
            <div>
                <label class="file-label" for="imageFile"> Вибрати зображення </label>
                <input type="file" id="imageFile" accept="image/*" style="display:none">
                <img id="imagePreview" alt="Попередній перегляд">
            </div>
            <select id="category_ids" multiple size="5">
                <option value="1">Театр</option>
                <option value="2">Концерти</option>
                <option value="3">Сімейні</option>
                <option value="4">Спорт</option>
                <option value="5">Молодіжні</option>
                <option value="6">Громадські</option>
                <option value="7">Освіта</option>
            </select>
            <input type="text" id="organizer_name" placeholder="Організатор">
            <button type="submit"> Зберегти подію</button>
        </form>
        <div id="formMessage"></div>
    </div>
    <div class="card">
        <h2> Список подій</h2>
        <div id="eventsList">Завантаження...</div>
    </div>
</div>
<script>
    const API_BASE = '';
    let adminToken = localStorage.getItem('adminToken') || '';
    const tokenInput = document.getElementById('tokenInput');
    tokenInput.value = adminToken;

    // Обробка вибору файлу
    const fileInput = document.getElementById('imageFile');
    const imagePreview = document.getElementById('imagePreview');
    let currentImageBase64 = '';

    fileInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = function(ev) {
                currentImageBase64 = ev.target.result;
                imagePreview.src = currentImageBase64;
                imagePreview.style.display = 'block';
            };
            reader.readAsDataURL(file);
        } else {
            currentImageBase64 = '';
            imagePreview.style.display = 'none';
        }
    });

    async function getToken() {
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'admin', password: 'admin123' })
            });
            if (!res.ok) throw new Error('Невірний логін/пароль');
            const data = await res.json();
            adminToken = data.token;
            tokenInput.value = adminToken;
            localStorage.setItem('adminToken', adminToken);
            showMessage('Токен отримано', 'success');
            loadEvents();
        } catch (err) {
            showMessage(err.message, 'error');
        }
    }

    async function loadEvents() {
        if (!adminToken) { document.getElementById('eventsList').innerHTML = '<p>Спочатку отримайте токен</p>'; return; }
        try {
            const res = await fetch('/api/admin/events', { headers: { 'Authorization': \`Bearer \${adminToken}\` } });
            if (!res.ok) throw new Error('Не вдалося завантажити');
            const events = await res.json();
            const container = document.getElementById('eventsList');
            if (events.length === 0) { container.innerHTML = '<p>Немає подій</p>'; return; }
            container.innerHTML = events.map(ev => \`
                <div class="event-item">
                    <div><strong>\${escapeHtml(ev.title)}</strong><br>\${ev.start_date} \${ev.start_time || ''} • \${ev.place || ''}</div>
                    <button class="delete-btn" data-id="\${ev.id}">Видалити</button>
                </div>
            \`).join('');
            document.querySelectorAll('.delete-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    if (confirm('Видалити?')) await deleteEvent(btn.dataset.id);
                });
            });
        } catch (err) { document.getElementById('eventsList').innerHTML = \`<p class="error">\${err.message}</p>\`; }
    }

    async function deleteEvent(id) {
        try {
            const res = await fetch(\`/api/admin/events/\${id}\`, { method: 'DELETE', headers: { 'Authorization': \`Bearer \${adminToken}\` } });
            if (!res.ok) throw new Error('Помилка видалення');
            showMessage('Видалено', 'success');
            loadEvents();
        } catch (err) { showMessage(err.message, 'error'); }
    }

    document.getElementById('getTokenBtn').onclick = getToken;
    document.getElementById('eventForm').onsubmit = async (e) => {
        e.preventDefault();
        if (!adminToken) { showMessage('Отримайте токен', 'error'); return; }
        // Збираємо вибрані категорії (множинний вибір)
        const categorySelect = document.getElementById('category_ids');
        const category_ids = Array.from(categorySelect.selectedOptions).map(opt => parseInt(opt.value));
        const data = {
            title: document.getElementById('title').value,
            description: document.getElementById('description').value,
            start_date: document.getElementById('start_date').value,
            start_time: document.getElementById('start_time').value,
            place: document.getElementById('place').value,
            image_url: currentImageBase64, // base64 зображення
            category_ids: category_ids,
            organizer_name: document.getElementById('organizer_name').value,
            is_online: false, is_free: true, price: null
        };
        if (!data.title || !data.start_date) { showMessage('Заповніть назву та дату', 'error'); return; }
        if (category_ids.length === 0) { showMessage('Виберіть хоча б одну категорію', 'error'); return; }
        try {
            const res = await fetch('/api/admin/events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${adminToken}\` },
                body: JSON.stringify(data)
            });
            if (!res.ok) throw new Error(await res.text());
            showMessage('Подію додано!', 'success');
            document.getElementById('eventForm').reset();
            currentImageBase64 = '';
            imagePreview.style.display = 'none';
            loadEvents();
        } catch (err) { showMessage(\`Помилка: \${err.message}\`, 'error'); }
    };

    function showMessage(msg, type) {
        const div = document.getElementById('formMessage');
        div.innerHTML = \`<div class="\${type}">\${msg}</div>\`;
        setTimeout(() => div.innerHTML = '', 3000);
    }
    function escapeHtml(str) { return str.replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[m]); }
    if (adminToken) loadEvents();
</script>
</body>
</html>`;

// Віддаємо адмін-панель для кореневого маршруту
app.get('/', (req, res) => res.send(adminHtml));
app.get('/admin.html', (req, res) => res.send(adminHtml));

app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));