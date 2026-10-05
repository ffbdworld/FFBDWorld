require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const PORT = Number(process.env.PORT || 8080);
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

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));

const origins = String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || origins.length === 0 || origins.includes('*') || origins.includes(origin)) return cb(null, true);
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

// Groups / Events
app.post('/v1/groups', requireAuth, asyncRoute(async(req,res)=>{const ref=db.collection('groups').doc();await ref.set({name:clean(req.body?.name,200),description:clean(req.body?.description,2000),ownerUid:req.user.uid,members:[req.user.uid],createdAt:now()});ok(res,{id:ref.id})}));
app.post('/v1/events', requireAuth, asyncRoute(async(req,res)=>{const ref=db.collection('events').doc();await ref.set({title:clean(req.body?.title,200),description:clean(req.body?.description,3000),location:clean(req.body?.location,500),startAt:req.body?.startAt||null,ownerUid:req.user.uid,createdAt:now()});ok(res,{id:ref.id})}));

// Verification / Boost / Monetization
app.post('/v1/verification-requests', requireAuth, asyncRoute(async(req,res)=>{const ref=db.collection('verificationRequests').doc(req.user.uid);await ref.set({uid:req.user.uid,name:clean(req.body?.name,200),username:clean(req.body?.username,100),email:clean(req.body?.email,200),phone:clean(req.body?.phone,100),type:clean(req.body?.type||'profile',50),status:'pending',createdAt:now(),updatedAt:now()},{merge:true});ok(res,{id:ref.id,status:'pending'})}));
app.post('/v1/boost-requests', requireAuth, asyncRoute(async(req,res)=>{const postId=clean(req.body?.postId,200);const post=await db.doc(`posts/${postId}`).get();if(!post.exists||post.data()?.uid!==req.user.uid)return bad(res,403,'Only your own post can be boosted.');const ref=db.collection('boostRequests').doc();await ref.set({uid:req.user.uid,postId,amount:Number(req.body?.amount||0),durationHours:Number(req.body?.durationHours||24),paymentMethod:clean(req.body?.paymentMethod,50),transactionId:clean(req.body?.transactionId||req.body?.paymentReference,300),paymentScreenshotUrl:clean(req.body?.paymentScreenshotUrl,2000),status:'pending',createdAt:now()});ok(res,{id:ref.id,status:'pending'})}));
app.post('/v1/monetization-applications', requireAuth, asyncRoute(async(req,res)=>{const ref=db.collection('monetizationApplications').doc();await ref.set({uid:req.user.uid,name:clean(req.body?.name,200),username:clean(req.body?.username,100),email:clean(req.body?.email,200),followers:Number(req.body?.followers||0),contentCategory:clean(req.body?.contentCategory,100),categoryLabel:clean(req.body?.categoryLabel,200),watchHours:Number(req.body?.watchHours||0),watchSeconds:Number(req.body?.watchSeconds||0),views:Number(req.body?.views||0),metrics:req.body?.metrics||{},status:'pending',monetizationType:'content',createdAt:now()});ok(res,{id:ref.id,status:'pending'})}));

// Stars / referral / shop / help
const STAR_UNIT = 120;
const STAR_TAKA = 100;
const validStars = n => Number.isInteger(n) && n >= STAR_UNIT && n % STAR_UNIT === 0;

app.post('/v1/stars/purchase-requests', requireAuth, asyncRoute(async(req,res)=>{
  const stars=Math.floor(Number(req.body?.stars||0)); const amount=Number(req.body?.amount||0);
  if(!validStars(stars)) return bad(res,400,`Stars must be a multiple of ${STAR_UNIT}.`);
  const expected=stars*STAR_TAKA/STAR_UNIT; if(Math.abs(amount-expected)>0.01) return bad(res,400,'Invalid Stars price.');
  const paymentReference=clean(req.body?.paymentReference||req.body?.transactionId,300); if(!paymentReference) return bad(res,400,'Payment reference required.');
  const ref=db.collection('starPurchases').doc();
  await ref.set({uid:req.user.uid,stars,amount:expected,status:'pending',paymentMethod:clean(req.body?.paymentMethod,50),paymentReference,createdAt:now()});
  ok(res,{id:ref.id,status:'pending'});
}));

app.post('/v1/stars/withdrawal-requests', requireAuth, asyncRoute(async(req,res)=>{
  const stars=Math.floor(Number(req.body?.stars||0)); if(!validStars(stars)) return bad(res,400,`Withdrawal must be a multiple of ${STAR_UNIT}.`);
  const number=clean(req.body?.number,100); if(!number) return bad(res,400,'Payout number required.');
  const ref=db.collection(`userProfiles/${req.user.uid}`); const out=db.collection('starWithdrawals').doc();
  await db.runTransaction(async tx=>{ const s=await tx.get(ref); const d=s.exists?s.data()||{}:{}; const bal=Number(d.starsAvailable||0); if(bal<stars) throw new Error('Not enough Stars.'); tx.set(ref,{starsAvailable:bal-stars,pendingWithdrawalStars:Number(d.pendingWithdrawalStars||0)+stars,updatedAt:now()},{merge:true}); tx.set(out,{uid:req.user.uid,stars,amount:stars*STAR_TAKA/STAR_UNIT,method:clean(req.body?.method,50),number,status:'pending',createdAt:now()}); });
  ok(res,{id:out.id,status:'pending'});
}));

app.post('/v1/stars/gifts', requireAuth, asyncRoute(async(req,res)=>{
  const receiverUid=clean(req.body?.receiverUid,200); const stars=Math.floor(Number(req.body?.stars||0));
  if(!receiverUid || receiverUid===req.user.uid) return bad(res,400,'Invalid receiver.'); if(!validStars(stars)) return bad(res,400,`Gift must be a multiple of ${STAR_UNIT}.`);
  const sender=db.doc(`userProfiles/${req.user.uid}`), gift=db.collection('starGifts').doc();
  await db.runTransaction(async tx=>{ const s=await tx.get(sender); const d=s.exists?s.data()||{}:{}; const bal=Number(d.starsAvailable||0); if(bal<stars) throw new Error('Not enough Stars.'); tx.set(sender,{starsAvailable:bal-stars,pendingSentStars:Number(d.pendingSentStars||0)+stars,updatedAt:now()},{merge:true}); tx.set(gift,{senderUid:req.user.uid,receiverUid,stars,status:'pending',contextType:clean(req.body?.contextType,50),contextId:clean(req.body?.contextId,200),createdAt:now()}); });
  ok(res,{id:gift.id,status:'pending'});
}));
app.post('/v1/referrals', requireAuth, asyncRoute(async(req,res)=>{
  const referrerUid=clean(req.body?.referrerUid,200);
  if(!referrerUid || referrerUid===req.user.uid) return bad(res,400,'Invalid referral owner.');
  const existing=await db.collection('referrals').where('referredUid','==',req.user.uid).limit(1).get();
  if(!existing.empty) return bad(res,409,'Referral already recorded for this account.');
  const ref=db.collection('referrals').doc();
  await ref.set({referrerUid,referredUid:req.user.uid,status:'pending',rewardGranted:false,createdAt:now()});
  ok(res,{id:ref.id,status:'pending'});
}));
app.post('/v1/orders', requireAuth, asyncRoute(async(req,res)=>{const productId=clean(req.body?.productId,200);const product=await db.doc(`marketplace/${productId}`).get();if(!product.exists)return bad(res,404,'Product not found.');const pd=product.data()||{};const sellerUid=String(pd.uid||'');if(!sellerUid||sellerUid===req.user.uid)return bad(res,400,'Invalid seller.');const qty=Math.max(1,Math.min(100,Number(req.body?.quantity||1)));const unitPrice=Number(pd.price||0);if(!Number.isFinite(unitPrice)||unitPrice<0)return bad(res,400,'Invalid product price.');const total=unitPrice*qty;const ref=db.collection('orders').doc();await ref.set({productId,productTitle:clean(pd.title,300),sellerUid,buyerUid:req.user.uid,buyerName:clean(req.body?.buyerName,200),buyerPhone:clean(req.body?.buyerPhone,100),address:clean(req.body?.address,1000),quantity:qty,unitPrice,total,paymentMethod:clean(req.body?.paymentMethod,100),transactionId:clean(req.body?.transactionId,300),paymentScreenshotUrl:clean(req.body?.paymentScreenshotUrl,2000),status:'pending',createdAt:now()});ok(res,{id:ref.id,status:'pending',total})}));
app.post('/v1/help/messages', requireAuth, asyncRoute(async(req,res)=>{const ref=db.collection(`supportChats/${req.user.uid}/messages`).doc();await ref.set({uid:req.user.uid,text:clean(req.body?.text,5000),sender:'user',createdAt:now()});await db.doc(`supportChatsIndex/${req.user.uid}`).set({uid:req.user.uid,lastMessage:clean(req.body?.text,500),updatedAt:now(),unreadForAdmin:true},{merge:true});ok(res,{id:ref.id})}));

// Admin API
app.patch('/v1/admin/stars/purchases/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const status=clean(req.body?.status,20); if(!['approved','rejected'].includes(status)) return bad(res,400,'Invalid status.');
  const purchase=db.doc(`starPurchases/${req.params.id}`);
  await db.runTransaction(async tx=>{ const ps=await tx.get(purchase); if(!ps.exists) throw new Error('Purchase not found.'); const p=ps.data()||{}; if(p.status!=='pending') throw new Error('Purchase already reviewed.');
    if(status==='approved'){ const u=db.doc(`userProfiles/${p.uid}`); const us=await tx.get(u); const d=us.exists?us.data()||{}:{}; tx.set(u,{starsAvailable:Number(d.starsAvailable||0)+Number(p.stars||0),starsPurchased:Number(d.starsPurchased||0)+Number(p.stars||0),updatedAt:now()},{merge:true}); }
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
  const REWARD=50;
  await db.runTransaction(async tx=>{
    const rs=await tx.get(referral); if(!rs.exists) throw new Error('Referral not found.');
    const r=rs.data()||{}; if(r.rewardGranted===true) throw new Error('Referral reward already granted.');
    if(r.status==='rejected') throw new Error('Referral is rejected.');
    const referrer=db.doc(`userProfiles/${r.referrerUid}`); const referred=db.doc(`userProfiles/${r.referredUid}`);
    const a=await tx.get(referrer); const b=await tx.get(referred);
    const ad=a.exists?a.data()||{}:{}; const bd=b.exists?b.data()||{}:{};
    tx.set(referrer,{starsAvailable:Number(ad.starsAvailable||0)+REWARD,starsReferralRewards:Number(ad.starsReferralRewards||0)+REWARD,updatedAt:now()},{merge:true});
    tx.update(referral,{status:'rewarded',rewardGranted:true,rewardStars:REWARD,rewardedBy:req.user.uid,rewardedAt:now()});
    if(b.exists) tx.set(referred,{referralRewardReceived:true,updatedAt:now()},{merge:true});
  });
  ok(res,{updated:true,rewardStars:REWARD});
}));

app.get('/v1/admin/summary', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{
  const names=['verificationRequests','boostRequests','reports','userProfiles','posts','monetizationApplications','liveSessions','blockedUsers','orders','premiumSubscriptions','creatorEarnings','withdrawalRequests'];
  const out={}; for(const n of names){try{const s=await db.collection(n).get();out[n]=s.size}catch{out[n]=null}}
  ok(res,{summary:out});
}));
app.get('/v1/admin/blocked-users', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const s=await db.collection('blockedUsers').where('blocked','==',true).get();ok(res,{users:s.docs.map(d=>({uid:d.id,...d.data()}))})}));
app.patch('/v1/admin/posts/:id/delete', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`posts/${req.params.id}`);await ref.update({deleted:true,trashed:true,archived:true,visibility:'private',deletedBy:req.user.uid,deletedAt:now()});ok(res,{deleted:true})}));
app.patch('/v1/admin/verification/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`verificationRequests/${req.params.id}`);const s=await ref.get();const status=clean(req.body?.status,30);await ref.update({status,reviewedBy:req.user.uid,reviewedAt:now(),reviewNote:clean(req.body?.note,1000)});const uid=s.exists?(s.data()?.uid||s.data()?.userId||''):'';if(uid)await db.doc(`userProfiles/${uid}`).set({verified:status==='approved',updatedAt:now()},{merge:true});ok(res,{updated:true})}));
app.patch('/v1/admin/boost/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`boostRequests/${req.params.id}`);const s=await ref.get();const status=clean(req.body?.status,30);await ref.update({status,reviewedBy:req.user.uid,reviewedAt:now(),reviewNote:clean(req.body?.note,1000)});const postId=s.exists?(s.data()?.postId||''):'';if(postId)await db.doc(`posts/${postId}`).set({boosted:status==='approved',boostStatus:status,boostedBy:req.user.uid,boostedAt:now()},{merge:true});ok(res,{updated:true})}));

app.patch('/v1/admin/monetization/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`monetizationApplications/${req.params.id}`);const snap=await ref.get();if(!snap.exists)return bad(res,404,'Application not found.');const status=clean(req.body?.status,30);if(!['approved','rejected','pending'].includes(status))return bad(res,400,'Invalid status.');const d=snap.data()||{};const uid=d.uid||d.userId||'';await ref.update({status,reviewedBy:req.user.uid,reviewedAt:now()});if(uid){const prof=db.doc(`userProfiles/${uid}`);if(status==='approved')await prof.set({monetizationEnabled:true,monetizationStatus:'approved',monetizationApplicationId:ref.id,monetizationReviewedBy:req.user.uid,monetizationReviewedAt:now(),updatedAt:now()},{merge:true});else if(status==='rejected')await prof.set({monetizationStatus:'rejected',monetizationReviewedBy:req.user.uid,monetizationReviewedAt:now(),updatedAt:now()},{merge:true});}ok(res,{updated:true})}));
app.patch('/v1/admin/withdrawals/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`withdrawalRequests/${req.params.id}`);const snap=await ref.get();if(!snap.exists)return bad(res,404,'Withdrawal not found.');const status=clean(req.body?.status,30);if(!['approved','rejected','paid','pending'].includes(status))return bad(res,400,'Invalid status.');await ref.update({status,reviewedBy:req.user.uid,reviewedAt:now(),reviewNote:clean(req.body?.note,1000)});ok(res,{updated:true})}));
app.patch('/v1/admin/orders/:id', requireAuth, requireAdmin, asyncRoute(async(req,res)=>{const ref=db.doc(`orders/${req.params.id}`);const snap=await ref.get();if(!snap.exists)return bad(res,404,'Order not found.');const status=clean(req.body?.status,30);if(!['pending','approved','rejected','shipped','delivered','cancelled'].includes(status))return bad(res,400,'Invalid status.');await ref.update({status,reviewedBy:req.user.uid,reviewedAt:now()});ok(res,{updated:true})}));

app.use((req,res)=>bad(res,404,'FFBDWorld API route not found'));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);return bad(res,500,'Server error');});

app.listen(PORT,()=>console.log(`FFBDWorld API listening on port ${PORT}`));
