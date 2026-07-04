import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";
import { createShapesRoom, sendShapesMessage, pollShapesReply } from "./shapes.js";
import { getAnyWorkingAccount } from "./cookies.js";
import { loadRoom, saveRoom } from "./roomConfig.js";
import { addToHistory, getHistory } from "./messageHistory.js";

const SHAPE_USERNAME = "angel-mm39";

function sanitize(text: string): string {
  return text.replace(/\|\|([^|]+)\|\|/g, "$1");
}

function toTelegramHtml(text: string): string {
  const stripped = sanitize(text);
  const escaped = stripped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/_\s*([^_\n]+?)\s*_/g, "<i>$1</i>");
}

async function ensureRoom(): Promise<{ roomId: string; accountNum: number }> {
  const existing = loadRoom();
  if (existing) return existing;

  console.log(`[telegram] Creando sala única para ${SHAPE_USERNAME}...`);
  const info = await getAnyWorkingAccount();
  if (!info) throw new Error("[telegram] No hay ninguna cuenta disponible");

  const { roomId, accountNum } = await createShapesRoom(
    info.accountNum,
    `AngelBot — sala principal`,
    SHAPE_USERNAME
  );
  saveRoom({ roomId, accountNum });
  return { roomId, accountNum };
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
    lines.push(`[Últimos ${history.length} mensajes del chat:]`);
    for (const h of history) {
      lines.push(`${h.username}: ${h.content}`);
    }
  }

  lines.push(`[Mensaje actual de ${authorName}:]`);
  lines.push(messageText);

  return lines.join("\n");
}

const channelQueues = new Map<string, Promise<void>>();

function queueForChat(chatId: string, fn: () => Promise<void>): void {
  const prev = channelQueues.get(chatId) ?? Promise.resolve();
  const next = prev.then(() => fn()).catch(() => {});
  channelQueues.set(chatId, next);
  next.finally(() => {
    if (channelQueues.get(chatId) === next) channelQueues.delete(chatId);
  });
}

export function startTelegram(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[telegram] ⚠️  TELEGRAM_BOT_TOKEN no definido. Bot de Telegram desactivado.");
    return;
  }

  const bot = new Telegraf(token);

  bot.on(message("text"), async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text?.trim() ?? "";
    if (!text) return;

    const isDM = ctx.chat.type === "private";
    const botInfo = ctx.botInfo;
    const mentioned =
      text.includes(`@${botInfo.username}`) ||
      (ctx.message.reply_to_message?.from?.id === botInfo.id);

    if (!isDM && !mentioned) {
      const authorName = ctx.from?.username ?? ctx.from?.first_name ?? "usuario";
      addToHistory(chatId, authorName, text.replace(`@${botInfo.username}`, "").trim());
      return;
    }

    const cleanText = text.replace(`@${botInfo.username}`, "").trim();
    if (!cleanText) return;

    const authorName = ctx.from?.username ?? ctx.from?.first_name ?? "usuario";
    addToHistory(chatId, authorName, cleanText);

    let locationLine: string;
    if (isDM) {
      locationLine = `Mensaje Directo de Telegram con ${authorName}`;
    } else {
      const chatTitle = (ctx.chat as any).title ?? `Grupo ${chatId}`;
      locationLine = `Telegram | Grupo: "${chatTitle}"`;
    }

    const history = getHistory(chatId);
    const contextPayload = buildContextMessage(
      locationLine,
      history.slice(0, -1),
      authorName,
      cleanText
    );

    queueForChat(chatId, async () => {
      try {
        await ctx.sendChatAction("typing");

        const { roomId, accountNum } = await ensureRoom();
        const sentAt = Date.now();

        await sendShapesMessage(accountNum, roomId, contextPayload, authorName, SHAPE_USERNAME);
        const replies = await pollShapesReply(accountNum, roomId, sentAt);

        if (replies.length === 0) {
          await ctx.reply("⚠️ Sin respuesta. Intenta de nuevo.");
          return;
        }

        for (const raw of replies) {
          const html = toTelegramHtml(raw.trim());
          if (!html) continue;
          const chunks = html.match(/.{1,4000}/gs) ?? [html];
          for (const chunk of chunks) {
            await ctx.reply(chunk, {
              parse_mode: "HTML",
              reply_parameters: replies.indexOf(raw) === 0
                ? { message_id: ctx.message.message_id }
                : undefined,
            });
          }
        }
      } catch (err) {
        console.error("[telegram] Error procesando mensaje:", err);
      }
    });
  });

  bot.launch().then(() => {
    console.log("[telegram] ✅ Bot de Telegram iniciado");
  }).catch((err) => {
    console.error("[telegram] Error al iniciar:", err.message);
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
