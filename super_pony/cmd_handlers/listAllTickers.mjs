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
      .setColor(0x57f287)
      .setTitle(title)
      .setDescription(desc)
      .setFooter({ text: `עמוד ${i + 1}/${pages.length} — ${footer}` })
  );
}

/**
 * Shows all tickers.
 * - Ticker text links to the FIRST mention (by whoever mentioned it first).
 * - Date links to the LAST mention (by any user).
 * - Appends the FIRST user's display name in parentheses.
 */
export async function listAllTickers({ message, dbPath, includeCounts = true, minMentions = 1 }) {
  const raw = await fs.readFile(dbPath, "utf-8").catch(() => "{}");
  const db = JSON.parse(raw || "{}");
  const entries = Array.isArray(db) ? db : db.entries || [];

  // Aggregate by ticker
  const agg = new Map(); // sym -> { count, firstTs, firstLink, firstUser, lastTs, lastLink }
  for (const e of entries) {
    const sym = e.ticker?.toUpperCase();
    if (!sym) continue;
    const ts = Date.parse(e.timestamp);
    const cur = agg.get(sym) || {
      count: 0, firstTs: Infinity, firstLink: "", firstUser: "",
      lastTs: -1, lastLink: ""
    };
    cur.count += 1;
    if (ts < cur.firstTs) { cur.firstTs = ts; cur.firstLink = e.link || ""; cur.firstUser = e?.user?.name || ""; }
    if (ts > cur.lastTs)  { cur.lastTs  = ts; cur.lastLink  = e.link || ""; }
    agg.set(sym, cur);
  }

  let items = [...agg.entries()];
  if (minMentions > 1) items = items.filter(([, v]) => v.count >= minMentions);

  items.sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

  if (items.length === 0) {
    await message.channel.send("לא נמצאו טיקרים.");
    return;
  }

  const totalMentions = entries.length;
  const lines = items.map(([sym, v]) => {
    const firstUrl = v.firstLink || "#";
    const lastUrl  = v.lastLink  || "#";
    const lastStr  = formatShort(v.lastTs);
    const who      = v.firstUser ? ` (${v.firstUser})` : "";
    // ticker -> first mention link, date -> last mention link, include first user
    return `• \`${sym}\` — **${v.count}** [${who}](${firstUrl}) — [${lastStr}](${lastUrl})`;
  });

  const embeds = paginate(lines, {
    title: "📊 טיקרים במעקב",
    footer: `סה"כ ${items.length} ייחודיים, ${totalMentions} אזכורים`,
  });

  for (const emb of embeds) await message.channel.send({ embeds: [emb] });
}
