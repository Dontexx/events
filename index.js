const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;

// Підключення до PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ===== Публічні маршрути =====
app.get('/api/events', async (req, res) => {
    const { categories } = req.query;
    let query = 'SELECT * FROM events';
    const params = [];

    if (categories) {
        const cats = categories.split(',');
        query = `
            SELECT e.* FROM events e
            JOIN event_categories ec ON e.id = ec.event_id
            WHERE ec.category_id IN (${cats.map((_, i) => `$${i+1}`).join(',')})
            GROUP BY e.id
        `;
        params.push(...cats);
    }

    try {
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/events/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/categories', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM categories ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

// ===== Адміністративна частина =====
function authenticateAdmin(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
}

app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    if (username === adminUser && password === adminPass) {
        const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'secret', { expiresIn: '8h' });
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/api/admin/events', authenticateAdmin, async (req, res) => {
    const { title, description, date, time, place, image_url, category_ids, organizer } = req.body;
    if (!title || !date) {
        return res.status(400).json({ error: 'Title and date are required' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO events (title, description, date, time, place, image_url, organizer) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [title, description, date, time, place, image_url, organizer]
        );
        const eventId = result.rows[0].id;
        if (category_ids && category_ids.length) {
            for (const catId of category_ids) {
                await pool.query('INSERT INTO event_categories (event_id, category_id) VALUES ($1, $2)', [eventId, catId]);
            }
        }
        res.status(201).json({ id: eventId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create event' });
    }
});

app.delete('/api/admin/events/:id', authenticateAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM events WHERE id = $1', [id]);
        res.status(200).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete event' });
    }
});

// ===== Користувацька частина (підписки) =====
function authenticateUser(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        if (!decoded.userId) return res.status(403).json({ error: 'Invalid token: missing userId' });
        req.userId = decoded.userId;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid token' });
    }
}

// Тестовий логін для користувача (повертає токен з userId=1)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (username === 'user' && password === 'user123') {
        const token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET || 'secret', { expiresIn: '8h' });
        res.json({ token });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.get('/api/subscriptions', authenticateUser, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT category_id FROM user_subscriptions WHERE user_id = $1',
            [req.userId]
        );
        res.json(result.rows.map(row => row.category_id));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/subscriptions', authenticateUser, async (req, res) => {
    const { categoryId } = req.body;
    if (!categoryId) return res.status(400).json({ error: 'categoryId is required' });
    try {
        await pool.query(
            'INSERT INTO user_subscriptions (user_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [req.userId, categoryId]
        );
        res.status(201).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add subscription' });
    }
});

app.delete('/api/subscriptions/:categoryId', authenticateUser, async (req, res) => {
    const categoryId = parseInt(req.params.categoryId);
    try {
        await pool.query(
            'DELETE FROM user_subscriptions WHERE user_id = $1 AND category_id = $2',
            [req.userId, categoryId]
        );
        res.status(200).send();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete subscription' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));