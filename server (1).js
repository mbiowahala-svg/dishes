/* Fine Dishes Hotel - backend (Node.js + Express + MySQL)
 * Setup:  npm init -y
 *         npm i express mysql2 bcryptjs jsonwebtoken cookie-parser helmet express-rate-limit multer dotenv
 * .env :  DB_HOST=localhost DB_USER=root DB_PASS=yourpass DB_NAME=fine_dishes
 *         JWT_SECRET=long-random-string  ADMIN_EMAIL=you@example.com  ADMIN_PASSWORD=StrongPass123
 *         PORT=3000  (NODE_ENV=production when deployed over HTTPS)
 * Run  :  node server.js   -> http://localhost:3000
 * Keep server.js, index.html and styles.css in the same folder. The database and tables are created automatically.
 */
require('dotenv').config();
const express = require('express'), mysql = require('mysql2/promise'), bcrypt = require('bcryptjs'),
  jwt = require('jsonwebtoken'), cookieParser = require('cookie-parser'), helmet = require('helmet'),
  rateLimit = require('express-rate-limit'), multer = require('multer'), crypto = require('crypto'),
  path = require('path'), fs = require('fs');

const E = process.env, PORT = E.PORT || 3000, DB = E.DB_NAME || 'fine_dishes';
const SECRET = E.JWT_SECRET || (console.warn('WARNING: set JWT_SECRET in .env'), crypto.randomBytes(32).toString('hex'));
const SLOT = 90; // minutes a table is held per booking
let pool;

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS users(id INT AUTO_INCREMENT PRIMARY KEY, full_name VARCHAR(100) NOT NULL, email VARCHAR(120) NOT NULL UNIQUE, phone VARCHAR(20) NOT NULL, password_hash VARCHAR(100) NOT NULL, role ENUM('customer','admin') NOT NULL DEFAULT 'customer', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS password_resets(id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, token_hash CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, used TINYINT DEFAULT 0, INDEX(token_hash), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE)`,
`CREATE TABLE IF NOT EXISTS menu_categories(id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80) NOT NULL UNIQUE, sort_order INT DEFAULT 0)`,
`CREATE TABLE IF NOT EXISTS menu_items(id INT AUTO_INCREMENT PRIMARY KEY, category_id INT NOT NULL, name VARCHAR(100) NOT NULL, description VARCHAR(300) DEFAULT '', price DECIMAL(10,2) NOT NULL, emoji VARCHAR(8) DEFAULT '🍽️', image_url VARCHAR(255) NULL, featured TINYINT DEFAULT 0, price_confirmed TINYINT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(category_id), FOREIGN KEY(category_id) REFERENCES menu_categories(id) ON DELETE CASCADE)`,
`CREATE TABLE IF NOT EXISTS reservations(id INT AUTO_INCREMENT PRIMARY KEY, ref VARCHAR(16) NOT NULL UNIQUE, user_id INT NOT NULL, name VARCHAR(100) NOT NULL, phone VARCHAR(20) NOT NULL, res_date DATE NOT NULL, res_time TIME NOT NULL, guests INT NOT NULL, seating VARCHAR(40) DEFAULT '', notes VARCHAR(500) DEFAULT '', status ENUM('Pending','Confirmed','Cancelled','Completed','Rejected') NOT NULL DEFAULT 'Pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, INDEX(res_date,res_time), INDEX(status), FOREIGN KEY(user_id) REFERENCES users(id))`,
`CREATE TABLE IF NOT EXISTS reservation_status_history(id INT AUTO_INCREMENT PRIMARY KEY, reservation_id INT NOT NULL, status VARCHAR(20) NOT NULL, changed_by INT NULL, changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE CASCADE)`,
`CREATE TABLE IF NOT EXISTS gallery_images(id INT AUTO_INCREMENT PRIMARY KEY, file VARCHAR(120) NOT NULL, alt_text VARCHAR(200) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
`CREATE TABLE IF NOT EXISTS hotel_settings(k VARCHAR(40) PRIMARY KEY, v VARCHAR(500) NOT NULL)`
];
const DEFAULTS = { hotel_name: 'Fine Dishes Hotel', phone: '0704519961', address: 'Isiolo Town, Kenya', whatsapp: '', map_url: '',
  open_time: '08:00', close_time: '21:00', show_hours: '0', capacity: '40', reservations_open: '1', cancel_hours: '2' };
const SEED = { 'Kenyan Traditional Food': [['Nyama Choma','Grilled meat served with kachumbari and ugali.',900,'🍖',1],['Ugali with Beef Stew','Ugali served with slow-cooked beef stew.',450,'🍲',1],['Pilau','Spiced rice with tender meat.',400,'🍛',1],['Chapati with Beans','Soft chapati served with seasoned beans.',250,'🫓',1]],
  'African Cuisine': [['Fish Dish','Fresh fish prepared in the chef’s style.',700,'🐟',1]],
  'International Meals': [['Pasta','Pasta in a rich sauce of your choice.',600,'🍝',1],['Grilled Chicken','Grilled chicken with sides.',700,'🍗',1]],
  'Fast Food': [['Kenyan Chicken and Chips','Fried chicken with crispy chips.',550,'🍟',1],['Beef Burger','Beef burger with fries.',500,'🍔',1],['Pizza','Freshly baked pizza.',900,'🍕',1]],
  'Vegetarian Meals': [['Fresh Vegetable Salad','Crisp seasonal vegetables.',350,'🥗',1]],
  'Drinks and Refreshments': [['Fresh Fruit Juice','Freshly blended fruit juice.',200,'🧃',1],['Tea and Coffee','Hot tea or coffee.',150,'☕',1]] };

async function init() {
  const root = await mysql.createConnection({ host: E.DB_HOST || 'localhost', user: E.DB_USER || 'root', password: E.DB_PASS || '' });
  await root.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8mb4`); await root.end();
  pool = mysql.createPool({ host: E.DB_HOST || 'localhost', user: E.DB_USER || 'root', password: E.DB_PASS || '', database: DB, dateStrings: true, charset: 'utf8mb4', connectionLimit: 10 });
  for (const s of SCHEMA) await pool.query(s);
  for (const [k, v] of Object.entries(DEFAULTS)) await pool.execute('INSERT IGNORE INTO hotel_settings(k,v) VALUES(?,?)', [k, v]);
  const [[c]] = await pool.query('SELECT COUNT(*) n FROM menu_categories');
  if (!c.n) { let o = 0; for (const [cat, items] of Object.entries(SEED)) {
    const [r] = await pool.execute('INSERT INTO menu_categories(name,sort_order) VALUES(?,?)', [cat, o++]);
    for (const [n, d, p, e, f] of items) await pool.execute('INSERT INTO menu_items(category_id,name,description,price,emoji,featured) VALUES(?,?,?,?,?,?)', [r.insertId, n, d, p, e, f]); } }
  const [[a]] = await pool.query("SELECT COUNT(*) n FROM users WHERE role='admin'");
  if (!a.n && E.ADMIN_EMAIL && E.ADMIN_PASSWORD) {
    await pool.execute("INSERT INTO users(full_name,email,phone,password_hash,role) VALUES('Administrator',?,?,?,'admin')", [E.ADMIN_EMAIL.toLowerCase(), '0704519961', await bcrypt.hash(E.ADMIN_PASSWORD, 12)]);
    console.log('Admin account created:', E.ADMIN_EMAIL); }
  else if (!a.n) console.warn('No admin yet: set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart.');
}

const settings = async () => Object.fromEntries((await pool.query('SELECT k,v FROM hotel_settings'))[0].map(r => [r.k, r.v]));
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ hsts: E.NODE_ENV === 'production', contentSecurityPolicy: { directives: { upgradeInsecureRequests: null, defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ['https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https:'], frameSrc: ['https://www.google.com', 'https://maps.google.com'] } } }));
app.use(express.json({ limit: '50kb' }), cookieParser());
const UP = path.join(__dirname, 'uploads'); fs.mkdirSync(UP, { recursive: true });
app.use('/uploads', express.static(UP));
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));
app.get('/styles.css', (q, r) => r.sendFile(path.join(__dirname, 'styles.css')));

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts. Please try again in 15 minutes.' } });
const wrap = f => (q, r, n) => f(q, r, n).catch(e => { console.error(e); r.status(500).json({ error: 'Server error. Please try again.' }); });
const auth = (q, r, n) => { try { q.user = jwt.verify(q.cookies.tok, SECRET); n(); } catch { r.status(401).json({ error: 'Please log in first.' }); } };
const admin = (q, r, n) => auth(q, r, () => q.user.role === 'admin' ? n() : r.status(403).json({ error: 'Administrators only.' }));
const sign = (r, u) => r.cookie('tok', jwt.sign({ id: u.id, role: u.role, name: u.full_name }, SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'lax', secure: E.NODE_ENV === 'production', maxAge: 7 * 864e5 });
const me = u => ({ id: u.id, name: u.full_name, email: u.email, phone: u.phone, role: u.role });
const okPw = p => typeof p === 'string' && p.length >= 8 && /[a-z]/i.test(p) && /\d/.test(p);
const okPhone = p => /^(\+?254|0)\d{9}$/.test(String(p).replace(/\s/g, ''));
const hm = t => String(t).slice(0, 5);
const mins = t => { const [h, m] = hm(t).split(':'); return +h * 60 + +m; };
const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// ---------- Auth ----------
app.post('/api/register', authLimit, wrap(async (q, r) => {
  const { name, email, phone, password, confirm } = q.body || {};
  if (!name || name.trim().length < 2) return r.status(400).json({ error: 'Enter your full name.' });
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return r.status(400).json({ error: 'Enter a valid email address.' });
  if (!okPhone(phone)) return r.status(400).json({ error: 'Enter a valid Kenyan phone number, e.g. 0712345678.' });
  if (!okPw(password)) return r.status(400).json({ error: 'Password needs 8+ characters with letters and numbers.' });
  if (password !== confirm) return r.status(400).json({ error: 'Passwords do not match.' });
  const [ex] = await pool.execute('SELECT id FROM users WHERE email=?', [email.toLowerCase()]);
  if (ex.length) return r.status(409).json({ error: 'An account with this email already exists.' });
  const [i] = await pool.execute('INSERT INTO users(full_name,email,phone,password_hash) VALUES(?,?,?,?)', [name.trim(), email.toLowerCase(), phone.replace(/\s/g, ''), await bcrypt.hash(password, 12)]);
  const u = { id: i.insertId, role: 'customer', full_name: name.trim(), email: email.toLowerCase(), phone }; sign(r, u); r.json({ user: me(u) });
}));
app.post('/api/login', authLimit, wrap(async (q, r) => {
  const { email, password } = q.body || {};
  const [[u]] = await pool.execute('SELECT * FROM users WHERE email=?', [String(email || '').toLowerCase()]);
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) return r.status(401).json({ error: 'Incorrect email or password.' });
  sign(r, u); r.json({ user: me(u) });
}));
app.post('/api/logout', (q, r) => { r.clearCookie('tok'); r.json({ ok: true }); });
app.get('/api/me', wrap(async (q, r) => {
  try { const t = jwt.verify(q.cookies.tok, SECRET); const [[u]] = await pool.execute('SELECT * FROM users WHERE id=?', [t.id]); return r.json({ user: u ? me(u) : null }); } catch { r.json({ user: null }); }
}));
app.post('/api/forgot', authLimit, wrap(async (q, r) => {
  const [[u]] = await pool.execute('SELECT id FROM users WHERE email=?', [String(q.body.email || '').toLowerCase()]);
  if (u) { const t = crypto.randomBytes(32).toString('hex');
    await pool.execute('INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))', [u.id, crypto.createHash('sha256').update(t).digest('hex')]);
    // TODO: send by email/SMS once a provider is configured. Until then the link is printed in the server console.
    console.log(`PASSWORD RESET LINK: http://localhost:${PORT}/#/reset?token=${t}`); }
  r.json({ message: 'If that email is registered, a reset link has been sent.' });
}));
app.post('/api/reset', authLimit, wrap(async (q, r) => {
  const { token, password } = q.body || {};
  if (!okPw(password)) return r.status(400).json({ error: 'Password needs 8+ characters with letters and numbers.' });
  const h = crypto.createHash('sha256').update(String(token || '')).digest('hex');
  const [[p]] = await pool.execute('SELECT * FROM password_resets WHERE token_hash=? AND used=0 AND expires_at>NOW()', [h]);
  if (!p) return r.status(400).json({ error: 'This reset link is invalid or has expired.' });
  await pool.execute('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 12), p.user_id]);
  await pool.execute('UPDATE password_resets SET used=1 WHERE id=?', [p.id]); r.json({ ok: true });
}));

// ---------- Public content ----------
app.get('/api/settings', wrap(async (q, r) => { const s = await settings(); r.json({ hotel_name: s.hotel_name, phone: s.phone, address: s.address, whatsapp: s.whatsapp, map_url: s.map_url, reservations_open: s.reservations_open, hours: s.show_hours === '1' ? `${s.open_time} - ${s.close_time}` : '' }); }));
app.get('/api/menu', wrap(async (q, r) => r.json({ categories: (await pool.query('SELECT * FROM menu_categories ORDER BY sort_order,id'))[0], items: (await pool.query('SELECT * FROM menu_items ORDER BY id'))[0] })));
app.get('/api/gallery', wrap(async (q, r) => r.json((await pool.query('SELECT * FROM gallery_images ORDER BY id DESC'))[0])));
app.post('/api/contact', rateLimit({ windowMs: 3600e3, max: 5 }), wrap(async (q, r) => {
  const { name, email, message } = q.body || {};
  if (!name || !/^\S+@\S+\.\S+$/.test(email || '') || !message || message.length < 5) return r.status(400).json({ error: 'Please fill in your name, a valid email and a message.' });
  console.log('CONTACT ENQUIRY:', { name, email, message }); // TODO: forward by email once configured
  r.json({ message: 'Thank you! Your enquiry has been received.' });
}));

// ---------- Reservations ----------
async function seatsFree(db, date, time, ignore = 0) {
  const s = await settings();
  const [[u]] = await db.execute(`SELECT COALESCE(SUM(guests),0) n FROM reservations WHERE res_date=? AND status IN('Pending','Confirmed') AND id<>? AND ABS(TIME_TO_SEC(TIMEDIFF(res_time,?)))/60 < ${SLOT}`, [date, ignore, time]);
  return { free: +s.capacity - u.n, s };
}
async function alternatives(db, date, guests) {
  const s = await settings(), out = [];
  for (let m = mins(s.open_time); m <= mins(s.close_time) - 60 && out.length < 40; m += 30) if ((await seatsFree(db, date, fmt(m))).free >= guests) out.push(fmt(m));
  return out;
}
app.post('/api/reservations', auth, wrap(async (q, r) => {
  const { phone, date, time, guests, seating, notes } = q.body || {}, g = parseInt(guests, 10);
  const [[u]] = await pool.execute('SELECT * FROM users WHERE id=?', [q.user.id]);
  if (!okPhone(phone)) return r.status(400).json({ error: 'Enter a valid contact phone number.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) return r.status(400).json({ error: 'Choose a valid date and time.' });
  if (!(g >= 1 && g <= 20)) return r.status(400).json({ error: 'Guests must be between 1 and 20. For larger groups please call us.' });
  const when = new Date(`${date}T${time}:00`); if (isNaN(when) || when <= new Date()) return r.status(400).json({ error: 'Choose a future date and time.' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("SELECT v FROM hotel_settings WHERE k='capacity' FOR UPDATE"); // serialises bookings -> no double-booking
    const { free, s } = await seatsFree(conn, date, time);
    if (s.reservations_open !== '1') { await conn.rollback(); return r.status(403).json({ error: 'Online reservations are currently closed. Please call us.' }); }
    if (mins(time) < mins(s.open_time) || mins(time) > mins(s.close_time) - 60) { await conn.rollback(); return r.status(400).json({ error: `Reservations are accepted between ${s.open_time} and ${fmt(mins(s.close_time) - 60)}.` }); }
    if (g > free) { const alt = await alternatives(conn, date, g); await conn.rollback();
      return r.status(409).json({ error: 'Sorry, that time is not available for your party size.', alternatives: alt.sort((a, b) => Math.abs(mins(a) - mins(time)) - Math.abs(mins(b) - mins(time))).slice(0, 6).sort() }); }
    const ref = 'FDH-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const [i] = await conn.execute('INSERT INTO reservations(ref,user_id,name,phone,res_date,res_time,guests,seating,notes) VALUES(?,?,?,?,?,?,?,?,?)', [ref, u.id, u.full_name, phone.replace(/\s/g, ''), date, time, g, String(seating || '').slice(0, 40), String(notes || '').slice(0, 500)]);
    await conn.execute("INSERT INTO reservation_status_history(reservation_id,status,changed_by) VALUES(?,'Pending',?)", [i.insertId, u.id]);
    await conn.commit(); r.json({ ref, status: 'Pending', message: 'Request received. It is Pending until the hotel confirms it.' });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
app.get('/api/reservations/mine', auth, wrap(async (q, r) => r.json((await pool.execute('SELECT * FROM reservations WHERE user_id=? ORDER BY res_date DESC,res_time DESC', [q.user.id]))[0])));
app.post('/api/reservations/:id/cancel', auth, wrap(async (q, r) => {
  const [[x]] = await pool.execute('SELECT * FROM reservations WHERE id=? AND user_id=?', [q.params.id, q.user.id]);
  if (!x) return r.status(404).json({ error: 'Reservation not found.' });
  if (!['Pending', 'Confirmed'].includes(x.status)) return r.status(400).json({ error: `A ${x.status} reservation cannot be cancelled.` });
  const s = await settings();
  if ((new Date(`${x.res_date}T${x.res_time}`) - new Date()) / 36e5 < +s.cancel_hours) return r.status(400).json({ error: `Within ${s.cancel_hours} hours of the booking, please call ${s.phone} to cancel or change it.` });
  await pool.execute("UPDATE reservations SET status='Cancelled' WHERE id=?", [x.id]);
  await pool.execute("INSERT INTO reservation_status_history(reservation_id,status,changed_by) VALUES(?,'Cancelled',?)", [x.id, q.user.id]); r.json({ ok: true });
}));

// ---------- Admin ----------
app.get('/api/admin/reservations', admin, wrap(async (q, r) => {
  const w = [], p = [];
  if (q.query.date) { w.push('r.res_date=?'); p.push(q.query.date); }
  if (q.query.status) { w.push('r.status=?'); p.push(q.query.status); }
  if (q.query.ref) { w.push('r.ref LIKE ?'); p.push('%' + q.query.ref.toUpperCase() + '%'); }
  r.json((await pool.execute(`SELECT r.*,u.email FROM reservations r JOIN users u ON u.id=r.user_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY r.res_date DESC,r.res_time DESC LIMIT 300`, p))[0]);
}));
app.patch('/api/admin/reservations/:id', admin, wrap(async (q, r) => {
  const st = q.body.status; if (!['Pending', 'Confirmed', 'Rejected', 'Cancelled', 'Completed'].includes(st)) return r.status(400).json({ error: 'Invalid status.' });
  const [x] = await pool.execute('UPDATE reservations SET status=? WHERE id=?', [st, q.params.id]); if (!x.affectedRows) return r.status(404).json({ error: 'Not found.' });
  await pool.execute('INSERT INTO reservation_status_history(reservation_id,status,changed_by) VALUES(?,?,?)', [q.params.id, st, q.user.id]); r.json({ ok: true });
}));
app.get('/api/admin/stats', admin, wrap(async (q, r) => r.json({
  byStatus: (await pool.query('SELECT status,COUNT(*) n FROM reservations GROUP BY status'))[0],
  upcoming: (await pool.query("SELECT COUNT(*) n FROM reservations WHERE res_date>=CURDATE() AND status IN('Pending','Confirmed')"))[0][0].n,
  customers: (await pool.query("SELECT COUNT(*) n FROM users WHERE role='customer'"))[0][0].n })));
app.post('/api/admin/categories', admin, wrap(async (q, r) => { if (!q.body.name) return r.status(400).json({ error: 'Name required.' }); await pool.execute('INSERT INTO menu_categories(name) VALUES(?)', [q.body.name.trim()]); r.json({ ok: true }); }));
app.delete('/api/admin/categories/:id', admin, wrap(async (q, r) => { await pool.execute('DELETE FROM menu_categories WHERE id=?', [q.params.id]); r.json({ ok: true }); }));
const item = b => [parseInt(b.category_id, 10), String(b.name || '').trim(), String(b.description || '').slice(0, 300), parseFloat(b.price), String(b.emoji || '🍽️').slice(0, 8), b.featured ? 1 : 0, b.price_confirmed ? 1 : 0];
const itemOk = a => a[0] && a[1] && a[3] >= 0;
app.post('/api/admin/items', admin, wrap(async (q, r) => { const a = item(q.body); if (!itemOk(a)) return r.status(400).json({ error: 'Category, name and a valid price are required.' }); await pool.execute('INSERT INTO menu_items(category_id,name,description,price,emoji,featured,price_confirmed) VALUES(?,?,?,?,?,?,?)', a); r.json({ ok: true }); }));
app.put('/api/admin/items/:id', admin, wrap(async (q, r) => { const a = item(q.body); if (!itemOk(a)) return r.status(400).json({ error: 'Category, name and a valid price are required.' }); await pool.execute('UPDATE menu_items SET category_id=?,name=?,description=?,price=?,emoji=?,featured=?,price_confirmed=? WHERE id=?', [...a, q.params.id]); r.json({ ok: true }); }));
app.delete('/api/admin/items/:id', admin, wrap(async (q, r) => { await pool.execute('DELETE FROM menu_items WHERE id=?', [q.params.id]); r.json({ ok: true }); }));
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const up = multer({ storage: multer.diskStorage({ destination: UP, filename: (q, f, cb) => cb(null, crypto.randomBytes(8).toString('hex') + EXT[f.mimetype]) }), limits: { fileSize: 3 * 1024 * 1024 }, fileFilter: (q, f, cb) => cb(EXT[f.mimetype] ? null : new Error('Only JPG, PNG or WebP images allowed.'), !!EXT[f.mimetype]) });
app.post('/api/admin/gallery', admin, (q, r, n) => up.single('image')(q, r, e => e ? r.status(400).json({ error: e.message }) : n()), wrap(async (q, r) => {
  if (!q.file) return r.status(400).json({ error: 'Choose an image.' });
  await pool.execute('INSERT INTO gallery_images(file,alt_text) VALUES(?,?)', [q.file.filename, String(q.body.alt || 'Food at Fine Dishes Hotel').slice(0, 200)]); r.json({ ok: true });
}));
app.delete('/api/admin/gallery/:id', admin, wrap(async (q, r) => {
  const [[g]] = await pool.execute('SELECT file FROM gallery_images WHERE id=?', [q.params.id]);
  if (g) { fs.unlink(path.join(UP, path.basename(g.file)), () => {}); await pool.execute('DELETE FROM gallery_images WHERE id=?', [q.params.id]); } r.json({ ok: true });
}));
app.get('/api/admin/settings', admin, wrap(async (q, r) => r.json(await settings())));
app.put('/api/admin/settings', admin, wrap(async (q, r) => {
  for (const k of Object.keys(DEFAULTS)) if (q.body[k] !== undefined) {
    const v = String(q.body[k]).slice(0, 500);
    if (['open_time', 'close_time'].includes(k) && !/^\d{2}:\d{2}$/.test(v)) return r.status(400).json({ error: 'Times must be HH:MM.' });
    if (['capacity', 'cancel_hours'].includes(k) && !(parseInt(v, 10) >= 0)) return r.status(400).json({ error: `${k} must be a number.` });
    if (k === 'map_url' && v && !/^https:\/\/(www\.)?google\.com\/maps\/embed/.test(v)) return r.status(400).json({ error: 'Use a Google Maps "Embed a map" URL.' });
    await pool.execute('REPLACE INTO hotel_settings(k,v) VALUES(?,?)', [k, v]); }
  r.json({ ok: true });
}));

app.use('/api', (q, r) => r.status(404).json({ error: 'Not found.' }));
init().then(() => app.listen(PORT, () => console.log(`Fine Dishes Hotel running on http://localhost:${PORT}`))).catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
