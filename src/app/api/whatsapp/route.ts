/**
 * UPU WhatsApp Gateway — Central Router
 *
 * Receives ALL WhatsApp webhooks from Meta and routes them to the correct SaaS project.
 * Zero business logic — just routing.
 *
 * GET  → Meta webhook verification
 * POST → Route incoming message to correct SaaS
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ─── SaaS Configuration (from env vars) ────────────────────────────────────

interface SaaSConfig {
  key: string;
  label: string;
  webhookUrl: string;
}

function getSaaSConfigs(): SaaSConfig[] {
  // Read from env: SAAS_<KEY>_URL and SAAS_<KEY>_LABEL
  // Always include emlak as default
  const configs: SaaSConfig[] = [];

  const keys = (process.env.SAAS_KEYS || "emlak").split(",").map(k => k.trim());

  for (const key of keys) {
    const url = process.env[`SAAS_${key.toUpperCase()}_URL`];
    const label = process.env[`SAAS_${key.toUpperCase()}_LABEL`] || key;
    if (url) {
      configs.push({ key, label, webhookUrl: url });
    }
  }

  return configs;
}

// ─── Supabase client (for phone registry + active session) ─────────────────

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

// ─── WhatsApp API helpers ──────────────────────────────────────────────────

const WA_API = "https://graph.facebook.com/v23.0";

async function sendButtonMessage(
  phone: string,
  text: string,
  buttons: Array<{ id: string; title: string }>,
) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return;

  await fetch(`${WA_API}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({
            type: "reply",
            reply: { id: b.id, title: b.title.substring(0, 20) },
          })),
        },
      },
    }),
  }).catch(err => console.error("[gateway] sendButton error:", err));
}

async function sendListMessage(
  phone: string,
  text: string,
  buttonText: string,
  rows: Array<{ id: string; title: string }>,
) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) return;

  await fetch(`${WA_API}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text },
        action: {
          button: buttonText,
          sections: [{ title: "Sistemler", rows }],
        },
      },
    }),
  }).catch(err => console.error("[gateway] sendList error:", err));
}

// ─── Parse webhook payload ─────────────────────────────────────────────────

function parseWebhook(payload: Record<string, unknown>): { phone: string; messageType: string; text: string; interactiveId: string } | null {
  try {
    const entry = (payload.entry as Array<Record<string, unknown>>)?.[0];
    const changes = (entry?.changes as Array<Record<string, unknown>>)?.[0];
    const value = changes?.value as Record<string, unknown>;
    const messages = value?.messages as Array<Record<string, unknown>>;
    if (!messages?.[0]) return null;

    const msg = messages[0];
    const phone = msg.from as string;
    const messageType = msg.type as string;
    const text = messageType === "text" ? ((msg.text as Record<string, string>)?.body || "").trim() : "";

    let interactiveId = "";
    if (messageType === "interactive") {
      const interactive = msg.interactive as Record<string, unknown>;
      const buttonReply = interactive?.button_reply as Record<string, string>;
      const listReply = interactive?.list_reply as Record<string, string>;
      interactiveId = buttonReply?.id || listReply?.id || "";
    }

    return { phone, messageType, text, interactiveId };
  } catch {
    return null;
  }
}

// ─── GET: Meta webhook verification ────────────────────────────────────────

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;
  console.log("[gateway] Verify attempt:", { mode, token, expectedToken: expectedToken ? "set" : "NOT SET" });

  if (mode === "subscribe" && token === expectedToken) {
    console.log("[gateway] Webhook verified");
    return new Response(challenge || "", { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

// ─── POST: Route incoming message ──────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();
    const parsed = parseWebhook(payload);

    if (!parsed) {
      // Status update or non-message event
      // Forward to all registered SaaS (they might need delivery receipts)
      return NextResponse.json({ status: "ok" });
    }

    const { phone, text, interactiveId } = parsed;
    const supabase = getSupabase();
    const configs = getSaaSConfigs();

    // ── Handle SaaS selection callback ──────────────────────────────
    if (interactiveId.startsWith("saas:")) {
      const selectedKey = interactiveId.replace("saas:", "");

      await supabase.from("saas_active_session").upsert({
        phone,
        active_saas_key: selectedKey,
        updated_at: new Date().toISOString(),
      });

      const config = configs.find(c => c.key === selectedKey);
      if (config) {
        console.log(`[gateway] ${phone} selected ${selectedKey}, forwarding`);
        await forwardToSaaS(config.webhookUrl, payload);
      }

      return NextResponse.json({ status: "ok" });
    }

    // ── Switch request ("degistir", "switch") → show menu ──────────
    const switchKeywords = ["degistir", "değiştir", "switch", "sistem", "saas"];
    const isSwitchRequest = switchKeywords.some(k => text.toLowerCase() === k);

    // Look up user's registered SaaS
    const { data: registrations } = await supabase
      .from("saas_phone_registry")
      .select("saas_key")
      .eq("phone", phone);

    const registeredKeys = registrations?.map(r => r.saas_key) || [];

    if (isSwitchRequest && registeredKeys.length > 0) {
      const allKeys = [...new Set(["emlak", ...registeredKeys])];
      const menuItems = allKeys
        .map(k => {
          const cfg = configs.find(c => c.key === k);
          return cfg ? { id: `saas:${k}`, title: cfg.label.substring(0, 20) } : null;
        })
        .filter(Boolean) as Array<{ id: string; title: string }>;

      if (menuItems.length <= 3) {
        await sendButtonMessage(phone, "Hangi sisteme erişmek istiyorsunuz?", menuItems);
      } else {
        await sendListMessage(phone, "Hangi sisteme erişmek istiyorsunuz?", "Sistemler", menuItems);
      }

      return NextResponse.json({ status: "ok" });
    }

    // ── Check active session → route to correct SaaS ───────────────
    if (registeredKeys.length > 0) {
      const { data: activeSession } = await supabase
        .from("saas_active_session")
        .select("active_saas_key")
        .eq("phone", phone)
        .maybeSingle();

      const activeKey = activeSession?.active_saas_key;

      if (activeKey) {
        const config = configs.find(c => c.key === activeKey);
        if (config) {
          console.log(`[gateway] Routing ${phone} → ${activeKey}`);
          await forwardToSaaS(config.webhookUrl, payload);
          return NextResponse.json({ status: "ok" });
        }
      }
    }

    // ── Default: forward to emlak (or first configured SaaS) ───────
    const defaultConfig = configs.find(c => c.key === "emlak") || configs[0];
    if (defaultConfig) {
      console.log(`[gateway] Default routing ${phone} → ${defaultConfig.key}`);
      await forwardToSaaS(defaultConfig.webhookUrl, payload);
    }

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    console.error("[gateway] Error:", err);
    return NextResponse.json({ status: "ok" }); // Always 200 for Meta
  }
}

// ─── Forward payload to SaaS webhook ───────────────────────────────────────

async function forwardToSaaS(webhookUrl: string, payload: unknown) {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[gateway] Forward to ${webhookUrl} failed: ${res.status}`);
    }
  } catch (err) {
    console.error(`[gateway] Forward to ${webhookUrl} error:`, err);
  }
}
