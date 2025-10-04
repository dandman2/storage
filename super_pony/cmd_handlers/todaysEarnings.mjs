import axios from "axios";
import fs from "fs/promises";
import path from "path";

const SP_FILE = path.resolve("./super_pony/sp500.json");

async function loadSP500() {
  try {
    const txt = await fs.readFile(SP_FILE, "utf-8");
    const { updated, symbols } = JSON.parse(txt);
    if ((Date.now() - Date.parse(updated)) / 86400000 < 30) return symbols;
  } catch {}
  const csvUrl = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv";
  const { data: csv } = await axios.get(csvUrl);
  const symbols = csv
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[0])
    .filter(Boolean);
  await fs.writeFile(
    SP_FILE,
    JSON.stringify({ updated: new Date().toISOString(), symbols }, null, 2),
    "utf-8"
  );
  return symbols;
}

const timeMap = {
  amc: "After Market Close",
  bmo: "Before Market Open",
  dmh: "During Market Hours",
  "": "Unknown Time",
};

const order = [
  "Before Market Open",
  "During Market Hours",
  "After Market Close",
  "Unknown Time",
];

function todayInIsraelYYYYMMDD() {
  const tz = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  const y = tz.getFullYear();
  const m = String(tz.getMonth() + 1).padStart(2, "0");
  const d = String(tz.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function handleTodaysEarnings({ client, interaction, filter = "all", limit = 0, FINNHUB_TOKEN }) {
  try {
    const sp500 = await loadSP500();
    const today = todayInIsraelYYYYMMDD();
    const { data } = await axios.get(
      `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${today}&token=${FINNHUB_TOKEN}`
    );
    let items = data.earningsCalendar || data;

    if (filter === "sp500") {
      items = items.filter((e) => sp500.includes(e.symbol));
    }
    if (limit) items = items.slice(0, limit);

    if (!items.length) {
      return interaction.followUp ? interaction.followUp("לא מצאתי דיווחי רווחים להיום.") : null;
    }

    const groups = items.reduce((acc, e) => {
      const label = timeMap[e.hour] || e.hour || "Unknown Time";
      (acc[label] = acc[label] || []).push(e.symbol);
      return acc;
    }, {});

    const channel = interaction.channel ?? (interaction.channelId ? await client.channels.fetch(interaction.channelId) : null);
    if (!channel) {
      return interaction.followUp ? interaction.followUp("❌ לא הצלחתי לשלוח הודעות לערוץ.") : null;
    }

    const maxLen = 1900;
    for (const label of order) {
      const syms = groups[label] || [];
      if (!syms.length) continue;

      let chunk = `—————————————————————————\n**${label}:**\n—————————————————————————\n`;
      for (const sym of syms) {
        const part = `${sym}, `;
        if ((chunk + part).length > maxLen) {
          await channel.send(chunk.replace(/, $/, ""));
          chunk = "";
        }
        chunk += part;
      }
      await channel.send(chunk.replace(/, $/, ""));
    }

    return interaction.followUp
      ? interaction.followUp(`נמצאו ${items.length} דיווחי רווחים להיום.`)
      : null;
  } catch (e) {
    console.error(e);
    return interaction.followUp ? interaction.followUp("❌ מתנצל, קרתה שגיאה בשליפת דיווחי הרווחים.") : null;
  }
}
