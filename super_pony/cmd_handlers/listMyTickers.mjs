import fs from "fs/promises";
import { EmbedBuilder } from "discord.js";

const MAX_DESC = 3500;

function formatShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function paginate(lines, { title, footer }) {
  const pages = [];
  let buf = [], size = 0;
  for (const ln of lines) {
    const add = ln.length + 1;
    if (size + add > MAX_DESC) { pages.push(buf.join("\n")); buf = []; size = 0; }
    buf.push(ln); size += add;
  }
  if (buf.length) pages.push(buf.join("\n"));

  return pages.map((desc, i) =>
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(title)
      .setDescription(desc)
      .setFooter({ text: `עמוד ${i + 1}/${pages.length} — ${footer}` })
  );
}

/**
 * Shows user's own tickers.
 * - Ticker text links to the FIRST time this user mentioned it.
 * - Date links to the LAST time this user mentioned it.
 */
export async function listMyTickers({ message, dbPath, fromDateIso }) {
  const raw = await fs.readFile(dbPath, "utf-8").catch(() => "{}");
  const db = JSON.parse(raw || "{}");
  const entries = Array.isArray(db) ? db : db.entries || [];

  const me = message.author.id;
  const fromTs = fromDateIso ? Date.parse(fromDateIso) : null;

  // Aggregate by ticker
  const agg = new Map(); // sym -> { count, firstTs, firstLink, lastTs, lastLink }
  for (const e of entries) {
    if (e?.user?.id !== me) continue;
    if (fromTs && Date.parse(e.timestamp) < fromTs) continue;
    const sym = e.ticker?.toUpperCase();
    if (!sym) continue;

    const ts = Date.parse(e.timestamp);
    const cur = agg.get(sym) || { count: 0, firstTs: Infinity, firstLink: "", lastTs: -1, lastLink: "" };
    cur.count += 1;
    if (ts < cur.firstTs) { cur.firstTs = ts; cur.firstLink = e.link || ""; }
    if (ts > cur.lastTs)  { cur.lastTs  = ts; cur.lastLink  = e.link || ""; }
    agg.set(sym, cur);
  }

  const items = [...agg.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

  if (items.length === 0) {
    await message.channel.send("לא נמצאו טיקרים שלך.");
    return;
  }

  const lines = items.map(([sym, v]) => {
    const firstUrl = v.firstLink || "#";
    const lastUrl  = v.lastLink  || "#";
    const lastStr  = formatShort(v.lastTs);
    // ticker -> first mention link, date -> last mention link
    return `• [\`${sym}\`](${firstUrl}) — **${v.count}** (last: [${lastStr}](${lastUrl}))`;
  });

  const title = fromDateIso
    ? `🎯 הטיקרים שלך (מ־${fromDateIso} ועד היום)`
    : "🎯 הטיקרים שלך";

  const total = items.reduce((s, [, v]) => s + v.count, 0);
  const embeds = paginate(lines, { title, footer: `${items.length} ייחודיים, ${total} אזכורים` });

  for (const emb of embeds) await message.channel.send({ embeds: [emb] });
}
