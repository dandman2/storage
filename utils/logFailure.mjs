// Log a failure to the private botChannel for admin triage.
export async function logFailure(botChannel, origMessage, error) {
    const header = `⚠️ Mirror failed for message ${origMessage.id} by <@${origMessage.author.id}> in #${origMessage.channel?.name}`;
    const body = "```\n" + (error?.stack || error?.message || String(error)) + "\n```";
    const text = `${header}\n${body}`;
    try {
      await botChannel.send({ content: text, allowedMentions: { parse: [] } });
    } catch (e) {
      console.error("Failed to log failure to botChannel:", e);
    }
  }
  