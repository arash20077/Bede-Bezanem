import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, migrate } from './lib/db.js';

const DIST_DIR = path.join(process.cwd(), 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveStatic(req: IncomingMessage, res: ServerResponse, urlPath: string): void {
  // SPA: unknown routes fall back to index.html
  let filePath = path.join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Frontend build not found. Run npm run build.');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const ADMIN_STUDENT_ID = '4042103037';
const SESSION_DAYS = 30;
const ACTIVITY_LIMIT = 3;
const ACTIVITY_WINDOW_HOURS = 24;
const TEHRAN_OFFSET_MINUTES = 210;
const DEFAULT_MEAL_SCHEDULE = {
 'ناهار': { start: '11:30', end: '15:00' },
 'شام': { start: '17:00', end: '21:00' },
} as const;

type Json = Record<string, unknown>;
type UserRow = { id: number; full_name: string; student_id: string; phone: string; gender: 'MALE' | 'FEMALE' | null; role: string; status: string; must_change_password: number };
type SessionUser = UserRow | null;

migrate(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, student_id TEXT NOT NULL UNIQUE,
 phone TEXT NOT NULL UNIQUE, gender TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'USER',
 status TEXT NOT NULL DEFAULT 'ACTIVE', must_change_password INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS dining_halls (
 id INTEGER PRIMARY KEY AUTOINCREMENT, campus TEXT NOT NULL, name TEXT NOT NULL, gender TEXT NOT NULL DEFAULT 'MALE',
 is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meal_types (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS activities (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
 date_key TEXT NOT NULL, hall_id INTEGER NOT NULL REFERENCES dining_halls(id), meal_type_id INTEGER NOT NULL REFERENCES meal_types(id),
 status TEXT NOT NULL DEFAULT 'ACTIVE', expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user_id, kind, date_key, hall_id, meal_type_id, status)
);
CREATE TABLE IF NOT EXISTS matches (
 id INTEGER PRIMARY KEY AUTOINCREMENT, offer_id INTEGER NOT NULL REFERENCES activities(id), request_id INTEGER NOT NULL REFERENCES activities(id),
 selected_by INTEGER NOT NULL REFERENCES users(id), offer_confirmed INTEGER NOT NULL DEFAULT 1,
 request_confirmed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DROP INDEX IF EXISTS one_open_match_per_offer;
DROP INDEX IF EXISTS one_open_match_per_request;
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request_per_pair ON matches(offer_id,request_id) WHERE status='PENDING';
CREATE UNIQUE INDEX IF NOT EXISTS one_connected_match_per_offer ON matches(offer_id) WHERE status='CONNECTED';
CREATE UNIQUE INDEX IF NOT EXISTS one_connected_match_per_request ON matches(request_id) WHERE status='CONNECTED';
CREATE TABLE IF NOT EXISTS password_reset_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'NEW',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS information_change_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), text TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'NEW', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL,
 title TEXT NOT NULL, body TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS announcements (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'NORMAL',
 is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id INTEGER NOT NULL REFERENCES users(id), activity_id INTEGER REFERENCES activities(id),
 category TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'NEW', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_activity_logs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL,
 target_type TEXT, target_id TEXT, details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Backward-compatible schema upgrades for databases created by older versions.
function hasColumn(table: string, column: string) {
 const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
 return columns.some(x => x.name === column);
}
if (!hasColumn('users','gender')) db.exec("ALTER TABLE users ADD COLUMN gender TEXT");
if (!hasColumn('dining_halls','gender')) db.exec("ALTER TABLE dining_halls ADD COLUMN gender TEXT DEFAULT 'MALE'");

const existingHalls = db.prepare('SELECT id,campus,name,gender FROM dining_halls').all() as {id:number;campus:string;name:string;gender:string|null}[];
if (existingHalls.length) {
 const renameHall = db.prepare('UPDATE dining_halls SET name=?, gender=? WHERE id=?');
 const addFemaleHall = db.prepare('INSERT INTO dining_halls(campus,name,gender,sort_order) SELECT campus,?, ?, sort_order + 1000 FROM dining_halls WHERE id=?');
 const femaleExists = db.prepare("SELECT 1 FROM dining_halls WHERE name=? AND gender='FEMALE' LIMIT 1");
 existingHalls.forEach(h => {
  const baseName = h.name.replace(/ \((?:برادران|خواهران)\)$/, '');
  if (!h.name.endsWith('(برادران)') && !h.name.endsWith('(خواهران)')) {
   renameHall.run(`${baseName} (برادران)`, 'MALE', h.id);
   if (!femaleExists.get(`${baseName} (خواهران)`)) addFemaleHall.run(`${baseName} (خواهران)`, 'FEMALE', h.id);
  }
 });
}

const seedHall = db.prepare('INSERT INTO dining_halls (campus,name,gender,sort_order) VALUES (?,?,?,?)');
const hallsCount = db.prepare('SELECT COUNT(*) c FROM dining_halls').get() as { c: number };
if (hallsCount.c === 0) {
 [['پردیس','سالن غذاخوری باغ ابریشم','MALE',1],['پردیس','سالن غذاخوری باغ ابریشم','FEMALE',2],
  ['علوم اجتماعی','سالن غذاخوری شکرانه','MALE',3],['علوم اجتماعی','سالن غذاخوری شکرانه','FEMALE',4],
  ['کشاورزی','سالن غذاخوری زیتون','MALE',5],['کشاورزی','سالن غذاخوری زیتون','FEMALE',6],
  ['دندانپزشکی','سالن غذاخوری بهار','MALE',7],['دندانپزشکی','سالن غذاخوری بهار','FEMALE',8]].forEach((h) => seedHall.run(...h));
}
const mealCount = db.prepare('SELECT COUNT(*) c FROM meal_types').get() as { c: number };
if (mealCount.c === 0) { db.prepare('INSERT INTO meal_types (name) VALUES (?),(?)').run('ناهار','شام'); }
db.prepare("UPDATE users SET role='ADMIN' WHERE student_id=?").run(ADMIN_STUDENT_ID);
if (!(db.prepare("SELECT 1 FROM settings WHERE key='maintenance'").get())) db.prepare("INSERT INTO settings(key,value) VALUES('maintenance','0')").run();
if (!(db.prepare("SELECT 1 FROM settings WHERE key='maintenance_message'").get())) db.prepare("INSERT INTO settings(key,value) VALUES('maintenance_message','سایت موقتاً در حال به‌روزرسانی است.')").run();
if (!(db.prepare("SELECT 1 FROM settings WHERE key='meal_schedule'").get())) db.prepare("INSERT INTO settings(key,value) VALUES('meal_schedule',?)").run(JSON.stringify(DEFAULT_MEAL_SCHEDULE));

function send(res: ServerResponse, status: number, data: unknown, cookies?: string[]) {
 res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(cookies ? { 'Set-Cookie': cookies } : {}) });
 res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<Json> {
 const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
 if (!chunks.length) return {}; return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json;
}
function hashPassword(value: string, salt = crypto.randomBytes(16).toString('hex')) {
 return `${salt}:${crypto.scryptSync(value, salt, 64).toString('hex')}`;
}
function verifyPassword(value: string, stored: string) {
 const [salt, saved] = stored.split(':'); if (!salt || !saved) return false;
 return crypto.timingSafeEqual(Buffer.from(saved, 'hex'), crypto.scryptSync(value, salt, 64));
}
function cookie(req: IncomingMessage, name: string) {
 const item = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
 return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
function sessionToken(req: IncomingMessage) {
 const authorization = req.headers.authorization || '';
 const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
 return cookie(req, 'bb_session') || bearer;
}
function currentUser(req: IncomingMessage): SessionUser {
 const token = sessionToken(req); if (!token) return null;
 return db.prepare(`SELECT u.id,u.full_name,u.student_id,u.phone,u.gender,u.role,u.status,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND julianday(s.expires_at)>julianday('now')`).get(crypto.createHash('sha256').update(token).digest('hex')) as UserRow | undefined || null;
}
function auth(req: IncomingMessage, res: ServerResponse): UserRow | null {
 const user = currentUser(req); if (!user) { send(res, 401, { error: 'برای ادامه وارد حساب شوید.' }); return null; }
 if (user.status !== 'ACTIVE') { send(res, 403, { error: 'حساب شما فعال نیست.' }); return null; } return user;
}
function admin(req: IncomingMessage, res: ServerResponse): UserRow | null {
 const user = auth(req, res); if (!user) return null; if (user.role !== 'ADMIN') { send(res, 403, { error: 'دسترسی مدیریت ندارید.' }); return null; } return user;
}
function notify(userId: number, type: string, title: string, text: string) { db.prepare('INSERT INTO notifications(user_id,type,title,body) VALUES(?,?,?,?)').run(userId,type,title,text); }
function logAdmin(adminId: number, action: string, targetType?: string, targetId?: string, details?: string) { db.prepare('INSERT INTO admin_activity_logs(admin_id,action,target_type,target_id,details) VALUES(?,?,?,?,?)').run(adminId,action,targetType || null,targetId || null,details || null); }
type MealSchedule = Record<string, { start: string; end: string }>;
function mealSchedule(): MealSchedule {
 const row = db.prepare("SELECT value FROM settings WHERE key='meal_schedule'").get() as { value: string } | undefined;
 try { return row ? JSON.parse(row.value) as MealSchedule : DEFAULT_MEAL_SCHEDULE; }
 catch { return DEFAULT_MEAL_SCHEDULE; }
}
function tehranTimeToUtc(dateKey: string, time: string) {
 const [year, month, day] = dateKey.split('-').map(Number);
 const [hour, minute] = time.split(':').map(Number);
 return new Date(Date.UTC(year, month - 1, day, hour, minute) - TEHRAN_OFFSET_MINUTES * 60_000).toISOString();
}
function dateExpiry(dateKey: string, mealName: string) {
 const schedule = mealSchedule();
 return tehranTimeToUtc(dateKey, schedule[mealName]?.end || '21:00');
}
function syncCurrentActivityExpiries() {
 const rows = db.prepare("SELECT a.id,a.date_key,m.name meal_name FROM activities a JOIN meal_types m ON m.id=a.meal_type_id WHERE a.status IN ('ACTIVE','CONNECTING','DISABLED')").all() as {id:number;date_key:string;meal_name:string}[];
 const update = db.prepare('UPDATE activities SET expires_at=? WHERE id=?');
 try { db.exec('BEGIN IMMEDIATE'); rows.forEach(row => update.run(dateExpiry(row.date_key,row.meal_name),row.id)); db.exec('COMMIT'); }
 catch (error) { try { db.exec('ROLLBACK'); } catch {} console.error('Sync activity expiries failed', error); }
}
syncCurrentActivityExpiries();
function migrateLegacyConnectionStates() {
 try {
  db.exec('BEGIN IMMEDIATE');
  db.prepare("UPDATE activities SET status='MATCHED' WHERE status='CONNECTING' AND EXISTS (SELECT 1 FROM matches x WHERE x.status='CONNECTED' AND (x.offer_id=activities.id OR x.request_id=activities.id))").run();
  db.prepare("UPDATE activities SET status='ACTIVE' WHERE status='CONNECTING' AND EXISTS (SELECT 1 FROM matches x WHERE x.status='PENDING' AND (x.offer_id=activities.id OR x.request_id=activities.id))").run();
  db.exec('COMMIT');
 } catch(error) { try{db.exec('ROLLBACK')}catch{} console.error('Legacy connection state migration failed',error); }
}
migrateLegacyConnectionStates();
function expireActivities() {
 const expired = db.prepare("SELECT id,user_id FROM activities WHERE status IN ('ACTIVE','CONNECTING','DISABLED') AND julianday(expires_at)<=julianday('now')").all() as { id:number; user_id:number }[];
 if (!expired.length) return;
 try {
  db.exec('BEGIN IMMEDIATE');
  const ids = expired.map(x => x.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE matches SET status='EXPIRED',updated_at=CURRENT_TIMESTAMP WHERE status IN ('PENDING','CONNECTED') AND (offer_id IN (${placeholders}) OR request_id IN (${placeholders}))`).run(...ids,...ids);
  db.prepare(`UPDATE activities SET status='EXPIRED' WHERE id IN (${placeholders}) AND status IN ('ACTIVE','CONNECTING','DISABLED')`).run(...ids);
  db.exec('COMMIT');
  expired.forEach(x => notify(x.user_id,'EXPIRED','فعالیت منقضی شد','زمان این فعالیت به پایان رسیده است.'));
 } catch (error) { try { db.exec('ROLLBACK'); } catch {} console.error('Expire activities failed', error); }
}
function activityRows(where: string, params: (string|number)[]) {
 return db.prepare(`SELECT a.*,h.name hall_name,h.campus,m.name meal_name,u.full_name owner_name,u.student_id owner_student_id FROM activities a JOIN dining_halls h ON h.id=a.hall_id JOIN meal_types m ON m.id=a.meal_type_id JOIN users u ON u.id=a.user_id ${where} ORDER BY a.created_at DESC`).all(...params);
}

const server = createServer(async (req, res) => {
 try {
  expireActivities();
  const url = new URL(req.url || '/', 'http://localhost'); const path = url.pathname; const method = req.method || 'GET';
  if (!path.startsWith('/api/')) return serveStatic(req, res, path);
  if (path === '/api/config' && method === 'GET') {
   const viewer = currentUser(req);
    const halls = viewer?.gender ? db.prepare('SELECT * FROM dining_halls WHERE is_active=1 AND gender=? ORDER BY sort_order,id').all(viewer.gender) : [];
   const mealTypes = db.prepare('SELECT * FROM meal_types WHERE is_active=1 ORDER BY id').all();
   const announcements = db.prepare('SELECT * FROM announcements WHERE is_active=1 ORDER BY created_at DESC').all();
   const maintenance = (db.prepare("SELECT value FROM settings WHERE key='maintenance'").get() as {value:string}).value === '1';
   const maintenanceMessage = (db.prepare("SELECT value FROM settings WHERE key='maintenance_message'").get() as {value:string}).value;
   return send(res, 200, { halls, mealTypes, announcements, maintenance, maintenanceMessage });
  }
  if (path === '/api/auth/register' && method === 'POST') {
   const b = await body(req); const fullName=String(b.fullName||'').trim(), gender=String(b.gender||''), studentId=String(b.studentId||'').trim(), phone=String(b.phone||'').trim(), password=String(b.password||'');
   if (fullName.length<3 || !['MALE','FEMALE'].includes(gender) || !/^\d{10}$/.test(studentId) || !/^09\d{9}$/.test(phone) || password.length<8) return send(res,400,{error:'اطلاعات فرم معتبر نیست؛ رمز باید حداقل ۸ کاراکتر باشد.'});
   try { const role=studentId===ADMIN_STUDENT_ID?'ADMIN':'USER'; db.prepare('INSERT INTO users(full_name,student_id,phone,gender,password_hash,role) VALUES(?,?,?,?,?,?)').run(fullName,studentId,phone,gender,hashPassword(password),role); return send(res,201,{ok:true}); }
   catch { return send(res,409,{error:'کد دانشجویی یا شماره تلفن قبلاً ثبت شده است.'}); }
  }
  if (path === '/api/auth/login' && method === 'POST') {
   const b=await body(req), identifier=String(b.identifier||'').trim(), password=String(b.password||'');
   const user=db.prepare('SELECT * FROM users WHERE student_id=? OR phone=?').get(identifier,identifier) as (UserRow & {password_hash:string})|undefined;
   if(!user || !verifyPassword(password,user.password_hash)) return send(res,401,{error:'اطلاعات ورود نادرست است.'});
   if(user.status!=='ACTIVE') return send(res,403,{error:'حساب شما غیرفعال یا مسدود است.'});
   const token=crypto.randomBytes(32).toString('base64url'), hash=crypto.createHash('sha256').update(token).digest('hex');
   db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,datetime('now',?))").run(hash,user.id,`+${SESSION_DAYS} days`);
   db.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
   const safeUser: UserRow = { id:user.id, full_name:user.full_name, student_id:user.student_id, phone:user.phone, gender:user.gender, role:user.role, status:user.status, must_change_password:user.must_change_password };
   return send(res,200,{ok:true,token,user:safeUser},[`bb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS*86400}`]);
  }
  if(path==='/api/auth/me'&&method==='GET') return send(res,200,{user:currentUser(req)});
  if(path==='/api/auth/logout'&&method==='POST') { const token=sessionToken(req); if(token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(token).digest('hex')); return send(res,200,{ok:true},['bb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']); }
  if(path==='/api/auth/change-password'&&method==='POST') { const u=auth(req,res); if(!u)return; const b=await body(req), next=String(b.newPassword||''); if(next.length<8)return send(res,400,{error:'رمز جدید باید حداقل ۸ کاراکتر باشد.'}); db.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').run(hashPassword(next),u.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); return send(res,200,{ok:true},['bb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']); }
  if(path==='/api/information-change-requests'&&method==='POST'){const u=auth(req,res);if(!u)return;const b=await body(req),text=String(b.text||'').trim();if(text.length<5)return send(res,400,{error:'متن درخواست را کامل‌تر بنویسید.'});db.prepare("INSERT INTO information_change_requests(user_id,text) VALUES(?,?)").run(u.id,text);return send(res,201,{ok:true});}
   if(path==='/api/information-change-requests/mine'&&method==='GET'){const u=auth(req,res);if(!u)return;const items=db.prepare('SELECT * FROM information_change_requests WHERE user_id=? ORDER BY created_at DESC').all(u.id);return send(res,200,{items});}
   if(path==='/api/password-reset'&&method==='POST') { const b=await body(req), id=String(b.identifier||'').trim(); const u=db.prepare('SELECT id FROM users WHERE student_id=? OR phone=?').get(id,id) as {id:number}|undefined; if(u && !db.prepare("SELECT 1 FROM password_reset_requests WHERE user_id=? AND status='NEW'").get(u.id)) db.prepare('INSERT INTO password_reset_requests(user_id) VALUES(?)').run(u.id); return send(res,200,{ok:true,message:'اگر حسابی با این مشخصات وجود داشته باشد، درخواست ثبت شد.'}); }
  if(path==='/api/activities'&&method==='POST') {
   const u=auth(req,res); if(!u)return; const b=await body(req), kind=String(b.kind), dateKey=String(b.dateKey), hallId=Number(b.hallId), mealTypeId=Number(b.mealTypeId);
   if(!['OFFER','REQUEST'].includes(kind)||!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)||!Number.isInteger(hallId)||!Number.isInteger(mealTypeId)) return send(res,400,{error:'اطلاعات فعالیت معتبر نیست.'});
   const meal=db.prepare('SELECT name FROM meal_types WHERE id=? AND is_active=1').get(mealTypeId) as {name:string}|undefined;
   const hall=db.prepare('SELECT id,gender FROM dining_halls WHERE id=? AND is_active=1').get(hallId) as {id:number;gender:string}|undefined;
    if(!hall||!meal) return send(res,400,{error:'سالن یا نوع غذا فعال نیست.'});
    if(!u.gender || hall.gender!==u.gender) return send(res,403,{error:'این سلف برای جنسیت حساب شما قابل استفاده نیست.'});
   const expiresAt=dateExpiry(dateKey,meal.name);
   if(new Date(expiresAt).getTime()<=Date.now()) return send(res,409,{error:'زمان این فعالیت به پایان رسیده است.'});
   try {
    db.exec('BEGIN IMMEDIATE');
    const recent=(db.prepare("SELECT COUNT(*) c FROM activities WHERE user_id=? AND status<>'CANCELLED' AND created_at>datetime('now',?)").get(u.id,`-${ACTIVITY_WINDOW_HOURS} hours`) as {c:number}).c;
    if(recent>=ACTIVITY_LIMIT){db.exec('ROLLBACK');return send(res,429,{error:'سهمیه ثبت فعالیت شما در ۲۴ ساعت گذشته تکمیل شده است.'});}
    const result=db.prepare('INSERT INTO activities(user_id,kind,date_key,hall_id,meal_type_id,expires_at) VALUES(?,?,?,?,?,?)').run(u.id,kind,dateKey,hallId,mealTypeId,expiresAt);
    db.exec('COMMIT');
    const opposite=kind==='OFFER'?'REQUEST':'OFFER'; const matches=db.prepare("SELECT DISTINCT a.user_id FROM activities a JOIN users other ON other.id=a.user_id WHERE a.kind=? AND a.date_key=? AND a.hall_id=? AND a.meal_type_id=? AND a.status='ACTIVE' AND julianday(a.expires_at)>julianday('now') AND a.user_id<>? AND other.gender=?").all(opposite,dateKey,hallId,mealTypeId,u.id,u.gender) as {user_id:number}[];
    matches.forEach(x=>notify(x.user_id,'NEW_MATCH','تطبیق جدید','یک فعالیت منطبق با درخواست شما ثبت شد.')); return send(res,201,{ok:true,id:Number(result.lastInsertRowid)});
   } catch(error) { try{db.exec('ROLLBACK')}catch{} console.error('Create activity failed',u.id,error); return send(res,409,{error:'این فعالیت فعال قبلاً ثبت شده است.'}); }
  }
  if(path==='/api/activities/mine'&&method==='GET') { const u=auth(req,res);if(!u)return; const rows=activityRows('WHERE a.user_id=?',[u.id]) as Json[]; return send(res,200,{items:rows}); }
  const cancelActivity=path.match(/^\/api\/activities\/(\d+)\/cancel$/);
  if(cancelActivity&&method==='POST') {
   const u=auth(req,res);if(!u)return;const activityId=Number(cancelActivity[1]);
   try {
    db.exec('BEGIN IMMEDIATE');
    const activity=db.prepare("SELECT * FROM activities WHERE id=? AND user_id=? AND status IN ('ACTIVE','CONNECTING') AND julianday(expires_at)>julianday('now')").get(activityId,u.id) as any;
    if(!activity) { db.exec('ROLLBACK'); return send(res,409,{error:'این فعالیت دیگر قابل لغو نیست.'}); }
    const openMatches=db.prepare("SELECT x.*,CASE WHEN o.user_id=? THEN r.user_id ELSE o.user_id END other_user_id FROM matches x JOIN activities o ON o.id=x.offer_id JOIN activities r ON r.id=x.request_id WHERE (x.offer_id=? OR x.request_id=?) AND x.status='PENDING'").all(u.id,activityId,activityId) as any[];
    if(activity.status==='CONNECTING'&&!openMatches.length) { db.exec('ROLLBACK'); return send(res,409,{error:'این ارتباط دیگر قابل لغو نیست.'}); }
    db.prepare("UPDATE activities SET status='CANCELLED' WHERE id=?").run(activityId);
    db.prepare("UPDATE matches SET status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE status='PENDING' AND (offer_id=? OR request_id=?)").run(activityId,activityId);
    openMatches.forEach(openMatch=>notify(openMatch.other_user_id,'MATCH_CANCELLED','درخواست ارتباط بسته شد','طرف مقابل فعالیت خود را لغو کرد.'));
    db.exec('COMMIT');
    return send(res,200,{ok:true});
   } catch(error) { try{db.exec('ROLLBACK')}catch{} console.error('Cancel activity failed',activityId,error); return send(res,500,{error:'لغو فعالیت انجام نشد؛ دوباره تلاش کنید.'}); }
  }
  const candidates=path.match(/^\/api\/activities\/(\d+)\/candidates$/);
  if(candidates&&method==='GET') {
   const u=auth(req,res);if(!u)return;
   const source=db.prepare("SELECT a.*,h.gender hall_gender FROM activities a JOIN dining_halls h ON h.id=a.hall_id WHERE a.id=? AND a.user_id=? AND a.status='ACTIVE' AND julianday(a.expires_at)>julianday('now')").get(Number(candidates[1]),u.id) as any;
   if(!source)return send(res,404,{error:'فعالیت فعال پیدا نشد.'});
   const opposite=source.kind==='OFFER'?'REQUEST':'OFFER';
   const items=activityRows("JOIN users candidate_user ON candidate_user.id=a.user_id JOIN dining_halls candidate_hall ON candidate_hall.id=a.hall_id WHERE a.kind=? AND a.status='ACTIVE' AND julianday(a.expires_at)>julianday('now') AND a.date_key=? AND a.hall_id=? AND a.meal_type_id=? AND a.user_id<>? AND candidate_user.gender=? AND candidate_hall.gender=? AND NOT EXISTS (SELECT 1 FROM matches x WHERE x.offer_id=CASE WHEN ?='OFFER' THEN ? ELSE a.id END AND x.request_id=CASE WHEN ?='REQUEST' THEN ? ELSE a.id END AND x.status IN ('PENDING','CONNECTED'))",[opposite,source.date_key,source.hall_id,source.meal_type_id,u.id,u.gender,u.gender,source.kind,source.id,source.kind,source.id]);
   return send(res,200,{items});
  }
  if(path==='/api/matches'&&method==='POST') {
   const u=auth(req,res);if(!u)return;const b=await body(req),sourceActivityId=Number(b.sourceActivityId),targetActivityId=Number(b.targetActivityId);
   try {
    db.exec('BEGIN IMMEDIATE');
    const source=db.prepare("SELECT * FROM activities WHERE id=? AND user_id=? AND status='ACTIVE' AND julianday(expires_at)>julianday('now')").get(sourceActivityId,u.id) as any;
    const target=db.prepare("SELECT a.*,h.gender hall_gender,u.gender user_gender FROM activities a JOIN dining_halls h ON h.id=a.hall_id JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.user_id<>? AND a.status='ACTIVE' AND julianday(a.expires_at)>julianday('now')").get(targetActivityId,u.id) as any;
    if(!source||!target||!u.gender||target.user_gender!==u.gender||target.hall_gender!==u.gender||source.kind===target.kind||source.date_key!==target.date_key||source.hall_id!==target.hall_id||source.meal_type_id!==target.meal_type_id) throw new Error('invalid');
    const offer=source.kind==='OFFER'?source:target, request=source.kind==='REQUEST'?source:target;
    const r=db.prepare('INSERT INTO matches(offer_id,request_id,selected_by,offer_confirmed,request_confirmed,status) VALUES(?,?,?,?,?,\'PENDING\')').run(offer.id,request.id,u.id,source.kind==='OFFER'?1:0,source.kind==='REQUEST'?1:0);
    notify(target.user_id,'CONNECTION_REQUEST','درخواست ارتباط جدید',source.kind==='REQUEST'?'یک دانشجو برای غذای شما درخواست ارتباط فرستاده است.':'یک دانشجو برای درخواست غذای شما پیام ارتباط فرستاده است.');
    db.exec('COMMIT');return send(res,201,{ok:true,id:Number(r.lastInsertRowid)});
   } catch(error) { try{db.exec('ROLLBACK')}catch{} console.error('Create connection request failed',u.id,sourceActivityId,targetActivityId,error);return send(res,409,{error:'این درخواست قبلاً ثبت شده یا یکی از فعالیت‌ها دیگر معتبر نیست.'}); }
  }
  if(path==='/api/matches/mine'&&method==='GET') {
   const u=auth(req,res);if(!u)return;
   const items=db.prepare(`SELECT x.*,o.user_id offer_user_id,r.user_id request_user_id,o.date_key,h.name hall_name,mt.name meal_name,uo.full_name offer_name,ur.full_name request_name,CASE WHEN x.selected_by=? THEN 'SENT' ELSE 'RECEIVED' END direction,CASE WHEN x.status='CONNECTED' THEN CASE WHEN o.user_id=? THEN ur.phone ELSE uo.phone END END other_phone FROM matches x JOIN activities o ON o.id=x.offer_id JOIN activities r ON r.id=x.request_id JOIN dining_halls h ON h.id=o.hall_id JOIN meal_types mt ON mt.id=o.meal_type_id JOIN users uo ON uo.id=o.user_id JOIN users ur ON ur.id=r.user_id WHERE (o.user_id=? OR r.user_id=?) AND uo.gender=? AND ur.gender=? ORDER BY x.updated_at DESC`).all(u.id,u.id,u.gender,u.gender);
   return send(res,200,{items});
  }
  const confirm=path.match(/^\/api\/matches\/(\d+)\/confirm$/);
  if(confirm&&method==='POST') {
   const u=auth(req,res);if(!u)return;const matchId=Number(confirm[1]);
   try {
    db.exec('BEGIN IMMEDIATE');
    const m=db.prepare(`SELECT x.*,o.user_id offer_user_id,o.status offer_status,o.expires_at offer_expires,r.user_id request_user_id,r.status request_status,r.expires_at request_expires FROM matches x JOIN activities o ON o.id=x.offer_id JOIN activities r ON r.id=x.request_id WHERE x.id=? AND x.status='PENDING'`).get(matchId) as any;
    if(!m||m.selected_by===u.id||![m.offer_user_id,m.request_user_id].includes(u.id)) { db.exec('ROLLBACK');return send(res,409,{error:'این درخواست قابل پذیرش نیست.'}); }
    if(m.offer_status!=='ACTIVE'||m.request_status!=='ACTIVE'||new Date(m.offer_expires).getTime()<=Date.now()||new Date(m.request_expires).getTime()<=Date.now()) { db.exec('ROLLBACK');return send(res,409,{error:'یکی از فعالیت‌ها دیگر فعال نیست.'}); }
    const changed=db.prepare("UPDATE matches SET status='CONNECTED',offer_confirmed=1,request_confirmed=1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING'").run(m.id);
    if(!changed.changes) throw new Error('already handled');
    db.prepare("UPDATE activities SET status='MATCHED' WHERE id IN (?,?) AND status='ACTIVE'").run(m.offer_id,m.request_id);
    const competing=db.prepare("SELECT id,selected_by FROM matches WHERE id<>? AND status='PENDING' AND (offer_id IN (?,?) OR request_id IN (?,?))").all(m.id,m.offer_id,m.request_id,m.offer_id,m.request_id) as {id:number;selected_by:number}[];
    db.prepare("UPDATE matches SET status='REJECTED',updated_at=CURRENT_TIMESTAMP WHERE id<>? AND status='PENDING' AND (offer_id IN (?,?) OR request_id IN (?,?))").run(m.id,m.offer_id,m.request_id,m.offer_id,m.request_id);
    competing.forEach(x=>notify(x.selected_by,'REQUEST_REJECTED','درخواست رد شد','این فعالیت با دانشجوی دیگری ارتباط برقرار کرد.'));
    notify(m.selected_by,'REQUEST_ACCEPTED','درخواست پذیرفته شد','درخواست شما پذیرفته شد. ارتباط برقرار شد.');
    notify(u.id,'CONNECTED','ارتباط برقرار شد','شماره طرف مقابل اکنون قابل مشاهده است.');
    db.exec('COMMIT');return send(res,200,{ok:true});
   } catch(error) { try{db.exec('ROLLBACK')}catch{} console.error('Accept connection request failed',matchId,error);return send(res,409,{error:'این فعالیت هم‌اکنون به ارتباط دیگری اختصاص یافته است.'}); }
  }
  const reject=path.match(/^\/api\/matches\/(\d+)\/reject$/);
  if(reject&&method==='POST') {
   const u=auth(req,res);if(!u)return;const matchId=Number(reject[1]);
   const m=db.prepare(`SELECT x.*,o.user_id offer_user_id,r.user_id request_user_id FROM matches x JOIN activities o ON o.id=x.offer_id JOIN activities r ON r.id=x.request_id WHERE x.id=? AND x.status='PENDING'`).get(matchId) as any;
   if(!m||m.selected_by===u.id||![m.offer_user_id,m.request_user_id].includes(u.id))return send(res,409,{error:'این درخواست قابل رد کردن نیست.'});
   const changed=db.prepare("UPDATE matches SET status='REJECTED',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='PENDING'").run(matchId);
   if(!changed.changes)return send(res,409,{error:'این درخواست قبلاً بررسی شده است.'});
   notify(m.selected_by,'REQUEST_REJECTED','درخواست رد شد','درخواست ارتباط شما رد شد.');return send(res,200,{ok:true});
  }
  const result=path.match(/^\/api\/matches\/(\d+)\/result$/);
  if(result&&method==='POST') { const u=auth(req,res);if(!u)return; const b=await body(req), outcome=String(b.outcome); const m=db.prepare('SELECT x.*,o.user_id offer_user_id,r.user_id request_user_id FROM matches x JOIN activities o ON o.id=x.offer_id JOIN activities r ON r.id=x.request_id WHERE x.id=?').get(Number(result[1])) as any; if(!m||![m.offer_user_id,m.request_user_id].includes(u.id)||!['COMPLETED','FAILED'].includes(outcome))return send(res,400,{error:'درخواست معتبر نیست.'}); db.exec('BEGIN IMMEDIATE'); try{db.prepare('UPDATE matches SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(outcome,m.id); db.prepare(`UPDATE activities SET status=? WHERE id IN (?,?)`).run(outcome,m.offer_id,m.request_id); if(outcome==='FAILED')db.prepare("UPDATE activities SET status='ACTIVE' WHERE id IN (?,?) AND julianday(expires_at)>julianday('now')").run(m.offer_id,m.request_id); db.exec('COMMIT'); [m.offer_user_id,m.request_user_id].forEach((id:number)=>notify(id,outcome,outcome==='COMPLETED'?'ارتباط انجام شد':'ارتباط انجام نشد',outcome==='COMPLETED'?'این فعالیت به تاریخچه منتقل شد.':'فعالیت برای تطبیق دوباره باز شد.'));return send(res,200,{ok:true});}catch(e){db.exec('ROLLBACK');throw e;} }
  if(path==='/api/notifications'&&method==='GET'){const u=auth(req,res);if(!u)return;const items=db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(u.id);return send(res,200,{items});}
  if(path==='/api/notifications/read'&&method==='POST'){const u=auth(req,res);if(!u)return;db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(u.id);return send(res,200,{ok:true});}
  if(path==='/api/reports'&&method==='POST'){const u=auth(req,res);if(!u)return;const b=await body(req),category=String(b.category),details=String(b.details||''),activityId=b.activityId?Number(b.activityId):null;if(!['FAKE','BEHAVIOR','ABUSE','SUSPICIOUS','OTHER'].includes(category))return send(res,400,{error:'نوع گزارش معتبر نیست.'});db.prepare('INSERT INTO reports(reporter_id,activity_id,category,details) VALUES(?,?,?,?)').run(u.id,activityId,category,details);return send(res,201,{ok:true});}
  if(path==='/api/admin/dashboard'&&method==='GET'){const a=admin(req,res);if(!a)return; const scalar=(q:string)=>(db.prepare(q).get() as {c:number}).c; return send(res,200,{stats:{users:scalar('SELECT COUNT(*) c FROM users'),activeUsers:scalar("SELECT COUNT(*) c FROM users WHERE status='ACTIVE'"),offers:scalar("SELECT COUNT(*) c FROM activities WHERE kind='OFFER' AND status='ACTIVE'"),requests:scalar("SELECT COUNT(*) c FROM activities WHERE kind='REQUEST' AND status='ACTIVE'"),matches:scalar("SELECT COUNT(*) c FROM matches WHERE status IN ('PENDING','CONNECTED')"),resets:scalar("SELECT COUNT(*) c FROM password_reset_requests WHERE status='NEW'"),reports:scalar("SELECT COUNT(*) c FROM reports WHERE status='NEW'")}});}
  if(path==='/api/admin/data'&&method==='GET'){const a=admin(req,res);if(!a)return;return send(res,200,{users:db.prepare('SELECT id,full_name,student_id,phone,gender,role,status,created_at,last_login_at FROM users ORDER BY created_at DESC').all(),activities:activityRows('',[]),resets:db.prepare('SELECT p.*,u.full_name,u.student_id,u.phone FROM password_reset_requests p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC').all(),changeRequests:db.prepare('SELECT r.*,u.full_name,u.student_id,u.phone,u.gender FROM information_change_requests r JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC').all(),reports:db.prepare('SELECT r.*,u.full_name reporter_name FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC').all(),announcements:db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all(),halls:db.prepare('SELECT * FROM dining_halls ORDER BY sort_order,id').all(),mealTypes:db.prepare('SELECT * FROM meal_types ORDER BY id').all(),logs:db.prepare('SELECT l.*,u.full_name admin_name FROM admin_activity_logs l JOIN users u ON u.id=l.admin_id ORDER BY l.created_at DESC LIMIT 200').all(),settings:Object.fromEntries((db.prepare('SELECT * FROM settings').all() as {key:string,value:string}[]).map(x=>[x.key,x.value]))});}
  if(path==='/api/admin/action'&&method==='POST'){const a=admin(req,res);if(!a)return;const b=await body(req),action=String(b.action),id=Number(b.id); if(action==='USER_STATUS'){const status=String(b.value);if(!['ACTIVE','INACTIVE','BLOCKED'].includes(status))return send(res,400,{error:'وضعیت نامعتبر است.'});db.prepare('UPDATE users SET status=? WHERE id=? AND role<>\'ADMIN\'').run(status,id);logAdmin(a.id,'تغییر وضعیت کاربر','USER',String(id),status);}
    else if(action==='USER_GENDER'){const gender=String(b.value);if(!['MALE','FEMALE'].includes(gender))return send(res,400,{error:'جنسیت نامعتبر است.'});const changed=db.prepare('UPDATE users SET gender=? WHERE id=?').run(gender,id);if(!changed.changes)return send(res,404,{error:'کاربر پیدا نشد.'});logAdmin(a.id,'تغییر جنسیت کاربر','USER',String(id),gender);}
    else if(action==='CHANGE_REQUEST_STATUS'){const status=String(b.value);if(!['NEW','RESOLVED'].includes(status))return send(res,400,{error:'وضعیت درخواست نامعتبر است.'});db.prepare("UPDATE information_change_requests SET status=?,resolved_at=CASE WHEN ?='RESOLVED' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?").run(status,status,id);logAdmin(a.id,'تغییر وضعیت درخواست اطلاعات','CHANGE_REQUEST',String(id),status);}
   else if(action==='ACTIVITY_DISABLE'){
    try { db.exec('BEGIN IMMEDIATE');const changed=db.prepare("UPDATE activities SET status='DISABLED' WHERE id=? AND status='ACTIVE' AND julianday(expires_at)>julianday('now')").run(id);if(!changed.changes){db.exec('ROLLBACK');return send(res,409,{error:'فقط فعالیت فعال و معتبر قابل غیرفعال‌کردن است.'});}const pending=db.prepare("SELECT selected_by FROM matches WHERE status='PENDING' AND (offer_id=? OR request_id=?)").all(id,id) as {selected_by:number}[];db.prepare("UPDATE matches SET status='CANCELLED',updated_at=CURRENT_TIMESTAMP WHERE status='PENDING' AND (offer_id=? OR request_id=?)").run(id,id);logAdmin(a.id,'غیرفعال‌کردن فعالیت','ACTIVITY',String(id),'ACTIVE → DISABLED');db.exec('COMMIT');pending.forEach(x=>notify(x.selected_by,'REQUEST_CANCELLED','درخواست بسته شد','فعالیت طرف مقابل توسط مدیریت غیرفعال شد.'));}
    catch(error){try{db.exec('ROLLBACK')}catch{}console.error('Admin disable activity failed',a.id,id,error);return send(res,500,{error:'عملیات انجام نشد. لطفاً دوباره تلاش کنید.'});}
   }
   else if(action==='ACTIVITY_ENABLE'){
    try {db.exec('BEGIN IMMEDIATE');const row=db.prepare("SELECT status FROM activities WHERE id=?").get(id) as {status:string}|undefined;if(!row){db.exec('ROLLBACK');return send(res,404,{error:'فعالیت پیدا نشد.'});}if(row.status!=='DISABLED'){db.exec('ROLLBACK');return send(res,409,{error:'فقط فعالیت غیرفعال‌شده قابل فعال‌سازی است.'});}const changed=db.prepare("UPDATE activities SET status='ACTIVE' WHERE id=? AND status='DISABLED' AND julianday(expires_at)>julianday('now')").run(id);if(!changed.changes){db.prepare("UPDATE activities SET status='EXPIRED' WHERE id=? AND status='DISABLED'").run(id);db.exec('COMMIT');return send(res,409,{error:'زمان این فعالیت به پایان رسیده است.'});}logAdmin(a.id,'فعال‌کردن مجدد فعالیت','ACTIVITY',String(id),'DISABLED → ACTIVE');db.exec('COMMIT');}
    catch(error){try{db.exec('ROLLBACK')}catch{}console.error('Admin enable activity failed',a.id,id,error);return send(res,500,{error:'عملیات انجام نشد. لطفاً دوباره تلاش کنید.'});}
   }
   else if(action==='REPORT_STATUS'){db.prepare('UPDATE reports SET status=? WHERE id=?').run(String(b.value),id);logAdmin(a.id,'رسیدگی گزارش','REPORT',String(id),String(b.value));}
   else if(action==='TOGGLE_HALL'){db.prepare('UPDATE dining_halls SET is_active=? WHERE id=?').run(Number(b.value),id);logAdmin(a.id,'تغییر سالن','HALL',String(id));}
   else if(action==='TOGGLE_MEAL'){db.prepare('UPDATE meal_types SET is_active=? WHERE id=?').run(Number(b.value),id);logAdmin(a.id,'تغییر نوع غذا','MEAL_TYPE',String(id));}
   else if(action==='TOGGLE_ANNOUNCEMENT'){db.prepare('UPDATE announcements SET is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(Number(b.value),id);logAdmin(a.id,'تغییر وضعیت اطلاعیه','ANNOUNCEMENT',String(id),String(b.value));}
   else if(action==='DELETE_ANNOUNCEMENT'){const removed=db.prepare('DELETE FROM announcements WHERE id=?').run(id);if(!removed.changes)return send(res,404,{error:'اطلاعیه پیدا نشد.'});logAdmin(a.id,'حذف اطلاعیه','ANNOUNCEMENT',String(id));}
   else return send(res,400,{error:'عملیات ناشناخته است.'}); return send(res,200,{ok:true});}
  if(path==='/api/admin/temp-password'&&method==='POST'){const a=admin(req,res);if(!a)return;const b=await body(req),resetId=Number(b.resetId);const reset=db.prepare("SELECT * FROM password_reset_requests WHERE id=? AND status='NEW'").get(resetId) as any;if(!reset)return send(res,404,{error:'درخواست بازیابی پیدا نشد.'});const temp=crypto.randomBytes(6).toString('base64url')+'7a';db.prepare('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?').run(hashPassword(temp),reset.user_id);db.prepare("UPDATE password_reset_requests SET status='DONE',resolved_at=CURRENT_TIMESTAMP WHERE id=?").run(resetId);db.prepare('DELETE FROM sessions WHERE user_id=?').run(reset.user_id);logAdmin(a.id,'تولید رمز موقت','USER',String(reset.user_id));return send(res,200,{ok:true,tempPassword:temp});}
  if(path==='/api/admin/announcements'&&method==='POST'){const a=admin(req,res);if(!a)return;const b=await body(req),id=Number(b.id||0),title=String(b.title||'').trim(),text=String(b.body||'').trim(),level=String(b.level||'NORMAL');if(!title||!text||!['NORMAL','WARNING','IMPORTANT'].includes(level))return send(res,400,{error:'اطلاعیه کامل نیست.'});if(id){const updated=db.prepare('UPDATE announcements SET title=?,body=?,level=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title,text,level,id);if(!updated.changes)return send(res,404,{error:'اطلاعیه پیدا نشد.'});}else db.prepare('INSERT INTO announcements(title,body,level) VALUES(?,?,?)').run(title,text,level);logAdmin(a.id,id?'ویرایش اطلاعیه':'ایجاد اطلاعیه','ANNOUNCEMENT',String(id||'NEW'));return send(res,200,{ok:true});}
  if(path==='/api/admin/catalog'&&method==='POST'){const a=admin(req,res);if(!a)return;const b=await body(req),type=String(b.type),name=String(b.name||'').trim();if(!name)return send(res,400,{error:'نام لازم است.'});if(type==='HALL'){const gender=String(b.gender||'');if(!['MALE','FEMALE'].includes(gender))return send(res,400,{error:'نوع جنسیت سلف را انتخاب کنید.'});db.prepare('INSERT INTO dining_halls(campus,name,gender,sort_order) VALUES(?,?,?,?)').run(String(b.campus||'دانشگاه رازی'),name,gender,Number(b.sortOrder||99));logAdmin(a.id,'افزودن سالن','HALL');}else if(type==='MEAL'){db.prepare('INSERT INTO meal_types(name) VALUES(?)').run(name);logAdmin(a.id,'افزودن نوع غذا','MEAL_TYPE');}else return send(res,400,{error:'نوع نامعتبر است.'});return send(res,201,{ok:true});}
  if(path==='/api/admin/settings'&&method==='POST'){const a=admin(req,res);if(!a)return;const b=await body(req);db.prepare("UPDATE settings SET value=? WHERE key='maintenance'").run(b.maintenance?'1':'0');db.prepare("UPDATE settings SET value=? WHERE key='maintenance_message'").run(String(b.message||'سایت موقتاً در حال به‌روزرسانی است.'));logAdmin(a.id,'تغییر تنظیمات','SETTINGS');return send(res,200,{ok:true});}
  return send(res,404,{error:'مسیر پیدا نشد.'});
 } catch (error) { console.error('API error',req.method,req.url,error); return send(res,500,{error:'خطایی در پردازش درخواست رخ داد. دوباره تلاش کنید.'}); }
});
server.listen(Number(process.env.PORT||3001),()=>console.log('Backend ready'));
