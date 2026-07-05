import { getAnyWorkingAccount } from "./src/cookies.js";
import { createShapesRoom } from "./src/shapes.js";
import { saveRoom, loadRoom } from "./src/roomConfig.js";

const SHAPE_USERNAME = "mateoia";

const existing = loadRoom();
if (existing) {
  console.log(`[create-room] Ya existe una sala: ${existing.roomId} (cuenta ${existing.accountNum})`);
  console.log("[create-room] Borrando y recreando...");
}

console.log(`[create-room] Iniciando sesión y creando sala para ${SHAPE_USERNAME}...`);

const info = await getAnyWorkingAccount();
if (!info) {
  console.error("[create-room] ❌ No hay ninguna cuenta disponible");
  process.exit(1);
}

const { roomId, accountNum } = await createShapesRoom(
  info.accountNum,
  "Mateoia — sala principal",
  SHAPE_USERNAME
);

saveRoom({ roomId, accountNum });
console.log(`[create-room] ✅ Sala creada y guardada:`);
console.log(`  roomId: ${roomId}`);
console.log(`  accountNum: ${accountNum}`);
