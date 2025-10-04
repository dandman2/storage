// Forward the original message to a private botChannel with metadata for audit.
export async function forwardMessage(message, botChannel, files) {
    const contentLines = [
      `👤 From: <@${message.author.id}>`,
      `#️⃣ Channel: #${message.channel?.name ?? "unknown"}`,
      `🆔 Msg ID: ${message.id}`,
    ];
    const content = [contentLines.join("  •  "), message.content ?? ""]
      .filter(Boolean)
      .join("\n");
  
    return botChannel.send({
      content: content || (files?.length ? "" : "(no content)"),
      files: files?.length ? files : undefined,
      stickers: message.stickers?.map(s => s.id) ?? undefined,
      allowedMentions: { parse: [] },
    });
  }
  