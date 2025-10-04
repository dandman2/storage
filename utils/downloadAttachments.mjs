// Download all attachments to Buffers so they survive deletion + reupload.
// Node 18+ has global fetch. For older Node, `npm i node-fetch` and import it.
export async function downloadAttachments(attachments) {
    const files = [];
    for (const att of attachments.values()) {
      try {
        const resp = await fetch(att.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} when fetching ${att.url}`);
        const ab = await resp.arrayBuffer();
        files.push({ attachment: Buffer.from(ab), name: att.name ?? "file" });
      } catch (err) {
        console.warn(`Failed to download attachment ${att.url}:`, err);
      }
    }
    return files;
  }
  