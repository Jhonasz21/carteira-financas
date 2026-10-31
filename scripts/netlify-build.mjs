import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const outputDirectory = resolve(root, "dist");
const publicFiles = ["index.html", "api-config.js", "app.js", "firebase-messaging-sw.js", "styles.css", "manifest.webmanifest", "icons"];

await mkdir(outputDirectory, { recursive: true });
for (const file of publicFiles) {
  await cp(resolve(root, file), resolve(outputDirectory, file), { recursive: true });
}
