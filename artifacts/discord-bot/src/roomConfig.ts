import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOM_FILE = resolve(__dirname, "..", "room.json");

export interface RoomConfig {
  roomId: string;
  accountNum: number;
}

export function loadRoom(): RoomConfig | null {
  if (!existsSync(ROOM_FILE)) return null;
  try {
    return JSON.parse(readFileSync(ROOM_FILE, "utf8")) as RoomConfig;
  } catch {
    return null;
  }
}

export function saveRoom(config: RoomConfig): void {
  try {
    writeFileSync(ROOM_FILE, JSON.stringify(config, null, 2), "utf8");
    console.log(`[room] ✅ Sala guardada: ${config.roomId} (cuenta ${config.accountNum})`);
  } catch (err) {
    console.error("[room] Error guardando room.json:", err);
  }
}
