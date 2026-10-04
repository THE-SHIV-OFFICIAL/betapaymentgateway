# BETA BOT HUB – UPI Payment Gateway

## Data storage: MongoDB (no more data loss)

All users, payments, payouts and logins are saved in **MongoDB**, so nothing is lost on
restart, redeploy, or when you move to a different Railway account. No Railway volume is needed.

**Recommended (works with any Railway account): free MongoDB Atlas**
1. Create a free cluster at https://www.mongodb.com/atlas
2. Database Access → add a user + password. Network Access → allow `0.0.0.0/0`.
3. Connect → Drivers → copy the `mongodb+srv://...` string (put your password in it).
4. In Railway → your service → Variables → add `MONGODB_URI` = that string.
5. Redeploy. Logs should show `MongoDB connected`.

Changing Railway account later? Just add the same `MONGODB_URI` in the new account – all data is still there.

(Alternative: Railway's own MongoDB plugin – set `MONGODB_URI=${{MongoDB.MONGO_URL}}`. That data stays
inside that Railway account, so Atlas is better if you switch accounts.)

If an old `data/db.json` exists and MongoDB is empty, it is imported automatically on first start.

## Monthly history cleanup (email first, then delete)

- Every `CLEANUP_EVERY_DAYS` (default 30) the server takes all orders and payouts older than
  `HISTORY_RETENTION_DAYS` (default 30).
- It emails **each user** their own old history as CSV files (from your `GMAIL_USER` Gmail),
  and emails **you** a full backup of everything.
- Only after the email is sent are those records deleted. If a user's email fails, their records
  are kept and included next time. If your backup email fails, nothing is deleted.
- **User accounts are never deleted.** Total balance, earnings, volume and withdrawn amounts stay
  exactly the same (old totals are carried forward). Pending orders/payouts are never removed.
- Owner panel (`/admin`) has an **"Email & clean old history"** button to run it now.


Built by **THE SHIV** · Support: [@betabot_support](https://t.me/betabot_support) · Updates: [@betabot_hub](https://t.me/betabot_hub) · Owner: [@sukoon_s](https://t.me/sukoon_s)

## How it works
1. A user signs up on `/dashboard` with **only email + password** (no Gmail app password needed).
2. They get an API key and create payments from their website/bot.
3. Customer pays to the owner's FamPay UPI ID. Each order has a unique amount (a few paise added) + order ID in the note.
4. Server reads the owner's Gmail every ~20 s, finds the FamPay alert, marks the order **PAID**.
5. The user gets an email (sent from the owner's Gmail) with amount, order and earning; customer gets a receipt; optional Telegram alert + webhook.
6. 4% commission is kept; the rest is the user's balance. Users request withdrawals, owner pays them via UPI and clicks "Mark paid" in `/admin`.

## Run
```bash
npm install
npm start        # http://localhost:4000
```
Settings are in `.env` (see `.env.example`). Data is saved in `data/db.json` – keep this folder when redeploying (Docker volume / Railway volume).

Pages: `/` home · `/dashboard` users · `/pay?id=ORDER` checkout · `/admin` owner panel.

## API
```
POST /api/v1/payments/create      Authorization: Bearer API_KEY
     { "amount": 99, "customerEmail": "buyer@gmail.com", "note": "Premium" }
GET  /api/v1/payments/:orderId    Authorization: Bearer API_KEY
```
Webhook (optional, set in Settings): `POST { event: "payment.paid", order }` with header `X-BBH-Signature = HMAC_SHA256(apiKey, orderId)`.

## Notes
- Gmail must have IMAP enabled (Gmail → Settings → Forwarding and POP/IMAP).
- FamPay must send payment-received emails to the owner Gmail.
- Telegram alerts: create a bot with @BotFather, add it as admin to your channel, put the token in `TELEGRAM_BOT_TOKEN`.
