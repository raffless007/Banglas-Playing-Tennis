import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const api = await readFile(new URL("../netlify/functions/api.mjs", import.meta.url), "utf8");
const start = api.indexOf("function locationNameKey(");
const end = api.indexOf("async function getPasscodeSetting(", start);
assert.ok(start >= 0 && end > start, "location hydration helpers are present");
const locationHelpers = new Function(`${api.slice(start, end)}; return { hydrateEventLocations };`)();

const locations = [
  { id: "civic", name: "Civic Park Tennis Courts", suburb: "Pendle Hill", entry_pin: "3120" },
  { id: "dirrabarri", name: "Dirrabarri Tennis Courts", suburb: "Greystanes", entry_pin: "4821" },
];

test("event hydration supplies the catalogue PIN for a legacy short venue label", () => {
  const [event] = locationHelpers.hydrateEventLocations([
    { id: "week", location: "Civic Tennis Court", suburb: "Pendle Hill", entry_pin: "" },
  ], locations);
  assert.equal(event.location_id, "civic");
  assert.equal(event.entry_pin, "3120");
});

test("event hydration uses catalogue PIN when the event PIN is null or whitespace", () => {
  for (const entry_pin of [null, "   "]) {
    const [event] = locationHelpers.hydrateEventLocations([
      { id: "week", location: "Civic Park Tennis Courts", suburb: "Pendle Hill", entry_pin },
    ], locations);
    assert.equal(event.entry_pin, "3120");
  }
});

test("a non-empty event PIN remains an editable per-event override", () => {
  const [event] = locationHelpers.hydrateEventLocations([
    { id: "week", location_id: "civic", location: "Civic Park Tennis Courts", suburb: "Pendle Hill", entry_pin: "7777" },
  ], locations);
  assert.equal(event.entry_pin, "7777");
});

test("ambiguous short venue aliases are not linked to an arbitrary PIN", () => {
  const ambiguousLocations = [
    ...locations,
    { id: "civic-annex", name: "Civic Annex Tennis Courts", suburb: "Pendle Hill", entry_pin: "9999" },
  ];
  const [event] = locationHelpers.hydrateEventLocations([
    { id: "week", location: "Civic Tennis Court", suburb: "Pendle Hill", entry_pin: null },
  ], ambiguousLocations);
  assert.equal(event.location_id, undefined);
  assert.equal(event.entry_pin, null);
});
