import fs from "fs/promises";
import axios from "axios";
import {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

/* ---------- per-message and per-user metric and month selection ---------- */
const metricState = new Map(); // `${messageId}:${userId}` -> { metric: "month_oc" | "month_cc" | "mention_oc" | "mention_cc", month: "YYYY-MM" }

/* ======================== DB + time helpers ======================== */
async function loadDb(dbPath) {
  try {
    const raw = await fs.readFile(dbPath, "utf-8");
    const db = JSON.parse(raw || "{}");
    return Array.isArray(db) ? { entries: db } : db || { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function startOfMonthUTC(year, month) {
  return Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
}

function isInMonth(tsMs, monthStartMs) {
  const d = new Date(tsMs);
  const m0 = new Date(monthStartMs);
  return d.getUTCFullYear() === m0.getUTCFullYear() && d.getUTCMonth() === m0.getUTCMonth();
}

function shortDate(isoOrMs) {
  const d = new Date(isoOrMs);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function getAvailableMonths(entries) {
  const months = new Set();
  for (const e of entries) {
    const d = new Date(Date.parse(e.timestamp));
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    months.add(`${year}-${month}`);
  }
  return [...months].sort((a, b) => b.localeCompare(a)); // Sort descending (newest first)
}

/* ======================== MTD aggregation ======================== */
function buildMonthAgg(entries, selectedMonth) {
  const [year, month] = selectedMonth.split("-").map(Number);
  const monthStart = startOfMonthUTC(year, month);
  const mtd = entries.filter((e) => isInMonth(Date.parse(e.timestamp), monthStart));

  const byTicker = new Map();
  for (const e of mtd) {
    const sym = e.ticker?.toUpperCase();
    if (!sym) continue;
    const ts = Date.parse(e.timestamp);
    const cur = byTicker.get(sym) || {
      countMTD: 0,
      firstTs: Infinity,
      firstLink: "",
      firstUserId: "",
      firstUserName: "",
      lastTs: -1,
      lastLink: "",
    };
    cur.countMTD++;
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
    byTicker.set(sym, cur);
  }

  const firstByUserCounts = new Map();
  for (const [, v] of byTicker) {
    if (!v.firstUserId) continue;
    const e = firstByUserCounts.get(v.firstUserId) || { name: v.firstUserName || "", count: 0 };
    e.count++;
    if (!e.name && v.firstUserName) e.name = v.firstUserName;
    firstByUserCounts.set(v.firstUserId, e);
  }

  return { byTicker, firstByUserCounts };
}

/* ======================== Yahoo Finance fetch ======================== */
const chartCache = new Map();

async function getYahooChart(symbol, fromTsMs) {
  const days = Math.max(1, Math.floor((Date.now() - (fromTsMs || Date.now())) / 86400000));
  const range = days <= 30 ? "1mo" : days <= 62 ? "3mo" : days <= 370 ? "1y" : "5y";

  const cacheKey = `${symbol}|${range}`;
  if (chartCache.has(cacheKey)) return chartCache.get(cacheKey);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=1d&range=${range}`;
  const { data } = await axios.get(url);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error(`yahoo chart NA for ${symbol}`);

  const ts = (r.timestamp || []).map((s) => s * 1000);
  const q = r.indicators?.quote?.[0] || {};
  let closes = q?.close || [];
  let opens = q?.open || [];
  if ((!closes || !closes.length) && r.indicators?.adjclose?.[0]?.adjclose) {
    closes = r.indicators.adjclose[0].adjclose;
  }
  const lastClose = [...closes].reverse().find((v) => v != null && isFinite(v));
  const lastPrice = r.meta?.regularMarketPrice ?? lastClose;
  const tz = r.meta?.exchangeTimezoneName || "America/New_York";

  if (!Array.isArray(ts) || !Array.isArray(closes) || !Array.isArray(opens)) {
    throw new Error(`yahoo parse fail for ${symbol}`);
  }

  const out = { timestamps: ts, opens, closes, lastClose, lastPrice, tz };
  chartCache.set(cacheKey, out);
  return out;
}

function localYMD(ts, tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(ts)); // "YYYY-MM-DD"
}

function monthFirstYMD(tz, year, month) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(startOfMonthUTC(year, month)));
  const y = parts.find((p) => p.type === "year")?.value || year;
  const m = parts.find((p) => p.type === "month")?.value || month;
  return `${y}-${m}-01`;
}

function pickStartIndex(ch, anchor, mentionTs, selectedMonth) {
  const tz = ch.tz || "America/New_York";
  const [year, month] = selectedMonth.split("-").map(Number);
  const targetYMD = anchor === "month" ? monthFirstYMD(tz, year, month) : localYMD(mentionTs, tz);
  let idx = -1;
  for (let i = 0; i < ch.timestamps.length; i++) {
    const ymd = localYMD(ch.timestamps[i], tz);
    if (ymd >= targetYMD) { idx = i; break; }
  }
  if (idx === -1) idx = 0;
  return idx;
}

/** opts: { anchor:"mention"|"month", mode:"oc"|"cc" } */
async function fetchBasisAndLatest(symbol, mentionTs, opts, selectedMonth) {
  const { anchor = "mention", mode = "oc" } = opts || {};
  const [year, month] = selectedMonth.split("-").map(Number);
  const ch = await getYahooChart(symbol, anchor === "month" ? startOfMonthUTC(year, month) : mentionTs);
  const idx = pickStartIndex(ch, anchor, mentionTs, selectedMonth);

  let startOpen = ch.opens[idx];
  let startClose = ch.closes[idx];
  for (let j = idx; (startOpen == null || !isFinite(startOpen)) && j < ch.opens.length; j++) {
    if (ch.opens[j] != null && isFinite(ch.opens[j])) { startOpen = ch.opens[j]; break; }
  }
  for (let j = idx; (startClose == null || !isFinite(startClose)) && j < ch.closes.length; j++) {
    if (ch.closes[j] != null && isFinite(ch.closes[j])) { startClose = ch.closes[j]; break; }
  }

  const lastClose = ch.lastClose;
  const lastPrice = ch.lastPrice;

  if (!(startOpen > 0) && !(startClose > 0)) throw new Error("bad start prices");
  if (!(lastPrice > 0) && !(lastClose > 0)) throw new Error("bad latest price");

  const basis  = mode === "cc" ? (startClose ?? startOpen) : (startOpen ?? startClose);
  const latest = mode === "cc" ? (lastClose ?? lastPrice) : (lastPrice ?? lastClose);

  return { basis, latest };
}

/* concurrency map */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0, active = 0;
  return await new Promise((resolve) => {
    const next = () => {
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        Promise.resolve(worker(items[idx], idx))
          .then((res) => (results[idx] = res))
          .catch(() => (results[idx] = null))
          .finally(() => {
            active--;
            if (i >= items.length && active === 0) resolve(results);
            else next();
          });
      }
    };
    next();
  });
}

/** rank by gain */
async function computeGainers(items, { limitTickers = 50, concurrency = 3, anchor = "month", mode = "oc", selectedMonth } = {}) {
  console.log(`Computing gainers for ${items.length} items, limit ${limitTickers}, concurrency ${concurrency}, anchor ${anchor}, mode ${mode}, month ${selectedMonth}`);
  if (!Array.isArray(items) || !items.length) return [];
  if (limitTickers <= 0) limitTickers = 50;
  if (concurrency <= 0) concurrency = 3;
  if (concurrency > 10) concurrency = 10;

  const subset = items.slice(0, limitTickers);
  console.log(`Processing subset of ${subset.length} items`);

  const out = await mapLimit(subset, concurrency, async (info) => {
    try {
      const { basis, latest } = await fetchBasisAndLatest(info.symbol, info.firstTs, { anchor, mode }, selectedMonth);
      const pct = ((latest - basis) / basis) * 100;
      return { ...info, basis, latest, pct };
    } catch {
      return null;
    }
  });
  console.log(`Gainers computed, got ${out.filter(Boolean).length} valid results`);
  return out.filter(Boolean).sort((a, b) => b.pct - a.pct);
}

/* ======================== UI builders ======================== */
const METRIC_CHOICES = [
  { label: "Open→Close (Month)",           value: "month_oc"   },
  { label: "Close→Close (Month)",          value: "month_cc"   },
  { label: "Open→Close (Since Mention)",   value: "mention_oc" },
  { label: "Close→Close (Since Mention)",  value: "mention_cc" },
];

function buildDashboardComponents(userOptions, currentUserId, currentMetric = "month_oc", availableMonths, selectedMonth) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dash:hot5").setStyle(ButtonStyle.Primary).setLabel("Hot5"),
    new ButtonBuilder().setCustomId("dash:hot10").setStyle(ButtonStyle.Primary).setLabel("Hot10"),
    new ButtonBuilder().setCustomId("dash:hot20").setStyle(ButtonStyle.Primary).setLabel("Hot20"),
    new ButtonBuilder().setCustomId(`dash:mine:${currentUserId}`).setStyle(ButtonStyle.Secondary).setLabel("Mine"),
    new ButtonBuilder().setCustomId("dash:all").setStyle(ButtonStyle.Secondary).setLabel("All"),
  );

  const components = [row1];

  if (userOptions.length > 0) {
    const menuUsers = new StringSelectMenuBuilder()
      .setCustomId("dash:user")
      .setPlaceholder("Users")
      .addOptions(userOptions.slice(0, 25));
    const row2 = new ActionRowBuilder().addComponents(menuUsers);
    components.push(row2);
  } else {
    console.log("No user options available, skipping users dropdown");
  }

  const menuMetric = new StringSelectMenuBuilder()
    .setCustomId("dash:metric")
    .setPlaceholder("Metric")
    .addOptions(
      METRIC_CHOICES.map((m) => ({
        label: m.label,
        value: m.value,
        default: m.value === currentMetric,
      }))
    );
  const row3 = new ActionRowBuilder().addComponents(menuMetric);
  components.push(row3);

  const menuMonth = new StringSelectMenuBuilder()
    .setCustomId("dash:month")
    .setPlaceholder("Select Month")
    .addOptions(
      availableMonths.map((m) => ({
        label: m.split("-").reverse().join("."),
        value: m,
        default: m === selectedMonth,
      }))
    );
  const row4 = new ActionRowBuilder().addComponents(menuMonth);
  components.push(row4);

  return components;
}

function getSelectedMetricForMessage(message, userId) {
  return metricState.get(`${message.id}:${userId}`)?.metric || "month_oc";
}

function getSelectedMonthForMessage(message, userId) {
  return metricState.get(`${message.id}:${userId}`)?.month || `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
}

function metricToComputeOpts(metric) {
  switch (metric) {
    case "month_cc":   return { anchor: "month",   mode: "cc" };
    case "mention_oc": return { anchor: "mention", mode: "oc" };
    case "mention_cc": return { anchor: "mention", mode: "cc" };
    case "month_oc":
    default:           return { anchor: "month",   mode: "oc" };
  }
}

/* ======================== Public: dashboard ======================== */
export async function showTickersDashboard({ message, dbPath }) {
  try {
    const { entries } = await loadDb(dbPath);
    console.log(`DB loaded: ${entries.length} entries`);

    const allUnique = new Set(entries.map((e) => (e.ticker || "").toUpperCase()).filter(Boolean)).size;
    console.log(`All unique tickers: ${allUnique}`);

    const availableMonths = getAvailableMonths(entries);
    console.log(`Available months: ${availableMonths.join(", ")}`);

    const currentMonth = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    const { byTicker, firstByUserCounts } = buildMonthAgg(entries, currentMonth);
    const mtdItems = [...byTicker.entries()];
    const mtdUnique = mtdItems.length;

    const top10 = mtdItems
      .sort((a, b) => b[1].countMTD - a[1].countMTD || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([s]) => s);
    console.log(`MTD unique tickers: ${mtdUnique}, top10: ${top10.join(", ")}`);

    const posters = [...firstByUserCounts.entries()]
      .map(([id, v]) => ({ id, name: v.name || "Unknown", count: v.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 3)
      .map((x) => x.name);
    console.log(`Top posters: ${posters.map((p) => `${p}`).join(", ")}`);

    // quick preview of top gainers (month_oc)
    let topGainersSyms = [];
    try {
      console.log("Computing gainers...");
      const quickInfos = mtdItems.map(([sym, v]) => ({
        symbol: sym,
        firstTs: v.firstTs,
        firstUserName: v.firstUserName,
        firstLink: v.firstLink,
      }));
      console.log(`Quick infos: ${quickInfos.length} items`);

      const gainers = await computeGainers(quickInfos, {
        limitTickers: 25,
        concurrency: 3,
        anchor: "month",
        mode: "oc",
        selectedMonth: currentMonth,
      });
      console.log(`Gainers computed: ${gainers.length} items`);
      topGainersSyms = gainers.slice(0, 3).map((g) => g.symbol);
      console.log(`Top gainers: ${topGainersSyms.join(", ")}`);
    } catch {
      console.error("Failed to compute gainers");
      topGainersSyms = [];
    }

    console.log(`First by user counts: ${[...firstByUserCounts.entries()].length} users`);
    const userOptions = [...firstByUserCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count || (a[1].name || "").localeCompare(b[1].name || ""))
      .slice(0, 25)
      .map(([id, v]) => ({ label: `${v.name || "Unknown"} (${v.count})`, value: id }));
    console.log(`User options: ${userOptions.map((u) => u.label).join(", ")}`);

    const lines = [];
    lines.push(`Total Tracked: **${allUnique}** Tickers`);
    lines.push(`This month (${currentMonth.split("-").reverse().join(".")}): **${mtdUnique}** Tickers`);
    if (top10.length)       lines.push(`Top 10 Tickers: ${top10.map((s) => `\`${s}\``).join(", ")}`);
    if (posters.length)     lines.push(`Top 3 Posters: ${posters.join(", ")}`);
    if (topGainersSyms.length)
      lines.push(`Top Gainers: ${topGainersSyms.map((s) => `\`${s}\``).join(", ")}`);
    else
      lines.push(`Top Gainers: None (insufficient data)`);
    console.log("Lines:", lines);

    const embed = new EmbedBuilder()
      .setColor(0x00b7ff)
      .setTitle(`📈 Tickers — Dashboard (${currentMonth.split("-").reverse().join(".")})`)
      .setDescription(lines.join("\n"));
    console.log("Embed built");

    const components = buildDashboardComponents(userOptions, message.author.id, "month_oc", availableMonths, currentMonth);
    console.log("Components built");

    const sent = await message.channel.send({ embeds: [embed], components });
    console.log("Dashboard sent");

    metricState.set(`${sent.id}:${message.author.id}`, { metric: "month_oc", month: currentMonth });
    console.log("Metric and month state set for user", message.author.id);
  } catch (e) {
    console.error("showTickersDashboard error:", e);
    await message.channel.send("תקלה בטעינת לוח הבקרה של הטיקרים.");
  }
}

/* ======================== Public: interactions ======================== */
export async function handleDashboardInteraction({ interaction, dbPath }) {
  const cid = interaction.customId || "";
  if (!cid.startsWith("dash:")) return false;

  const userId = interaction.user.id;
  const selectedMonth = getSelectedMonthForMessage(interaction.message, userId);
  const { entries } = await loadDb(dbPath);
  const { byTicker } = buildMonthAgg(entries, selectedMonth);
  const mtd = [...byTicker.entries()].sort(
    (a, b) => b[1].countMTD - a[1].countMTD || a[0].localeCompare(b[0])
  );

  const infos = mtd.map(([sym, v]) => ({
    symbol: sym,
    firstTs: v.firstTs,
    firstLink: v.firstLink,
    firstUserName: v.firstUserName,
    firstUserId: v.firstUserId,
    lastLink: v.lastLink,
    lastTs: v.lastTs,
    countMTD: v.countMTD,
  }));

  const sendPaged = async (title, lines) => {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: 64 });
    }
    if (!lines.length) {
      await interaction.editReply("—");
      return;
    }
    let cur = "", chunks = [];
    for (const ln of lines) {
      if (cur.length + ln.length + 1 > 1800) { chunks.push(cur); cur = ""; }
      cur += ln + "\n";
    }
    if (cur) chunks.push(cur);
    await interaction.editReply(`**${title}**\n${chunks[0]}`);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i], flags: 64 });
    }
  };

  // Metric selection
  if (cid === "dash:metric" && interaction.isStringSelectMenu()) {
    const selected = interaction.values?.[0] || "month_oc";
    metricState.set(`${interaction.message.id}:${userId}`, { ...metricState.get(`${interaction.message.id}:${userId}`), metric: selected });
    await interaction.deferUpdate();
    return true;
  }

  // Month selection
  if (cid === "dash:month" && interaction.isStringSelectMenu()) {
    const selected = interaction.values?.[0] || getSelectedMonthForMessage(interaction.message, userId);
    metricState.set(`${interaction.message.id}:${userId}`, { ...metricState.get(`${interaction.message.id}:${userId}`), month: selected });
    await interaction.deferUpdate();
    return true;
  }

  const metric = getSelectedMetricForMessage(interaction.message, userId);
  const computeOpts = { ...metricToComputeOpts(metric), selectedMonth };

  // Hot5 / Hot10 / Hot20
  if (cid === "dash:hot5" || cid === "dash:hot10" || cid === "dash:hot20") {
    const topN = cid === "dash:hot5" ? 5 : cid === "dash:hot10" ? 10 : 20;
    await interaction.deferReply({ flags: 64 });
    try {
      const ranked = await computeGainers(infos, { limitTickers: 300, concurrency: 4, ...computeOpts });
      const picked = ranked.slice(0, topN);
      const lines = picked.map((r, i) => {
        const who = r.firstUserName || "user";
        const pct = r.pct.toFixed(1);
        return `${i + 1}. \`${r.symbol}\`: **${pct}%**, [${who}](${r.firstLink || "#"})`;
      });
      await sendPaged(topN === 5 ? `🔥 Hot 5 (${selectedMonth.split("-").reverse().join(".")})` : topN === 10 ? `🔥 Hot 10 (${selectedMonth.split("-").reverse().join(".")})` : `🔥 Hot 20 (${selectedMonth.split("-").reverse().join(".")})`, lines);
    } catch (e) {
      console.error("dash:hot error:", e);
      await interaction.editReply("לא הצלחתי לחשב תשואות כרגע.");
    }
    return true;
  }

  // Mine
  if (cid.startsWith("dash:mine:")) {
    const uid = cid.split(":")[2] || interaction.user.id;
    await interaction.deferReply({ flags: 64 });
    const mine = infos.filter((v) => v.firstUserId === uid);
    if (!mine.length) {
      await interaction.editReply(`אין טיקרים שהוזכרו ראשונים על ידך ב-${selectedMonth.split("-").reverse().join(".")}.`);
      return true;
    }
    try {
      const ranked = await computeGainers(mine, { limitTickers: 200, concurrency: 4, ...computeOpts });
      const lines = ranked.map((r, i) => {
        const pct = r.pct.toFixed(1);
        const who = r.firstUserName || "you";
        return `${i + 1}. \`${r.symbol}\`: **${pct}%**, [${who}](${r.firstLink || "#"})`;
      });
      await sendPaged(`🎯 Mine (first mentions in ${selectedMonth.split("-").reverse().join(".")})`, lines);
    } catch (e) {
      console.error("dash:mine error:", e);
      await interaction.editReply("תקלה בחישוב תשואות.");
    }
    return true;
  }

  // All
  if (cid === "dash:all") {
    await interaction.deferReply({ flags: 64 });
    const lines = infos.map((v) => {
      const firstUrl = v.firstLink || "#";
      const lastUrl = v.lastLink || "#";
      const lastStr = shortDate(v.lastTs);
      const who = v.firstUserName ? ` (${v.firstUserName})` : "";
      return `• [\`${v.symbol}\`](${firstUrl}) — **${v.countMTD}**${who} — [${lastStr}](${lastUrl})`;
    });
    await sendPaged(`📋 All (${selectedMonth.split("-").reverse().join(".")})`, lines);
    return true;
  }

  // Users dropdown
  if (cid === "dash:user" && interaction.isStringSelectMenu()) {
    try {
      const targetId = interaction.values?.[0];
      if (!targetId) {
        await interaction.deferReply({ flags: 64 });
        await interaction.editReply("לא נבחר משתמש.");
        return true;
      }
      const userFirst = infos.filter((v) => v.firstUserId === targetId);
      if (!userFirst.length) {
        await interaction.deferReply({ flags: 64 });
        await interaction.editReply(`אין טיקרים למשתמש זה ב-${selectedMonth.split("-").reverse().join(".")}.`);
        return true;
      }
      const ranked = await computeGainers(userFirst, { limitTickers: 200, concurrency: 4, ...computeOpts });
      const lines = ranked.map((r, i) => {
        const pct = r.pct.toFixed(1);
        const who = r.firstUserName || "user";
        return `${i + 1}. \`${r.symbol}\`: **${pct}%**, [${who}](${r.firstLink || "#"})`;
      });
      await sendPaged(`👤 User's first mentions (${selectedMonth.split("-").reverse().join(".")})`, lines);
    } catch (e) {
      console.error("dash:user error:", e);
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 }).catch(() => {});
      }
      await interaction.editReply("תקלה בעיבוד הבחירה.");
    }
    return true;
  }

  return false;
}
