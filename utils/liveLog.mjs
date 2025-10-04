import { supabase } from "./supabaseClient.mjs";
import { logStorageError } from "./storageErrorLogger.mjs";
import { ensureBucketExists } from './storageBootstrap.mjs';

const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET;
if (!SUPABASE_BUCKET) throw new Error("SUPABASE_BUCKET is not set");
await ensureBucketExists(process.env.SUPABASE_BUCKET || 'discord-logs');

// get the integer number from environment variable DAYS_2_BACK_FILL, default to 2 if not set or invalid
const DAYS_2_BACK_FILL = parseInt(process.env.DAYS_2_BACK_FILL) || 2;

// ===== debug + Israel timezone helpers (no deps) =====
const LOG_DEBUG = true; // keep your explicit always-on logs
const IL_TZ = "Asia/Jerusalem";
function dlog(...args) { if (LOG_DEBUG) console.log("[liveLog.readRecent]", ...args); }

function israelDateString(d = new Date()) {
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: IL_TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(d);
    const y = parts.find(p => p.type === "year")?.value ?? "0000";
    const m = parts.find(p => p.type === "month")?.value ?? "01";
    const day = parts.find(p => p.type === "day")?.value ?? "01";
    return `${y}-${m}-${day}`; // YYYY-MM-DD in Israel local time
}

function israelFormat(isoOrDate) {
    const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
    return new Intl.DateTimeFormat("he-IL", {
        timeZone: IL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(d);
}

function ilISOString(d = new Date()) {
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Jerusalem",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const y = map.year, m = map.month, day = map.day, hh = map.hour, mm = map.minute, ss = map.second;
  
    const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
    const il  = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    let offMin = Math.round((il - utc) / 60000);
    const sign = offMin >= 0 ? "+" : "-";
    offMin = Math.abs(offMin);
    const offH = String(Math.floor(offMin / 60)).padStart(2, "0");
    const offM = String(offMin % 60).padStart(2, "0");
    const offset = `${sign}${offH}:${offM}`;
  
    return `${y}-${m}-${day}T${hh}:${mm}:${ss}${offset}`;
}
  
function getDailyLogFile(channelId, date) {
    const formattedDate = israelDateString(date); // YYYY-MM-DD in Israel time
    return `${channelId}_${formattedDate}.jsonl`;
}

function channelLogFile(channelId) {
    return getDailyLogFile(channelId, new Date());
}

function shouldLogMessage(msg) {
    const content = msg.content?.trim() || "";
    if (!content) return false; // Skip empty content, even with attachments

    // Check if only emojis
    const withoutEmojis = content.replace(/[\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Emoji_Component}\p{Emoji_Presentation}]/gu, '').trim();
    if (!withoutEmojis) return false; // Only emojis, skip

    // Check if it's just a GIF link (e.g., tenor.com)
    if (content.startsWith('https://tenor.com/')) return false; // Skip animated GIF links

    return true; // Has text or regular links, log it
}

export async function appendToLog(msg) {
    if (!shouldLogMessage(msg)) return; // Skip if no text or only emojis/GIF

    // let userInitials = msg.author.username.replace(/[aeiou\.]/g, "").toLowerCase() || "pny"; // default to "pny" if empty
    // if (userInitials.length > 3) {
    //     userInitials = userInitials.substring(0, 3);
    // }

    // insread of msg.author.username get the display name of the user
    const userInitials = msg.member?.displayName || msg.member?.nickname || msg.author.displayName || msg.author.username;

    let referenceMessageLink = "";
    if (msg.reference?.messageId) {
        referenceMessageLink = `https://discord.com/channels/1397974486581772494/${msg.channelId}/${msg.reference?.messageId}`;
    }

    const rec = {
        msgLink: `https://discord.com/channels/1397974486581772494/${msg.channelId}/${msg.id}`,
        refMsgLink: referenceMessageLink,
        author: userInitials || "אנונימי",
        content: msg.content || "",
        createdAt: ilISOString(msg.createdAt ?? new Date()),
        attachments: [...(msg.attachments?.values?.() || [])].map(a => ({ url: a.url, name: a.name })),
    };

    const fileName = channelLogFile(msg.channelId);
    // 🔵 keep your explicit log
    // console.log("Appending to log:", fileName, "record:", rec);
    let existing = "";
    try {
        const { data } = await supabase.storage.from(SUPABASE_BUCKET).download(fileName);
        // console.log("  → downloaded existing log file:", fileName);
        // console.log("content:", data);

        existing = await data.text();
        // console.log("data text:", existing);

    } catch (error) {
        console.warn("Failed to fetch log file: ", fileName, error.message || error);
        await logStorageError(error);
    }

    // Append new record
    const payload = existing + JSON.stringify(rec) + "\n";

    const { error } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(fileName, Buffer.from(payload), { upsert: true, contentType: "application/jsonl" });
    if (error) {
        await logStorageError(error);
        console.error("Failed to upload log file", fileName, error);
        throw error;
    }
}

export async function readRecent(channelId, minutes = 60, maxLines = 4000) {
    const now = new Date();
    const cutoffMs = Date.now() - minutes * 60 * 1000;
    const todayFile = getDailyLogFile(channelId, now);

    // 🔵 keep your explicit logs
    // console.log("Reading recent messages for channel:", channelId, "from", minutes, "minutes ago");

    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const yesterdayFile = getDailyLogFile(channelId, y);
    // console.log("Yesterday's log file:", yesterdayFile);

    dlog("channelId:", channelId);
    dlog("IL now:", israelFormat(now), "| window(min):", minutes);
    dlog("Cutoff >= ", israelFormat(new Date(cutoffMs)));
    dlog("Today file:", todayFile);
    dlog("Yesterday file:", yesterdayFile);

    const items = [];
    const files = [todayFile, yesterdayFile];

    for (const f of files) {
        let raw = "";
        try {
            const { data } = await supabase.storage.from(SUPABASE_BUCKET).download(f);
            raw = await data.text();
            dlog("  → downloaded", f, `size=${raw.length}`);
        } catch (error) {
            await logStorageError(error);
            dlog("  → not found", f);
            continue; // missing file is fine
        }
        if (!raw.trim()) { dlog("  → empty file", f); continue; }

        const lines = raw.split(/\r?\n/).filter(Boolean);
        const start = Math.max(0, lines.length - maxLines);
        let parsed = 0, kept = 0, malformed = 0;
        let firstTs = null, lastTs = null;

        for (let i = start; i < lines.length; i++) {
            const line = lines[i];
            try {
                const o = JSON.parse(line);
                parsed++;
                const t = new Date(o.createdAt).getTime();
                if (Number.isFinite(t)) {
                    if (!firstTs || t < firstTs) firstTs = t;
                    if (!lastTs || t > lastTs) lastTs = t;
                    if (t >= cutoffMs) { items.push(o); kept++; }
                }
            } catch {
                malformed++;
            }
        }

        dlog("  → file summary:", f,
            `lines=${lines.length}, parsed=${parsed}, kept>=cutoff=${kept}, malformed=${malformed}`,
            firstTs ? `first=${israelFormat(new Date(firstTs))}` : "first=–",
            lastTs ? `last=${israelFormat(new Date(lastTs))}` : "last=–",
        );
    }

    items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const out = items.slice(-maxLines);

    dlog("TOTAL kept:", out.length,
        out.length ? `range=${israelFormat(out[0].createdAt)} → ${israelFormat(out[out.length - 1].createdAt)}` : "");

    return out;
}

// 🔶 NEW: last-N lines from the newest (today/yesterday) file
export async function readLastNFromLatestFile(channelId, n = 400, date = null) {
    const now = new Date();
    const todayFile = getDailyLogFile(channelId, now);
    const y = new Date(now); y.setDate(y.getDate() - 1);
    const yesterdayFile = getDailyLogFile(channelId, y);

    let chosen;
    if (date) {
        chosen = getDailyLogFile(channelId, new Date(date));
    } else {
        const { data: list } = await supabase.storage.from(SUPABASE_BUCKET).list('', { search: `${channelId}_` });
        const candidates = [];
        for (const item of list || []) {
            if (item.name === todayFile || item.name === yesterdayFile) {
                candidates.push(item);
            }
        }
        if (candidates.length === 0) {
            dlog("readLastNFromLatestFile: no files for channel", channelId);
            return [];
        }
        candidates.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
        chosen = candidates[0].name;
    }

    dlog("readLastNFromLatestFile: chosen file:", chosen);

    let raw = "";
    try {
        const { data } = await supabase.storage.from(SUPABASE_BUCKET).download(chosen);
        raw = await data.text();
    } catch (error) {
        await logStorageError(error);
        return [];
    }

    let rawLines = raw.split(/\r?\n/).filter(Boolean);
    const startIndex = Math.max(0, rawLines.length - n);
    const lines = rawLines.slice(startIndex);

    let parsed = 0, malformed = 0;
    const out = [];
    for (const line of lines) {
        try {
            out.push(JSON.parse(line));
            parsed++;
        } catch {
            malformed++;
        }
    }
    dlog("readLastNFromLatestFile: lines:", lines.length, "taking last:", lines.length, "parsed:", parsed, "malformed:", malformed);

    out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    if (out[0] && out.at(-1)) {
        dlog("readLastNFromLatestFile: range:", israelFormat(out[0].createdAt), "→", israelFormat(out.at(-1).createdAt));
    }
    return out;
}
export async function backfillLastDayMessages(client, channelId) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
        console.warn(`Channel ${channelId} not found for backfill.`);
        return;
    }

    const now = new Date();
    const cutoff = new Date(now.getTime() - DAYS_2_BACK_FILL * 24 * 60 * 60 * 1000); // 24 hours ago

    // Build a per-day bucket so each message is written to its correct daily log (Israel local day)
    const dayBuckets = new Map();

    function yyyy_mm_dd_IL(d) {
        return israelDateString(d);
    }

    async function ensureBucketFor(dateObj) {
        const key = yyyy_mm_dd_IL(dateObj);
        if (dayBuckets.has(key)) return dayBuckets.get(key);
        const fileForDay = getDailyLogFile(channelId, dateObj);

        // 🔵 keep your explicit log
        // console.log("reading/writing to daily log file:", fileForDay);

        const bucket = { file: fileForDay, existingText: "", existingIds: new Set(), records: [] };

        // Load existing IDs for that day to prevent duplicates
        try {
            const { data } = await supabase.storage.from(SUPABASE_BUCKET).download(fileForDay);
            const raw = await data.text();
            bucket.existingText = raw;
            const lines = raw.trim() ? raw.trim().split("\n") : [];
            for (const line of lines) {
                try {
                    const o = JSON.parse(line);
                    const msgId = o.msgLink?.split?.("/")?.pop?.();
                    if (msgId) bucket.existingIds.add(msgId);
                } catch { }
            }
        } catch (error) {
            await logStorageError(error);
        }

        dayBuckets.set(key, bucket);
        return bucket;
    }

    let lastId;
    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;

        let stop = false;
        for (const msg of messages.values()) {
            if (msg.createdAt < cutoff) { stop = true; break; }
            if (msg.author.bot) continue;
            if (!shouldLogMessage(msg)) continue;

            const key = yyyy_mm_dd_IL(msg.createdAt);
            // Construct a date object for path derivation (any time during that IL day is fine)
            const parts = key.split("-");
            const dtForBucket = new Date(`${parts[0]}-${parts[1]}-${parts[2]}T12:00:00Z`);
            const bucket = await ensureBucketFor(dtForBucket);

            const msgId = msg.id;
            if (bucket.existingIds.has(msgId)) continue;

            // let userInitials = msg.author.username.replace(/[aeiou\.]/g, "").toLowerCase() || "pny";
            // if (userInitials.length > 3) userInitials = userInitials.substring(0, 3);

            // insread of msg.author.username get the display name of the user
            const userInitials = msg.member?.displayName || msg.member?.nickname || msg.author.displayName || msg.author.username;
            
            let referenceMessageLink = "";
            if (msg.reference?.messageId) {
                referenceMessageLink = `https://discord.com/channels/1397974486581772494/${msg.channelId}/${msg.reference?.messageId}`;
            }

            const rec = {
                msgLink: `https://discord.com/channels/1397974486581772494/${msg.channelId}/${msg.id}`,
                refMsgLink: referenceMessageLink,
                author: userInitials || "אנונימי",
                content: msg.content || "",
                createdAt: ilISOString(msg.createdAt ?? new Date()),
                attachments: [...(msg.attachments?.values?.() || [])].map(a => ({ url: a.url, name: a.name })),
            };
            bucket.records.push(rec);
            bucket.existingIds.add(msgId);
        }
        if (stop) break;
        lastId = messages.last().id;
    }

    // Write per-day
    let total = 0;
    for (const { file: f, existingText, records } of dayBuckets.values()) {
        if (records.length === 0) continue;
        const logData = existingText + records.map(r => JSON.stringify(r)).join("\n") + "\n";
        const { error } = await supabase.storage
            .from(SUPABASE_BUCKET)
            .upload(f, Buffer.from(logData), { upsert: true, contentType: "application/jsonl" });
        if (error) {
            await logStorageError(error);
            console.error("Failed to upload log file", f, error);
            throw error;
        }
        total += records.length;
    }

    if (total > 0) {
        console.log(`✅ Backfilled ${total} messages for channel ${channelId} across ${dayBuckets.size} day file(s).`);
    } else {
        console.log(`No new messages to backfill for channel ${channelId}`);
    }
}
