// ============================================================
// Supabase Edge Function: ai-chat
// File ini di-deploy ke Supabase (bukan disajikan ke browser),
// jadi API key Claude tidak pernah terlihat oleh user.
// Lihat "PANDUAN-SETUP-AI.md" untuk cara deploy & konfigurasi.
// ============================================================

// deno-lint-ignore-file no-explicit-any
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ANTHROPIC_MODEL   = "claude-sonnet-4-6"; // model yang dipakai untuk chat

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // ganti dgn domain aplikasi Anda untuk lebih aman
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY belum diset di Supabase secrets." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const system: string = typeof body.system === "string" ? body.system : "";
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];

    // Batasi ukuran payload sederhana (anti-abuse dasar)
    if (system.length > 20000) {
      return new Response(JSON.stringify({ error: "Konteks terlalu besar." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (messages.length === 0 || messages.length > 20) {
      return new Response(JSON.stringify({ error: "Jumlah pesan tidak valid." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const cleanMessages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        system: system,
        messages: cleanMessages,
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: "Gagal menghubungi Claude API (" + anthropicRes.status + ")", detail: errText }),
        { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const data = await anthropicRes.json();
    const reply = (data.content || [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim() || "Maaf, tidak ada balasan.";

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Request tidak valid: " + (err as Error).message }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
