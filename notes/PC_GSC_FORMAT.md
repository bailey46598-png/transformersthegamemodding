# PC level scene format (.GSC), compared with Wii .CSC

Mapped 2026-11-06 from `LEVELS\HOOVERINT\HOOVERINT_PC.GSC`, checked against all 10 PC GSCs and the Wii
`HOOVEREXT.CSC`. Tools are in `mods\wii_tools\`: `nu20.py` is an endian-neutral reader. Status: ✅ verified, ❓ inferred.

## Container ✅
- Same layout as GHG: `u32 modelOffset`, `u16 texSlots`, DDS texture entries, `u16 vbCount` {size, data},
  `u16 ibCount` {size, data}, padding, then `NU20` at `modelOffset+4`.
- `ghg_lib.GHG(...).build()` rebuilds **all 10 PC GSCs byte for byte**. This only covers the container;
  the NU20 block is copied as-is.
- PC levels use 4–16 VBs and a **single shared u16 IB**.

## NU20 block
- **Header:** `"NU20"`, `i32 −length`, `i32 version`, 0. Version is **1 on PC** and **2 on Wii**.
  The Wii block is the whole file, big-endian, with byte-reversed tags.
- **PC chunk order:** `HEAD NTBL MS00 SST0 INID FDNS BNDS DISP [TAS0 PORT] TREF TST0 VBIB SALI DNO2 GSNH PNTR`.
- **Wii chunk order:** `NTBL TREF TST0 MS00 SST0 INID BNDS FDNS DISP IABL TAS0 SALI ALA3 DNO2`. Wii has no HEAD,
  VBIB, GSNH or PNTR.
- **Pointers are self-relative `i32` on both platforms.** So any structure keeps working after a byte swap,
  as long as its position relative to its targets is kept.
- **`PNTR`:** `i32 count`, then `count` self-relative offsets to every pointer field. HOOVERINT has 31,823 pointers:
  DISP 25,873, GSNH 3,991, MS00 1,648, SST0 206, TAS0 45, PORT 31, DNO2 28, HEAD 1.
- **The Wii file has no pointer table,** so a converter has to know every pointer field from structure
  knowledge.

| Chunk | PC | Wii | Notes |
|---|---|---|---|
| HEAD | 16 B: →NTBL+4, →PNTR+8, →GSNH+8 | – | Build it new |
| NTBL | name strings | same | Byte copy (no endian data except the length) ❓ |
| MS00 | `u32 count` + count × **628-byte** records from +0x10 | count × **292-byte** records from +0x14 | Different layout. See "Materials" below |
| SST0 | 87 KB, 206 pointers | 16 B, empty | ❓ |
| INID | `u32 nObj`, 0, `u16` list | same | nObj = 2,571 (PC) / 1,467 (Wii) ✅ |
| FDNS | `nObj × 8` zeros (runtime) | same | ✅ |
| BNDS | `0x80000001, nObj`, `nObj × 32 B` bounds | same | ✅ |
| DISP | See below | same header layout | Geometry differs |
| TREF / TST0 / VBIB | Runtime slots (`0xAB` fill) | TREF hashes, TST0 = Wii texture headers and data | Build new |
| SALI | `{0, 1}` | same | ✅ |
| DNO2 | 527 KB, 28 pointers, mostly packed 16-bit data | 568 KB, same header layout | **Probably collision** ❓ (there's no other collision file: the exe only loads `.gsc` plus text configs) |
| GSNH | 18 KB, 3,991 pointers (into DISP, MS00, TST0, NTBL, SST0, …) | – | Scene header. Not decoded yet |

## DISP ✅ (header fields line up between PC and Wii)
- `+00` → end of command stream
- `+04` command count (PC 11,652 / Wii 8,006)
- `+08` → command stream
- `+0C` → FDNS
- `+10` nObj
- `+14…+34` → eight per-object tables. Per-object sizes are 12, 2, 2, ~7.5 (→ lists), ~7.5, 4, 4, and a tail.
  The sizes match on both platforms.
- `+48` → material table, 68 B per material
- `+4C` material count (412 / 467)
- `+54` → 4 pointers per material
- `+60` count (22 / 33) → `+64` table of 36-byte entries
- `+6C` count (630 / 524): named objects (→ NTBL)
- `+70` → their pointer table
- `+7C…+8C` small tables

### Command stream ✅
- **PC:** 16-byte entries `{i32 type, ptr, 0, 0}`.
- **Wii:** 8-byte entries `{u8 op, u8 sub, u16 0, ptr}`, and **PC type = `sub<<8 | op`**.
- **Types:**
  - 389 = 0x185: block. Its pointer goes to the next block.
  - 135 = 0x87
  - 896 = 0x380: material
  - 395 = 0x18B
  - 131 = 0x83: matrix
  - 130 = 0x82: draw
  - 1156 = 0x484
  - 911 = 0x38F (PC only so far)
  - 142 = 0x8E: end
- **Matrices:** PC uses 4×4 D3D (row-major, translation in row 3). Wii uses 3×4 `[R|t]` padded to 16 floats.

### PC draw record (0x64 bytes) ✅
| Offset | Field |
|---|---|
| +00 | `u32 6` |
| +04 | `u16 primitiveCount` (strip indices − 2) |
| +06 | `u16 stride` |
| +08 | 8 × `0xFF` |
| +10 | `baseVertex` |
| +14 | `vertexCount` |
| +18 | `startIndex` into the shared IB |
| +1C | 0 |
| +20 | 1 |
| **+24** | **VB index** ✅ (`max(base+count) × stride` = that VB's exact size) |
| +28…+44 | 8 × −1 (bone palette) |
| +48… | zeros |

- **The Wii counterpart** is the geometry header with a GX display list (see `WII_HOOVEREXT_NOTES.md`).

## Materials
- **Texture index:**
  - PC: `+0x74` low u16, also `+0xB8`. They match in 1,749 of 1,758 materials across all levels.
    `+0xBC`, `+0xC0` and so on are extra layers (−1 = none).
  - Wii: low u16 of `+0xFC`, counting from the record start at MS00+0x14.
- **PC `+0x1F0` is the vertex format** ✅. Each bit adds one element, and the sizes sum to the stride:
  - `0x01` position (12)
  - `0x08` normal (4)
  - `0x100` colour (4)
  - `0x800` UV (8)
  - `0x200` and `0x400` are 4-byte extras
  - `0x1000` is a 16-byte extra
- **Examples:** `0x0101` = 16, `0x0109` = 20, `0x0901` = 24, **`0x0909` = 28** (the format we'll write: float3 pos, u8×4 normal,
  u8×4 colour, float2 uv), `0x1301` = 36.
- **Diffuse colour:** RGB floats at `+0x54…`.

## Converter plan, given the above
1. **Endian-swap and copy** the chunks whose layout matches: NTBL, INID, FDNS, BNDS, SALI, the DISP per-object
   tables, and probably DNO2. This needs the field widths. DNO2 is mostly 16-bit.
2. **Rebuild** the platform-specific parts:
   - textures → DDS entries
   - geometry headers + GX lists → draw records + VB/IB
   - materials → PC 628-byte records, starting from a PC template with `+0x1F0 = 0x0909`
   - matrices → 4×4
3. **Write new** HEAD, TREF, TST0, VBIB, GSNH and PNTR. Record every pointer as it's written.
4. **Validate** by running the same parser and writer over a real PC GSC. The output must match byte for byte.

## GSNH: the PC scene index ✅ (mostly an index of other chunks plus runtime slots)
| Offset (from GSNH+8) | Field |
|---|---|
| +00 | → +0x878 (248 zero slots, the runtime texture handles) |
| +04 | 248 = texture count |
| +08 | → +0xC58: 248 pointers → `TST0` slot records |
| +0C | → +0x208: **412 pointers → MS00 records**. The count is at +10 |
| +30 / +34 | 206 → +0x1038: `SST0` table, 12-byte entries `{u32, → name (NTBL), → SST0 record}` |
| +38 | → NTBL+0xC |
| +58 / +5C | nObj, → INID+0x10 |
| +60…+98 | `{count, → table}` pairs into TAS0 and PORT (portals) |
| +9C…+D8 | 16 null pointers (runtime) |
| +F0 / +F4 | nObj, nObj |
| +FC | → BNDS+0x10 |
| +110 | → DISP+8 |
| +138 | → GSNH+0x74 |
| +150, +164 | pointers outside the block, maybe runtime ❓ |
| +154 | → DNO2+0xC |
| +1D0 | → +0x19E0 (the region after the SST0 table) ❓ |
| +1E0 | → DNO2 |
| +1E8… | 8 null pointers |

- **For conversion,** GSNH can be generated: counts plus pointer tables to things we write.

## SST0 (PC): named special objects ✅/❓
- **Contents:** physics props and splines, e.g. `PO_BIGWHEEL1_1`, `PO_CRUCIBLE_1`, `AREA_500_spline`.
  Variable-size records, each with one pointer field at +0x14. Those pointer values point outside the file,
  so they're probably runtime.
- **The Wii SST0 is empty** (16 B). The Wii level must hold its props another way, probably through
  PLACEMENTS/PHYSOBJTYPES. First conversion target: an empty SST0, so no SST0-based props.

## More DISP tables ✅
- **`+14` per-object table:** 12-byte `{i32 count, → material-index list (+24 table), → command-index list (+20 table)}`.
  This is the same "Object" structure as in GHG, on both platforms. The lists hold **indices**, not pointers.
- **`+64`:** `count` (+60) × 36-byte display groups. Each points into the command stream and back to DISP+8.
- **`+70…+7C` region:** 4×4 matrices. Its size isn't a clean multiple of 64, so there's still a header or extra data in it ❓.
  The Wii version is the same kind of region.

## Revised converter plan (structure-preserving)
- **Keep the Wii's own level structure and byte-swap it.** The per-object tables, BNDS, INID, display groups
  and command indices all match.
- **Re-lay out only what changes size:**
  - Commands grow from 8 to 16 bytes. Pointers into the stream (block links, display groups) get relocated.
    Index lists are unaffected.
  - Geometry headers + GX lists become 100-byte draw records + VB/IB.
  - MS00 records go from 292 to 628 bytes.
  - Matrices stay 64 bytes and are rewritten in place from 3×4 to 4×4.
- **Getting the pointer field list for the Wii structures:** use the PC `PNTR` table to learn which offsets
  of each PC structure type are pointers. The structures match, so the same offsets apply to the Wii ones.
- **Build new:** HEAD, GSNH (an index), TREF/TST0/VBIB (runtime slots), PNTR, and an empty SST0.

## DISP region map, both platforms ✅
Each row is `header field → region`. Unless noted, both platforms have the same layout.

| Field | Region | Notes |
|---|---|---|
| +08 | command stream | Wii 8 B/cmd, PC 16 B/cmd. Count at +04 |
| +00 | source file name string | PC `hooverInt_PC.GSC`, Wii a `\\dev2\...\hooverExt.CSC` path |
| +14 | per-object `{count, →mat-index list, →cmd-index list}`, 12 B × nObj | |
| +18, +1C | `u16[nObj]` each | |
| +20, +24 | `u32` command-index / material-index lists | total = number of draws |
| +28 | `u32[nObj]` zeros (runtime) | |
| +2C | `f32[nObj]` draw distance | PC 300, Wii 1000. PC adds 8 bytes |
| +30, +34 | zeros (runtime) | size varies |
| +58, +5C | 64 B zeros each (runtime) | |
| +48 | `u8[nObj]` flags (padded to 4), then nMat × **68 B per-material records** | Same offsets. Wii has a `u8` at +24 where PC has a `u32`. PC +18 is a pointer, Wii's is 0. Pointer fields: +04, +0C, +10, +14, +18, +1C, +28 (null), +2C, +30, +34 (null) |
| +54 | nMat pointers → those 68 B records, then runtime 52 B records (zeros + pointer fields) | |
| +60 / +64 | count, then 36 B display groups | Fields: +00 (PC index / Wii pointer), +04 → command, +10 → self, +14 = 1 (PC u32, Wii u8), +1C → DISP+8, +20 u16 pair |
| +6C / +70 | count; region = 2 identity 4×4 matrices + 48 B bounds records `{min xyz 1, max xyz 1, centre xyz, radius}` | |
| +7C | geometry: PC draw records (100 B), cmd-911 data and 4×4 matrices. Wii: geometry headers, GX lists, vertex arrays, command matrices | |
| +80 | 608 B zeros | |
| +88 | PC 324 B / Wii 280 B: bitmask-like ❓ | |
| +38, +3C, +84 | PC = nObj, Wii = 0 or junk | |
| +44, +50, +78 | PC → BNDS+0x10, GSNH+0x210 (material pointer table), GSNH+8. Wii = 0 | |
| +74 | PC 0x4000, Wii 0x20000 ❓ | |

- **Runtime chunk sizes:** VBIB = 8 + 4×nVB + 8. TST0 (PC) = 8 + nTex×4 + nTex×40. GSNH's texture pointers point at the 40 B records.

## Which chunks are optional ✅ (checked across all 10 PC GSCs)
- **SST0:** 16 B (empty) in AIRBASE, CITY and both FRONTENDs. **An empty SST0 is valid in shipped levels.**
- **PORT:** only in HOOVERINT. Optional.
- **TAS0:** always present, 160–432 B. The Wii file has a 592 B one, so convert it.
- **DNO2:** 112 B in FRONTEND (a menu, no collision) against 55 KB–1.2 MB in real levels. This supports DNO2 = collision.

## Per-draw material and matrix ✅ (2026-11-08, from `mods\tf_studio`)
- **Material:** walking the command stream and keeping the last `0x380` material gives the wrong one for about
  40% of CITY's draws. They follow the last material command.
  - Use the per-object table instead (DISP `+14` → `{count, → material indices, → command indices}`). Its material
    list is authoritative and parallel to the command list.
- **Matrix:** every draw in all 11 PC GSCs is preceded by its own `0x83` matrix command. No matrix is shared
  between draws (CITY: 7,766 draws, 7,766 matrices).
  - The vertex data is shared between instances (one CITY street prop shares its vertices with 83 others).
  - So **edit the matrix, not the vertices**, to move or hide a single object.

## Open questions
- Exact field widths for the byte swap in DNO2 (probably collision: mostly 16-bit) and in the 36-byte display groups.
- TAS0 / PORT (PC, HOOVERINT only?) and IABL / ALA3 (Wii only).
- The GSNH tail after +0x19E0.
- Whether the game accepts an empty SST0 and minimal TAS0/PORT. This needs an in-game test.

## Rebuilding a GSC with a different layout ✅ (2026-11-08, `mods\tf_studio\js\gsc_writer.js`)
- Every PNTR entry is turned into "chunk + offset → chunk + offset", so chunks can grow and the writer recomputes
  every self-relative value. Unedited files rebuild byte for byte (all 13 `_PC.GSC`).
- **HEAD body+0 → PNTR+8 (the count) is not listed in PNTR.** It has to be rewritten whenever the layout moves.
- A few PNTR entries (SST0, TAS0, GSNH) hold values that point outside every chunk: runtime junk. They're kept as
  stored.
- Texture entry header `{w, h, mips, fmt, z}`: fmt 12 or 14 = DXT1, 15 = DXT5 (2,517 stock textures checked
  against their DDS headers); cube maps have w < 0.
- **In game:** a re-laid-out Tranquility 2 (every chunk +16 B) loads and plays. A resized texture isn't tested yet.

## DNO2 collision: layout used for editing ✅ (2026-11-08, checked on every stock PC level)
Reader, tree builder and writer: `mods\tf_studio\js\dno2.js`. Editor glue: `js\collision_view.js`.
- **Header (chunk body):**

  | Offset | Field |
  |---|---|
  | +08 / +0C | bodies, 32 B each |
  | +18 / +1C | shapes, 20 B each |
  | +38 / +3C | transforms, 64 B |
  | +40 / +44 | geoms, 48 B |
  | +4C | → per-geom pointer list (→ 2 bytes per polygon) |

- **Body:** `{f32 mass, 0, 0, u32 link}`. `link >> 16` = **scene instance index** (DISP+0x70 records, 208 B).
  `link & 0xFFFF` = kind (0x10 building piece, mass 1; 0x11 prop, mass 100).
- **Shape:** `{s8 type, u8, s16 body, s16 transform, s16 geom, f32 ×3}`.
  - Type 5 = KD terrain; type 2 = primitive (posts; the 3 floats look like radius / half height / radius).
  - A body's geom is local: world = shape transform × instance matrix (row vectors).
  - Body −1 with transform −1 = the **world-space** static geom.
  - Body −1 with a transform = a static piece placed by that transform. Qatar reuses one geom 13 times this way.
- **Scene instances have their own world matrix** at +0, separate from the per-draw 0x83 matrices. Rendering
  uses the draw matrices; physics bodies use the instance matrix.
- **Geom arrays:** stored together in the order verts (12 B), polys (10 B: quad a b c d, triangle when d == c,
  plus a u16 kept as is), per-poly surface byte, nodes (12 B), leaves (32 B), surface table (4 B), then the
  2 B/poly block.
- **Tree rules** (all 10,229 stock nodes):
  - Node = `{f32 a, f32 b, u16 child, u8 axis, u8 0}`. Axis 3 = leaf, and child is the leaf index.
  - Otherwise the high child is the next node (every value ≥ b) and the low child is node `child` (≤ a).
  - Stock bounds are sometimes loose, never violated.
  - Leaf = `{min xyz, u32 count, max xyz, u32 first poly}`. The box exactly fits its polygons.
  - Leaves are in depth-first order with contiguous polygon ranges (≤ 56 per leaf in stock files).
- **Rebuilding:** a fresh median-split tree (24 polys per leaf) passes the same checks on every level, and the
  file reads back identically elsewhere. Converted HOOVEREXT isn't supported (its DNO2 arrays aren't
  16-aligned).
- **In game ✅:** a rebuilt Tranquility 2 tree loads, and a lifted house is solid at its new height (lab test 3).

## Adding objects (copies) ✅ in game (2026-11-08, `mods\tf_studio\js\scene_edit.js`)
Checked on all 9 stock levels: copies added, every old object keeps its draws, instances still point at the
right objects, block skips unchanged, rebuild stable.
- **Command stream (DISP+08, 16 B commands, count +04):**
  - Material blocks: `[0x185 → next block or group end][0x87][0x87][0x380 → MS00][0x18B]`, then draw pairs
    `[0x83 → matrix][0x82 → draw record]`.
  - `0x484` ends a display group. Some 0x185s skip to it, which is normal. `0x8E` ends the stream.
  - A copy's pair goes right after the source's 0x82, in the same block. A skip that pointed at the next block
    start moves with it.
  - Command numbers are stored only in the object command lists (+20); everything else uses pointers.
- **Display groups (+64, 36 B, count +60):** `+00` sort key, `+04` → first block, `+20` = first material << 16 |
  material count. No command numbers.
- **Material display record (68 B, via +54):**
  - `+0C` → its block, `+18` → its 0x18B.
  - `+38` = an odd count (1, 3, 5…) that sizes the buffers `+28`/`+2C` (16 B × count). It's **not** the
    number of draws (a block with 12 draws has 1), so adding draws to a block doesn't touch it.
  - The 0x380 material often differs from a draw's own material (the object table's list is authoritative).
- **Draw record (100 B):** no pointers, and **shared between draws** (Cybertron: 561 draws, 253 records). At load the game replaces +24 (the VB index) with the D3D vertex buffer pointer, but only for records it finds itself: a copied record crashed `SetStreamSource` (lab test 4). A copy must point at its source's record. Matrices are the last thing in DISP; new ones go right after the last stock matrix.
- **Two object counts:**
  - **All objects:** +10. Tables +14 (12 B), +18/+1C (u16), +28 (u32, runtime zeros), +2C (f32 draw distance),
    and the bitsets +30/+34 (`2 × align8(ceil(n/8))` bytes, runtime zeros).
  - **Culled objects:** +38, +3C, +84, INID count, BNDS count, GSNH +58/+F0/+F4. Tables +48 (u8 flags),
    FDNS (8 B), BNDS (32 B), INID (u16 order list), and +88 (`4 × (n/32 + 1)` bytes).
  - +88 is one bit per culled object that has a scene instance: its set bits equal the instance count in every
    level.
  - CITY (3,861 / 2,881) and AIRBASE (1,714 / 1,701) have objects past the culled count with no bounds. A new
    object goes in at index = culled count, and instance +C0 (object index) moves up for the objects after it.
- **BNDS record:** world centre xyz, radius (= length of the half extents), half extents xyz, 1. Matches the
  drawn geometry exactly.
- **Instance record (208 B):**
  - +00 world matrix, +40 second matrix (identity in stock).
  - +80 min xyz 1, +90 max xyz 1, +A0 centre xyz + radius.
  - +B0 → object entry, +B4 → name, +B8 flags, +BC → its u32 slot in a table after the instances, +C0 object
    index.
  - Copies don't get an instance yet.
- **Named copies (scene instances) ✅ offline:** a copy can get its own 208 B instance record.
  - It's a copy of the source's instance with +00/+40 moved, bounds from the copy's geometry, +B0 → new object,
    +B4 → new name, +BC → new slot, +C0 = new object index, and the +88 bit set.
  - The name is appended to NTBL (u32 byte count at body+0, then NUL-terminated strings).
  - +40 equals +00 on 1,987 of 2,228 Tranquility instances; moving an object now updates both when they match.
  - +80/+90/+A0 bounds: centre = midpoint and radius = half-diagonal on every instance of every level.
  - +88 bitmask: bit (LSB first) per culled object that has an instance. It matches exactly on 7 levels; CITY
    (150 bits for instances on objects past the culled count) and AIRBASE (40 swapped) don't follow it.
  - Instance names are unique per level; TF Studio refuses duplicates.

## Editing a mesh (Blender round trip, 2026-11-09, `mods\tf_studio\js\mesh_io.js`)
- **Draw record (100 B):**
  - `+00` primitive type 6 (the engine's code for a strip), `+04` u16 prims (strip length − 2), `+06` u16 stride.
  - `+10` base vertex, `+14` vertex count, `+18` first index in IB 0, `+20` 1, `+24` VB index.
  - No bounds and no pointers.
- **Vertex layouts:**
  - Position f32 x3 at 0.
  - Normal (format bit 0x08): 4 bytes, x y z = (n + 1) × 127.5, then 0.
  - Colour BGRA, 0x7F = 1.0. UV f32 x2.
  - Faces are wound so that (b − a) × (c − a) points out.
- **Import:**
  - New vertices are appended to the draw's VB and a strip (triangles joined by degenerates, each starting on an
    even position) to IB 0. The record's prims/base/count/start are rewritten.
  - The record is kept: a copied record crashes the loader (test 4). So a mesh shared by several draws changes for
    all of them (Tranquility 2: 629 of 2,398 records are shared).
  - Each new vertex starts as a copy of the nearest old vertex, which keeps the unknown format fields.
  - BNDS (32 B, object index < culled count) and the instance bounds (+80/+90/+A0) are recomputed.
- **Checks:** an import with no edits gives identical triangles, UVs, normals and colours. pcgsc / DNO2 checkers
  report the same as stock. **In game:** lab test 6 (pending).

## Physics props: NEWPHYSOBJ.DAT (2026-11-09, `mods\tf_studio\js\props.js`)
- Props aren't in the .GSC. The game spawns them from `LEVELS\<level>\NEWPHYSOBJ.DAT`, or from `NEWPHYSOBJ_NG.DAT`
  when bit 0x200 of the flag word at 0x6FB1D0 is set (code at 0x4F4F01; also picks `PhysObjTypes_NG`). What sets
  that bit wasn't found.
- **Types:** `PHYSOBJTYPES(_NG).INI`, in file order. A type's `SpecialName` is the scene instance holding its model
  (the `PO_…` templates kept off the map) and its physics body; `SpecialName_DM1` is the broken version.
- **File layout:**
  - u32 0x06041D00, a schema of u32s (3 12 3 4 4 2 5 4 2 2 6 2 7 4 2 6 8 4 9 2 10 4 2), then the cell count.
  - Cells (18 B): f32 centre x y z, f32 radius, u16 1. The radius is always 37.5 or 56.25 on Tranquility 2.
  - The cell count again, then per cell u16 1 and u16 its number of props.
  - The prop count, then the props (12 B) grouped by cell:
    - s16 x y z: offset from the cell centre in 1/100 units. The largest offsets equal the radius, so the
      radius is a bounding sphere.
    - s16 qy, qw: the turn as a Y-axis quaternion × 32767. Most props are at 0/90/180/270°.
    - u8 type, u8 0.
  - A prop's position is its model's middle: lamp posts stand 3.1 above the ground, phone booths 1.2.
- **Checks:** all 19 files (9 levels × 2, Cybertron included) read and write back byte for byte. Re-encoding every
  prop keeps positions exact and turns within 0.002°. TestTranquility's `_NG` file doesn't parse.
- **Note:** Tranquility 2's `PO_tree1` template is drawn with a wooden-wall texture (#113) in the scene itself.

## Character spawns (scripts)
- Characters are spawned by mission scripts (`LEVELS\<level>\AI\*.SCP`):
  `CreateModule "#Creature" "#<name>" "#Spline=<spline>" "#count=N" "#maxalive=M" "#Type=<character>" …`
  (keys in either case). They spawn along the named `SPLINE.DAT` spline.
- 207 such lines across the levels. The character must be INCLUDEd by the level's `CREATURES.CFG`.
