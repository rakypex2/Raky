import { createServer } from "node:http";
import { startAngelBot } from "./selfbot.js";

const PORT = process.env.PORT ?? "8080";

const server = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

server.listen(Number(PORT), () => {
  console.log(`[health] Servidor de health check activo en puerto ${PORT}`);
});

process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

startAngelBot();
