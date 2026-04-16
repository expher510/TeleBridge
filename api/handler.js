// ============================================================
//  TeleBridge 🌉 v3.0
//  Vercel Proxy — يربط n8n بـ Telegram ويتجاوز الحظر
//  ✅ يستخدم Upstash Redis (بديل @vercel/kv)
// ============================================================

import { Redis } from "@upstash/redis";

const kv = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TELEGRAM_API = "https://api.telegram.org";

const MIME_TYPES = {
  mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
  mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg",
  m4a: "audio/mp4", wav: "audio/wav", jpg: "image/jpeg",
  jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", pdf: "application/pdf", zip: "application/zip",
  json: "application/json", txt: "text/plain",
};

const UPLOAD_FIELD_NAMES = {
  sendDocument: "document", sendPhoto: "photo", sendVideo: "video",
  sendAudio: "audio", sendVoice: "voice", sendAnimation: "animation",
  sendSticker: "sticker",
};

// ──────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────

async function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

async function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseQuery(url) {
  const i = url.indexOf("?");
  if (i === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(i + 1)));
}

// ══════════════════════════════════════════════════════════
export default async function handler(req, res) {

  const fullUrl = req.url;
  const path    = fullUrl.split("?")[0];
  const query   = parseQuery(fullUrl);

  // ──────────────────────────────────────────────────────
  // 🔵 Route 1: Telegram → Vercel → n8n
  // ──────────────────────────────────────────────────────
  if (path === "/api/webhook") {

    if (req.method !== "POST") {
      return res.status(200).json({ status: "🟢 TeleBridge Webhook ready" });
    }

    const body = await parseJsonBody(req);
    console.log("📨 Telegram Update:", JSON.stringify(body));

    const n8nUrl = await kv.get("n8n_webhook_url");

    if (!n8nUrl) {
      console.error("❌ n8n URL مش محفوظ — شغّل Telegram Trigger الأول");
      return res.status(200).json({ ok: true });
    }

    try {
      const r = await fetch(n8nUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(55000),
      });
      console.log(`✅ n8n Response [${r.status}]`);
    } catch (err) {
      console.error("❌ Forward to n8n failed:", err.message);
    }

    return res.status(200).json({ ok: true });
  }

  // ──────────────────────────────────────────────────────
  // 🟡 Route 2: n8n → Vercel → Telegram
  //    ✅ FIX: بيقبل GET و POST (مش POST بس)
  // ──────────────────────────────────────────────────────
  const botRoute = path.match(/^\/bot([^/]+)\/(.+)$/);
  if (botRoute) {

    const [, token, method] = botRoute;

    // ── GET request (زي getWebhookInfo) ─────────────────
    if (req.method === "GET") {
      try {
        const tgResponse = await fetch(
          `${TELEGRAM_API}/bot${token}/${method}`
        );
        const tgData = await tgResponse.json();
        console.log(`✅ GET [${method}]:`, JSON.stringify(tgData));
        return res.status(200).json(tgData);
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message });
      }
    }

    // ── POST request ─────────────────────────────────────
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    let body = await parseJsonBody(req);

    // اعترض setWebhook وغيّر الـ URL لـ Vercel
    if (method === "setWebhook") {
      const originalUrl = body.url;
      console.log("🔗 n8n Webhook URL:", originalUrl);

      await kv.set("n8n_webhook_url", originalUrl);
      console.log("💾 n8n URL saved to Redis:", originalUrl);

      const vercelHost = process.env.VERCEL_URL || req.headers.host;
      const newUrl     = `https://${vercelHost}/api/webhook`;

      console.log("🔄 setWebhook:", originalUrl, "→", newUrl);

      body = {
        ...body,
        url:             newUrl,
        allowed_updates: body.allowed_updates || ["message", "callback_query", "inline_query"],
      };
    }

    try {
      console.log(`📤 Proxying POST [${method}] → Telegram`);
      const tgResponse = await fetch(
        `${TELEGRAM_API}/bot${token}/${method}`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        }
      );
      const tgData = await tgResponse.json();
      console.log(`✅ Telegram [${method}]:`, JSON.stringify(tgData));
      return res.status(200).json(tgData);
    } catch (err) {
      console.error(`❌ Proxy failed [${method}]:`, err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ──────────────────────────────────────────────────────
  // 📥 Route 3: تحميل ملف من Telegram
  // ──────────────────────────────────────────────────────
  if (path === "/api/file") {

    if (req.method !== "GET") {
      return res.status(405).json({ error: "Use GET" });
    }

    const { file_id, token } = query;
    if (!file_id) return res.status(400).json({ error: "❌ file_id required" });
    if (!token)   return res.status(400).json({ error: "❌ token required" });

    try {
      const getFileRes  = await fetch(`${TELEGRAM_API}/bot${token}/getFile`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ file_id }),
      });
      const getFileData = await getFileRes.json();

      if (!getFileData.ok) {
        return res.status(400).json({ error: "❌ getFile failed", details: getFileData });
      }

      const file_path   = getFileData.result.file_path;
      const fileRes     = await fetch(`${TELEGRAM_API}/file/bot${token}/${file_path}`);

      if (!fileRes.ok) return res.status(500).json({ error: "❌ File download failed" });

      const ext         = file_path.split(".").pop().toLowerCase();
      const contentType = MIME_TYPES[ext] || fileRes.headers.get("content-type") || "application/octet-stream";
      const fileName    = file_path.split("/").pop();
      const buffer      = await fileRes.arrayBuffer();

      res.setHeader("Content-Type",        contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("X-File-Path",         file_path);
      res.setHeader("X-File-Name",         fileName);
      return res.send(Buffer.from(buffer));

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ──────────────────────────────────────────────────────
  // 📤 Route 4: رفع ملف Binary لـ Telegram
  // ──────────────────────────────────────────────────────
  if (path === "/api/upload") {

    if (req.method !== "POST") {
      return res.status(200).json({ status: "🟢 Upload endpoint ready" });
    }

    const {
      method   = "sendDocument",
      chat_id,
      token,
      caption  = "",
      filename = "file",
      mimetype = "application/octet-stream",
    } = query;

    if (!chat_id) return res.status(400).json({ error: "❌ chat_id required" });
    if (!token)   return res.status(400).json({ error: "❌ token required" });

    try {
      const fileBuffer = await parseRawBody(req);
      const fieldName  = UPLOAD_FIELD_NAMES[method] || "document";

      const formData = new FormData();
      formData.append("chat_id", chat_id);
      if (caption) formData.append("caption", caption);
      formData.append(fieldName, new Blob([fileBuffer], { type: mimetype }), filename);

      const tgResponse = await fetch(
        `${TELEGRAM_API}/bot${token}/${method}`,
        { method: "POST", body: formData }
      );

      const tgData = await tgResponse.json();
      return res.status(200).json(tgData);

    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ──────────────────────────────────────────────────────
  // ℹ️ Health Check
  // ──────────────────────────────────────────────────────
  const vercelHost  = process.env.VERCEL_URL || req.headers.host;
  const savedN8nUrl = await kv.get("n8n_webhook_url").catch(() => null);

  return res.status(200).json({
    name:    "🌉 TeleBridge",
    version: "3.0.0",
    status:  "🟢 Running",
    n8n_url: savedN8nUrl || "⏳ شغّل Telegram Trigger الأول عشان يتسجّل",
    routes: {
      "Telegram → n8n": `POST https://${vercelHost}/api/webhook`,
      "n8n → Telegram": `POST https://${vercelHost}/bot{TOKEN}/{method}`,
      "Download File":  `GET  https://${vercelHost}/api/file?file_id=xxx&token=xxx`,
      "Upload File":    `POST https://${vercelHost}/api/upload?method=sendDocument&chat_id=xxx&token=xxx`,
    },
  });
}
