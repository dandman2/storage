// /utils/repostMessage.js
import { anonymizeTradingViewIfNeeded } from "./anonymizeTradingView.mjs";

// Repost the message as the bot in the original channel, preserving reply + stickers.
export async function repostMessage(message, files, userInitials) {
  const replyTargetId = message.reference?.messageId ?? null;
  const stickerIds = message.stickers?.map(s => s.id) ?? [];

  // 🔒 Anonymize only images that contain the TradingView header with username
  const processedFiles = files?.length
    ? await Promise.all(files.map(anonymizeTradingViewIfNeeded))
    : undefined;

  const options = {
    content: (`${message.content}\n[@${userInitials}](https://discord.com/channels/1397974486581772494/1397977551078686871)\n\n> אין באמור משום ייעוץ השקעות או ייעוץ פיננסי, וכל פעולה שתבצעו היא על אחריותכם בלבד.` ?? "") || (processedFiles?.length ? "" : "(no content)"),
    files: processedFiles,
    allowedMentions: { parse: [] }, // avoid accidental pings; tweak if needed
    reply: replyTargetId
      ? { messageReference: replyTargetId, failIfNotExists: false }
      : undefined,
    stickers: stickerIds.length ? stickerIds : undefined,
  };

  return message.channel.send(options);
}
