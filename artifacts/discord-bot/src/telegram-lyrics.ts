import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createShapesRoom,
  sendShapesMessage,
  pollShapesReply,
} from "./shapes.js";
import { getAnyWorkingAccount } from "./cookies.js";
import { addToHistory, getHistory } from "./messageHistory.js";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────
const SHAPE_USERNAME = "rakylyrics";

/** Usuario que recibe sala propia fija (pre-creada al inicio) */
const VIP_TELEGRAM_USERNAME = "rakykxd";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOMS_FILE = resolve(__dirname, "..", "rakylyrics-rooms.json");

// ──────────────────────────────────────────────────────────────────────────────
// Room registry — persiste { [telegramUserId]: { roomId, accountNum } }
// ──────────────────────────────────────────────────────────────────────────────
interface RoomEntry {
  roomId: string;
  accountNum: number;
}

function loadRooms(): Record<string, RoomEntry> {
  if (!existsSync(ROOMS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(ROOMS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveRooms(rooms: Record<string, RoomEntry>): void {
  try {
    writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), "utf8");
  } catch (err) {
    console.error("[lyrics] Error guardando rakylyrics-rooms.json:", err);
  }
}

async function getOrCreateRoom(userId: string, label: string): Promise<RoomEntry> {
  const rooms = loadRooms();
  if (rooms[userId]) return rooms[userId];

  console.log(`[lyrics] Creando sala para ${label} (${SHAPE_USERNAME})...`);
  const info = await getAnyWorkingAccount();
  if (!info) throw new Error("[lyrics] No hay ninguna cuenta disponible");

  const { roomId, accountNum } = await createShapesRoom(
    info.accountNum,
    `rakylyrics — ${label}`,
    SHAPE_USERNAME
  );

  rooms[userId] = { roomId, accountNum };
  saveRooms(rooms);
  console.log(`[lyrics] ✅ Sala creada para ${label}: ${roomId.slice(0, 8)}`);
  return { roomId, accountNum };
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
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

function buildContextMessage(
  locationLine: string,
  history: Array<{ username: string; content: string }>,
  authorName: string,
  messageText: string
): string {
  const lines: string[] = [`[${locationLine}]`];
  if (history.length > 0) {
    lines.push(`[Últimos ${history.length} mensajes del chat:]`);
    for (const h of history) lines.push(`${h.username}: ${h.content}`);
  }
  lines.push(`[Mensaje actual de ${authorName}:]`, messageText);
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

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────
export async function startTelegramLyrics(): Promise<void> {
  const token = process.env.TELEGRAM_RAKYLYRICS_TOKEN;
  if (!token) {
    console.warn("[lyrics] ⚠️  TELEGRAM_RAKYLYRICS_TOKEN no definido. Bot de rakylyrics desactivado.");
    return;
  }

  // Pre-crear la sala del VIP al arrancar
  try {
    await getOrCreateRoom(`vip:${VIP_TELEGRAM_USERNAME}`, VIP_TELEGRAM_USERNAME);
    console.log(`[lyrics] ✅ Sala de ${VIP_TELEGRAM_USERNAME} lista`);
  } catch (err) {
    console.warn(`[lyrics] ⚠️ No se pudo pre-crear la sala de ${VIP_TELEGRAM_USERNAME}:`, err);
  }

  const bot = new Telegraf(token);

  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text?.trim() ?? "";
    if (!text) return;

    const chatId    = String(ctx.chat.id);
    const isDM      = ctx.chat.type === "private";
    const botInfo   = ctx.botInfo;
    const mentioned =
      text.includes(`@${botInfo.username}`) ||
      (ctx.message.reply_to_message?.from?.id === botInfo.id);

    const authorName = ctx.from?.username ?? ctx.from?.first_name ?? "usuario";

    // En grupos, registrar historial aunque no esté mencionado
    if (!isDM && !mentioned) {
      addToHistory(chatId, authorName, text.replace(`@${botInfo.username}`, "").trim());
      return;
    }

    const cleanText = text.replace(`@${botInfo.username}`, "").trim();
    if (!cleanText) return;

    addToHistory(chatId, authorName, cleanText);

    // Determinar qué sala usar:
    // - Si es rakykxd → sala VIP fija
    // - Todos los demás → sala propia por userId
    const senderUsername = (ctx.from?.username ?? "").toLowerCase();
    const isVip = senderUsername === VIP_TELEGRAM_USERNAME.toLowerCase();
    const roomKey = isVip
      ? `vip:${VIP_TELEGRAM_USERNAME}`
      : `user:${ctx.from?.id}`;
    const roomLabel = isVip ? VIP_TELEGRAM_USERNAME : `usuario_${ctx.from?.id}`;

    const locationLine = isDM
      ? `Mensaje Directo de Telegram con ${authorName}`
      : `Telegram | Grupo: "${(ctx.chat as any).title ?? chatId}"`;

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

        const { roomId, accountNum } = await getOrCreateRoom(roomKey, roomLabel);
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
              reply_parameters:
                replies.indexOf(raw) === 0
                  ? { message_id: ctx.message.message_id }
                  : undefined,
            });
          }
        }
      } catch (err) {
        console.error("[lyrics] Error procesando mensaje:", err);
      }
    });
  });

  bot.launch().then(() => {
    console.log("[lyrics] ✅ Bot rakylyrics de Telegram iniciado");
  }).catch((err) => {
    console.error("[lyrics] Error al iniciar:", err.message);
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
