require('dotenv').config();
const express = require('express');
const cors = require('cors');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const path = require('path');

// ── FIREBASE INIT ──────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── LINE CONFIG ────────────────────────────────────────
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// ── EXPRESS SETUP ──────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// LINE webhook — raw body, respond 200 immediately
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const signature = req.headers['x-line-signature'];
      if (!line.validateSignature(req.body, process.env.LINE_CHANNEL_SECRET, signature)) return;
      const body = JSON.parse(req.body.toString());
      for (const event of (body.events || [])) {
        try { await handleEvent(event); } catch (e) { console.error('Event error:', e); }
      }
    } catch (e) { console.error('Webhook error:', e); }
  });
});

app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const LIFF_ID = process.env.LIFF_ID;

// ── HELPERS ────────────────────────────────────────────
async function getAllStaff() {
  const snap = await db.collection('config').doc('staff').get();
  if (!snap.exists) return [];
  return JSON.parse(snap.data().data || '[]');
}
async function getStaffByLineId(lineUserId) {
  const all = await getAllStaff();
  return all.find(s => s.lineUserId === lineUserId) || null;
}
async function getLeaves() {
  const snap = await db.collection('config').doc('leaves').get();
  if (!snap.exists) return [];
  return JSON.parse(snap.data().data || '[]');
}
async function saveLeaves(leaves) {
  await db.collection('config').doc('leaves').set({ data: JSON.stringify(leaves), updatedAt: Date.now() });
}
async function getPayroll() {
  const snap = await db.collection('config').doc('payroll').get();
  if (!snap.exists) return {};
  return JSON.parse(snap.data().data || '{}');
}
function fmt(n) {
  const v = parseFloat(n) || 0;
  if (v === Math.round(v)) return Math.round(v).toLocaleString();
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function mkKey(m, y) { return `${y}_${m}`; }
const MTH = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ── HEALTH CHECK ───────────────────────────────────────
app.get('/', (req, res) => res.send('✅ RCG Payroll LINE Server is running!'));

// One-time admin setup — open in browser
app.get('/setup-admin/:lineUserId', async (req, res) => {
  try {
    const { lineUserId } = req.params;
    const snap = await db.collection('config').doc('adminLineIds').get();
    const existing = snap.exists ? (snap.data().ids || []) : [];
    if (!existing.includes(lineUserId)) existing.push(lineUserId);
    await db.collection('config').doc('adminLineIds').set({ ids: existing });
    res.send(`✅ Admin registered! LINE ID: ${lineUserId}<br>All admins: ${existing.join(', ')}`);
  } catch (e) { res.status(500).send('❌ Error: ' + e.message); }
});

// ── LINE BOT HANDLERS ──────────────────────────────────
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;
  const lineUserId = event.source.userId;
  const text = event.message.text.trim().toLowerCase();
  const replyToken = event.replyToken;
  const staff = await getStaffByLineId(lineUserId);
  if (text.startsWith('register ') || text.startsWith('ลงทะเบียน ')) {
    const staffId = text.split(' ')[1]?.trim().toUpperCase();
    await handleRegister(replyToken, lineUserId, staffId);
    return;
  }
  if (!staff) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `สวัสดีครับ/ค่ะ 👋\n\nกรุณาลงทะเบียนก่อนใช้งาน\nพิมพ์: register [รหัสพนักงาน]\n\nตัวอย่าง: register S1001\n\nติดต่อ HR เพื่อขอรหัสพนักงาน` }] });
    return;
  }
  await lineClient.replyMessage({ replyToken, messages: [{ type: 'flex', altText: 'RCG Staff Menu', contents: buildMainMenu(staff) }] });
}

async function handleRegister(replyToken, lineUserId, staffId) {
  if (!staffId) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: 'กรุณาระบุรหัสพนักงาน เช่น: register S1001' }] });
    return;
  }
  const allStaff = await getAllStaff();
  const staff = allStaff.find(s => s.id.toUpperCase() === staffId);
  if (!staff) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `❌ ไม่พบรหัสพนักงาน ${staffId}\nกรุณาติดต่อ HR` }] });
    return;
  }
  if (staff.lineUserId && staff.lineUserId !== lineUserId) {
    await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `❌ รหัสพนักงานนี้ถูกลงทะเบียนแล้ว\nติดต่อ HR หากต้องการเปลี่ยน` }] });
    return;
  }
  staff.lineUserId = lineUserId;
  await db.collection('config').doc('staff').set({ data: JSON.stringify(allStaff), updatedAt: Date.now() });
  await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: `✅ ลงทะเบียนสำเร็จ!\n\nสวัสดี ${staff.nn} ${staff.fn} 👋\nพิมพ์อะไรก็ได้เพื่อเปิดเมนู` }] });
}

function buildMainMenu(staff) {
  return {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#1e3a5f', paddingAll: '20px',
      contents: [
        { type: 'text', text: 'RCG Staff Portal', color: '#ffffff', size: 'sm', weight: 'bold' },
        { type: 'text', text: `สวัสดี ${staff.nn} 👋`, color: '#fde68a', size: 'xl', weight: 'bold' }
      ]
    },
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px',
      contents: [
        { type: 'button', style: 'primary', color: '#f59e0b', action: { type: 'uri', label: '🏖️ ขอลา / Leave Request', uri: `https://liff.line.me/${LIFF_ID}?page=leave&staffId=${staff.id}` } },
        { type: 'button', style: 'primary', color: '#1e3a5f', action: { type: 'uri', label: '💰 ตรวจสอบเงินเดือน / Salary', uri: `https://liff.line.me/${LIFF_ID}?page=salary&staffId=${staff.id}` } },
        { type: 'button', style: 'secondary', action: { type: 'uri', label: '📄 ขอเอกสาร / Documents', uri: `https://liff.line.me/${LIFF_ID}?page=document&staffId=${staff.id}` } }
      ]
    }
  };
}

// ── LIFF API ENDPOINTS ─────────────────────────────────
app.post('/api/verify', async (req, res) => {
  try {
    const { lineUserId, staffId } = req.body;
    const allStaff = await getAllStaff();
    const staff = lineUserId ? allStaff.find(s => s.lineUserId === lineUserId) : allStaff.find(s => s.id === staffId);
    if (!staff) return res.json({ ok: false, msg: 'Staff not found' });
    res.json({ ok: true, staff: { id: staff.id, fn: staff.fn, ln: staff.ln, nn: staff.nn, dept: staff.dept, pos: staff.pos, ct: staff.ct, emptype: staff.emptype, leaveAllowance: staff.leaveAllowance } });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

app.get('/api/leave-balance/:staffId/:year', async (req, res) => {
  try {
    const { staffId, year } = req.params;
    const leaves = await getLeaves();
    const balance = {};
    ['annual','sick','business'].forEach(type => {
      balance[type] = leaves.filter(r => r.staffId === staffId && r.status === 'approved' && r.year === parseInt(year) && r.type === type).reduce((s, r) => s + r.days, 0);
    });
    res.json({ ok: true, balance });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

app.post('/api/leave-request', async (req, res) => {
  try {
    const { staffId, lineUserId, type, customName, from, to, days, reason } = req.body;
    if (!staffId || !type || !from || !days) return res.json({ ok: false, msg: 'Missing required fields' });
    const allStaff = await getAllStaff();
    const staff = allStaff.find(s => s.id === staffId);
    if (!staff || staff.lineUserId !== lineUserId) return res.json({ ok: false, msg: 'Unauthorized' });
    const newLeave = { id: 'LV' + Date.now(), staffId, type, customName: customName || null, from, to: to || from, days: parseFloat(days), year: parseInt(from.split('-')[0]), reason: reason || '', status: 'pending', source: 'line', createdAt: new Date().toISOString() };
    const leaves = await getLeaves();
    leaves.push(newLeave);
    await saveLeaves(leaves);
    await notifyAdmin(staff, newLeave);
    res.json({ ok: true, leaveId: newLeave.id });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

app.get('/api/salary/:staffId/:year/:month', async (req, res) => {
  try {
    const { staffId, year, month } = req.params;
    const payroll = await getPayroll();
    const key = mkKey(month, year);
    const entry = payroll[key] && payroll[key][staffId];
    if (!entry || !entry.net) return res.json({ ok: false, msg: 'Salary not published yet for this period' });
    const allStaff = await getAllStaff();
    const staff = allStaff.find(s => s.id === staffId);
    res.json({ ok: true, period: `${MTH[parseInt(month)-1]} ${year}`, net: entry.net, staffName: staff ? `${staff.nn} ${staff.fn}` : staffId });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

app.post('/api/document-request', async (req, res) => {
  try {
    const { staffId, lineUserId, docType, note } = req.body;
    const allStaff = await getAllStaff();
    const staff = allStaff.find(s => s.id === staffId);
    if (!staff || staff.lineUserId !== lineUserId) return res.json({ ok: false, msg: 'Unauthorized' });
    const docReq = { id: 'DOC' + Date.now(), staffId, docType, note: note || '', status: 'pending', source: 'line', createdAt: new Date().toISOString() };
    const snap = await db.collection('config').doc('docRequests').get();
    const existing = snap.exists ? JSON.parse(snap.data().data || '[]') : [];
    existing.push(docReq);
    await db.collection('config').doc('docRequests').set({ data: JSON.stringify(existing), updatedAt: Date.now() });
    await notifyAdminDoc(staff, docReq);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

// ── ADMIN NOTIFICATIONS ────────────────────────────────
async function notifyAdmin(staff, leave) {
  try {
    const snap = await db.collection('config').doc('adminLineIds').get();
    if (!snap.exists) return;
    const adminIds = snap.data().ids || [];
    const typeLabel = { annual: 'Annual Leave', sick: 'Sick Leave', business: 'Business Leave', custom: leave.customName || 'Other' };
    const msg = { type: 'flex', altText: `Leave Request from ${staff.nn} ${staff.fn}`,
      contents: { type: 'bubble',
        header: { type: 'box', layout: 'vertical', backgroundColor: '#f59e0b', paddingAll: '15px', contents: [{ type: 'text', text: '🏖️ Leave Request', color: '#ffffff', weight: 'bold', size: 'lg' }] },
        body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '20px',
          contents: [
            { type: 'text', text: `👤 ${staff.nn} ${staff.fn}`, weight: 'bold', size: 'md' },
            { type: 'text', text: `📋 ${typeLabel[leave.type]}`, size: 'sm', color: '#6b7280' },
            { type: 'text', text: `📅 ${leave.from}${leave.to !== leave.from ? ' → ' + leave.to : ''} (${leave.days} day${leave.days > 1 ? 's' : ''})`, size: 'sm', color: '#6b7280' },
            ...(leave.reason ? [{ type: 'text', text: `💬 ${leave.reason}`, size: 'sm', color: '#6b7280', wrap: true }] : []),
            { type: 'separator', margin: 'md' },
            { type: 'text', text: 'กรุณาอนุมัติในระบบ RCG Payroll', size: 'xs', color: '#9ca3af', margin: 'md' }
          ]
        }
      }
    };
    for (const adminId of adminIds) await lineClient.pushMessage({ to: adminId, messages: [msg] });
  } catch (e) { console.error('notifyAdmin error:', e); }
}

async function notifyAdminDoc(staff, docReq) {
  try {
    const snap = await db.collection('config').doc('adminLineIds').get();
    if (!snap.exists) return;
    const adminIds = snap.data().ids || [];
    const docLabels = { payslip: 'Pay Slip', cert: 'Employment Certificate' };
    for (const adminId of adminIds) {
      await lineClient.pushMessage({ to: adminId, messages: [{ type: 'text', text: `📄 Document Request\n\n👤 ${staff.nn} ${staff.fn}\n📋 ${docLabels[docReq.docType] || docReq.docType}\n💬 ${docReq.note || '-'}\n\nกรุณาอนุมัติในระบบ RCG Payroll` }] });
    }
  } catch (e) { console.error('notifyAdminDoc error:', e); }
}

app.post('/api/notify-leave-result', async (req, res) => {
  try {
    const { staffId, status, reason } = req.body;
    const allStaff = await getAllStaff();
    const staff = allStaff.find(s => s.id === staffId);
    if (!staff || !staff.lineUserId) return res.json({ ok: false, msg: 'Staff has no LINE ID' });
    const emoji = status === 'approved' ? '✅' : '❌';
    const statusTh = status === 'approved' ? 'อนุมัติแล้ว' : 'ไม่อนุมัติ';
    await lineClient.pushMessage({ to: staff.lineUserId, messages: [{ type: 'text', text: `${emoji} ผลการขอลาของคุณ\n\nสถานะ: ${statusTh}${reason ? '\nเหตุผล: ' + reason : ''}\n\nติดต่อ HR หากมีข้อสงสัย` }] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

app.post('/api/set-admin-line-id', async (req, res) => {
  try {
    const { lineUserId } = req.body;
    const snap = await db.collection('config').doc('adminLineIds').get();
    const existing = snap.exists ? (snap.data().ids || []) : [];
    if (!existing.includes(lineUserId)) existing.push(lineUserId);
    await db.collection('config').doc('adminLineIds').set({ ids: existing });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

// ── START ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ RCG Payroll LINE Server running on port ${PORT}`);
  console.log(`📡 Webhook: ${BASE_URL}/webhook`);
  console.log(`🔗 LIFF: ${BASE_URL}`);
});
