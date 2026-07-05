import { Client } from "discord.js-selfbot-v13";
import { sendShapesMessage, pollShapesReply } from "./shapes.js";
import { loadRoom, saveRoom } from "./roomConfig.js";
import { addToHistory, getHistory, clearHistory } from "./messageHistory.js";
import { getAnyWorkingAccount } from "./cookies.js";
import { createShapesRoom } from "./shapes.js";

const SHAPE_USERNAME = "mateoia";

async function ensureRoom(): Promise<{ roomId: string; accountNum: number }> {
  const existing = loadRoom();
  if (existing) return existing;

  console.log(`[selfbot] Creando sala única para ${SHAPE_USERNAME}...`);
  const info = await getAnyWorkingAccount();
  if (!info) throw new Error("[selfbot] No hay ninguna cuenta disponible");

  const { roomId, accountNum } = await createShapesRoom(
    info.accountNum,
    `Mateoia — sala principal`,
    SHAPE_USERNAME
  );
  saveRoom({ roomId, accountNum });
  return { roomId, accountNum };
}

function sanitize(text: string): string {
  return text.replace(/\|\|([^|]+)\|\|/g, "$1");
}

function splitIntoChunks(text: string, size = 1900): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > size) {
    const cut = remaining.lastIndexOf("\n", size);
    const pos = cut > 0 ? cut : size;
    chunks.push(remaining.slice(0, pos).trim());
    remaining = remaining.slice(pos).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function buildContextMessage(
  locationLine: string,
  history: Array<{ username: string; content: string }>,
  authorName: string,
  messageText: string
): string {
  const lines: string[] = [];
  lines.push(`[${locationLine}]`);
  if (history.length > 0) {
    lines.push(`[Últimos ${history.length} mensajes del canal:]`);
    for (const h of history) lines.push(`${h.username}: ${h.content}`);
  }
  lines.push(`[Mensaje actual de ${authorName}:]`);
  lines.push(messageText);
  return lines.join("\n");
}

const channelQueues = new Map<string, Promise<void>>();

function queueForChannel(channelId: string, fn: () => Promise<void>): void {
  const prev = channelQueues.get(channelId) ?? Promise.resolve();
  const next = prev.then(() => fn()).catch((err) => {
    console.error(`[selfbot] Error en cola del canal ${channelId}:`, err);
  });
  channelQueues.set(channelId, next);
  next.finally(() => {
    if (channelQueues.get(channelId) === next) channelQueues.delete(channelId);
  });
}

export function startAngelBot(): void {
  const token = process.env.ANGEL_SELFBOT_TOKEN;
  if (!token) {
    console.error("[selfbot] ❌ ANGEL_SELFBOT_TOKEN no definido.");
    process.exit(1);
  }

  const client = new Client({});

  client.on("ready", () => {
    console.log(`[selfbot] ✅ Conectado como ${client.user?.tag} (${client.user?.id})`);
  });

  client.on("messageCreate", (message) => {
    queueForChannel(message.channelId, async () => {
      try {
        if (message.author.bot) return;
        if (message.author.id === client.user?.id) return;

        const rawContent = message.content?.trim() ?? "";
        if (!rawContent) return;

        const isDM = !message.guild;
        const mentioned = message.mentions.has(client.user!);
        const isReplyToMe = message.reference
          ? (await message.fetchReference().catch(() => null))?.author?.id === client.user?.id
          : false;

        const channelName = isDM
          ? "DM"
          : `#${"name" in message.channel ? (message.channel as any).name : message.channelId}`;

        console.log(
          `[selfbot] 📨 ${channelName} de ${message.author.username} | raw: "${rawContent.slice(0, 80)}"`
        );

        const cleanText = rawContent
          .replace(/<@!?\d+>/g, "")
          .trim() || rawContent.trim();

        const lowerClean = cleanText.toLowerCase();

        // Comandos R! — funcionan siempre sin mención
        if (lowerClean === "r!ping") {
          await message.reply("🏓 Pong! El bot está funcionando.");
          return;
        }
        if (lowerClean === "r!reset" || lowerClean === "r!reiniciar") {
          clearHistory(message.channelId);
          await message.reply("🔄 Historial del canal reiniciado.");
          return;
        }

        const shouldRespond = isDM || mentioned || isReplyToMe;
        console.log(
          `[selfbot] → mencionado=${mentioned} replyToMe=${isReplyToMe} DM=${isDM} → responder=${shouldRespond}`
        );

        addToHistory(message.channelId, message.author.username, cleanText);
        if (!shouldRespond) return;

        let locationLine: string;
        if (isDM) {
          locationLine = `Mensaje Directo con ${message.author.username}`;
        } else {
          const guildName = message.guild?.name ?? `Servidor ${message.guild?.id}`;
          const chName = "name" in message.channel
            ? (message.channel as any).name
            : message.channelId;
          locationLine = `Servidor: "${guildName}" | Canal: #${chName}`;
        }

        const history = getHistory(message.channelId);
        const contextPayload = buildContextMessage(
          locationLine,
          history.slice(0, -1),
          message.author.username,
          cleanText
        );

        await (message.channel as any).sendTyping?.().catch(() => {});

        const { roomId, accountNum } = await ensureRoom();
        console.log(`[selfbot] 📤 Enviando a shapes (sala: ${roomId.slice(0, 8)}...)...`);
        const sentAt = Date.now();

        await sendShapesMessage(accountNum, roomId, contextPayload, message.author.username, SHAPE_USERNAME);
        console.log(`[selfbot] ⏳ Esperando respuesta de shapes...`);

        const replies = await pollShapesReply(accountNum, roomId, sentAt);

        if (replies.length === 0) {
          console.warn(`[selfbot] ⚠️ Sin respuesta de shapes`);
          await message.reply("⚠️ Sin respuesta. Intenta de nuevo.");
          return;
        }

        console.log(`[selfbot] 💬 Recibidas ${replies.length} respuestas`);

        let first = true;
        for (const raw of replies) {
          const text = sanitize(raw).trim();
          if (!text) continue;
          const chunks = splitIntoChunks(text);
          for (const chunk of chunks) {
            if (first) {
              await message.reply(chunk);
              first = false;
            } else {
              await (message.channel as any).send(chunk);
            }
            if (chunks.length > 1) await new Promise((r) => setTimeout(r, 300));
          }
        }
      } catch (err) {
        console.error("[selfbot] ❌ Error procesando mensaje:", err);
      }
    });
  });

  client.login(token).catch((err) => {
    console.error("[selfbot] ❌ Error al hacer login:", err.message);
    process.exit(1);
  });

  console.log(`[selfbot] 🐊 Iniciando con shape ${SHAPE_USERNAME}...`);
}
