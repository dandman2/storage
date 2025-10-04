import fs from "fs/promises";
import fssync from "fs";
import path from "path";
import { promisify } from "util";
import { exec as execCb } from "child_process";

/** ---- config ---- */
const DISCORD_EPOCH = 1420070400000n; // 2015-01-01

/** Cache the tickers set in-memory to avoid rereads */
let _tickerSet = null;
let _blacklistSet = null;
let _tickerFilePath = null;

/** Simple write queue to serialize db.json writes */
let writeQueue = Promise.resolve();

/** Pre-compiled regex
 * Standalone words only:
 * - left boundary: start or whitespace/quote/bracket
 * - right boundary: end or whitespace/quote/bracket/punct (not '/')
 * Supports: TSLA / $TSLA / BRK.B / BRK-B
 * Avoids: ".com/..." and other URL/domain hits.
 * Boundaries are LATIN-only, so Hebrew next to a ticker is still a boundary.
 */
const TICKER_RE = /(?:^|[\s"'`([{<]|[^\x00-\x7F])\$?([A-Za-z]{1,5}(?:[.\-][A-Za-z]{1,2})?)(?=$|[\s"'`)\]}>.,:;!?]|[^\x00-\x7F])/gu;
const TICKER_RE_FALLBACK = /(?:^|[^A-Za-z0-9])\$?([A-Za-z]{1,5}(?:[.-][A-Za-z]{1,2})?)(?=$|[^A-Za-z0-9])/g;

const exec = promisify(execCb);

/** -------- blacklist -------- */
function getBlacklistSet() {
  if (_blacklistSet) return _blacklistSet;

  // Env is a single string (possibly multiline). If absent, fall back to defaults.
  const rawEnv = process.env.TICKER_BLACKLIST;
  const raw = (typeof rawEnv === "string" && rawEnv.trim().length > 0)
    ? rawEnv
    : DEFAULT_BLACKLIST.join("\n");

  const list = raw
    .split(/[\s,;]+/)              // split on newlines, spaces, commas, semicolons
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  _blacklistSet = new Set(list);
  return _blacklistSet;
}

/** Ensure directory exists for a file path */
async function ensureDirFor(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/** Load tickers (one per line) into an uppercase Set */
async function loadTickerSet(allTickersFile) {
  if (_tickerSet && _tickerFilePath === allTickersFile) return _tickerSet;
  if (!fssync.existsSync(allTickersFile)) {
    throw new Error(`Missing tickers file: ${allTickersFile}`);
  }
  const txt = await fs.readFile(allTickersFile, "utf-8");
  _tickerSet = new Set(
    txt
      .split(/\r?\n/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
  _tickerFilePath = allTickersFile;
  return _tickerSet;
}

/** Extract possible tickers and validate against the Set + blacklist */
function extractTickers(text, tickerSet) {
  if (!text) return [];
  const found = new Set();
  const blacklistSet = getBlacklistSet();

  // try main regex
  TICKER_RE.lastIndex = 0;
  let m;
  while ((m = TICKER_RE.exec(text)) !== null) {
    const cand = m[1].toUpperCase().replace(/-/g, ".");
    if (tickerSet.has(cand) && !blacklistSet.has(cand)) found.add(cand);
  }

  // optional fallback if nothing matched (older runtimes)
  if (found.size === 0) {
    TICKER_RE_FALLBACK.lastIndex = 0;
    while ((m = TICKER_RE_FALLBACK.exec(text)) !== null) {
      const cand = m[1].toUpperCase().replace(/-/g, ".");
      if (tickerSet.has(cand) && !blacklistSet.has(cand)) found.add(cand);
    }
  }
  return [...found];
}

/** DB helpers */
async function loadDb(dbPath) {
  try {
    const txt = await fs.readFile(dbPath, "utf-8");
    const json = JSON.parse(txt);
    if (Array.isArray(json)) return { updated: new Date().toISOString(), entries: json, checkpoints: {} };
    if (!json.entries) json.entries = [];
    if (!json.checkpoints) json.checkpoints = {};
    return json;
  } catch {
    return { updated: new Date().toISOString(), entries: [], checkpoints: {} };
  }
}
async function saveDb(dbPath, db) {
  await ensureDirFor(dbPath);
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), "utf-8");
}

/** Compare two snowflake strings (by BigInt) */
function snowflakeGt(a, b) {
  if (!b) return true;
  return BigInt(a) > BigInt(b);
}

/** Convert timestamp (ms) -> synthetic snowflake string */
function snowflakeFromTsMs(ts) {
  const n = (BigInt(ts) - DISCORD_EPOCH) << 22n; // worker=0, process=0, inc=0
  return n.toString();
}

/** Update checkpoint for a channel (only if id is newer) */
async function updateCheckpoint(dbPath, channelId, msgId, tsIso) {
  writeQueue = writeQueue.then(async () => {
    const db = await loadDb(dbPath);
    const cp = db.checkpoints[channelId] || {};
    if (!cp.lastProcessedId || snowflakeGt(msgId, cp.lastProcessedId)) {
      db.checkpoints[channelId] = {
        lastProcessedId: msgId,
        lastProcessedAt: tsIso,
      };
      db.updated = new Date().toISOString();
      await saveDb(dbPath, db);
    }
  });
  return writeQueue;
}

/** Append multiple entries in a single read/write; dedupe by (messageId,ticker) */
async function appendEntries(dbPath, entries) {
  if (!entries.length) return;
  await ensureDirFor(dbPath);
  writeQueue = writeQueue.then(async () => {
    const db = await loadDb(dbPath);
    const have = new Set(db.entries.map((e) => `${e.messageId}:${e.ticker}`));
    let added = 0;
    for (const entry of entries) {
      const key = `${entry.messageId}:${entry.ticker}`;
      if (have.has(key)) continue;
      db.entries.push(entry);
      have.add(key);
      added++;
    }
    if (added > 0) {
      db.updated = new Date().toISOString();
      await saveDb(dbPath, db);
    }
  });
  return writeQueue;
}

/** Git commit helper (safe to call when nothing changed) */
export async function commitDbIfChanged(dbPath) {
  try {
    await exec('git config user.name "github-actions[bot]"');
    await exec('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');

    await exec(`git add "${dbPath}"`);
    try {
      await exec("git diff --cached --quiet");
      return false; // nothing to commit
    } catch {}
    await exec('git commit -m "chore(scanner): update db.json [skip ci]"');
    try {
      await exec("git push");
    } catch {
      try {
        await exec("git pull --rebase --autostash");
        await exec("git push");
      } catch {}
    }
    console.log("✅ Pushed db.json changes.");
    return true;
  } catch (e) {
    console.error("git commit/push failed:", e?.message || e);
    return false;
  }
}

/**
 * Handle a single message in GRAPHS_CHANNEL_ID:
 * - Extract tickers, save entries, optionally commit+push
 */
export async function handleGraphChannelMessage({
  message,
  allTickersFile = "../scanner/all_tickers.txt",
  dbPath = "../scanner/db.json",
  silent = false,
  updateCheckpoint: doCheckpoint = true,
  commitAfterWrite = true, // live messages: true; backfill: false
}) {
  const content = message.content?.trim();
  if (!content) {
    if (doCheckpoint) {
      await updateCheckpoint(
        dbPath,
        message.channel.id,
        message.id,
        new Date(message.createdTimestamp).toISOString()
      );
    }
    return;
  }

  const tickerSet = await loadTickerSet(allTickersFile);
  const tickers = extractTickers(content, tickerSet);

  if (tickers.length > 0) {
    const displayName =
      message.member?.nickname ||
      message.member?.displayName ||
      message.author.globalName ||
      message.author.username;

    const entries = tickers.map((ticker) => ({
      ticker,
      user: { id: message.author.id, name: displayName },
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guildId,
      link: message.url,
      timestamp: new Date(message.createdTimestamp).toISOString(),
      content,
    }));

    await appendEntries(dbPath, entries);

    if (commitAfterWrite) {
      await commitDbIfChanged(dbPath);
    }

    if (!silent) {
      for (const ticker of tickers) {
        await message.channel.send(`logged ticker: ${ticker} from user: ${displayName}`);
      }
    }
  }

  if (doCheckpoint) {
    await updateCheckpoint(
      dbPath,
      message.channel.id,
      message.id,
      new Date(message.createdTimestamp).toISOString()
    );
  }
}

/**
 * One-time backfill on startup:
 * - No per-message commits; we commit once at the end.
 */
export async function runBackfillOnce({
  client,
  channelId,
  allTickersFile = "./scanner/all_tickers.txt",
  dbPath = "./scanner/db.json",
  lookbackDays = 14,
}) {
  if (!channelId) throw new Error("runBackfillOnce: channelId is required");
  const channel = await client.channels.fetch(channelId);

  const db = await loadDb(dbPath);
  const cp = db.checkpoints[channelId];

  let afterId;
  if (cp?.lastProcessedId) {
    afterId = cp.lastProcessedId;
  } else {
    const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
    afterId = snowflakeFromTsMs(cutoff);
  }

  let scanned = 0;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, after: afterId });
    if (batch.size === 0) break;

    const msgs = Array.from(batch.values()).sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp
    );

    for (const message of msgs) {
      if (!message.author?.bot) {
        const mentionsBot =
          (client.user?.id && message.mentions.users.has(client.user.id)) ||
          message.content?.includes("@SuperPony");
        if (!mentionsBot) {
          await handleGraphChannelMessage({
            message,
            allTickersFile,
            dbPath,
            silent: true,
            updateCheckpoint: false,
            commitAfterWrite: false, // <= no per-message commits during backfill
          });

          await updateCheckpoint(
            dbPath,
            channelId,
            message.id,
            new Date(message.createdTimestamp).toISOString()
          );
        }
      }

      afterId = message.id;
      scanned++;
    }
  }

  // Flush queued writes and commit ONCE for the whole backfill
  await writeQueue;
  await commitDbIfChanged(dbPath);

  console.log(`Backfill complete for channel ${channelId}. Scanned ${scanned} messages.`);
}

export function flushTickerDbWrites() {
  return writeQueue;
}
