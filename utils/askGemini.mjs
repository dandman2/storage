import fetch from "node-fetch";
import { supabase } from "./supabaseClient.mjs";
import { logStorageError } from "./storageErrorLogger.mjs";

const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET;
if (!SUPABASE_BUCKET) throw new Error("SUPABASE_BUCKET is not set");

/**
 * Env:
 *   - GEMINI_API_KEY (required)
 *   - GEMINI_MODEL (optional, default: gemini-2.5-flash-lite)
 *   - GEMINI_DEBUG (1/true)
 *   - CONTEXT_CHANNEL_ID (optional; fallback if אין hint)
 */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");

const GEMINI_DEBUG = (process.env.GEMINI_DEBUG === "1" || (process.env.GEMINI_DEBUG || "").toLowerCase() === "true");

const CHATROOM_IDS = (process.env.CHATROOM_IDS || "").split(/[\s,]+/).filter(Boolean);
const CONTEXT_CHANNEL_ID = process.env.CONTEXT_CHANNEL_ID || CHATROOM_IDS[0] || "";

function glog(...a) { if (GEMINI_DEBUG) console.log("[askGemini]", ...a); }

// ========== Helpers to resolve context channel ==========
async function inferLatestChannelIdFromLogs() {
  const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).list();
  if (error || !data) return null;
  const items = [];
  for (const f of data) {
    const m = f.name.match(/^(\d+)_\d{4}-\d{2}-\d{2}\.jsonl$/);
    if (!m) continue;
    const updated = new Date(f.updated_at || 0).getTime();
    const size = f.size || f.metadata?.size || 0;
    items.push({ channelId: m[1], updated, size });
  }
  if (!items.length) return null;
  items.sort((a,b) => b.updated - a.updated || b.size - a.size);
  return items[0].channelId;
}

// ========== Generic Gemini call ==========
async function callGemini(model, apiKey, prompt, { temperature = 0.4, maxOutputTokens = 2048 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }]}], generationConfig: { temperature, maxOutputTokens } };
  // glog("Gemini request:", { url, prompt, temperature, maxOutputTokens });
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(()=>"");
    const e = new Error(`Gemini HTTP ${res.status}: ${t.slice(0,400)}`);
    e.status = res.status;
    glog("Gemini error response:", { status: res.status, text: t.slice(0,400) });
    throw e;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  // glog("Gemini response:", text.slice(0, 100));
  return text.trim();
}

// ========== Dates extraction via Gemini ==========
async function extractDatesArrayWithGemini(model, apiKey, userPrompt, tz = "Asia/Jerusalem") {
  if (!userPrompt || typeof userPrompt !== "string") {
    glog("Invalid userPrompt for date extraction:", userPrompt);
    throw new Error("Invalid user prompt for date extraction");
  }

  const now = new Date().toISOString().split("T")[0]; // Current date: 2025-08-18

  const systemInstr = [
    "אתה ממפה פרומפט של משתמש לטווחי תאריכים מוחלטים בפורמט YYYY-MM-DD.",
    "החזר JSON **בלבד** עם המפתח dates: רשימת מחרוזות תאריך (ללא טווחים או טקסט נוסף).",
    "אם המשתמש ביקש 'השבוע', החזר את כל הימים מהיום הראשון של השבוע (יום ראשון) עד היום הנוכחי בשעון ישראל (Asia/Jerusalem).",
    "לדוגמה, אם היום הוא 2025-08-23 (שבת), 'השבוע' מתייחס ל-2025-08-17 עד 2025-08-23.",
    "אם המשתמש ציין תאריכים ספציפיים (למשל, '2025-08-20'), החזר אותם ישירות.",
    "אם אין תאריכים ברורים, החזר את התאריך הנוכחי.",
    "התאריך היום הוא: " + now,
    "דוגמה פלט חוקית: {\"dates\":[\"2025-08-17\",\"2025-08-18\",\"2025-08-19\",\"2025-08-20\",\"2025-08-21\",\"2025-08-22\",\"2025-08-23\"]}"
  ].join("\n");

  const prompt = `${systemInstr}\n\nפרומפט משתמש:\n${userPrompt}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }]}], generationConfig: { temperature: 0.0, maxOutputTokens: 256 } };
  glog("Gemini date extraction request:", { url, prompt });

  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const t = await res.text().catch(()=>"");
    glog("Gemini date extraction error:", { status: res.status, text: t.slice(0,400) });
    throw new Error(`Gemini dates HTTP ${res.status}`);
  }
  const data = await res.json();
  const txt = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("")?.trim() || "{}";
  // glog("Gemini date extraction response:", txt);

  const jsonStart = txt.indexOf("{"), jsonEnd = txt.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    glog("Invalid JSON response from Gemini for date extraction");
    throw new Error("Invalid JSON response from Gemini");
  }
  let json;
  try {
    json = JSON.parse(txt.slice(jsonStart, jsonEnd + 1));
  } catch (e) {
    glog("Failed to parse Gemini date response:", e.message);
    throw new Error("Failed to parse Gemini date response");
  }
  const dates = Array.isArray(json?.dates) ? json.dates : [];
  if (!dates.length) {
    glog("No dates returned by Gemini, checking for 'השבוע'");
    if (userPrompt.toLowerCase().includes("השבוע")) {
      glog("Applying fallback for 'השבוע'");
      const now = new Date().toLocaleString("en-US", { timeZone: tz });
      const today = new Date(now);
      const dayOfWeek = today.getDay();
      const startOfWeek = new Date(today);
      startOfWeek.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1)); // Start from Sunday
      const dates = [];
      for (let d = new Date(startOfWeek); d <= today; d.setDate(d.getDate() + 1)) {
        dates.push(d.toISOString().split("T")[0]);
      }
      glog("Fallback dates:", dates);
      return dates;
    }
    glog("No valid dates returned by Gemini and no 'השבוע' in prompt");
    throw new Error("No dates returned by Gemini");
  }
  glog("Extracted dates:", dates);
  return dates;
}

// ========== Read logs for a specific YYYY-MM-DD ==========
async function readLogsForDate(channelId, ymd) {
  const file = `${channelId}_${ymd}.jsonl`;
  let out = [];
  try {
    const { data } = await supabase.storage.from(SUPABASE_BUCKET).download(file);
    const txt = await data.text();
    for (const line of txt.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const text = obj.content?.trim?.() || obj.text?.trim?.() || obj.message?.trim?.() || "";
        if (!text) continue;
        out.push({ ts: obj.timestamp || obj.ts || 0, author: obj.author || obj.user || "Unknown", text });
      } catch {}
    }
  } catch (error) {
    await logStorageError(error);
  }
  out.sort((a,b)=> (a.ts||0)-(b.ts||0));
  return out;
}

// ========== Main ==========
export async function askGemini(userPrompt) {
  try {
    const channelId = CONTEXT_CHANNEL_ID;
    // glog("contextChannel:", channelId);

    if (!userPrompt || typeof userPrompt !== "string" || userPrompt.trim() === "") {
      glog("Invalid or missing userPrompt:", userPrompt, "contextChannelId:", channelId);
      return "❌ השאלה אינה תקינה. אנא ספק שאלה ברורה.";
    }

    const dates = await extractDatesArrayWithGemini(GEMINI_MODEL, GEMINI_API_KEY, userPrompt, "Asia/Jerusalem");

    const perDaySummaries = [];
    for (const ymd of dates) {
      const msgs = await readLogsForDate(channelId, ymd);
      if (msgs.length === 0) continue;
      console.log(`Found ${msgs.length} messages for ${ymd}`);

      const MAX = 15000;
      let acc = [], sum = 0;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const s = `${msgs[i].author}: ${msgs[i].text}\n`;
        if (sum + s.length > MAX) break;
        acc.push(s); sum += s.length;
      }
      acc = acc.reverse();

      const now = new Date().toISOString().split("T")[0]; // Current date: 2025-08-18

      const dayPrompt = [
        "אתה עוזר מסכם שיחות.",
        "הוראות חשובות:",
        "- תענה אך ורק לשאלה שנשאלת.",
        "- אם בקונטקסט אין מספיק מידע לענות לשאלה → השב: 'אין מספיק מידע כדי לענות לשאלה'.",
        "- אל תכלול נושאים אחרים.",
        "- למשל אם שואלים על שוק ההון - התרכז רק בשוק ההון (חברות, מניות, טיקרים, שוק קריפטו, מחירים, נתונים מספריים).",
        "",
        `השאלה של המשתמש: ${userPrompt}`,
        "",
        "--- הקשר ---",
        `ההקשר הזה הוא משיחות בתאריך ${ymd} (שעון ישראל).`,
        acc.join(""),
        "--- סוף הקשר ---",
        "התאריך היום הוא: " + now
      ].join("\n");
      


      const dayAnswer = await callGemini(GEMINI_MODEL, GEMINI_API_KEY, dayPrompt);
      if (dayAnswer) {
        console.log(`Answer for ${ymd}:`, dayAnswer.slice(0,200));
        perDaySummaries.push(`### ${ymd}\n${dayAnswer}`);
      }
    }

    if (perDaySummaries.length === 0) {
      return `לא נמצאו הודעות לתאריכים שביקשת (${dates.join(", ")})`;
    }

    // Concatenate per-day responses instead of summarizing
    const final = perDaySummaries.join("\n\n");
    return final || "לא התקבלו תשובות לתאריכים המבוקשים.";
  } catch (error) {
    console.error(`Error in askGemini:`, error);
    if (error.message === "Invalid user prompt for date extraction" || error.message === "No dates returned by Gemini") {
      return "❌ לא ניתן לזהות תאריכים מהבקשה. אנא נסח את השאלה מחדש או ציין תאריכים ספציפיים.";
    }
    if (error.status === 429) return "❌ הגעת לגבול השאלות היומי של ג׳מיני. נסו שוב מאוחר יותר.";
    if (error.status === 400 && String(error.message).includes("maximum number of tokens")) {
      return "❌ השאלה ארוכה מדי. נסו טווח קצר יותר.";
    }
    return "❌ שגיאת Gemini.";
  }
}