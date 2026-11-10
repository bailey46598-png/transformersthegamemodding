# Wii HOOVEREXT.CSC → PC: first look (2026-11-06)

Source: `C:\Users\skeet\Desktop\experiments =.=\HOOVEREXT.CSC` (6,975,040 bytes). Not copied into the game folder.

## Why the level is unused on PC
- `LEVELS\HOOVEREXT\LEVEL.CFG` and `LEVELS\HOOVERDAM\LEVEL.CFG` ask for the NEXTGEN scenes
  `HooverExt_Main`, `_Buildings`, `_Vehicles`, `_POs`. None of those `.GSC` files exist on PC.
- The configs, scripts, placements and splines for the level are all still there.
- The Wii file is the single CURRGEN scene `HooverExt`.

## Wii CSC layout
- It's the whole file as one NU20 block, **big-endian**. Tags are byte-reversed (`02UN`, `LBTN`, …).
  `i32 -length` = file size. Version field = 2 (the PC version field is 1).
- There are no texture, vertex or index buffers before the block. Everything is inside it.
- Chunks: `NTBL` (556 names), `TREF`, `TST0` (3.5 MB, **252 textures embedded**, 0x40-byte headers with
  u16 w,h + format), `MS00` (**467 materials**), `SST0`, `INID`, `BNDS`, `FDNS`, `DISP` (2.6 MB, geometry
  as **GX display lists**: about 30k `0x98` tri-strip opcodes), `IABL`, `TAS0`, `SALI`, `ALA3` (texture anim,
  `ANI4`), `DNO2` (568 KB).
- No `HEAD`, `VBIB`, `GSNH` or `PNTR`. Pointers look file-relative (no fix-up table).

## PC GSC layout (HOOVERINT_PC.GSC for reference)
- DDS textures, VBs and IBs come first, then `NU20` at `modelOffset+4`. Same scheme as the GHG files (see `GHG_FORMAT.md`).
- Chunks: `HEAD NTBL MS00 SST0 INID FDNS BNDS DISP TAS0 PORT TREF TST0 VBIB SALI DNO2 GSNH PNTR`.

## Step 1 done: decoded to Blender (2026-11-06)
- Tools are in `mods\wii_tools\`:
  - `wii_tex.py`: textures → PNG
  - `wii_scene.py`: DISP parser
  - `wii_to_glb.py`: GLB export
  - `blender_preview.py`: renders
- Output is `mods\wii_tools\out\HOOVEREXT_wii.glb`: 186,773 triangles, 100 texture groups, 232 textures.
- Run with Blender's Python, e.g. `"C:\Program Files\Blender Foundation\Blender 3.3\3.3\python\bin\python.exe"`.
- **Textures:** TST0 has 252 records of 0x3C bytes each. Fields: `u16 w,h`, `u16 fmt`, `+8` self-relative data pointer,
  `+0x34` self-relative palette pointer. Formats: 14 = CMPR, 9 = C8, 8 = C4. Palettes are RGB5A3.
  20 records have no data. ✅ All 232 look right.
- **DISP command stream:** this is at `DISP+8+0x8`. Each command is 8 bytes: `{u8 op, …, i32 self-relative}`.
  - `0x85` starts a block, `0x80` sets the material (pointer into MS00), `0x83` sets the matrix, `0x82` draws geometry, `0x8E` ends the stream.
  - There are 2,834 draws and 1,585 unique geometries. Every draw has a matrix: a 3×4 row-major
    `[R|t]`, stored as 16 floats.
- **Materials:** MS00 records are 292 bytes. **`+0xFA` s16 = texture index** ✅.
- **Geometry header:** described in `wii_scene.py`. Flags select index sizes and attribute formats. `+0x04` u16 = vertex count.
  Pointers: `+0x0C` → [pos], `+0x14` → UV, `+0x18` → colour, `+0x20` display list, `+0x24` size.
- **Display lists** are GX `0x98` tri-strips only. Vertex attribute order is POS, NRM, CLR, UV.
- **Scales:**
  - Float positions are in world units. s16 positions use 1/1024 ❓ (estimated from prop sizes; looks right).
  - s16 UVs use 1/16384 with flag 0x80, else 1/512 ✅ (UVs match exactly where vertices are shared). u8 UVs use 1/256.
  - Colours are RGBA6 with 32 = 1.0.
- **Still unknown:**
  - The global normal table that flag 0x40/0x100 indexes. Normals aren't exported; Blender computes them.
  - Handedness (left/right mirror) isn't verified against PC.
  - The two biggest objects (sky and probably the lake) and the material blend fields aren't decoded.
  - Texture 154 is a white-RGB, alpha-detail overlay. It only looks right in EEVEE, not Workbench.

## Step 3 done: converter built (2026-11-06)
- **Command:**
  `python mods\wii_tools\wii2pc.py "<HOOVEREXT.CSC>" mods\wii_tools\out\HOOVEREXT_PC.GSC`
  It takes about 6 s and writes 9.3 MB.
- **Writer:** `pcnu20.py`. `test_pcnu20.py` rebuilds **all 10 PC GSCs byte for byte** from symbolic chunks, with all
  pointers and PNTR regenerated.
- **Checker:** `pcgsc_check.py` is an independent PC reader. It checks pointers, commands, VB/IB ranges and texture
  indices, then exports a GLB. The converted file passes. Its render matches the Wii decode.
- **Converted:**
  - 252 textures (DXT1/DXT5)
  - 1,585 draw records, 155k vertices, stride 28 (pos, normal, BGRA colour, uv)
  - 2,834 matrices
  - 467 materials, from a HOOVERINT opaque template
  - the per-object tables, 524 instances and 33 display groups
  - runtime areas sized by PC rules
- **Left out for the first in-game test:**
  - DNO2 is the empty FRONTEND form, so **no collision**.
  - SST0 is empty, so no physics props from the scene.
  - TAS0 is empty, so no texture animation.
  - Materials are all opaque: no alpha or blend flags yet.
  - Normals are computed, not taken from the Wii table.
- **Bugs fixed on the way:**
  - The `+70` instances start right at the region; the two "matrices" belong to instance 0.
  - The Wii `0x85` jump is relative to the command start.
  - Wii material fields are counted from MS00+0x14 (texture u16 at +0xFA, RGB at +0xD4).
  - HEAD = {→PNTR unlisted, →GSNH listed}.

## In-game test 1 (2026-11-06): crash, fixed
- **Crash:** `c0000005` at 0x555CD7, writing to `[0+8]`. Call chain:
  `0x57A070` → load `0x579D90` → `0x5696D0(DISP)` → `0x568870`, which loops over the materials and calls
  `0x555CD0([mat68+8])`.
- **Cause:** my 68 B material display records were shifted by 4 bytes. The real records start at the `DISP+54`
  pointer-list targets. The real layout is now in `wii2pc.py` (from clone code at 0x5785A0):
  - +00 →DISP, +04 index, +08 →52 B rec, +0C/+18 →cmd stream, +10/+14 →16 B rec (`8D 01` …)
  - +28/+2C → buffers of 16×count, with the count at +38
  - the arrays are 16-aligned
- **Also fixed:**
  - TST0 40 B records are no longer 0xAB. The loader treats record +0x18 < 0 as "no texture", so they're zero now.
- **Learned:**
  - The material texture fields fixed up at load are +74 (s16), +B8, +BC, +C0, +C4, +E8, +EC, +FC, +100…+110, +24C.
    Flag 0x4000 marks a shared or external texture.
- **New tools:**
  - `minidump.py` reads crash dumps.
  - Capstone lives in the scratchpad.
  - `pcgsc_check.py` now emulates the material-record checks (real PC levels pass).

## In-game test 2: the level loads and draws ✅ (no collision yet)

## Collision (DNO2) decoded and converted (2026-11-06)
- **What DNO2 is:** the "Dyno" physics scene (`Engine\DynoScene.cpp`, `Geoms\KdTerrain.cpp`).
  GSNH+0x154 → DNO2 body+4.
- **Header (body):**

  | Offset | Field |
  |---|---|
  | +00 | u32 (hash or stamp) |
  | +04 | version 15 |
  | +08 / +0C | bodies |
  | +18 / +1C | shapes, 20 B each |
  | +28 / +2C, +30 / +34 | type-4 tables |
  | +38 / +3C | 64 B 4×4 transforms |
  | +40 / +44 | geoms, 48 B each |
  | +48 | world terrain |
  | +4C | → per-geom data pointer list |

- **Shape** (setup at 0x620500): `{s8 type, u8, s16 group (-1 = static world), s16 transform, s16 geom, 3 f32}`.
  Type 5 = KD-tree terrain.
- **Geom** (KdTerrain constructor 0x62AEF0, needs version > 3):
  `{u32 ver 4, nv, nn, npoly, nleaf, →verts f32×3, →polys u16×5 (quad + flags), →nodes {f32, f32, u16 child, u8 axis, u8},
  →leaves {f32×3, u32, f32×3, u32}, u32 nsurf, →surf {u8, u8, u16}, →u8 per poly}`.
  The per-geom data list holds bytes (no swap).
- **Wii HOOVEREXT:** 117 bodies, 119 shapes, 109 terrain geoms. **The static world is shape → geom 108**
  (18,680 verts, 18,167 polys). The other 108 terrain pieces belong to bodies (props, destructibles), which aren't converted yet.
- **`wii2pc.py collision()`** writes a PC DNO2 with that static terrain. `pc_dno2_check.py` reads it back:
  axes 0–3, children in range, valid leaves. Its render matches the level.

## In-game test 3 (2026-11-07): playable ✅
- Bumblebee stands on the road on the dam. The HUD shows "The Hoover Dam" / "Spill Way East", so the LEVELZONE
  coordinates line up with the converted geometry. That also means the world isn't mirrored.
- Textures, lighting, the lake and the railings show. The user reports "some errors". Details pending.

## Lighting / texture pass (2026-11-07), after "textures and lighting seem off"
- **Measured:**
  - Real PC levels use vertex alpha 0x7F everywhere. Mine copied the Wii alpha (mean 113).
  - PC prelit geometry uses the unlit format 0x0901 (stride 24) with +40 `3E16xxxx`, +B4 0x1000.
  - Only 233 of 1,585 Wii geometries have normals. The rest are prelit by vertex colour.
- **Changed:**
  - Per material: **lit** = Tranquility 0x0909 template (stride 28, VB0) when any of its geometry has normals.
    Otherwise **unlit** = Tranquility 0x0901 template (stride 24, VB1). Result: 43 lit and 424 unlit materials.
  - Vertex alpha is 0x7F except on soft-alpha (blend) textures.
  - Textures have full mip chains, and the DXT1 endpoints follow each block's principal colour axis.
  - The lab LEVEL.CFG gets `BACKGROUNDCOLOUR 120 140 165 128`. The Wii scene has no sky dome; the PC levels that have
    one draw it as geometry.
- **Found:** Wii material 466 (texture 127, a white 32×32 square, 884 draws) is the "vertex colour only" material, not a sky.
- **Not done:** material alpha and blend modes (the PC +40 low byte doesn't map cleanly), the Wii normal table,
  texture animation (TAS0), physics bodies and props.

## Test 4 (2026-11-07): the unlit 0x0901 path draws rainbow colours, reverted
- **Symptom:** surfaces on the unlit path (the sky dome, the intake towers) showed rainbow gradients. The lit surfaces were fine.
- **What it isn't:** the 24 B vertex layout. Real PC 0x0901 vertices are pos, D3DCOLOR, uv, the same as written. The cause is
  in the template material or its shader ❓. So the Wii scene *does* have a vertex-coloured sky dome.
- **Now:** every material uses the lit 0x0909 path (as in test 3, which the user said looked right but too dark).
  Vertex colours are ×1.5 (`--bright`; mean ≈100 against ~87 in real PC levels). Vertex alpha fixed, mipmaps on.
  `--unlit` turns the split back on for later experiments.

## Blend modes / multi-pass (2026-11-07): fixes "overlap / flicker", plus the sky
- **The Wii draws terrain and decals in several passes.** 13,253 triangles are drawn by 2+ materials, e.g. rock tex191 + dirt
  tex192, blended by vertex alpha. Mat 466 (white tex127, 884 draws, incl. the sky dome) is an ADDITIVE light pass.
- **PC material +0x40** (apply at 0x558A30; "make transparent" helpers at 0x558E00):
  - low nibble = blend: 0 opaque, 1 alpha, 2 additive, 3 reverse-subtract, 10 alpha test (ref = bits 23–30)
  - bits 14–15 = depth mode (0 normal, 1 no depth write, 2 always, 3 off; see 0x554700)
  - bits 20–22 and 12–13 are read too (not decoded)
- **Wii MS00 +0xB4 byte 0** uses the same blend enum.
- **Converter:** opaque → (0, depth on); blend/additive → (1/2, depth write off); cut-out texture → (10, depth on).
  Vertex alpha is kept for blend passes. Result: 213 opaque / 156 blend / 91 alpha test / 7 additive.
- **Brightness** is back to the Wii's exact vertex colours (`--bright 1.0`). The old "too dark" look came from the passes
  being drawn wrong.
- **Not found:** fog is shader-based (FOG_STAGE / SEMANTIC_FOG_*). Its parameters come from the lighting data,
  which is identical on Wii and PC (HOOVEREXT.RTL). There are no FOG keys in the level config.

## In-game result of the blend-mode build: worse, revised (2026-11-07)
- **What happened:** true PC blending with Wii vertex alpha, plus mat 466 additive, looked washed out and smeared (pale mountains).
  The Wii's TEV combiner setup is more than the blend byte.
- **Now:**
  - Back to the template look (nibble 1, depth write on, vertex alpha 0x7F, `--bright 1.5`, as in the build the user liked).
  - Cut-out textures use alpha test (10).
  - **Overlay passes (Wii blend 1–3, 160 materials) are pushed `OVERLAY_LIFT` = 0.02 along their normals.** They sit above
    their base pass, which stops the z-fighting. The normals were checked to point outward (79–100% up on ground layers).

## Water, flicker and fog pass (2026-11-07), after screenshots of the lifted build
- **Fog:** the RTL fog block is at 0x4604: f32 start, f32 end, u8 RGBA colour. The PC loads `<scene>_360.RTL` for NEXTGEN
  scenes (0x4A4700 adds "_360" when flag 0x200 of [0x6FB1D0] is set). The 360 fog is 607..1000, the Wii's (HOOVEREXT.RTL) is
  308..866, colour (159,175,216,35). `patch_rtl_fog.py` copies the Wii block into HOOVEREXT_360.RTL (backup `.orig`).
  The Wii reference zip (Level.Cfg etc.) has no fog keys.
- **PC +0x40 blend nibbles** (jump table 0x558C78/0x558C94):
  - 0 off; 1 alpha (SRCALPHA/INVSRCALPHA); 2 additive (SRCALPHA/ONE)
  - **3 = dst × (1 − srcA)** (ZERO/INVSRCALPHA, REVSUBTRACT)
  - 10 alpha test; 4–9, 11, 12 leave state; 13 = no change
  - Bits 20–22 = alpha test (0–1 off, 5 ref = bits 23–30, otherwise ref 0, func GREATER).
- **Wii blend 6** is used by one material only: 365, terrain detail, tex154 IA8 with the detail in alpha. It's the Wii's 2×
  multiply. It was drawn as alpha-blended white, which caused the pale rock blotches on the mountains. Now nibble 3, no
  depth write, texture alpha = 255 − 2I (the darkening half of the 2× multiply).
- **Water** = material 466 geometry with flag **0x100000** (31 geometries: the lake at y≈130 and the river at y≈−139). White
  vertex colour, alpha 15/31, plus a second layer with alpha 0..31. No texture or lake bed; the Wii look comes from TEV.
  Now coloured blue-green per vertex (`WATER_DEEP`/`WATER_LIGHT`, position-based variation, the second layer's alpha
  lightens). Material 466's tex127 can't carry a ripple texture: 420 other 466 geometries use UVs.
- **Pink road marks** = tex135 (mats 317/320, Wii blend 1, cut-out). They were alpha-tested, not lifted and drawn at full alpha.
  Cut-out overlays now use nibble 1 + alpha test field 2 + the Wii vertex alpha (fades like the Wii), lifted 2×.
- **Lift layers:** `OVERLAY_LIFT` = 0.03: blend overlays 1× (160), cut-out decals 2× (79), detail pass 3× (1).
- Materials that look unused are drawn by prop objects. Each material has exactly one 0x80 command, so a material slot
  can't be reused for water.

## LOD pass (2026-11-07), after "issues with LOD" screenshots (blurry visitor centre / dam wall, doubled towers)
- **Material per geometry comes from the object tables** (+14 {count, ->material list, ->command list}, paired by entry),
  not from the last 0x80 in the command stream. The stream order was wrong for 575 of 1,585 geometries, all instanced.
  So earlier "material 466 = water / sky / 884 draws" was a misreading. Now `object_tables()` builds `geo_mat`.
- **Water** really uses materials 428/433/435 (blend 1, tex0 = a grey placeholder, no UVs). It belongs to the instance
  "default_string". The upside-down sky dome **SKY_reflection** (tex150) sits under it, so the Wii water is see-through
  (vertex alpha ~0.5) over a reflected sky. Now: no texture, flat tint, Wii alpha × 1.4.
- **LOD stand-ins:** instances named `LOD_damWall*`, `LOD_damTowers*`, `LOD_mainPowerPlant*`, `LOD_visitorCentre*`,
  `LOD_exhibits`, `LOD_buildByExhibits` and `LO_waterTower*` each overlap a detailed `Build_Skin_*` instance.
  The Wii building system swaps them by distance (BUILDINGDRAWRANGE 750); the PC drew both.
  - **Now:** 37 stand-ins (cover ≥ 0.25 of a Build_Skin) draw one degenerate triangle (IB starts with 0,0,0).
  - **Left alone:** `LO_A4C2*_HVE_GENERIC`, `LO_boulder*` and `LO_girder*` have no detailed partner in the scene.
- Instance +0xC4 points back into the instance record (runtime link). +0xB8 flag values (4, 6, 0x806) are also found
  in stock PC levels. IABL (6 entries) and ALA3 (ANI4) are animation chunks, not LOD.

- **Follow-up (holes in the towers at mid range):** the building system finds stand-ins by name (`"LOD_"` at 0x50133E)
  and stops drawing glass and interiors beyond BUILDINGGLASSDRAWRANGE / BUILDINGINTERIORDRAWRANGE, expecting the stand-in
  to cover them. With the stand-ins hidden, the level's NEXTGEN block now sets BUILDINGDRAWRANGE,
  BUILDINGINTERIORDRAWRANGE and BUILDINGGLASSDRAWRANGE to 100000000, as stock Cybertron does. Backup: `LEVEL.CFG.pre_lod`.
- The RTL block at 0x4604 is an array of up to 32 fog records of 0x4C bytes (+0x14 = in use; the fog editor's
  "alternate settings"). Only record 0 is patched.

## LOD switching fixed properly: FDNS (2026-11-07)
- **FDNS** = per-object fade distances, 2 f32 per object (body = 8 × nobj, pointer at DISP+0x0C). It's used when the object
  flag byte (DISP+0x48) has **0x40** (engine 0x57E104 → fade function 0x5698B0, which skips the draw at fade 0).
  - near < far: hidden nearer than `near`, fades in up to `far` (LOD stand-ins)
  - near > far: fades out (detail pieces)
  - 0/0 = always drawn
- **The converter used to write FDNS as all zeros**, so every stand-in drew at every distance. That was the original
  "LOD overlap". The Wii values are big-endian and now byte-swapped:
  - stand-ins 250/200 (33) and 240/190 (9 dam wall)
  - detail fade-outs 350/400 (91) and 250/300 (20)
  - pylons 300/1500 (25)
  - Stock Tranquility uses 225/175 for its LOD_ objects.
- Stand-in hiding is off (`HIDE_LOD_STANDINS = False`). The lab LEVEL.CFG is back to BUILDINGDRAWRANGE 750
  (`LEVEL.CFG.pre_lod`).
- Instance +B8 bit 1 (value 2) = drawn by the instance loop (0x57F676). Value 4 without 2 = the building system draws it.

## What a converter has to do
1. Decode the Wii textures and re-encode them as DDS. CMPR maps almost directly to DXT1.
2. Decode the GX display lists into D3D vertex and index buffers.
3. Rewrite `MS00`, `DISP`, `DNO2` and the rest into the PC structures. Build `HEAD`, `VBIB`, `GSNH` and `PNTR`.
4. Point the level config at the converted scene, then test in game.

## HUD map (radar) added (2026-11-07)
- **Source:** `RTFE52\HooverExt Map.zip` (Dolphin dump, 8 PNGs: 7 map tiles plus one plain land filler tile, 101x99).
- **PC format** (same in every stock level with a `MAP` folder):
  - 16 tiles `MAP_<X><Z>_PC.DDS`, X/Z ∈ M002 M001 P000 P001. 128×128 DXT5, 1 mip, opaque.
  - `MAP_PC.DDS` = the 16 tiles stitched, 512×512 DXT5. X = column (M002 left), Z = row (M002 top). Checked exactly on HOOVERINT, CITY, TRANQUILITY2.
  - The tile path is built by `"%s/map/%s_%s"` (0x6A1B48, used at 0x5E25DD; radar = `DrawRadarMap`).
- **World mapping:** 750 units per tile. The map centre is world 0 + `MAPOFFSET`, so HOOVEREXT is centred on X = +750. Image up = world +Z.
  The scale was fitted from HOOVERINT geometry against its map (best fit 1500–1536 half-width; MAPOFFSET −750 = one tile).
- **Layout** (edge matching, then checked by overlaying HOOVEREXT_PC.GSC geometry; roads, dam and lake mesh line up):
  - row M001: d3a7 · c3c9 (dam) · 383b · 69cd
  - row P000: 0da4 · 215b · fb5f · (filler)
  - rows M002 / P001: filler land colour (161,111,86)
- **Tool:** `mods\wii_tools\wii_map2pc.py "<zip>" LEVELS\HOOVEREXT\MAP`. Preview: `mods\wii_tools\out\hooverext_map_preview.png`.
- The radar reads `<PATH>\MAP\` (InTheCity etc. use city's map), so `HOOVEREXT\MAP` also serves HooverDam. Installed in `Lab - HooverExt` too.
- **Not tested in game yet.** Cells with no Wii tile are plain land, so the lake has a straight edge at the
  right of the map (the M001/P000 boundary in column P001 and the top of that tile).

## Props (physics objects) investigation (2026-11-07)
- PC loads `NEWPHYSOBJ_NG.DAT` + `PHYSOBJTYPES_NG` when platform flag 0x200 is set (0x4F4F01). HDE's _NG.DAT is byte-identical to
  the Wii's `NEWPHYSOBJ.DAT`, and the types INI is identical to the Wii's. So the placement data matches the Wii scene.
- **NEWPHYSOBJ layout:**
  - header
  - 73 clusters at 0x64: f32 x,y,z, f32, u16
  - a table of 73 u16 pairs (props per cluster)
  - at 0x6AE: u32 833, then **833 × 12-byte records** (byte 10 = type index into PHYSOBJTYPES, byte 11 = flags 3/2)
- Each type's model is its `SpecialName`. Lookup 0x4F73F0 → 0x570020 searches the level's main scene ([level+0xAF4] = [0x762328]).
  If GSNH+0x110 → DISP, it searches **instances by name** (0x56FFA0); otherwise SST0 specials. Ours has GSNH+0x110 = DISP+8,
  like stock levels. Then it searches the global scene [0x6FB218].
- **Models:** 57 of 66 types' models exist as instances in the converted map. Not in the map: PObigHandRail (27 placements),
  PO_CarPickup3 (27), PO_bigPillarTop (9), PO_stoneBench (3), plus types 252–255 (8, special codes).
  Largest groups: boulder2 155, exhibit1 109, lampPost 101, sportCar 75.
- **DNO2 physics groups not converted:** 117 groups (+0x08 count, link words kind<<24 | instance index):
  - 106 `BuildTer_Build` (building collision)
  - 5 `jettyPlatform` + 1 `jettyGangway`
  - 3 `PO_boulder` + 1 `PO_lampPost`
  - Shapes: 108 KdTerrain with a transform, 8 type 3, 2 type 2.
  - The converter writes only the static ground (shape 108).

## Extra prop models from stock PC scenes (2026-11-07): PO_CarPickup3
- `extra_props.py` extracts an instanced prop by instance name from a PC GSC:
  - the 208 B instance, flag byte, draw distance, FDNS, BNDS
  - per draw (stride 28 / 0x0909 only): raw vertices, index strip, 628 B material, DDS texture
- `wii2pc.EXTRA_PROPS` adds each one to the converted scene as a template instance (the prop spawner finds models by
  instance name):
  - +1 object (t14/t18/t1C, lists appended to +20 commands / +24 materials, t28, t2C, flag byte, INID, FDNS, BNDS)
  - +1 instance (+B0 → t14, +B4 → NTBL name appended, +BC → new tail entry, +C0 = object index)
  - +1 material, texture and draw record per draw
  - per material, a command block `[0x85→+5][0x87][0x87][0x80][0x8B][0x84]`, then `[0x83 identity][0x82]` draw pairs.
    All of this goes just before the final 0x8E; only the 0x8E index moves (`remap`).
  - mat68 for extras: +0C → block start, +18 → its 0x8B, +20 = 1, +38 = 1 (A/B buffers 16 B each).
- **Truck:** 5 draws (the stride-20 shadow quad is skipped). Round-trip extract from the output is identical to Tranquility's.
- `PObigHandRail` in PHYSOBJTYPES is a typo that is also in the stock PC file. The model `PO_bigHandRail`, the pillar top and the
  stone bench exist only in the PS3 `HOOVEREXT_POS_PS3.GSC` (NU20 v0), which isn't converted.
