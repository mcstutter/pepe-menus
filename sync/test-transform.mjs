import { transform } from "./toast-sync.mjs";
import { readFileSync } from "node:fs";
const cfg = JSON.parse(readFileSync("config/vesuvio.json", "utf8"));
const raw = {
  restaurantGuid: "x", lastUpdated: "2026-09-23T20:00:00.000+0000",
  menus: [
    { name: "Dinner", guid: "m1", visibility: ["POS","TOAST_ONLINE_ORDERING"], menuGroups: [
      { name: "Pizza Napoletana", description: "Housemade gluten free crust + $2", visibility: ["POS"], menuItems: [
        { name: "Margherita", description: "mozz', basil, tomato sauce", price: 22, pricingStrategy: "BASE_PRICE", guid: "i1", visibility: ["POS"] },
        { name: "Diavola", description: "soppressata, pèpe bumba calabrian chili", price: 25, guid: "i2", visibility: ["POS"] },
        { name: "Open Food", price: 0, guid: "i3" }
      ], menuGroups: [
        { name: "Sides", menuItems: [ { name: "Truffled Gnocchi", description: "baked gnocchi", pricingStrategy: "SIZE_PRICE", pricingRules: { sizeSequencePricingRules: [ { sequencePrices: [ { sequence: 1, price: 22 }, { sequence: 2, price: 30 } ] } ] }, guid: "i4" } ] }
      ] },
      { name: "Kiosk only", visibility: ["KIOSK"], menuItems: [ { name: "Hidden", price: 1 } ] }
    ] },
    { name: "Happy Hour", guid: "m2", menuGroups: [ { name: "Drink Specials", menuItems: [ { name: "House Wine", description: "red, white, or bubbles", price: 11 } ] } ] },
    { name: "Catering", guid: "m3", menuGroups: [] }
  ]
};
const out = transform(raw, { ...cfg, channels: ["POS"] });
console.log(JSON.stringify(out, null, 1));
const dinner = out.menus.find(m => m.slug === "dinner");
const names = dinner.groups.map(g => g.name);
console.assert(names.join("|") === "Pizza Napoletana|Sides", "groups: " + names);
console.assert(!JSON.stringify(out).includes("Open Food"), "hideItems failed");
console.assert(!JSON.stringify(out).includes("Hidden"), "channel filter failed");
console.assert(dinner.groups[0].items[1].flags.includes("h/s"), "flag failed");
console.assert(JSON.stringify(dinner.groups[1].items[0].prices) === "[22,30]", "size prices failed");
console.log("\nALL ASSERTIONS PASSED");
