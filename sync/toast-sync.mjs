#!/usr/bin/env node
// Toast menus -> menus/<slug>.json
// Runs on GitHub Actions (see .github/workflows/sync-menus.yml). No dependencies, Node 20+.
//
// Env (from repository secrets):
//   TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_RESTAURANT_GUID
// Optional:
//   TOAST_HOST      default https://ws-api.toasttab.com
//   MENU_CONFIG     default config/vesuvio.json
//   MENU_OUT        default menus/vesuvio.json
//
// Behavior:
//   1. Auth (TOAST_MACHINE_CLIENT) -> JWT.
//   2. GET /menus/v2/metadata. If lastUpdated matches what is already in the output file, exit 0 without writing.
//   3. GET /menus/v2/menus, transform with the config, write the JSON, exit 0.
//   Any failure exits 1 and leaves the last good file untouched, so the website never goes blank.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const HOST = process.env.TOAST_HOST || "https://ws-api.toasttab.com";
const CLIENT_ID = process.env.TOAST_CLIENT_ID;
const CLIENT_SECRET = process.env.TOAST_CLIENT_SECRET;
const RESTAURANT = process.env.TOAST_RESTAURANT_GUID;
const CONFIG_PATH = process.env.MENU_CONFIG || "config/vesuvio.json";
const OUT_PATH = process.env.MENU_OUT || "menus/vesuvio.json";


async function login() {
  const r = await fetch(`${HOST}/authentication/v1/authentication/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, userAccessType: "TOAST_MACHINE_CLIENT" }),
  });
  if (!r.ok) throw new Error(`auth ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const token = j?.token?.accessToken;
  if (!token) throw new Error("auth: no accessToken in response");
  return token;
}

async function get(path, token) {
  const r = await fetch(`${HOST}${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Toast-Restaurant-External-ID": RESTAURANT, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

// ---------- transform ----------

const norm = (s) => (s || "").toString().trim().toLowerCase();

function visibleOn(entity, channels) {
  if (!channels || channels.length === 0) return true;
  const v = entity?.visibility;
  if (!Array.isArray(v) || v.length === 0) return true; // older payloads omit it
  return v.some((c) => channels.includes(c));
}

function itemPrices(item) {
  // Base price, or size-sequence prices (e.g. "22 · 30" for two sizes), or nothing (market price / modifier-priced).
  const rules = item?.pricingRules || {};
  const seq = rules.sizeSequencePricingRules;
  if (Array.isArray(seq) && seq.length) {
    const prices = seq
      .flatMap((r) => (r.sequencePrices || []).map((p) => p.price))
      .filter((p) => typeof p === "number");
    if (prices.length > 1) return { prices };
    if (prices.length === 1) return { price: prices[0] };
  }
  if (typeof item?.price === "number") return { price: item.price };
  return {};
}

function flagsFor(item, cfg) {
  const flags = [];
  const text = `${item.name} ${item.description || ""}`.toLowerCase();
  for (const [flag, needles] of Object.entries(cfg.flags || {})) {
    if (needles.some((n) => text.includes(n.toLowerCase()))) flags.push(flag);
  }
  // Toast "diet" style tags if present
  for (const t of item.tags || []) {
    const tn = norm(t?.name || t);
    if (cfg.tagFlags?.[tn]) flags.push(cfg.tagFlags[tn]);
  }
  return [...new Set(flags)];
}

function transformGroup(group, cfg, channels) {
  const items = (group.menuItems || [])
    .filter((it) => visibleOn(it, channels))
    .filter((it) => !(cfg.hideItems || []).map(norm).includes(norm(it.name)))
    .map((it) => ({
      name: it.name,
      description: it.description || "",
      ...itemPrices(it),
      flags: flagsFor(it, cfg),
      guid: it.guid,
    }));
  const out = { name: group.name, items };
  if (group.description) out.note = group.description;
  // Nested groups flatten into sibling groups after the parent
  const nested = (group.menuGroups || []).filter((g) => visibleOn(g, channels)).map((g) => transformGroup(g, cfg, channels));
  return [out, ...nested.flat()];
}

export function transform(raw, cfg) {
  const channels = cfg.channels || [];
  const wanted = cfg.menus; // ordered list of { toastName, slug, name, subtitle?, pdf? }
  const byName = new Map((raw.menus || []).map((m) => [norm(m.name), m]));
  const menus = [];
  for (const w of wanted) {
    const m = byName.get(norm(w.toastName));
    if (!m) {
      console.warn(`menu not found in Toast: "${w.toastName}" (available: ${[...byName.keys()].join(", ")})`);
      continue;
    }
    if (!visibleOn(m, channels)) continue;
    const groups = (m.menuGroups || [])
      .filter((g) => visibleOn(g, channels))
      .flatMap((g) => transformGroup(g, cfg, channels))
      .filter((g) => g.items.length > 0);
    menus.push({ slug: w.slug, name: w.name || m.name, subtitle: w.subtitle || "", pdf: w.pdf || "", groups });
  }
  return {
    restaurant: cfg.restaurant,
    location: cfg.location,
    source: "toast",
    toastLastUpdated: raw.lastUpdated || null,
    updated: new Date().toISOString(),
    notes: cfg.notes || [],
    menus,
  };
}

// ---------- main ----------

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET || !RESTAURANT) {
    throw new Error("Missing TOAST_CLIENT_ID, TOAST_CLIENT_SECRET or TOAST_RESTAURANT_GUID");
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const token = await login();
  const meta = await get("/menus/v2/metadata", token);
  const existing = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, "utf8")) : null;
  if (existing?.source === "toast" && meta?.lastUpdated && existing.toastLastUpdated === meta.lastUpdated) {
    console.log(`unchanged (Toast lastUpdated ${meta.lastUpdated}); nothing written`);
    return;
  }
  const raw = await get("/menus/v2/menus", token);
  if (!raw.lastUpdated && meta?.lastUpdated) raw.lastUpdated = meta.lastUpdated;
  const out = transform(raw, config);
  const total = out.menus.reduce((n, m) => n + m.groups.reduce((k, g) => k + g.items.length, 0), 0);
  if (out.menus.length === 0 || total < (config.minItems || 10)) {
    throw new Error(`refusing to write: ${out.menus.length} menus, ${total} items (below minItems)`);
  }
  writeFileSync(OUT_PATH, JSON.stringify(out, null, 1) + "\n");
  console.log(`wrote ${OUT_PATH}: ${out.menus.map((m) => `${m.name} ${m.groups.length} groups`).join("; ")}, ${total} items`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
