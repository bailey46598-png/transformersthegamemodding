# PS3 HOOVEREXT GSCs: first review (2026-11-08)

Source: `C:\Users\skeet\Desktop\TF claude\Hoover Dam Edition - PS3\...\[BLUS30047]\PS3_GAME\USRDIR\LEVELS\HOOVEREXT\`
(the Hoover Dam Edition mod; files dated 2024-01-07). Read-only; nothing copied into a game folder.
Scripts: `mods\ps3_tools\` (run with Blender's Python, `-I`). Status: ✅ verified, ❓ inferred.

## The five scenes
| File | Size | Role (LEVEL.CFG) | Objects | Mats | Names | DNO2 collision | Notes |
|---|---|---|---|---|---|---|---|
| `HOOVEREXT_MAIN_PS3` | 50 MB | NEXTGEN `DEFAULTSCENE` | 890 | 216 | 80 | 531 KB, 42 bodies; static ground 18,688 v / 18,173 polys | terrain, `+SKY`, `SKY_reflection`, `samsiteUnderwater1-3`, `BuildTer_Build6..` pieces. Only scene with IABL + ALA3 (anim) |
| `HOOVEREXT_BUILDINGS_PS3` | 24 MB | NEXTGEN `BUILDINGSCENE` | 343 | 146 | 273 | 29 KB, **70 bodies** (small box-like geoms) | `Build_Skin_*`, `LOD_damWall*/damTowers*/mainPowerPlant*/visitorCentre*`, `BUILDTYPE_*`, `BuildMatSwap_*`, `BuildTer_Build1..` |
| `HOOVEREXT_POS_PS3` | 12.6 MB | NEXTGEN scene | 76 | 66 | 77 | 3 bodies | prop models (`PO_*`), **incl. `PO_bigHandRail`, `PO_bigPillarTop`, `PO_stoneBench`** missing from the Wii scene |
| `HOOVEREXT_VEHICLES_PS3` | 1.5 MB | NEXTGEN scene | 28 | 73 | 29 | none | traffic vehicle models |
| `HOOVEREXT_PS3` | 8.5 MB | CURRGEN `SCENE HooverExt` | 2,043 | 289 | 294 | 473 KB, static ground 15,985 v | single-scene version. **SST0 = 32 KB** (Wii's is empty). Has `samsiteHatchDoor` |

- MAIN's ground collision is almost the same mesh as the Wii one already converted (18,680 v / 18,167 polys).
- BUILDINGS' 70 collision bodies are the building/tower collision the Wii port never converted
  (the mod readme also says "Dam towers are missing collision").
- The hi-res PC set has no HooverExt, but has PC versions of every scene type to use as templates:
  `AIRBASE_{MAIN,BUILDINGS,POS,VEHICLES}_PC.GSC`, the same for CITY and TRANQUILITY.

## Container ✅
- `u32 nu20Rel`, `u32 nTex`, then `nTex × {u32 offset, u32 size}`. **Every offset is relative to the end of that
  table** (`T = 8 + 8·nTex`). NU20 starts at `T + nu20Rel`.
- Data after the table: texture data → padding → vertex streams → big-endian u16 index data → NU20.
- There's no VBIB chunk; draw records point straight at container offsets (relative to `T`).

## NU20 block
- **Big-endian, tags byte-reversed** (`02UN`, `DAEH`, `LBTN`, …), as on Wii. Version **0**.
- **Chunks are 16-aligned; the size field excludes the padding** (so a naive walk breaks after NTBL).
- **Chunk order matches PC:** `HEAD NTBL TREF TST0 MS00 SST0 INID BNDS FDNS DISP [IABL] TAS0 SALI [ALA3] DNO2 GSNH PNTR`.
- **It has HEAD, GSNH and a PNTR pointer table**, unlike the Wii file. PNTR = `i32 n` then n self-relative offsets
  (relative to each entry) to every pointer field ✅ (all land inside the block). So endian-swapping can be driven
  from PNTR instead of structure knowledge, as with the PC writer.

### DISP ✅
- Header field offsets are the same as PC/Wii (+04 cmd count, +08 → stream, +0C → FDNS, +10 nObj, +4C mats,
  +60 groups, +6C named). Counts match INID/MS00.
- **Command stream = Wii-style 8-byte commands** `{u8 op, u8 sub, u16 0, i32 rel}`: 0x85/1 block, 0x87, 0x80/3 material,
  0x8B/1, 0x83 matrix, 0x82 draw, 0x84/4, 0x8E end.
- **Matrices** are 4×4 floats with the translation in the last row (same layout as PC, byte-swapped).

### Draw record (0xA0 bytes) ✅
| Offset | Field |
|---|---|
| +00 | `u8 flags (0x00/0x08/0x30), u8 ?, 05 02` |
| +04 | up to 8 × 8-byte **RSX vertex streams** `{u8 components, u8 type, u8 stride, 0, u32 offset}` |
| +84 | vertex count |
| +88 | index offset (rel. to T), BE u16 |
| +8C | **index count; triangle LIST** (quads show as `0,1,2, 3,0,2`), unlike PC strips |
| +90 | runtime pointer (listed in PNTR, 0) |
| +98 / +9C | stream base offsets ❓ |
- Types are `CELL_GCM_VERTEX_*`: 2 = float, 3 = half float, 4 = u8 (normalized).
- Position is always its own stream (`3×float, stride 12`). Then one interleaved stream, e.g.
  `4×u8 / 4×u8 / 2×half` (stride 12), `4×u8 / 2×half` (stride 8), up to 7 attributes (stride 32).
  Which u8×4 is normal vs colour vs tangent isn't decoded yet.

### Textures (TST0) ✅ (solved 2026-11-08)
- 68-byte records: `u32 w, u32 h, 16 B hash, u32 0, u32 1`, +0x20 RSX format (**0x86 = DXT1, 0x88 = DXT5**, 0 = empty),
  +0x22 u16 w, +0x24 u16 h, +0x2A flag byte, **+0x30 = 0x80000000 | container texture index** (0 = no data).
- **The DXT data is byte-identical to PC DDS data** (no swap, linear blocks). Some textures carry mips down to 4×4 or 8×8;
  count levels from the data size. (The earlier "byte-swapped endpoints" note was wrong: it came from pairing records
  with the wrong data.)
- **Material +0x25C (s32) = diffuse texture = TST0 record index** (−1 = none); copied at +0x45C. +0x2A0 = a second layer.
  The pointer at material +0x420 is the same runtime value in every material (not a texture).

### Vertex attributes ✅
- After the float3 position stream: u8×4 **normal** ((n+1)·127.5, w = 0), u8×4 **RGBA colour** (0x7F = 1.0, as PC),
  optional more u8×4 (tangent?), then **half2 UV** (or half4 = UV + a copy). Index values are absolute into the shared stream.

### Materials (MS00)
- `u32 count` then records of **~2.4–7.6 KB each** (PC = 628 B). They almost certainly carry compiled RSX shader
  programs ❓. Plan: rebuild them from PC templates (same approach as the Wii port), not byte-swap them.

### DNO2 ✅
- Same header as Wii/PC (version 15). The existing `pc_dno2_check.py` / `wii2pc.py collision()` layout applies.

## Restoration plan (suggested order)
1. ✅ Textures (see above).
2. Geometry: decode draw records → GLB (one scene at a time; VEHICLES is smallest) to check positions, UVs and colours.
3. Converter: PNTR-driven byte swap for the chunks that share PC layout (NTBL, INID, BNDS, FDNS, DISP tables, DNO2, GSNH),
   rebuild MS00 / draw records / VBs / IB (lists → strips or list) / commands (8 → 16 bytes), using the hi-res PC
   `*_MAIN/_BUILDINGS/_POS/_VEHICLES` files as templates. `mods\wii_tools\pcnu20.py` is the writer.
4. ✅ Quick wins (2026-11-08): building collision (from the Wii scene's identical bodies) and the 3 missing POS props are
   in the Wii-based `HOOVEREXT_PC.GSC` (`wii2pc.py`, `ps3_props.py`; see MODLOG). Not tested in game yet.

## Converter facts (2026-11-09, `mods\wii_tools\ps32pc.py`)
- **0x85 jump:** target = command index i + (rel + 4) / 8 (relative to the pointer field; the Wii's is relative to the command).
- **Materials:** index = sorted order of the 0x80 targets. Fields 0x000–0x24F are zero in every record (PS3-only data
  sits after the PC-like part). +0x258 flags (0x1000 common; PC has 0x1000 at +0xB4 right before its texture at +0xB8),
  +0x25C diffuse, +0x2A0 second layer, byte +0x424: 0x04 = opaque DXT1 only, 0x14 / 0x18 = alpha materials.
- **Instanced objects** take their material from the DISP+0x14 per-object tables, not from the 0x80 in the stream.
- **Vertex streams:** u8×4 streams after the position = normal, then colour; UV = last half2 (type 3) stream.
