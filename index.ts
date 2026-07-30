// ============================================================
// Supabase Edge Function: ai-chat (Gemini + pencarian gardu
// terdekat berdasarkan lokasi yang disebut user)
// ============================================================

// deno-lint-ignore-file no-explicit-any
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_MODEL    = "gemini-flash-latest";

// Disediakan OTOMATIS oleh Supabase Edge Functions — tidak perlu diset manual
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function callGemini(system: string, contents: any[]) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents }),
    }
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("\n").trim() || "";
}

// ── Deteksi apakah user menyebut lokasi & minta gardu terdekat ──
async function extractLocation(userMessage: string): Promise<string | null> {
  const sys =
    'Kamu adalah classifier. Baca satu pesan user. Jika dia menyebutkan sedang berada ' +
    'di suatu lokasi/daerah dan menanyakan gardu apa saja di sekitar/dekat situ, balas ' +
    'HANYA dengan JSON murni seperti {"lokasi":"nama lokasi yang disebut"} (ambil nama ' +
    'daerah/jalan yang disebut apa adanya). Jika tidak ada permintaan seperti itu, balas ' +
    'HANYA {"lokasi":null}. Jangan tambahkan penjelasan atau markdown apa pun.';
  try {
    const raw = await callGemini(sys, [{ role: "user", parts: [{ text: userMessage }] }]);
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed.lokasi === "string" && parsed.lokasi.trim() ? parsed.lokasi.trim() : null;
  } catch {
    return null;
  }
}

// ── Geocoding gratis via OpenStreetMap Nominatim ──
async function geocode(lokasi: string): Promise<{ lat: number; lon: number; label: string } | null> {
  const attempts = [`${lokasi}, Jayapura, Papua, Indonesia`, `${lokasi}, Papua, Indonesia`];
  for (const q of attempts) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=id&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { "User-Agent": "PLN-UP3-Jayapura-ManajemenGardu/1.0 (internal tool)" } });
      if (!res.ok) continue;
      const arr = await res.json();
      if (arr && arr.length) return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), label: arr[0].display_name };
    } catch { /* coba varian berikutnya */ }
  }
  return null;
}

// ── Ambil semua gardu yang punya koordinat, langsung dari database ──
async function fetchGarduBerkoordinat() {
  const url = `${SUPABASE_URL}/rest/v1/v_gardu_lengkap?select=no_gardu,ulp,penyulang,alamat,latitude,longitude&latitude=not.is.null&longitude=not.is.null&limit=5000`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_SERVICE_KEY || "", Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!res.ok) return [];
  return await res.json();
}

// ── Jarak garis lurus (haversine) dalam km ──
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!GEMINI_API_KEY) return jsonResponse({ error: "GEMINI_API_KEY belum diset di Supabase secrets." }, 500);

  try {
    const body = await req.json();
    let system: string = typeof body.system === "string" ? body.system : "";
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];

    if (system.length > 20000) return jsonResponse({ error: "Konteks terlalu besar." }, 400);
    if (messages.length === 0 || messages.length > 20) return jsonResponse({ error: "Jumlah pesan tidak valid." }, 400);

    const cleanMessages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content).slice(0, 4000) }] }));

    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMsg && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      const lokasi = await extractLocation(String(lastUserMsg.content || ""));
      if (lokasi) {
        const titik = await geocode(lokasi);
        if (titik) {
          const semuaGardu = await fetchGarduBerkoordinat();
          const terdekat = semuaGardu
            .map((g: any) => ({
              noGardu: g.no_gardu, ulp: g.ulp, penyulang: g.penyulang, alamat: g.alamat,
              jarakKm: haversineKm(titik.lat, titik.lon, parseFloat(g.latitude), parseFloat(g.longitude)),
            }))
            .sort((a: any, b: any) => a.jarakKm - b.jarakKm)
            .slice(0, 15);

          let tambahan = `\n\n--- GARDU TERDEKAT DARI LOKASI "${lokasi}" (perkiraan garis lurus, BUKAN jarak jalan sebenarnya) ---\n`;
          tambahan += `Lokasi ditemukan sebagai: ${titik.label}\n`;
          terdekat.forEach((g: any) => { tambahan += `${g.noGardu} | ${g.ulp} | ${g.penyulang} | ${g.alamat} | ~${g.jarakKm.toFixed(1)} km\n`; });
          tambahan += 'Catatan: jarak ini garis lurus (udara), bukan jarak tempuh jalan raya. Sampaikan itu ke user kalau relevan.';
          system += tambahan;
        } else {
          system += `\n\n(Catatan: user menyebut lokasi "${lokasi}" tapi sistem tidak menemukan koordinatnya. Beritahu user dengan sopan, minta sebutkan nama daerah/jalan yang lebih spesifik.)`;
        }
      }
    }

    const reply = await callGemini(system, cleanMessages);
    return jsonResponse({ reply: reply || "Maaf, tidak ada balasan." });
  } catch (err) {
    return jsonResponse({ error: "Request tidak valid: " + (err as Error).message }, 400);
  }
});