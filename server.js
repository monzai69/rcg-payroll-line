require('dotenv').config();
const express = require('express');
const cors = require('cors');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const path = require('path');
const puppeteer = require('puppeteer');

// ── FIREBASE INIT ──────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'rcg-payroll.firebasestorage.app'
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

// ── LINE CONFIG ────────────────────────────────────────
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// ── EXPRESS SETUP ──────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.static(__dirname));

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
async function getBranches() {
  const snap = await db.collection('config').doc('branches').get();
  if (!snap.exists) return [];
  return JSON.parse(snap.data().data || '[]');
}
async function getCompany() {
  const snap = await db.collection('config').doc('company').get();
  if (!snap.exists) return {};
  return snap.data();
}
async function getLogos() {
  const snap = await db.collection('config').doc('logos').get();
  if (!snap.exists) return { rcg: null, clinic: null, mode: 'rcg' };
  return snap.data();
}
async function getSigStamp() {
  const snap = await db.collection('config').doc('sigstamp').get();
  if (!snap.exists) return { sig: null, stamp: null, showStamp: true };
  return snap.data();
}
async function getDocRequests() {
  const snap = await db.collection('config').doc('docRequests').get();
  if (!snap.exists) return [];
  return JSON.parse(snap.data().data || '[]');
}
async function saveDocRequests(docs) {
  await db.collection('config').doc('docRequests').set({ data: JSON.stringify(docs), updatedAt: Date.now() });
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
app.get('/liff', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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
  console.log('Event received:', JSON.stringify(event));
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
    if (!entry) return res.json({ ok: false, msg: 'Salary not published yet for this period' });
    const allStaff = await getAllStaff();
    const staff = allStaff.find(s => s.id === staffId);
    if (!staff) return res.json({ ok: false, msg: 'Staff not found' });

    // Build full breakdown from saved snapshot + entry
    const snap = entry.snap || {};
    const ct = snap.ct || staff.ct || 'permanent';
    const isPerm = ct === 'permanent';
    const emptype = snap.emptype || staff.emptype || 'fulltime';
    const items = snap.items || staff.items || [];
    const fptmethod = snap.fptmethod || staff.fptmethod || 'hourly';

    // Base
    let bG = 0, bLabel = 'Base Salary';
    if (emptype === 'fulltime') { bG = parseFloat(snap.base || staff.base) || 0; }
    else if (emptype === 'fullparttime') {
      if (fptmethod === 'daily') { const d = parseFloat(entry.days)||0, r = parseFloat(snap.fptdayrate||staff.fptdayrate)||0; bG=d*r; bLabel=`${d}d × ${fmt(r)}฿`; }
      else { const h = parseFloat(entry.hours)||0, r = parseFloat(snap.hrrate||staff.hrrate)||0; bG=h*r; bLabel=`${h}hrs × ${fmt(r)}฿`; }
    }

    // Leave deduction
    const dL = parseFloat(entry.dL) || 0;
    const leaveDays = parseFloat(entry.leaveDays) || 0;
    const leaveHrs = parseFloat(entry.leaveHrs) || 0;

    // Items
    const rev = parseFloat(entry.rev) || 0;
    const itemRows = [];
    (items).forEach(item => {
      if (!item || !item.name) return;
      // Simple: use saved net from items if available, otherwise skip
    });

    // Key figures from saved entry
    const gross = parseFloat(entry.gross) || (parseFloat(entry.net)||0);
    const net = parseFloat(entry.net) || 0;
    const sso = parseFloat(entry.sso) || 0;
    const mT = parseFloat(entry.mT) || 0;
    const whtD = parseFloat(entry.whtD) || 0;
    const adv = parseFloat(entry.adv) || 0;
    const dO = parseFloat(entry.dOth) || 0;
    const bon = parseFloat(entry.bonus) || 0;
    const otA = parseFloat(entry.otA) || (parseFloat(entry.otHrs)||0) * (parseFloat(snap.otrate||staff.otrate)||0);
    const otH = parseFloat(entry.otHrs) || 0;

    // Build rows for LIFF display
    const rows = [];
    rows.push({ label: bLabel, amt: bG, type: 'income' });
    if (dL > 0) rows.push({ label: `Leave (${leaveDays}d ${leaveHrs}hrs)`, amt: -dL, type: 'ded' });
    if (rev > 0 && items.some(i => ['comm_flat','comm_tiered','comm_tiered_fixed'].includes(i.type))) {
      rows.push({ label: `Revenue`, amt: rev, type: 'info' });
    }
    if (otA > 0) rows.push({ label: `OT (${otH}hrs)`, amt: otA, type: 'income' });
    if (bon > 0) rows.push({ label: 'Bonus', amt: bon, type: 'income' });
    rows.push({ label: 'Gross Income', amt: gross, type: 'sub' });
    if (isPerm) {
      if (sso > 0) rows.push({ label: 'SSO (5%)', amt: -sso, type: 'ded' });
      if (mT > 0) rows.push({ label: 'Income Tax ภงด.1', amt: -mT, type: 'ded' });
    } else {
      if (whtD > 0) rows.push({ label: 'WHT 3%', amt: -whtD, type: 'ded' });
    }
    if (adv > 0) rows.push({ label: 'Advance', amt: -adv, type: 'ded' });
    if (dO > 0) rows.push({ label: 'Other Deductions', amt: -dO, type: 'ded' });

    res.json({
      ok: true,
      period: `${MTH[parseInt(month)-1]} ${year}`,
      staffName: `${staff.nn} ${staff.fn}`,
      pos: staff.pos || '',
      net, rows
    });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

// Get unregistered active non-parttime staff with phone
app.get('/api/unregistered-staff', async (req, res) => {
  try {
    const allStaff = await getAllStaff();
    const unregistered = allStaff.filter(s =>
      s.st === 'Active' &&
      s.emptype !== 'parttime' &&
      !s.lineUserId &&
      s.phone && s.phone.length >= 4
    ).map(s => ({ id: s.id, fn: s.fn, nn: s.nn, dept: s.dept, pos: s.pos }));
    res.json({ ok: true, staff: unregistered });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

// Register by phone last 4 digits
app.post('/api/register-by-phone', async (req, res) => {
  try {
    const { staffId, last4, lineUserId } = req.body;
    if (!staffId || !last4 || !lineUserId) return res.json({ ok: false, msg: 'Missing fields' });
    const allStaff = await getAllStaff();
    const staff = allStaff.find(s => s.id === staffId);
    if (!staff) return res.json({ ok: false, msg: 'ไม่พบรหัสพนักงาน' });
    if (!staff.phone) return res.json({ ok: false, msg: 'ไม่มีเบอร์โทรในระบบ กรุณาติดต่อ HR' });
    // Check last 4 digits
    const phoneLast4 = staff.phone.replace(/\D/g, '').slice(-4);
    if (phoneLast4 !== last4) return res.json({ ok: false, msg: 'เบอร์โทรไม่ตรงกัน กรุณาลองใหม่' });
    // Check not already registered by someone else
    const alreadyLinked = allStaff.find(s => s.lineUserId === lineUserId && s.id !== staffId);
    if (alreadyLinked) return res.json({ ok: false, msg: 'LINE นี้ลงทะเบียนกับพนักงานคนอื่นแล้ว' });
    // Link LINE ID
    staff.lineUserId = lineUserId;
    await db.collection('config').doc('staff').set({ data: JSON.stringify(allStaff), updatedAt: Date.now() });
    res.json({ ok: true, staff: { id: staff.id, fn: staff.fn, ln: staff.ln, nn: staff.nn, dept: staff.dept, pos: staff.pos } });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});
app.get('/api/branches', async (req, res) => {
  try {
    const branches = await getBranches();
    res.json({ ok: true, branches: branches.map(b => ({ id: b.id, name: b.name })) });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

app.post('/api/document-request', async (req, res) => {
  try {
    const { staffId, lineUserId, docType, branchId, showSalary, month, year, note, lang, showReason } = req.body;
    const allStaff = await getAllStaff();
    const staff = allStaff.find(s => s.id === staffId);
    if (!staff || staff.lineUserId !== lineUserId) return res.json({ ok: false, msg: 'Unauthorized' });
    const docReq = {
      id: 'DOC' + Date.now(),
      staffId,
      docType,
      branchId: branchId || null,
      showSalary: showSalary !== false,
      lang: lang || 'th',
      month: month || null,
      year: year || null,
      note: note || '',
      showReason: showReason !== false,
      status: 'pending',
      source: 'line',
      createdAt: new Date().toISOString()
    };
    const existing = await getDocRequests();
    existing.push(docReq);
    await saveDocRequests(existing);
    await notifyAdminDoc(staff, docReq);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

// Approve document — generate PDF and send to staff
app.post('/api/approve-document', async (req, res) => {
  try {
    const { docId } = req.body;
    const docs = await getDocRequests();
    const doc = docs.find(d => d.id === docId);
    if (!doc) return res.json({ ok: false, msg: 'Request not found' });
    if (doc.status !== 'pending') return res.json({ ok: false, msg: 'Already processed' });

    const allStaff = await getAllStaff();
    const staff = allStaff.find(s => s.id === doc.staffId);
    if (!staff) return res.json({ ok: false, msg: 'Staff not found' });
    if (!staff.lineUserId) return res.json({ ok: false, msg: 'Staff has no LINE ID' });

    const company = await getCompany();
    const branches = await getBranches();
    const branch = branches.find(b => b.id === doc.branchId) || {};
    const logos = await getLogos();
    const sigstamp = await getSigStamp();

    // Build HTML for PDF
    let html = '';
    if (doc.docType === 'payslip') {
      const payroll = await getPayroll();
      const key = `${doc.year}_${doc.month}`;
      const entry = payroll[key] && payroll[key][doc.staffId] || {};
      html = buildPaySlipHTML(staff, entry, doc.month, doc.year, company, logos, sigstamp, doc.lang||'th');
    } else {
      const isEn = (doc.lang||'th')==='en';
      const dateStr = isEn
        ? new Date().toLocaleDateString('en-GB',{year:'numeric',month:'long',day:'numeric'})
        : new Date().toLocaleDateString('th-TH',{year:'numeric',month:'long',day:'numeric'});
html = buildCertHTML(staff, branch, company, doc.showSalary, dateStr, logos, sigstamp, doc.lang||'th', doc.note||'', doc.showReason!==false);    }

    // Generate PDF with puppeteer
    const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' } });
    await browser.close();

    // Upload to Firebase Storage
    const fileName = `documents/${doc.id}_${doc.docType}.pdf`;
    const file = bucket.file(fileName);
    await file.save(pdfBuffer, { metadata: { contentType: 'application/pdf' } });
    // Make public and get URL
    await file.makePublic();
    const downloadUrl = `https://storage.googleapis.com/rcg-payroll.firebasestorage.app/${fileName}`;

    // Update doc status
    const idx = docs.findIndex(d => d.id === docId);
    docs[idx].status = 'approved';
    docs[idx].downloadUrl = downloadUrl;
    docs[idx].approvedAt = new Date().toISOString();
    await saveDocRequests(docs);

    // Send LINE message to staff
    const docLabel = doc.docType === 'payslip' ? 'สลิปเงินเดือน' : 'หนังสือรับรองการทำงาน';
    await lineClient.pushMessage({
      to: staff.lineUserId,
      messages: [{
        type: 'flex',
        altText: `📄 ${docLabel} พร้อมแล้ว!`,
        contents: {
          type: 'bubble',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#1e3a5f', paddingAll: '16px',
            contents: [{ type: 'text', text: `📄 ${docLabel}`, color: '#fde68a', weight: 'bold', size: 'lg' }]
          },
          body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '18px',
            contents: [
              { type: 'text', text: `สวัสดี ${staff.nn} 👋`, weight: 'bold' },
              { type: 'text', text: `${docLabel}ของคุณพร้อมให้ดาวน์โหลดแล้ว`, size: 'sm', color: '#6b7280', wrap: true, margin: 'sm' },
              { type: 'text', text: '⚠️ ลิงก์ใช้ได้ 7 วัน', size: 'xs', color: '#f59e0b', margin: 'sm' }
            ]
          },
          footer: { type: 'box', layout: 'vertical', paddingAll: '12px',
            contents: [{
              type: 'button', style: 'primary', color: '#1e3a5f',
              action: { type: 'uri', label: '📥 ดาวน์โหลดเอกสาร', uri: downloadUrl }
            }]
          }
        }
      }]
    });

    res.json({ ok: true, downloadUrl });
  } catch (e) {
    console.error('approve-document error:', e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// Reject document request
app.post('/api/reject-document', async (req, res) => {
  try {
    const { docId } = req.body;
    const docs = await getDocRequests();
    const idx = docs.findIndex(d => d.id === docId);
    if (idx < 0) return res.json({ ok: false, msg: 'Not found' });
    const staff = (await getAllStaff()).find(s => s.id === docs[idx].staffId);
    docs[idx].status = 'rejected';
    await saveDocRequests(docs);
    if (staff && staff.lineUserId) {
      await lineClient.pushMessage({ to: staff.lineUserId, messages: [{ type: 'text', text: `❌ คำขอเอกสารของคุณไม่ได้รับการอนุมัติ\nกรุณาติดต่อ HR หากมีข้อสงสัย` }] });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

// Get pending doc requests (for web app)
app.get('/api/doc-requests', async (req, res) => {
  try {
    const docs = await getDocRequests();
    res.json({ ok: true, docs });
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

// Publish salary — notify all staff with LINE ID
app.post('/api/publish-salary', async (req, res) => {
  try {
    const { month, year } = req.body;
    const allStaff = await getAllStaff();
    const staffWithLine = allStaff.filter(s => s.lineUserId && s.st === 'Active');
    const period = `${MTH[parseInt(month)-1]} ${year}`;
    let sent = 0;
    for (const s of staffWithLine) {
      try {
        await lineClient.pushMessage({
          to: s.lineUserId,
          messages: [{
            type: 'flex',
            altText: `💰 เงินเดือน ${period} พร้อมแล้ว!`,
            contents: {
              type: 'bubble',
              header: {
                type: 'box', layout: 'vertical',
                backgroundColor: '#1e3a5f', paddingAll: '18px',
                contents: [
                  { type: 'text', text: '💰 เงินเดือนพร้อมแล้ว', color: '#fde68a', weight: 'bold', size: 'lg' },
                  { type: 'text', text: period, color: '#93c5fd', size: 'sm', margin: 'sm' }
                ]
              },
              body: {
                type: 'box', layout: 'vertical', paddingAll: '18px',
                contents: [
                  { type: 'text', text: `สวัสดี ${s.nn} 👋`, weight: 'bold', size: 'md' },
                  { type: 'text', text: 'เงินเดือนของคุณสำหรับเดือน '+period+' พร้อมให้ตรวจสอบแล้ว', size: 'sm', color: '#6b7280', wrap: true, margin: 'sm' }
                ]
              },
              footer: {
                type: 'box', layout: 'vertical', paddingAll: '12px',
                contents: [{
                  type: 'button', style: 'primary', color: '#f59e0b',
                  action: {
                    type: 'uri',
                    label: '💰 ดูเงินเดือนของฉัน',
                    uri: `https://liff.line.me/${LIFF_ID}?page=salary&staffId=${s.id}&month=${month}&year=${year}`
                  }
                }]
              }
            }
          }]
        });
        sent++;
      } catch (e) { console.error('Failed to notify', s.id, e.message); }
    }
    res.json({ ok: true, sent, total: staffWithLine.length });
  } catch (e) { res.status(500).json({ ok: false, msg: e.message }); }
});

app.get('/debug/payroll', async (req, res) => {
  try {
    const payroll = await getPayroll();
    const keys = Object.keys(payroll);
    const sample = keys[0] ? Object.keys(payroll[keys[0]]).slice(0,3) : [];
    res.json({ keys, sample });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PDF HTML BUILDERS ─────────────────────────────────
function fmtN(n) { const v = parseFloat(n)||0; if(v===Math.round(v))return Math.round(v).toLocaleString(); return v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }

function buildLogoHeaderHTML(logos) {
  if (!logos) return '';
  const mode = logos.mode || 'rcg';
  const left = logos.rcg, right = logos.clinic;
  if (mode === 'none') return '';
  if (mode === 'rcg') {
    if (!right) return '';
    return `<div style="display:flex;justify-content:flex-end;align-items:center;margin-bottom:10px"><img src="${right}" style="max-height:52px;max-width:160px;object-fit:contain"></div>`;
  }
  if (mode === 'both') {
    if (!left && !right) return '';
    if (!left) return `<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><img src="${right}" style="max-height:52px;max-width:160px;object-fit:contain"></div>`;
    if (!right) return `<div style="display:flex;justify-content:flex-start;margin-bottom:10px"><img src="${left}" style="max-height:52px;max-width:160px;object-fit:contain"></div>`;
    return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><img src="${left}" style="max-height:52px;max-width:140px;object-fit:contain"><img src="${right}" style="max-height:52px;max-width:140px;object-fit:contain"></div>`;
  }
  return '';
}

function buildSigBlockHTML(sigstamp, sgn, dateStr) {
  if (!sigstamp) return `<div style="text-align:right;margin-top:32px"><div style="border-bottom:1.5px solid #9ca3af;width:180px;margin-left:auto;margin-bottom:6px"></div><div style="font-weight:600">${sgn}</div><div style="font-size:11px;color:#6b7280">${dateStr}</div></div>`;
  const showStamp = sigstamp.showStamp !== false;
  const sigImg = sigstamp.sig ? `<img src="${sigstamp.sig}" style="max-height:52px;max-width:150px;object-fit:contain;display:block;margin:0 auto 2px">` : `<div style="border-bottom:1.5px solid #9ca3af;width:180px;margin-left:auto;margin-bottom:6px"></div>`;
  const sigBlock = `<div style="text-align:center"><div style="display:inline-block;text-align:center">${sigImg}<div style="font-weight:600">${sgn}</div><div style="font-size:11px;color:#6b7280">${dateStr}</div></div></div>`;
  if (showStamp && sigstamp.stamp) {
    return `<div style="display:flex;align-items:flex-end;justify-content:flex-end;gap:20px;margin-top:32px">${sigBlock}<img src="${sigstamp.stamp}" style="max-height:80px;max-width:80px;object-fit:contain;opacity:.9"></div>`;
  }
  return `<div style="display:flex;justify-content:flex-end;margin-top:32px">${sigBlock}</div>`;
}

function buildPaySlipHTML(staff, entry, month, year, company, logos, sigstamp, lang='th') {
  const isEn = lang === 'en';
  const MTH2 = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MTH2TH = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const period = isEn
    ? `${MTH2[parseInt(month)-1]} ${year}`
    : `${MTH2TH[parseInt(month)-1]} ${year}`;
  const net = parseFloat(entry.net)||0;
  const bG = parseFloat(entry.bG)||(parseFloat(entry.snap&&entry.snap.base)||0);
  const gross = parseFloat(entry.gross)||0;
  const sso = parseFloat(entry.sso)||0;
  const mT = parseFloat(entry.mT)||0;
  const whtD = parseFloat(entry.whtD)||0;
  const adv = parseFloat(entry.adv)||0;
  const dO = parseFloat(entry.dOth)||0;
  const bon = parseFloat(entry.bonus)||0;
  const otA = parseFloat(entry.otA)||0;
  const otH = parseFloat(entry.otHrs)||0;
  const dL = parseFloat(entry.dL)||0;
  const isPerm = (entry.snap&&entry.snap.ct||staff.ct) === 'permanent';
  const cth = isEn ? (company&&company.cthen)||'Ready Check Go Group Co., Ltd.' : (company&&company.cth)||'ReadyCheckGo';
  const sgn = isEn ? (company&&company.sgnen)||company.sgn||'' : (company&&company.sgn)||'';
  const today = isEn
    ? new Date().toLocaleDateString('en-GB',{year:'numeric',month:'long',day:'numeric'})
    : new Date().toLocaleDateString('th-TH',{year:'numeric',month:'long',day:'numeric'});
  const logoHtml = buildLogoHeaderHTML(logos);
  const sigHtml = buildSigBlockHTML(sigstamp, sgn, today);
  const L = isEn ? {
    base:'Base Salary', ot:`OT (${otH} hrs)`, bonus:'Bonus', gross:'Total Income',
    sso:'Social Security (5%)', tax:'Income Tax', wht:'Withholding Tax 3%',
    leave:'Leave Deduction', adv:'Advance', other:'Other Deductions', net:'NET PAY',
    payslip:'PAY SLIP', id:'ID', name:'Name', pos:'Position', contract:'Contract'
  } : {
    base:'เงินเดือน', ot:`OT (${otH} hrs)`, bonus:'Bonus', gross:'รายได้รวม',
    sso:'ประกันสังคม (5%)', tax:'ภาษีเงินได้ ภงด.1', wht:'หัก ณ ที่จ่าย 3%',
    leave:'หักลา', adv:'หักเงินยืม', other:'หักอื่นๆ', net:'เงินสุทธิ',
    payslip:'สลิปเงินเดือน', id:'รหัส', name:'ชื่อ', pos:'ตำแหน่ง', contract:'ประเภท'
  };
  let rows = '';
  rows += `<tr><td>${L.base}</td><td style="text-align:right">${fmtN(bG)} ฿</td></tr>`;
  if(otA>0) rows += `<tr><td>${L.ot}</td><td style="text-align:right">${fmtN(otA)} ฿</td></tr>`;
  if(bon>0) rows += `<tr><td>${L.bonus}</td><td style="text-align:right">${fmtN(bon)} ฿</td></tr>`;
  rows += `<tr style="font-weight:700;border-top:1.5px solid #374151"><td>${L.gross}</td><td style="text-align:right">${fmtN(gross)} ฿</td></tr>`;
  if(isPerm) {
    if(sso>0) rows += `<tr style="color:#6b7280"><td>${L.sso}</td><td style="text-align:right">−${fmtN(sso)} ฿</td></tr>`;
    if(mT>0) rows += `<tr style="color:#6b7280"><td>${L.tax}</td><td style="text-align:right">−${fmtN(mT)} ฿</td></tr>`;
  } else {
    if(whtD>0) rows += `<tr style="color:#6b7280"><td>${L.wht}</td><td style="text-align:right">−${fmtN(whtD)} ฿</td></tr>`;
  }
  if(dL>0) rows += `<tr style="color:#6b7280"><td>${L.leave}</td><td style="text-align:right">−${fmtN(dL)} ฿</td></tr>`;
  if(adv>0) rows += `<tr style="color:#6b7280"><td>${L.adv}</td><td style="text-align:right">−${fmtN(adv)} ฿</td></tr>`;
  if(dO>0) rows += `<tr style="color:#6b7280"><td>${L.other}</td><td style="text-align:right">−${fmtN(dO)} ฿</td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
    <style>body{font-family:'Sarabun',sans-serif;font-size:13px;color:#1a1a2e;padding:0;margin:0}
    .wrap{max-width:540px;margin:auto;padding:28px}
    table{width:100%;border-collapse:collapse;font-size:13px}td{padding:5px 0}
    .hdr{border-bottom:2px solid #1e3a5f;padding-bottom:10px;margin-bottom:14px}
    .net{background:#1e3a5f;color:#fff;border-radius:8px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;margin-top:12px}
    </style></head><body><div class="wrap">
    ${logoHtml}
    <div class="hdr"><div style="font-size:14px;font-weight:700;color:#1e3a5f">${cth}</div>
    <div style="font-size:12px;color:#6b7280">${L.payslip} — ${period}</div></div>
    <table style="margin-bottom:12px;font-size:12px">
      <tr><td><b>${L.id}:</b> ${staff.id}</td><td><b>${L.name}:</b> ${staff.fn} ${staff.ln}</td></tr>
      <tr><td><b>${L.pos}:</b> ${staff.pos}</td><td><b>${L.contract}:</b> ${isPerm?'Permanent':staff.ct}</td></tr>
    </table>
    <table>${rows}</table>
    <div class="net"><b style="font-size:14px">${L.net}</b><b style="font-size:22px;color:#fde68a">${fmtN(net)} ฿</b></div>
    ${sigHtml}
    </div></body></html>`;
}

function buildCertHTML(staff, branch, company, showSalary, dateStr, logos, sigstamp, lang='th', purpose='', showReason=true) {  const isEn = lang === 'en';
  const cth = isEn ? (company&&company.cthen)||'Ready Check Go Group Co., Ltd.' : (company&&company.cth)||'ReadyCheckGo';
  const addr = isEn ? (company&&company.addren)||company.addr||'' : (company&&company.addr)||'';  
  const sgn = isEn ? (company&&company.sgnen)||company.sgn||'' : (company&&company.sgn)||'';
  const cn = isEn ? (branch.nameEn||branch.certname||branch.name||'') : (branch.certname||branch.name||'');
  const sd = staff.sd ? new Date(staff.sd).toLocaleDateString(isEn?'en-GB':'th-TH',{year:'numeric',month:'long',day:'numeric'}) : '';
  const yrs = staff.sd ? Math.floor((Date.now()-new Date(staff.sd))/(365.25*24*60*60*1000)) : 0;
  const mos = staff.sd ? Math.floor(((Date.now()-new Date(staff.sd))%(365.25*24*60*60*1000))/(30.44*24*60*60*1000)) : 0;
  const logoHtml = buildLogoHeaderHTML(logos);
  const sigHtml = buildSigBlockHTML(sigstamp, sgn, dateStr);

  const content = isEn ? `
  <p>This is to certify that <b>${staff.fn} ${staff.ln}</b> is an employee of ${cth}</p>
  <p>Position: <b>${staff.pos} · ${staff.dept}</b></p>
    ${cn?`<p>At ${cn}</p>`:''}
    ${showSalary&&staff.base?`<p>Monthly Salary: <b>${fmtN(staff.base)} THB</b></p>`:''}
    <p>Start Date: ${sd}</p>
    <p>Length of Service: ${yrs} year${yrs!==1?'s':''} ${mos} month${mos!==1?'s':''}</p>
    ${showReason && purpose ? `<p>This certificate is issued for the purpose of <b>${purpose}</b>.</p>` : '<p>This certificate is issued for the purpose requested by the employee.</p>'}
  ` : `
    <p>หนังสือฉบับนี้ออกให้เพื่อรับรองว่า <b>${staff.fn} ${staff.ln}</b> เป็นพนักงานของ${cth}</p>
    <p>ตำแหน่ง <b>${staff.pos} · ${staff.dept}</b></p>
    ${cn?`<p>ที่${cn}</p>`:''}
    ${showSalary&&staff.base?`<p>มีอัตราเงินเดือนล่าสุด <b>${fmtN(staff.base)} บาทต่อเดือน</b></p>`:''}
    <p>เริ่มงาน ${sd} จนถึงปัจจุบัน</p>
    <p>อายุงาน: ${yrs} ปี ${mos} เดือน</p>
   ${showReason && purpose ? `<p>จึงออกหนังสือรับรองฉบับนี้เพื่อ <b>${purpose}</b></p>` : '<p>จึงเรียนมาเพื่อทราบ</p>'}
  `;

  const title = isEn ? 'EMPLOYEE CERTIFICATE' : 'หนังสือรับรองพนักงาน';
  const issuedLabel = isEn ? `Issued on ${dateStr}` : `ออกให้ ณ วันที่ ${dateStr}`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">
    <style>body{font-family:'Sarabun',sans-serif;font-size:14px;color:#1a1a2e;line-height:2}
    .wrap{max-width:540px;margin:auto;padding:28px}
    </style></head><body><div class="wrap">
    ${logoHtml}
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:16px;border-bottom:2px solid #1e3a5f;padding-bottom:10px">
      <div><div style="font-weight:700">${cn}</div>${branch.lic?`<div>${isEn?'License No.':'เลขที่ใบอนุญาต'} ${branch.lic}</div>`:''}</div>
      <div style="text-align:right"><div style="font-weight:700">${cth}</div><div style="color:#6b7280;white-space:pre-line;font-size:11px">${addr}</div></div>
    </div>
    <div style="text-align:center;margin-bottom:16px"><div style="font-size:16px;font-weight:700;text-decoration:underline;color:#1e3a5f">${title}</div></div>
    <div style="text-align:right;font-size:12px;color:#6b7280;margin-bottom:16px">${issuedLabel}</div>
    ${content}
    ${sigHtml}
    </div></body></html>`;
}

// ── START ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ RCG Payroll LINE Server running on port ${PORT}`);
  console.log(`📡 Webhook: ${BASE_URL}/webhook`);
  console.log(`🔗 LIFF: ${BASE_URL}`);
});
