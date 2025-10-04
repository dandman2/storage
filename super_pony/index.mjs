import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

import { handleTodaysEarnings } from "./cmd_handlers/todaysEarnings.mjs";
import { handleAnticipatedImage } from "./cmd_handlers/anticipatedImage.mjs";
import { sendHelp } from "./cmd_handlers/help.mjs";
import { listAllTickers } from "./cmd_handlers/listAllTickers.mjs";
import { listMyTickers } from "./cmd_handlers/listMyTickers.mjs";
import { listFirstByUser } from "./cmd_handlers/listFirstByUser.mjs";
import { handleGraphChannelMessage, runBackfillOnce } from "./cmd_handlers/graphChannelHandler.mjs";
import { showTickersDashboard, handleDashboardInteraction } from "./cmd_handlers/tickersDashboard.mjs";
import { deleteAndRepost } from "./cmd_handlers/deleteAndRepost.mjs";
import { registerNewsCmdHandler } from "./cmd_handlers/newsRoleHandler.mjs";
import { registerMonthlyScores } from "./cmd_handlers/monthlyScores.mjs";

import { appendToLog, readRecent, backfillLastDayMessages } from "../utils/liveLog.mjs";
import { askGemini } from "../utils/askGemini.mjs";
import { getATR } from "./cmd_handlers/atr.mjs";

// paths
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "scanner");
const DB_PATH = path.join(DATA_DIR, "db.json");
const ALL_TICKERS_PATH = path.join(DATA_DIR, "all_tickers.txt");

// env
const {
  DISCORD_TOKEN,
  FINNHUB_TOKEN,
  ANTICIPATED_CHANNEL_ID,
  GRAPHS_CHANNEL_ID,
  SCHEDULE_CHANNEL_ID,
  BOT_CHANNEL_ID,
  LOG_CHANNEL_ID,
  DISCORD_GUILD_ID,
  DISCORD_APPLICATION_ID,
  SHUTDOWN_SECRET,
  CHATROOM_IDS
} = process.env;

// shared state
let LIVE_LISTENING_ENABLED = false;

let botLogChannel = null; // channel for bot logs
let botChannel = null; // channel for bot interactions

// graceful shutdown
async function shutdown(reason = "discord-webhook") {
  try {
    console.log(`🛑 Shutting down (${reason})...`);
    if (client) await client.destroy();
  } catch (e) {
    console.error("Error during shutdown:", e);
  } finally {
    process.exit(0);
  }
}

// slash command def
const commands = [
  // ### todays_earnings slash command
  new SlashCommandBuilder()
    .setName("todays_earnings")
    .setDescription("הצג את הטיקרים של החברות שמדווחות היום")
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("איזה סוג של טיקרים להציג")
        .setRequired(false)
        .addChoices(
          { name: "All", value: "all" },
          { name: "S&P 500", value: "sp500" },
          { name: "Anticipated", value: "anticipated" },
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName("limit")
        .setDescription("הגבל את מספר הטיקרים המוצגים")
        .setMinValue(1)
        .setRequired(false)
    ),

  // ### start_survey command
  new SlashCommandBuilder()
    .setName("start_survey")
    .setDescription("פותח חלון הזנה חדש בסקר התשואה החודשי"),

    // ### remind_survey command
  new SlashCommandBuilder()
    .setName("remind_survey")
    .setDescription("שולח תזכורת למשתמשים להשתתף בסקר"),

    // ### publish_survey command
  new SlashCommandBuilder()
    .setName("publish_survey")
    .setDescription("מסכם את התשואות שהתקבלו ומפרסם את התוצאות"),
    
    // ### survey_help command
  new SlashCommandBuilder()
    .setName("survey_help")
    .setDescription("מציג עזרה לגבי הפקודות הזמינות לניהול סקר התשואה החודשי"),

    // ### atr command
    new SlashCommandBuilder()
    .setName('atr')
    .setDescription('Get ATR and ATR% for a stock symbol')
    .addStringOption(o =>
      o.setName('symbol')
        .setDescription('Ticker symbol (e.g., AAPL)')
        .setRequired(true)
    )
    .addIntegerOption(o =>
      o.setName('period')
        .setDescription('ATR period (default 14)')
        .setMinValue(1)
    )
    .addStringOption(o =>
      o.setName('interval')
        .setDescription('Timeframe: daily | weekly | monthly (default daily)')
        .addChoices(
          { name: 'daily', value: 'daily' },
          { name: 'weekly', value: 'weekly' },
          { name: 'monthly', value: 'monthly' },
        )
    )
].map((c) => c.toJSON());


async function registerSlashCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(DISCORD_APPLICATION_ID, DISCORD_GUILD_ID),
    { body: commands }
  );
  console.log("✅ Slash commands registered");
}

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    botLogChannel = client.channels.cache.get(LOG_CHANNEL_ID);
    await botLogChannel.send("🔵 שומר הודעות מחדר בלה-בלה...");
    if (!botLogChannel) {
      console.warn("Bot Log channel not found, wont be able to delete and repost.");
    }

    botChannel = client.channels.cache.get(BOT_CHANNEL_ID);
    if (!botChannel) {
      console.warn("Bot channel not found, wont be able to respond to user commands.");
    }

    registerNewsCmdHandler(client);
    registerMonthlyScores(client);

    // Backfill messages from the last day for specified chat rooms
    const chatRooms = (CHATROOM_IDS || "")
      .split(/[\n]+/)
      .map(s => s.trim())
      .filter(Boolean);
    for (const channelId of chatRooms) {
      try {
        await backfillLastDayMessages(client, channelId);
        console.log(`✅ Backfilled last day's messages for channel ${channelId}`);
      } catch (e) {
        console.error(`Backfill failed for channel ${channelId}:`, e);
      }
    }

    if (botLogChannel) {
      await botLogChannel.send("🔵 מבצע סריקה של הטיקרים בחדר גרפים...");
    } else {
      console.warn("Bot log channel not found, skipping scanning message.");
    }

    try {
      await runBackfillOnce({
        client,
        channelId: GRAPHS_CHANNEL_ID,
        allTickersFile: ALL_TICKERS_PATH,
        dbPath: DB_PATH,
        lookbackDays: 14,
      });
    } catch (e) {
      console.error("Backfill failed:", e);
    }

    console.log("✅ Backfill done; now listening for new messages.");
    if (botLogChannel) {
      await botLogChannel.send("🟢 חזרתי לפעילות, אני זמין, שלחו לי הודעה!");
    } else {
      console.warn("Bot log channel not found, skipping ready message.");
    }
  } catch (e) {
    console.error("Error occurred:", e);
  }
});

// Interaction router (components first!)
client.on("interactionCreate", async (interaction) => {
  try {
    // Handle button and select menu interactions first
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const handled = await handleDashboardInteraction({ interaction, dbPath: DB_PATH });
      if (handled) return;
    }

    // Slash commands, else ignore
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName == "todays_earnings") {
      await interaction.deferReply();
      const filter = interaction.options.getString("type") || "all";
      const limit = interaction.options.getInteger("limit") || 0;

      if (filter === "anticipated") {
        await handleAnticipatedImage({ client, interaction, ANTICIPATED_CHANNEL_ID });
      } else {
        await handleTodaysEarnings({ client, interaction, filter, limit, FINNHUB_TOKEN });
      }
    }
    else if (interaction.commandName == 'atr') {
      // Parse options
      const rawSymbol = interaction.options.getString('symbol', true).trim();
      const symbol = rawSymbol.toUpperCase().replace(/\s+/g, '');
      const period = interaction.options.getInteger('period') ?? 14;
      const interval = interaction.options.getString('interval') ?? 'daily';

      // Basic validation
      if (!/^[A-Z0-9.\-=/_+]{1,15}$/.test(symbol)) {
        await interaction.reply({ content: '❌ סימול לא תקין.', ephemeral: true });
        return;
      }

      // Dynamic import to avoid loading if not needed
      await interaction.deferReply();

      // Fetch ATR
      const { atr, atrPct, close, timestamp } = await getATR(symbol, period, interval);

      var atrInterval = '1D';
      if(interval === 'daily') {
        atrInterval = '1D';
      }
      else if(interval === 'weekly') {
        atrInterval = '1W';
      }
      else if(interval === 'monthly') {
        atrInterval = '1M';
      }

      const msg =
        `**${symbol} · ${atrInterval} · (${close.toFixed(2)}$)**  ${timestamp}:\n` +
        `**ATR(${period}): ${atr.toFixed(2)} ${atrPct.toFixed(2)}%**`;

      await interaction.editReply({ content: msg, allowedMentions: { parse: [] } });
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: "❌ שגיאה בעיבוד הבקשה.", flags: 64 }).catch(() => { });
    } else {
      await interaction.reply({ content: "❌ שגיאה בעיבוד הבקשה.", flags: 64 }).catch(() => { });
    }
  }
});

// Message router
client.on("messageCreate", async (message) => {
  try {
    // Special path for Discord webhook messages
    if (message.webhookId) {
      if (message.channel.id === LOG_CHANNEL_ID) {
        const text = (message.content || "").trim();
        if (text === `shutdown ${SHUTDOWN_SECRET}`) {
          console.log("🔴 Shutdown command received via webhook, shutting down...");
          if (botLogChannel) {
            await botLogChannel.send("🔴 אני יורד לדקה של תחזוקה...");
          } else {
            console.warn("Bot log channel not found, skipping shutdown message.");
          }
          return shutdown();
        }
      }
      return; // ignore other webhook messages
    }

    // Ignore bot messages
    if (message.author.bot) return;

    const inBotRoom = message.channel.id === BOT_CHANNEL_ID;
    const inGraphsRoom = message.channel.id === GRAPHS_CHANNEL_ID;
    const inScheduleRoom = message.channel.id === SCHEDULE_CHANNEL_ID;
    // Limit logging to certain channel IDs (line separated). If empty => log None.
    const chatRooms = (CHATROOM_IDS || "")
      .split(/[\n]+/)
      .map(s => s.trim())
      .filter(Boolean);

    // Stream-log messages (only if channel allowed)
    const shouldLog = chatRooms.length > 0 && chatRooms.includes(message.channel.id);
    if (shouldLog) {
      try {
        await appendToLog(message);
      } catch (err) {
        console.error("Failed to log message: ", err);
      }
    }

    const content = (message.content || "").trim();
    if (!content) return; // Ignore empty messages

    // Handle messages in the graphs room
    if (inGraphsRoom) {
      if (content) {
        // Log user's message in the DB
        await handleGraphChannelMessage({
          message,
          allTickersFile: ALL_TICKERS_PATH,
          dbPath: DB_PATH,
          silent: true,
          updateCheckpoint: true,
        });

        // Delete and repost the message
        if (!LIVE_LISTENING_ENABLED) return;
        let userInitials = message.author.username.replace(/[aeiou\.]/g, "").toLowerCase() || "pny";
        if (userInitials.length > 3) {
          userInitials = userInitials.substring(0, 3);
        }
        console.log(`🔄 Reposting message from ${message.author.tag} in #${message.channel.name} as ${userInitials}`);

        try {
          await deleteAndRepost(message, botLogChannel, userInitials);
          console.log(`🔄 Reposted message from ${message.author.tag} in #${message.channel.name}`);
        } catch (err) {
          console.error(`❌ Failed to repost message from ${message.author.tag} in #${message.channel.name}:`, err);
          if (message.channel.send) {
            await message.channel.send(`❌ לא הצלחתי לפרסם את ההודעה שלך, אנא נסה שוב, או פנה למנהל השרת.`);
          }
        }
      }
      return;
    }

    // Clean the content: remove mentions and normalize
    let cleanContent = content.replace(/<@!?[0-9]+>/g, "").trim().toLowerCase();
    // also remove "@superpony" and the bot's ID
    cleanContent = cleanContent.replace(/@superpony/g, "").replace(/<@&1398710664079474789>/g, "").trim();

    // Check if the message mentions the bot or contains its ID
    const mentionsBot = (client.user?.id && message.mentions.users.has(client.user.id)) || content.includes("@superpony") || content.includes("1398710664079474789");
    if (!mentionsBot) return;

    // If in schedule room, handle scheduled messages
    if (inScheduleRoom) {
      if (cleanContent === "ססמי המחק" || cleanContent === "ססמי מחק" || cleanContent === "ססמי תמחק") {
        console.log(`🗑️ User ${message.author.tag} requested to delete the schedule room message`);
        // delete all the messages in the schedule room from all users and bots
        const deletableMessages = await message.channel.messages.fetch({ limit: 100 });
        if (deletableMessages.size > 0) {
          await message.channel.bulkDelete(deletableMessages);
          console.log(`🗑️ Deleted ${deletableMessages.size} messages in the schedule room.`);
        } else {
          console.log("🗑️ No messages to delete in the schedule room.");
        }
      }
      return; // Ignore other messages in the schedule room
    }

    // Ignore messages not in the bot room
    if (!inBotRoom) return;

    console.log(`🔔 Message from: ${message.author.tag}, in channel: ${message.channel.name}, mentions: ${message.mentions.users}, content: `, content);

    const otherMentions = message.mentions.users.filter(u => u.id !== client.user.id);

    // Mine
    if (otherMentions.size === 0 && (cleanContent === "טיקרים שלי" || cleanContent === "שלי")) {
      console.log(`📈 User ${message.author.tag} requested their tickers`);
      await listMyTickers({ message, dbPath: DB_PATH });
      return;
    }

    // List all tickers
    if (otherMentions.size === 0 && (cleanContent === "כל הטיקרים" || cleanContent === "כל טיקרים")) {
      console.log(`📜 User ${message.author.tag} requested the full ticker list`);
      await listAllTickers({ message, dbPath: DB_PATH });
      return;
    }

    // Dashboard (primary entrypoint)
    if (otherMentions.size === 0 && cleanContent === "טיקרים") {
      console.log(`📊 User ${message.author.tag} requested the dashboard`);
      await showTickersDashboard({ message, dbPath: DB_PATH });
      return;
    }

    // Other user tickers
    if (otherMentions.size > 0 && (cleanContent === "טיקרים" || cleanContent === "הטיקרים" || cleanContent === "של")) {
      console.log(`🔍 User ${message.author.tag} requested tickers for: ${otherMentions.map(u => u.tag).join(", ")}`);
      const targetUser = otherMentions.first();
      await listFirstByUser({ message, dbPath: DB_PATH, targetUser });
      return;
    }

    // Earnings
    if (cleanContent === "דיווחים 500") {
      console.log(`📈 User ${message.author.tag} requested S&P 500 earnings`);
      await handleTodaysEarnings({
        client,
        interaction: { channel: message.channel, followUp: (t) => message.channel.send(t) },
        filter: "sp500",
        limit: 0,
        FINNHUB_TOKEN,
      });
      return;
    }

    // List all tickers as an image
    if (cleanContent === "תמונת דיווחים" || cleanContent === "תמונה") {
      console.log(`🖼️ User ${message.author.tag} requested anticipated earnings image`);
      await handleAnticipatedImage({
        client,
        interaction: { followUp: (t) => message.channel.send(t) },
        ANTICIPATED_CHANNEL_ID,
      });
      return;
    }

    // All earnings
    if (cleanContent === "דיווחים" || cleanContent === "מדווחות") {
      console.log(`📈 User ${message.author.tag} requested all earnings`);
      await handleTodaysEarnings({
        client,
        interaction: { channel: message.channel, followUp: (t) => message.channel.send(t) },
        filter: "all",
        limit: 0,
        FINNHUB_TOKEN,
      });
      return;
    }

    // Fallback: Treat any other text as a Gemini question
    if (cleanContent) {
      console.log(`❓ User ${message.author.tag} asked Gemini: ${cleanContent}`);
      try {
        await message.channel.send("🔍 מחפש תשובה לשאלה שלך, זה יכול לקחת כמה שניות...");

        const response = await askGemini(cleanContent, message.channel.id);
        // console.log("[Discord.send] chars:", (response || "").length, "preview:", (response || "").slice(0, 300).replace(/\n/g, " "));

        const maxLen = 1500;
        let responseLines = response.split("\n").map(line => line.trim()).filter(line => line.length > 0);
        let chunk = "";
        for (const line of responseLines) {
          if ((chunk + line + "\n").length > maxLen) {
            // console.log("[Discord.send] chars:", (chunk).length, "chunk:", chunk);
            await message.channel.send(chunk);
            chunk = "";
          }
          // is line larger than maxLen, split it
          if (line.length > maxLen) {
            const parts = line.match(new RegExp(`.{1,${maxLen}}`, "g")) || [];
            for (const part of parts) {
              await message.channel.send(part);
            }
            continue;
          }
          else {
            chunk += line + "\n";
          }
        }
        await message.channel.send(chunk);
      } catch (err) {
        console.error(`Failed to process Gemini question: ${cleanContent}`, err);
        await message.channel.send("❌ שגיאה בעיבוד השאלה, אנא נסה שוב.");
      }
      return;
    }

    // No matching command or question - return help
    await sendHelp({ channel: message.channel });

  } catch (err) {
    console.error("messageCreate handler error:", err);
    if (message?.channel?.send) {
      await message.channel.send("❌ קרתה שגיאה בעיבוד הבקשה.");
    }
  }
});

// global error handlers
process.on("unhandledRejection", (err) => {
  console.error("UnhandledRejection:", err);
  shutdown();
});

process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
  shutdown();
});

await registerSlashCommands();
client.login(DISCORD_TOKEN);