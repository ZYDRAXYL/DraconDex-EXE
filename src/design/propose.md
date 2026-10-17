# ข้อเสนอฟีเจอร์ที่ DraconDex (EXE) ยังขาด — 2026-10-17

> **ที่มา** : รันแอปจริง (EXE 5.1.1, `main` @ `c2e9b42`) ด้วย run-dracondex driver — สร้าง Nexus ตัวอย่าง "Aethra" พร้อม Classifier · Author · Chronicler · Locator · Scribe · Wanderer · Narrator · Sketcher · Diviner แล้วดูหน้าจอจริง
> \+ เทียบกับเครื่องมือที่ผู้ใช้กลุ่มเดียวกันใช้ (World Anvil · LegendKeeper · Kanka · Campfire · Plottr · Scrivener · Obsidian · Notion)
> **กติกา** : ข้อที่อยู่ในรายการนี้ grep ใน `electron/src` + `docs/` แล้วว่า**ยังไม่มีจริง** — ไม่ใช่การขัดเกลาหน้าจอที่มีอยู่
> ข้อที่ติด **ต้องตรวจก่อน** = ยังยืนยันไม่ได้ว่าขาดจริง
> **ขนาด** : S ≈ ไม่กี่วัน · M ≈ 1–2 สัปดาห์ · L ≈ หลายสัปดาห์ / แตะ SDB

## มีอยู่แล้ว (จึงไม่อยู่ในรายการ)
version history + restore (`db/versions.js`) · undo · ถังขยะ · wikilink + backlinks + `[[` autocomplete + Problems (ลิงก์ไม่มีปลาย) · Author : บท สถานะ synopsis POV corkboard มุมมอง Outline/Reading/Book · component เป้าจำนวนคำ (`pcOptGoal`) · ปฏิทินกำหนดเอง (`calendar-engine.js`) · Diviner (ตารางสุ่ม ลูกเต๋า) · ตัวแปรเรื่องใน Narrator · กราฟความสัมพันธ์ · family tree (`exhibitor-tree.js`) · export DOCX / EPUB / PDF / XLSX / CSV / Markdown / เว็บไซต์ HTML · cloud sync · Google Drive · DDX Transfer · 3D / PDF / เสียง · extension · package · template TTRPG / แฟนตาซี / visual novel / สืบสวน / นิยายออนไลน์

## 5 ข้อที่ควรทำก่อน

### 1. แผนที่จากรูปภาพ : หมุด · ลิงก์ · แผนที่ซ้อน — **L**
- **คืออะไร** : อัปโหลดรูปแผนที่โลก · วางหมุดที่ลิงก์ไป entity ใดก็ได้ (หน้าเมืองใน Classifier, โน้ต Scribe) · หมุดเปิดแผนที่ลูกได้ (ภูมิภาค → เมือง → ดันเจียน) · หมวดหมุด · แสดงหมุดตามระดับซูม · ไม้บรรทัดระยะทาง
- **ใครใช้** : นักสร้างโลก / GM มีแผนที่วาดไว้แล้ว อยากคลิก "Waterdeep" แล้วไปหน้านั้นทันที
- **หลักฐาน** : Locator ตอนนี้เป็น grid เปล่า มีแต่ polygon "Area" (สเกล "24px = 10 km") · ตาราง `map` / `map_area` / `map_point` เก็บแค่ polygon · ไม่มีรูปพื้นหลัง/หมุดใน `renderer/map.js` · หมุด `map_event` ของ Wanderer ลิงก์ได้แค่ event · LegendKeeper (ฟีเจอร์หลัก) · World Anvil · Kanka มี
- **ต่อยอดจาก** : Locator (`mod/locator.js`, `map.js`) · โค้ดหมุดของ Wanderer · ท่อ asset (`asset-media.js`) · `sketch_pin` / `api.wiki.resolveKeys`
- **ความเสี่ยง** : แก้ schema → ต้องปล่อย SDB + vendor เข้า APK/PWA · รูปใหญ่บน Konva (ใช้ proxy/thumbnail ที่มีอยู่) · `.ddx` export และ DDX Transfer ต้องพารูปไปด้วย

### 2. ความลับ / มองเห็นเฉพาะ GM + "ส่งออกสำหรับผู้เล่น" — **M–L**
- **คืออะไร** : ธง "ซ่อนจาก export/เว็บไซต์" ระดับ object · field · บล็อก · บท · โมดูล · บล็อกสปอยล์ · export HTML/PDF แบบผู้เล่นที่ตัดส่วนที่ซ่อนออก
- **ใครใช้** : GM แชร์วิกิโลกให้ผู้เล่นโดยไม่หลุดตัวตนจริงของตัวร้าย · นักเขียนเผยแพร่วิกิสาธารณะไม่มีสปอยล์
- **หลักฐาน** : `db/html-export.js` ไม่มีตัวกรองการมองเห็น · tone "Secret" (`pcToneSecret`) และ preset Classifier "ความลับ" เป็นแค่หน้าตา ไม่ได้ซ่อนอะไร · World Anvil (secrets + spoiler) · Kanka (สิทธิ์ผู้เล่น) มี
- **ต่อยอดจาก** : `html-export.js` · `md-export.js` · `pdf-export.js` · ตัวเลือกขอบเขตใน `hub/export.js` · ธงฟิลด์ใน `classifier-fields.js` · `page-block.js`
- **ความเสี่ยง** : คอลัมน์/ธงใหม่ = แก้ SDB · **หลุดง่าย** ผ่าน search / backlinks / กราฟ / Exhibitor ที่อ่านข้อมูลตรง → ตัวกรองต้องอยู่ชั้นกลางชั้นเดียว · ซ่อนพลาดครั้งเดียว = เสียความเชื่อใจ

### 3. นำเข้า : Markdown / โฟลเดอร์ Obsidian · DOCX · ข้อความล้วน (Scrivener ทีหลัง) — **M**
- **คืออะไร** : นำเข้าโฟลเดอร์ `.md` เป็น Collector (frontmatter → ฟิลด์, คง `[[ลิงก์]]`) · `.docx` / `.txt` เป็นบทของ Author
- **ใครใช้** : คนย้ายมาจาก Obsidian / Scrivener / Word / Google Docs ไม่อยากพิมพ์ใหม่ 200 หน้า — **อุปสรรคใหญ่สุดของการย้ายมาใช้**
- **หลักฐาน** : `db/md-export.js` เขียนไว้เองว่า "Export only: nothing here reads Markdown back" · นำเข้าโฟลเดอร์ปัจจุบันได้แค่เป็น asset · นำเข้าที่มี = CSV · `.ddx`/`.mddx` · legacy notes
- **ต่อยอดจาก** : รูปแบบของ md-export (ทำ round-trip) · `csv-import.js` · index ลิงก์ใน `wiki.js` · การสร้างบทใน `author.js`
- **ความเสี่ยง** : ต้องมีตัวอ่าน DOCX (เช่น `mammoth`) — ขัดกับแนว CSP / ไม่เพิ่ม dependency อาจต้อง vendor เข้ามา · resolve ลิงก์ต้อง 2 รอบ · ต้องมี mapping ใน `import-merge`

### 4. "กล่าวถึงแต่ยังไม่ลิงก์" + เสนอลิงก์อัตโนมัติ — **S–M**
- **คืออะไร** : ในแผง backlinks เพิ่มส่วนที่แสดงข้อความที่พูดถึงชื่อ entity แต่ยังไม่ได้ใส่ `[[ ]]` + ปุ่ม "ลิงก์" คลิกเดียว · (เสริม) hover card ดูตัวอย่าง entity ที่ลิงก์
- **ใครใช้** : นักเขียนที่พิมพ์ "Kael" ไป 400 ครั้งอยากลิงก์ทั้งหมดในรอบเดียว · GM อยากให้วิกิเชื่อมกันเองโดยไม่ต้องจำพิมพ์ `[[`
- **หลักฐาน** : Backlinks / Outgoing links มีแล้ว (`wiki.js`) · ไม่มี unlinked mentions / autolink ที่ไหน · Obsidian · World Anvil · Kanka มี
- **ต่อยอดจาก** : `wiki.js` / `wiki_link` · `search.js` · แผง backlinks ใน `page/links.js`
- **ความเสี่ยง** : ต้นทุนสแกน index ชื่อ · ขอบคำต่างกันตามภาษา — **ภาษาไทยไม่มีช่องว่าง** จับแบบตรง ๆ จะผิด (ใช้ `Intl.Segmenter`)

### 5. diff ระหว่างเวอร์ชัน + snapshot ตั้งชื่อเอง — **M**
- **คืออะไร** : ดูความต่างแบบเคียงข้าง/ในบรรทัดระหว่าง 2 เวอร์ชันของบท/โน้ตในแผง version · "ถ่าย snapshot ตอนนี้" พร้อมชื่อ ("ร่าง 2 ก่อนส่ง beta reader") ที่**ไม่ถูกลบอัตโนมัติ**
- **ใครใช้** : นักเขียนที่เขียนบท 7 ใหม่ อยากเห็นว่าเปลี่ยนอะไรไปจากร่าง 1 และเก็บร่างที่ตั้งชื่อไว้อย่างปลอดภัย
- **หลักฐาน** : `db/versions.js` เก็บ before-state ต่อ action สูงสุด 50 ต่อโมดูล (`versionLimit`) · `renderer/versions.js` มีแค่ restore ไม่มี diff · Scrivener (Snapshots + Compare) มี
- **ต่อยอดจาก** : `module_version` · `versions.js` · op restore `authorChapterContent`
- **ความเสี่ยง** : ต้อง vendor ไลบรารี diff หรือเขียน diff ระดับบรรทัด/คำเอง · เพดาน 50 รายการไล่เวอร์ชันเก่าออกเร็วเวลาแก้หนัก ๆ → snapshot ที่ตั้งชื่อต้องไม่ถูก prune (อาจต้องมีธงใน `module_version` = แก้ SDB)

## ข้อที่เหลือ (เรียงตามความสำคัญ)

| # | ฟีเจอร์ | ขนาด | ใครใช้ / ทำไม | หลักฐานว่ายังไม่มี | ต่อยอดจาก | ความเสี่ยง |
|---|---|---|---|---|---|---|
| 6 | ตัวติดตามการต่อสู้ (initiative · HP · สถานะ) + stat block | M–L | GM เตรียมและเล่น encounter ในแอปเดียว | template TTRPG มี monster / encounter แต่ไม่มี tracker · ไม่มี `initiative` / `statblock` ในโค้ด | Classifier + สูตร (`core/formula.js`) · Diviner · ตัวแปร Narrator | ระบบกติกาแต่ละเกมต่างกัน → โครงกลาง + preset SRD 1 ชุด · ระวังลิขสิทธิ์ |
| 7 | สถิติการเขียนรายวัน · streak · เส้นตายโปรเจกต์ | S–M | นักเขียนสาย NaNoWriMo อยากมีเป้ารายวัน + กราฟ | `pcOptGoal` นับแค่ยอดรวม · schema ไม่มี log รายวัน | hook เนื้อหาของ `author.js` · Sage · widget หน้า Home | ตาราง `writing_log` ใหม่ · **นับคำภาษาไทยต้องใช้ `Intl.Segmenter`** |
| 8 | ตรวจคำสะกดใน editor + พจนานุกรมต่อ Nexus | S–M | นักเขียนทุกคน — ตอนนี้ชื่อแฟนตาซีกับคำพิมพ์ผิดหน้าตาเหมือนกัน | `spellcheck="false"` ฝังไว้ที่ `mdeditor.js:140` และ `core/ui.js:251` | `session.setSpellCheckerLanguages` / `addWordToSpellCheckerDictionary` · toggle ใน Settings | ภาษาไทยแทบไม่มี spellcheck · Electron โหลดพจนานุกรมจากเน็ต (ขัดแนว offline) → เปิดผ่าน setting |
| 9 | คอมเมนต์ / หมายเหตุ / TODO บนบทและหน้า | M | จดโน้ตถึงตัวเองหรือ feedback จาก beta reader โดยไม่แก้เนื้อความ | ไม่มี UI หรือตาราง comment | `book_chapter` · ช่วงข้อความใน `mdeditor.js` · Problems เป็นที่รวม "คอมเมนต์ที่เปิดอยู่" | ตาราง `comment` ใหม่ (SDB) · ตำแหน่งเลื่อนเมื่อแก้ข้อความ · export ต้องตัดออกหรือพาไปด้วย |
| 10 | template โครงเรื่อง (Hero's Journey · Save the Cat · 3 องก์) + กระดาน plotline × บท | M | สาย plotter เลือกโครงแล้วเห็นว่า beat ไหนยังว่าง · ไบเบิลซีรีส์ | template ตอนนี้เป็นโครงตามแนวเรื่อง ไม่มี beat sheet · Plottr มี 12+ แบบ | ท่อ bundle/template (`bundle-catalog.js`) · Author board · Chronicler · Exhibitor | ส่วนใหญ่เป็นเนื้อหา + แปลชื่อ beat 18 ภาษา · มุมมองตารางเป็นของใหม่ชิ้นเดียว |
| 11 | มุมมอง Kanban ของ Classifier | S–M | GM ติดตามสถานะเควสต์ · นักเขียนติดตามความครบของตัวละคร | `CLASSIFIER_VIEWS = ['table','listDetail','relationCat','grid']` · group by มีแต่ลากระหว่างคอลัมน์ไม่ได้ | `classifier.js` · `core/list.js` · โค้ดลากของ Author board | เล็ก · ใช้ฟิลด์ select ที่มีอยู่ |
| 12 | ประเภทความสัมพันธ์แบบสองทาง + สร้าง family tree อัตโนมัติ | M | เขียน "Aria เป็นแม่ของ Kael" แล้ว Kael ขึ้น "แม่ = Aria" เอง | **ต้องตรวจก่อน** — มี `relation_type` และ family tree แล้ว แต่ยังไม่ยืนยันว่าฟิลด์ relation สร้างฝั่งกลับให้หรือไม่ | relation field ของ Classifier · `relation_type` · `exhibitor-tree.js` | ฝั่งกลับต้องรอดทั้งการลบ / merge / import |
| 13 | รวม entity ซ้ำ + ค้นหา-แทนที่ทั้ง Nexus | M | เปลี่ยนชื่อ "Kael" → "Cael" หลังเขียน 80 บท · มี "Kael" ซ้ำจากการนำเข้า CSV | ไม่มี merge entity และไม่มี replaceAll | การ rewrite ลิงก์ตอน rename ใน `wiki.js` · `search.js` · undo / versions · `import-merge.js` | กระทบกว้าง → ต้องผ่าน undo + version และ**ต้องมีตัวอย่างก่อนทำจริง** |
| 14 | timeline หลายแถว (อายุตัวละคร) + เล่นเหตุการณ์บนแผนที่ตามเวลา | M–L | "ใครยังมีชีวิตอยู่ตอนสงคราม" · "กองทัพเดินทัพ" ขณะเลื่อนเวลา | Chronicler มีแถวเดียว / แนวตั้ง / เทียบ / ปฏิทิน · Wanderer มีหมุดนิ่ง | Chronicler · Wanderer (`map_event`) · `calendar-engine.js` · `timeline.js` | ควรทำหลังข้อ 1 |
| 15 | ลิงก์แชร์แบบอ่านอย่างเดียว / เว็บที่โฮสต์ให้ | L | GM ให้ผู้เล่นเปิด URL เดียวที่อัปเดตตลอด | "เผยแพร่เป็นเว็บไซต์" ได้แค่โฟลเดอร์ HTML offline · Supabase sync ปิดตั้งแต่ v4.5.0 | `html-export.js` · `PUBLISH.md` · Drive · DraconDex-TRX | ต้องตัดสินเชิง product (โฮสติ้ง · ความเป็นส่วนตัว · ค่าใช้จ่าย) · ทำข้อ 2 ก่อน |
| 16 | ทำงานร่วมกันแบบ real-time หรือผลัดกันแก้ | L | คู่เขียนนิยาย · GM กับ co-GM | ออกแบบมาเป็นผู้ใช้คนเดียว · มี DDX Transfer / `import-merge.js` | `import-merge.js` · `sync.js` · module versions | เปลี่ยนโครงสร้าง — **ไม่แนะนำ**ก่อนข้ออื่น |
| 17 | hook สำหรับ AI ผ่าน extension API (ไม่ฝังโมเดลในแอป) | S–M | "สรุปบท 3" · "หาจุดขัดกัน" ด้วย key ของผู้ใช้เอง | **ต้องตรวจก่อน** — ยังไม่ได้ยืนยันว่า plugin API เปิดอ่าน/เขียน entity ได้แค่ไหน | ระบบ extension · `pluginpanel.js` · EXT template | ส่งต้นฉบับที่ยังไม่เผยแพร่ไปบริการภายนอก → ต้องมี UX ขอความยินยอมชัดเจน |
| 18 | โมดูล/preset บันทึกเซสชัน + checklist เตรียมเกม | S–M | GM เล่นทุกสัปดาห์ อยากได้ recap ที่ลิงก์ NPC / สถานที่ | template TTRPG มี "บันทึกเซสชัน" เป็นแชต Scribe แต่ไม่มีโครงเฉพาะ | Scribe / Drafter · `page-templates.js` · `pcTasks` | ส่วนใหญ่เป็น template → ถูก |
| 19 | hotkey จดไอเดียระดับ OS + web clipper | S–M | ไอเดียมาตอนเปิดเบราว์เซอร์ จดได้โดยไม่ต้องเปิดแอป | `core/shortcuts.js` มีแต่คีย์ลัดในแอป · ไม่ใช้ `globalShortcut` | หน้าต่างใน `main.js` · Scribe "กล่องจดหมาย" | tray / background ชนกับ single-instance lock ต่อ data dir |
| 20 | preset ต้นฉบับมาตรฐาน (manuscript format) ตอน export | S–M | ส่งต้นฉบับให้เอเจนต์/ประกวด ต้องจัดรูปแบบมาตรฐาน | มี PDF / DOCX / EPUB แต่ไม่มีตัวเลือก manuscript / compile | `docx-export.js` · `EXPORT-DECOR.md` | ต่ำ · เป็นตัวเลือกเพิ่มบน exporter ที่มี |

## ของถูกที่ทำคู่ไปได้
- **ข้อ 8** spellcheck : เปลี่ยน attribute + setting พจนานุกรม
- **ข้อ 11** มุมมอง Kanban
- **ข้อ 18** template เซสชัน

## ลำดับที่เสนอ
1. ข้อ 4 และข้อ 8 / 11 / 18 (เล็ก ไม่แตะ SDB) — ได้ผลเร็ว
2. ข้อ 5 (diff + snapshot) และข้อ 3 (นำเข้า) — ไม่ต้องรอ SDB ยกเว้นธง snapshot
3. ข้อ 1 และข้อ 2 — เริ่มที่ SDB (`sdb-v*`) แล้ว EXE → APK/PWA ตาม `chained-updated` · ข้อ 2 ต้องเสร็จก่อนข้อ 15
4. ข้อ 14 หลังข้อ 1 · ข้อ 16 เก็บไว้ท้ายสุด

## ข้อสังเกตระหว่างรัน (ส่งต่อให้ ui-researcher / bug sweep)
- empty state ของ Locator : canvas แผนที่ซ้อนอยู่เหนือ empty state อีกก้อน
- หลายโมดูลที่ไม่ใช่ Classifier ขึ้นแถบเรื่องเปลี่ยน layout หน้า
- ปุ่ม "New Nexus" ในหน้าต่าง Welcome ไม่เห็นผลผ่าน driver (เปิดหน้าต่างลูก `nexus-create.js`) — ส่งให้ bug sweep ตรวจแล้ว

## แหล่งอ้างอิง
- [World Anvil vs LegendKeeper](https://www.worldanvil.com/compare/world-anvil-vs-legendkeeper)
- [LegendKeeper — World Anvil alternative](https://www.legendkeeper.com/world-anvil-alternative)
- [Kanka — comparison](https://kanka.io/comparison)
- [Plottr 2.0](https://plottr.com/introducing-plottr-2/) · [Plottr](https://plottr.com/)
- [ALLi podcast — Plottr](https://selfpublishingadvice.org/podcast-using-plottr/)
