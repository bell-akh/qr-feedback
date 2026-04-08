const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const QRCode = require("qrcode");

dotenv.config();

const APP_URL = process.env.APP_URL || "http://localhost:3000";
const outputDir = path.join(__dirname, "..", "assets");
const outputPath = path.join(outputDir, "qr.png");

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

QRCode.toFile(outputPath, APP_URL, {
  type: "png",
  errorCorrectionLevel: "H",
  margin: 1,
  width: 400
})
  .then(() => {
    console.log(`QR generated: ${outputPath}`);
    console.log(`QR points to: ${APP_URL}`);
  })
  .catch((err) => {
    console.error("Failed to generate QR:", err.message);
    process.exit(1);
  });
