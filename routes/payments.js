// routes/payments.js — /api/dues/*, /api/fees/*, /api/wallet/, /api/applications/:id/additional-charges
const { Router } = require('express');
const { ObjectId } = require('mongodb');
const SSLCommerzPayment = require('sslcommerz-lts');
const { authenticateAdmin } = require('../middleware/auth');
const { collections } = require('../config/db');
const { upload } = require('../middleware/upload');

const STORE_ID = process.env.STORE_ID || 'testbox';
const STORE_PASSWD = process.env.STORE_PASSWD || 'testpass';
const IS_LIVE = process.env.IS_LIVE === 'true';

function calculatePlatformFee(laborAmount) {
  if (!laborAmount || laborAmount <= 0) return { fee: 0, tier: 'A' };
  let rate = 0.10;
  let cap = 15;
  let tier = 'A';
  if (laborAmount > 300 && laborAmount <= 800) { rate = 0.08; cap = 50; tier = 'B'; }
  else if (laborAmount > 800) { rate = 0.07; cap = 200; tier = 'C'; }
  return { fee: Math.max(0, Math.round(Math.min(laborAmount * rate, cap))), tier };
}

async function processJobSettlement(applicationId) {
  try {
    const app = await collections.applications.findOne({ _id: new ObjectId(applicationId) });
    if (!app || app.settlementStatus !== 'PENDING') return;
    const laborAmount = Number(app.finalPrice || app.proposedPrice) || 0;
    const { fee: platformFee, tier } = calculatePlatformFee(laborAmount);
    const approvedCharges = await collections.additionalCharges.find({ applicationId: new ObjectId(applicationId), status: 'APPROVED' }).toArray();
    const approvedExtrasAmount = approvedCharges.filter(c => c.type === 'EXTRA_COST').reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
    await collections.applications.updateOne(
      { _id: new ObjectId(applicationId) },
      { $set: { laborAmount, approvedExtrasAmount, platformFee, feeTier: tier, settlementStatus: 'SETTLED' } }
    );
    if (platformFee > 0 && app.workerId) {
      await collections.ledgers.insertOne({ transactionId: new ObjectId().toString(), workerId: String(app.workerId), orderId: new ObjectId(applicationId), type: 'platform_fee_debit', amount: platformFee, direction: 'DEBIT', createdAt: new Date() });
      await collections.users.updateOne({ uid: String(app.workerId) }, { $inc: { dueBalance: platformFee } });
      const worker = await collections.users.findOne({ uid: String(app.workerId) });
      if (worker && worker.dueBalance >= 200 && !worker.dueWarningNotifiedAt) {
        await collections.users.updateOne({ uid: String(app.workerId) }, { $set: { dueWarningNotifiedAt: new Date() } });
      }
    }
  } catch (err) {
    console.error('Error processing job settlement:', err);
  }
}

const router = Router();

// ---- Fee Calculator ----
router.post('/fees/calculate', (req, res) => {
  try { res.json(calculatePlatformFee(Number(req.body.laborAmount) || 0)); }
  catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ---- Additional Charges ----
router.post('/applications/:id/additional-charges', upload.array('receipts', 5), async (req, res) => {
  try {
    const { id } = req.params;
    const { workerId, amount, type, description } = req.body;
    const files = req.files || [];
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const receiptUrls = files.map(f => `/uploads/${f.filename}`);
    if (type === 'EXTRA_COST' && receiptUrls.length === 0) return res.status(400).json({ error: 'Receipts are mandatory for EXTRA_COST' });
    const charge = { applicationId: new ObjectId(id), workerId: String(workerId), amount: Number(amount) || 0, type: String(type || 'TIP'), description: String(description || ''), receiptUrls, status: 'PENDING', createdAt: new Date() };
    const result = await collections.additionalCharges.insertOne(charge);
    res.status(201).json({ _id: result.insertedId, ...charge });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});
router.post('/applications/:id/additional-charges/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { chargeId, status } = req.body;
    if (!ObjectId.isValid(id) || !ObjectId.isValid(chargeId)) return res.status(400).json({ error: 'Invalid ids' });
    const validStatus = ['APPROVED', 'REJECTED'].includes(status) ? status : 'REJECTED';
    const result = await collections.additionalCharges.updateOne({ _id: new ObjectId(chargeId), applicationId: new ObjectId(id) }, { $set: { status: validStatus, updatedAt: new Date() } });
    if (result.matchedCount === 0) return res.status(404).json({ error: 'Charge not found' });
    res.json({ ok: true, status: validStatus });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/applications/:id/additional-charges', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid id' });
    const list = await collections.additionalCharges.find({ applicationId: new ObjectId(id) }).toArray();
    res.json(list);
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ---- Manual Due Payment ----
router.post('/dues/pay', async (req, res) => {
  try {
    const { workerId, amount, gateway, transactionId } = req.body;
    if (!workerId || !amount || !transactionId) return res.status(400).json({ error: 'Missing fields' });
    const doc = { workerId: String(workerId), amount: Number(amount), gateway: String(gateway || 'manual'), transactionId: String(transactionId), status: 'PENDING_VERIFICATION', isDuePayment: true, createdAt: new Date() };
    const result = await collections.paymentRequests.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ---- SSLCommerz ----
router.post('/dues/ssl-init', async (req, res) => {
  try {
    const { workerId, amount, redirectUrl } = req.body;
    if (!workerId || !amount) return res.status(400).json({ error: 'Worker ID and amount required' });
    const tran_id = new ObjectId().toString();
    const doc = { _id: new ObjectId(tran_id), workerId: String(workerId), amount: Number(amount), gateway: 'sslcommerz', transactionId: tran_id, status: 'PENDING_GATEWAY', isDuePayment: true, frontendUrl: redirectUrl || 'http://localhost:5173', createdAt: new Date() };
    await collections.paymentRequests.insertOne(doc);
    const init_url = `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/dues`;
    const data = { total_amount: amount, currency: 'BDT', tran_id, success_url: `${init_url}/ssl-success?tran_id=${tran_id}`, fail_url: `${init_url}/ssl-fail?tran_id=${tran_id}`, cancel_url: `${init_url}/ssl-cancel?tran_id=${tran_id}`, ipn_url: `${init_url}/ssl-ipn`, shipping_method: 'No', product_name: 'Platform Dues', product_category: 'Service', product_profile: 'general', cus_name: 'HireMistri Worker', cus_email: 'worker@hiremistri.com', cus_add1: 'Dhaka', cus_add2: 'Dhaka', cus_city: 'Dhaka', cus_state: 'Dhaka', cus_postcode: '1000', cus_country: 'Bangladesh', cus_phone: '01700000000', cus_fax: '01700000000', ship_name: 'HireMistri', ship_add1: 'Dhaka', ship_add2: 'Dhaka', ship_city: 'Dhaka', ship_state: 'Dhaka', ship_postcode: 1000, ship_country: 'Bangladesh' };
    const sslcz = new SSLCommerzPayment(STORE_ID, STORE_PASSWD, IS_LIVE);
    const apiResponse = await sslcz.init(data);
    if (apiResponse?.GatewayPageURL) res.json({ url: apiResponse.GatewayPageURL });
    else res.status(400).json({ error: 'Failed to initialize SSLCommerz session' });
  } catch (err) { console.error('SSL init error:', err); res.status(500).json({ error: 'Server error' }); }
});
router.post('/dues/ssl-success', async (req, res) => {
  try {
    const { tran_id } = req.query;
    const payment = await collections.paymentRequests.findOne({ _id: new ObjectId(tran_id) });
    if (!payment || payment.status !== 'PENDING_GATEWAY') return res.redirect(`${payment?.frontendUrl || 'http://localhost:5173'}/payment-status?status=fail`);
    await collections.paymentRequests.updateOne({ _id: new ObjectId(tran_id) }, { $set: { status: 'VERIFIED', updatedAt: new Date() } });
    const updatedWorker = await collections.users.findOneAndUpdate({ uid: String(payment.workerId) }, { $inc: { dueBalance: -payment.amount } }, { returnDocument: 'after' });
    const newBalance = updatedWorker?.dueBalance ?? 0;
    if (newBalance < 200) await collections.users.updateOne({ uid: String(payment.workerId) }, { $set: { isApplyBlocked: false, blockReason: null }, $unset: { dueWarningNotifiedAt: '' } });
    await collections.ledgers.insertOne({ workerId: String(payment.workerId), type: 'DUE_PAYMENT_CREDIT', direction: 'CREDIT', amount: payment.amount, transactionId: payment.transactionId, createdAt: new Date() });
    res.redirect(`${payment.frontendUrl}/payment-status?status=success&amount=${payment.amount}`);
  } catch (err) { console.error('SSL success error:', err); res.redirect('http://localhost:5173/payment-status?status=fail'); }
});
router.post('/dues/ssl-fail', async (req, res) => {
  try {
    const { tran_id } = req.query;
    const payment = await collections.paymentRequests.findOneAndUpdate({ _id: new ObjectId(tran_id) }, { $set: { status: 'FAILED' } }, { returnDocument: 'before' });
    res.redirect(`${payment?.frontendUrl || 'http://localhost:5173'}/payment-status?status=fail`);
  } catch (err) { res.redirect('http://localhost:5173/payment-status?status=fail'); }
});
router.post('/dues/ssl-cancel', async (req, res) => {
  try {
    const { tran_id } = req.query;
    const payment = await collections.paymentRequests.findOneAndUpdate({ _id: new ObjectId(tran_id) }, { $set: { status: 'CANCELLED' } }, { returnDocument: 'before' });
    res.redirect(`${payment?.frontendUrl || 'http://localhost:5173'}/payment-status?status=cancel`);
  } catch (err) { res.redirect('http://localhost:5173/payment-status?status=cancel'); }
});
router.post('/dues/ssl-ipn', async (req, res) => res.status(200).send('IPN Received'));
router.post('/dues/verify', authenticateAdmin, async (req, res) => {
  try {
    const { paymentRequestId, workerId, amount } = req.body;
    if (!ObjectId.isValid(paymentRequestId)) return res.status(400).json({ error: 'Invalid id' });
    await collections.paymentRequests.updateOne({ _id: new ObjectId(paymentRequestId) }, { $set: { status: 'APPROVED', updatedAt: new Date() } });
    await collections.ledgers.insertOne({ transactionId: new ObjectId().toString(), workerId: String(workerId), orderId: null, type: 'due_payment_credit', amount: Number(amount), direction: 'CREDIT', createdAt: new Date() });
    const workerUpdate = await collections.users.findOneAndUpdate({ uid: String(workerId) }, { $inc: { dueBalance: -Number(amount) } }, { returnDocument: 'after' });
    if (workerUpdate && workerUpdate.dueBalance < 200) await collections.users.updateOne({ uid: String(workerId) }, { $set: { isApplyBlocked: false, blockReason: null }, $unset: { dueWarningNotifiedAt: '' } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

// ---- Wallet Ledger ----
router.get('/wallet/ledger/:uid', async (req, res) => {
  try {
    const uid = String(req.params.uid);
    const list = await collections.ledgers.find({ workerId: uid }).sort({ createdAt: -1 }).toArray();
    const worker = await collections.users.findOne({ uid });
    res.json({ ledgers: list, dueBalance: worker ? (worker.dueBalance || 0) : 0, isApplyBlocked: worker ? !!worker.isApplyBlocked : false });
  } catch (err) { res.status(500).json({ error: 'Failed' }); }
});

module.exports = { router, processJobSettlement, calculatePlatformFee };
