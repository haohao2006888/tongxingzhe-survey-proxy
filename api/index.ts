const BAIDU_KEY = "rrJI9DRyudEBu7NdN6JO37i1";
const BAIDU_SECRET = "K53an5SVXnI7NS4yFq8hifX53d4hmqLW";

let baiduToken = "";
let baiduTokenExpiry = 0;

async function getBaiduToken(): Promise<string> {
  if (baiduToken && Date.now() < baiduTokenExpiry) return baiduToken;
  try {
    const resp = await fetch(
      `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_KEY}&client_secret=${BAIDU_SECRET}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" } }
    );
    const data = await resp.json();
    if (data.access_token) {
      baiduToken = data.access_token;
      baiduTokenExpiry = Date.now() + (data.expires_in || 2592000) * 1000 - 60000;
      return baiduToken;
    }
  } catch { /* ignore */ }
  return baiduToken;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  // POST /stt: speech-to-text via Baidu API
  if (req.method === "POST" && path.startsWith("/stt")) {
    try {
      const { audio, format, rate, lang } = await req.json();
      if (!audio) {
        return new Response(JSON.stringify({ error: "Missing audio data" }), {
          status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }
      const token = await getBaiduToken();
      if (!token) {
        return new Response(JSON.stringify({ error: "Baidu API not configured" }), {
          status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }
      const devPid = lang === "en" ? 1737 : 1537;
      const cuid = "proxy-" + Date.now();
      const params = new URLSearchParams({ cuid, token, dev_pid: String(devPid) });
      const binary = atob(audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const baiduResp = await fetch(`http://vop.baidu.com/server_api?${params}`, {
        method: "POST",
        headers: {
          "Content-Type": `audio/${format || "pcm"}; rate=${rate || 16000}`,
          "Content-Length": String(bytes.length),
        },
        body: bytes,
      });
      const result = await baiduResp.json();
      if (result.err_no === 0 && result.result) {
        const text = Array.isArray(result.result) ? result.result[0] : result.result;
        return new Response(JSON.stringify({ text: text || "" }), {
          headers: { ...corsHeaders(), "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: result.err_msg || "unknown" }), {
        status: 502, headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" },
      });
    }
  }

  // Health check
  return new Response(JSON.stringify({ ok: true, path }), {
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}
