/**
 * SurviMind · AI Analysis Worker (Cloudflare Workers)
 *
 * ตัวกลางระหว่างหน้าเว็บกับ Google Gemini
 * - เก็บ GEMINI_API_KEY ไว้ฝั่งเซิร์ฟเวอร์ ผู้เล่นมองไม่เห็น key
 * - สร้างคำสั่ง (prompt) ที่ฝั่งนี้ทั้งหมด หน้าเว็บส่งมาได้แค่ข้อมูลการเล่น
 *   จึงเอา Worker นี้ไปใช้เป็นแชตบอตฟรีไม่ได้
 * - รับเฉพาะคำขอจากเว็บของทีม (ALLOWED_ORIGINS)
 *
 * ตั้งค่าใน Cloudflare (Settings → Variables and Secrets):
 *   GEMINI_API_KEY   (Secret, จำเป็น)  key จาก Google AI Studio
 *   ALLOWED_ORIGINS  (Text, ไม่บังคับ) ค่าเริ่มต้น https://survimind.github.io
 *   GEMINI_MODELS    (Text, ไม่บังคับ) ชื่อโมเดลคั่นด้วยจุลภาค ลองตามลำดับ
 *                    ค่าเริ่มต้น gemini-3.5-flash-lite,gemini-3.8-flash
 *   TEACHER_KEY      (Secret, สำหรับห้องอาจารย์) รหัสที่อาจารย์ใช้ดูผลของนักศึกษา
 *   SESSIONS         (KV namespace binding, สำหรับห้องอาจารย์) ที่เก็บผลการเล่นของนักศึกษา
 *
 * ห้องอาจารย์ (mode):
 *   save  → บันทึก/อัปเดตผลการเล่น 1 รอบ (ไม่ต้องใช้รหัส · รับเฉพาะฟิลด์ที่กำหนด · ไม่รับข้อมูลส่วนตัวอื่น)
 *   list  → รายการผลทั้งหมดแบบย่อ (ต้องใช้ TEACHER_KEY)
 *   get   → ผลเต็มของ 1 รอบ (ต้องใช้ TEACHER_KEY)
 */

const DEFAULT_ORIGINS = "https://survimind.github.io";
const DEFAULT_MODELS = "gemini-3.5-flash-lite,gemini-3.8-flash";
const MAX_BODY = 90000;

const SYSTEM = `คุณเป็นโค้ชการเรียนสำหรับนักศึกษามหาวิทยาลัยไทย
คุณจะได้รับข้อมูลพฤติกรรมจากเกมจำลองสถานการณ์วิกฤต (เอาตัวรอดจากซอมบี้ หลงป่า หรือสึนามิ)
หน้าที่ของคุณคือตีความพฤติกรรมการตัดสินใจ แล้วแนะนำการพัฒนาการเรียน การจัดการเวลา การจัดการความเครียด และการทำงานกลุ่มในชีวิตมหาวิทยาลัย

กฎ:
1. ทุกข้อสังเกตต้องอ้างข้อมูลจริงจาก JSON เช่น ชื่อสถานการณ์ เวลาตัดสินใจเป็นวินาที จำนวนครั้งที่เปลี่ยนใจ คะแนน EF อย่างน้อย 3 จุดในทั้งรายงาน
2. ห้ามแต่งข้อมูลหรือเหตุการณ์ที่ไม่มีใน JSON
3. ห้ามวินิจฉัยโรค ภาวะทางจิตใจ หรือบุคลิกภาพผิดปกติ ใช้คำว่า "แนวโน้ม" หรือ "รูปแบบ" แทน
4. ถ้าข้อมูลบ่งชี้แรงกดดันสูงมาก (panic สูง, ชะงักบ่อย, stress reflex ต่ำ) ให้ใส่คำแนะนำหนึ่งข้อใน stress_tips ว่าสามารถคุยกับศูนย์ให้คำปรึกษาของมหาวิทยาลัย หรือโทรสายด่วนสุขภาพจิต 1323 ได้
5. ใช้ภาษาไทยเป็นกันเอง ให้กำลังใจ ไม่ตัดสิน เรียกผู้เล่นว่า "คุณ"
6. คำแนะนำต้องเจาะจงกับชีวิตนักศึกษา และทำได้จริงภายในสัปดาห์นี้
7. เกมนี้เป็นเครื่องมือสะท้อนตัวเอง ไม่ใช่แบบทดสอบทางจิตวิทยา อย่าพูดเกินข้อมูล
8. ตอบเป็น JSON เท่านั้น ตาม schema ที่กำหนด ไม่มีข้อความอื่นนอก JSON`;

const SCHEMA_HINT = `ตอบเป็น JSON รูปแบบนี้เท่านั้น:
{
  "summary": "สรุปภาพรวม 2-3 ประโยค",
  "key_moments": [ { "scene": "ชื่อสถานการณ์จากข้อมูล", "observation": "สิ่งที่สังเกตจากข้อมูล พร้อมตัวเลข", "meaning": "ความหมายต่อชีวิตมหาวิทยาลัย" } ],
  "strengths": ["จุดแข็ง พร้อมหลักฐานจากข้อมูล"],
  "growth_areas": ["จุดที่ควรพัฒนา พร้อมหลักฐานจากข้อมูล"],
  "study_strategies": ["กลยุทธ์การเรียนที่เหมาะกับคนนี้"],
  "stress_tips": ["วิธีจัดการความเครียด"],
  "seven_day_plan": [ { "day": 1, "action": "สิ่งที่ทำวันนั้น 1 ประโยค" } ],
  "group_work_role": "บทบาทที่เหมาะในงานกลุ่ม พร้อมเหตุผล"
}
จำนวน: key_moments 3 ข้อ, strengths 2-3 ข้อ, growth_areas 2-3 ข้อ, study_strategies 3 ข้อ, stress_tips 2-3 ข้อ, seven_day_plan 7 วัน`;

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const okOrigin = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : allowed[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return json({ ok: true, service: "survimind-ai", ai: !!env.GEMINI_API_KEY, storage: !!env.SESSIONS, teacherKey: !!env.TEACHER_KEY }, 200, cors);   // บอกแค่ว่าตั้งค่าครบไหม ไม่เปิดเผยค่าจริง
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);
    if (!okOrigin) return json({ ok: false, error: "forbidden_origin" }, 403, cors);

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ ok: false, error: "too_large" }, 413, cors);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "bad_json" }, 400, cors); }

    // ---- ห้องอาจารย์: เก็บและดูผลของนักศึกษา ----
    if (body && ["save", "list", "get", "feedback", "feedback_list"].includes(body.mode)) return teacherApi(body, env, cors);

    if (!env.GEMINI_API_KEY) return json({ ok: false, error: "missing_key" }, 500, cors);
    const player = sanitize(body && body.player);
    if (!player) return json({ ok: false, error: "bad_payload" }, 400, cors);
    const models = (env.GEMINI_MODELS || DEFAULT_MODELS).split(",").map((s) => s.trim()).filter(Boolean);

    // ---- โหมด AI Coach: แชตถามต่อ ----
    if (body.mode === "coach") {
      const messages = sanitizeMessages(body.messages);
      if (!messages) return json({ ok: false, error: "bad_messages" }, 400, cors);
      if (messages.filter((m) => m.role === "user").length > COACH_LIMIT) return json({ ok: false, error: "limit_reached" }, 429, cors);
      const context = "ข้อมูลการเล่นของผู้เล่น (JSON):\n" + JSON.stringify(player) +
        "\n\nรายงาน AI ที่ผู้เล่นได้รับแล้ว (JSON):\n" + JSON.stringify(sanitizeReport(body.report));
      const res = await callGemini(env, models, {
        systemInstruction: { parts: [{ text: COACH_SYSTEM + "\n\n" + context }] },
        contents: messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] })),
        generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
      }, (text) => { const t = String(text || "").trim(); return t ? t.slice(0, 2500) : null; });
      if (!res.ok) return json({ ok: false, error: res.error }, res.status, cors);
      return json({ ok: true, model: res.model, reply: res.value }, 200, cors);
    }

    // ---- โหมดวิเคราะห์ผล (ค่าเริ่มต้น) ----
    const prompt = "ข้อมูลการเล่นของผู้เล่น (JSON):\n" + JSON.stringify(player) + "\n\n" + SCHEMA_HINT;
    const res = await callGemini(env, models, {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.6, maxOutputTokens: 8192 },
    }, parseReport);
    if (!res.ok) return json({ ok: false, error: res.error }, res.status, cors);
    return json({ ok: true, model: res.model, report: res.value }, 200, cors);
  },
};

// เรียก Gemini ตามลำดับโมเดล ถ้าตัวแรกเต็มหรือผิดพลาดจะลองตัวถัดไป
async function callGemini(env, models, payload, parse) {
  let error = "ai_unavailable", status = 502;
  for (const model of models) {
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify(payload),
      });
    } catch {
      error = "network"; continue;
    }
    if (r.status === 429) { error = "rate_limited"; status = 429; continue; }
    if (!r.ok) { error = "ai_error_" + r.status; continue; }
    const out = await r.json().catch(() => null);
    const text = ((out && out.candidates && out.candidates[0] && out.candidates[0].content && out.candidates[0].content.parts) || [])
      .map((p) => (p && !p.thought && p.text) || "").join("");
    const value = parse(text);
    if (!value) { error = "bad_ai_output"; continue; }
    return { ok: true, model, value };
  }
  return { ok: false, error, status };
}

const COACH_LIMIT = 10;

const COACH_SYSTEM = `คุณคือ "AI Coach" โค้ชการเรียนสำหรับนักศึกษามหาวิทยาลัยไทย ในเว็บเกม SurviMind
ผู้เล่นเพิ่งเล่นเกมจำลองสถานการณ์วิกฤตจบ และอ่านรายงานวิเคราะห์ของตัวเองแล้ว ตอนนี้เขาถามคำถามต่อ

กฎ:
1. ตอบโดยอิงข้อมูลการเล่นและรายงานของผู้เล่นคนนี้ (บุคลิก MBTI, คะแนน EF, พฤติกรรมการตัดสินใจ) อ้างข้อมูลจริงอย่างน้อย 1 จุดเมื่อเกี่ยวข้อง
2. ตอบเฉพาะเรื่องการเรียน การอ่านหนังสือสอบ การจัดการเวลา การทำงานกลุ่ม การจัดการความเครียด และชีวิตในมหาวิทยาลัย ถ้าถามเรื่องอื่น ให้ตอบสุภาพสั้น ๆ ว่าช่วยได้เฉพาะเรื่องเหล่านี้ แล้วเสนอหัวข้อที่ถามได้
3. ห้ามวินิจฉัยโรค ภาวะทางจิตใจ หรือบุคลิกภาพผิดปกติ ใช้คำว่า "แนวโน้ม" หรือ "รูปแบบ"
4. ถ้าผู้เล่นพูดถึงความรู้สึกหมดหวัง อยากทำร้ายตัวเอง หรือไม่อยากมีชีวิตอยู่ ให้ตอบด้วยความเห็นใจ ไม่ตัดสิน บอกว่าเขาไม่ได้อยู่คนเดียว และแนะนำให้โทรสายด่วนสุขภาพจิต 1323 (ตลอด 24 ชั่วโมง) หรือคุยกับศูนย์ให้คำปรึกษาของมหาวิทยาลัย หรือคนที่ไว้ใจทันที ไม่ต้องให้คำแนะนำเรื่องการเรียนในคำตอบนั้น
5. ห้ามขอข้อมูลส่วนตัว เช่น ชื่อจริง รหัสนักศึกษา เบอร์โทร ถ้าผู้เล่นพิมพ์มาเอง ห้ามทวนซ้ำ
6. ใช้ภาษาไทยเป็นกันเอง ให้กำลังใจ เรียกผู้เล่นว่า "คุณ"
7. ตอบกระชับ ไม่เกินประมาณ 150 คำ ให้ขั้นตอนที่ทำได้จริง ถ้าเป็นแผนให้ใช้ข้อ 1. 2. 3. ขึ้นบรรทัดใหม่
8. ตอบเป็นข้อความธรรมดา ห้ามใช้ markdown เช่น ** หรือ #`;

function sanitizeMessages(list) {
  if (!Array.isArray(list) || !list.length || list.length > COACH_LIMIT * 2 + 1) return null;
  const out = [];
  for (const m of list) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string" || !m.text.trim()) return null;
    out.push({ role: m.role, text: m.text.trim().slice(0, m.role === "user" ? 500 : 2500) });
  }
  if (out[out.length - 1].role !== "user") return null;
  return out;
}

function sanitizeReport(r) {
  if (!r || typeof r !== "object") return {};
  const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  return {
    summary: s(r.summary, 800),
    strengths: strList(r.strengths, 4, 300),
    growth_areas: strList(r.growth_areas, 4, 300),
    study_strategies: strList(r.study_strategies, 5, 300),
    stress_tips: strList(r.stress_tips, 4, 300),
    group_work_role: s(r.group_work_role, 400),
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}

const str = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : typeof v === "number" || typeof v === "boolean" ? v : null);
const num = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 10) / 10 : null);

// รับเฉพาะ field ที่รู้จัก ตัดข้อความยาว และไม่มีข้อมูลส่วนตัว
function sanitize(p) {
  if (!p || typeof p !== "object") return null;
  const obj = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : {});
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, num(obj(o)[k]) ?? str(obj(o)[k], 120)]));
  const decisions = (Array.isArray(p.decisions) ? p.decisions : []).slice(0, 20).map((d) => ({
    n: num(obj(d).n), situation: str(obj(d).situation, 120), choice: str(obj(d).choice, 160),
    latency_s: num(obj(d).latency_s), switches: num(obj(d).switches), hints: num(obj(d).hints),
    panic_at: num(obj(d).panic_at), risky: !!obj(d).risky, item_used: str(obj(d).item_used, 60),
  }));
  if (!decisions.length && !p.mbti) return null;
  return {
    scenario: str(p.scenario, 60),
    character_role: str(p.character_role, 60),
    mbti: str(p.mbti, 4),
    mbti_percent: pick(p.mbti_percent, ["E", "S", "T", "J"]),
    executive_functions: pick(p.executive_functions, ["working_memory", "inhibitory_control", "cognitive_flexibility"]),
    end_meters: pick(p.end_meters, ["health", "infection", "panic"]),
    decision_style: pick(p.decision_style, ["avg_latency_s", "median_latency_s", "total_switches", "hints_used", "speed", "confidence", "pressure_effect", "stress_reflex", "qte_timeouts", "memory_probe"]),
    item_strategy: str(p.item_strategy, 80),
    rule_based_barriers: (Array.isArray(p.rule_based_barriers) ? p.rule_based_barriers : []).slice(0, 5).map((b) => str(b, 100)),
    decisions,
  };
}

const strList = (a, n, len = 400) => (Array.isArray(a) ? a.filter((x) => typeof x === "string" && x.trim()).slice(0, n).map((x) => x.slice(0, len)) : []);

function parseReport(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let o;
  try { o = JSON.parse(t); } catch {
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { o = JSON.parse(t.slice(a, b + 1)); } catch { return null; }
  }
  if (!o || typeof o !== "object" || typeof o.summary !== "string") return null;
  return {
    summary: o.summary.slice(0, 800),
    key_moments: (Array.isArray(o.key_moments) ? o.key_moments : []).slice(0, 5)
      .filter((m) => m && typeof m === "object")
      .map((m) => ({ scene: String(m.scene || "").slice(0, 120), observation: String(m.observation || "").slice(0, 400), meaning: String(m.meaning || "").slice(0, 400) })),
    strengths: strList(o.strengths, 4),
    growth_areas: strList(o.growth_areas, 4),
    study_strategies: strList(o.study_strategies, 5),
    stress_tips: strList(o.stress_tips, 4),
    seven_day_plan: (Array.isArray(o.seven_day_plan) ? o.seven_day_plan : []).slice(0, 7)
      .filter((d) => d && typeof d === "object")
      .map((d, i) => ({ day: Number(d.day) || i + 1, action: String(d.action || "").slice(0, 240) })),
    group_work_role: typeof o.group_work_role === "string" ? o.group_work_role.slice(0, 500) : "",
  };
}


// ================= ห้องอาจารย์ =================
const SESSION_TTL = 60 * 60 * 24 * 365;   // เก็บ 1 ปี แล้วลบอัตโนมัติ
const tStr = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);
const tNum = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : undefined);
function sameKey(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b) return false;
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
function cleanSession(s) {
  if (!s || typeof s !== "object") return null;
  const sid = tStr(s.sid, 40);
  if (!sid || !/^[A-Za-z0-9_-]+$/.test(sid)) return null;
  const out = { sid };
  const put = (k, v) => { if (v !== undefined && v !== null && v !== "") out[k] = v; };
  put("scenario", ["zombie", "forest", "disaster"].includes(s.scenario) ? s.scenario : undefined);
  put("character", ["ek", "waen", "fah", "bom", "uan"].includes(s.character) ? s.character : undefined);
  put("mbti", /^[EI][SN][TF][JP]$/.test(s.mbti || "") ? s.mbti : undefined);
  put("gender", tStr(s.gender, 20));
  put("age", tNum(s.age));
  put("device", tStr(s.device, 10));
  put("playerName", tStr(s.playerName, 40));
  put("code", tStr(s.code, 40));
  put("startedAt", tNum(s.startedAt));
  put("finishedAt", tNum(s.finishedAt));
  // ผลการเล่นเต็ม (คะแนน สภาพทีม พฤติกรรม) สำหรับเปิดหน้าผลลัพธ์ย้อนหลัง
  if (s.result && typeof s.result === "object") {
    const r = JSON.stringify(s.result);
    if (r.length <= 60000) out.result = JSON.parse(r);
  }
  return out;
}
function metaOf(r) {
  const tm = (r.result && r.result.summary) || {};
  return { t: r.finishedAt || r.startedAt || 0, sc: r.scenario, ch: r.character, mb: r.mbti, g: r.gender, a: r.age, n: r.playerName ? r.playerName.slice(0, 30) : undefined,
    lat: tNum(tm.avgLatency), sw: tNum(tm.totalSwitches), wm: tNum(tm.ef && tm.ef.wm), ic: tNum(tm.ef && tm.ef.ic), cf: tNum(tm.ef && tm.ef.cf),
    h: tNum(r.result && r.result.meters && r.result.meters.health), p: tNum(r.result && r.result.meters && r.result.meters.panic), done: !!r.finishedAt };
}
async function teacherApi(body, env, cors) {
  if (!env.SESSIONS) return json({ ok: false, error: "kv_missing" }, 503, cors);
  if (body.mode === "save") {
    const s = cleanSession(body.session);
    if (!s) return json({ ok: false, error: "bad_session" }, 400, cors);
    const key = "s:" + s.sid;
    let old = {};
    try { old = (await env.SESSIONS.get(key, "json")) || {}; } catch {}
    const rec = { ...old, ...s };
    await env.SESSIONS.put(key, JSON.stringify(rec), { expirationTtl: SESSION_TTL, metadata: metaOf(rec) });
    return json({ ok: true }, 200, cors);
  }
  if (body.mode === "feedback") {
    const f = body.feedback || {};
    const rating = Math.round(Number(f.rating));
    const text = tStr(f.text, 1000) || "";
    const tags = Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === "string").slice(0, 8).map((t) => t.slice(0, 30)) : [];
    if (!(rating >= 1 && rating <= 5) && !text.trim() && !tags.length) return json({ ok: false, error: "empty_feedback" }, 400, cors);
    const rec = { t: Date.now(), rating: rating >= 1 && rating <= 5 ? rating : undefined, text: text.trim() || undefined, tags,
      sid: tStr(f.sid, 40), scenario: ["zombie", "forest", "disaster"].includes(f.scenario) ? f.scenario : undefined,
      mbti: /^[EI][SN][TF][JP]$/.test(f.mbti || "") ? f.mbti : undefined, device: tStr(f.device, 10), where: tStr(f.where, 20) };
    const key = "f:" + String(rec.t).padStart(14, "0") + ":" + Math.random().toString(36).slice(2, 8);
    await env.SESSIONS.put(key, JSON.stringify(rec), { expirationTtl: SESSION_TTL });
    return json({ ok: true }, 200, cors);
  }
  if (!env.TEACHER_KEY) return json({ ok: false, error: "teacher_key_missing" }, 503, cors);
  if (!sameKey(String(body.key || ""), env.TEACHER_KEY)) return json({ ok: false, error: "wrong_key" }, 401, cors);
  if (body.mode === "get") {
    const sid = tStr(body.sid, 40);
    if (!sid) return json({ ok: false, error: "bad_sid" }, 400, cors);
    const rec = await env.SESSIONS.get("s:" + sid, "json");
    return rec ? json({ ok: true, session: rec }, 200, cors) : json({ ok: false, error: "not_found" }, 404, cors);
  }
  if (body.mode === "feedback_list") {
    const keys = [];
    let c;
    do {
      const page = await env.SESSIONS.list({ prefix: "f:", cursor: c, limit: 1000 });
      page.keys.forEach((k) => keys.push(k.name));
      c = page.list_complete ? undefined : page.cursor;
    } while (c && keys.length < 3000);
    keys.sort().reverse();
    const vals = await Promise.all(keys.slice(0, 300).map((k) => env.SESSIONS.get(k, "json").catch(() => null)));
    return json({ ok: true, total: keys.length, feedback: vals.filter(Boolean) }, 200, cors);
  }
  const rows = [];
  let cursor;
  do {
    const page = await env.SESSIONS.list({ prefix: "s:", cursor, limit: 1000 });
    page.keys.forEach((k) => rows.push({ sid: k.name.slice(2), ...(k.metadata || {}) }));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && rows.length < 5000);
  rows.sort((a, b) => (b.t || 0) - (a.t || 0));
  return json({ ok: true, sessions: rows }, 200, cors);
}
