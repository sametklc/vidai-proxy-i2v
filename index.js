// vidai-proxy-i2v / index.js  (clean-i2v)
import express from "express";
import cors from "cors";
import multer from "multer";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use((req, _res, next) => {
  console.log("[INGRESS]", req.method, req.path, "ct=", req.headers["content-type"]);
  next();
});

const upload = multer(); // memoryStorage

// ==== ENV ====
const PORT = process.env.PORT || 3000;
const FAL_API_KEY = process.env.FAL_API_KEY;
// i2v default modeli (istersen Render env'de FAL_MODEL ile değiştir)
const FAL_MODEL = process.env.FAL_MODEL || "fal-ai/veo2/image-to-video";
const USE_QUEUE = process.env.FAL_USE_QUEUE === "0" ? false : true;

const FAL_DIRECT = "https://fal.run";
const FAL_QUEUE  = "https://queue.fal.run";

function submitUrl(modelId) {
  return USE_QUEUE ? `${FAL_QUEUE}/${modelId}/requests` : `${FAL_DIRECT}/${modelId}`;
}
// "fal-ai/veo2/image-to-video" -> "fal-ai/veo2"
function baseModelId(modelId) {
  const p = (modelId || "").split("/");
  return p.length >= 2 ? `${p[0]}/${p[1]}` : modelId;
}
function toDataUrl(buf, mime = "application/octet-stream") {
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}
function pickVideoUrl(any) {
  const r = any?.response || any;
  const cands = [
    r?.video_url,
    r?.video?.url,
    r?.videos?.[0]?.url,
    r?.output?.[0]?.url,
    r?.data?.video_url,
    r?.media?.[0]?.url,
  ].filter(Boolean);
  return cands[0] || null;
}
async function falPostJSONSubmit(modelId, body) {
  const url = submitUrl(modelId);
  const headers = { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" };

  const mask = JSON.parse(JSON.stringify(body));
  if (mask?.input?.image_url) mask.input.image_url = "[[base64]]";
  console.log("[FAL SUBMIT]", { url, modelId, use_queue: USE_QUEUE, body: mask });

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const txt = await res.text().catch(() => "");
  if (!res.ok) {
    console.error("[FAL SUBMIT ERR]", res.status, txt?.slice?.(0, 200));
    throw new Error(`Fal HTTP ${res.status} ${txt}`);
  }
  try { return JSON.parse(txt); } catch { return { response: txt }; }
}

app.get("/healthz", (_req, res) => res.json({
  ok: true, service: "i2v", version: "clean-i2v", model: FAL_MODEL, use_queue: USE_QUEUE
}));
app.get("/", (_req, res) => res.send("OK i2v"));

app.get("/test-i2v", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`
    <h3>Image → Video</h3>
    <form method="POST" action="/video/generate_image" enctype="multipart/form-data">
      <div>Prompt: <input name="prompt" style="width:400px" value="cinematic zoom out"/></div>
      <div>Image: <input type="file" name="image" accept="image/*"/></div>
      <button type="submit">Submit</button>
    </form>
  `);
});

// === Generate (image -> video)
app.post("/video/generate_image", upload.single("image"), async (req, res) => {
  try {
    console.log("[I2V IN] file?", !!req.file, req.file ? { size: req.file.size, mime: req.file.mimetype } : null);
    const prompt = (req.body.prompt || "").trim();
    console.log("[I2V IN] prompt len:", prompt.length);

    if (!prompt) return res.status(400).json({ error: "prompt required" });
    if (!req.file) return res.status(400).json({ error: "image file required" });
    if (req.file.size > 3_900_000) return res.status(413).json({ error: "Image too large (<3.9MB)." });

    const image_url = toDataUrl(req.file.buffer, req.file.mimetype);
    const payload = { input: { prompt, image_url } };

    const data = await falPostJSONSubmit(FAL_MODEL, payload);

    if (USE_QUEUE) {
      console.log("[I2V QUEUED]", { request_id: data.request_id, status_url: data.status_url });
      return res.json({
        request_id:   data.request_id,
        status_url:   data.status_url,
        response_url: data.response_url
      });
    } else {
      const video_url = pickVideoUrl(data);
      return res.json({ video_url, raw: data });
    }
  } catch (e) {
    console.error("[I2V ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// === Result (poll)
app.get("/video/result/:id?", async (req, res) => {
  try {
    const headers = { Authorization: `Key ${FAL_API_KEY}` };
    const statusUrl = req.query.status_url;

    let statusResp, statusUrlUsed = null;
    if (statusUrl) {
      statusUrlUsed = statusUrl;
      console.log("[RESULT] via status_url:", statusUrl);
      statusResp = await fetch(statusUrl, { headers });
    } else {
      const id = req.params.id;
      if (!id) return res.status(400).json({ error: "status_url or id required" });
      const url = `${FAL_QUEUE}/${baseModelId(FAL_MODEL)}/requests/${id}/status`;
      statusUrlUsed = url;
      console.log("[RESULT] via id:", id, " url:", url);
      statusResp = await fetch(url, { headers });
    }

    const statusTxt = await statusResp.text().catch(() => "");
    if (!statusResp.ok) {
      console.error("[RESULT ERR]", statusResp.status, statusTxt?.slice?.(0, 200));
      return res.status(statusResp.status).send(statusTxt || "error");
    }

    let statusData; try { statusData = JSON.parse(statusTxt); } catch { statusData = { response: statusTxt }; }
    const status = statusData?.status || statusData?.response?.status || "";
    let video_url = pickVideoUrl(statusData);

    const done = (s) => ["COMPLETED","SUCCEEDED","succeeded","completed"].includes((s||"").toUpperCase());
    if (done(status) && !video_url) {
      const respUrl =
        statusData?.response_url ||
        statusData?.response?.response_url ||
        (statusUrlUsed?.endsWith("/status") ? statusUrlUsed.replace(/\/status$/, "") : null);

      if (respUrl) {
        console.log("[RESULT] fetch response_url:", respUrl);
        const r2 = await fetch(respUrl, { headers });
        const txt2 = await r2.text().catch(() => "");
        if (!r2.ok) {
          console.error("[RESULT RESP ERR]", r2.status, txt2?.slice?.(0, 200));
          return res.status(r2.status).send(txt2 || "error");
        }
        let respData; try { respData = JSON.parse(txt2); } catch { respData = { response: txt2 }; }
        const resolvedUrl = pickVideoUrl(respData);
        if (resolvedUrl) video_url = resolvedUrl;
        return res.json({ status, video_url, raw: respData });
      }
    }

    return res.json({ status, video_url, raw: statusData });
  } catch (e) {
    console.error("[RESULT ERROR]", e.message);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log("i2v server on:", PORT, { model: FAL_MODEL, USE_QUEUE });
});
