// Sets the app version in package.json, tauri.conf.json and Cargo.toml.
// Usage: node scripts/set-version.mjs v1.2.3   (leading "v" optional)
import fs from "node:fs";

const version = (process.argv[2] ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Not a vMAJOR.MINOR.PATCH version: ${process.argv[2] ?? "(none)"}`);
  process.exit(1);
}
for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.version = version;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}
const cargo = "src-tauri/Cargo.toml";
// First `version =` line is the [package] one.
fs.writeFileSync(cargo, fs.readFileSync(cargo, "utf8").replace(/^version = ".*"$/m, `version = "${version}"`));
console.log(version);
