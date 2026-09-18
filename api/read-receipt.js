// Vercel serverless function (Node runtime). Receives a base64 JPEG of a
// receipt, sends it to the free OCR.space API to get the raw text back,
// then runs a small heuristic parser over that text to guess the total
// amount. Returns { amount: "245,00" } or { amount: null } if nothing
// confident was found. The OCR.space API key stays server-side.
//
// This is a best-effort assist, not a guarantee — the amount field in the
// app stays editable so the person can fix it if the guess is wrong.

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
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

// Pull every money-looking number out of a line, e.g. "1.234,56", "245,00", "99".
function extractNumbers(line) {
  var matches = line.match(/\d{1,3}(?:[.\s]\d{3})*(?:[.,]\d{2})?|\d+(?:[.,]\d{2})/g) || [];
  return matches
    .map(function (raw) {
      // Normalize "1.234,56" or "1 234,56" -> 1234.56 ; "245,00" -> 245.00 ; "245.00" -> 245.00
      var cleaned = raw.replace(/\s/g, "");
      var lastComma = cleaned.lastIndexOf(",");
      var lastDot = cleaned.lastIndexOf(".");
      var decimalSep = lastComma > lastDot ? "," : lastDot > -1 ? "." : null;
      var value;
      if (decimalSep) {
        var intPart = cleaned.slice(0, decimalSep === "," ? lastComma : lastDot).replace(/[.,]/g, "");
        var decPart = cleaned.slice((decimalSep === "," ? lastComma : lastDot) + 1);
        value = parseFloat(intPart + "." + decPart);
      } else {
        value = parseFloat(cleaned.replace(/[.,]/g, ""));
      }
      return { raw: raw, value: value };
    })
    .filter(function (n) {
      return !isNaN(n.value) && n.value > 0 && n.value < 1000000;
    });
}

function guessTotal(text) {
  var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  var keywordGroups = [
    /totalt?\s*å\s*betale/i,
    /sum\s*å\s*betale/i,
    /\btotalt\b/i,
    /\btotal\b/i,
    /\bsum\b/i,
    /\bbel[øo]p\b/i,
  ];

  for (var g = 0; g < keywordGroups.length; g++) {
    for (var i = 0; i < lines.length; i++) {
      if (keywordGroups[g].test(lines[i])) {
        var nums = extractNumbers(lines[i]);
        if (!nums.length && lines[i + 1]) nums = extractNumbers(lines[i + 1]);
        if (nums.length) {
          nums.sort(function (a, b) { return b.value - a.value; });
          return nums[0].value;
        }
      }
    }
  }

  // Fallback: largest money-looking number anywhere on the receipt.
  var all = extractNumbers(text);
  if (!all.length) return null;
  all.sort(function (a, b) { return b.value - a.value; });
  return all[0].value;
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

  const ocrKey = process.env.OCR_SPACE_API_KEY;
  if (!ocrKey) {
    res.status(500).json({ error: "ocr_not_configured" });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const { imageBase64 } = body || {};
  if (!imageBase64 || typeof imageBase64 !== "string") {
    res.status(400).json({ error: "missing_image" });
    return;
  }

  try {
    const params = new URLSearchParams();
    params.set("apikey", ocrKey);
    params.set("base64Image", "data:image/jpeg;base64," + imageBase64);
    params.set("OCREngine", "2");
    params.set("scale", "true");
    params.set("language", "eng");

    const ocrRes = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!ocrRes.ok) {
      res.status(502).json({ error: "ocr_request_failed" });
      return;
    }

    const data = await ocrRes.json();
    if (data.IsErroredOnProcessing) {
      res.status(502).json({ error: "ocr_processing_error", message: String(data.ErrorMessage || "") });
      return;
    }

    const parsedText = (data.ParsedResults && data.ParsedResults[0] && data.ParsedResults[0].ParsedText) || "";
    const total = guessTotal(parsedText);

    if (total == null) {
      res.status(200).json({ amount: null });
      return;
    }

    const formatted = total.toFixed(2).replace(".", ",");
    res.status(200).json({ amount: formatted });
  } catch (e) {
    res.status(502).json({ error: "ocr_failed", message: String((e && e.message) || e) });
  }
};
