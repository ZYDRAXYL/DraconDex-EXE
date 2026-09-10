'use strict';
// First-run seed rows (the symbol palette). DATA FILE (see ddl.js).
const SEED_SYMBOLS = ['⚔️ Sword', '🛡️ Shield', '🏹 Bow', '🗡️ Dagger', '🔥 Fire', '💧 Water', '🌿 Nature', '⚡ Lightning',
      '🌙 Moon', '☀️ Sun', '⭐ Star', '👑 Crown', '💀 Skull', '🔮 Orb', '📜 Scroll', '💎 Gem',
      '🐉 Dragon', '🦁 Lion', '🐺 Wolf', '🦅 Eagle', '🏰 Castle', '⚓ Anchor', '🕯️ Candle', '⚖️ Scale',
      '🪄 Magic', '🧿 Talisman', '🪶 Feather', '🕳️ Portal', '🧭 Compass', '🪨 Stone', '🌊 Wave', '🌪️ Storm',
      '🌸 Bloom', '🌾 Grain', '🍀 Clover', '🪐 Planet', '🧩 Puzzle', '🪙 Coin', '🔑 Key', '🧱 Brick',
      '🛶 Boat', '🧺 Basket', '🧬 DNA', '🫧 Bubble', '🪞 Mirror', '📡 Signal', '🧯 Extinguisher', '🗝️ Key'];

// ── Schema stamp ────────────────────────────────────────────────────────────
// initDB() is idempotent but not free: re-running the DDL, the column guards and
// the 118 CREATE INDEX statements cost ~1.6s of the main process before the
// first paint, on every single launch. The stamp lets a launch whose schema is
// already current skip the whole thing.
//
// The stamp is DERIVED, not hand-maintained. A hand-bumped constant fails the
// first time someone edits the schema and forgets to bump it, and that failure
// mode is a missing column in production. Hashing the schema source instead
// means any edit to the DDL, the indexes, the seed, or ANY schema-mutating
// function body changes the stamp automatically — including initDB's own inline
// legacy-Navigator probe, which is why String(initDB) is in the list.
//
// Bump SCHEMA_EPOCH by hand only to deliberately force a re-run on every client.

module.exports = { SEED_SYMBOLS };
