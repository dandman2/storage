// super_pony/cmd_handlers/listFirstByUser.mjs
import fs from "fs/promises";
import { EmbedBuilder } from "discord.js";

const MAX_DESC = 3500;

function formatShort(isoOrTs) {
  if (!isoOrTs && isoOrTs !== 0) return "";
  const d = new Date(typeof isoOrTs === "number" ? isoOrTs : Date.parse(isoOrTs));
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function paginate(lines, { title, footer, color = 0xffa500 }) {
  const pages = [];
  let buf = [], sz = 0;
  for (const ln of lines) {
    const add = ln.length + 1;
    if (sz + add > MAX_DESC) { pages.push(buf.join("\n")); buf = []; sz = 0; }
    buf.push(ln); sz += add;
  }
  if (buf.length) pages.push(buf.join("\n"));
  return pages.map((desc, i) =>
    new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(desc || "—")
      .setFooter({ text: `עמוד ${i + 1}/${pages.length} — ${footer}` })
  );
}

/**
 * List tickers where `targetUser` is the FIRST to mention them.
 * - Ticker text links to the FIRST mention by target user.
 * - Date links to the LAST mention by anyone.
 */
export async function listFirstByUser({ message, dbPath, targetUser }) {
  const raw = await fs.readFile(dbPath, "utf-8").catch(() => "{}");
  const db = JSON.parse(raw || "{}");
  const entries = Array.isArray(db) ? db : db.entries || [];

  // Aggregate per ticker: track first+last across all users
  const agg = new Map(); // sym -> { count, firstTs, firstLink, firstUserId, firstUserName, lastTs, lastLink }
  for (const e of entries) {
    const sym = e.ticker?.toUpperCase();
    if (!sym) continue;
    const ts = Date.parse(e.timestamp);
    const cur = agg.get(sym) || {
      count: 0, firstTs: Infinity, firstLink: "", firstUserId: "", firstUserName: "",
      lastTs: -1, lastLink: ""
    };
    cur.count += 1;
    if (ts < cur.firstTs) {
      cur.firstTs = ts;
      cur.firstLink = e.link || "";
      cur.firstUserId = e?.user?.id || "";
      cur.firstUserName = e?.user?.name || "";
    }
    if (ts > cur.lastTs) {
      cur.lastTs = ts;
      cur.lastLink = e.link || "";
    }
    agg.set(sym, cur);
  }

  const wantedId = targetUser.id;
  const list = [...agg.entries()]
    .filter(([, v]) => v.firstUserId === wantedId)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));

  if (list.length === 0) {
    await message.channel.send(`לא נמצאו טיקרים שבהם ${targetUser.username} היה/הייתה הראשון/ה.`);
    return;
  }

  const lines = list.map(([sym, v]) => {
    const firstUrl = v.firstLink || "#";
    const lastUrl  = v.lastLink || "#";
    const lastStr  = formatShort(v.lastTs);
    // TICKER (→ first mention link), count, last date (→ last mention link)
    return `• [\`${sym}\`](${firstUrl}) — **${v.count}** — [${lastStr}](${lastUrl})`;
  });

  const title = `🥇 טיקרים ש־${targetUser.username} הזכיר/ה ראשון/ה`;
  const totalMentions = list.reduce((s, [, v]) => s + v.count, 0);
  const embeds = paginate(lines, {
    title,
    footer: `${list.length} ייחודיים, ${totalMentions} אזכורים`,
    color: 0xffc107, // amber
  });

  for (const emb of embeds) await message.channel.send({ embeds: [emb] });
}
