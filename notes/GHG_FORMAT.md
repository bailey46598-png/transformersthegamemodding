# GHG model format (Transformers: The Game PC, NU2): working notes

- **Mapped:** 2026-11-06, from `CHARS\BUMBLEBEE\ROBOT_PC.GHG` (510,276 bytes), `CAR_PC.GHG` and `GUN_PC.GHG`.
- **Status labels:** ✅ = verified (parsed, and the geometry renders correctly). ❓ = inferred.
- **Tools:** extract scripts live in the session scratchpad for now. They move to `mods\ghg_tools` once
  they're generalized.

## File layout
```
+0x00  u32  modelOffset        NU20 block starts at modelOffset + 4                      ✅
+0x04  u16  entryCount         15 robot / 10 car / 12 gun; not simply tex+buffers         ❓
       --- texture entries (repeat; header length varies by file, e.g. the gun's is longer) ---
       u32 width, u32 height, u32 mips, u32 format, u32 0, u32 size  then  size bytes of a standard .DDS   ✅
           format 12 = DXT1, 15 = DXT5. width -64 (0xFFFFFFC0) = cube map (6 faces)     ✅/❓
       --- vertex buffers ---
       u16 vbCount, then per VB:  u32 byteSize, data                                     ✅ (robot: 2, car: 1)
       --- index buffers ---
       u16 ibCount, then per IB:  u32 byteSize, u16 indices                              ✅
modelOffset+4:  "NU20" block (scene graph, materials, skeleton, draw records) to EOF     ✅
```

### Vertex formats (robot)
| VB | Stride | Count | Layout |
|---|---|---|---|
| 0 | 28 | 10,764 | `float3 pos`, `4B normal (packed)`, `4B colour (7f7f7f7f)`, `float2 uv` ✅ (rigid; each part sits in its bone's local space) |
| 1 | 36 | 880 | same as VB0, then `4B bone weights (UBYTE4N)` and `4B bone indices` ❓ (skinned) |

- The car has one VB (stride 28, 2,263 vertices) and one IB (4,221 indices). It has no skinned stream.
- **Index buffer:** `u16` triangle **strips**, with degenerate triangles joining the strips. Indices are
  relative to each draw record's base vertex ✅.

## NU20 block
- **Header:** `"NU20"`, then `i32 −blockLength` (negated; it equals the bytes left in the file ✅), then
  8 bytes.
- **Body:** a chain of chunks, each `{4cc, u32 size including the 8-byte header}`:

| Chunk | Robot size | Meaning |
|---|---|---|
| `HEAD` | 16 | header |
| `NTBL` | 736 | **name table** (`u32 len`, then NUL-separated strings): 48 skeleton bones (`BB_Robot_Root_Tracker`, `pelvis`, `waist`, `chest`, `neck`, `head`, `L/R_clavicle`, `arm`, `bicep_twist`, `elbow`, `wrist`, fingers, `forearm_plate`, `L/R_door_1/2`, `hip`, `knee`, `ankle`, `ball`) plus locators (`r_arm_weapon_attach`, `left_hand`, `poleLocator`, `newBlockLocator`, …) ✅ |
| `MS00` | 5,680 | materials (robot: 9, gun: 3) ❓ |
| `INID`, `FDNS` | 16 / 352 | ? |
| `BNDS` | 1,360 | starts with `0x80000000`, `0x2A` (= 42) ❓ bounds or bone list |
| `CDAT` | 43,152 | **Skeleton** ✅. See "Skeleton" below. |
| `DISP` | 24,848 | display data: self-relative offsets plus tables. Contains the **draw records** ✅ |
| `TREF`, `TST0` | 16 / 672 | texture references and texture set |
| `VBIB` | 32 | runtime vertex/index buffer slot (filled with `0xAB` in the file) ✅ |
| `SALI`, `DNO2`, `GSNH`, `PNTR` | 16 / 112 / 960 / 8,656 | ? `PNTR` = pointer fix-up table ❓ (pointers are file-relative and patched when loaded) |

### Draw records ✅
- **Two tables of 100-byte records** in the robot: 31 at 0x76D54 and 24 at 0x77A9C. Together they cover
  VB0's vertices 0–10,764 exactly.
- **Fields (from the start of the table):** `+0 u32 baseVertex`, `+4 u32 vertexCount`, `+8 u32 startIndex`.
  The strip runs to the next record's `startIndex`.
- **The rest of each record is not yet labelled:** material, bone or node index, and the primitive count.
- **Check:** 54 of the 55 records keep every index below their vertexCount. The last record probably
  crosses into the skinned (VB1) section.

## Skeleton (`CDAT`) ✅
**Layout:**
```
CDAT body (chunk + 8):
  N × 0x60 bone records:
     +0x00  float[2]   (0, 0)
     +0x08  float[16]  orientation matrix (rotation only; translation is 0)
     +0x48  float[3]   0
     +0x54  i32        self-relative pointer to the bone name in NTBL
     +0x58  u8         parent index (0xFF = root); parents always come before children
     +0x59  u8         flags (0x08 root, 0x21 others)
  8 bytes (zero)
  N × float[16]  LOCAL bind matrices (relative to the parent)
  N × float[16]  INVERSE BIND matrices (inverse of world)
```
- **Count:** N is found by walking records while the name pointer stays inside NTBL. No count field
  needed.
- **Matrix convention:** row-major, row vectors, translation in the last row, so
  `world = local × parentWorld` (D3D style).
- **Bone axes:** Maya-style, pointing down local +X.
- **Check:** `world × inverse_bind = identity` to within 10⁻⁶ on every bone of all four tested characters
  (Bumblebee 48 bones, Optimus 46, Megatron 45, Jazz 39).
- **Bumblebee's bind pose** is a standing figure about 5 units tall, Y-up:
  - pelvis 3.05, chest 4.17, head 5.03
  - wrists ±1.52 / 3.02, knees ±0.75 / 2.01 (bent forward), toes 0.06
  - doors behind the chest

**Tools** in `mods\ghg_tools\`:
- `ghg_skeleton.py` reads any GHG skeleton into JSON (names, parents, local, world and inverse-bind
  matrices, joint positions).
- `blender_import_skeleton.py` builds a Blender armature from that JSON, converting Y-up to Z-up.

### Locators ✅/❓
- **Where:** right after the inverse-bind array (robot: 0x721C4). It starts with a short `u8` list
  (`02 16 00 02 01 06 08 07 0b 0a 05 03 09 04`), then 0x50-byte records:
  `float[16]` offset matrix, `u32` name hash, `u32` parent bone index, 8 bytes padding.
- **Seen in Bumblebee:** bone 0x13 (`L_object`), 0x09 (`L_elbow`) and 0x22 (`R_object`). These are the
  attachment points (`left_hand`, `r_arm_weapon_attach`, …).

### Ruled out while tracing the 42-entry tables
- **Draw-record fields:** the 8 palette slots are all `-1` on rigid parts. The rest of the record holds
  no bone index. The steadily rising byte at +1 is just the high byte of `baseVertex`.
- **`BNDS`:** 42 × 32-byte entries, all empty bounds (zeros, then 1.0). It's a runtime buffer.
- **Geometric fit:** trying all 48 bones per part isn't decisive (best and second scores are within
  about 10%). It does confirm the parts are in bone-local space: mirrored parts (409/409, 50/50, 72/72,
  finger segments) consistently pick mirror-image bones.

### `DISP` object tree (partly read)
- **Header ints:** `2776, 164, 144, −16492 (self-relative), 42, 2772, 3272, 3352, 3432, 3660, …`.
  The values after the 42 are offsets from DISP+8 to sub-tables.
- **Sub-tables:**

  | Offset (from DISP+8) | Contents |
  |---|---|
  | +2772 | the string `ROBOT_PC.GHG` |
  | +3272 | `{1, 644, 408}`-style triples |
  | +3352 | `u16` pairs (`1,1 / 1,2 …`) |
  | +3432 | sequential `u16` lists (`0x25, 0x26, …`) |
  | +3660 | descending `u32` (70, 66, 64, …) |

- **Most likely meaning:** a tree of geometry objects, each holding draw-record lists and a node/bone
  reference. Not decoded yet.

## Solved 2026-11-06: pointers, the part → bone link, materials (from G1 Megatron)
### Pointers ✅
- **Every pointer in NU20 is self-relative:** target = its own address + the stored `i32`. A stored 0 means
  null.
- **`PNTR` lists them:** `i32 count`, then `count` self-relative offsets to each pointer field.
- **What this means for writing:** the NU20 block can stay byte-identical while the buffers before it change
  size.
- **No buffer sizes or counts are stored in NU20.** The vertex and index buffers are found only by walking
  the file header.
- **Chunk tags never appear in the exe.** The loader treats NU20 as a memory image and follows pointers.
- `DISP` sits inside `CDAT`.

### File padding ✅
- **Rule:** `modelOffset` is the first offset after the index buffer that ends in `0xC0` (mod 0x100). The 4
  bytes there are zero, then `NU20` follows.
- **Checked:** this holds for every model checked.
- `ghg_lib.GHG.build()` reproduces **112 of the game's 174 GHGs byte for byte**, including all the robot
  models. The rest (gun, weapon and transformer models) have a different texture or animation header and
  aren't parsed yet.

### Texture slots ✅
- **The `u16` after `modelOffset` is the number of `TST0` slots** (11 for G1 Megatron, 15 for Bumblebee).
- **Some slots are empty:** only the filled ones have a DDS entry in the file.
- **`TST0`:** 0x28-byte records, with `i32 width, height` at record + 0x34. The rest is runtime data.

### Scene chain: bone → geometry ✅
| Step | Where | Layout |
|---|---|---|
| Skeleton header | `GSNH` (+0x170 in G1 Megatron) | `i32 nBones`, then pointers to bone records (CDAT+0x10), local matrices, inverse binds, …. At +0x2C a pointer to a struct whose +4 is the **bone list** |
| Bone list | CDAT | `nBones` pointers, **null when the bone has no geometry**, else → a 12-byte ref `{→GSNH+8, null, →instance}` |
| Instance | CDAT, 0xD0 bytes | two matrices (identity), `+0x80` bbox min, `+0x90` bbox max, `+0xA0` sphere (centre, radius), all bone-local. `+0xB0` → object, `+0xB4` → name, `+0xB8` = 6, `+0xBC` → runtime slot, `+0xC0` = instance index |
| Object | DISP, 12 bytes | `i32 count`, → `i32 material[count]`, → `i32 command[count]` |
| Command list | DISP+0x10 → 16-byte entries `{i32 type, → data, 0, 0}` | Types seen: 389, 135, 896 (→ material), 395, 1156, 131 (→ matrix), **130 (→ draw record)**, 142 (end) |
| Draw record | 0x64 bytes | `+0 u32 6`, `+4 u16 primitiveCount` (= strip indices − 2), `+6 u16 stride` (28), `+8` 8 × 0xFF, **`+0x10 baseVertex`, `+0x14 vertexCount`, `+0x18 startIndex`**, `+0x20 1`, then 8 × −1 bone palette (rigid) |

- **`GSNH`+0x280** also lists every draw record: count, then a pointer list.
- **Material per part:** the object's `material[k]` is the index into `MS00`. It's confirmed: Bumblebee uses
  0, 1, 4, 5 and 8 of his 9 materials. A material's texture is an `i32` index into `TST0` (G1 Megatron:
  material 0 → slot 0, material 1 → slot 9).
- **Rigid vertices are in their bone's bind space:** `world = v × boneWorld`.
- **G1 Megatron check:** posing every part with its bone gives bounds (−4.87…3.35, 0…9.97, −1.49…1.33),
  which exactly match the bounds stored in `GSNH` (skeleton header + 0x44 min, + 0x50 max).

### Vertex format (rigid, stride 28) ✅
- `float3 position`
- normal as `u8 x, y, z, 0`, decoded as `(b − 128) / 127`
- `u8×4` colour, `7F7F7F7F` = neutral
- `float2 uv`

**Strip winding:** for triangle *j*, swap the first two indices when *j* is odd. Then
`cross(b − a, c − a)` points along the normal.

### Animations (`.AN3`, tag `4INA`): decoded 2026-11-08 ✅
Reader: `mods\tf_studio\js\an3.js`. The curve decoding follows the MIT reader in github.com/Snufflebox/TTGames-Workshop
(`formats/classic-pc/tools/cu2.py`). 2,022 of the 2,029 clips decode cleanly; the 7 Jazz `*_ARM.AN3` use another layout.
- **Header:** `@4 u16 bones, u16 samples, u16 groupBytes (= 4 × animated curves), u16 sourceFrames, u16 channels (9), u16 start`.
  `@28 f32 constBase (−π)`, `f32 constScale (π/32768)`. Then `@36 →params`, `@40 →constant pool`, `@44 →key types`,
  `@48 →keys`, `@52 →keys end`. The clip name is at `@60`.
- **Key types:** `u16 × 9 per bone`, in the order `tx ty tz rx ry rz sx sy sz`.
  - `≥16`: a constant, `constBase + pool[k−16] × constScale` (the pool is u16).
  - `6`: an animated curve.
- **Curve params:** `{f32 scale, f32 low}` per animated curve, in key-type order.
- **Keys:** `u32[segment × curves + curve]`. A segment covers 4 samples.
  - Bits 0–7 are the anchor.
  - Bits `8+6k`…`13+6k` are the 6-bit blend for sample k.
  - Value = `low + scale × (a0 + (a1 − a0) × blend/63)`, where a1 is the next segment's anchor.
- **Timing:** the `samples` are spread over `sourceFrames`, which play at the config's `RATE` (30 fps). Example:
  IDLE has 24 samples over 120 frames = 4 s.
- **Clips are mirrored in Z relative to the model.** Before use, negate `tz`, `rx` and `ry`. Then the rotations
  are radians in D3D order (X, then Y, then Z, row vectors): the row-form local 3×3 is `(Rz·Ry·Rx)ᵀ` in
  column-vector terms, built from `(−rx, −ry, rz)`.
  - **Translations:** after the flip, `(tx, ty, −tz)` equals the bind skeleton's offsets. Before the flip, every
    bone offset along Z mismatched: 42 of Barricade's 76 bones and 13 of Bumblebee's 48.
  - **Checked:** with this, planted feet in idle clips drift about 0.001–0.003 units on Bumblebee, Barricade,
    Megatron, Optimus and Ironhide.
  - **Why the first version looked fine:** Bumblebee's limbs mostly lie along X and Y, so the missing flip hid
    on him and showed on Barricade (arms, hood and doors offset in Z).
- **`RATE 0.000001`** in a config (e.g. Barricade's `strafe_idle`) means "hold this pose", not a real speed.

### Animations: earlier partial notes (kept for history) ❓
- **Header:** `u16 bones`, `u16 frames`, …, `u32 9` (channels per bone), then offsets to tables.
- **Channels:** each bone has 9 `u16` curve indices (3 + 3 + 3). The shared constant curves look like zero
  and one.
- **The clips carry bone offsets too** ✅. G1 Megatron's bone-offset values appear in its AN3 files about
  2.5 times more often than random values would (430 matches against 175). In game, a model whose bind
  skeleton was changed came apart, because the joints went back to the clip's offsets.
- **So a mesh swap must keep the target's skeleton** and fit the new parts onto its joints. (The earlier
  "rotation-only" guess was wrong.)

### Formerly open: which bone each rigid part follows (solved above)
- **Not in the draw records.** No byte in the 100-byte record places the posed parts on the skeleton better
  than putting every part on the pelvis (mean distance 0.19 vs 0.12).
- **Rigid vertices are stored relative to some node.** Their raw bounds are about ±1.5 by ±0.8 by ±1.0,
  but the body is about 5 tall.
- **Candidates for the link:**
  - `BNDS`: 42 entries of 32 bytes (1,360 = 16 + 42 × 32)
  - the 42-entry pointer table at the start of `DISP`
  - the scene-node chunks `GSNH` / `DNO2` / `INID`
- **Why 42:** 42 recurs, so there are probably 42 geometry nodes, each with its own bone and matrix,
  and the draw records hang off them.

## Verified output
- **Export:** `ghg2obj.py` writes VB0 + IB + draw records to an OBJ. That gives **8,381 triangles** with
  UVs, 55 parts and bounds of about ±1.47 × ±0.82 × ±0.97.
- **Blender render:** recognisable parts (wheels, finger joints, chest plates, pistons, door wings), with
  clean faces and UVs.
- **Not posed yet:** the parts overlap at the origin because they're in bone-local space.

## Next steps
1. ~~Decode the `CDAT` skeleton~~ ✅ Done.
2. ~~Find the part → bone link~~ ✅ Done. See "Scene chain" above.
3. **Decode VB1 skinning:** weights, indices, and the palette mapping to bones. Needed for skinned
   characters like Bumblebee; G1 Megatron is fully rigid.
4. ~~Generalize the parser~~ ✅ `mods\ghg_tools\ghg_lib.py` (pointer-driven).
5. ~~Round-trip writer~~ ✅ It's byte-identical on 112 models. First mesh swap:
   `mods\ArmadaMegatron`. **It still needs an in-game test.**
6. Parse the 62 remaining models (guns, weapons, transformer sequences): a different texture or animation
   header.
7. Add new instances (more parts than the target has bones with geometry). That means editing pointer
   tables and `PNTR`.

## Added 2026-11-07 (from Blackout)
### Empty texture entries ✅
- Gun, weapon and transformer models have texture entries with `size 0`: just `w, h, mips 0, fmt 0, 0, 0`,
  with no DDS.
- `ghg_lib` reads them, and 168 of 174 GHGs now round-trip.

### TST0 layout ✅
- **Header:** `i32[slotCount]` runtime fill (`0xABABABAB`), then `slotCount` × 0x28-byte records.
- **Each record:** `i32 w, h`, then a **128-bit hash** of the texture, then `i32 borrowed` (−1 = this slot
  borrows a texture from a model it `DEPENDS` on), then 12 bytes of zeros.
- **Empty slots** have w = h = 0 and no entry in the file.
- **Borrowed slots** carry the parent's hash and size, and an empty texture entry.
- **Shared hashes:** textures shared by unrelated models have the same hash (the cube map, for example).

### Material → texture ✅
- **MS00 layout:** `i32 count`, then `count` × 628-byte records starting at MS00 + 12.
- **Fields in each record:**
  - **+120:** the main texture. The low 16 bits are the slot, plus flags in the high bits.
  - **+124:** the constant 65446.
  - **+256:** the second texture (the reflection mask), or −1.
- **Flag `0x4000`:** the texture is in the parent models. The slots count across the parents in `DEPENDS`
  order. Example: `BlackoutTran` → robot slots 0–13, then heli slots 14–27, so `0x400E` = heli slot 0.

### Blackout's models
| File | Bones | What |
|---|---|---|
| `ROBOT_PC.GHG` | 48 | Rigid. No left forearm geometry: `GUN_PC.GHG` is attached there |
| `GUN_PC.GHG` | 10 | The root bone's local rotation equals the robot's `left_forearm` world rotation, origin at that joint. Gun-file world = robot bind world − forearm joint |
| `CAR_PC.GHG` | 5 | `whirlybird` (body), `rotorhinge`, `rotors` (spins about its local X; the blur disc), `rear_rotorspin` |
| `TRANSFORMER_PC.GHG` | 127 | Rigid. The robot skeleton (68 bones, plus plate, strut and wheel bones) and 59 heli-panel bones under `whirlybird`, all overlapping in bind pose |

## Added 2026-11-07: layers, skinning, full export
- **Layers:** skeleton header `+0x28` = layer count, `+0x2C` → table of 20-byte records
  `{→name, →rigid bone list or null, →skin ref or null, ?, 0}`. Names: `defaultLayer`, `TT1_left_arm`,
  `TT2_right_arm`, `TT3_left_door`, … The old reader only used layer 0, so arms/hands/doors were missing.
- **Skin ref** = the same 12-byte ref as a bone-list entry (→ instance → object → draw records).
- **Draw record +0x08 = u8 bone palette[8]** (0xFF = unused; all 0xFF = rigid). `+0x1C` IB index, `+0x24` VB index.
  Stride 36 is not always skinned: rigid parts can use a 36-byte VB too.
- **Skinned vertex (stride 36):** pos, normal, colour, uv, then `u8 weight[3]` (sum 255) + pad, `u8 paletteIndex[3]` + pad.
  Skinned vertices are in model (bind) space.
- **Cube-map texture entries** can have any negative width (−64, −256).
- **Tools:** `ghg_scene.py` (full reader), `dds.py` (DXT1/3/5 decode), `ghg_catalog.py` (sorting),
  `ghg_export.py` (Blender: rigged textured GLB + preview per model). All 174 GHGs export.

## PS3 GHG (next-gen), mapped 2026-11-07 from PS3 Bumblebee
Reader: `mods\ghg_tools\ps3_ghg.py`. Everything is **big-endian**, and the NU20 block is **version 0**.
- **Container:** `u32` (NU20 offset − 0x58), `u32 texCount`, then `texCount × {u32 offset, u32 size}`. The buffer
  area starts at **0x58**, and every buffer offset (texture table and draw records) is relative to 0x58.
- **NU20:** the tag is stored reversed (`02UN`). Chunks are 16-aligned with junk padding, so find them by tag.
  The structures match PC: CDAT bone records (0x60), GSNH skeleton header, layers, bone list → ref → 0xD0
  instance → object. Pointers are self-relative.
- **Commands:** 8-byte entries `{u8 op, u8 sub, u16 0, i32 ptr}` (like the Wii). 0x82 = draw, 0x380 = material.
- **Draw record (0xA0):** `u8 0, u8 attrMask, u8 nAttr, u8 2`, then `nAttr × {u8 count, u8 type, u8 stride, 0,
  u32 offset}`. `+0x84` vertex count, `+0x88` IB offset, `+0x8C` index count.
  - Indices: `u16` triangle **lists**, absolute into the shared vertex pool.
  - Attribute types: 3 = half float, 4 = u8.
  - Attribute order: position half3 (own stream, stride 6), normal u8×4 (`(b−128)/127`), colour u8×4,
    [tangent u8×4], uv half2 (V as on PC, top-down).
  - Rigid parts are in bone space. The winding is the same as PC even triangles.
- **TST0:** 0x44-byte slot records from +8: `w, h`, `+0x1C` mips, `+0x20` GCM format (0x86 DXT1, 0x88 DXT5),
  `+0x30` = `0x80000000 | texture index`.
- **MS00:** variable-size records (they hold RSX shader code). `+0x25C` diffuse slot, `+0x2A0` specular,
  `+0x2A4` normal map, `+0x2A8` cube map, `+0x26C` colour.
