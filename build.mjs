// Build the VPS plugin.
//
//   node plugins/vps/build.mjs
//
// Everything happens in the shared builder; see plugins/build-plugin.mjs. Note what is NOT
// built: server/ holds the Axum service this plugin talks to, which is deployed to a VPS rather
// than bundled into Deck. The builder only emits plugin.js from src/, so it never ships.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "../build-plugin.mjs";

await buildPlugin(dirname(fileURLToPath(import.meta.url)));
