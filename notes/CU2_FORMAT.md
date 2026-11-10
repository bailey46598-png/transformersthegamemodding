# Cutscenes (`CUT\*.CU2`), PC

How Transformers: The Game stores its 64 in-engine cutscenes, as read by TF Studio's Cutscenes tab
(`mods\tf_studio\js\cu2.js`, `cutscene_view.js`). The base layout comes from the MIT-licensed LEGO-games
notes in [Snufflebox/TTGames-Workshop](https://github.com/Snufflebox/TTGames-Workshop)
(`formats/classic-pc/tools/cu2.py`). Everything below was re-checked on all 64 Transformers files
(2026-11-08). Versions 517 and 519 have the same layout.

## What a cutscene loads: `CUT\<name>.CFG`
- `CUT cut\<name>.cc2 30.0`: the cutscene file (the game reads `<NAME>.CU2`) and its frame rate.
- `SCENE levels\<level>\<x>_main.gsc` (and `_pos`, `_buildings`): these are the console's split scenes. The PC
  build has one combined `LEVELS\<level>\<X>_PC.GSC`, and it holds the named pieces the cutscenes move.
- `CHAR chars\<x>.cfg`: the character configs.
- `INCLUDE cut\tranquility.cfg` etc.: shared level setups. `cut\general.cfg` loads particles, VFX and `cut\things.gsc`
  (not in the PC files).
- Three `.CU2` files have no config: `DECEPT2_CH2_MIDTRO2`, `DECEPT2_CH4_MIDTRO5` and `DECEPT6_CH1_MIDTRO4`. They look
  like older copies of the `DCPT…` cutscenes. TTIDENT's scene `cut\TTIdentLevel.gsc` isn't on PC.

## File
It is a memory image: pointers are absolute, and the load address is the u32 at +4 (again at +0x28).

| Offset | |
|---|---|
| 0x00 | u32 version (517 / 519) |
| 0x08 | f32 length in frames |
| 0x0C | → names (other fields give 1-based offsets into them) |
| 0x10 | → cameras |
| 0x14 | → objects (level pieces) |
| 0x18 | → characters |
| 0x1C | → effects (not read) |
| 0x5C | f32 fps: 0 in every Transformers file, so the config's 30 applies |

- **Cameras:**
  - Header: u32 count, → array of 0x50 B, → one animation block with one node per camera, → cut table, u8 start camera.
  - Each camera: a 4×4 matrix, then u8 animated, u8 id, u8 node.
  - The three floats after them are always 0, so **there is no field of view** in the file.
- **Cut table:** u16 count, u16 length, → f32 frames, → u8 camera indices (255 = none).
- **Objects (0x5C B each):**
  - Matrix, u32 name, then at +0x4C → animation block and at +0x50 → visibility table.
  - The visibility table has the cut table's layout, with values 1 = shown and 0 = hidden.
  - The names are the GSC's instance names exactly (50 of 51 in A1_CH1_INTRO), and the matrix equals the
    instance's matrix.
- **Characters (0x64 B each):** matrix, u32 name, → root block (1 node: where the character is), → skeleton block (one node
  per bone), → a third block (not read). Names are `CHARACTER` names from `CHARS\*.CFG`.

## Animation blocks
Each block is an `.AN3` clip (tag `4INA`; see the AN3 section of `GHG_FORMAT.md`) inside the file. The u16 at +14 is
the cutscene frame the block starts on.

- **Mirrored like AN3 clips:** the position is (tx, ty, −tz) and the rotation is (−rx, −ry, rz). These matched the
  stored matrices for cameras (316 animated cameras) and for character roots (114 of 121).
- **Cameras** look along their **+Z** row. In half of all shots a character is within 14° of the centre line.
- **Root blocks** have 12 channels:
  - 0–5 are position and rotation.
  - 6, 7 and 11 are bytes per frame (meaning not known).
  - 8–10 are constants (0, 1, 1).
  - Their constant pool has extra values in front: the constants the key types use are **the last ones before the
    key-type table**. With that, a constant tx/tz equals the stored matrix (80 of 82 within 0.05).
  - Camera, skeleton and object blocks don't have these extra values.
- **Skeleton blocks:**
  - The rotations are **relative to the bind pose**: bone local = R(track) · bind rotation, then the track's offset,
    which equals the bind offset.
  - Unlike normal AN3 clips, they are not absolute. A car's track rotates 7 of its 104 bones where the bind pose
    rotates 81, and read as absolute the model falls apart.
  - Bone 0 is local; the root block places the character.
  - Track and model bone counts match for 343 of 405 entries. Where they differ, the shared bones still line up by
    index (Barricade's 128-bone track drives the first 76 bones of `ROBOT_PC.GHG`; the 125-bone tracks match
    `TRANSFORMER_PC.GHG`).
- **Object blocks** (2,509 blocks, all 1 node):
  - Rotation and scale are absolute: 2,157 match the object's matrix at the block's start or are zero.
  - Translation is an offset from the matrix: 736 of 746 longer blocks start at 0.

## Assumptions in the player (not proven)
- **Field of view:** 50° vertical, adjustable.
- **When a character is on screen:** from its root block's first frame to the end of the longer of its root and
  skeleton blocks. A 1-frame track stays on screen to the end.
- **Objects with a visibility table:** before their first switch, they're in the opposite state.
- **Not shown:**
  - sound and particles
  - characters with no model in the PC files: Sam, Mikaela and TripleCCutTran
  - characters with no config: `Ident_*`, `OptimusPrimeRobot`, `MegatronRobot` and a few props
  - `things.gsc` props such as `BarricadeWheel`

## Sound
A `.CU2` has no sound of its own. The game shows its story cutscenes as Bink videos rendered from these scenes:
- Level configs list them as `LEVELFMV "D2C2Midtro2" "fmv/$LANGDcpt2_Ch2_midtro2.pss"`.
- Scripts start them with `#StartVideo=#A5C4Midtro1`.
- On PC they are `fmv\MultiLang\<name>.bik`.

`MUSIC.CFG` documents a `CUTSCENE` track type but marks it "Not Implemented YET".

**Video names:** `A5_CH3_OUTRO` → `auto5_ch3_outro`, `D5_…` / `DECEPT6_…` → `dcpt5_…` / `dcpt6_…`, `…_2` → the main
take, and `TTIDENT` → `tt_logo`. There are no videos for AUTO4 or DCPT4.

**Timing:**
- Video soundtracks run a median 0.12 s shorter than the scene, measured on 56 cutscenes with a video of their own name.
- Exceptions: `AUTO5_CH4_MIDTRO1` +0.85 s, `DCPT6_CH1_MIDTRO3` −0.69 s, and `DECEPT2_CH2_MIDTRO2` +2.38 s (an
  older edit of `DCPT2_CH2_MIDTRO2`).
- The soundtracks are 48 kHz stereo and Blender's FFmpeg (`aud.Sound`) reads them. TF Studio extracts them with
  `mods\tf_studio\tools\extract_cutscene_audio.py`.

## Cutscenes in the level folders
There are 125 more `.CU2` files: 89 in `LEVELS\<level>\CUTSCENES\` and 36 in `LEVELS\FRONTEND\CUTSCENE\`. All of them
read with the same layout, including version 516. They play in their level's scene, which the level's `LEVEL.CFG`
names (`PATH Levels/Tranquility2` + `SCENE Tranquility` → `TRANQUILITY_PC.GSC`). There are three kinds:
- **Front-end menu animations** (36): `CUBESPININ`, `3MENUOPEN`, `EARTHRISE`… They move named pieces of
  `FRONTEND_PC.GSC`, and 376 of 388 are found. (`LEVEL.CFG` lists `FrontEnd_Fre` first; that's the French scene.)
- **In-level animations:** Hoover Dam inside has doors and generators (`CUT_FAC1_DOOR_OPEN`, `CUT_GEN01_EXPLODE`…),
  and Qatar and Hoover Dam outside have similar ones.
  - None of the pieces they move (`door_011`, `gen_01`…) are in the PC scenes: there is nothing within 3 units of where
    they should be.
  - Their `CUTSCENE` lines in `HOOVERINT\LEVEL.CFG` are commented out, so they're leftovers.
- **Story stand-ins:** the `D1M…`/`D2M…`/`A2M…` mission names. Many are identical copies, with the same length,
  camera and single character (e.g. 12 `D2M…` files: 170 frames, Barricade). Tranquility 2's `A2M7`/`A2M8_TRIPLEINTRO`
  are real short scenes with Bumblebee.

None of them have a video, so they have no sound in the player.
