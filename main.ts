const GH_TOKEN = Deno.env.get("GH_TOKEN") || "";
const BAIDU_KEY = Deno.env.get("BAIDU_API_KEY") || "rrJI9DRyudEBu7NdN6JO37i1";
const BAIDU_SECRET = Deno.env.get("BAIDU_SECRET_KEY") || "K53an5SVXnI7NS4yFq8hifX53d4hmqLW";
const OWNER = "haohao2006888";
const REPO = "tongxingzhe-survey";
const PATH = "data/submissions.json";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;

// ── Baidu token cache ──
let baiduToken = "";
let baiduTokenExpiry = 0;

async function getBaiduToken(): Promise<string> {
  if (baiduToken && Date.now() < baiduTokenExpiry) return baiduToken;
  if (!BAIDU_KEY || !BAIDU_SECRET) return "";
  try {
    const resp = await fetch(
      `https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${BAIDU_KEY}&client_secret=${BAIDU_SECRET}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" } }
    );
    const data = await resp.json();
    if (data.access_token) {
      baiduToken = data.access_token as string;
      baiduTokenExpiry = Date.now() + (data.expires_in || 2592000) * 1000 - 60000;
      return baiduToken;
    }
  } catch { /* ignore */ }
  return baiduToken;
}

function utf8ToB64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64ToUtf8(str: string): string {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Strip audio/base64 fields for lightweight GET responses */
function stripAudio(submissions: Record<string, unknown>[]) {
  return submissions.map((s) => {
    const { bio_audio, part1_audio, part2_audio, part3_audio, ua, ...rest } = s as Record<string, unknown>;
    return rest;
  });
}

/** Extract audio fields from a payload, return { text, audio } */
function splitAudio(payload: Record<string, unknown>): {
  text: Record<string, unknown>;
  audio: Record<string, string>;
} {
  const text: Record<string, unknown> = {};
  const audio: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k.endsWith("_audio") && typeof v === "string") {
      audio[k] = v;
    } else {
      text[k] = v;
    }
  }
  return { text, audio };
}

/** Upload a single audio file to GitHub data/audio/ */
async function uploadAudioFile(
  userName: string,
  key: string,
  content: string,
): Promise<boolean> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = String(userName).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "_").slice(0, 20);
  const filePath = `data/audio/${safeName}_${key}_${ts}.txt`;
  const audioApi = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${filePath}`;

  // Check if file exists (for SHA)
  let sha = "";
  try {
    const checkResp = await fetch(audioApi, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    });
    if (checkResp.ok) {
      const checkData = await checkResp.json();
      sha = checkData.sha || "";
    }
  } catch { /* file doesn't exist, that's fine */ }

  const body: Record<string, string> = {
    message: `🎤 ${userName} - ${key}`,
    content: utf8ToB64(content),
    branch: "main",
  };
  if (sha) body.sha = sha;

  const putResp = await fetch(audioApi, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return putResp.ok;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") return new Response(null, { headers });

  // ── POST /stt: speech-to-text via Baidu API ──
  if (req.method === "POST" && path === "/stt") {
    try {
      const { audio, format, rate, lang } = await req.json();
      if (!audio) {
        return new Response(JSON.stringify({ error: "Missing audio data" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const token = await getBaiduToken();
      if (!token) {
        return new Response(JSON.stringify({ error: "Baidu API not configured" }), {
          status: 502, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      // dev_pid: 1537=Mandarin, 1737=English
      const devPid = lang === "en" ? 1737 : 1537;
      const cuid = "proxy-" + Date.now();
      const params = new URLSearchParams({ cuid, token, dev_pid: String(devPid) });
      // Decode base64 PCM to raw bytes
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
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: result.err_msg || "unknown", code: result.err_no }), {
        status: 502, headers: { ...headers, "Content-Type": "application/json" },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 500, headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  }

  // ── GET: return text-only submissions (no audio base64) ──
  if (req.method === "GET") {
    try {
      const getResp = await fetch(API, {
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" },
      });
      if (!getResp.ok) {
        return new Response(JSON.stringify({ error: `GitHub API: ${getResp.status}` }), {
          status: 502,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const data = await getResp.json();
      const submissions: Record<string, unknown>[] = data.content
        ? JSON.parse(b64ToUtf8(data.content))
        : [];
      const lite = stripAudio(submissions);
      return new Response(JSON.stringify(lite), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  }

  // ── PUT /part4: update founder annotation ──
  if (req.method === "PUT" && path === "/part4") {
    try {
      const { name, time, part4_text } = await req.json();
      if (!name || !part4_text) {
        return new Response(JSON.stringify({ error: "Missing name or part4_text" }), {
          status: 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      const getResp = await fetch(API, {
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" },
      });
      if (!getResp.ok) {
        return new Response(JSON.stringify({ error: `GitHub API GET: ${getResp.status}` }), {
          status: 502,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const data = await getResp.json();
      const submissions: Record<string, unknown>[] = data.content
        ? JSON.parse(b64ToUtf8(data.content))
        : [];
      const sha = data.sha;

      // Find matching submission by name + time
      const idx = submissions.findIndex(
        (s) => (s as Record<string, unknown>).userName === name || (s as Record<string, unknown>).name === name
      );
      if (idx === -1) {
        return new Response(JSON.stringify({ error: "Submission not found" }), {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      // Update part4_text
      submissions[idx] = { ...submissions[idx], part4_text, _part4_updated: new Date().toISOString() };

      const encoded = utf8ToB64(JSON.stringify(submissions, null, 2));

      const putResp = await fetch(API, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `✍️ 创始人批注: ${name} (${new Date().toISOString().slice(0, 10)})`,
          content: encoded,
          sha,
          branch: "main",
        }),
      });
      const result = await putResp.json();

      return new Response(
        JSON.stringify({ success: !!result.content, index: idx }),
        { headers: { ...headers, "Content-Type": "application/json" } },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: msg }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  }

  // ── POST: append new submission ──
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await req.json();
    const userName = String(payload.userName || payload.name || "?");

    // Split audio from text — audio stored as separate small files
    const { text, audio } = splitAudio(payload);

    // Upload audio files in parallel (non-blocking for submission)
    const audioUploads: Promise<boolean>[] = [];
    for (const [key, content] of Object.entries(audio)) {
      audioUploads.push(uploadAudioFile(userName, key, content));
    }

    // Update submissions.json with text-only payload
    const getResp = await fetch(API, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    });
    const data = await getResp.json();
    const submissions: Record<string, unknown>[] = data.content
      ? JSON.parse(b64ToUtf8(data.content))
      : [];
    const sha = data.sha;

    submissions.push({ ...text, _received: new Date().toISOString(), _audio_saved: Object.keys(audio).length });

    const encoded = utf8ToB64(JSON.stringify(submissions, null, 2));

    const putResp = await fetch(API, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `📝 ${userName} (${new Date().toISOString().slice(0, 10)})`,
        content: encoded,
        sha,
        branch: "main",
      }),
    });
    const result = await putResp.json();

    // Wait for audio uploads to complete
    const audioResults = await Promise.allSettled(audioUploads);
    const audioOk = audioResults.filter((r) => r.status === "fulfilled" && r.value).length;

    return new Response(
      JSON.stringify({ success: !!result.content, count: submissions.length, audio_saved: audioOk }),
      { headers: { ...headers, "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" } },
    );
  }
});
