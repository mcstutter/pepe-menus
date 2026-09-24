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
import { createHash } from "node:crypto";

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

function stripPrefix(name, cfg, w = {}) {
  let n = (name || "").trim();
  for (const p of [...(cfg.stripPrefixes || []), ...(w.stripPrefixes || [])]) {
    if (n.toLowerCase().startsWith(p.toLowerCase())) n = n.slice(p.length).trim();
  }
  const rn = { ...(cfg.rename || {}), ...(w.rename || {}) };
  for (const [from, to] of Object.entries(rn)) if (norm(from) === norm(name)) return to;
  for (const suf of w.stripSuffixes || []) {
    if (n.toLowerCase().endsWith(suf.toLowerCase())) n = n.slice(0, -suf.length).trim();
  }
  for (const [from, to] of Object.entries(rn)) if (norm(from) === norm(n)) return to;
  return n;
}

function groupWanted(group, w) {
  const n = norm(group.name);
  if (w.groups && w.groups.length) return w.groups.map(norm).includes(n);
  if (w.excludeGroups && w.excludeGroups.length) return !w.excludeGroups.map(norm).includes(n);
  return true;
}

function hiddenByRule(it, cfg, w = {}, groupName = "") {
  if (Array.isArray(it.visibility) && it.visibility.length === 0) return true; // hidden everywhere in Toast
  const hideNames = [...(cfg.hideItems || []), ...(w.hideItems || []), ...((w.hideInGroups || {})[groupName] || [])].map(norm);
  if (hideNames.includes(norm(it.name))) return true;
  const only = (w.groupItemPatterns || {})[groupName];
  if (only && !new RegExp(only, "i").test(it.name || "")) return true;
  for (const pat of w.hidePatterns || []) {
    if (new RegExp(pat, "i").test(it.name || "")) return true;
  }
  if (cfg.hideZeroPrice !== false && typeof it.price === "number" && it.price <= 0 && !it.pricingRules?.sizeSequencePricingRules?.length) return true;
  for (const pat of cfg.hidePatterns || []) {
    if (new RegExp(pat, "i").test(it.name || "")) return true;
  }
  return false;
}

function transformGroup(group, cfg, channels, w = {}) {
  const items = (group.menuItems || [])
    // Website rule: an item shows only if it is on in Toast for the menu's channels (online ordering),
    // unless it is a printed, dine-in-only dish listed in alwaysShow.
    .filter((it) => visibleOn(it, channels) || (w.alwaysShow || []).map(norm).includes(norm(it.name)))
    .filter((it) => !hiddenByRule(it, cfg, w, group.name))
    .map((it) => ({
      name: stripPrefix(it.name, cfg, w),
      raw: it.name,
      description: it.description || "",
      ...itemPrices(it),
      flags: flagsFor(it, cfg),
      guid: it.guid,
    }));
  const out = { name: group.name, items };
  if (group.description) out.note = group.description;
  // Nested groups flatten into sibling groups after the parent
  const nested = (group.menuGroups || []).filter((g) => visibleOn(g, channels)).map((g) => transformGroup(g, cfg, channels, w));
  return [out, ...nested.flat()];
}

export function transform(raw, cfg) {
  const wanted = cfg.menus; // ordered list of { toastName, slug, name, subtitle?, pdf? }
  const byName = new Map((raw.menus || []).map((m) => [norm(m.name), m]));
  const menus = [];
  for (const w of wanted) {
    const channels = w.channels || cfg.channels || [];
    const m = byName.get(norm(w.toastName));
    if (!m) {
      console.warn(`menu not found in Toast: "${w.toastName}" (available: ${[...byName.keys()].join(", ")})`);
      continue;
    }
    if (!visibleOn(m, channels)) continue;
    const groups = (m.menuGroups || [])
      .filter((g) => visibleOn(g, channels))
      .filter((g) => groupWanted(g, w))
      .flatMap((g) => transformGroup(g, cfg, channels, w))
      .map((g) => ({ ...g, name: (w.groupNames || {})[g.name] || stripPrefix(g.name, cfg) }))
      .filter((g) => g.items.length > 0);
    if (w.dedupe) {
      const seen = new Set();
      for (const g of groups) g.items = g.items.filter((i) => (seen.has(norm(i.raw)) ? false : seen.add(norm(i.raw))));
    }
    for (const g of groups) for (const i of g.items) delete i.raw;
    if (w.groupOrder) {
      const rank = (g) => { const k = w.groupOrder.map(norm).indexOf(norm(g.name)); return k < 0 ? 999 : k; };
      groups.sort((a, b) => rank(a) - rank(b));
    }
    menus.push({ slug: w.slug, name: w.name || m.name, subtitle: w.subtitle || "", pdf: w.pdf || "", groups: groups.filter((g) => g.items.length > 0) });
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
  const configText = readFileSync(CONFIG_PATH, "utf8");
  const config = JSON.parse(configText);
  const configHash = createHash("sha256").update(configText).digest("hex").slice(0, 12);
  const token = await login();
  const meta = await get("/menus/v2/metadata", token);
  const existing = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, "utf8")) : null;
  if (existing?.source === "toast" && meta?.lastUpdated && existing.toastLastUpdated === meta.lastUpdated && existing.configHash === configHash) {
    console.log(`unchanged (Toast lastUpdated ${meta.lastUpdated}); nothing written`);
    return;
  }
  const raw = await get("/menus/v2/menus", token);
  if (!raw.lastUpdated && meta?.lastUpdated) raw.lastUpdated = meta.lastUpdated;
  // Structure map (menu and group names only) so the config can be tuned without credentials.
  const structure = (raw.menus || []).map((m) => ({
    menu: m.name, visibility: m.visibility || null,
    groups: (function walk(gs, depth) { return (gs || []).flatMap((g) => [{ name: g.name, depth, items: (g.menuItems || []).length, visibility: g.visibility || null }, ...walk(g.menuGroups, depth + 1)]); })(m.menuGroups, 0),
  }));
  writeFileSync(OUT_PATH.replace(/[^/]+$/, "_structure.json"), JSON.stringify(structure, null, 1) + "\n");
  // Item visibility map (name -> Toast channels) so managers' toggles can be audited without credentials.
  const vis = {};
  for (const m of raw.menus || []) (function walk(gs) { for (const g of gs || []) { for (const it of g.menuItems || []) vis[`${m.name} / ${g.name} / ${it.name}`] = it.visibility || null; walk(g.menuGroups); } })(m.menuGroups);
  writeFileSync(OUT_PATH.replace(/[^/]+$/, "_visibility.json"), JSON.stringify(vis, null, 1) + "\n");
  const out = transform(raw, config);
  out.configHash = configHash;
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
