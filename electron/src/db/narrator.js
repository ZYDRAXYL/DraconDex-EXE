'use strict';
// Story "Narrator" (progress.md Phase 10) — route-board data. Dialogue
// nodes carry a position on the board and an ordered conversation
// (story_talk rows); story_edge rows are the directed route connections.
// talkCount/snippet are joined in so the board can render each node's
// first line without a per-node round trip.
// Process 8 part 2: a dialogue's ordered list holds two row kinds --
// story_talk.row_type 'talk' (a spoken line) and 'choice' (a branch whose
// options live in story_choice_option). They share one talk_order sequence,
// so a choice can sit anywhere between two lines; every aggregate that means
// "spoken lines" therefore has to say row_type='talk' out loud.
const { getDB } = require('./core');

const ROW_TYPES = ['talk', 'choice'];
const rowType = (v) => (ROW_TYPES.includes(v) ? v : 'talk');
const EFFECT_KINDS = ['none', 'text', 'jump', 'reply'];
const effectKind = (v) => (EFFECT_KINDS.includes(v) ? v : 'none');

const getDialogues = (moduleRef) => getDB().prepare(`
  SELECT d.*, uc.color_code,
    (SELECT COUNT(*) FROM story_talk t WHERE t.dialogue_ref = d.id AND t.row_type = 'talk') AS talk_count,
    (SELECT COUNT(*) FROM story_talk t WHERE t.dialogue_ref = d.id AND t.row_type = 'choice') AS choice_count,
    (SELECT COUNT(DISTINCT speaker) FROM story_talk t WHERE t.dialogue_ref = d.id AND t.row_type = 'talk' AND speaker IS NOT NULL AND speaker != '') AS speaker_count,
    (SELECT t.speaker || CASE WHEN t.speaker IS NOT NULL AND t.speaker != '' THEN ': ' ELSE '' END || COALESCE(t.talk_sentence,'')
       FROM story_talk t WHERE t.dialogue_ref = d.id AND t.row_type = 'talk' ORDER BY t.talk_order, t.id LIMIT 1) AS snippet
  FROM story_dialogue d
  LEFT JOIN use_color uc ON d.color = uc.id
  WHERE d.module_ref = ?
  ORDER BY d.id
`).all(moduleRef);

const createDialogue = (moduleRef, name, colorId, xPos, yPos) =>
  getDB().prepare(`INSERT INTO story_dialogue (module_ref,name,color,pos_x,pos_y) VALUES (?,?,?,?,?)`)
    .run(moduleRef, name, colorId || null, Number(xPos) || 0, Number(yPos) || 0).lastInsertRowid;

const updateDialogue = (id, name, colorId) =>
  getDB().prepare(`UPDATE story_dialogue SET name=?, color=?, update_at=datetime('now') WHERE id=?`)
    .run(name, colorId || null, id);

const updateDialogueDescription = (id, description) =>
  getDB().prepare(`UPDATE story_dialogue SET description=?, update_at=datetime('now') WHERE id=?`)
    .run(description || null, id);

const updateDialoguePos = (id, xPos, yPos) =>
  getDB().prepare(`UPDATE story_dialogue SET pos_x=?, pos_y=?, update_at=datetime('now') WHERE id=?`)
    .run(Number(xPos) || 0, Number(yPos) || 0, id);

const deleteDialogue = (id) =>
  getDB().prepare(`DELETE FROM story_dialogue WHERE id=?`).run(id);

const getEdges = (moduleRef) => getDB().prepare(`
  SELECT * FROM story_edge WHERE module_ref = ? ORDER BY id
`).all(moduleRef);

// UNIQUE(from_ref,to_ref) upsert: re-connecting an existing pair just
// refreshes its label instead of erroring.
const createEdge = (moduleRef, fromRef, toRef, label) =>
  getDB().prepare(`
    INSERT INTO story_edge (module_ref,from_ref,to_ref,label) VALUES (?,?,?,?)
    ON CONFLICT(from_ref,to_ref) DO UPDATE SET label=excluded.label
  `).run(moduleRef, fromRef, toRef, label || null).lastInsertRowid;

const updateEdgeLabel = (id, label) =>
  getDB().prepare(`UPDATE story_edge SET label=? WHERE id=?`).run(label || null, id);

const deleteEdge = (id) =>
  getDB().prepare(`DELETE FROM story_edge WHERE id=?`).run(id);

const getTalks = (dialogueRef) => getDB().prepare(`
  SELECT * FROM story_talk WHERE dialogue_ref = ? ORDER BY talk_order, id
`).all(dialogueRef);

const createTalk = (dialogueRef, speaker, sentence, linkerKey, type) => {
  const d = getDB();
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(talk_order),-1) AS m FROM story_talk WHERE dialogue_ref=?`).get(dialogueRef).m;
  return d.prepare(`INSERT INTO story_talk (dialogue_ref,speaker,talk_sentence,talk_order,linker_key,row_type) VALUES (?,?,?,?,?,?)`)
    .run(dialogueRef, speaker || null, sentence || null, maxOrder + 1, linkerKey || null, rowType(type)).lastInsertRowid;
};

// Rewrites the whole order in one transaction from the list the UI dragged
// into shape -- the same shape as author.js's moveBookChapter, and the reason
// a choice can be dropped between two lines at all. dialogue_ref is asserted
// in the UPDATE so a stale id from another dialogue cannot be renumbered.
const moveTalks = (dialogueRef, orderedIds) => {
  const d = getDB();
  const st = d.prepare(`UPDATE story_talk SET talk_order=?, update_at=datetime('now') WHERE id=? AND dialogue_ref=?`);
  d.transaction(() => {
    (orderedIds || []).forEach((id, idx) => st.run(idx, id, dialogueRef));
  })();
};

const updateTalk = (id, speaker, sentence, linkerKey) =>
  getDB().prepare(`UPDATE story_talk SET speaker=?, talk_sentence=?, linker_key=?, update_at=datetime('now') WHERE id=?`)
    .run(speaker || null, sentence || null, linkerKey || null, id);

const deleteTalk = (id) =>
  getDB().prepare(`DELETE FROM story_talk WHERE id=?`).run(id);

// ── Choice options ──────────────────────────────────────────────────────
// One row per selectable option under a 'choice' row. jump_ref is the
// dialogue the option leads to; the matching story_edge is written by the
// renderer, since only it knows the module the board belongs to.
const getChoiceOptions = (dialogueRef) => getDB().prepare(`
  SELECT o.* FROM story_choice_option o
  JOIN story_talk t ON o.talk_ref = t.id
  WHERE t.dialogue_ref = ? ORDER BY o.talk_ref, o.option_order, o.id
`).all(dialogueRef);

const createChoiceOption = (talkRef, text) => {
  const d = getDB();
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(option_order),-1) AS m FROM story_choice_option WHERE talk_ref=?`).get(talkRef).m;
  return d.prepare(`INSERT INTO story_choice_option (talk_ref,option_text,option_order) VALUES (?,?,?)`)
    .run(talkRef, text || null, maxOrder + 1).lastInsertRowid;
};

const updateChoiceOption = (id, text, kind, effectText, jumpRef) =>
  getDB().prepare(`
    UPDATE story_choice_option SET option_text=?, effect_kind=?, effect_text=?, jump_ref=?, update_at=datetime('now')
    WHERE id=?
  `).run(text || null, effectKind(kind), effectText || null, jumpRef || null, id);

const deleteChoiceOption = (id) =>
  getDB().prepare(`DELETE FROM story_choice_option WHERE id=?`).run(id);

module.exports = {
  getDialogues, createDialogue, updateDialogue, updateDialogueDescription, updateDialoguePos, deleteDialogue,
  getEdges, createEdge, updateEdgeLabel, deleteEdge,
  getTalks, createTalk, updateTalk, deleteTalk, moveTalks,
  getChoiceOptions, createChoiceOption, updateChoiceOption, deleteChoiceOption,
};
