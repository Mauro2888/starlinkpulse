import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const args = [
  "node_modules/vite/bin/vite.js",
  "preview",
  "--host",
  "127.0.0.1",
  "--port",
  "4179",
  "--strictPort",
];

const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });

if (!child) {
  throw new Error("Could not start the preview server.");
}

let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  let response;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      response = await fetch("http://127.0.0.1:4179/?mockProfile=mini#live");
      if (response.ok) break;
    } catch {
      // The preview server is still starting.
    }
    await delay(250);
  }

  if (!response?.ok) {
    throw new Error(`Preview did not become reachable.\n${output}`);
  }

  const html = await response.text();
  if (!html.includes("<div id=\"root\"></div>") || !html.includes("/assets/")) {
    throw new Error(`Preview returned an unexpected document.\n${html.slice(0, 500)}`);
  }

  console.log("Preview runtime smoke passed.");
} finally {
  child.kill("SIGTERM");
}
