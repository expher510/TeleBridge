# 🌉 TeleBridge

> جسر شفاف بين **n8n** و **Telegram API** يتجاوز حظر الـ IP تلقائياً

---

## ⚡ الإعداد — 3 خطوات بس

### 1. Deploy على Vercel
```bash
vercel deploy
```

### 2. غيّر Base URL في n8n Credentials
```
Telegram Credentials → Base URL:
https://your-app.vercel.app
```

### 3. شغّل الـ Workflow في n8n
- **Telegram Trigger** هيعمل `setWebhook` أوتوماتيك
- TeleBridge هيعترض الـ URL ويوجّهه لنفسه
- كل الرسايل هتيجي وتروح عبر Vercel ✅

---

## 🔄 كيف يشتغل

```
User ──► Telegram ──► Vercel (/api/webhook) ──► n8n Trigger
                                                      │
                                               [Workflow Logic]
                                                      │
User ◄── Telegram ◄── Vercel (/bot{token}/method) ◄── n8n Telegram Node
```

---

## 📡 الـ Routes

| Route | الاتجاه | الوصف |
|-------|---------|-------|
| `POST /api/webhook` | Telegram → n8n | استقبال الـ Updates |
| `POST /bot{token}/{method}` | n8n → Telegram | كل الـ Telegram methods |
| `GET /api/file?file_id=xxx&token=xxx` | Telegram → n8n | تحميل ملف |
| `POST /api/upload?chat_id=xxx&token=xxx` | n8n → Telegram | رفع ملف Binary |

---

## ✅ مش محتاج أي Environment Variables

الـ Token بييجي مع كل request من n8n أوتوماتيك جوه الـ URL.
الـ n8n Webhook URL بيتحفظ لما Trigger يعمل `setWebhook`.
