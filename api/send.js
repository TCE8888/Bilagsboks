const nodemailer = require("nodemailer");

// Vercel serverless function (Node runtime). Receives JSON with the receipt
// details plus a base64-encoded image, and sends it as an email with the
// image attached via the Gmail account configured through environment
// variables. This runs on the server, so it is not subject to the browser
// restrictions (mailto, Web Share) that block automatic attachments.

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      // Basic guard against absurdly large payloads before Vercel's own limit kicks in.
      if (data.length > 8 * 1024 * 1024) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-secret");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const appSecret = process.env.APP_SECRET;
  if (appSecret && req.headers["x-app-secret"] !== appSecret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    res.status(500).json({ error: "server_not_configured" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const { to, subject, text, imageBase64, imageType, imageName } = body || {};

  if (!to || typeof to !== "string") {
    res.status(400).json({ error: "missing_recipient" });
    return;
  }
  if (!imageBase64 || typeof imageBase64 !== "string") {
    res.status(400).json({ error: "missing_image" });
    return;
  }

  let buffer;
  try {
    buffer = Buffer.from(imageBase64, "base64");
  } catch (e) {
    res.status(400).json({ error: "invalid_image" });
    return;
  }

  if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) {
    res.status(400).json({ error: "image_size" });
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  try {
    await transporter.sendMail({
      from: gmailUser,
      to: to,
      subject: subject || "Kvittering",
      text: text || "",
      attachments: [
        {
          filename: imageName || "kvittering.jpg",
          content: buffer,
          contentType: imageType || "image/jpeg",
        },
      ],
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "send_failed", message: String((e && e.message) || e) });
  }
};
