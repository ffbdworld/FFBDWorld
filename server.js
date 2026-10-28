require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 10000);
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'bondhubd-e6fb4';
const ADMINS = new Set([
  'VkSWgPu8UdPwYTV3yv0le772SDC2',
  'x3iGIrvOEib9g0TMoEGoXb85H8O2'
]);
const ADMIN_EMAILS = new Set(['mdrifonahmed3@gmail.com','mdrifonahmed661@gmail.com']);

function initFirebase() {
  if (admin.apps.length) return admin.app();
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    credential = admin.credential.cert(JSON.parse(raw));
  } else {
    credential = admin.credential.applicationDefault();
  }
  return admin.initializeApp({ credential, projectId: PROJECT_ID });
}

initFirebase();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;
const BUSINESS_DEFAULTS = Object.freeze({
  starRateStars:100, starRateTaka:80, starWithdrawMinStars:500, starWithdrawFeePct:10,
  marketplaceFreePosts:10, marketplacePostStars:10, jobFreePosts:5, jobPostStars:20,
  tuitionFreePosts:5, tuitionPostStars:20, groupCreateStars:20,
  verificationStars:100, verificationRejectRefundStars:80, referralRewardStars:20,
  pkEntryStars:5, pkVoteStars:2, pkWinnerGiftPct:80,
  marketBoost24h:15, marketBoost72h:30, marketBoost7d:60, marketBoost15d:110, marketBoost30d:200,
  profileBoost24h:25, profileBoost72h:50, profileBoost7d:100, profileBoost15d:180, profileBoost30d:350,
  shortPayoutPer1000:8, longPayoutPer1000:16, photoPayoutPer1000Likes:4,
  monetizationMinPayoutTaka:500, manualPaymentsEnabled:true, automaticPaymentApiEnabled:false
});
async function getBusinessSettings(){
  const snap=await db.doc('businessSettings/general').get();
  return {...BUSINESS_DEFAULTS,...(snap.exists?snap.data():{})};
}
function starToTaka(stars, settings){
  const baseStars=Number(settings.starRateStars), baseTaka=Number(settings.starRateTaka);
  if(!Number.isFinite(baseStars)||baseStars<=0||!Number.isFinite(baseTaka)||baseTaka<=0) throw new Error('Invalid business Stars rate settings.');
  return Math.round((Number(stars)*baseTaka/baseStars)*100)/100;
}
function starsLedger(uid, type, stars, extra={}){
  return db.collection('starLedger').doc();
}


const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));

const origins = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || origins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin not allowed'));
  },
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }));

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 5000) => String(v ?? '').slice(0, max);
const now = () => FieldValue.serverTimestamp();
const bad = (res, code, message) => res.status(code).json({ ok: false, error: message });
const ok = (res, data = {}) => res.json({ ok: true, ...data });
const isAdminUid = uid => ADMINS.has(uid);
const isAdminUser = user => !!user && (ADMINS.has(user.uid) || ADMIN_EMAILS.has(String(user.email || '').toLowerCase()));

async function getBlockRecord(uid) {
  const [blockSnap, profileSnap] = await Promise.all([
    db.doc(`blockedUsers/${uid}`).get(),
    db.doc(`userProfiles/${uid}`).get()
  ]);
  const b = blockSnap.exists ? blockSnap.data() : {};
  const p = profileSnap.exists ? profileSnap.data() : {};
  return {
    blocked: b.blocked === true || p.blocked === true || p.active === false || p.status === 'blocked' || p.status === 'suspended',
    reason: b.reason || p.blockReason || p.suspensionReason || ''
  };
}

async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return bad(res, 401, 'Missing Firebase ID token');
    const token = h.slice(7).trim();
    const decoded = await admin.auth().verifyIdToken(token, true);
    req.user = decoded;
    if (!isAdminUser(decoded)) {
      const state = await getBlockRecord(decoded.uid);
      if (state.blocked) return bad(res, 403, 'Account is blocked or suspended');
    }
    next();
  } catch (e) {
    return bad(res, 401, 'Invalid or expired authentication token');
  }
}

function requireAdmin(req, res, next) {
  if (!isAdminUser(req.user)) return bad(res, 403, 'Admin access required');
  next();
}

async function loadUser(uid) {
  const s = await db.doc(`userProfiles/${uid}`).get();
  return s.exists ? { uid, ...s.data() } : { uid };
}

app.get('/health', (req, res) => ok(res, { service: 'FFBDWorld API', version: '1.0.0', firebaseProject: PROJECT_ID, time: new Date().toISOString() }));
app.get('/v1', (req, res) => ok(res, { service: 'FFBDWorld API', version: '1.0.0' }));

// One trusted source for all business rates. Clients may read public rate fields;
// only verified admins may write settings through this API.
const BUSINESS_NUMERIC_KEYS = new Set(Object.keys(BUSINESS_DEFAULTS).filter(k => typeof BUSINESS_DEFAULTS[k] === 'number'));
const BUSINESS_BOOLEAN_KEYS = new Set(['manualPaymentsEnabled','automaticPaymentApiEnabled']);
const BUSINESS_STRING_KEYS = new Set(['bkashPaymentNumber','nagadPaymentNumber','rocketPaymentNumber']);
const BUSINESS_WRITABLE_KEYS = new Set([...BUSINESS_NUMERIC_KEYS,...BUSINESS_BOOLEAN_KEYS,...BUSINESS_STRING_KEYS]);
function validateBusinessSettings(input) {
  const out = {};
  for (const key of BUSINESS_WRITABLE_KEYS) {
    if (!(key in input)) continue;
    const value = input[key];
    if (BUSINESS_NUMERIC_KEYS.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid non-negative number: ${key}`);
      out[key] = value;
    } else if (BUSINESS_BOOLEAN_KEYS.has(key)) {
      if (typeof value !== 'boolean') throw new Error(`Invalid boolean: ${key}`);
      out[key] = value;
    } else {
      if (typeof value !== 'string' || value.length > 80) throw new Error(`Invalid payment number: ${key}`);
      out[key] = value.trim();
    }
  }
  const merged = {...BUSINESS_DEFAULTS,...out};
  for (const key of ['starRateStars','starWithdrawMinStars','marketplaceFreePosts','jobFreePosts','tuitionFreePosts']) {
    if (!Number.isInteger(Number(merged[key]))) throw new Error(`${key} must be a whole number`);
  }
  if (merged.starRateStars < 1 || merged.starRateTaka <= 0) throw new Error('Stars rate must be greater than zero.');
  if (merged.starWithdrawMinStars < 1 || merged.starWithdrawFeePct > 100) throw new Error('Invalid withdrawal settings.');
  if (merged.pkWinnerGiftPct > 100) throw new Error('PK winner share cannot exceed 100%.');
  if (merged.verificationRejectRefundStars > merged.verificationStars) throw new Error('Verification refund cannot exceed fee.');
  if (merged.automaticPaymentApiEnabled === true) throw new Error('Automatic payment API is not enabled until merchant webhook verification is completed.');
  return out;
}
async function getPaymentInfo(){
  const snap=await db.doc('settings/paymentInfo').get();
  const d=snap.exists?snap.data()||{}:{};
  return {bkashNumber:String(d.bkashNumber||''),nagadNumber:String(d.nagadNumber||'')};
}
function withPaymentInfo(settings,paymentInfo){
  return {...settings,bkashPaymentNumber:paymentInfo.bkashNumber,nagadPaymentNumber:paymentInfo.nagadNumber};
}
function publicBusinessSettings(settings) {
  const out = {};
  for (const key of [...BUSINESS_NUMERIC_KEYS,...BUSINESS_BOOLEAN_KEYS]) if (key in settings) out[key] = settings[key];
  return out;
}
app.get('/v1/business-settings', requireAuth, asyncRoute(async (req,res) => {
  const [settings,paymentInfo] = await Promise.all([getBusinessSettings(),getPaymentInfo()]);
  ok(res,{settings:withPaymentInfo(publicBusinessSettings(settings),paymentInfo),paymentInfo});
}));
app.get('/v1/admin/business-settings', requireAuth, requireAdmin, asyncRoute(async (req,res) => {
  const [settings,paymentInfo] = await Promise.all([getBusinessSettings(),getPaymentInfo()]);
  ok(res,{settings:withPaymentInfo(settings,paymentInfo),paymentInfo});
}));
app.put('/v1/admin/business-settings', requireAuth, requireAdmin, asyncRoute(async (req,res) => {
  const input = req.body && typeof req.body === 'object' ? {...req.body} : {};
  const paymentInfo = {};
  if ('bkashPaymentNumber' in input) paymentInfo.bkashNumber=String(input.bkashPaymentNumber||'').trim();
  if ('nagadPaymentNumber' in input) paymentInfo.nagadNumber=String(input.nagadPaymentNumber||'').trim();
  delete input.bkashPaymentNumber; delete input.nagadPaymentNumber; delete input.rocketPaymentNumber;
  let next;
  try { next = validateBusinessSettings(input); } catch (e) { return bad(res,400,e.message); }
  if (Object.values(paymentInfo).some(v=>v.length>80)) return bad(res,400,'Payment receiver number is too long.');
  const ref = db.doc('businessSettings/general'), payRef=db.doc('settings/paymentInfo'), audit = db.collection('auditLogs').doc();
  await db.runTransaction(async tx => {
    const [snap,paySnap] = await Promise.all([tx.get(ref),tx.get(payRef)]);
    const old = snap.exists ? snap.data() || {} : {};
    const oldPayment = paySnap.exists ? paySnap.data() || {} : {};
    const merged = {...BUSINESS_DEFAULTS,...old,...next,automaticPaymentApiEnabled:false,updatedAt:now(),updatedBy:req.user.uid};
    tx.set(ref,merged,{merge:true});
    tx.set(payRef,{...oldPayment,...paymentInfo,updatedAt:now(),updatedBy:req.user.uid},{merge:true});
    tx.create(audit,{action:'shared_business_settings_update',actorUid:req.user.uid,actorEmail:req.user.email||'',documentId:'general',oldValue:old,newValue:next,paymentInfoChanged:Object.keys(paymentInfo).length>0,createdAt:now()});
  });
  const [settingsSaved,paymentSaved]=await Promise.all([getBusinessSettings(),getPaymentInfo()]);
  ok(res,{updated:true,settings:withPaymentInfo(settingsSaved,paymentSaved),paymentInfo:paymentSaved});
}));

// Firebase Auth remains the identity provider. This endpoint is called immediately after login.
app.get('/v1/auth/check', requireAuth, asyncRoute(async (req, res) => {
  const user = await loadUser(req.user.uid);
  ok(res, { user });
}));

app.get('/v1/me', requireAuth, asyncRoute(async (req, res) => ok(res, { user: await loadUser(req.user.uid) })));
app.get('/v1/users/:uid', requireAuth, asyncRoute(async (req, res) => ok(res, { user: await loadUser(req.params.uid) })));

// Posts
app.post('/v1/posts', requireAuth, asyncRoute(async (req, res) => {
  const data = req.body || {};
  const ref = db.collection('posts').doc();
  await ref.set({
    uid: req.user.uid,
    text: clean(data.text, 10000),
    caption: clean(data.caption, 5000),
    image: clean(data.image, 2000000),
    video: clean(data.video, 2000000),
    videoType: clean(data.videoType, 50),
    contentCategory: clean(data.contentCategory, 50),
    audience: clean(data.audience || 'public', 30),
    createdAt: now(), updatedAt: now(), deleted: false, trashed: false
  });
  ok(res, { id: ref.id });
}));

app.get('/v1/posts', requireAuth, asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 30), 100);
  const snap = await db.collection('posts').where('deleted', '!=', true).orderBy('deleted').orderBy('createdAt', 'desc').limit(limit).get();
  ok(res, { posts: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
}));

app.patch('/v1/posts/:id', requireAuth, asyncRoute(async (req, res) => {
  const ref = db.doc(`posts/${req.params.id}`); const snap = await ref.get();
  if (!snap.exists) return bad(res, 404, 'Post not found');
  const p = snap.data(); if (p.uid !== req.user.uid && !isAdminUid(req.user.uid)) return bad(res, 403, 'Not allowed');
  const allowed = ['text','caption','image','albumImages','video','videoType','contentCategory','audience'];
  const patch = {};
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) patch[k] = req.body[k];
  patch.updatedAt = now();
  await ref.update(patch); ok(res, { id: ref.id });
}));

app.delete('/v1/posts/:id', requireAuth, asyncRoute(async (req, res) => {
  const ref = db.doc(`posts/${req.params.id}`); const snap = await ref.get();
  if (!snap.exists) return ok(res, { deleted: true });
  const p = snap.data(); if (p.uid !== req.user.uid && !isAdminUid(req.user.uid)) return bad(res, 403, 'Not allowed');
  await ref.update({ deleted: true, trashed: true, archived: true, visibility: 'private', deletedBy: req.user.uid, deletedAt: now() });
  ok(res, { deleted: true });
}));

app.post('/v1/posts/:id/like', requireAuth, asyncRoute(async (req, res) => {
  const ref = db.doc(`posts/${req.params.id}`); const snap = await ref.get(); if (!snap.exists) return bad(res,404,'Post not found');
  const data = snap.data(); const likes = Array.isArray(data.likes) ? data.likes : [];
  const has = likes.includes(req.user.uid);
  await ref.update({ likes: has ? FieldValue.arrayRemove(req.user.uid) : FieldValue.arrayUnion(req.user.uid), likeCount: FieldValue.increment(has ? -1 : 1), updatedAt: now() });
  ok(res, { liked: !has });
}));

app.post('/v1/posts/:id/save', requireAuth, asyncRoute(async (req, res) => {
  const ref = db.doc(`savedPosts/${req.user.uid}_${req.params.id}`); const snap = await ref.get();
  if (snap.exists) { await ref.delete(); return ok(res, { saved: false }); }
  await ref.set({ uid: req.user.uid, postId: req.params.id, createdAt: now() }); ok(res, { saved: true });
}));

app.post('/v1/posts/:id/share', requireAuth, asyncRoute(async (req, res) => {
  const ref = db.collection('shares').doc(); await ref.set({ postId: req.params.id, uid: req.user.uid, createdAt: now() });
  await db.doc(`posts/${req.params.id}`).update({ shareCount: FieldValue.increment(1) }).catch(() => {});
  ok(res, { id: ref.id });
}));

app.post('/v1/posts/:id/comments', requireAuth, asyncRoute(async (req, res) => {
  const ref = db.collection(`posts/${req.params.id}/comments`).doc();
  await ref.set({ uid: req.user.uid, text: clean(req.body?.text, 3000), parentId: clean(req.body?.parentId, 200), createdAt: now(), likeCount: 0 });
  ok(res, { id: ref.id });
}));

// Follow / friend request
app.post('/v1/users/:uid/follow', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.uid === req.user.uid) return bad(res, 400, 'Cannot follow yourself');
  const me = db.doc(`userProfiles/${req.user.uid}`), them = db.doc(`userProfiles/${req.params.uid}`);
  const [ms, ts] = await Promise.all([me.get(), them.get()]); if (!ts.exists) return bad(res,404,'User not found');
  const following = Array.isArray(ms.data()?.following) ? ms.data().following : [];
  const has = following.includes(req.params.uid);
  await me.update({ following: has ? FieldValue.arrayRemove(req.params.uid) : FieldValue.arrayUnion(req.params.uid) });
  await them.update({ followers: has ? FieldValue.arrayRemove(req.user.uid) : FieldValue.arrayUnion(req.user.uid) });
  ok(res, { following: !has });
}));

app.post('/v1/friend-requests', requireAuth, asyncRoute(async (req, res) => {
  const toUid = clean(req.body?.toUid, 200); if (!toUid || toUid === req.user.uid) return bad(res,400,'Invalid recipient');
  const ref = db.collection('friendRequests').doc(); await ref.set({ fromUid:req.user.uid,toUid,status:'pending',createdAt:now(),updatedAt:now() });
  ok(res,{id:ref.id});
}));

// Blocking: one canonical API path. The web app can later be switched to this instead of client-side block writes.
app.post('/v1/users/:uid/block', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const uid = req.params.uid; if (isAdminUid(uid)) return bad(res,400,'Admin account cannot be blocked by this endpoint');
  await db.doc(`blockedUsers/${uid}`).set({ blocked:true, reason:clean(req.body?.reason,1000), blockedBy:req.user.uid, blockedAt:now() }, {merge:true});
  await db.doc(`userProfiles/${uid}`).set({ blocked:true, active:false, status:'blocked', blockReason:clean(req.body?.reason,1000), blockedAt:now(), blockedBy:req.user.uid }, {merge:true});
  ok(res,{blocked:true});
}));
app.delete('/v1/users/:uid/block', requireAuth, requireAdmin, asyncRoute(async (req,res)=>{
  const uid=req.params.uid;
  await db.doc(`blockedUsers/${uid}`).set({blocked:false,unblockedBy:req.user.uid,unblockedAt:now()},{merge:true});
  await db.doc(`userProfiles/${uid}`).set({blocked:false,active:true,status:'active',unblockedAt:now(),unblockedBy:req.user.uid},{merge:true});
  ok(res,{blocked:false});
}));

// Stories: 24-hour visibility is enforced by expiresAt.
app.post('/v1/stories', requireAuth, asyncRoute(async (req,res)=>{
  const expires = Timestamp.fromMillis(Date.now()+24*60*60*1000);
  const ref=db.collection('stories').doc();
  await ref.set({uid:req.user.uid,text:clean(req.body?.text,3000),media:clean(req.body?.media,2000000),mediaType:clean(req.body?.mediaType,30),createdAt:now(),expiresAt:expires});
  ok(res,{id:ref.id,expiresAt:expires.toDate().toISOString()});
}));
app.get('/v1/stories', requireAuth, asyncRoute(async(req,res)=>{
  const snap=await db.collection('stories').where('expiresAt','>',Timestamp.now()).orderBy('expiresAt').limit(100).get();
  ok(res,{stories:snap.docs.map(d=>({id:d.id,...d.data()}))});
}));

// Notifications
app.get('/v1/notifications', requireAuth, asyncRoute(async(req,res)=>{
  const snap=await db.collection('notifications').where('toUid','==',req.user.uid).limit(100).get();
  const notifications=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>{const ta=a.createdAt?.toMillis?a.createdAt.toMillis():0;const tb=b.createdAt?.toMillis?b.createdAt.toMillis():0;return tb-ta;}).slice(0,50);
  ok(res,{notifications});
}));
app.post('/v1/notifications', requireAuth, asyncRoute(async(req,res)=>{
  const toUid=clean(req.body?.toUid,200), type=clean(req.body?.type,50), text=clean(req.body?.text,2000), postId=clean(req.body?.postId,200);
  if(!toUid||toUid===req.user.uid||!text)return bad(res,400,'Invalid notification.');
  const sender=await loadUser(req.user.uid); const ref=db.collection('notifications').doc();
  await ref.set({toUid,fromUid:req.user.uid,fromName:sender?.name||req.user.email||'FFBDWorld User',type,text,postId,createdAt:now(),read:false});
  ok(res,{id:ref.id});
}));
app.post('/v1/notifications/:id/read', requireAuth, asyncRoute(async(req,res)=>{const ref=db.doc(`notifications/${req.params.id}`);const s=await ref.get();if(!s.exists)return bad(res,404,'Notification not found');if(s.data()?.toUid!==req.user.uid && !isAdminUid(req.user.uid))return bad(res,403,'Not allowed');await ref.set({read:true,readAt:now()},{merge:true});ok(res,{read:true})}));

// Messenger
app.post('/v1/chats', requireAuth, asyncRoute(async(req,res)=>{
  const members=Array.isArray(req.body?.members)?req.body.members.filter(Boolean):[];
  if(!members.includes(req.user.uid)) members.push(req.user.uid);
  const unique=[...new Set(members)].slice(0,50); if(unique.length<2)return bad(res,400,'At least two members required');
  const type=req.body?.type==='group'?'group':'direct';
  // Direct chats use the same canonical UID-based key as the website.
  const chatId=type==='direct' && unique.length===2 ? unique.slice().sort().join('_') : null;
  const ref=chatId?db.doc(`chats/${chatId}`):db.collection('chats').doc();
  const payload={members:unique,type,name:clean(req.body?.name,200),createdBy:req.user.uid,createdAt:now(),updatedAt:now()};
  await ref.set(payload,{merge:true}); ok(res,{id:ref.id,members:unique,type});
}));
app.post('/v1/chats/:chatId/messages', requireAuth, asyncRoute(async(req,res)=>{
  const chat=db.doc(`chats/${req.params.chatId}`), cs=await chat.get(); if(!cs.exists)return bad(res,404,'Chat not found');
  if(!cs.data().members?.includes(req.user.uid))return bad(res,403,'Not a chat member');
  const ref=chat.collection('messages').doc(); await ref.set({uid:req.user.uid,text:clean(req.body?.text,5000),type:clean(req.body?.type||'text',30),media:clean(req.body?.media,2000000),createdAt:now(),seenBy:[req.user.uid]}); await chat.update({lastMessage:clean(req.body?.text,500),lastMessageUid:req.user.uid,updatedAt:now()}); ok(res,{id:ref.id});
}));
app.post('/v1/chats/:chatId/typing', requireAuth, asyncRoute(async(req,res)=>{const ref=db.doc(`chats/${req.params.chatId}`);const s=await ref.get();if(!s.exists||!s.data().members?.includes(req.user.uid))return bad(res,403,'Not allowed');await ref.collection('typing').doc(req.user.uid).set({typing:req.body?.typing===true,at:now()},{merge:true});ok(res,{typing:req.body?.typing===true})}));
app.post('/v1/chats/:chatId/messages/:messageId/seen', requireAuth, asyncRoute(async(req,res)=>{const m=db.doc(`chats/${req.params.chatId}/messages/${req.params.messageId}`);const s=await m.get();if(!s.exists)return bad(res,404,'Message not found');await m.update({seenBy:FieldValue.arrayUnion(req.user.uid),seenAt:now()});ok(res,{seen:true})}));

// WebRTC call signaling API. Firestore listeners remain realtime; API owns the trusted call document mutations.
app.post('/v1/calls', requireAuth, asyncRoute(async(req,res)=>{
  const callee=clean(req.body?.callee,200), type=req.body?.type==='video'?'video':'audio', offer=req.body?.offer;
  if(!callee||callee===req.user.uid||!offer?.sdp)return bad(res,400,'Invalid call target or offer.');
  const ref=db.collection('calls').doc();
  await ref.set({caller:req.user.uid,callee,type,status:'ringing',offer:{type:offer.type||'offer',sdp:String(offer.sdp)},createdAt:now()});
  ok(res,{id:ref.id,status:'ringing'});
}));
app.patch('/v1/calls/:id', requireAuth, asyncRoute(async(req,res)=>{
  const ref=db.doc(`calls/${req.params.id}`), s=await ref.get(); if(!s.exists)return bad(res,404,'Call not found.'); const d=s.data()||{};
  if(d.caller!==req.user.uid&&d.callee!==req.user.uid)return bad(res,403,'Not a call participant.');
  const patch={}; const status=clean(req.body?.status,30);
  if(status && ['ringing','accepted','declined','ended','missed'].includes(status))patch.status=status;
  if(req.body?.answer?.sdp && d.callee===req.user.uid)patch.answer={type:req.body.answer.type||'answer',sdp:String(req.body.answer.sdp)};
  if(status==='ended'||status==='declined')patch.endedAt=now();
  if(!Object.keys(patch).length)return bad(res,400,'No valid call update.');
  await ref.set(patch,{merge:true}); ok(res,{updated:true,status:patch.status||d.status});
}));
app.post('/v1/calls/:id/candidates', requireAuth, asyncRoute(async(req,res)=>{
  const ref=db.doc(`calls/${req.params.id}`), s=await ref.get(); if(!s.exists)return bad(res,404,'Call not found.'); const d=s.data()||{};
  if(d.caller!==req.user.uid&&d.callee!==req.user.uid)return bad(res,403,'Not a call participant.');
  const role=d.caller===req.user.uid?'callerCandidates':'calleeCandidates'; const c=req.body?.candidate; if(!c)return bad(res,400,'Candidate required.');
  const cr=ref.collection(role).doc(); await cr.set(c); ok(res,{id:cr.id});
}));

// Idempotent Stars debit primitive. A caller must supply a stable Idempotency-Key
// for retries; the same key and payload returns the original result without a second debit.
app.post('/v1/stars/deduct', requireAuth, asyncRoute(async (req, res) => {
  const rawKey = String(req.get('Idempotency-Key') || req.body?.idempotencyKey || '').trim();
  const stars = Number(req.body?.stars);
  const reason = clean(req.body?.reason || 'stars_debit', 80).replace(/[^a-zA-Z0-9_-]/g, '_');
  const referenceId = clean(req.body?.referenceId || '', 180);
  if (!rawKey || rawKey.length < 8 || rawKey.length > 200) return bad(res, 400, 'A stable Idempotency-Key (8-200 chars) is required.');
  if (!Number.isSafeInteger(stars) || stars <= 0 || stars > 1000000) return bad(res, 400, 'stars must be a positive whole number.');
  const keyHash = crypto.createHash('sha256').update(`${req.user.uid}:${rawKey}`).digest('hex');
  const idemRef = db.doc(`starDebitIdempotency/${keyHash}`);
  const profileRef = db.doc(`userProfiles/${req.user.uid}`);
  const ledgerRef = db.collection('starLedger').doc();
  const result = await db.runTransaction(async tx => {
    const idemSnap = await tx.get(idemRef);
    if (idemSnap.exists) {
      const old = idemSnap.data() || {};
      if (old.stars !== stars || old.reason !== reason || old.referenceId !== referenceId) {
        const e = new Error('Idempotency-Key was already used with a different payload.'); e.statusCode = 409; throw e;
      }
      return { replayed: true, starsDeducted: old.stars, balanceAfter: old.balanceAfter, ledgerId: old.ledgerId };
    }
    const profileSnap = await tx.get(profileRef);
    const profile = profileSnap.exists ? profileSnap.data() || {} : {};
    const balance = Number(profile.starsAvailable || 0);
    if (!Number.isFinite(balance) || balance < stars) { const e = new Error('Not enough Stars.'); e.statusCode = 402; throw e; }
    const balanceAfter = balance - stars;
    tx.set(profileRef, { starsAvailable: balanceAfter, updatedAt: now() }, { merge: true });
    tx.create(ledgerRef, { uid: req.user.uid, type: reason, direction: 'debit', stars, referenceId: referenceId || keyHash, idempotencyKeyHash: keyHash, balanceAfter, createdAt: now() });
    tx.create(idemRef, { uid: req.user.uid, stars, reason, referenceId, balanceAfter, ledgerId: ledgerRef.id, createdAt: now() });
    return { replayed: false, starsDeducted: stars, balanceAfter, ledgerId: ledgerRef.id };
  });
  ok(res, result);
}));

// Groups / Events
app.post('/v1/groups', requireAuth, asyncRoute(async(req,res)=>{
  const settings=await getBusinessSettings(); const charge=Math.max(0,Number(settings.groupCreateStars||0));
  const ref=db.collection('groups').doc(), profile=db.doc(`userProfiles/${req.user.uid}`), ledger=db.collection('starLedger').doc();
  await db.runTransaction(async tx=>{const ps=await tx.get(profile);const d=ps.exists?ps.data()||{}:{};const bal=Number(d.starsAvailable||0);if(bal<charge)throw new Error('Not enough Stars to create a group.');
    tx.set(profile,{starsAvailable:bal-charge,updatedAt:now()},{merge:true});
    tx.set(ref,{name:clean(req.body?.name,200),description:clean(req.body?.description,2000),ownerUid:req.user.uid,members:[req.user.uid],createdAt:now(),creationStars:charge,rateSnapshot:{groupCreateStars:charge}});
    tx.set(ledger,{uid:req.user.uid,type:'group_create',direction:'debit',stars:charge,referenceId:ref.id,rateSnapshot:{groupCreateStars:charge},createdAt:now()});});
  ok(res,{id:ref.id,starsCharged:charge});
}));
app.post('/v1/events', requireAuth, asyncRoute(async(req,res)=>{const ref=db.collection('events').doc();await ref.set({title:clean(req.body?.title,200),description:clean(req.body?.description,3000),location:clean(req.body?.location,500),startAt:req.body?.startAt||null,ownerUid:req.user.uid,createdAt:now()});ok(res,{id:ref.id})}));

// Job/Tuition board creation: server-enforced free quota and Star charge.
app.post('/v1/board/create', requireAuth, asyncRoute(async(req,res)=>{
  const kind=clean(req.body?.kind,20).toLowerCase();if(!['job','tuition'].includes(kind))return bad(res,400,'kind must be job or tuition.');
  const title=clean(req.body?.title,200),location=clean(req.body?.location,300),description=clean(req.body?.description,3000),company=clean(req.body?.company,200),subject=clean(req.body?.subject,200),salary=Number(req.body?.salary||0);
  if(!title||!location||!description||!Number.isFinite(salary)||salary<0||(kind==='job'&&!company)||(kind==='tuition'&&!subject))return bad(res,400,'Missing or invalid required fields.');
  const settings=await getBusinessSettings(),collectionName=kind==='job'?'jobPosts':'tuitionPosts',quota=Number(settings[kind==='job'?'jobFreePosts':'tuitionFreePosts']||0),charge=Math.max(0,Number(settings[kind==='job'?'jobPostStars':'tuitionPostStars']||0));
  const coll=db.collection(collectionName),profile=db.doc(`userProfiles/${req.user.uid}`),post=coll.doc(),ledger=db.collection('starLedger').doc(),quotaRef=db.doc(`postingQuota/${req.user.uid}`),quotaField=kind==='job'?'jobCreated':'tuitionCreated';
  await db.runTransaction(async tx=>{const [qs,ps]=await Promise.all([tx.get(quotaRef),tx.get(profile)]),qd=qs.exists?qs.data()||{}:{},pd=ps.exists?ps.data()||{}:{},used=Math.max(0,Number(qd[quotaField]||0));const paid=used>=quota,stars=paid?charge:0,bal=Number(pd.starsAvailable||0);if(bal<stars)throw new Error(`Not enough Stars. ${quota} free ${kind} posts are allowed. Buy Stars to continue.`);
    if(stars)tx.set(profile,{starsAvailable:bal-stars,updatedAt:now()},{merge:true});
    tx.set(quotaRef,{uid:req.user.uid,[quotaField]:used+1,updatedAt:now()},{merge:true});
    tx.create(post,{uid:req.user.uid,kind,company,title,subject,location,salary,description,status:'published',freePost:!paid,starsCharged:stars,rateSnapshot:{freeQuota:quota,postChargeStars:charge},createdAt:now()});
    if(stars)tx.create(ledger,{uid:req.user.uid,type:`${kind}_post_fee`,direction:'debit',stars,referenceId:post.id,rateSnapshot:{freeQuota:quota,postChargeStars:charge},createdAt:now()});
  });
  ok(res,{id:post.id,kind,status:'published',starsCharged:(await post.get()).data()?.starsCharged||0});
}));


// Verification / Boost / Monetization
app.post('/v1/verification-requests', requireAuth, asyncRoute(async(req,res)=>{
  const settings=await getBusinessSettings();const fee=Math.max(0,Number(settings.verificationStars||0));
  const ref=db.collection('verificationRequests').doc(req.user.uid),profile=db.doc(`userProfiles/${req.user.uid}`),ledger=db.collection('starLedger').doc();
  await db.runTransaction(async tx=>{const [rs,ps]=await Promise.all([tx.get(ref),tx.get(profile)]);const old=rs.exists?rs.data()||{}:{};if(old.status==='pending')throw new Error('A verification request is already pending.');
    const d=ps.exists?ps.data()||{}:{};const bal=Number(d.starsAvailable||0);if(bal<fee)throw new Error('Not enough Stars for verification.');
    tx.set(profile,{starsAvailable:bal-fee,updatedAt:now()},{merge:true});
    tx.set(ref,{uid:req.user.uid,name:clean(req.body?.name,200),username:clean(req.body?.username,100),email:clean(req.body?.email,200),phone:clean(req.body?.phone,100),type:clean(req.body?.type||'profile',50),status:'pending',feeStars:fee,refundStars:Number(settings.verificationRejectRefundStars||0),rateSnapshot:{verificationStars:fee,verificationRejectRefundStars:Number(settings.verificationRejectRefundStars||0)},createdAt:now(),updatedAt:now()});
    tx.set(ledger,{uid:req.user.uid,type:'verification_fee',direction:'debit',stars:fee,referenceId:ref.id,rateSnapshot:{verificationStars:fee},createdAt:now()});});
  ok(res,{id:ref.id,status:'pending',starsCharged:fee});
}));
app.post('/v1/boost-requests', requireAuth, asyncRoute(async(req,res)=>{
  const postId=clean(req.body?.postId,200),kind=clean(req.body?.kind||req.body?.boostType||'market',20).toLowerCase();
  if(!['market','profile'].includes(kind))return bad(res,400,'Boost kind must be market or profile.');
  const post=kind==='market'?await db.doc(`posts/${postId}`).get():null;if(kind==='market'&&(!postId||!post?.exists||post.data()?.uid!==req.user.uid))return bad(res,403,'Market boost requires your own post.');
  const settings=await getBusinessSettings(),hours=Number(req.body?.durationHours||24),suffix=hours===24?'24h':hours===72?'72h':hours===168?'7d':hours===360?'15d':hours===720?'30d':'';
  if(!suffix)return bad(res,400,'Unsupported boost duration.');
  const key=(kind==='market'?'marketBoost':'profileBoost')+suffix,charge=Number(settings[key]);if(!Number.isFinite(charge)||charge<0)return bad(res,400,'Boost rate is not configured.');
  const ref=db.collection('boostRequests').doc(),profile=db.doc(`userProfiles/${req.user.uid}`),ledger=db.collection('starLedger').doc();
  await db.runTransaction(async tx=>{const ps=await tx.get(profile);const d=ps.exists?ps.data()||{}:{};const bal=Number(d.starsAvailable||0);if(bal<charge)throw new Error('Not enough Stars for this boost.');
    tx.set(profile,{starsAvailable:bal-charge,updatedAt:now()},{merge:true});tx.set(ref,{uid:req.user.uid,postId:postId||null,kind,durationHours:hours,amountStars:charge,rateSnapshot:{[key]:charge},status:'pending',createdAt:now()});
    tx.set(ledger,{uid:req.user.uid,type:'boost_purchase',direction:'debit',stars:charge,referenceId:ref.id,rateSnapshot:{[key]:charge},createdAt:now()});});
  ok(res,{id:ref.id,status:'pending',starsCharged:charge});
}));
app.post('/v1/monetization-applications', requireAuth, asyncRoute(async(req,res)=>{const ref=db.collection('monetizationApplications').doc();await ref.set({uid:req.user.uid,name:clean(req.body?.name,200),username:clean(req.body?.username,100),email:clean(req.body?.email,200),followers:Number(req.body?.followers||0),contentCategory:clean(req.body?.contentCategory,100),categoryLabel:clean(req.body?.categoryLabel,200),watchHours:Number(req.body?.watchHours||0),watchSeconds:Number(req.body?.watchSeconds||0),views:Number(req.body?.views||0),metrics:req.body?.metrics||{},status:'pending',monetizationType:'content',createdAt:now()});ok(res,{id:ref.id,status:'pending'})}));

// Separate Taka-only cashout queues. These routes never read or mutate Stars balances.
async function createTakaWithdrawal(req, res, kind) {
  const amount = Number(req.body?.amount);
  const method = clean(req.body?.method, 30);
  const account = clean(req.body?.account || req.body?.number, 100).trim();
  if (!Number.isFinite(amount) || amount < 500 || Math.round(amount * 100) !== amount * 100) return bad(res, 400, 'Minimum withdrawal is ৳500; amount must be valid.');
  if (!['bKash','Nagad','Rocket'].includes(method) || !account) return bad(res, 400, 'Valid bKash/Nagad/Rocket payout details are required.');
  const profile = db.doc(`userProfiles/${req.user.uid}`);
  const collection = kind === 'monetization' ? 'monetizationPayoutRequests' : 'withdrawalRequests';
  const out = db.collection(collection).doc();
  const balanceField = kind === 'monetization' ? 'monetizationTakaBalance' : 'walletTakaBalance';
  const pendingField = kind === 'monetization' ? 'pendingMonetizationTaka' : 'pendingWalletTaka';
  const ledgerCollection = kind === 'monetization' ? 'monetizationTakaLedger' : 'takaWalletLedger';
  const ledger = db.collection(ledgerCollection).doc();
  await db.runTransaction(async tx => {
    const snap = await tx.get(profile);
    const d = snap.exists ? snap.data() || {} : {};
    const balance = Number(d[balanceField] || 0);
    if (!Number.isFinite(balance) || balance < amount) throw new Error(`Insufficient ${kind === 'monetization' ? 'monetization' : 'Taka wallet'} balance.`);
    tx.set(profile, { [balanceField]: Math.round((balance - amount) * 100) / 100, [pendingField]: Math.round((Number(d[pendingField] || 0) + amount) * 100) / 100, updatedAt: now() }, { merge: true });
    tx.create(out, { uid: req.user.uid, amount: Math.round(amount * 100) / 100, method, account, status: 'pending', walletType: kind === 'monetization' ? 'monetization_taka' : 'taka_wallet', balanceField, createdAt: now() });
    tx.create(ledger, { uid: req.user.uid, type: 'withdrawal_reserve', direction: 'debit', amount: Math.round(amount * 100) / 100, currency: 'BDT', walletType: kind === 'monetization' ? 'monetization_taka' : 'taka_wallet', referenceId: out.id, createdAt: now() });
  });
  res.json({ success: true, ok: true, id: out.id, status: 'pending', amount });
}
app.post('/monetization/withdraw', requireAuth, asyncRoute(async(req,res)=>createTakaWithdrawal(req,res,'monetization')));
app.post('/wallet/withdraw', requireAuth, asyncRoute(async(req,res)=>createTakaWithdrawal(req,res,'wallet')));
app.post('/v1/monetization/withdraw', requireAuth, asyncRoute(async(req,res)=>createTakaWithdrawal(req,res,'monetization')));
app.post('/v1/wallet/withdraw', requireAuth, asyncRoute(async(req,res)=>createTakaWithdrawal(req,res,'wallet')));

// Stars / referral / shop / help
// Stars / referral / shop / help — prices are read from businessSettings/general.
app.post('/v1/stars/purchase-requests', requireAuth, asyncRoute(async(req,res)=>{
  const settings=await getBusinessSettings();if(settings.manualPaymentsEnabled===false)return bad(res,403,'Manual Stars payments are currently disabled.');
  const stars=Math.floor(Number(req.body?.stars||0)),amount=Number(req.body?.amount||0);
  if(!Number.isInteger(stars)||stars<Number(settings.starRateStars)||stars%Number(settings.starRateStars)!==0)return bad(res,400,`Stars must be in packages of ${settings.starRateStars}.`);
  const expected=starToTaka(stars,settings);if(Math.abs(amount-expected)>0.01)return bad(res,400,'Invalid Stars price for current business rate.');
  const paymentReference=clean(req.body?.paymentReference||req.body?.transactionId,300);if(!paymentReference)return bad(res,400,'Payment reference required.');
  const trxKey=crypto.createHash('sha256').update(paymentReference.trim().toLowerCase()).digest('hex'),indexRef=db.doc(`starPurchaseTrxIndex/${trxKey}`),ref=db.collection('starPurchases').doc();
  await db.runTransaction(async tx=>{const ix=await tx.get(indexRef);if(ix.exists)throw new Error('This transaction reference has already been submitted.');
    tx.create(indexRef,{purchaseId:ref.id,uid:req.user.uid,createdAt:now()});
    tx.create(ref,{uid:req.user.uid,stars,amount:expected,status:'pending',paymentMethod:clean(req.body?.paymentMethod,50),paymentReference,rateSnapshot:{starRateStars:Number(settings.starRateStars),starRateTaka:Number(settings.starRateTaka)},createdAt:now()});});
  ok(res,{id:ref.id,status:'pending',stars,amount:expected});
}));

app.post('/v1/stars/withdrawal-requests', requireAuth, asyncRoute(async(req,res)=>{
  const settings=await getBusinessSettings(),stars=Math.floor(Number(req.body?.stars||0)),minimum=Number(settings.starWithdrawMinStars||500),feePct=Number(settings.starWithdrawFeePct||10);
  if(!Number.isInteger(stars)||stars<minimum)return bad(res,400,`Minimum withdrawal is ${minimum} Stars.`);
  if(feePct<0||feePct>100)return bad(res,400,'Invalid withdrawal fee configuration.');
  const number=clean(req.body?.number,100);if(!number)return bad(res,400,'Payout number required.');
  const gross=starToTaka(stars,settings),fee=Math.round(gross*feePct)/100,net=Math.round((gross-fee)*100)/100;
  const profile=db.doc(`userProfiles/${req.user.uid}`),out=db.collection('starWithdrawals').doc(),ledger=db.collection('starLedger').doc();
  await db.runTransaction(async tx=>{const s=await tx.get(profile);const d=s.exists?s.data()||{}:{};const bal=Number(d.starsAvailable||0);if(bal<stars)throw new Error('Not enough Stars.');
    tx.set(profile,{starsAvailable:bal-stars,pendingWithdrawalStars:Number(d.pendingWithdrawalStars||0)+stars,updatedAt:now()},{merge:true});
    tx.set(out,{uid:req.user.uid,stars,grossAmount:gross,feeAmount:fee,feePct,amount:net,netAmount:net,method:clean(req.body?.method,50),number,status:'pending',rateSnapshot:{starRateStars:Number(settings.starRateStars),starRateTaka:Number(settings.starRateTaka),starWithdrawFeePct:feePct},createdAt:now()});
    tx.set(ledger,{uid:req.user.uid,type:'stars_withdrawal_request',direction:'debit',stars,referenceId:out.id,rateSnapshot:{grossAmount:gross,feeAmount:fee,netAmount:net,feePct},createdAt:now()});});
  ok(res,{id:out.id,status:'pending',stars,grossAmount:gross,feeAmount:fee,netAmount:net});
}));

app.post('/v1/stars/gifts', requireAuth, asyncRoute(async(req,res)=>{
  const receiverUid=clean(req.body?.receiverUid,200); const stars=Math.floor(Number(req.body?.stars||0));
  if(!receiverUid || receiverUid===req.user.uid) return bad(res,400,'Invalid receiver.'); if(!Number.isInteger(stars) || stars<=0) return bad(res,400,'Gift amount must be a positive whole number of Stars.');
  const sender=db.doc(`userProfiles/${req.user.uid}`), gift=db.collection('starGifts').doc();
  await db.runTransaction(async tx=>{ const s=await tx.get(sender); const d=s.exists?s.data()||{}:{}; const bal=Number(d.starsAvailable||0); if(bal<stars) throw new Error('Not enough Stars.'); tx.set(sender,{starsAvailable:bal-stars,pendingSentStars:Number(d.pendingSentStars||0)+stars,updatedAt:now()},{merge:true}); tx.set(gift,{senderUid:req.user.uid,receiverUid,stars,status:'pending',contextType:clean(req.body?.contextType,50),contextId:clean(req.body?.contextId,200),createdAt:now()}); });
  ok(res,{id:gift.id,status:'pending'});
}));
app.post('/v1/referrals', requireAuth, asyncRoute(async(req,res)=>{
  const referrerUid=clean(req.body?.referrerUid,200);
  if(!referrerUid || referrerUid===req.user.uid) return bad(res,400,'Invalid referral owner.');
  const [existing,referrerSnap,referredSnap]=await Promise.all([
    db.collection('referrals').where('referredUid','==',req.user.uid).limit(1).get(),
    db.doc(`userProfiles/${referrerUid}`).get(),db.doc(`userProfiles/${req.user.uid}`).get()
  ]);
  if(!existing.empty) return bad(res,409,'Referral already recorded for this account.');
  const rd=referredSnap.exists?referredSnap.data()||{}:{},fd=referrerSnap.exists?referrerSnap.data()||{}:{};
  const normPhone=v=>String(v||'').replace(/\D/g,'').replace(/^88/,'');
  const phoneA=normPhone(rd.phone||rd.phoneNumber),phoneB=normPhone(fd.phone||fd.phoneNumber);
  const ipHash=crypto.createHash('sha256').update(String(req.ip||'unknown')).digest('hex');
  const signupHash=String(fd.signupIpHash||fd.registrationIpHash||fd.lastSignupIpHash||'');
  const referredSignupHash=String(rd.signupIpHash||rd.registrationIpHash||rd.lastSignupIpHash||'');
  const samePhone=!!phoneA&&!!phoneB&&phoneA===phoneB, sameIp=!!signupHash&&signupHash===referredSignupHash;
  const sameRequestIp=!!signupHash&&signupHash===ipHash;
  const ref=db.collection('referrals').doc();
  await ref.set({referrerUid,referredUid:req.user.uid,status:(samePhone||sameIp||sameRequestIp)?'rejected':'pending',rejectionReason:samePhone?'same_phone':(sameIp||sameRequestIp)?'same_ip':null,rewardGranted:false,requestIpHash:ipHash,referrerSignupIpHash:signupHash||null,referredSignupIpHash:referredSignupHash||null,createdAt:now()});
  if(samePhone||sameIp||sameRequestIp)return bad(res,403,'Referral is not eligible: same phone or registration IP detected.');
  ok(res,{id:ref.id,status:'pending'});
}));
app.post('/v1/referrals/finalize', requireAuth, asyncRoute(async(req,res)=>{
  const referredUid=req.user.uid;
  const existing=await db.collection('referrals').where('referredUid','==',referredUid).limit(5).get();
  if(existing.empty) return bad(res,404,'No referral record found for this account.');
  const referralDoc=existing.docs.find(d=>!['rejected','rewarded'].includes(String(d.data()?.status||'')));
  if(!referralDoc){
    const already=existing.docs.find(d=>d.data()?.rewardGranted===true||d.data()?.status==='rewarded');
    if(already) return ok(res,{status:'rewarded',alreadyProcessed:true});
    return bad(res,403,'Referral is not eligible.');
  }
  const referral=referralDoc.ref;
  const settings=await getBusinessSettings();
  const reward=Math.max(0,Math.floor(Number(settings.referralRewardStars??20)));
  let credited=false;
  await db.runTransaction(async tx=>{
    const rs=await tx.get(referral);
    if(!rs.exists) throw new Error('Referral not found.');
    const r=rs.data()||{};
    if(r.referredUid!==referredUid) throw new Error('Referral owner mismatch.');
    if(r.rewardGranted===true||r.status==='rewarded') return;
    if(r.status==='rejected') throw new Error('Referral is not eligible.');
    const referrerUid=String(r.referrerUid||'');
    if(!referrerUid||referrerUid===referredUid) throw new Error('Invalid referral owner.');
    const referrer=db.doc(`userProfiles/${referrerUid}`), referred=db.doc(`userProfiles/${referredUid}`);
    const [a,b]=await Promise.all([tx.get(referrer),tx.get(referred)]);
    const ad=a.exists?a.data()||{}:{}, bd=b.exists?b.data()||{}:{};
    const normPhone=v=>String(v||'').replace(/\D/g,'').replace(/^88/,'');
    const phoneA=normPhone(ad.phone||ad.phoneNumber), phoneB=normPhone(bd.phone||bd.phoneNumber);
    const ipA=String(ad.signupIpHash||ad.registrationIpHash||ad.lastSignupIpHash||'');
    const ipB=String(bd.signupIpHash||bd.registrationIpHash||bd.lastSignupIpHash||'');
    if((phoneA&&phoneB&&phoneA===phoneB)||(ipA&&ipB&&ipA===ipB)){
      tx.update(referral,{status:'rejected',rejectionReason:(phoneA&&phoneB&&phoneA===phoneB)?'same_phone':'same_ip',reviewedAt:now()});
      return;
    }
    tx.set(referrer,{starsAvailable:Number(ad.starsAvailable||0)+reward,starsReferralRewards:Number(ad.starsReferralRewards||0)+reward,updatedAt:now()},{merge:true});
    tx.set(referred,{starsAvailable:Number(bd.starsAvailable||0)+reward,starsReferralRewardsReceived:Number(bd.starsReferralRewardsReceived||0)+reward,referralRewardReceived:true,updatedAt:now()},{merge:true});
    tx.update(referral,{status:'rewarded',rewardGranted:true,rewardStars:reward,rewardedBy:'system:first-login',rewardedAt:now()});
    const la=db.collection('starLedger').doc(),lb=db.collection('starLedger').doc();
    tx.set(la,{uid:referrerUid,type:'referral_reward',direction:'credit',stars:reward,referenceId:referral.id,createdAt:now()});
    tx.set(lb,{uid:referredUid,type:'referral_reward',direction:'credit',stars:reward,referenceId:referral.id,createdAt:now()});
    credited=true;
  });
  const latest=await referral.get();
  const status=latest.data()?.status||'pending';
  if(status==='rejected') return bad(res,403,'Referral is not eligible: same phone or registration IP detected.');
  ok(res,{status,credited,rewardStarsPerEligibleUser:reward,alreadyProcessed:!credited});
}));


// Marketplace listing creation is server-enforced: first N listings free, then Stars fee.
app.post('/v1/marketplace/listings', requireAuth, asyncRoute(async(req,res)=>{
  const title=clean(req.body?.title,200).trim(),description=clean(req.body?.description,3000),category=clean(req.body?.category,100),location=clean(req.body?.location,300),contact=clean(req.body?.contact,100),image=clean(req.body?.image,2000000),price=Number(req.body?.price);
  if(!title||!category||!location||!Number.isFinite(price)||price<0)return bad(res,400,'Valid title, category, location and price are required.');
  const settings=await getBusinessSettings(),quota=Math.max(0,Math.floor(Number(settings.marketplaceFreePosts??10))),fee=Math.max(0,Number(settings.marketplacePostStars??10));
  const coll=db.collection('marketplace'),profile=db.doc(`userProfiles/${req.user.uid}`),ref=coll.doc(),ledger=db.collection('starLedger').doc(),quotaRef=db.doc(`postingQuota/${req.user.uid}`);
  await db.runTransaction(async tx=>{const [qs,ps,quotaSnap]=await Promise.all([tx.get(quotaRef),tx.get(profile)]);const pd=ps.exists?ps.data()||{}:{},qd=qs.exists?qs.data()||{}:{},used=Math.max(0,Number(qd.marketplaceCreated||0)),paid=used>=quota,charge=paid?fee:0,bal=Number(pd.starsAvailable||0);if(bal<charge)throw new Error(`Not enough Stars. First ${quota} marketplace listings are free; then ${fee} Stars per listing. Buy Stars to continue.`);
    if(charge)tx.set(profile,{starsAvailable:bal-charge,updatedAt:now()},{merge:true});
    tx.set(quotaRef,{uid:req.user.uid,marketplaceCreated:used+1,updatedAt:now()},{merge:true});
    tx.create(ref,{uid:req.user.uid,title,price,category,location,contact,description,image,status:'active',freePost:!paid,starsCharged:charge,rateSnapshot:{marketplaceFreePosts:quota,marketplacePostStars:fee},createdAt:now(),updatedAt:now()});
    if(charge)tx.create(ledger,{uid:req.user.uid,type:'marketplace_post_fee',direction:'debit',stars:charge,referenceId:ref.id,rateSnapshot:{marketplaceFreePosts:quota,marketplacePostStars:fee},createdAt:now()});
  });
  ok(res,{id:ref.id,starsCharged:(await ref.get()).data()?.starsCharged||0});
}));

// PK battle: each participant pays entry fee once; each vote costs Stars and is platform income.
app.post('/v1/pk/enter', requireAuth, asyncRoute(async(req,res)=>{
  const battleId=clean(req.body?.battleId,200),opponentUid=clean(req.body?.opponentUid,200);
  if(!battleId)return bad(res,400,'battleId required.');
  const settings=await getBusinessSettings(),fee=Math.max(0,Number(settings.pkEntryStars??5)),battleRef=db.doc(`pkBattles/${battleId}`),profile=db.doc(`userProfiles/${req.user.uid}`),ledger=db.collection('starLedger').doc();
  await db.runTransaction(async tx=>{const [bs,ps]=await Promise.all([tx.get(battleRef),tx.get(profile)]);if(!bs.exists)throw new Error('PK battle not found.');const b=bs.data()||{},players=Array.isArray(b.players)?b.players:[];if(b.status==='completed'||b.status==='cancelled')throw new Error('PK battle is closed.');if(players.some(x=>(typeof x==='string'?x:x.uid)===req.user.uid))throw new Error('Already entered this PK battle.');if(players.length>=2)throw new Error('PK battle already has two players.');if(opponentUid&&players.length===0&&opponentUid===req.user.uid)throw new Error('Invalid opponent.');const pd=ps.exists?ps.data()||{}:{},bal=Number(pd.starsAvailable||0);if(bal<fee)throw new Error('Not enough Stars for PK entry.');const next=[...players,{uid:req.user.uid,entryStars:fee,enteredAt:new Date().toISOString()}];tx.set(profile,{starsAvailable:bal-fee,updatedAt:now()},{merge:true});tx.set(battleRef,{players:next,entryFeeStars:fee,rateSnapshot:{...(b.rateSnapshot||{}),pkEntryStars:fee},status:next.length===2?'active':'waiting',potStars:next.reduce((a,x)=>a+Number(x.entryStars||0),0),updatedAt:now()},{merge:true});tx.create(ledger,{uid:req.user.uid,type:'pk_entry_fee',direction:'debit',stars:fee,referenceId:battleId,rateSnapshot:{pkEntryStars:fee},createdAt:now()});});
  ok(res,{battleId,entryStars:fee});
}));
app.post('/v1/pk/vote', requireAuth, asyncRoute(async(req,res)=>{
  const battleId=clean(req.body?.battleId,200),targetUid=clean(req.body?.targetUid,200);if(!battleId||!targetUid||targetUid===req.user.uid)return bad(res,400,'Valid battleId and targetUid required.');
  const settings=await getBusinessSettings(),fee=Math.max(0,Number(settings.pkVoteStars??2)),battleRef=db.doc(`pkBattles/${battleId}`),profile=db.doc(`userProfiles/${req.user.uid}`),voteRef=db.doc(`pkBattles/${battleId}/votes/${req.user.uid}`),ledger=db.collection('starLedger').doc();
  await db.runTransaction(async tx=>{const [bs,ps,vs]=await Promise.all([tx.get(battleRef),tx.get(profile),tx.get(voteRef)]);if(!bs.exists)throw new Error('PK battle not found.');const b=bs.data()||{},players=Array.isArray(b.players)?b.players:[];if(!players.some(x=>(typeof x==='string'?x:x.uid)===targetUid))throw new Error('Vote target is not a battle participant.');if(vs.exists)throw new Error('You have already voted in this PK battle.');const pd=ps.exists?ps.data()||{}:{},bal=Number(pd.starsAvailable||0);if(bal<fee)throw new Error('Not enough Stars to vote.');tx.set(profile,{starsAvailable:bal-fee,updatedAt:now()},{merge:true});tx.create(voteRef,{uid:req.user.uid,targetUid,stars:fee,createdAt:now()});tx.set(battleRef,{voteIncomeStars:Number(b.voteIncomeStars||0)+fee,updatedAt:now()},{merge:true});tx.create(ledger,{uid:req.user.uid,type:'pk_vote_fee',direction:'debit',stars:fee,referenceId:battleId,rateSnapshot:{pkVoteStars:fee,platformSharePct:100},createdAt:now()});});ok(res,{battleId,voteStars:fee,platformShareStars:fee});
}));
app.post('/v1/admin/pk/:id/settle', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const ref=db.doc(`pkBattles/${req.params.id}`),winnerUid=clean(req.body?.winnerUid,200);if(!winnerUid)return bad(res,400,'winnerUid required.');
  const settings=await getBusinessSettings(),pct=Number(settings.pkWinnerGiftPct??80),ledger=db.collection('starLedger').doc(),audit=db.collection('auditLogs').doc();
  await db.runTransaction(async tx=>{const bs=await tx.get(ref);if(!bs.exists)throw new Error('PK battle not found.');const b=bs.data()||{},players=Array.isArray(b.players)?b.players:[];if(b.status==='completed')throw new Error('PK battle already settled.');if(players.length!==2||!players.some(x=>(typeof x==='string'?x:x.uid)===winnerUid))throw new Error('Winner must be one of the two battle participants.');const pot=Math.max(0,Number(b.potStars||players.reduce((a,x)=>a+Number(x.entryStars||0),0))),payout=Math.floor(pot*pct/100),platform=pot-payout,profile=db.doc(`userProfiles/${winnerUid}`),ps=await tx.get(profile),pd=ps.exists?ps.data()||{}:{};tx.set(profile,{starsAvailable:Number(pd.starsAvailable||0)+payout,updatedAt:now()},{merge:true});tx.update(ref,{status:'completed',winnerUid,payoutStars:payout,platformShareStars:platform,settledBy:req.user.uid,settledAt:now(),rateSnapshot:{...(b.rateSnapshot||{}),pkWinnerGiftPct:pct}});tx.create(ledger,{uid:winnerUid,type:'pk_winner_payout',direction:'credit',stars:payout,referenceId:ref.id,rateSnapshot:{pkWinnerGiftPct:pct,potStars:pot,platformShareStars:platform},createdAt:now()});tx.create(audit,{action:'pk_battle_settlement',targetId:ref.id,targetUid:winnerUid,actorUid:req.user.uid,potStars:pot,payoutStars:payout,platformShareStars:platform,createdAt:now()});});ok(res,{settled:true});
}));


app.post('/v1/pk/battles', requireAuth, asyncRoute(async(req,res)=>{const ref=db.collection('pkBattles').doc();await ref.create({ownerUid:req.user.uid,players:[],status:'waiting',potStars:0,voteIncomeStars:0,createdAt:now(),updatedAt:now()});ok(res,{id:ref.id,status:'waiting'})}));

// Monetization accrual is admin-only and idempotent. eligibleViews/eligibleLikes must be verified upstream.
app.post('/v1/admin/monetization/accrue', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const uid=clean(req.body?.uid,200),contentId=clean(req.body?.contentId,300),periodKey=clean(req.body?.periodKey,40),kind=clean(req.body?.kind,20).toLowerCase();
  const metric=kind==='photo'?Number(req.body?.eligibleLikes):Number(req.body?.eligibleViews);
  if(!uid||!contentId||!periodKey||!['short','long','photo'].includes(kind)||!Number.isSafeInteger(metric)||metric<0)return bad(res,400,'uid, contentId, periodKey, valid kind and non-negative integer eligible metric required.');
  const settings=await getBusinessSettings(),rate=Number(settings[kind==='short'?'shortPayoutPer1000':kind==='long'?'longPayoutPer1000':'photoPayoutPer1000Likes']||0),amount=Math.round(metric*rate/1000*100)/100;
  const key=crypto.createHash('sha256').update(`${uid}|${contentId}|${periodKey}|${kind}`).digest('hex'),accrual=db.doc(`monetizationAccruals/${key}`),profile=db.doc(`userProfiles/${uid}`),ledger=db.collection('monetizationTakaLedger').doc(),audit=db.collection('auditLogs').doc();
  await db.runTransaction(async tx=>{const [as,ps]=await Promise.all([tx.get(accrual),tx.get(profile)]);if(as.exists)throw new Error('Monetization accrual already recorded for this content period.');if(!ps.exists)throw new Error('User profile not found.');const d=ps.data()||{};if(d.monetizationEnabled!==true&&d.monetizationStatus!=='approved')throw new Error('User is not approved for monetization.');const balance=Math.round((Number(d.monetizationTakaBalance||0)+amount)*100)/100;tx.create(accrual,{uid,contentId,periodKey,kind,eligibleMetric:metric,ratePer1000:rate,amount,currency:'BDT',createdBy:req.user.uid,createdAt:now()});tx.set(profile,{monetizationTakaBalance:balance,updatedAt:now()},{merge:true});tx.create(ledger,{uid,type:'monetization_earning',direction:'credit',amount,currency:'BDT',walletType:'monetization_taka',referenceId:key,contentId,periodKey,kind,eligibleMetric:metric,ratePer1000:rate,createdAt:now()});tx.create(audit,{action:'monetization_earning_accrual',targetUid:uid,targetId:key,actorUid:req.user.uid,kind,eligibleMetric:metric,ratePer1000:rate,amount,createdAt:now()});});ok(res,{accrued:true,amount,currency:'BDT',ratePer1000:rate,eligibleMetric:metric});
}));

// Admin queues and date-filtered financial summary based on immutable ledger/request records.
app.get('/v1/admin/queues', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const names=['starPurchases','starWithdrawals','verificationRequests','boostRequests','orders','monetizationApplications','monetizationPayoutRequests','withdrawalRequests','referrals','starGifts'];const out={};
  for(const name of names){try{const snap=await db.collection(name).where('status','==','pending').limit(200).get();out[name]=snap.docs.map(d=>({id:d.id,...d.data()}));}catch(e){out[name]=[];}}
  ok(res,{queues:out});
}));
app.get('/v1/admin/reports/financial', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const from=req.query.from?new Date(String(req.query.from)):new Date(Date.now()-7*86400000),to=req.query.to?new Date(String(req.query.to)):new Date();if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>to)return bad(res,400,'Invalid date range.');
  const collections=['starLedger','monetizationTakaLedger','takaWalletLedger'];const summary={from:from.toISOString(),to:to.toISOString(),starCredits:0,starDebits:0,takaCredits:0,takaDebits:0,events:0};
  for(const name of collections){try{const snap=await db.collection(name).where('createdAt','>=',admin.firestore.Timestamp.fromDate(from)).where('createdAt','<=',admin.firestore.Timestamp.fromDate(to)).limit(5000).get();for(const d of snap.docs){const x=d.data()||{};summary.events++;const amount=Number(name==='starLedger'?x.stars:x.amount)||0;if(name==='starLedger'){if(x.direction==='credit')summary.starCredits+=amount;else if(x.direction==='debit')summary.starDebits+=amount;}else{if(x.direction==='credit')summary.takaCredits+=amount;else if(x.direction==='debit')summary.takaDebits+=amount;}}}catch(e){/* missing indexes/collections are reported as unavailable below */}}
  ok(res,{summary,note:'Ledger movement summary only; do not add Stars sale cash and Stars spending fees as if both were cash revenue.'});
}));

app.post('/v1/orders', requireAuth, asyncRoute(async(req,res)=>{const productId=clean(req.body?.productId,200);const product=await db.doc(`marketplace/${productId}`).get();if(!product.exists)return bad(res,404,'Product not found.');const pd=product.data()||{};if(pd.status&&pd.status!=='active')return bad(res,400,'Listing is not active.');const sellerUid=String(pd.uid||'');if(!sellerUid||sellerUid===req.user.uid)return bad(res,400,'Invalid seller.');const qty=Number(req.body?.quantity||1);if(!Number.isInteger(qty)||qty<1||qty>100)return bad(res,400,'Quantity must be 1–100.');const unitPrice=Number(pd.price||0);if(!Number.isFinite(unitPrice)||unitPrice<0)return bad(res,400,'Invalid product price.');const total=Math.round(unitPrice*qty*100)/100,paymentMethod=clean(req.body?.paymentMethod,100);if(!['Cash on Delivery','bKash','Nagad','Rocket'].includes(paymentMethod))return bad(res,400,'Unsupported payment method.');const transactionId=clean(req.body?.transactionId,300),paymentScreenshotUrl=clean(req.body?.paymentScreenshotUrl,2000);if(paymentMethod!=='Cash on Delivery'&&(!transactionId||!paymentScreenshotUrl))return bad(res,400,'Online payment requires TrxID and screenshot.');const ref=db.collection('orders').doc();await ref.create({productId,productTitle:clean(pd.title,300),sellerUid,buyerUid:req.user.uid,buyerName:clean(req.body?.buyerName,200),buyerPhone:clean(req.body?.buyerPhone,100),address:clean(req.body?.address,1000),quantity:qty,unitPrice,total,paymentMethod,transactionId,paymentScreenshotUrl,deliveryMethod:'seller_delivery',deliveryFee:Number(pd.deliveryFee||0),deliveryArea:clean(pd.deliveryArea||pd.location,300),eta:clean(pd.deliveryEta||'',100),paymentReceived:false,paymentStatus:paymentMethod==='Cash on Delivery'?'pay_on_delivery':'verification_pending',status:'pending',createdAt:now(),updatedAt:now()});ok(res,{id:ref.id,status:'pending',total,paymentReceived:false,deliveryMethod:'seller_delivery'})}));
app.post('/v1/help/messages', requireAuth, asyncRoute(async(req,res)=>{const ref=db.collection(`supportChats/${req.user.uid}/messages`).doc();await ref.set({uid:req.user.uid,text:clean(req.body?.text,5000),sender:'user',createdAt:now()});await db.doc(`supportChatsIndex/${req.user.uid}`).set({uid:req.user.uid,lastMessage:clean(req.body?.text,500),updatedAt:now(),unreadForAdmin:true},{merge:true});ok(res,{id:ref.id})}));

// Admin API
app.patch('/v1/admin/stars/purchases/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const status=clean(req.body?.status,20); if(!['approved','rejected'].includes(status)) return bad(res,400,'Invalid status.');
  const purchase=db.doc(`starPurchases/${req.params.id}`);
  await db.runTransaction(async tx=>{ const ps=await tx.get(purchase); if(!ps.exists) throw new Error('Purchase not found.'); const p=ps.data()||{}; if(p.status!=='pending') throw new Error('Purchase already reviewed.');
    if(status==='approved'){ const u=db.doc(`userProfiles/${p.uid}`); const us=await tx.get(u); const d=us.exists?us.data()||{}:{}; tx.set(u,{starsAvailable:Number(d.starsAvailable||0)+Number(p.stars||0),starsPurchased:Number(d.starsPurchased||0)+Number(p.stars||0),updatedAt:now()},{merge:true}); }
    if(status==='approved'){const ledger=db.collection('starLedger').doc();tx.set(ledger,{uid:p.uid,type:'stars_purchase',direction:'credit',stars:Number(p.stars||0),cashAmount:Number(p.amount||0),referenceId:purchase.id,rateSnapshot:p.rateSnapshot||{},createdAt:now()});}
    const audit=db.collection('auditLogs').doc();tx.set(audit,{action:'stars_purchase_review',targetId:purchase.id,targetUid:p.uid,status,actorUid:req.user.uid,createdAt:now()});
    tx.update(purchase,{status,reviewedBy:req.user.uid,reviewedAt:now()}); });
  ok(res,{updated:true,status});
}));
app.patch('/v1/admin/stars/withdrawals/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const status=clean(req.body?.status,20); if(!['approved','paid','rejected'].includes(status)) return bad(res,400,'Invalid status.');
  const wr=db.doc(`starWithdrawals/${req.params.id}`);
  await db.runTransaction(async tx=>{ const ws=await tx.get(wr); if(!ws.exists) throw new Error('Withdrawal not found.'); const w=ws.data()||{}; if(!['pending','approved'].includes(w.status)) throw new Error('Withdrawal already finalized.'); const u=db.doc(`userProfiles/${w.uid}`); const us=await tx.get(u); const d=us.exists?us.data()||{}:{};
    if(status==='rejected'){ tx.set(u,{starsAvailable:Number(d.starsAvailable||0)+Number(w.stars||0),pendingWithdrawalStars:Math.max(0,Number(d.pendingWithdrawalStars||0)-Number(w.stars||0)),updatedAt:now()},{merge:true}); }
    else if(status==='paid'){ tx.set(u,{pendingWithdrawalStars:Math.max(0,Number(d.pendingWithdrawalStars||0)-Number(w.stars||0)),updatedAt:now()},{merge:true}); }
    tx.update(wr,{status,reviewedBy:req.user.uid,reviewedAt:now()}); });
  ok(res,{updated:true,status});
}));

app.patch('/v1/admin/stars/gifts/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const status=clean(req.body?.status,20); if(!['approved','rejected'].includes(status)) return bad(res,400,'Invalid status.');
  const gift=db.doc(`starGifts/${req.params.id}`);
  await db.runTransaction(async tx=>{
    const gs=await tx.get(gift); if(!gs.exists) throw new Error('Gift not found.');
    const g=gs.data()||{}; if(g.status!=='pending') throw new Error('Gift already reviewed.');
    const sender=db.doc(`userProfiles/${g.senderUid}`); const receiver=db.doc(`userProfiles/${g.receiverUid}`);
    const ss=await tx.get(sender); const rs=await tx.get(receiver);
    const sd=ss.exists?ss.data()||{}:{}; const rd=rs.exists?rs.data()||{}:{};
    const stars=Number(g.stars||0);
    if(status==='approved'){
      tx.set(sender,{pendingSentStars:Math.max(0,Number(sd.pendingSentStars||0)-stars),updatedAt:now()},{merge:true});
      tx.set(receiver,{starsAvailable:Number(rd.starsAvailable||0)+stars,starsReceived:Number(rd.starsReceived||0)+stars,updatedAt:now()},{merge:true});
    } else {
      tx.set(sender,{starsAvailable:Number(sd.starsAvailable||0)+stars,pendingSentStars:Math.max(0,Number(sd.pendingSentStars||0)-stars),updatedAt:now()},{merge:true});
    }
    tx.update(gift,{status,reviewedBy:req.user.uid,reviewedAt:now()});
  });
  ok(res,{updated:true,status});
}));

app.patch('/v1/admin/referrals/:id/reward', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const referral=db.doc(`referrals/${req.params.id}`);
  const settings=await getBusinessSettings(); const REWARD=Math.max(0,Number(settings.referralRewardStars||20));
  await db.runTransaction(async tx=>{
    const rs=await tx.get(referral); if(!rs.exists) throw new Error('Referral not found.');
    const r=rs.data()||{}; if(r.rewardGranted===true) throw new Error('Referral reward already granted.');
    if(r.status==='rejected') throw new Error('Referral is rejected.');
    const referrer=db.doc(`userProfiles/${r.referrerUid}`); const referred=db.doc(`userProfiles/${r.referredUid}`);
    const a=await tx.get(referrer); const b=await tx.get(referred);
    const ad=a.exists?a.data()||{}:{}; const bd=b.exists?b.data()||{}:{};
    tx.set(referrer,{starsAvailable:Number(ad.starsAvailable||0)+REWARD,starsReferralRewards:Number(ad.starsReferralRewards||0)+REWARD,updatedAt:now()},{merge:true});
    tx.update(referral,{status:'rewarded',rewardGranted:true,rewardStars:REWARD,rewardedBy:req.user.uid,rewardedAt:now()});
    if(b.exists) tx.set(referred,{starsAvailable:Number(bd.starsAvailable||0)+REWARD,starsReferralRewardsReceived:Number(bd.starsReferralRewardsReceived||0)+REWARD,referralRewardReceived:true,updatedAt:now()},{merge:true});
    const ledgerA=db.collection('starLedger').doc(),ledgerB=db.collection('starLedger').doc();tx.set(ledgerA,{uid:r.referrerUid,type:'referral_reward',direction:'credit',stars:REWARD,referenceId:referral.id,createdAt:now()});tx.set(ledgerB,{uid:r.referredUid,type:'referral_reward',direction:'credit',stars:REWARD,referenceId:referral.id,createdAt:now()});
  });
  ok(res,{updated:true,rewardStarsPerEligibleUser:REWARD});
}));

app.get('/v1/admin/summary', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const names=['verificationRequests','boostRequests','reports','userProfiles','posts','monetizationApplications','liveSessions','blockedUsers','orders','premiumSubscriptions','creatorEarnings','withdrawalRequests'];
  const out={}; for(const n of names){try{const s=await db.collection(n).get();out[n]=s.size}catch{out[n]=null}}
  ok(res,{summary:out});
}));
app.get('/v1/admin/blocked-users', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const s=await db.collection('blockedUsers').where('blocked','==',true).get();ok(res,{users:s.docs.map(d=>({uid:d.id,...d.data()}))})}));
app.patch('/v1/admin/posts/:id/delete', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`posts/${req.params.id}`);await ref.update({deleted:true,trashed:true,archived:true,visibility:'private',deletedBy:req.user.uid,deletedAt:now()});ok(res,{deleted:true})}));
app.patch('/v1/admin/verification/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const status=clean(req.body?.status,30);if(!['approved','rejected'].includes(status))return bad(res,400,'Status must be approved or rejected.');
  const ref=db.doc(`verificationRequests/${req.params.id}`);
  await db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)throw new Error('Verification request not found.');const d=s.data()||{};if(d.status!=='pending')throw new Error('Verification request already reviewed.');
    const uid=d.uid||d.userId||req.params.id,profile=db.doc(`userProfiles/${uid}`),ps=await tx.get(profile),pd=ps.exists?ps.data()||{}:{};
    tx.update(ref,{status,reviewedBy:req.user.uid,reviewedAt:now(),reviewNote:clean(req.body?.note,1000)});
    tx.set(profile,{verified:status==='approved',updatedAt:now()},{merge:true});
    if(status==='rejected'){const refund=Math.max(0,Number(d.refundStars??d.rateSnapshot?.verificationRejectRefundStars??0));if(refund>0){tx.set(profile,{starsAvailable:Number(pd.starsAvailable||0)+refund,updatedAt:now()},{merge:true});const ledger=db.collection('starLedger').doc();tx.set(ledger,{uid,type:'verification_rejection_refund',direction:'credit',stars:refund,referenceId:ref.id,serviceFeeStars:Math.max(0,Number(d.feeStars||0)-refund),createdAt:now()});}}
    const audit=db.collection('auditLogs').doc();tx.set(audit,{action:'verification_review',targetId:ref.id,targetUid:uid,status,actorUid:req.user.uid,note:clean(req.body?.note,1000),createdAt:now()});
  });ok(res,{updated:true,status});
}));
app.patch('/v1/admin/boost/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const status=clean(req.body?.status,30);if(!['approved','rejected'].includes(status))return bad(res,400,'Status must be approved or rejected.');
  const ref=db.doc(`boostRequests/${req.params.id}`);
  await db.runTransaction(async tx=>{const s=await tx.get(ref);if(!s.exists)throw new Error('Boost request not found.');const d=s.data()||{};if(d.status!=='pending')throw new Error('Boost request already reviewed.');
    const postId=d.postId||'',uid=d.uid||'',profile=uid?db.doc(`userProfiles/${uid}`):null;
    const ps=(status==='rejected'&&profile)?await tx.get(profile):null,pd=ps?.exists?ps.data()||{}:{};
    if(postId&&d.kind!=='profile')tx.set(db.doc(`posts/${postId}`),{boosted:status==='approved',boostStatus:status,boostedBy:req.user.uid,boostedAt:now(),boostDurationHours:Number(d.durationHours||24)},{merge:true});
    if(d.kind==='profile'&&uid)tx.set(db.doc(`userProfiles/${uid}`),{profileBoosted:status==='approved',profileBoostStatus:status,profileBoostedBy:req.user.uid,profileBoostedAt:now(),profileBoostDurationHours:Number(d.durationHours||24)},{merge:true});
    tx.update(ref,{status,reviewedBy:req.user.uid,reviewedAt:now(),reviewNote:clean(req.body?.note,1000)});
    if(status==='rejected'&&uid){const refund=Math.max(0,Number(d.amountStars||0));tx.set(profile,{starsAvailable:Number(pd.starsAvailable||0)+refund,updatedAt:now()},{merge:true});const ledger=db.collection('starLedger').doc();tx.set(ledger,{uid,type:'boost_rejection_refund',direction:'credit',stars:refund,referenceId:ref.id,createdAt:now()});}
    const audit=db.collection('auditLogs').doc();tx.set(audit,{action:'boost_review',targetId:ref.id,targetUid:uid,status,actorUid:req.user.uid,note:clean(req.body?.note,1000),createdAt:now()});
  });ok(res,{updated:true,status});
}));

app.patch('/v1/admin/monetization/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`monetizationApplications/${req.params.id}`);const snap=await ref.get();if(!snap.exists)return bad(res,404,'Application not found.');const status=clean(req.body?.status,30);if(!['approved','rejected','pending'].includes(status))return bad(res,400,'Invalid status.');const d=snap.data()||{};const uid=d.uid||d.userId||'';await ref.update({status,reviewedBy:req.user.uid,reviewedAt:now()});if(uid){const prof=db.doc(`userProfiles/${uid}`);if(status==='approved')await prof.set({monetizationEnabled:true,monetizationStatus:'approved',monetizationApplicationId:ref.id,monetizationReviewedBy:req.user.uid,monetizationReviewedAt:now(),updatedAt:now()},{merge:true});else if(status==='rejected')await prof.set({monetizationStatus:'rejected',monetizationReviewedBy:req.user.uid,monetizationReviewedAt:now(),updatedAt:now()},{merge:true});}ok(res,{updated:true})}));
app.patch('/v1/admin/withdrawals/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`withdrawalRequests/${req.params.id}`);const status=clean(req.body?.status,30);if(!['approved','rejected','paid','pending'].includes(status))return bad(res,400,'Invalid status.');await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error('Withdrawal not found.');const d=snap.data()||{};if(d.status==='paid'||d.status==='rejected')throw new Error('Withdrawal already finalized.');const profile=db.doc(`userProfiles/${d.uid||''}`);const ps=await tx.get(profile);const pd=ps.exists?ps.data()||{}:{};if(status==='rejected'&&d.balanceField){const amount=Number(d.amount||0),field=d.balanceField,pendingField=d.walletType==='monetization_taka'?'pendingMonetizationTaka':'pendingWalletTaka';tx.set(profile,{[field]:Math.round((Number(pd[field]||0)+amount)*100)/100,[pendingField]:Math.max(0,Number(pd[pendingField]||0)-amount),updatedAt:now()},{merge:true});const ledger=db.collection(d.walletType==='monetization_taka'?'monetizationTakaLedger':'takaWalletLedger').doc();tx.set(ledger,{uid:d.uid,type:'withdrawal_rejection_refund',direction:'credit',amount,currency:'BDT',walletType:d.walletType,referenceId:ref.id,createdAt:now()});}tx.update(ref,{status,reviewedBy:req.user.uid,reviewedAt:now(),reviewNote:clean(req.body?.note,1000)});const audit=db.collection('auditLogs').doc();tx.create(audit,{action:'taka_withdrawal_review',targetId:ref.id,targetUid:d.uid||'',status,actorUid:req.user.uid,note:clean(req.body?.note,1000),createdAt:now()});});ok(res,{updated:true,status})}));
app.patch('/v1/admin/monetization-payouts/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`monetizationPayoutRequests/${req.params.id}`);const status=clean(req.body?.status,30);if(!['approved','rejected','paid','pending'].includes(status))return bad(res,400,'Invalid status.');await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error('Monetization payout not found.');const d=snap.data()||{};if(d.status==='paid'||d.status==='rejected')throw new Error('Withdrawal already finalized.');const profile=db.doc(`userProfiles/${d.uid||''}`);const ps=await tx.get(profile);const pd=ps.exists?ps.data()||{}:{};if(status==='rejected'&&d.balanceField){const amount=Number(d.amount||0),field=d.balanceField;tx.set(profile,{[field]:Math.round((Number(pd[field]||0)+amount)*100)/100,pendingMonetizationTaka:Math.max(0,Number(pd.pendingMonetizationTaka||0)-amount),updatedAt:now()},{merge:true});const ledger=db.collection('monetizationTakaLedger').doc();tx.set(ledger,{uid:d.uid,type:'withdrawal_rejection_refund',direction:'credit',amount,currency:'BDT',walletType:'monetization_taka',referenceId:ref.id,createdAt:now()});}tx.update(ref,{status,reviewedBy:req.user.uid,reviewedAt:now(),reviewNote:clean(req.body?.note,1000)});const audit=db.collection('auditLogs').doc();tx.create(audit,{action:'monetization_payout_review',targetId:ref.id,targetUid:d.uid||'',status,actorUid:req.user.uid,note:clean(req.body?.note,1000),createdAt:now()});});ok(res,{updated:true,status})}));
app.patch('/v1/admin/orders/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`orders/${req.params.id}`),status=clean(req.body?.status,30),note=clean(req.body?.note,1000);if(!['pending','confirmed','rejected','shipped','delivered','cancelled'].includes(status))return bad(res,400,'Invalid order status.');const audit=db.collection('auditLogs').doc();await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error('Order not found.');const d=snap.data()||{};if(['delivered','cancelled','rejected'].includes(d.status)&&d.status!==status)throw new Error('Order already finalized.');tx.update(ref,{status,reviewedBy:req.user.uid,reviewedAt:now(),reviewNote:note,updatedAt:now(),paymentReceived:d.paymentMethod==='Cash on Delivery'?false:d.paymentReceived===true});tx.create(audit,{action:'marketplace_order_status',targetId:ref.id,targetUid:d.buyerUid||'',actorUid:req.user.uid,status,note,paymentReceived:d.paymentMethod==='Cash on Delivery'?false:d.paymentReceived===true,createdAt:now()});});ok(res,{updated:true,status,paymentReceived:false})}));
app.patch('/v1/admin/orders/:id/payment', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`orders/${req.params.id}`),received=req.body?.paymentReceived===true;if(!received)return bad(res,400,'Use this endpoint only to confirm a verified payment.');const audit=db.collection('auditLogs').doc();await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw new Error('Order not found.');const d=snap.data()||{};if(d.paymentMethod==='Cash on Delivery'&&d.status!=='delivered')throw new Error('COD payment can only be confirmed after delivery.');if(d.paymentReceived===true)throw new Error('Payment already confirmed.');tx.update(ref,{paymentReceived:true,paymentStatus:'paid',paymentVerifiedBy:req.user.uid,paymentVerifiedAt:now(),updatedAt:now()});tx.create(audit,{action:'marketplace_payment_confirmed',targetId:ref.id,targetUid:d.buyerUid||'',actorUid:req.user.uid,amount:d.total||0,createdAt:now()});});ok(res,{paymentReceived:true})}));

app.use((req,res)=>bad(res,404,'FFBDWorld API route not found'));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);const message=String(err?.message||'');if(Number.isInteger(err?.statusCode)&&err.statusCode>=400&&err.statusCode<500)return bad(res,err.statusCode,message);if(/Not enough Stars|already reviewed|already been submitted|already pending|already recorded|Referral is rejected|Withdrawal already finalized|Gift already reviewed|Boost request already reviewed|Verification request already reviewed/i.test(message))return bad(res,409,message);if(/not found/i.test(message))return bad(res,404,message);if(/Invalid|must be|Unsupported|required|cannot exceed/i.test(message))return bad(res,400,message);return bad(res,500,'Server error');});

app.listen(PORT, '0.0.0.0', ()=>console.log(`FFBDWorld API listening on 0.0.0.0:${PORT}`));
