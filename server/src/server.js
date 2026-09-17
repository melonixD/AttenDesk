import http from "node:http";
import { createAttendanceApp } from "./app.js";

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const server = http.createServer(createAttendanceApp());

server.listen(port, host, () => {
  console.log(`AttenDesk API listening on http://${host}:${port}`);
});
