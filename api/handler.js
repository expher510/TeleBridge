// ============================================================
//  TeleBridge 🌉 v2.0
//  Vercel Proxy — يربط n8n بـ Telegram ويتجاوز الحظر
//  ✅ يستخدم Vercel KV لحفظ الـ n8n URL بشكل دائم
//
//  كيفية الاستخدام:
//  1. في Vercel Dashboard → Storage → Create KV Database
//  2. اربط الـ KV بالمشروع (Connect to Project)
//  3. Deploy على Vercel
//  4. في n8n → Credentials → Telegram → Base URL = https://your-app.vercel.app
//  5. شغّل الـ Telegram Trigger → كل حاجة هتشتغل أوتوماتيك ✅
// ============================================================

import { kv } from "@vercel/kv";

// ──────────────────────────────────────────────────────────
//  Telegram API الأصلي
// ──────────────────────────────────────────────────────────
const TELEGRAM_API = "https://api.telegram.org";

// ──────────────────────────────────────────────────────────
//  MIME Types للملفات
// ──────────────────────────────────────────────────────────
const MIME_TYPES = {
  mp4:  "video/mp4",
  mov:  "video/quicktime",
  avi:  "video/x-msvideo",
  mp3:  "audio/mpeg",
  ogg:  "audio/ogg",
  oga:  "audio/ogg",
  m4a:  "audio/mp4",
  wav:  "audio/wav",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  png:  "image/png",
  gif:  "image/gif",
  webp: "image/webp",
  pdf:  "application/pdf",
  zip:  "application/zip",
  json: "application/json",
  txt:  "text/plain",
};

// ──────────────────────────────────────────────────────────
//  Field Names لرفع الملفات
// ──────────────────────────────────────────────────────────
const UPLOAD_FIELD_NAMES = {
  sendDocument:  "document",
  sendPhoto:     "photo",
  sendVideo:     "video",
  sendAudio:     "audio",
  sendVoice:     "voice",
  sendAnimation: "animation",
  sendSticker:   "sticker",
};

// ══════════════════════════════════════════════════════════
export default async function handler(req, res) {

  const path = req.url.split("?")[0];

  // ──────────────────────────────────────────────────────
  // 🔵 Route 1: Telegram → Vercel → n8n
  //    Telegram بيبعت الـ Updates هنا
  // ──────────────────────────────────────────────────────
  if (path === "/api/webhook") {

    if (req.method !== "POST") {
      return res.status(200).json({ status: "🟢 TeleBridge Webhook ready" });
    }

    const body = req.body;
    console.log("📨 Telegram Update:", JSON.stringify(body));

    // ✅ جيب الـ n8n URL من Vercel KV (مش من process.env)
    const n8nUrl = await kv.get("n8n_webhook_url");

    if (!n8nUrl) {
      console.error("❌ N8N_WEBHOOK_URL مش محفوظ في KV — شغّل Telegram Trigger الأول");
      return res.status(200).json({ ok: true });
    }

    try {
      const n8nResponse = await fetch(n8nUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(55000),
      });

      console.log(`✅ n8n Response [${n8nResponse.status}]`);
    } catch (err) {
      console.error("❌ Forward to n8n failed:", err.message);
    }

    return res.status(200).json({ ok: true });
  }

  // ──────────────────────────────────────────────────────
  // 🟡 Route 2: n8n Telegram Node/Trigger → Vercel → Telegram
  //    n8n بيبعت لـ /bot{TOKEN}/{method}
  //    Vercel بيعترض setWebhook ويغير الـ URL لنفسه
  // ──────────────────────────────────────────────────────
  const botRoute = path.match(/^\/bot([^/]+)\/(.+)$/);
  if (botRoute) {

    const [, token, method] = botRoute;

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    let body = req.body || {};

    // ── اعترض setWebhook وغيّر الـ URL ──────────────────
    if (method === "setWebhook") {

      const originalUrl = body.url;
      console.log("🔗 n8n Webhook URL:", originalUrl);

      // ✅ احفظ الـ n8n URL في Vercel KV — بيفضل محفوظ دايماً
      await kv.set("n8n_webhook_url", originalUrl);
      console.log("💾 n8n URL saved to KV:", originalUrl);

      const vercelHost    = process.env.VERCEL_URL || req.headers.host;
      const newWebhookUrl = `https://${vercelHost}/api/webhook`;

      console.log("🔄 Replacing webhook URL:", originalUrl, "→", newWebhookUrl);

      body = {
        ...body,
        url:             newWebhookUrl,
        allowed_updates: body.allowed_updates || ["message", "callback_query", "inline_query"],
      };

      console.log("✅ setWebhook intercepted → URL changed to Vercel");
    }

    // ── مرّر الـ Request لـ Telegram ─────────────────────
    try {
      console.log(`📤 Proxying [${method}] → Telegram API`);

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
  //    GET /api/file?file_id=xxx&token=xxx
  // ──────────────────────────────────────────────────────
  if (path === "/api/file") {

    if (req.method !== "GET") {
      return res.status(405).json({ error: "Use GET" });
    }

    const { file_id, token } = req.query;

    if (!file_id) return res.status(400).json({ error: "❌ file_id required" });
    if (!token)   return res.status(400).json({ error: "❌ token required" });

    try {
      console.log(`📥 Downloading file_id: ${file_id}`);

      // Step 1: جيب file_path من Telegram
      const getFileRes  = await fetch(`${TELEGRAM_API}/bot${token}/getFile`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ file_id }),
      });
      const getFileData = await getFileRes.json();

      if (!getFileData.ok) {
        return res.status(400).json({ error: "❌ getFile failed", details: getFileData });
      }

      const file_path = getFileData.result.file_path;
      console.log(`📁 file_path: ${file_path}`);

      // Step 2: حمّل الملف
      const fileRes = await fetch(
        `${TELEGRAM_API}/file/bot${token}/${file_path}`
      );

      if (!fileRes.ok) {
        return res.status(500).json({ error: "❌ File download failed" });
      }

      const ext         = file_path.split(".").pop().toLowerCase();
      const contentType = MIME_TYPES[ext] || fileRes.headers.get("content-type") || "application/octet-stream";
      const fileName    = file_path.split("/").pop();
      const buffer      = await fileRes.arrayBuffer();

      console.log(`✅ File ready [${contentType}] ${buffer.byteLength} bytes`);

      res.setHeader("Content-Type",        contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("X-File-Path",         file_path);
      res.setHeader("X-File-Name",         fileName);
      return res.send(Buffer.from(buffer));

    } catch (err) {
      console.error("❌ File proxy error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ──────────────────────────────────────────────────────
  // 📤 Route 4: رفع ملف Binary لـ Telegram
  //    POST /api/upload?method=sendDocument&chat_id=xxx&token=xxx
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
    } = req.query;

    if (!chat_id) return res.status(400).json({ error: "❌ chat_id required" });
    if (!token)   return res.status(400).json({ error: "❌ token required" });

    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const fileBuffer = Buffer.concat(chunks);

      console.log(`📤 Uploading [${method}] → chat_id: ${chat_id} | ${fileBuffer.byteLength} bytes`);

      const fieldName = UPLOAD_FIELD_NAMES[method] || "document";

      const formData = new FormData();
      formData.append("chat_id", chat_id);
      if (caption) formData.append("caption", caption);
      formData.append(
        fieldName,
        new Blob([fileBuffer], { type: mimetype }),
        filename
      );

      const tgResponse = await fetch(
        `${TELEGRAM_API}/bot${token}/${method}`,
        { method: "POST", body: formData }
      );

      const tgData = await tgResponse.json();
      console.log("✅ Upload Response:", JSON.stringify(tgData));
      return res.status(200).json(tgData);

    } catch (err) {
      console.error("❌ Upload error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ──────────────────────────────────────────────────────
  // ℹ️ Health Check + Docs
  // ──────────────────────────────────────────────────────
  const vercelHost = process.env.VERCEL_URL || req.headers.host;

  // ✅ جيب الـ n8n URL من KV عشان يظهر في الـ health check
  const savedN8nUrl = await kv.get("n8n_webhook_url");

  return res.status(200).json({
    name:    "🌉 TeleBridge",
    version: "2.0.0",
    status:  "🟢 Running",
    n8n_url: savedN8nUrl || "⏳ Waiting for Telegram Trigger to register...",

    setup: {
      step1: "في Vercel Dashboard → Storage → Create KV Database → Connect to Project",
      step2: "Deploy على Vercel",
      step3: `في n8n Credentials → Telegram → Base URL = https://${vercelHost}`,
      step4: "شغّل الـ Telegram Trigger → كل حاجة هتبقى أوتوماتيك ✅",
    },

    routes: {
      "Telegram → n8n":  `POST https://${vercelHost}/api/webhook`,
      "n8n → Telegram":  `POST https://${vercelHost}/bot{TOKEN}/{method}`,
      "Download File":   `GET  https://${vercelHost}/api/file?file_id=xxx&token=xxx`,
      "Upload File":     `POST https://${vercelHost}/api/upload?method=sendDocument&chat_id=xxx&token=xxx`,
    },
  });
}
