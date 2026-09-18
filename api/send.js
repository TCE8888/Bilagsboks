const nodemailer = require("nodemailer");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

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

// Builds a simple one-page PDF: a small text header (department, date,
// amount, note) followed by the receipt photo scaled to fit. Falls back to
// null if anything goes wrong, so the caller can send the raw image instead
// rather than failing the whole send.
async function buildReceiptPdf(imageBuffer, imageType, headerLines) {
  try {
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    let image;
    const type = (imageType || "").toLowerCase();
    if (type.indexOf("png") !== -1) {
      image = await pdfDoc.embedPng(imageBuffer);
    } else {
      image = await pdfDoc.embedJpg(imageBuffer);
    }

    const pageWidth = 595.28; // A4 at 72dpi
    const margin = 40;
    const headerFontSize = 11;
    const headerLineGap = 16;
    const headerHeight = 30 + headerLines.length * headerLineGap;

    const maxImgWidth = pageWidth - margin * 2;
    const maxImgHeight = 750 - headerHeight - margin;
    const scale = Math.min(maxImgWidth / image.width, maxImgHeight / image.height, 1);
    const imgWidth = image.width * scale;
    const imgHeight = image.height * scale;

    const pageHeight = headerHeight + imgHeight + margin * 2;
    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    let y = pageHeight - margin;
    headerLines.forEach(function (line, idx) {
      page.drawText(line.text, {
        x: margin,
        y: y,
        size: headerFontSize,
        font: idx === 0 ? boldFont : font,
        color: rgb(0.11, 0.14, 0.13),
      });
      y -= headerLineGap;
    });

    page.drawImage(image, {
      x: (pageWidth - imgWidth) / 2,
      y: y - imgHeight,
      width: imgWidth,
      height: imgHeight,
    });

    const bytes = await pdfDoc.save();
    return Buffer.from(bytes);
  } catch (e) {
    return null;
  }
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

  // Header-linjer øverst i PDF-en, hentet fra tekstmeldingen appen allerede
  // bygger (avdeling, dato, beløp, notat) — første linje vises fet.
  const headerLines = String(text || "")
    .split("\n")
    .map(function (l) { return l.trim(); })
    .filter(Boolean)
    .filter(function (l) { return l.indexOf("Sendt fra Bilagsboks") === -1; })
    .map(function (l) { return { text: l }; });

  let attachment = null;
  const pdfBuffer = await buildReceiptPdf(buffer, imageType, headerLines.length ? headerLines : [{ text: subject || "Kvittering" }]);
  if (pdfBuffer) {
    attachment = {
      filename: (imageName ? imageName.replace(/\.[a-z0-9]+$/i, "") : "kvittering") + ".pdf",
      content: pdfBuffer,
      contentType: "application/pdf",
    };
  } else {
    // OCR/bilde kunne ikke pakkes inn i PDF (uventet filformat e.l.) — send
    // heller det rå bildet enn å feile hele sendingen.
    attachment = {
      filename: imageName || "kvittering.jpg",
      content: buffer,
      contentType: imageType || "image/jpeg",
    };
  }

  try {
    await transporter.sendMail({
      from: gmailUser,
      to: to,
      subject: subject || "Kvittering",
      text: text || "",
      attachments: [attachment],
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: "send_failed", message: String((e && e.message) || e) });
  }
};
