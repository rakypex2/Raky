import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = resolve(__dirname, "..", "cookies.json");

export interface AccountInfo {
  accountNum: number;
  email: string;
  cookie: string;
  senderId: string;
  lastRefresh: number;
  failedAt: number;
}

const ACCOUNT_NUMBERS = [3, 4, 5, 6, 7, 8, 9];
const FAIL_COOLDOWN_MS = 5 * 60 * 1000;

let accounts: Map<number, AccountInfo> = new Map();

function loadCookies(): void {
  let stored: Record<string, AccountInfo> = {};
  if (existsSync(COOKIES_FILE)) {
    try {
      stored = JSON.parse(readFileSync(COOKIES_FILE, "utf8"));
    } catch {
      stored = {};
    }
  }
  for (const num of ACCOUNT_NUMBERS) {
    const key = String(num);
    if (stored[key]) {
      accounts.set(num, { ...stored[key], failedAt: 0 });
    } else {
      accounts.set(num, {
        accountNum: num,
        email: `test${num}@raky.es`,
        cookie: "",
        senderId: randomUUID(),
        lastRefresh: 0,
        failedAt: 0,
      });
    }
  }
  saveCookies();
}

function saveCookies(): void {
  const obj: Record<string, AccountInfo> = {};
  for (const [num, info] of accounts) {
    obj[String(num)] = info;
  }
  try {
    writeFileSync(COOKIES_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error("[cookies] Error guardando cookies:", err);
  }
}

export async function loginAccount(num: number): Promise<boolean> {
  const email = `test${num}@raky.es`;
  const password = `test${num}@raky.es`;
  console.log(`[cookies] Iniciando sesión para ${email}...`);

  try {
    const res = await fetch(
      "https://talk.shapes.inc/api/better-auth/sign-in/email",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "accept-language": "es-ES,es;q=0.9",
          "content-type": "application/json",
          origin: "https://talk.shapes.inc",
          referer: "https://talk.shapes.inc/login",
          "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        },
        body: JSON.stringify({
          email,
          password,
          callbackURL: "https://talk.shapes.inc/login/verified",
        }),
      }
    );

    const responseText = await res.text().catch(() => "");

    if (!res.ok) {
      console.error(
        `[cookies] Login fallido para ${email}: HTTP ${res.status} — ${responseText.slice(0, 200)}`
      );
      const info = accounts.get(num)!;
      info.failedAt = Date.now();
      accounts.set(num, info);
      return false;
    }

    const rawCookies = res.headers.getSetCookie?.() ?? [];
    let cookieParts: string[] = [];
    let sUid: string | null = null;

    for (const header of rawCookies) {
      const nameValue = header.split(";")[0].trim();
      cookieParts.push(nameValue);
      const sUidMatch = nameValue.match(/s_uid=([0-9a-f-]{36})/i);
      if (sUidMatch) sUid = sUidMatch[1];
    }

    if (cookieParts.length === 0) {
      console.error(`[cookies] Login sin cookies en respuesta para ${email}`);
      const info = accounts.get(num)!;
      info.failedAt = Date.now();
      accounts.set(num, info);
      return false;
    }

    const info = accounts.get(num)!;
    info.cookie = cookieParts.join("; ");
    info.senderId = sUid ?? info.senderId ?? randomUUID();
    info.lastRefresh = Date.now();
    info.failedAt = 0;
    accounts.set(num, info);
    saveCookies();
    console.log(`[cookies] ✅ Login exitoso para ${email} (${cookieParts.length} cookies)`);
    return true;
  } catch (err) {
    console.error(`[cookies] Error en login para test${num}@raky.es:`, err);
    const info = accounts.get(num);
    if (info) { info.failedAt = Date.now(); accounts.set(num, info); }
    return false;
  }
}

export async function getValidAccount(num: number): Promise<AccountInfo | null> {
  const info = accounts.get(num);
  if (!info) return null;
  if (info.cookie) return info;
  if (info.failedAt && Date.now() - info.failedAt < FAIL_COOLDOWN_MS) return null;
  const ok = await loginAccount(num);
  return ok ? accounts.get(num)! : null;
}

export async function refreshAccount(num: number): Promise<boolean> {
  return loginAccount(num);
}

export async function getAnyWorkingAccount(preferredNum?: number): Promise<AccountInfo | null> {
  const order = ACCOUNT_NUMBERS.slice().sort((a, b) => {
    if (a === preferredNum) return -1;
    if (b === preferredNum) return 1;
    const aInfo = accounts.get(a)!;
    const bInfo = accounts.get(b)!;
    const aHasCookie = aInfo.cookie ? 1 : 0;
    const bHasCookie = bInfo.cookie ? 1 : 0;
    return bHasCookie - aHasCookie;
  });

  for (const num of order) {
    const info = accounts.get(num);
    if (!info) continue;
    if (info.failedAt && Date.now() - info.failedAt < FAIL_COOLDOWN_MS) continue;

    if (info.cookie) {
      console.log(`[cookies] Usando cuenta test${num}@raky.es (cookie existente)`);
      return info;
    }

    const ok = await loginAccount(num);
    if (ok) return accounts.get(num)!;
  }

  console.warn("[cookies] Todas las cuentas fallaron. Intentando login de emergencia...");
  // Intentar refrescar la cuenta 3 como emergencia
  const ok3 = await loginAccount(3);
  if (ok3) return accounts.get(3)!;

  return null;
}

export function markAccountFailed(num: number): void {
  const info = accounts.get(num);
  if (info) {
    info.failedAt = Date.now();
    info.cookie = "";
    accounts.set(num, info);
    saveCookies();
  }
}

export function getRandomAccountNum(): number {
  const available = ACCOUNT_NUMBERS.filter((n) => {
    const info = accounts.get(n);
    if (!info) return false;
    if (info.failedAt && Date.now() - info.failedAt < FAIL_COOLDOWN_MS) return false;
    return true;
  });
  const pool = available.length > 0 ? available : ACCOUNT_NUMBERS;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function getAllAccountNums(): number[] {
  return [...ACCOUNT_NUMBERS];
}

loadCookies();
