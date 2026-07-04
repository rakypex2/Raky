import { randomUUID } from "node:crypto";
import { getAnyWorkingAccount, markAccountFailed } from "./cookies.js";

const BASE = "https://talk.shapes.inc/api";

function buildHeaders(cookie: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    cookie,
    origin: "https://talk.shapes.inc",
    referer: "https://talk.shapes.inc/",
    "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  };
}

async function callShapes(
  path: string,
  cookie: string,
  init?: RequestInit
): Promise<{ res: Response; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...buildHeaders(cookie), ...(init?.headers ?? {}) },
  });
  let body: any = null;
  const txt = await res.text().catch(() => "");
  try { body = txt ? JSON.parse(txt) : null; } catch { body = txt; }
  return { res, body };
}

export async function createShapesRoom(
  preferredAccountNum: number,
  title: string,
  shapeUsername: string = "lucarioo"
): Promise<{ roomId: string; accountNum: number }> {
  const info = await getAnyWorkingAccount(preferredAccountNum);
  if (!info) throw new Error("[shapes] No hay ninguna cuenta disponible");

  const payload = {
    title,
    shapes: [shapeUsername],
    visibility: "private",
    isPrivate: true,
  };

  const { res, body } = await callShapes("/rooms", info.cookie, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (res.status === 401 || res.status === 403) {
    console.warn(`[shapes] Cookie de cuenta ${info.accountNum} expirada, reintentando...`);
    markAccountFailed(info.accountNum);
    const info2 = await getAnyWorkingAccount();
    if (!info2) throw new Error("[shapes] No hay ninguna cuenta disponible tras reintento");

    const r2 = await callShapes("/rooms", info2.cookie, {
      method: "POST",
      body: JSON.stringify({ ...payload }),
    });
    if (!r2.res.ok || !r2.body?.id)
      throw new Error(`[shapes] createRoom HTTP ${r2.res.status}`);
    console.log(`[shapes] ✅ Sala creada ${r2.body.id} (${shapeUsername}) con cuenta ${info2.accountNum}`);
    return { roomId: r2.body.id as string, accountNum: info2.accountNum };
  }

  if (!res.ok || !body?.id)
    throw new Error(`[shapes] createRoom HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);

  console.log(`[shapes] ✅ Sala creada ${body.id} (${shapeUsername}) con cuenta ${info.accountNum}`);
  return { roomId: body.id as string, accountNum: info.accountNum };
}

export async function sendShapesMessage(
  accountNum: number,
  roomId: string,
  text: string,
  senderName: string,
  shapeUsername: string = "lucarioo"
): Promise<void> {
  let info = await getAnyWorkingAccount(accountNum);
  if (!info) throw new Error("[shapes] No hay ninguna cuenta disponible");

  const msgId = randomUUID();
  const makePayload = (senderId: string) => ({
    id: roomId,
    message: {
      id: msgId,
      createdAt: new Date().toISOString(),
      role: "user",
      content: text,
      senderId,
      senderName,
      parts: [{ type: "text", text }],
    },
    selectedChatModel: null,
    selectedVisibilityType: "private",
    initialInterlocutors: [`shapesinc/${shapeUsername}`],
  });

  const { res, body } = await callShapes("/chat", info.cookie, {
    method: "POST",
    body: JSON.stringify(makePayload(info.senderId)),
  });

  if (res.status === 401 || res.status === 403) {
    console.warn(`[shapes] Cookie expirada en sendMessage, reintentando...`);
    markAccountFailed(info.accountNum);
    info = await getAnyWorkingAccount() as any;
    if (!info) throw new Error("[shapes] No hay ninguna cuenta disponible tras reintento");

    const r2 = await callShapes("/chat", info.cookie, {
      method: "POST",
      body: JSON.stringify(makePayload(info.senderId)),
    });
    if (!r2.res.ok)
      throw new Error(`[shapes] sendMessage HTTP ${r2.res.status}: ${JSON.stringify(r2.body).slice(0, 200)}`);
    return;
  }

  if (!res.ok)
    throw new Error(`[shapes] sendMessage HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
}

interface ShapesMsg {
  id: string;
  role: string;
  content?: string;
  parts?: Array<{ type: string; text?: string }>;
  createdAt?: string;
}

function extractText(m: ShapesMsg): string {
  if (m.parts && m.parts.length > 0) {
    return m.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text!).join("\n").trim();
  }
  return (m.content ?? "").trim();
}

export async function pollShapesReply(
  accountNum: number,
  roomId: string,
  afterMs: number,
  timeoutMs = 45000,
  intervalMs = 1500
): Promise<string[]> {
  const info = await getAnyWorkingAccount(accountNum);
  if (!info) return [];

  const start = Date.now();
  let lastSeenId: string | null = null;

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const { res, body } = await callShapes(`/chat/${roomId}/bootstrap`, info.cookie, { method: "GET" });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) markAccountFailed(info.accountNum);
      continue;
    }

    const messages: ShapesMsg[] = body?.messages ?? [];
    const replies = messages.filter((m) => {
      if (m.role !== "assistant") return false;
      const t = m.createdAt ? new Date(m.createdAt).getTime() : 0;
      return t >= afterMs - 500;
    });

    if (replies.length > 0) {
      const last = replies[replies.length - 1];
      if (lastSeenId === last.id) {
        return replies.map(extractText).filter((t) => t.length > 0);
      }
      lastSeenId = last.id;
    }
  }

  const infoFinal = await getAnyWorkingAccount(accountNum);
  if (!infoFinal) return [];
  const { body } = await callShapes(`/chat/${roomId}/bootstrap`, infoFinal.cookie, { method: "GET" });
  const messages: ShapesMsg[] = body?.messages ?? [];
  return messages
    .filter((m) => {
      if (m.role !== "assistant") return false;
      const t = m.createdAt ? new Date(m.createdAt).getTime() : 0;
      return t >= afterMs - 500;
    })
    .map(extractText)
    .filter((t) => t.length > 0);
}
