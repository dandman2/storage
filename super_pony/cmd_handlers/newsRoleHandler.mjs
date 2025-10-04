// newsRoleHandler.mjs
// ESM module for discord.js v14
// Adds/removes a "news" role for users via text commands, only inside BOT_CHANNEL_ID

import {
    ChannelType,
    PermissionsBitField,
  } from "discord.js";
  
  /**
   * Environment variables (configure in your host):
   * - BOT_CHANNEL_ID   (required)  -> channel where the bot listens to these commands
   * - NEWS_ROLE_ID     (optional)  -> if you already have a role, set its ID here
   * - NEWS_ROLE_NAME   (optional)  -> defaults to "news" (used if NEWS_ROLE_ID not provided)
   * - CMD_PREFIX       (optional)  -> defaults to "!"
   */
  const BOT_CHANNEL_ID = process.env.BOT_CHANNEL_ID;
  const NEWS_ROLE_ID = process.env.NEWS_ROLE_ID || "";
  const NEWS_ROLE_NAME = (process.env.NEWS_ROLE_NAME || "news").trim();
  const CMD_PREFIX = (process.env.CMD_PREFIX || "!").trim();
  
  // Basic guards
  if (!BOT_CHANNEL_ID) {
    console.error("❌ Missing BOT_CHANNEL_ID env var (required).");
  }
  
  function normalize(str) {
    return (str || "").trim().toLowerCase();
  }
  
  /**
   * Resolve (or create) the news role on this guild.
   * If NEWS_ROLE_ID is provided, we fetch it by ID.
   * Otherwise we look by name (case-insensitive). If not found, we create it.
   */
  async function getOrCreateNewsRole(guild) {
    if (!guild) return null;
  
    // Prefer by ID if provided
    if (NEWS_ROLE_ID) {
      try {
        const byId = await guild.roles.fetch(NEWS_ROLE_ID);
        if (byId) {
          // Ensure it's mentionable so @news notifies members
          if (!byId.mentionable) {
            await byId.edit({ mentionable: true }, "Ensure @news mentions notify");
          }
          return byId;
        }
      } catch {}
    }
  
    // Try by name (case-insensitive)
    await guild.roles.fetch(); // ensure cache
    let role =
      guild.roles.cache.find(
        (r) => normalize(r.name) === normalize(NEWS_ROLE_NAME)
      ) || null;
  
    if (role) {
      if (!role.mentionable) {
        role = await role.edit({ mentionable: true }, "Ensure @news mentions notify");
      }
      return role;
    }
  
    // Create the role if missing
    // No special permissions; mentionable so @news pings members
    const me = guild.members.me || (await guild.members.fetchMe());
    // Ensure the bot can manage roles
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      throw new Error(
        "Bot lacks Manage Roles permission. Grant it to allow creating/assigning the news role."
      );
    }
  
    const created = await guild.roles.create({
      name: NEWS_ROLE_NAME,
      mentionable: true,
      reason: "Self-subscribe role for news ping",
    });
  
    return created;
  }
  
  async function handleRegister(member, role) {
    if (!member || !role) return { ok: false, msg: "Internal error." };
  
    if (member.roles.cache.has(role.id)) {
      return { ok: true, msg: `You already have the @${role.name} role.` };
    }
    await member.roles.add(role, "User opted-in to news");
    return { ok: true, msg: `Added @${role.name}. You will be notified on @${role.name} mentions.` };
  }
  
  async function handleUnregister(member, role) {
    if (!member || !role) return { ok: false, msg: "Internal error." };
  
    if (!member.roles.cache.has(role.id)) {
      return { ok: true, msg: `You don't have @${role.name} yet.` };
    }
    await member.roles.remove(role, "User opted-out from news");
    return { ok: true, msg: `Removed @${role.name}. You will no longer be notified.` };
  }
  
  /**
   * Install the message listener.
   * Only reacts in the BOT_CHANNEL_ID and ignores all other channels/DMs.
   * Commands:
   *   !news register
   *   !news unregister
   */
  export function registerNewsCmdHandler(client) {
    if (!client) throw new Error("registerNewsCmdHandler: client is required");
  
    client.on("messageCreate", async (message) => {
      try {
        // Ignore bots, DMs, threads, and wrong channels
        if (message.author?.bot) return;
        if (!message.guild) return; // no DMs
        if (message.channel?.type !== ChannelType.GuildText) return;
        if (message.channelId !== BOT_CHANNEL_ID) return;
  
        const content = normalize(message.content);
  
        // Accept exact commands with prefix:
        // !news register  /  !news unregister
        if (!content.startsWith(normalize(CMD_PREFIX) + "news")) return;
  
        const parts = content.split(/\s+/g); // e.g., ["!news","register"]
        const cmd = parts[1] || "";
        if (!["register", "unregister"].includes(cmd)) return;
  
        // Ensure we can resolve/create the role
        const role = await getOrCreateNewsRole(message.guild);
        if (!role) {
          await message.reply("❌ Could not access or create the news role. Ask an admin to check my permissions.");
          return;
        }
  
        // Ensure the bot can manage member roles
        const me = message.guild.members.me || (await message.guild.members.fetchMe());
        if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          await message.reply("❌ I need the **Manage Roles** permission to assign/remove the news role.");
          return;
        }
  
        // Ensure role position is below the bot's highest role
        const myTop = me.roles.highest?.position ?? 0;
        if (role.position >= myTop) {
          await message.reply("❌ My highest role must be above the news role to manage it. Please adjust role order.");
          return;
        }
  
        const member =
          message.member || (await message.guild.members.fetch(message.author.id));
  
        let result;
        if (cmd === "register") {
          result = await handleRegister(member, role);
        } else {
          result = await handleUnregister(member, role);
        }
  
        await message.react(result.ok ? "✅" : "⚠️");
        await message.reply(result.msg);
      } catch (err) {
        console.error("newsRoleHandler error:", err);
        try {
          await (message?.reply?.("⚠️ An error occurred. Ask an admin to check the logs.") ?? Promise.resolve());
        } catch {}
      }
    });
  }
  