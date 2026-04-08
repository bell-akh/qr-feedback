# QR OTP Code App

Single QR -> opens a web form -> user enters phone/name -> OTP verification -> stable 5-character code generated and stored in SQLite.

## What this does

- Uses one static QR that points to your website URL (`APP_URL`).
- Asks for phone number and optional name.
- Sends OTP via Twilio Verify (or console mode for local testing).
- Verifies OTP.
- Generates a deterministic 5-character alphanumeric code based on phone number.
- Stores `{ phone, name, code }` in DB (`data.sqlite`), one record per phone.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
copy .env.example .env
```

3. Start server:

```bash
npm start
```

Open: `http://localhost:3000`

## Generate QR

```bash
npm run generate:qr
```

Output image: `assets/qr.png`

## OTP provider notes

- Recommended default: `OTP_PROVIDER=twilio` for real-time SMS OTP.
- Required Twilio env values:
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_VERIFY_SERVICE_SID`
- If you want local test mode without SMS charges, set `OTP_PROVIDER=console`.
- In Twilio mode, OTP creation/validation is fully handled by Twilio Verify API.

## Firebase storage (optional)

After OTP verification, the app can also save member data to Firebase Firestore in
the `member_codes` collection using phone number as document ID.

Required env values:

- `FIREBASE_PROJECT_ID` (set to your Firebase project id, e.g. `belle-noor-abb8f`)
- `FIREBASE_CLIENT_EMAIL` (from Firebase service account JSON)
- `FIREBASE_PRIVATE_KEY` (from Firebase service account JSON; keep `\n` escaped in `.env`)

If these are not configured, the app continues to work without Firebase writes.

## Behavior guarantee

- Same phone number -> same code always (for a fixed `CODE_SECRET`).
- Different phone numbers -> effectively different code (hash-based derivation).
