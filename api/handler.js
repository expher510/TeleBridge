// ============================================================
//  TeleBridge 🌉 v3.1 (Fixed & Plug-and-Play)
// ============================================================

import { Redis } from "@upstash/redis";

// الإصلاح 1: دعم تلقائي لأسماء متغيرات Vercel KV الافتراضية
const kv = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TELEGRAM_API = "https://api.telegram.org";

// ... (تُترك مصفوفات MIME_TYPES و UPLOAD_FIELD_NAMES كما هي)

export default async function handler(req, res) {
  const fullUrl = req.url;
  const path = fullUrl.split("?")[0];
  const query = parseQuery(fullUrl);

  // 🔵 Route 1: Telegram → Vercel → n8n
  if (path === "/api/webhook") {
    if (req.method !== "POST") return res.status(200).send("🟢 Webhook Ready");

    const body = await parseJsonBody(req);
    const token = query.token; // استخراج التوكن من الرابط

    // الإصلاح 2: جلب الرابط بناءً على التوكن لمنع التداخل
    const n8nUrl = await kv.get(`webhook:${token}`);

    if (!n8nUrl) {
      console.error(`❌ No URL saved for token ending in ...${token?.slice(-5)}`);
      return res.status(200).json({ ok: true });
    }

    try {
      await fetch(n8nUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(55000),
      });
    } catch (err) {
      console.error("❌ Forward failed:", err.message);
    }
    return res.status(200).json({ ok: true });
  }

  // 🟡 Route 2: n8n → Vercel → Telegram
  const botRoute = path.match(/^\/bot([^/]+)\/(.+)$/);
  if (botRoute) {
    const [, token, method] = botRoute;

    if (req.method === "GET") {
      const tgRes = await fetch(`${TELEGRAM_API}/bot${token}/${method}`);
      return res.status(200).json(await tgRes.json());
    }

    let body = await parseJsonBody(req);

    if (method === "setWebhook") {
      const originalUrl = body.url;
      // الإصلاح 3: تخزين الرابط باستخدام التوكن كفتاح فريد
      await kv.set(`webhook:${token}`, originalUrl);

      const vercelHost = process.env.VERCEL_URL || req.headers.host;
      body.url = `https://${vercelHost}/api/webhook?token=${token}`;
    }

    const tgResponse = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status(200).json(await tgResponse.json());
  }

  // ... (تُترك بقية مسارات التحميل والرفع كما هي في كودك)
  
  // Health Check المحسن
  const vercelHost = process.env.VERCEL_URL || req.headers.host;
  return res.status(200).json({
    status: "🟢 TeleBridge Active",
    storage_connected: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL),
    endpoint: `https://${vercelHost}`
  });
}

// ... (تُترك وظائف الـ Helpers كما هي)
