const nameInput = document.getElementById("name");
const phoneInput = document.getElementById("phone");
const otpInput = document.getElementById("otp");
const sendOtpBtn = document.getElementById("sendOtpBtn");
const verifyBtn = document.getElementById("verifyBtn");
const otpSection = document.getElementById("otpSection");
const messageEl = document.getElementById("message");
const codeEl = document.getElementById("code");
const copyCodeBtn = document.getElementById("copyCodeBtn");
const shopNoteEl = document.getElementById("shopNote");
let currentVerificationSid = null;

function setMessage(text, type) {
  messageEl.textContent = text;
  messageEl.className = `msg ${type || ""}`;
}

function clearCode() {
  codeEl.textContent = "";
  copyCodeBtn.classList.add("hidden");
  shopNoteEl.classList.add("hidden");
}

function setLoading(buttonEl, loadingText, isLoading) {
  if (!buttonEl.dataset.defaultText) {
    buttonEl.dataset.defaultText = buttonEl.textContent;
  }
  buttonEl.disabled = isLoading;
  buttonEl.textContent = isLoading ? loadingText : buttonEl.dataset.defaultText;
}

function validatePhone(phone) {
  const digitsOnly = String(phone || "").replace(/\D/g, "");
  return digitsOnly.length === 10;
}

function formatIndianPhone(phone) {
  const rawDigits = String(phone || "").replace(/\D/g, "");
  const tenDigits = rawDigits.length > 10 ? rawDigits.slice(-10) : rawDigits;
  return `+91${tenDigits}`;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

sendOtpBtn.addEventListener("click", async () => {
  try {
    const inputPhone = phoneInput.value.trim();
    if (!validatePhone(inputPhone)) {
      setMessage("Please enter a valid 10-digit mobile number.", "err");
      return;
    }
    const phone = formatIndianPhone(inputPhone);

    setLoading(sendOtpBtn, "Sending OTP...", true);
    clearCode();
    setMessage("Sending OTP to your mobile number...", "");
    const data = await postJson("/api/send-otp", {
      name: nameInput.value.trim(),
      phone
    });
    currentVerificationSid = data?.debug?.verificationSid || null;
    otpSection.classList.remove("hidden");
    otpInput.focus();
    setMessage("OTP sent successfully. Please check your SMS.", "ok");
  } catch (error) {
    setMessage(error.message, "err");
  } finally {
    setLoading(sendOtpBtn, "Sending OTP...", false);
  }
});

verifyBtn.addEventListener("click", async () => {
  try {
    const otp = otpInput.value.trim();
    if (otp.length < 4) {
      setMessage("Please enter the OTP received on your mobile.", "err");
      return;
    }

    setLoading(verifyBtn, "Verifying...", true);
    setMessage("Verifying OTP and generating your member code...", "");
    const data = await postJson("/api/verify-otp", {
      name: nameInput.value.trim(),
      phone: formatIndianPhone(phoneInput.value.trim()),
      otp,
      verificationSid: currentVerificationSid
    });
    setMessage("Phone verified successfully. Your member code is ready.", "ok");
    codeEl.textContent = data.code;
    copyCodeBtn.classList.remove("hidden");
    shopNoteEl.classList.remove("hidden");
  } catch (error) {
    clearCode();
    setMessage(error.message, "err");
  } finally {
    setLoading(verifyBtn, "Verifying...", false);
  }
});

copyCodeBtn.addEventListener("click", async () => {
  const code = codeEl.textContent.trim();
  if (!code) return;

  try {
    await navigator.clipboard.writeText(code);
    setMessage("Member code copied to clipboard.", "ok");
  } catch (_error) {
    setMessage("Could not copy automatically. Please copy the code manually.", "err");
  }
});
