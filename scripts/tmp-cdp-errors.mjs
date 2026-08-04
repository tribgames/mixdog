import WebSocket from "ws";

const list = await fetch("http://127.0.0.1:9342/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(method, params) {
  return new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
}
const seen = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    const desc = d.exception?.description || d.text || "";
    const key = desc.slice(0, 200);
    seen.set(key, (seen.get(key) || 0) + 1);
  } else if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    const key = "[console." + msg.params.type + "] " + text.slice(0, 300);
    seen.set(key, (seen.get(key) || 0) + 1);
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    if (e.level === "error" || e.level === "warning") {
      const key = "[log." + e.level + "] " + (e.text || "").slice(0, 300) + " @" + (e.url || "");
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
});
ws.on("open", async () => {
  await send("Runtime.enable", {});
  await send("Log.enable", {});
  setTimeout(() => {
    for (const [key, count] of [...seen.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`x${count}  ${key.replace(/\n/g, " | ")}`);
    }
    if (!seen.size) console.log("(no errors captured in window)");
    process.exit(0);
  }, 12000);
});
