import { PermissionFlagsBits } from "discord.js";
import { downloadAttachments } from "../../utils/downloadAttachments.mjs";
import { forwardMessage } from "../../utils/forwardMessage.mjs";
import { repostMessage } from "../../utils/repostMessage.mjs";
import { logFailure } from "../../utils/logFailure.mjs";

/**
 * Forward -> Delete original -> Repost -> Delete forward on success.
 * If repost fails, keeps the forward in botChannel for admin review.
 *
 * @param {import('discord.js').Message} message
 * @param {import('discord.js').TextChannel} botLogChannel - private/admin-only channel
 */
export async function deleteAndRepost(message, botLogChannel, userInitials) {
  // Skip bots/webhooks
  if (!message || message.author?.bot || message.webhookId) return;
  if (!botLogChannel) throw new Error("botChannel is required");

  const me = message.guild?.members?.me;
  const permsOriginal = me?.permissionsIn(message.channel);
  const permsBotChan = me?.permissionsIn(botLogChannel);

  if (!permsOriginal?.has(PermissionFlagsBits.ManageMessages)) {
    throw new Error("Missing ManageMessages in original channel.");
  }
  if (!permsOriginal?.has(PermissionFlagsBits.SendMessages)) {
    throw new Error("Missing SendMessages in original channel.");
  }
  if (!permsBotChan?.has(PermissionFlagsBits.SendMessages)) {
    throw new Error("Missing SendMessages in botChannel.");
  }

  // 1) Download attachments once for reuse
  const files = await downloadAttachments(message.attachments);

  // 2) Forward to botChannel (audit copy)
  const forwardMsg = await forwardMessage(message, botLogChannel, files);

  // 3) Delete original immediately
  await message.delete().catch(err => {
    throw new Error(`Failed to delete original: ${err?.message || err}`);
  });

  // 4) Repost in original channel
  try {
    await repostMessage(message, files, userInitials);
    // 5) Success -> delete the forward copy
    await forwardMsg.delete().catch(() => {});
  } catch (err) {
    // Failure -> keep forward for admin and log
    console.error("Resend failed, kept forward in botChannel:", err);
    await logFailure(botLogChannel, message, err);
    throw err;
  }
}
