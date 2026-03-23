import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    hasVerifyToken: !!process.env.WHATSAPP_VERIFY_TOKEN,
    verifyTokenLength: process.env.WHATSAPP_VERIFY_TOKEN?.length || 0,
    hasSaasKeys: !!process.env.SAAS_KEYS,
    saasKeys: process.env.SAAS_KEYS || "NOT SET",
    hasSupabaseUrl: !!process.env.SUPABASE_URL,
  });
}
