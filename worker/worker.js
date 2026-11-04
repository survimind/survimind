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
 *   EDITOR_ACCOUNTS  (Secret, สำหรับเข้าสู่ระบบทีม) บัญชี ชื่อผู้ใช้:รหัสผ่าน คั่นหลายบัญชีด้วยจุลภาค
 *   TEACHER_ACCOUNTS (Secret, ไม่บังคับ) บัญชีอาจารย์รายคน รูปแบบเดียวกัน · เห็นเฉพาะห้องเรียนที่ตัวเองสร้าง
 *                    เช่น  admin:รหัสยาวๆ,teacher:อีกรหัส  (เปลี่ยนค่านี้ = ทุกคนต้องเข้าสู่ระบบใหม่)
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
    if (body && (body.mode === "login" || body.mode === "verify")) return editorAuth(body, env, cors);
    if (body && ["register", "change_password", "acct_list", "acct_create", "acct_set"].includes(body.mode)) return accountApi(body, env, cors);
    if (body && ["save", "list", "get", "feedback", "feedback_list", "room_info", "room_create", "room_list", "room_delete"].includes(body.mode)) return teacherApi(body, env, cors);

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
  put("room", roomCode(s.room));   // ห้องเรียนที่อาจารย์สร้าง (ลิงก์ ?room=) · ไม่มี = เว็บกลาง
  put("reached", Number.isInteger(s.reached) && s.reached >= 1 && s.reached <= 10 ? s.reached : undefined);
  // ผลการเล่นเต็ม (คะแนน สภาพทีม พฤติกรรม) สำหรับเปิดหน้าผลลัพธ์ย้อนหลัง
  if (s.result && typeof s.result === "object") {
    const r = JSON.stringify(s.result);
    if (r.length <= 60000) out.result = JSON.parse(r);
  }
  return out;
}
// รหัสห้อง 6 ตัว (ตัดตัวที่สับสนง่าย เช่น O/0 I/1 ออก)
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function roomCode(v) { const c = String(v || "").trim().toUpperCase(); return /^[A-Z0-9]{6}$/.test(c) ? c : undefined; }
function newRoomCode() { const b = crypto.getRandomValues(new Uint8Array(6)); return Array.from(b, (x) => ROOM_CHARS[x % ROOM_CHARS.length]).join(""); }
function metaOf(r) {
  const tm = (r.result && r.result.summary) || {};
  return { t: r.finishedAt || r.startedAt || 0, sc: r.scenario, ch: r.character, mb: r.mbti, g: r.gender, a: r.age, n: r.playerName ? r.playerName.slice(0, 30) : undefined,
    lat: tNum(tm.avgLatency), sw: tNum(tm.totalSwitches), wm: tNum(tm.ef && tm.ef.wm), ic: tNum(tm.ef && tm.ef.ic), cf: tNum(tm.ef && tm.ef.cf),
    h: tNum(r.result && r.result.meters && r.result.meters.health), p: tNum(r.result && r.result.meters && r.result.meters.panic), q: r.reached, rm: r.room, done: !!r.finishedAt };
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
      mbti: /^[EI][SN][TF][JP]$/.test(f.mbti || "") ? f.mbti : undefined, device: tStr(f.device, 10), where: tStr(f.where, 20), room: roomCode(f.room) };
    const key = "f:" + String(rec.t).padStart(14, "0") + ":" + Math.random().toString(36).slice(2, 8);
    await env.SESSIONS.put(key, JSON.stringify(rec), { expirationTtl: SESSION_TTL });
    return json({ ok: true }, 200, cors);
  }
  // ข้อมูลห้อง (สาธารณะ): บอกแค่ชื่อห้อง ให้ผู้เล่นเห็นว่ากำลังเล่นในห้องไหน
  if (body.mode === "room_info") {
    const code = roomCode(body.code);
    const rec = code ? await env.SESSIONS.get("r:" + code, "json") : null;
    return rec ? json({ ok: true, code, name: rec.name }, 200, cors) : json({ ok: false, error: "room_not_found" }, 404, cors);
  }
  // เข้าได้ 2 ทาง: เข้าสู่ระบบทีม (token) หรือรหัสอาจารย์ (TEACHER_KEY)
  const byToken = body.token ? await verifyToken(String(body.token), env) : null;
  if (!byToken) {
    if (!env.TEACHER_KEY) return json({ ok: false, error: body.token ? "session_expired" : "teacher_key_missing" }, body.token ? 401 : 503, cors);
    if (!sameKey(String(body.key || ""), env.TEACHER_KEY)) { await sleep(500); return json({ ok: false, error: body.token && !body.key ? "session_expired" : "wrong_key" }, 401, cors); }
  }
  // บทบาท: อาจารย์เห็นเฉพาะห้องของตัวเอง · ทีม/รหัสอาจารย์ (TEACHER_KEY) เห็นทุกอย่าง
  const isAdmin = !byToken || byToken.r === "admin";
  const me = byToken ? byToken.u : "teacher";
  const myRooms = async () => {
    const set = new Set(); let c;
    do {
      const page = await env.SESSIONS.list({ prefix: "r:", cursor: c, limit: 1000 });
      page.keys.forEach((k) => { if (k.metadata && k.metadata.owner === me) set.add(k.metadata.code); });
      c = page.list_complete ? undefined : page.cursor;
    } while (c);
    return set;
  };
  if (body.mode === "room_create") {
    const name = (tStr(body.name, 60) || "").trim();
    if (!name) return json({ ok: false, error: "room_name" }, 400, cors);
    let code = "";
    for (let i = 0; i < 6 && !code; i++) { const c = newRoomCode(); if (!(await env.SESSIONS.get("r:" + c))) code = c; }
    if (!code) return json({ ok: false, error: "room_busy" }, 503, cors);
    const rec = { code, name, owner: byToken ? byToken.u : "teacher", t: Date.now() };
    await env.SESSIONS.put("r:" + code, JSON.stringify(rec), { metadata: rec });
    return json({ ok: true, room: rec }, 200, cors);
  }
  if (body.mode === "room_list") {
    const rooms = [];
    let c;
    do {
      const page = await env.SESSIONS.list({ prefix: "r:", cursor: c, limit: 1000 });
      page.keys.forEach((k) => rooms.push(k.metadata || { code: k.name.slice(2) }));
      c = page.list_complete ? undefined : page.cursor;
    } while (c && rooms.length < 2000);
    rooms.sort((a, b) => (b.t || 0) - (a.t || 0));
    return json({ ok: true, role: isAdmin ? "admin" : "teacher", rooms: isAdmin ? rooms : rooms.filter((r) => r.owner === me) }, 200, cors);
  }
  if (body.mode === "room_delete") {
    // ลบเฉพาะห้อง (ลิงก์ใช้ไม่ได้อีก) · ผลที่เล่นไปแล้วยังอยู่และยังกรองดูด้วยรหัสห้องได้
    const code = roomCode(body.code);
    if (!code) return json({ ok: false, error: "room_not_found" }, 404, cors);
    if (!isAdmin) { const r = await env.SESSIONS.get("r:" + code, "json"); if (!r || r.owner !== me) return json({ ok: false, error: "not_your_room" }, 403, cors); }
    await env.SESSIONS.delete("r:" + code);
    return json({ ok: true }, 200, cors);
  }
  if (body.mode === "get") {
    const sid = tStr(body.sid, 40);
    if (!sid) return json({ ok: false, error: "bad_sid" }, 400, cors);
    const rec = await env.SESSIONS.get("s:" + sid, "json");
    if (rec && !isAdmin && !(rec.room && (await myRooms()).has(rec.room))) return json({ ok: false, error: "not_found" }, 404, cors);
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
    const vals = (await Promise.all(keys.slice(0, 300).map((k) => env.SESSIONS.get(k, "json").catch(() => null)))).filter(Boolean);
    if (!isAdmin) { const mine = await myRooms(); const fb = vals.filter((f) => f.room && mine.has(f.room)); return json({ ok: true, role: "teacher", total: fb.length, feedback: fb }, 200, cors); }
    return json({ ok: true, role: "admin", total: keys.length, feedback: vals }, 200, cors);
  }
  const rows = [];
  let cursor;
  do {
    const page = await env.SESSIONS.list({ prefix: "s:", cursor, limit: 1000 });
    page.keys.forEach((k) => rows.push({ sid: k.name.slice(2), ...(k.metadata || {}) }));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && rows.length < 5000);
  rows.sort((a, b) => (b.t || 0) - (a.t || 0));
  if (!isAdmin) { const mine = await myRooms(); return json({ ok: true, role: "teacher", sessions: rows.filter((x) => x.rm && mine.has(x.rm)) }, 200, cors); }
  return json({ ok: true, role: "admin", sessions: rows }, 200, cors);
}


// ================= เข้าสู่ระบบทีม (Editor) =================
const TOKEN_DAYS = 7;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uText = (t) => b64u(new TextEncoder().encode(t));
const unb64uText = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
// บัญชี 2 บทบาท: EDITOR_ACCOUNTS = ทีมผู้ดูแล (เห็นทุกอย่าง) · TEACHER_ACCOUNTS = อาจารย์ (เห็นเฉพาะห้องที่ตัวเองสร้าง)
// รูปแบบเดียวกัน "ชื่อ:รหัส,ชื่อ2:รหัส2" · ชื่อซ้ำกันสองรายการ ให้ถือเป็นทีม
function parseAccounts(v, role) {
  return String(v || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean)
    .map((x) => { const i = x.indexOf(":"); return i > 0 ? { u: x.slice(0, i).trim(), p: x.slice(i + 1).trim(), r: role } : null; }).filter((a) => a && a.u && a.p);
}
function accountsOf(env) {
  const admins = parseAccounts(env.EDITOR_ACCOUNTS, "admin");
  return [...admins, ...parseAccounts(env.TEACHER_ACCOUNTS, "teacher").filter((t) => !admins.some((a) => a.u === t.u))];
}
async function sign(text, env) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("survimind-editor|" + (env.EDITOR_ACCOUNTS || "") + (env.TEACHER_ACCOUNTS ? "|" + env.TEACHER_ACCOUNTS : "")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}
// ---- บัญชีอาจารย์ที่สมัครผ่านเว็บ (เก็บใน KV "a:<ชื่อผู้ใช้>") ----
// สถานะ: pending (รอทีมอนุมัติ) · active · disabled · รหัสผ่านเก็บเป็น PBKDF2-SHA256 + salt ไม่เก็บรหัสจริง
const PBKDF2_ITER = 20000;
const USER_RE = /^[a-z0-9_.-]{3,30}$/;
async function hashPass(pass, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return { salt: btoa(String.fromCharCode(...salt)), hash: btoa(String.fromCharCode(...new Uint8Array(bits))) };
}
const acctMeta = (a) => ({ u: a.u, name: (a.name || "").slice(0, 60), org: (a.org || "").slice(0, 60), note: (a.note || "").slice(0, 80) || undefined, status: a.status, t: a.t });   // metadata KV จำกัด 1KB
async function getAcct(env, u) { if (!env.SESSIONS || !u) return null; try { return await env.SESSIONS.get("a:" + u, "json"); } catch { return null; } }
async function putAcct(env, a) { await env.SESSIONS.put("a:" + a.u, JSON.stringify(a), { metadata: acctMeta(a) }); }
const randomPass = () => { const c = "abcdefghjkmnpqrstuvwxyz23456789"; return Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => c[x % c.length]).join(""); };

// กุญแจเซ็น token มาจาก Secret ของบัญชีทีม · ไม่มี Secret = ปิดการเข้าสู่ระบบทั้งหมด (กันการปลอม token)
const signReady = (env) => !!(env.EDITOR_ACCOUNTS || env.TEACHER_ACCOUNTS);
async function verifyToken(token, env) {
  try {
    if (!signReady(env)) return null;
    const [body, sig] = token.split(".");
    if (!body || !sig || !sameKey(sig, await sign(body, env))) return null;
    const data = JSON.parse(unb64uText(body));
    if (!data || !data.u || !(data.exp > Date.now())) return null;
    const acc = accountsOf(env).find((a) => a.u === data.u);
    if (acc) return { ...data, r: acc.r, src: "env" };   // บทบาทอ่านจากบัญชีปัจจุบันเสมอ
    const k = await getAcct(env, data.u);
    if (k && k.status === "active" && (k.pv || 0) === (data.pv || 0)) return { ...data, r: "teacher", src: "kv" };   // เปลี่ยนรหัส/ปิดบัญชีแล้ว token เก่าใช้ไม่ได้
    return null;
  } catch { return null; }
}
async function issue(acc, env, cors, extra = {}) {
  const exp = Date.now() + TOKEN_DAYS * 864e5;
  const payload = b64uText(JSON.stringify({ u: acc.u, exp, pv: acc.pv || 0 }));
  return json({ ok: true, user: acc.u, name: acc.name, exp, role: acc.r || "teacher", token: payload + "." + (await sign(payload, env)), ...extra }, 200, cors);
}
async function editorAuth(body, env, cors) {
  if (!signReady(env)) return json({ ok: false, error: "accounts_missing" }, 503, cors);
  if (body.mode === "verify") {
    const d = await verifyToken(String(body.token || ""), env);
    return d ? json({ ok: true, user: d.u, exp: d.exp, role: d.r, src: d.src }, 200, cors) : json({ ok: false, error: "session_expired" }, 401, cors);
  }
  const u = (tStr(body.user, 40) || "").trim(), p = tStr(body.pass, 200) || "";
  const acc = accountsOf(env).find((a) => sameKey(u, a.u));
  if (acc) { if (!sameKey(p, acc.p)) { await sleep(700); return json({ ok: false, error: "wrong_login" }, 401, cors); } return issue(acc, env, cors); }
  const k = await getAcct(env, u.toLowerCase());
  if (!k || !k.hash || (await hashPass(p, k.salt)).hash !== k.hash) { await sleep(700); return json({ ok: false, error: "wrong_login" }, 401, cors); }
  if (k.status === "pending") return json({ ok: false, error: "pending" }, 403, cors);
  if (k.status !== "active") return json({ ok: false, error: "disabled" }, 403, cors);
  return issue({ ...k, r: "teacher" }, env, cors);
}
// สมัคร · เปลี่ยนรหัส · ทีมจัดการบัญชี
async function accountApi(body, env, cors) {
  if (!env.SESSIONS) return json({ ok: false, error: "kv_missing" }, 503, cors);
  if (!signReady(env)) return json({ ok: false, error: "accounts_missing" }, 503, cors);
  if (body.mode === "register") {
    const u = (tStr(body.user, 40) || "").trim().toLowerCase(), p = tStr(body.pass, 200) || "";
    const name = (tStr(body.name, 80) || "").trim(), org = (tStr(body.org, 120) || "").trim(), note = (tStr(body.note, 300) || "").trim();
    if (!USER_RE.test(u)) return json({ ok: false, error: "bad_user" }, 400, cors);
    if (p.length < 8) return json({ ok: false, error: "weak_pass" }, 400, cors);
    if (!name) return json({ ok: false, error: "need_name" }, 400, cors);
    if (accountsOf(env).some((a) => a.u.toLowerCase() === u) || (await getAcct(env, u))) return json({ ok: false, error: "user_taken" }, 409, cors);
    let pending = 0, c;
    do { const page = await env.SESSIONS.list({ prefix: "a:", cursor: c, limit: 1000 }); pending += page.keys.filter((k) => k.metadata && k.metadata.status === "pending").length; c = page.list_complete ? undefined : page.cursor; } while (c);
    if (pending >= 50) return json({ ok: false, error: "too_many_pending" }, 429, cors);
    const h = await hashPass(p);
    await putAcct(env, { u, name, org, note, status: "pending", t: Date.now(), ...h, pv: 0 });
    return json({ ok: true, status: "pending" }, 200, cors);
  }
  const me = body.token ? await verifyToken(String(body.token), env) : null;
  if (!me) return json({ ok: false, error: "session_expired" }, 401, cors);
  if (body.mode === "change_password") {
    if (me.src !== "kv") return json({ ok: false, error: "env_account" }, 400, cors);
    const k = await getAcct(env, me.u), np = tStr(body.newPass, 200) || "";
    if (!k || (await hashPass(tStr(body.oldPass, 200) || "", k.salt)).hash !== k.hash) { await sleep(700); return json({ ok: false, error: "wrong_old" }, 401, cors); }
    if (np.length < 8) return json({ ok: false, error: "weak_pass" }, 400, cors);
    const n = { ...k, ...(await hashPass(np)), pv: (k.pv || 0) + 1 };
    await putAcct(env, n);
    return issue({ ...n, r: "teacher" }, env, cors);   // token ใหม่ (token เก่าทุกเครื่องหมดอายุ)
  }
  if (me.r !== "admin") return json({ ok: false, error: "admin_only" }, 403, cors);
  if (body.mode === "acct_list") {
    const out = []; let c;
    do { const page = await env.SESSIONS.list({ prefix: "a:", cursor: c, limit: 1000 }); page.keys.forEach((k) => out.push(k.metadata || { u: k.name.slice(2) })); c = page.list_complete ? undefined : page.cursor; } while (c);
    out.sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || (b.t || 0) - (a.t || 0));
    return json({ ok: true, accounts: out, envTeachers: parseAccounts(env.TEACHER_ACCOUNTS, "teacher").map((a) => a.u) }, 200, cors);
  }
  if (body.mode === "acct_create") {
    const u = (tStr(body.user, 40) || "").trim().toLowerCase(), name = (tStr(body.name, 80) || "").trim(), org = (tStr(body.org, 120) || "").trim();
    if (!USER_RE.test(u)) return json({ ok: false, error: "bad_user" }, 400, cors);
    if (!name) return json({ ok: false, error: "need_name" }, 400, cors);
    if (accountsOf(env).some((a) => a.u.toLowerCase() === u) || (await getAcct(env, u))) return json({ ok: false, error: "user_taken" }, 409, cors);
    const temp = randomPass();
    await putAcct(env, { u, name, org, status: "active", t: Date.now(), by: me.u, ...(await hashPass(temp)), pv: 0 });
    return json({ ok: true, user: u, tempPass: temp }, 200, cors);   // แสดงครั้งเดียวให้ทีมส่งให้อาจารย์
  }
  if (body.mode === "acct_set") {
    const u = (tStr(body.user, 40) || "").trim().toLowerCase(), k = await getAcct(env, u);
    if (!k) return json({ ok: false, error: "not_found" }, 404, cors);
    const act = body.action;
    if (act === "delete") { await env.SESSIONS.delete("a:" + u); return json({ ok: true }, 200, cors); }
    if (act === "approve" || act === "enable") { await putAcct(env, { ...k, status: "active", by: me.u }); return json({ ok: true }, 200, cors); }
    if (act === "disable") { await putAcct(env, { ...k, status: "disabled", pv: (k.pv || 0) + 1 }); return json({ ok: true }, 200, cors); }
    if (act === "reset") { const temp = randomPass(); await putAcct(env, { ...k, ...(await hashPass(temp)), pv: (k.pv || 0) + 1, status: k.status === "pending" ? "active" : k.status }); return json({ ok: true, tempPass: temp }, 200, cors); }
    return json({ ok: false, error: "bad_action" }, 400, cors);
  }
  return json({ ok: false, error: "bad_mode" }, 400, cors);
}
