# Yeni SaaS Ekleme Kılavuzu

Bu kılavuz, UPU WhatsApp Gateway'e yeni bir SaaS projesi eklemeyi açıklar.

## Ön Koşullar

- Projenizin Vercel'de deploy edilmiş olması
- Projenizde bir WhatsApp webhook endpoint'i olması

## Adım 1: Webhook Endpoint Oluşturun

Projenizde `src/app/api/whatsapp/route.ts` dosyası oluşturun:

```typescript
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();

    // Meta webhook payload'ı parse edin
    const entry = payload.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages?.[0]) {
      return NextResponse.json({ status: "ok" });
    }

    const message = messages[0];
    const phone = message.from;        // Gönderen telefon numarası
    const type = message.type;          // "text", "interactive", vs.
    const text = type === "text" ? message.text?.body?.trim() : "";

    // --- Kendi iş mantığınızı buraya yazın ---
    console.log(`[whatsapp] Message from ${phone}: ${text}`);

    // Örnek: basit echo
    // await sendWhatsAppMessage(phone, `Aldım: ${text}`);

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("[whatsapp] Webhook error:", err);
    return NextResponse.json({ status: "ok" }); // Meta'ya her zaman 200 dönün
  }
}
```

## Adım 2: Gateway'e Kaydolun

Gateway yöneticisinden (veya Vercel dashboard'dan) şu env var'ları ekleyin:

1. `SAAS_KEYS` listesine projenizin key'ini ekleyin:
   ```
   SAAS_KEYS=emlak,bayi,muhasebe,siteyonetim,SIZIN_KEY
   ```

2. Projeniz için URL ve label ekleyin:
   ```
   SAAS_SIZIN_KEY_URL=https://sizin-proje.vercel.app/api/whatsapp
   SAAS_SIZIN_KEY_LABEL=📦 Proje Adı
   ```

## Adım 3: Telefon Numarası Kaydedin

Gateway'in Supabase veritabanındaki `saas_phone_registry` tablosuna kullanıcı kaydı ekleyin:

```sql
INSERT INTO saas_phone_registry (phone, saas_key)
VALUES ('905551234567', 'SIZIN_KEY');
```

Veya projeniz içinden API ile:

```typescript
const supabase = createClient(GATEWAY_SUPABASE_URL, GATEWAY_SERVICE_KEY);
await supabase.from('saas_phone_registry').insert({
  phone: '905551234567',
  saas_key: 'sizin_key',
});
```

## Adım 4: Test Edin

1. Kayıtlı telefon numarasından WhatsApp'a mesaj gönderin
2. Gateway loglarında routing'i kontrol edin
3. "degistir" yazarak SaaS menüsünü test edin

## Notlar

- Gateway **hiçbir iş mantığı** çalıştırmaz — sadece yönlendirir
- Her SaaS kendi kullanıcı yönetimini kendisi yapar
- Meta webhook payload'ı **aynen** forward edilir, değiştirilmez
- Kullanıcı "degistir" yazarak SaaS'lar arası geçiş yapabilir
- Varsayılan SaaS: `emlak` (kayıtlı değilse oraya gider)

## Teknik Detaylar

### Veritabanı Tabloları

| Tablo | Amaç |
|-------|------|
| `saas_phone_registry` | phone → saas_key mapping (bir telefon birden fazla SaaS'a kayıtlı olabilir) |
| `saas_active_session` | Kullanıcının şu an aktif olan SaaS seçimi |

### Env Var'lar (Gateway)

| Değişken | Açıklama |
|----------|----------|
| `SUPABASE_URL` | Gateway DB URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Gateway DB service key |
| `WHATSAPP_ACCESS_TOKEN` | Meta System User token |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta phone number ID |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification token |
| `SAAS_KEYS` | Virgülle ayrılmış SaaS key listesi |
| `SAAS_<KEY>_URL` | Her SaaS'ın webhook URL'si |
| `SAAS_<KEY>_LABEL` | Her SaaS'ın görünen adı (emoji dahil) |
