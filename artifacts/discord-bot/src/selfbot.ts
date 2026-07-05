import WebSocket from "ws";
import { createShapesRoom, sendShapesMessage, pollShapesReply } from "./shapes.js";
import { getAnyWorkingAccount } from "./cookies.js";
import { loadRoom, saveRoom } from "./roomConfig.js";
import { addToHistory, getHistory, clearHistory } from "./messageHistory.js";

const SHAPE_USERNAME = "mateoia";
const BOT_NAMES = ["mateoia", "mateo.ia", "mateo"];
const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

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

async function ensureRoom(): Promise<{ roomId: string; accountNum: number }> {
  const existing = loadRoom();
  if (existing) {
    console.log(`[selfbot] Usando sala existente: ${existing.roomId}`);
    return existing;
  }

  console.log(`[selfbot] Creando sala única para ${SHAPE_USERNAME}...`);
  const info = await getAnyWorkingAccount();
  if (!info) throw new Error("[selfbot] No hay ninguna cuenta disponible para crear la sala");

  const { roomId, accountNum } = await createShapesRoom(
    info.accountNum,
    `AngelBot — sala principal`,
    SHAPE_USERNAME
  );
  const config = { roomId, accountNum };
  saveRoom(config);
  return config;
}

async function sendTyping(token: string, channelId: string): Promise<void> {
  await fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
    method: "POST",
    headers: { Authorization: token, "User-Agent": "AngelBot/1.0" },
  }).catch(() => {});
}

function startTyping(token: string, channelId: string): () => void {
  let active = true;
  const tick = async () => {
    while (active) {
      await sendTyping(token, channelId);
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
  replyToMsgId?: string
): Promise<void> {
  const body: Record<string, any> = { content };
  if (replyToMsgId) {
    body.message_reference = { message_id: replyToMsgId };
    body.allowed_mentions = { replied_user: false };
  }
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": "AngelBot/1.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(`[selfbot] Error enviando mensaje HTTP ${res.status}: ${txt.slice(0, 200)}`);
  } else {
    console.log(`[selfbot] ✅ Mensaje enviado al canal ${channelId}`);
  }
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
    for (const h of history) {
      lines.push(`${h.username}: ${h.content}`);
    }
  }

  lines.push(`[Mensaje actual de ${authorName}:]`);
  lines.push(messageText);

  return lines.join("\n");
}

async function handleMessage(
  token: string,
  userId: string,
  msg: any,
  guildCache: Map<string, string>,
  channelCache: Map<string, string>
): Promise<void> {
  try {
    const rawContent: string = (msg.content ?? "").trim();
    const authorName = msg.author?.username ?? "usuario";
    const channelId: string = msg.channel_id;
    const guildId: string | null = msg.guild_id ?? null;
    const isDM = !guildId;

    // Filtrar bots y mensajes propios
    if (msg.author?.bot) return;
    if (msg.author?.id === userId) return;
    if (!rawContent) return;

    const rawLower = rawContent.toLowerCase();
    const mentioned =
      rawContent.includes(`<@${userId}>`) ||
      rawContent.includes(`<@!${userId}>`) ||
      BOT_NAMES.some((name) => rawLower.includes(name));
    let isReplyToMe = false;
    if (msg.referenced_message) {
      isReplyToMe = msg.referenced_message?.author?.id === userId;
    }
    const shouldRespond = isDM || mentioned || isReplyToMe;

    console.log(
      `[selfbot] 📨 ${isDM ? "DM" : `#${channelCache.get(channelId) ?? channelId}`} de ${authorName}` +
      ` | mencionado=${mentioned} replyToMe=${isReplyToMe} DM=${isDM} → responder=${shouldRespond}`
    );

    let cleanText = rawContent
      .replace(new RegExp(`<@!?${userId}>`, "g"), "")
      .trim();
    for (const name of BOT_NAMES) {
      cleanText = cleanText.replace(new RegExp(name, "gi"), "").trim();
    }

    if (!cleanText && !shouldRespond) return;
    if (!cleanText) cleanText = rawContent.trim();

    addToHistory(channelId, authorName, cleanText);

    if (!shouldRespond) return;

    const lowerClean = cleanText.toLowerCase();

    if (lowerClean === "!ping") {
      await sendDiscordMessage(token, channelId, "🏓 Pong! El bot está funcionando.", msg.id);
      return;
    }

    if (lowerClean === "!reset" || lowerClean === "!reiniciar") {
      clearHistory(channelId);
      await sendDiscordMessage(token, channelId, "🔄 Historial del canal reiniciado.", msg.id);
      return;
    }

    let locationLine: string;
    if (isDM) {
      locationLine = `Mensaje Directo con ${authorName}`;
    } else {
      const guildName = guildCache.get(guildId!) ?? `Servidor ${guildId}`;
      const channelName = channelCache.get(channelId) ?? `canal-${channelId}`;
      locationLine = `Servidor: "${guildName}" | Canal: #${channelName}`;
    }

    const history = getHistory(channelId);
    const contextPayload = buildContextMessage(
      locationLine,
      history.slice(0, -1),
      authorName,
      cleanText
    );

    console.log(`[selfbot] 📤 Enviando a shapes (sala: ${(await ensureRoom()).roomId.slice(0, 8)}...)...`);

    const stopTyping = startTyping(token, channelId);
    try {
      const { roomId, accountNum } = await ensureRoom();
      const sentAt = Date.now();

      await sendShapesMessage(accountNum, roomId, contextPayload, authorName, SHAPE_USERNAME);
      console.log(`[selfbot] ⏳ Esperando respuesta de shapes...`);

      const replies = await pollShapesReply(accountNum, roomId, sentAt);
      stopTyping();

      if (replies.length === 0) {
        console.warn(`[selfbot] ⚠️ No llegó respuesta de shapes para mensaje de ${authorName}`);
        await sendDiscordMessage(token, channelId, "⚠️ Sin respuesta. Intenta de nuevo.", msg.id);
        return;
      }

      console.log(`[selfbot] 💬 Recibidas ${replies.length} respuestas de shapes`);

      let first = true;
      for (const raw of replies) {
        const text = sanitize(raw).trim();
        if (!text) continue;
        const chunks = splitIntoChunks(text);
        for (const chunk of chunks) {
          await sendDiscordMessage(token, channelId, chunk, first ? msg.id : undefined);
          first = false;
          if (chunks.length > 1) await new Promise((r) => setTimeout(r, 300));
        }
      }
    } finally {
      stopTyping();
    }
  } catch (err) {
    console.error("[selfbot] ❌ Error procesando mensaje:", err);
  }
}

export class AngelSelfbot {
  private token: string;
  private ws: WebSocket | null = null;
  private userId: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private stopped = false;
  private guildCache = new Map<string, string>();
  private channelCache = new Map<string, string>();

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
      console.warn(`[selfbot] Gateway cerrado: código=${code} razón=${reason}. Reconectando en 5s...`);
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
          const guilds: any[] = d.guilds ?? [];
          let totalChannels = 0;
          for (const g of guilds) {
            if (g.id && g.name) this.guildCache.set(g.id, g.name);
            for (const ch of g.channels ?? []) {
              if (ch.id && ch.name) {
                this.channelCache.set(ch.id, ch.name);
                totalChannels++;
              }
            }
          }
          console.log(`[selfbot] 📋 Cacheados ${guilds.length} servidores y ${totalChannels} canales`);
        } else if (t === "GUILD_CREATE") {
          if (d.id && d.name) this.guildCache.set(d.id, d.name);
          for (const ch of d.channels ?? []) {
            if (ch.id && ch.name) this.channelCache.set(ch.id, ch.name);
          }
        } else if (t === "CHANNEL_CREATE" || t === "CHANNEL_UPDATE") {
          if (d.id && d.name) this.channelCache.set(d.id, d.name);
        } else if (t === "MESSAGE_CREATE") {
          if (!this.userId) {
            console.warn("[selfbot] MESSAGE_CREATE recibido antes de READY, ignorando");
            return;
          }
          queueForChannel(d.channel_id, () =>
            handleMessage(this.token, this.userId!, d, this.guildCache, this.channelCache)
          );
        }
        break;
      }
      case 9:
        console.warn("[selfbot] Sesión inválida. Reconectando...");
        setTimeout(() => this.identify(), 2000);
        break;
      default:
        break;
    }
  }
}

export function startAngelBot(): void {
  const token = process.env.ANGEL_SELFBOT_TOKEN;
  if (!token) {
    console.error("[selfbot] ❌ ANGEL_SELFBOT_TOKEN no definido. El bot no puede iniciar.");
    process.exit(1);
  }
  const bot = new AngelSelfbot(token);
  bot.start();
  console.log(`[selfbot] 😇 Mateo iniciado con shape ${SHAPE_USERNAME}`);
}
