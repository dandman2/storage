import axios from "axios";
import sharp from "sharp";
import { AttachmentBuilder } from "discord.js";

export async function handleAnticipatedImage({ client, interaction, ANTICIPATED_CHANNEL_ID }) {
  try {
    const channel = await client.channels.fetch(ANTICIPATED_CHANNEL_ID);

    // --- find the correct image by the Hebrew phrase + date ---
    const fetched = await channel.messages.fetch({ limit: 50 });
    const DATE_RE = /מדווחות בשבוע\s*(\d{2}\.\d{2}\.\d{4})/;

    function parseDDMMYYYY(s) {
      const [dd, mm, yyyy] = s.split(".").map(Number);
      return new Date(yyyy, mm - 1, dd);
    }

    function imageUrlFromMessage(m) {
      if (m.attachments.size > 0) return m.attachments.first().url;
      const img = m.embeds.find(e => e?.image?.url)?.image?.url
               || m.embeds.find(e => e?.thumbnail?.url)?.thumbnail?.url;
      return img || null;
    }

    const candidates = [];
    for (const m of fetched.values()) {
      const embedText = m.embeds
        .map(e => [e.title, e.description].filter(Boolean).join(" "))
        .join(" ");
      const text = `${m.content || ""} ${embedText}`.trim();
      const match = DATE_RE.exec(text);
      if (!match) continue;

      const dt = parseDDMMYYYY(match[1]);
      const imgUrl = imageUrlFromMessage(m);
      if (!imgUrl || Number.isNaN(dt.getTime())) continue;

      candidates.push({ dt, imgUrl, msg: m });
    }

    candidates.sort((a, b) => {
      const d = b.dt - a.dt;
      return d !== 0 ? d : b.msg.createdTimestamp - a.msg.createdTimestamp;
    });

    if (candidates.length === 0) {
      return interaction.followUp("❌ לא נמצאה תמונה עם תבנית 'מדווחות בשבוע dd.mm.yyyy'.");
    }

    const url = candidates[0].imgUrl;

    // --- crop as before ---
    const resp = await axios.get(url, { responseType: "arraybuffer" });
    const imgBuf = Buffer.from(resp.data);

    const presets = {
      1: { left: 5, top: 80, width: 265, height: 587 },
      2: { left: 267, top: 80, width: 265, height: 587 },
      3: { left: 532, top: 80, width: 265, height: 587 },
      4: { left: 795, top: 80, width: 265, height: 587 },
      5: { left: 1059, top: 80, width: 140, height: 587 },
    };

    const israelDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
    const day = israelDate.getDay(); // 0=Sun ... 6=Sat
    const region = presets[day] || presets[1];

    const cropped = await sharp(imgBuf).extract(region).toBuffer();
    const file = new AttachmentBuilder(cropped, { name: "today.png" });
    return interaction.followUp({ files: [file] });
  } catch (err) {
    console.error(err);
    return interaction.followUp("❌ שגיאה בחיתוך התמונה.");
  }
}
