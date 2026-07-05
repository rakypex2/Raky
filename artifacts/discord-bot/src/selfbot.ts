import WebSocket from "ws";
import { sendShapesMessage, pollShapesReply } from "./shapes.js";
import { loadRoom, saveRoom } from "./roomConfig.js";
import { addToHistory, getHistory, clearHistory } from "./messageHistory.js";
import { getAnyWorkingAccount } from "./cookies.js";
import { createShapesRoom } from "./shapes.js";

const SHAPE_USERNAME = "mateoia";

// Intents: GUILDS(1) | GUILD_MESSAGES(512) | GUILD_MESSAGE_REACTIONS(1024)
//          | DIRECT_MESSAGES(4096) | DIRECT_MESSAGE_REACTIONS(8192) | MESSAGE_CONTENT(32768)
const INTENTS = 1 | 512 | 1024 | 4096 | 8192 | 32768;

// ──────────────────────────────────────────────────────────────────────────────
// Room helpers
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
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function sanitize(text: string): string {
  return text.replace(/\|\|([^|]+)\|\|/g, "$1");
}

function chunks(text: string, size = 1900): string[] {
  const out: string[] = [];
  let s = text.trim();
  while (s.length > size) {
    const cut = s.lastIndexOf("\n", size);
    const pos = cut > 0 ? cut : size;
    out.push(s.slice(0, pos).trim());
    s = s.slice(pos).trim();
  }
  if (s) out.push(s);
  return out;
}

function buildContext(
  location: string,
  history: { username: string; content: string }[],
  author: string,
  text: string
): string {
  const lines: string[] = [`[${location}]`];
  if (history.length > 0) {
    lines.push(`[Últimos ${history.length} mensajes:]`);
    for (const h of history) lines.push(`${h.username}: ${h.content}`);
  }
  lines.push(`[Mensaje actual de ${author}:]`, text);
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Discord REST
// ──────────────────────────────────────────────────────────────────────────────
async function sendMessage(
  token: string,
  channelId: string,
  content: string,
  replyToId?: string
): Promise<void> {
  const body: Record<string, unknown> = { content };
  if (replyToId) {
    body.message_reference = { message_id: replyToId };
    body.allowed_mentions = { replied_user: false };
  }
  const res = await fetch(`https://discord.com/api/v9/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error(`[selfbot] ❌ REST error ${res.status}: ${err.slice(0, 200)}`);
  }
}

async function sendTyping(token: string, channelId: string): Promise<void> {
  await fetch(`https://discord.com/api/v9/channels/${channelId}/typing`, {
    method: "POST",
    headers: { Authorization: token, "User-Agent": "Mozilla/5.0" },
  }).catch(() => {});
}

// ──────────────────────────────────────────────────────────────────────────────
// Per-channel queue
// ──────────────────────────────────────────────────────────────────────────────
const queues = new Map<string, Promise<void>>();
function enqueue(channelId: string, fn: () => Promise<void>): void {
  const prev = queues.get(channelId) ?? Promise.resolve();
  const next = prev
    .then(fn)
    .catch((e) => console.error(`[selfbot] Error en cola ${channelId}:`, e));
  queues.set(channelId, next);
  next.finally(() => { if (queues.get(channelId) === next) queues.delete(channelId); });
}

// ──────────────────────────────────────────────────────────────────────────────
// Message handler
// ──────────────────────────────────────────────────────────────────────────────
async function handleMessage(
  token: string,
  userId: string,
  channelNames: Map<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: any
): Promise<void> {
  const rawContent: string = msg.content ?? "";
  const channelId: string = msg.channel_id;
  const isDM = !msg.guild_id;
  const authorId: string = msg.author?.id ?? "";
  const authorName: string = msg.author?.username ?? "Desconocido";

  if (msg.author?.bot) return;
  if (authorId === userId) return;
  if (!rawContent.trim()) return;

  const label = isDM ? "DM" : `#${channelNames.get(channelId) ?? channelId}`;
  console.log(`[selfbot] 📨 ${label} de ${authorName} | "${rawContent.slice(0, 80)}"`);

  const cleanText = rawContent.replace(/<@!?\d+>/g, "").trim() || rawContent.trim();
  const lower = cleanText.toLowerCase();

  // Comandos R! siempre responden
  if (lower === "r!ping") {
    await sendMessage(token, channelId, "🏓 Pong! El bot está funcionando.", msg.id);
    return;
  }
  if (lower === "r!reset" || lower === "r!reiniciar") {
    clearHistory(channelId);
    await sendMessage(token, channelId, "🔄 Historial reiniciado.", msg.id);
    return;
  }

  const mentioned =
    rawContent.includes(`<@${userId}>`) ||
    rawContent.includes(`<@!${userId}>`);
  const isReplyToMe = msg.referenced_message?.author?.id === userId;
  const shouldRespond = isDM || mentioned || isReplyToMe;

  console.log(`[selfbot] → mentioned=${mentioned} reply=${isReplyToMe} dm=${isDM} → respond=${shouldRespond}`);
  addToHistory(channelId, authorName, cleanText);
  if (!shouldRespond) return;

  let location: string;
  if (isDM) {
    location = `DM con ${authorName}`;
  } else {
    location = `Servidor: "${msg.guild_id}" | Canal: #${channelNames.get(channelId) ?? channelId}`;
  }

  const history = getHistory(channelId);
  const payload = buildContext(location, history.slice(0, -1), authorName, cleanText);

  await sendTyping(token, channelId);

  const { roomId, accountNum } = await ensureRoom();
  console.log(`[selfbot] 📤 Enviando a shapes (sala ${roomId.slice(0, 8)})...`);
  const sentAt = Date.now();

  await sendShapesMessage(accountNum, roomId, payload, authorName, SHAPE_USERNAME);
  console.log(`[selfbot] ⏳ Esperando respuesta...`);

  const replies = await pollShapesReply(accountNum, roomId, sentAt);
  if (replies.length === 0) {
    console.warn(`[selfbot] ⚠️ Sin respuesta de shapes`);
    await sendMessage(token, channelId, "⚠️ Sin respuesta. Intenta de nuevo.", msg.id);
    return;
  }

  let first = true;
  for (const raw of replies) {
    const text = sanitize(raw).trim();
    if (!text) continue;
    for (const chunk of chunks(text)) {
      await sendMessage(token, channelId, chunk, first ? msg.id : undefined);
      first = false;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Gateway
// ──────────────────────────────────────────────────────────────────────────────
export function startAngelBot(): void {
  const token = process.env.ANGEL_SELFBOT_TOKEN;
  if (!token) {
    console.error("[selfbot] ❌ ANGEL_SELFBOT_TOKEN no definido");
    process.exit(1);
  }

  const GATEWAY = "wss://gateway.discord.gg/?v=9&encoding=json";
  let ws: WebSocket;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let sessionId: string | null = null;
  let seq: number | null = null;
  let userId = "";
  const channelNames = new Map<string, string>();
  let reconnectDelay = 1000;

  function clearTimers() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  }

  function resetWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      console.warn("[selfbot] ⚠️ Watchdog: sin HELLO/HEARTBEAT_ACK — reconectando");
      ws.terminate();
    }, 90_000);
  }

  function connect(resume = false) {
    console.log(`[selfbot] 🔌 Conectando${resume ? " (resume)" : ""}...`);
    ws = new WebSocket(GATEWAY);

    ws.on("open", () => {
      console.log("[selfbot] WebSocket abierto");
      resetWatchdog();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let payload: any;
      try { payload = JSON.parse(data.toString()); } catch { return; }

      const { op, d, s, t } = payload;
      if (s != null) seq = s;

      switch (op) {
        case 10: { // HELLO
          const interval = d.heartbeat_interval;
          const jitter = Math.random() * interval;
          console.log(`[selfbot] 💓 Heartbeat cada ${interval}ms (jitter ${Math.round(jitter)}ms)`);
          setTimeout(() => {
            ws.send(JSON.stringify({ op: 1, d: seq }));
            heartbeatTimer = setInterval(() => {
              ws.send(JSON.stringify({ op: 1, d: seq }));
            }, interval);
          }, jitter);

          if (resume && sessionId) {
            console.log("[selfbot] 🔄 Resumiendo sesión...");
            ws.send(JSON.stringify({
              op: 6,
              d: { token, session_id: sessionId, seq },
            }));
          } else {
            ws.send(JSON.stringify({
              op: 2,
              d: {
                token,
                intents: INTENTS,
                properties: { os: "linux", browser: "chrome", device: "chrome" },
                presence: { status: "online", afk: false },
              },
            }));
          }
          resetWatchdog();
          break;
        }
        case 11: // HEARTBEAT_ACK
          resetWatchdog();
          break;
        case 1: // HEARTBEAT request
          ws.send(JSON.stringify({ op: 1, d: seq }));
          break;
        case 7: // RECONNECT
          console.log("[selfbot] 🔁 Gateway pidió reconexión");
          ws.close();
          break;
        case 9: // INVALID SESSION
          console.log(`[selfbot] ⚠️ Sesión inválida (resumable=${d}) — reiniciando`);
          sessionId = null;
          seq = null;
          ws.close();
          break;
        case 0: { // DISPATCH
          if (t === "READY") {
            userId = d.user.id;
            sessionId = d.session_id;
            reconnectDelay = 1000;
            console.log(`[selfbot] ✅ Conectado como ${d.user.username}#${d.user.discriminator} (${userId})`);
          } else if (t === "CHANNEL_CREATE" || t === "CHANNEL_UPDATE") {
            if (d.name) channelNames.set(d.id, d.name);
          } else if (t === "GUILD_CREATE") {
            for (const ch of d.channels ?? []) {
              if (ch.name) channelNames.set(ch.id, ch.name);
            }
          } else if (t === "MESSAGE_CREATE") {
            enqueue(d.channel_id, () => handleMessage(token!, userId, channelNames, d));
          }
          break;
        }
      }
    });

    ws.on("close", (code, reason) => {
      clearTimers();
      console.log(`[selfbot] ❌ Desconectado (${code} ${reason ?? ""})`);
      const canResume = code !== 1000 && sessionId != null;
      setTimeout(() => connect(canResume), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });

    ws.on("error", (err) => {
      console.error("[selfbot] WebSocket error:", err.message);
    });
  }

  connect(false);
  console.log(`[selfbot] 🐊 Iniciando con shape ${SHAPE_USERNAME}...`);
}
