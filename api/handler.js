// ============================================================
//  TeleBridge 🌉 v3.2 (Full Fix)
//  ✅ الإصلاح: إضافة جميع الوظائف المساعدة (Helpers)
//  ✅ الإصلاح: دعم تلقائي لمتغيرات Vercel KV
// ============================================================

import { Redis } from "@upstash/redis";

// إعداد Redis بدعم الأسماء المختلفة للمتغيرات
const kv = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
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
//  الوظائف المساعدة (Helpers) - تم إضافتها لحل الـ ReferenceError
// ──────────────────────────────────────────────────────────

function parseQuery(url) {
  const i = url.indexOf("?");
  if (i === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(i + 1)));
}

function buildQueryString(params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

function getPublicBaseUrl(req) {
  const configuredUrl = process.env.BRIDGE_PUBLIC_URL || process.env.PUBLIC_BASE_URL;
  if (configuredUrl) return configuredUrl.replace(/\/+$/, "");

  const host = req.headers["x-forwarded-host"] || req.headers.host || process.env.VERCEL_URL;
  const protocol = req.headers["x-forwarded-proto"] || "https";
  return `${protocol}://${host}`;
}

function getUpdateType(update) {
  return Object.keys(update || {}).find(key => key !== "update_id") || "unknown";
}

function getSafeUrlLabel(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}

async function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve) => {
    let data = "";
    req.on("data", chunk => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});

      const contentType = (req.headers["content-type"] || "").toLowerCase();
      if (contentType.includes("application/x-www-form-urlencoded")) {
        return resolve(Object.fromEntries(new URLSearchParams(data)));
      }

      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
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

// ══════════════════════════════════════════════════════════
// المبدأ الأساسي (Main Handler)
// ══════════════════════════════════════════════════════════
export default async function handler(req, res) {
  const fullUrl = req.url;
  const path = fullUrl.split("?")[0];
  const query = parseQuery(fullUrl); // الآن parseQuery معرفة ولن تعطي خطأ

  try {
    if (path === "/api/diag") {
      const token = query.token;
      const hasKvEnv = Boolean(
        process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
      ) && Boolean(
        process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
      );

      let savedWebhook = null;
      if (token) {
        try {
          savedWebhook = await kv.get(`webhook:${token}`);
        } catch {
          savedWebhook = null;
        }
      }

      return res.status(200).json({
        ok: true,
        route: "/api/diag",
        hasKvEnv,
        tokenProvided: Boolean(token),
        webhookSaved: Boolean(savedWebhook),
        savedWebhook,
      });
    }

    // 🔵 Route 1: Telegram → Vercel → n8n
    if (path === "/api/webhook") {
      if (req.method !== "POST") return res.status(200).send("🟢 Webhook Ready");

      const body = await parseJsonBody(req);
      const token = query.token;
      if (!token) {
        return res.status(400).json({ error: "Missing token in webhook query string" });
      }

      // جلب الرابط الخاص بالتوكن المحدد
      const n8nUrl = await kv.get(`webhook:${token}`);

      if (!n8nUrl) {
        console.error(`❌ No URL saved for bot token: ${token}`);
        return res.status(404).json({ ok: false, error: "No saved n8n webhook URL for this bot token" });
      }

      const updateType = getUpdateType(body);
      console.log("Forwarding Telegram update to n8n", {
        updateId: body.update_id,
        updateType,
        n8nTarget: getSafeUrlLabel(n8nUrl),
      });

      const n8nResponse = await fetch(n8nUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(55000),
      });
      const n8nBody = await n8nResponse.text();
      console.log("n8n webhook response", {
        status: n8nResponse.status,
        ok: n8nResponse.ok,
        body: n8nBody.slice(0, 500),
      });

      return res.status(200).json({ ok: true, forwarded: n8nResponse.ok, n8nStatus: n8nResponse.status });
    }

    // 🟡 Route 2: n8n → Vercel → Telegram
    const botRoute = path.match(/^\/bot([^/]+)\/(.+)$/);
    if (botRoute) {
      const [, token, method] = botRoute;

      if (req.method === "GET") {
        const params = { ...query };
        if (method === "setWebhook" && params.url) {
          await kv.set(`webhook:${token}`, params.url);
          params.url = `${getPublicBaseUrl(req)}/api/webhook?token=${token}`;
        }
        const tgRes = await fetch(`${TELEGRAM_API}/bot${token}/${method}${buildQueryString(params)}`);
        return res.status(tgRes.status).json(await tgRes.json());
      }

      let body = await parseJsonBody(req);

      // اعتراض setWebhook لتوجيه التحديثات للـ Bridge
      if (method === "setWebhook") {
        if (!body.url) {
          return res.status(400).json({ ok: false, error: "setWebhook requires url" });
        }
        await kv.set(`webhook:${token}`, body.url);
        body.url = `${getPublicBaseUrl(req)}/api/webhook?token=${token}`;
      }

      const tgResponse = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.status(tgResponse.status).json(await tgResponse.json());
    }

    // 📥 Route 3: Download File
    if (path === "/api/file") {
      const { file_id, token } = query;
      const getFileRes = await fetch(`${TELEGRAM_API}/bot${token}/getFile?file_id=${file_id}`);
      const getFileData = await getFileRes.json();
      const fileRes = await fetch(`${TELEGRAM_API}/file/bot${token}/${getFileData.result.file_path}`);
      const buffer = await fileRes.arrayBuffer();
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(Buffer.from(buffer));
    }

    // 📤 Route 4: Upload File
    if (path === "/api/upload") {
      const { method = "sendDocument", chat_id, token, filename = "file" } = query;
      const fileBuffer = await parseRawBody(req);
      const formData = new FormData();
      formData.append("chat_id", chat_id);
      formData.append(UPLOAD_FIELD_NAMES[method] || "document", new Blob([fileBuffer]), filename);

      const tgResponse = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: "POST",
        body: formData
      });
      return res.status(tgResponse.status).json(await tgResponse.json());
    }

    // Health Check
    return res.status(200).json({ status: "🟢 TeleBridge Active", storage: "Connected" });

  } catch (err) {
    console.error("Critical Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
