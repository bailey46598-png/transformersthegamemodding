# HooverExt restoration: map versions compared, and the plan (2026-11-08)

Goal: one PC Hoover Dam exterior that has every **pro** of the Hoover Dam Edition (HDE) map setups and none of the cons.
Data from `mods\ps3_tools\compare_maps.py` (instances, collision, surface types) plus texture/material checks.
✅ = measured in the files, ❓ = inferred, 🎮 = needs an in-game check.

## The sources
| Version | File(s) | What it is |
|---|---|---|
| **Wii low-res** | `HOOVEREXT.CSC` → converted to `HOOVEREXT_PC.GSC` | Base of the current PC map (`Lab - HooverExt`, `TF Hoover Dam Edition PC`) |
| **PS3 Low Detail** | `HOOVEREXT_PS3.GSC` (one scene) | HDE "Default Low Detail Map" |
| **PS3 High Detail** | `HOOVEREXT_MAIN / _BUILDINGS / _POS / _VEHICLES_PS3.GSC` | HDE "High Detail Map" (split scenes, building system) |

Copies of the PS3 files: `PS3 assets\LEVELS\HOOVEREXT` (view them in TF Studio as `PS3_HOOVEREXT`).

## Headline finding
**The Wii scene already combines almost every pro of both PS3 maps.** It has High Detail's buildings, LOD versions,
building collision pieces, jetty, pylons, water towers and *its exact ground collision* (same 9 surface types, same
polygon counts). It also has Low Detail's SAM debris and hatch door. So the current PC map is the right base. What it
lacks is High Detail's **visual quality** (hi-res layered textures, denser geometry) and **destructible buildings**.

## The developer's pros and cons, traced to their cause
| HDE note | Map | Cause found in the files | Wii / current PC map |
|---|---|---|---|
| Mountains render properly | Low ✔ | Low terrain is single-textured. ✅ | ✔ single-textured (blend passes fixed in the converter) |
| Mountain textures glitched | High ✘ | 79% of MAIN's triangles use **layered materials**: grey tiling detail textures (512–1024) + a **normal map**, blended by a PS3 shader over vertex colours. No texture data is missing. ✅ The glitch is in the blend/shader. ❓ | n/a (not used yet) |
| SAM debris | Low ✔ / High ✘ | 46 scene objects `LO_A4C2{A–E}_HVE_GENERIC12…16`, turned into props by name. High's POS has only 15, **renamed** `HooverExt_EW_POS_156_LO_…`, so the name lookup fails. ✅ | ✔ all 46, original names 🎮 |
| SAM hatch doors | Low ✔ / High ✘ | Prop type `HVE_GENERIC65`, model `samsiteHatchDoor`; only Low/Wii have the model. ✅ | ✔ has the model 🎮 |
| Chapter 2 works | Low ✔ | Needs the debris above. High's ch2 script was rewritten ("destroy the Dcon virus", no turrets) as a workaround. ✅ | Map ✔, but the PC port uses the **High** script 🔧 |
| Out of bounds (kill / respawn) | High ✔ / Low ✘ | Collision surface type `05000000`: 208 polygons down the dam face to the river. Missing in Low. ✅ | ✔ identical to High 🎮 |
| Water not solid | High ✔ / Low ✘ | High: water sheets flagged `00000008`/`00000010` with the lake/river bed 20 units below. Low: same sheets flagged as plain ground `00000000`, beds removed. ✅ | ✔ identical to High 🎮 |
| All buildings present | High ✔ / Low ✘ | Low has 14 of 54 `Build_Skin_*` buildings, no `LOD_*`, no jetty, no pylons, no water towers. ✅ | ✔ all 54 |
| Dam towers / parking lot collision | High ✔ / Low ✘ | Low has no collision bodies for Build6–10 (intake towers, visitor-centre building) or the jetty. ✅ | ✔ baked in (quick wins, 2026-11-08) 🎮 |
| All buildings destructible | High ✔ / Low partly | Destruction = collision **bodies** handled by the building system (`BUILDINGSCENE`). Low has bodies only for Build1–5 (power plants). ✅ | ✘ buildings are drawn as plain scene objects; their collision is baked static |
| Glitchy pickups | Low ✘ | Low lacks 22 of the prop models the level spawns (`PO_palmTree*`, `PO_memorialSign*`, `PO_phoneBooth`, cars…). ✅ | ✔ has them, plus bigHandRail / bigPillarTop / stoneBench from PS3 |

**Only in High Detail:** `PO_palmTree3`, `PO_palmTree3_MED`, hi-res textures and geometry, the building system setup.
**Only in Low Detail:** an extra strip of ground south of the map (96 polygons, z < −1300). **Only in the Wii scene:** nothing
the PS3 maps need.

## Scripts and settings
- The HDE ships two script sets (`Different Map Settings\…\LEVELS\HOOVEREXT\AI`). The PS3 package installs **High**.
  `TF Hoover Dam Edition PC` uses **High** (byte-identical) on the Wii-converted map. `Lab - HooverExt` uses neither (it has the
  original game scripts).
- Differences between the sets: AUTO4CHAP1 (40 lines: Low swaps Dreadwings for DroneForklifts), **AUTO4CHAP2 (119 lines:
  Low = original SAM-debris objective + turrets; High = Dcon-virus workaround)**, AUTO4HUB (10), TRAFFIC.CFG (48),
  PLACEMENTS.INI (2: Low's start point moved out of a wall), HOOVERDAM DCON4CHAP1 (10) / CHAP4 (3).
- **The best set for the combined map:** High for chapter 1 (Dreadwings work, since out-of-bounds exists), **Low for
  chapter 2** (the map has the SAM debris and hatch doors). Check hub/traffic/placements line by line.
- `TF Hoover Dam Edition PC\LEVELS\HOOVEREXT\LEVEL.CFG` NEXTGEN still lists the split scenes that don't exist on PC.
  The lab uses `SCENE HooverExt` in both blocks; carry that over.

## Plan
**Phase 0: check the current map in game** (`Lab - HooverExt`, quick-win build). 🎮
Water not solid · falling down the dam face kills or respawns · intake towers / visitor centre / power plants solid ·
SAM debris and hatch doors appear in chapter 2 · props (benches, handrails, pillar tops) spawn and can be picked up.
These all follow from the data above, but the PC engine's handling of the surface types and `LO_` names hasn't been seen yet.

**Phase 1: scripts** ✅ installed in `TF Hoover Dam Edition PC` (2026-11-08), not play-tested 🎮.
`mods\hde_port\merge_hoover_scripts.py` builds the set: AUTO4HUB = Low, AUTO4CHAP1 = High + Low's 10 `#SpecialObj` debris
lines (checked: nothing else differs from High), AUTO4CHAP2 = Low (byte-identical), HOOVERDAM DCON4CHAP1 = Low (`#Doors`).
PLACEMENTS / TRAFFIC / DCON4CHAP4 stay High. The port also got the quick-win map, the handrail name fix and the radar MAP.
Backups: `_hde_port_backup\phase1_scripts\`, `\phase1_map\`; log in `HDE_PORT_LOG.txt`.
- Checked: every spline, placement, text string, speech entry and sound chapter 2 uses exists in the port. The taxi and saloon
  traffic models exist in the map. The port's `BIONICLE.CFG` (flattened, so the folder LEVEL.CFG isn't read) loads
  `SCENE HooverExt` for both detail settings.
- Not provable offline: `#Doors`, `#ForcePopRange` and `CountCGet` aren't used by any stock PC script. Command names are hashed in the exe.
  The Wii HDE's own chapter 2 uses all three, so they're game commands, not PS3-only ones. 🎮
- **In-game test list:** hub: SAM debris visible at the 5 sites · ch1: Dreadwings/DroneMigs spawn, debris present ·
  ch2: Prime's line plays, clearing a site makes its turret pop up through the hatch door and shoot MiGs, chapter completes ·
  HooverDam ch1: turrets rise through hatch doors · out-of-bounds kill on the dam face · water not solid.

- **Chapter 2 crash (2026-11-08):** the `#ClearIt` debris check crashed at 0x502D88. Fixed by `mods\HooverFixes`
  (HooverFixes.asi, in the HDE port); see MODLOG. Retest chapter 2, and check that debris appears and each site's
  turret activates after clearing it.

**Phase 2: remaining props and collision** ✅ (2026-11-08), installed in the lab and the HDE port, not play-tested 🎮.
- ✅ The 5 jetty platforms are solid: box shapes baked as 6 faces each (`wii2pc.py BOX_COLLISION_PREFIXES`; see MODLOG).
- Dropped: `PO_palmTree3` / `_MED` (HooverExt's PHYSOBJTYPES never places them).
- Dropped: Low's south ground strip (nothing is placed there; placements reach z −824, splines z −880).

**Phase 3: destructible buildings** (large). Give the PC level a real building scene.
- Write `HOOVEREXT_BUILDINGS_PC.GSC` from the PS3 BUILDINGS scene (or the Wii building objects). Use a hi-res PC
  `*_BUILDINGS_PC.GSC` (Airbase, City, Tranquility) as the template for the building-system parts (`BUILDTYPE_*`,
  `BUILDINTTYPE_*`, `BuildMatSwap_*`, `Build_Skin_*`, `BuildTer_*` bodies). Set `BUILDINGSCENE` in LEVEL.CFG.
- Then turn off the baked building collision (`BAKE_BODY_COLLISION = False`), or the walls stay solid after a building falls.
- Study first: how the PC building system pairs `Build_Skin` / `BuildTer` / `BUILDTYPE` objects (exe strings `BUILD_SKIN_`, `LOD_`).

**Phase 4: High Detail visuals** (largest, optional). A full PS3 → PC converter for MAIN / POS / VEHICLES
(format: `PS3_HOOVEREXT_NOTES.md`; reader: TF Studio `ps3_scene.js`, `ps3_props.py`).
- Map the layered terrain materials to PC's own High Detail terrain formats (hi-res Tranquility terrain: 0x929 / 0x1129 /
  0x1d29 with normal maps), so PC draws the layers itself. That could fix the PS3 mountain glitch rather than copy it.
- Rename High's 15 debris objects back to `LO_A4C2…` and add the 31 missing ones plus the hatch door from the Wii scene.
- Keep the Wii-based scene as the `CURRGEN` (Low Detail) fallback. High Detail needs `TransformersUseHires 1`.

**Possible extras:** the HDE removed F-22s, Shilka tanks and S7 drones because their models aren't in either map. Check
whether other PC levels (Airbase, Qatar) have those models to borrow.

## PS3 restore: High Detail as the base, Low Detail's strengths added back (plan, 2026-11-09)
Goal from the user: one restored HooverExt built from the two PS3 maps, keeping each one's pros and dropping its cons.

**Texture survey (`texsurvey.py`, data actually stored):**
| File | Textures | Data | Largest |
|---|---|---|---|
| PS3 Low `HOOVEREXT_PS3` | 189 | 2.7 MB | 8 × 512, mostly 64–256 |
| Wii `HOOVEREXT.CSC` (current PC map) | 232 | – | 13 × 512, mostly 64–256 (same class as Low) |
| PS3 High `MAIN` / `BUILDINGS` / `POS` / `VEHICLES` | 215 / 117 / 126 / 44 | 41 / 21 / 11 / 0.6 MB | 50 / 37 / 12 × 1024 |

So the current PC map already looks like Low. **High is the visual upgrade**, so High is the base and Low supplies the fixes:
| From High (base) | From Low / Wii (fixes for High's cons) |
|---|---|
| Hi-res terrain, buildings, props, vehicles | Mountains: Low's single-texture terrain look (or PC's own hi-res terrain materials) instead of the glitched PS3 layered shader |
| All 54 buildings + the building system (destructible) | All 46 SAM debris objects with their `LO_A4C2…` names (High renamed 15 and dropped 31) |
| Ground collision with out-of-bounds kill zone + non-solid water | `samsiteHatchDoor` model (chapter 2 / HooverDam turrets) |
| | Scripts: the merged Phase 1 set (Low chapter 2) |
| | PC fixes made since: jetty platforms, visitor-centre piece placement, well cap |

**How:** a PS3 adapter for the proven `wii2pc.py` pipeline rather than a new converter. PS3 DISP has the Wii's header
offsets and 8-byte command stream, the same 208-byte instances and the same DNO2 (version 15), so the DISP / INID /
BNDS / FDNS / DNO2 / GSNH writers carry over. PS3-specific parts to add:
- `nu20.NU20`: the PS3 container (`nu20Rel`, texture table) and 16-aligned chunks (size excludes padding).
- Geometry: RSX streams + triangle lists (reader already in `ps3_props.py`) instead of GX display lists.
- Materials: PS3 records are 2.4–7.6 KB with variable size → index by the 0x80 command targets (as `ps3_props` does);
  diffuse at +0x25C, second layer +0x2A0; rebuilt from PC templates (lit 0x0909; layered terrain → hi-res PC terrain
  templates 0x929/0x1129/0x1d29 from `Hi-res assets` Tranquility).
- Textures: copy the DXT data as-is (byte-identical to PC).

**Order (one in-game test each, in `Lab - HooverExt`, High Detail on):**
1. `HooverExt_Vehicles` (1.5 MB, no collision): proves the adapter. LEVEL.CFG NEXTGEN gets the extra scene.
2. `HooverExt_POs` (props).
3. `HooverExt_Main` (terrain + collision + layered materials). The hard step.
4. `HooverExt_Buildings` as `BUILDINGSCENE` (destructible buildings; drop the baked building collision for NEXTGEN).
5. Low/Wii fixes from the table above.
CURRGEN (Low Detail) keeps the current Wii-based map. The HDE port's flattened `BIONICLE.CFG` NEXTGEN block changes only
after the lab build works.

### Side-by-side preview of the two PS3 maps (2026-11-09)
Names used from here on: **early build** = `HOOVEREXT_PS3.GSC` (one file; the mod's "Low Detail"), **updated build** = the four
split files (the mod's "High Detail"). These are the only two HooverExt maps in the PS3 build.
Renders (top = early, bottom = updated): `mods\ps3_tools\previews\early_vs_updated_*.png`, made with
`mods\ps3_tools\ps3_scene_json.py` + `map_render.py` (Blender) + `pair.py`. Instanced objects take their material from the
per-object tables (DISP+0x14), not the stream; the first preview got that wrong and showed false black buildings.
| | Early build | Updated build |
|---|---|---|
| Triangles | 118k | 457k (terrain 411k) |
| Textures | mostly 64–256, 2.7 MB | up to 1024, ~74 MB |
| Terrain look | clean, consistent rock | much more detail, but streaky layered-texture glitch over the mountains |
| Buildings | dam, towers, a few blocks; visitor centre bare | all buildings, power pylons, parking structure, textured visitor centre |
| Lake by the dam | water fully covers | lake bed shows through in patches next to the dam |
| Untextured | far backdrop (2% of tris) | under 2% |

### Progress
- 2026-11-09 **Step 1 (vehicles) converted** with `mods\wii_tools\ps32pc.py`, installed in the lab as an extra NEXTGEN
  scene. **Works in game** (High Detail). Step 2 (props) converted and installed, not tested yet. Next: MAIN.
