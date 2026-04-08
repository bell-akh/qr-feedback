const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const crypto = require("crypto");
const twilio = require("twilio");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS || 300);
const CODE_SECRET = process.env.CODE_SECRET || "change-this-secret";
const OTP_PROVIDER = process.env.OTP_PROVIDER || "console";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
const IS_VERCEL = Boolean(process.env.VERCEL);

let sqliteDb = null;
let kv = null;
let firestoreDb = null;
const memoryUsers = new Map();

if (IS_VERCEL) {
  // Vercel functions have ephemeral filesystem; use Vercel KV for persistence.
  // eslint-disable-next-line global-require
  kv = require("@vercel/kv").kv;
} else {
  // Local dev keeps SQLite for easy testing.
  // eslint-disable-next-line global-require
  const sqlite3 = require("sqlite3").verbose();
  const dbPath = path.join(__dirname, "data.sqlite");
  sqliteDb = new sqlite3.Database(dbPath);

  sqliteDb.serialize(() => {
    sqliteDb.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL UNIQUE,
        name TEXT,
        code TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  });
}

function getFirebaseServiceAccount() {
  const projectId = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKeyRaw = String(process.env.FIREBASE_PRIVATE_KEY || "").trim();

  if (!projectId || !clientEmail || !privateKeyRaw) {
    return null;
  }

  const privateKey = privateKeyRaw
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\\n/g, "\n")
    .trim();

  return {
    projectId,
    clientEmail,
    privateKey
  };
}

function initFirestore() {
  const serviceAccount = getFirebaseServiceAccount();
  if (!serviceAccount) {
    return null;
  }

  try {
    // eslint-disable-next-line global-require
    const admin = require("firebase-admin");
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
    return admin.firestore();
  } catch (error) {
    console.error("Firebase init failed:", error.message);
    return null;
  }
}

firestoreDb = initFirestore();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/favicon.ico", (_req, res) => res.status(204).end());

const otpStore = new Map();
const twilioClient =
  OTP_PROVIDER === "twilio" && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

function normalizePhone(input) {
  return String(input || "").replace(/[^\d+]/g, "").trim();
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateStableCode(phone) {
  const normalized = normalizePhone(phone);
  const digest = crypto
    .createHmac("sha256", CODE_SECRET)
    .update(normalized)
    .digest("hex");

  const first10Hex = digest.slice(0, 10);
  const num = parseInt(first10Hex, 16);
  const base36 = num.toString(36).toUpperCase();
  return base36.padStart(5, "0").slice(0, 5);
}

function ensureTwilioReady() {
  if (!twilioClient || !TWILIO_VERIFY_SERVICE_SID) {
    throw new Error(
      "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_VERIFY_SERVICE_SID."
    );
  }
}

async function verifyOtpWithDirectTwilioCheck(phone, otp, verificationSid) {
  ensureTwilioReady();
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString(
    "base64"
  );
  const url = `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SERVICE_SID}/VerificationCheck/`;
  const body = new URLSearchParams();
  body.set("Code", otp);
  if (verificationSid) {
    body.set("VerificationSid", verificationSid);
  } else {
    body.set("To", phone);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const data = await response.json();

  if (!response.ok) {
    const message = data.message || "Twilio verification check failed.";
    const err = new Error(message);
    err.status = response.status;
    err.code = data.code || null;
    throw err;
  }

  return data;
}

async function sendOtpViaProvider(phone, otp) {
  if (OTP_PROVIDER === "console") {
    console.log(`[OTP DEMO] phone=${phone} otp=${otp}`);
    return { provider: "console" };
  }

  if (OTP_PROVIDER === "twilio") {
    ensureTwilioReady();
    const verification = await twilioClient.verify.v2
      .services(TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: phone, channel: "sms" });
    return {
      provider: "twilio",
      verificationSid: verification.sid,
      status: verification.status,
      channel: verification.channel
    };
  }

  throw new Error(
    `Unsupported OTP provider '${OTP_PROVIDER}'. Use 'console' or 'twilio'.`
  );
}

async function verifyOtpViaProvider(phone, otp, verificationSid) {
  if (OTP_PROVIDER === "console") {
    const record = otpStore.get(phone);
    if (!record) {
      return { approved: false, reason: "OTP not requested for this phone." };
    }

    if (Date.now() > record.expiresAt) {
      otpStore.delete(phone);
      return { approved: false, reason: "OTP expired. Request a new OTP." };
    }

    if (record.otp !== otp) {
      return { approved: false, reason: "Invalid OTP." };
    }

    return { approved: true, nameFromSendStep: record.name || null };
  }

  if (OTP_PROVIDER === "twilio") {
    const result = await verifyOtpWithDirectTwilioCheck(
      phone,
      otp,
      verificationSid
    );

    if (result.status !== "approved") {
      return { approved: false, reason: "Invalid OTP." };
    }

    return { approved: true, nameFromSendStep: null };
  }

  throw new Error(
    `Unsupported OTP provider '${OTP_PROVIDER}'. Use 'console' or 'twilio'.`
  );
}

async function upsertUser({ phone, name, code }) {
  const now = new Date().toISOString();
  if (IS_VERCEL) {
    const saveToMemory = () => {
      const existing = memoryUsers.get(phone);
      memoryUsers.set(phone, {
        phone,
        name,
        code,
        created_at: existing?.created_at || now,
        updated_at: now
      });
    };

    if (!kv) {
      // Fallback avoids 500s when KV isn't configured yet.
      saveToMemory();
      return;
    }

    try {
      const payload = { phone, name, code, updated_at: now };
      const existing = await kv.get(`user:${phone}`);
      if (!existing) {
        payload.created_at = now;
      } else {
        payload.created_at = existing.created_at || now;
      }
      await kv.set(`user:${phone}`, payload);
    } catch (error) {
      // If KV package exists but env vars are missing, continue with fallback.
      if (
        typeof error?.message === "string" &&
        error.message.includes("@vercel/kv: Missing required environment variables")
      ) {
        saveToMemory();
        return;
      }
      throw error;
    }
    return;
  }

  await new Promise((resolve, reject) => {
    sqliteDb.run(
      `
      INSERT INTO users (phone, name, code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        name = excluded.name,
        code = excluded.code,
        updated_at = excluded.updated_at
      `,
      [phone, name, code, now, now],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

async function saveUserToFirestore({ phone, name, code }) {
  if (!firestoreDb) {
    return { saved: false, reason: "firebase_not_configured" };
  }

  const now = new Date().toISOString();
  await firestoreDb
    .collection("member_codes")
    .doc(phone)
    .set(
      {
        phone,
        name: name || null,
        code,
        updatedAt: now
      },
      { merge: true }
    );

  return { saved: true };
}

app.post("/api/send-otp", async (req, res) => {
  try {
    const { phone, name } = req.body || {};
    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({ error: "Phone number is required." });
    }

    const otp = generateOtp();
    otpStore.set(normalizedPhone, {
      otp,
      name: String(name || "").trim(),
      expiresAt: Date.now() + OTP_TTL_SECONDS * 1000
    });

    const providerResult = await sendOtpViaProvider(normalizedPhone, otp);

    return res.json({
      ok: true,
      message: "OTP sent successfully.",
      debug: providerResult
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to send OTP.",
      code: error.code || null,
      status: error.status || null,
      details: error.message
    });
  }
});

app.post("/api/verify-otp", async (req, res) => {
  try {
    const { phone, name, otp, verificationSid } = req.body || {};
    const normalizedPhone = normalizePhone(phone);
    const normalizedName = String(name || "").trim();
    const enteredOtp = String(otp || "").trim();

    if (!normalizedPhone || !enteredOtp) {
      return res
        .status(400)
        .json({ error: "Phone number and OTP are required." });
    }

    const verifyResult = await verifyOtpViaProvider(
      normalizedPhone,
      enteredOtp,
      String(verificationSid || "").trim() || null
    );
    if (!verifyResult.approved) {
      return res.status(400).json({ error: verifyResult.reason });
    }

    const code = generateStableCode(normalizedPhone);
    const finalName = normalizedName || verifyResult.nameFromSendStep || null;
    await upsertUser({
      phone: normalizedPhone,
      name: finalName,
      code
    });
    let firebaseResult = { saved: false, reason: "firebase_not_configured" };
    try {
      firebaseResult = await saveUserToFirestore({
        phone: normalizedPhone,
        name: finalName,
        code
      });
    } catch (firebaseError) {
      console.error("Failed to save member record to Firebase:", firebaseError.message);
      firebaseResult = { saved: false, reason: "firebase_write_failed" };
    }

    if (OTP_PROVIDER === "console") {
      otpStore.delete(normalizedPhone);
    }

    return res.json({
      ok: true,
      phone: normalizedPhone,
      name: finalName,
      code,
      firebase: firebaseResult
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to verify OTP.",
      details: error.message
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    appUrl: APP_URL,
    runtime: IS_VERCEL ? "vercel" : "local",
    storage: IS_VERCEL ? (kv ? "vercel-kv" : "in-memory-fallback") : "sqlite",
    firebase: firestoreDb ? "enabled" : "not-configured"
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running at ${APP_URL}`);
  });
}

module.exports = app;
