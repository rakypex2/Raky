import WebSocket from "ws";
import {
  createShapesRoom,
  sendShapesMessage,
  pollShapesReply,
} from "./shapes.js";
import { loadRoom, saveRoom } from "./roomConfig.js";
import { getAnyWorkingAccount } from "./cookies.js";
import { addToHistory, getHistory, clearHistory } from "./messageHistory.js";

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────
const SHAPE_USERNAME = "mateoia";
const DISCORD_API    = "https://discord.com/api/v10";
const GATEWAY_URL    = "wss://gateway.discord.gg/?v=10&encoding=json";

const channelQueues = new Map<string, Promise<void>>();

function queueForChannel(channelId: string, fn: () => Promise<void>): void {
  const prev = channelQueues.get(channelId) ?? Promise.resolve();
  const next = prev.then(() => fn()).catch(() => {});
  channelQueues.set(channelId, next);
  next.finally(() => {
    if (channelQueues.get(channelId) === next) channelQueues.delete(channelId);
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Room
// ──────────────────────────────────────────────────────────────────────────────
async function ensureRoom(): Promise<{ roomId: string; accountNum: number }> {
  const existing = loadRoom();
  if (existing) return existing;
  console.log(`[selfbot] Creando sala para ${SHAPE_USERNAME}...`);
  const info = await getAnyWorkingAccount();
  if (!info) throw new Error("[selfbot] No hay cuentas disponibles");
  const { roomId, accountNum } = await createShapesRoom(
    info.accountNum,
    "Mateoia — sala principal",
    SHAPE_USERNAME
  );
  saveRoom({ roomId, accountNum });
  return { roomId, accountNum };
}

// ──────────────────────────────────────────────────────────────────────────────
// Context payload
// ──────────────────────────────────────────────────────────────────────────────
function buildPayload(channelId: string, location: string, author: string, text: string): string {
  const history = getHistory(channelId);
  const lines: string[] = [`[${location}]`];
  if (history.length > 0) {
    lines.push(`[Últimos ${history.length} mensajes:]`);
    for (const h of history) lines.push(`${h.username}: ${h.content}`);
  }
  lines.push(`[Mensaje actual de ${author}:]`, text);
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Discord REST helpers
// ──────────────────────────────────────────────────────────────────────────────
function sanitizeReply(text: string): string {
  return text.replace(/\|\|([^|]+)\|\|/g, "$1");
}

function splitByBlankLines(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function sendTypingIndicator(token: string, channelId: string): Promise<void> {
  await fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
    method: "POST",
    headers: { Authorization: token, "User-Agent": "Mozilla/5.0" },
  }).catch(() => {});
}

function startTyping(token: string, channelId: string): () => void {
  let active = true;
  const tick = async () => {
    while (active) {
      await sendTypingIndicator(token, channelId);
      await new Promise((r) => setTimeout(r, 8000));
    }
  };
  tick();
  return () => { active = false; };
}

async function sendDiscordMessage(
  token: string,
  channelId: string,
  content: string,
  replyToMessageId?: string
): Promise<void> {
  const body: Record<string, unknown> = { content };
  if (replyToMessageId) {
    body.message_reference = { message_id: replyToMessageId };
    body.allowed_mentions  = { replied_user: false };
  }
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[selfbot] Error enviando mensaje HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Message handler
// ──────────────────────────────────────────────────────────────────────────────
async function handleMessage(
  token: string,
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: any
): Promise<void> {
  try {
    const content: string = (msg.content ?? "").trim();
    if (!content) return;
    if (msg.author?.bot) return;
    if (msg.author?.id === userId) return;

    const channelId: string = msg.channel_id;
    const guildId: string | null = msg.guild_id ?? null;
    const isDM = !guildId;
    const authorName: string = msg.author?.username ?? "user";

    const mentioned =
      content.includes(`<@${userId}>`) ||
      content.includes(`<@!${userId}>`);

    let isReplyToMe = false;
    if (!isDM && !mentioned && msg.referenced_message) {
      isReplyToMe = msg.referenced_message?.author?.id === userId;
    }

    const cleanText = content
      .replace(new RegExp(`<@!?${userId}>`, "g"), "")
      .trim();

    if (!cleanText) return;

    const lower = cleanText.toLowerCase();

    // Comandos R! siempre responden, sin necesitar mención
    if (lower === "r!ping") {
      await sendDiscordMessage(token, channelId, "🏓 Pong! El bot está funcionando.", msg.id);
      return;
    }
    if (lower === "r!reset" || lower === "r!reiniciar") {
      clearHistory(channelId);
      await sendDiscordMessage(token, channelId, "🔄 Historial reiniciado.", msg.id);
      return;
    }

    // Registrar en historial todos los mensajes
    addToHistory(channelId, authorName, cleanText);

    if (!isDM && !mentioned && !isReplyToMe) return;

    const location = isDM
      ? `DM con ${authorName}`
      : `Servidor: "${guildId}" | Canal: #${channelId}`;

    console.log(`[selfbot] 📨 ${location} de ${authorName} | mentioned=${mentioned} reply=${isReplyToMe} dm=${isDM}`);

    const payload = buildPayload(channelId, location, authorName, cleanText);
    const stopTyping = startTyping(token, channelId);

    try {
      const { roomId, accountNum } = await ensureRoom();
      console.log(`[selfbot] 📤 Enviando a shapes (sala ${roomId.slice(0, 8)})...`);
      const sentAt = Date.now();

      await sendShapesMessage(accountNum, roomId, payload, authorName, SHAPE_USERNAME);
      const replies = await pollShapesReply(accountNum, roomId, sentAt);
      stopTyping();

      if (replies.length === 0) {
        console.warn("[selfbot] ⚠️ Sin respuesta de shapes");
        await sendDiscordMessage(token, channelId, "⚠️ Sin respuesta. Intenta de nuevo.", msg.id);
        return;
      }

      let first = true;
      const allReplies: string[] = [];

      for (const raw of replies) {
        const blocks = splitByBlankLines(sanitizeReply(raw));
        const chunks = blocks.length > 0 ? blocks : [sanitizeReply(raw).trim()];
        for (const block of chunks) {
          if (!block) continue;
          allReplies.push(block);
          const parts = block.match(/.{1,2000}/gs) ?? [block];
          for (const part of parts) {
            await sendDiscordMessage(token, channelId, part, first ? msg.id : undefined);
            first = false;
          }
          await new Promise((r) => setTimeout(r, 350));
        }
      }

      addToHistory(channelId, SHAPE_USERNAME, allReplies.join(" ").slice(0, 300));
    } finally {
      stopTyping();
    }
  } catch (err) {
    console.error("[selfbot] Error procesando mensaje:", err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Selfbot class
// ──────────────────────────────────────────────────────────────────────────────
class AngelSelfbot {
  private token: string;
  private ws: WebSocket | null = null;
  private userId: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private stopped = false;

  constructor(token: string) {
    this.token = token;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.ws?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    console.log("[selfbot] Conectando al gateway de Discord...");
    this.ws = new WebSocket(GATEWAY_URL);

    this.ws.on("open", () => console.log("[selfbot] WebSocket conectado"));

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const payload = JSON.parse(data.toString());
        this.handlePayload(payload);
      } catch {}
    });

    this.ws.on("close", (code, reason) => {
      console.warn(`[selfbot] Gateway cerrado: ${code} ${reason ?? ""}. Reconectando en 5s...`);
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!this.stopped) setTimeout(() => this.connect(), 5000);
    });

    this.ws.on("error", (err) => {
      console.error("[selfbot] WebSocket error:", err.message);
    });
  }

  private send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private identify(): void {
    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: 8189,
        properties: {
          os: "Windows",
          browser: "Chrome",
          device: "",
          system_locale: "es-ES",
          browser_user_agent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          browser_version: "120.0.0.0",
          os_version: "10",
          referrer: "",
          referring_domain: "",
          referrer_current: "",
          referring_domain_current: "",
          release_channel: "stable",
          client_build_number: 0,
          client_event_source: null,
        },
        presence: { status: "online", since: 0, activities: [], afk: false },
        compress: false,
        client_state: { guild_versions: {} },
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlePayload(payload: any): void {
    const { op, d, s, t } = payload;
    if (s !== undefined && s !== null) this.sequence = s;

    switch (op) {
      case 10: {
        const interval: number = d.heartbeat_interval;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = setInterval(() => {
          this.send({ op: 1, d: this.sequence });
        }, interval);
        this.send({ op: 1, d: this.sequence });
        this.identify();
        break;
      }
      case 11:
        break;
      case 0: {
        if (t === "READY") {
          this.userId = d.user?.id ?? null;
          console.log(
            `[selfbot] ✅ Conectado como ${d.user?.username}#${d.user?.discriminator} (${this.userId})`
          );
        } else if (t === "MESSAGE_CREATE" && this.userId) {
          queueForChannel(d.channel_id, () =>
            handleMessage(this.token, this.userId!, d)
          );
        }
        break;
      }
      case 9:
        console.warn("[selfbot] Sesión inválida. Reconectando...");
        setTimeout(() => this.identify(), 2000);
        break;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────
export function startAngelBot(): void {
  const token = process.env.ANGEL_SELFBOT_TOKEN;
  if (!token) {
    console.error("[selfbot] ❌ ANGEL_SELFBOT_TOKEN no definido. Selfbot desactivado.");
    return;
  }
  const bot = new AngelSelfbot(token);
  bot.start();
  console.log("[selfbot] 🐊 Selfbot de Mateoia iniciado");
}
