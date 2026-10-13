'use strict';
// Every CREATE INDEX, as one SQL string. DATA FILE (see ddl.js). Applied by
// ensureIndexes() in schema/migrations.js, after the migrations.
//
// Two halves since Procress 19 part 2 (2026-10-10):
//   VAULT_INDEX_SQL — the tables v5 uses. VENDORED from DraconDex-SDB
//     (vault.sql's @indexes section), shared with APK. Add or change one
//     THERE, never here: test/indexes.test.mjs in SDB holds both apps' hot
//     queries to "no full table scan".
//   LEGACY_INDEX_SQL — Director / Navigator / Hero / Writer, the systems only
//     this app still reads. Stays here.
// INDEX_SQL is both, and is what schemaStamp() hashes, so a new SDB index
// re-runs ensureIndexes on every existing vault.
const { VAULT_INDEX_SQL } = require('../../../../src/schema/generated/vault-ddl.electron.js');

const LEGACY_INDEX_SQL = `
    -- Director
    CREATE INDEX IF NOT EXISTS idx_project_nexus             ON project(nexus_ref);
    CREATE INDEX IF NOT EXISTS idx_world_project_nexus       ON world_project(nexus_ref);
    CREATE INDEX IF NOT EXISTS idx_game_project_nexus        ON game_project(nexus_ref);
    CREATE INDEX IF NOT EXISTS idx_write_project_nexus       ON write_project(nexus_ref);
    CREATE INDEX IF NOT EXISTS idx_project_folder            ON project(folder_id);
    CREATE INDEX IF NOT EXISTS idx_project_description_proj  ON project_description(project_id);
    CREATE INDEX IF NOT EXISTS idx_object_category_project   ON object_category(project_id);
    CREATE INDEX IF NOT EXISTS idx_object_template_category  ON object_template(category_id);
    CREATE INDEX IF NOT EXISTS idx_object_project            ON object(project_id);
    CREATE INDEX IF NOT EXISTS idx_object_category           ON object(category_id);
    CREATE INDEX IF NOT EXISTS idx_object_attribute_template ON object_attribute(template_id);
    CREATE INDEX IF NOT EXISTS idx_timeline_project          ON timeline(project_id);
    CREATE INDEX IF NOT EXISTS idx_map_project               ON map(project_id);
    CREATE INDEX IF NOT EXISTS idx_relation_project          ON relation(project_id);
    CREATE INDEX IF NOT EXISTS idx_relation_type_ref         ON relation(relation_type);
    CREATE INDEX IF NOT EXISTS idx_relation_obob_relation    ON relation_obob(relation_id);
    CREATE INDEX IF NOT EXISTS idx_relation_obob_from        ON relation_obob(object_from);
    CREATE INDEX IF NOT EXISTS idx_relation_obob_to          ON relation_obob(object_to);
    CREATE INDEX IF NOT EXISTS idx_relation_obtl_relation    ON relation_obtl(relation_id);
    CREATE INDEX IF NOT EXISTS idx_relation_obtl_from        ON relation_obtl(object_from);
    CREATE INDEX IF NOT EXISTS idx_relation_obtl_to          ON relation_obtl(timeline_to);
    CREATE INDEX IF NOT EXISTS idx_relation_tltl_relation    ON relation_tltl(relation_id);
    CREATE INDEX IF NOT EXISTS idx_relation_tltl_from        ON relation_tltl(timeline_from);
    CREATE INDEX IF NOT EXISTS idx_relation_tltl_to          ON relation_tltl(timeline_to);
    CREATE INDEX IF NOT EXISTS idx_project_hashtag_tag       ON project_hashtag(hashtag_id);
    CREATE INDEX IF NOT EXISTS idx_object_hashtag_tag        ON object_hashtag(hashtag_id);
    CREATE INDEX IF NOT EXISTS idx_event_hashtag_tag         ON event_hashtag(hashtag_id);

    -- Navigator (World)
    CREATE INDEX IF NOT EXISTS idx_world_novel_project       ON world_novel(project_ref);
    CREATE INDEX IF NOT EXISTS idx_world_character_world     ON world_character(world_ref);
    CREATE INDEX IF NOT EXISTS idx_world_char_cat_category   ON world_character_category(category_ref);
    CREATE INDEX IF NOT EXISTS idx_world_char_link_object    ON world_character_link(object_ref);
    CREATE INDEX IF NOT EXISTS idx_world_category_category   ON world_category(category_ref);
    CREATE INDEX IF NOT EXISTS idx_world_object_object       ON world_object(object_ref);
    CREATE INDEX IF NOT EXISTS idx_world_object_symbol       ON world_object(symbol_ref);
    CREATE INDEX IF NOT EXISTS idx_world_map_map             ON world_map(map_ref);
    CREATE INDEX IF NOT EXISTS idx_world_map_area_area       ON world_map_area(area_ref);
    CREATE INDEX IF NOT EXISTS idx_world_map_point_point     ON world_map_point(point_ref);
    CREATE INDEX IF NOT EXISTS idx_world_timeline_world      ON world_timeline(world_ref);
    CREATE INDEX IF NOT EXISTS idx_world_timeline_map        ON world_timeline(world_map_ref);
    CREATE INDEX IF NOT EXISTS idx_world_tl_event_date       ON world_timeline_event(date_ref);
    CREATE INDEX IF NOT EXISTS idx_world_tl_object_object    ON world_timeline_object(world_object_ref);
    CREATE INDEX IF NOT EXISTS idx_world_tl_object_char      ON world_timeline_object(world_character_ref);
    CREATE INDEX IF NOT EXISTS idx_world_tl_object_point     ON world_timeline_object(point_ref);
    CREATE INDEX IF NOT EXISTS idx_world_orig_cat_world      ON world_orig_category(world_ref);
    CREATE INDEX IF NOT EXISTS idx_world_orig_tmpl_category  ON world_orig_template(category_id);
    CREATE INDEX IF NOT EXISTS idx_world_orig_obj_world      ON world_orig_object(world_ref);
    CREATE INDEX IF NOT EXISTS idx_world_orig_obj_category   ON world_orig_object(category_id);
    CREATE INDEX IF NOT EXISTS idx_world_orig_attr_template  ON world_orig_attribute(template_id);
    CREATE INDEX IF NOT EXISTS idx_world_description_world   ON world_description(world_ref);
    CREATE INDEX IF NOT EXISTS idx_world_tag_tag             ON world_tag(hashtag_id);
    CREATE INDEX IF NOT EXISTS idx_world_char_tag_tag        ON world_charactor_tag(hashtag_id);

    -- Hero (Game)
    CREATE INDEX IF NOT EXISTS idx_game_category_category    ON game_category(category_ref);
    CREATE INDEX IF NOT EXISTS idx_game_cat_object_object    ON game_cat_object(object_ref);
    CREATE INDEX IF NOT EXISTS idx_game_character_game       ON game_character(game_ref);
    CREATE INDEX IF NOT EXISTS idx_game_character_objlink    ON game_character(object_link);
    CREATE INDEX IF NOT EXISTS idx_game_char_template_game   ON game_char_template(game_ref);
    CREATE INDEX IF NOT EXISTS idx_game_char_attr_template   ON game_char_attribute(template_ref);
    CREATE INDEX IF NOT EXISTS idx_game_collection_game      ON game_collection(game_ref);
    CREATE INDEX IF NOT EXISTS idx_game_col_template_col     ON game_col_template(collection_ref);
    CREATE INDEX IF NOT EXISTS idx_game_col_element_col      ON game_col_element(collection_ref);
    CREATE INDEX IF NOT EXISTS idx_game_col_attr_template    ON game_col_attribute(template_ref);
    CREATE INDEX IF NOT EXISTS idx_game_char_element_element ON game_char_element(element_ref);
    CREATE INDEX IF NOT EXISTS idx_game_story_game           ON game_story(game_ref);
    CREATE INDEX IF NOT EXISTS idx_game_dialogue_story       ON game_dialogue(story_ref);
    CREATE INDEX IF NOT EXISTS idx_game_conversation_char    ON game_conversation(char_ref);
    CREATE INDEX IF NOT EXISTS idx_game_storyline_story      ON game_storyline(story_ref);
    CREATE INDEX IF NOT EXISTS idx_game_storyline_to         ON game_storyline(to_ref);
    CREATE INDEX IF NOT EXISTS idx_game_project_hashtag_tag  ON game_project_hashtag(hashtag_id);
    CREATE INDEX IF NOT EXISTS idx_game_char_hashtag_tag     ON game_char_hashtag(hashtag_id);
    CREATE INDEX IF NOT EXISTS idx_game_element_hashtag_tag  ON game_element_hashtag(hashtag_id);

    -- Writer (v2.7)
    CREATE INDEX IF NOT EXISTS idx_write_series_project      ON write_series(project_id);
    CREATE INDEX IF NOT EXISTS idx_write_book_series         ON write_book(series_id);
    CREATE INDEX IF NOT EXISTS idx_write_novel_link_novel    ON write_novel_link(novel_id);
    CREATE INDEX IF NOT EXISTS idx_write_wiki_link_object    ON write_wiki_link(object_id);
    CREATE INDEX IF NOT EXISTS idx_write_word_link_wiki      ON write_word_link(wiki_id);
    CREATE INDEX IF NOT EXISTS idx_write_note_project        ON write_note(project_id);

    -- idx_module_nexus (module(nexus_ref)) is superseded by SDB's
    -- idx_module_nexus_parent (nexus_ref, parent_id), whose prefix answers
    -- every query it did. Dropped so a vault does not maintain both.
    DROP INDEX IF EXISTS idx_module_nexus;
`;


const INDEX_SQL = VAULT_INDEX_SQL + LEGACY_INDEX_SQL;

module.exports = { INDEX_SQL, VAULT_INDEX_SQL, LEGACY_INDEX_SQL };
