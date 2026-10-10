// Fixture for tools/e2e-logtab.mjs: a portable service that also writes a log file.
//
//   node tools/fixtures/log-writer.mjs --port 15230 --log <file> [--interval 200]
//
// Appends `log-line-N` every interval, plus an ERROR-ish and a WARN-ish line every 5th/3rd tick,
// so the log tab has something to filter and highlight. Listens on the port so the dashboard shows
// a real service.
import { createServer } from "node:http";
import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const port = Number(arg("port", "15230"));
const logFile = arg("log");
const interval = Number(arg("interval", "200"));

let counter = 0;
setInterval(() => {
  counter += 1;
  const lines = [`log-line-${counter}`];
  if (counter % 3 === 0) lines.push(`WARN tick ${counter} slow response`);
  if (counter % 5 === 0) lines.push(`ERROR tick ${counter} upstream failed`);
  fs.appendFileSync(logFile, lines.join("\n") + "\n");
}, interval);

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("fixture ok\n");
}).listen(port, "127.0.0.1", () => console.log(`log-writer on ${port}, log ${logFile}`));
