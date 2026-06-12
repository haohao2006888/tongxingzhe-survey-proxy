// Vercel Node.js serverless — Baidu speech-to-text proxy
// Uses global fetch() (Node 18+), no require('https')

const BAIDU_KEY = "rrJI9DRyudEBu7NdN6JO37i1";
const BAIDU_SECRET = "K53an5SVXnI7NS4yFq8hifX53d4hmqLW";

let baiduToken = "";
let baiduTokenExpiry = 0;

async function getBaiduToken() {
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
      console.log("Baidu token OK, expires in", data.expires_in);
      return baiduToken;
    }
    console.error("Baidu token error:", JSON.stringify(data));
  } catch (e) {
    console.error("Baidu token fetch error:", e.message);
  }
  return baiduToken;
}

/** Read request body as JSON */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

module.exports = async function handler(req, res) {
  // ── CORS ──
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }

  // ── GET: health check ──
  if (req.method === "GET") {
    res.status(200).json({ ok: true, service: "tongxingzhe-stt-proxy", ready: !!baiduToken });
    return;
  }

  // ── POST: speech-to-text ──
  if (req.method === "POST") {
    try {
      const rawBody = Buffer.concat(await (async () => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        return chunks;
      })()).toString();

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch (parseErr) {
        console.error("JSON parse error:", parseErr.message, "raw:", rawBody.slice(0, 200));
        res.status(400).json({ error: "Invalid JSON", detail: parseErr.message });
        return;
      }

      const { audio, format, rate, lang, dev_pid } = body;

      if (!audio) {
        res.status(400).json({ error: "Missing audio data" });
        return;
      }

      console.log("STT request: audio_len=" + audio.length + ", format=" + format + ", rate=" + rate + ", lang=" + lang);

      const token = await getBaiduToken();
      if (!token) {
        res.status(502).json({ error: "Baidu API not configured - token fetch failed" });
        return;
      }

      // dev_pid: client-specified or fallback (1537=Mandarin, 1737=English)
      const devPid = dev_pid || (lang === "en" ? 1737 : 1537);
      const cuid = "proxy-" + Date.now();
      const params = new URLSearchParams({ cuid, token, dev_pid: String(devPid) });

      // Decode base64 PCM to raw bytes
      let bytes;
      try {
        bytes = Buffer.from(audio, "base64");
      } catch (b64err) {
        console.error("Base64 decode error:", b64err.message);
        res.status(400).json({ error: "Invalid base64 audio", detail: b64err.message });
        return;
      }

      console.log("PCM bytes:", bytes.length, "sending to Baidu...");

      const baiduResp = await fetch(`http://vop.baidu.com/server_api?${params}`, {
        method: "POST",
        headers: {
          "Content-Type": `audio/${format || "pcm"}; rate=${rate || 16000}`,
          "Content-Length": String(bytes.length),
        },
        body: bytes,
      });
      const result = await baiduResp.json();
      console.log("Baidu response: err_no=" + result.err_no + ", err_msg=" + result.err_msg);

      if (result.err_no === 0 && result.result) {
        const text = Array.isArray(result.result) ? result.result[0] : result.result;
        res.status(200).json({ text: text || "" });
        return;
      }
      res.status(502).json({
        error: result.err_msg || "Baidu API returned no result",
        code: result.err_no,
        server_err: result.err_msg
      });
    } catch (e) {
      console.error("STT handler error:", e.message, e.stack);
      res.status(500).json({ error: e.message || "Internal server error" });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
};
