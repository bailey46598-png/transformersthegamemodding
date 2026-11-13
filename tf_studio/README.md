# TF Studio

A model/animation viewer, level/map editor and 3D texture editor for Transformers: The Game (PC). It reads the game's own
files straight from this game folder. No export step.

## Start it
Double-click **`TF Studio.bat`**. It finds Python (a normal install, or the one inside Blender), starts a small
local server on `http://127.0.0.1:8765/` and opens your browser. Close the black window to stop it.

Manual start: `python serve.py "<game folder>" 8765`

Needs a Chrome/Edge/Firefox with internet the first time (three.js loads from jsDelivr).

## Models & animations tab
- **Characters (from configs):** every `CHARACTER` in `CHARS\*.CFG`. Opening one loads its model, its
  `DEPENDS` parents (for borrowed textures) and every `ANIMENTRY` from its anim configs (INCLUDEs followed),
  listed under their in-game names and groups.
- **All model files:** any `.GHG`; the clip list is every `.AN3` in the same folder.
- Clips whose bone count differs from the model are dimmed and flagged (the game matches bones by index).
- A model opens playing its rest clip: `idle`, else `driveidle`, else `caridle` (cars). The Cameras tab and the
  level spawn markers use that clip's first frame too. Some bind poses are rotated: the pickup truck drone's car
  model lies on its side until `driveidle` turns its body bone upright.
- Playback uses the config's `RATE` (negative = reversed) at the clip's original frame count. Space = play/pause,
  ← → = step a frame.
- **Export .glb** (toolbar) downloads the model for Blender: skeleton, skinned mesh, textures, and the current
  clip (tick **all clips** for every clip that fits the skeleton; Bumblebee: 48 bones, 92 actions, 28 MB).
  In Blender: set the scene to 30 fps **before** File › Import › glTF (the importer turns seconds into frames at the
  scene's rate).
- **Game layer mask** shows only the layers `ACTIVELAYERSMASKON` turns on for that clip (arm/door variants).
- **In place** pins the root tracker to the origin. **Bone names** labels every joint; click one to inspect
  its parent, children, world position and this frame's channel values (keyframed channels highlighted).

## Levels & maps tab
Pick a level folder and its `.GSC`, then **Load level**. You see the textured scene plus:
- `PLACEMENTS.INI` markers (blue). They're drawn at `Pos ÷ Scale`, which lines them up with the splines and triggers.
- `TRIGGERS.INI` boxes (red). Drawn at full `BoxSize`. `Rotation` is assumed to be 65536 units per turn.
- `SPLINE.DAT` paths (green).

Getting around (press **?** in the view for the full list):
- **Wheel** zooms toward whatever is under the cursor, all the way down to street level.
- **W A S D** fly, **Q / E** go down / up, and **Shift** gives 4× speed.
- **Right-drag** looks around from where you stand. **Left-drag** orbits and **middle-drag** pans.
- **Double-click** flies to a spot.
- **Minimap** (bottom right): click or drag to jump there, wheel to zoom it, double-click to make it follow you.
- **Home (H)**, **Top (T)** and **Focus (F)** move the camera smoothly.
- **Ctrl+1…9** saves a camera view for this level and **1…9** returns to it.
- **Go to** takes `x z`, `x y z` (game coordinates) or part of a marker name.
- **Fly speed** follows your zoom distance ("Auto"). `[` `]` or Alt+wheel set it yourself.

Editing:
- **Click** a surface, marker or list item to select it. **G** = move gizmo, **R** = rotate around Y, **F** = focus,
  **Esc** = deselect.
- **Placements and triggers:** every field can be edited in the panel. You can add, duplicate and delete them.
- **Splines:** rename them, drag points, insert or delete points.
- **Level geometry:** move, rotate or hide a scene object. Every draw in the shipped levels has its own
  placement matrix, so this edits just that copy's matrix. **Reset to original** puts it back.
- **Collision:** tick **Collision** in the toolbar to see the level's collision.
  - World collision is coloured by surface type, physics bodies are blue, and posts are yellow.
  - Select an object to see its own collision as orange lines, drawn where it will be after saving. The panel
    lists how many collision polygons and physics bodies belong to it.
  - With **Collision follows edits** on (in the Save box), saving moves an edited object's collision with it,
    removes a hidden object's collision, and updates the object's scene-instance matrix. A hidden object's
    physics body is dropped 1000 units below the level.
  - Each save rebuilds the collision from the copy loaded at the start of the session, so **Reset** puts the
    collision back too.
  - **Caveat:** "Belongs to" is a match by shape. The collision polygons must lie within 0.35 units of the
    object's surface, or within 2 units and inside its box (not counting flat ground at its base). Check the
    orange outline before saving.
- **New objects:** select a scene object and click **Duplicate**.
  - A copy appears beside it. Move it with **G** and turn it with **R**. **Duplicate again** and
    **Remove copy** are in its panel.
  - On save, each copy is written into the `.GSC` as a new scene object. It reuses the source's mesh and
    textures, and gets a copy of the source's collision when "Collision follows edits" is on.
  - The level then reloads, because object and draw numbers change.
  - **Name:** a copy can have its own scene instance, so scripts and props can find it by name.
    - When the source has a name, the copy gets a unique one like `<source>_copy1`, which you can edit.
    - An empty name means plain scenery.
    - Names must be unique in the level, with no spaces. The object panel shows each object's existing name.
  - Physics bodies (props that fall over or break) are not copied.
- **Textures:** select a surface; the panel lists its textures. **Export** downloads one as `.dds`. **Replace…**
  loads a DXT1 or DXT5 `.dds` of any power-of-two size (up to 4096). The file is rebuilt, so the new texture
  can be bigger or smaller than the old one. A texture can be shared by several materials; all of them change.
- **Meshes in Blender:** select a scene object, then **Export .glb** in its panel.
  - Blender gets one object per draw, named `draw_<id>`, with its textures, in the object's own space.
  - Edit it, export as `.glb`, and use **Import .glb…** to bring the new shape back into the level.
  - Keep the `draw_…` names. A new piece (another Blender object) joins the part whose material has the same
    `tex…` name.
  - The new vertices and triangles are added to the file; the object's bounds follow.
  - A model placed several times shares one mesh, so the panel warns when an import changes other objects too.
  - Collision isn't changed by an import.
- **Props** (toolbar):
  - Every physics prop the game spawns from `NEWPHYSOBJ.DAT` (lamp posts, trees, bins, signs, cars…) is drawn with
    its type's model.
  - Click one to move it (G), turn it (R), retype it, duplicate it or delete it. **Add prop** puts one on the ground
    where the camera looks.
  - The game reads `NEWPHYSOBJ_NG.DAT` instead in one of its detail modes; the toolbar chooses which file you edit.
  - The stored type is a game-wide id: the `PHYSOBJTYPES.INI` index plus a per-level **type base** (Airbase 861,
    proven in game; other levels guess the lowest id in their two files). If a level's props show the wrong models,
    change **Type base** in a prop's panel; it's remembered per level and doesn't change the file.
  - A prop's turn is stored as four signed bytes (a quaternion × 127). Fixed 2026-11-11: before, a turned prop was
    written as two 16-bit numbers and stood on end in game.
- **Script cutscenes** (right panel): the in-game camera moves the level's scripts play with `#SplineCamera`.
  - Every `CreateModule "#SplineCamera" … "#SetPosition=<spline>" "#SetFocus=<spline>" "#SetTime=<s>"` line is a
    shot. Shots that lead into one another through the script's states (`… GetPercentageComplete == 1.0 goto …`)
    form a sequence.
  - **Play** or scrub a sequence, looking through the shot camera. The actors are the `#Creature` lines (with
    `#FollowSpline`) and `#Goto` lines (`#SpawnSpline`, `#DirectSpline`, `#Speed`) of the state that starts the
    sequence: they spawn there and drive the route at their `#Speed` (or **Actor speed**), from rest at
    **Acceleration**. Its timer (`if timer > 0.6 goto …`) is the lead-in.
  - **Measured with a recording (Airbase, 2026-11-11):** the game's cutscene cameras are **43° tall at 4:3, stretched** to
    the screen, and move along **straight** lines between spline points (camera error 0.2 units). These are the
    defaults (Field of view, Aspect, Paths). Each shot camera also runs over 97 % of its SetTime (3.0 → 2.91 s,
    4.2 → 4.08 s; camera error then 0.03 units), applied as `camScale`. The earlier by-eye calibration (field of view **50°** and smooth paths by arc length) put
    the checkpoint and the AI car where the recordings show them. The crash shot matched closely; the wide shot was
    within a few degrees. Acceleration ~12 units/s² was measured from the AI Bumblebee (tests 2-3); `#Goto`'s `#Speed` is mph (×0.447 = units/s; Airbase test 4).
  - **Edit:** **Free view**, fly to a framing, then **Set key from view** (or **Insert key**) changes the shot's camera
    point and focus point under the playhead. Shot times are edited in the table. Splines save with `SPLINE.DAT`,
    times into the script line.
  - Gaps the preview doesn't show: in the game, removing a camera module before making the next shows the gameplay
    camera for ~0.1 s; actor AI (braking, turning, physics with props) isn't simulated.
- **Game recordings** (right panel, under Script cutscenes): what the game really did, recorded with the
  DebugTrainer's cutscene recorder (0.4: F9, or "Record every level start") into `<game>\CutsceneRecordings\*.tsv`.
  - Pick a recording (or **Open…** one from anywhere). It's lined up with the selected camera sequence: each shot
    starts where the game camera reaches that shot's first camera point (refined to the millisecond), so the panel
    shows each shot's real start and length, the lead-in, and frames of gameplay camera between shots.
  - **Camera off by … / aim …°**: the preview camera against the game's, frame by frame, per shot. Near 0 means the
    preview's paths, timing and interpolation match the game.
  - Actors are matched to recorded characters (same type, nearest the spawn). **Fit actors to recording** fits each
    one's start delay, acceleration and top speed to its track (kept per level and sequence); **Recorded actor
    motion** plays the tracks themselves, so shots can be framed around the real motion.
  - **Game camera** looks through the recorded camera (with the game's field of view when its projection is set).
    Paths: game camera orange, characters cyan (player blue); ghosts mark every recorded character at the playhead.
  - Checked with a synthetic recording (known start 7.3 s, 1 gameplay-camera frame, actors 0.4 s / 20 u/s² / 25 u/s):
    found 7.300 s, 1 frame, camera error 0.01, fit 0.42 s / 20.7 / 25. Real recordings not tried yet.
  - A shot left before its camera completes (`… GetPercentageComplete" > 0.97 goto …`) ends there in the preview,
    and one left when an actor finishes its route (`… "GCBee Complete" == 1.0 goto …`) ends when that actor's
    preview motion reaches the end of its first route (less `#Range`). Routes sent to an actor by a shot
    (`SendToModule "#GCBee" "#DirectSpline=…"`) continue its path.
  - Field of view and aspect come from each recorded frame's projection; looking through the game camera draws its
    aspect stretched to the view, like the game. A recording that isn't lined up plays from its own start.
- **Spawns** (toolbar): the characters the mission scripts spawn (`AI\*.SCP`, `CreateModule "#Creature" …`).
  - Each is shown with its character model at the start of its spawn spline.
  - The panel changes the character, count, how many can be alive at once and the spline. It can also switch the
    line on or off and duplicate it.
  - **Move it** selects the spline, whose points you can drag.
  - Saving rewrites only the changed lines of the script.
- **Save changes** writes every modified file. The first save of a file keeps the original next to it as
  `<name>.studio.bak`.

## Cutscenes tab
Plays the 64 in-engine cutscenes in `CUT\` with their level, characters, cameras and moving level pieces. Pick one
on the left (grouped by level).

**Normal / High detail** (top left, remembered). High detail plays the cutscene as High Detail does:
- the level = the split scenes the cutscene's config lists (`levels\x\tranquility_main.gsc`, `_buildings`, `_pos`,
  `_vehicles`; NODRAW/NORENDER skipped) as `<NAME>_PC.GSC` from the hi-res set (then the game folder), in the
  level's LEVEL.CFG PATH folder; none found → the LEVEL.CFG NEXTGEN list; still none → the Normal scene (noted).
  All are drawn together with the Levels tab's builder (layered terrain, blending); set pieces are found in any of them.
- characters = the hi-res model and DEPENDS parents where the set has them (tagged HI-RES); if a hi-res model's
  skeleton doesn't fit the track, the normal model is used (noted). Animations always come from the game folder.
- Export .glb takes set pieces and nearby level from every scene (blended layer passes left out).
- Fixed 2026-11-12: hi-res City's skyscrapers were scrambled because five hi-res scenes have two index buffers and
  the draw record's `+0x1C` (which one) was ignored. Readers now use it; the mesh importer and region cut write new
  strips into buffer 0 and set `+0x1C` to 0. (`wii_tools/pcgsc_check.py` and `extra_props.py` still assume one
  buffer; fine for Normal and ported scenes.)

Below them are the 125 cutscenes kept in the level folders (`… · level folder`). They play in that level's scene:
- front-end menu animations
- Hoover Dam's door and generator animations, which are unused (their pieces aren't in the PC scenes)
- short story stand-ins
- **Cutscene camera** (C) looks through the cutscene's own cameras, cutting between shots. Turn it off to fly around
  freely (same controls as the level tab), with the camera paths drawn in blue.
- **Timeline:**
  - Space plays and pauses, `,` and `.` step a frame, PgUp/PgDn jump between shots, and Home goes back to the start.
  - Blue ticks on the timeline mark the cuts.
  - Click a shot or a character in the right panel to jump there.
- **Export .glb** downloads the cutscene for Blender:
  - every character with its animation, hidden outside its frames;
  - one `CutsceneCamera` that follows the cuts;
  - the moving set pieces;
  - the level within the chosen radius.

  **Sound** saves the soundtrack (.ogg) for Blender's video editor. Set Blender to 30 fps before importing. The
  file's frame 0 is the cutscene's frame 0; set the end frame to the cutscene's length.
- **Letterbox**, the **FOV** slider and **Screenshot** are in the toolbar.
- The right panel lists the shots and each character's frames and model, and notes anything that isn't shown.
- **Sound:**
  - The game plays its story cutscenes as Bink videos rendered from these scenes (`fmv\MultiLang\*.bik`), so the
    voices, music and effects only exist inside those videos.
  - **`Extract cutscene audio.bat`** pulls each video's soundtrack into `cutscene_audio\` as `.ogg`, using Blender's
    built-in FFmpeg. Drag the game's `fmv\MultiLang` folder onto it. This is already done here: 52 tracks, 22 MB.
  - The player then plays the soundtrack in step with the timeline. **Sound** and the volume slider are next to Loop.
  - 60 of the 64 cutscenes have sound. The four AUTO4 and DCPT4 ones have none, because the game has no videos for
    them. The `…_2` alternate takes share their main take's sound, and TTIDENT uses `tt_logo.bik`.
  - The videos run about 0.1 s shorter than the scenes. Three cutscenes differ by 0.7 to 2.4 s (different edits);
    the right panel warns about those.
- **Not shown:** particles and lights. The field of view isn't stored in the files, so the 50° start value is a guess.
  Characters whose model isn't in the PC files (Sam, Mikaela) are left out.

Format notes: `CU2_FORMAT.md` in the game folder.

## Cameras tab
For tuning the player's vehicle cameras with `mods\CharacterCams` (guide: `CHARACTER_CAMERAS.md`). Run TF Studio on
the folder the game runs from (the lab: `serve.py "../../../Lab - VehicleJump" 8766`) so it sees the game's
`CharacterCams.ini`, F8 dumps and `CharacterCams_presets.bin`.
- **Pick a character:** its vehicle model (turned so +z is the visual front), the chase camera placed from the preset
  values (orange), the R camera (purple), the aim point (yellow), the camera's collision ray, and a ring at
  `IgnoreRayHitsUnder`. Insets show what both cameras see; **Game camera** looks through one.
- **Estimate only:** the exact chase-camera math isn't decoded, and the ray is tested against the drawn model, not
  the game's collision shape. Use it to compare settings and spot obvious problems, then check in game.
- **Speed factor:** the max distance blends from near to far; how that factor follows speed isn't measured.
- **F8 dumps** (list on the left, or **Open dump…**): live vs base distance (live below base = something pulls the
  camera in), pitch, heights, recorded aim point (white) and chase rig (blue).
- **Preset values** come from `CharacterCams_presets.bin` (F8 writes it, CharacterCams 0.9+). Without it only Truck,
  Optimus, Bumblebee and Blackout's flight preset are known (partly guessed).
- **INI editor:** the character's section. **Save to INI** rewrites only its keys (the first save keeps
  `CharacterCams.ini.studio.bak`). Then press **F7** in game.
- Lists every identity (1–31: characters, TripleC and his turret, the Energon drone, every drone and its `_a`) plus
  the G1 skins. A drone `_a` edits the plain drone's section unless it has its own.
- Scorponok and Frenzy have no vehicle model in the PC files; their numbers still show.

## Hi-res (High Detail) assets
The server finds the High Detail set (`Hi-res assets`: 150 character `.GHG`s and 38 level `.GSC`s, same PC format)
next to the game and serves it as the folder `HIRES/`. Pass a third argument to `serve.py` to point elsewhere.
- **Models** and **Textures** tabs: the **Normal detail / High detail** switch opens a character's hi-res model and
  hi-res DEPENDS parents when the set has them (others open normally). Animations always come from the game folder.
  "All model files" lists the hi-res files under `HIRES/...` in High detail.
- **Levels** tab: a level's hi-res scenes are listed under "Hi-res set" in the scene picker (bigger textures and the
  NEXTGEN split scenes, e.g. `HOOVERINT_VEHICLES_PC.GSC`). Saving writes back into the hi-res folder (with a backup).
- **Levels tab, "All N NEXTGEN scenes together"** (first in the picker): loads the level the way the game does in
  High Detail, i.e. every `SCENE` of LEVEL.CFG's `PLATFORM NEXTGEN` block (`<PATH>/<name>_PC.GSC`, hi-res set first,
  then the game folder; `DEFAULTSCENE` if none exist) drawn together in one world (`js/level_scenes.js`). One scene is
  edited at a time (Main to start); the info panel lists the scenes with show/hide boxes and Edit buttons. Clicking a
  surface of another scene shows what it is, with "Edit <scene>" to switch (view and selection kept). Collision overlays
  and prop models (often in `_POs`) come from all of them. Note the Buildings scene also holds building templates and
  LOD models parked off-map (around z −2530, 100 below ground), the same as in the CURRGEN scene.
- **How level surfaces are drawn (2026-11-12):**
  - DDS mipmaps: the game's DDS headers never set `DDSD_MIPMAPCOUNT`, so three.js used to load only the top level
    (tiled ground aliased into rings). `ddsTexture` sets the flag on a copy.
  - Vertex formats: bits `0x200` and `0x400` share one dword (e.g. `0x1F29` is 52 bytes, not 56); `0x80` = 4 bytes,
    `0x2000` = 32, `0x4000000` = 8. Before this, those formats fell back to a stride guess with wrong colour and UV
    offsets (striped roads). `0x400` alone = terrain layer weights (BGRA: R = layer 1, G = layer 2, B = layer 3).
  - Ground is stored twice per object: multi-pass (a vertex copy per layer; vertex alpha = layer weight, 0x7F = 1)
    and single-pass (a material with extra layers at `+0xBC…` and per-vertex weights). TF Studio draws the
    single-pass one with a layer shader and skips the multi-pass copies it replaces; other draws with vertex alpha
    below 1 are blended. DXT3/DXT5 textures are blended by their alpha (roads are a DXT5 dirt layer over the
    ground); DXT1 alpha stays a cut-out.
  - Open: the exact blend of the road tyre-track layer (tex `204` in Tranquility, white streaks on black at full
    weight) is a guess (plain mix); the game's terrain shader is compiled into the exe.
- Hi-res vertices carry a tangent (vertex-format bit `0x20`, strides 32 and 40): normal +12, tangent +16,
  colour +20, UV +24, weights/indices +32/+36. Hi-res UV V runs −1…0 and wraps.
- Level material texture ids are **TST0 slot numbers**; empty slots have no texture entry, so ids past one are
  shifted. The reader now maps slots to textures (this also fixes Airbase's 5-slot shift). A scene whose slot
  table doesn't line up (the ported `HOOVEREXT_PC.GSC`) is read the old way.

## Textures tab (3D texture editor)
Paint a model's textures on the model itself or on the flat texture, then save them back into the `.GHG`.
- Pick a character or `.GHG` (and Normal/High detail). The model opens in its rest pose with live textures; the
  right-hand pane shows the selected texture with its UV layout.
- **3D view:** left-drag paints, right-drag orbits, middle-drag pans, Alt+left orbits too. Clicking a part selects
  its texture. **2D view:** left = tool, middle/right-drag pans, wheel zooms.
- **Tools:** Brush (flat colour), Recolour (the colour's hue painted over the texture's own shading and detail),
  Restore (paints the file's original back), Fill (connected area within a tolerance; "Keep shading" recolours),
  Pick. Size (texels), opacity, hardness. **Mirror L/R** paints both sides of the model (M).
- The 3D brush is a ball on the surface: every texel whose point on the model is inside the ball is painted, so a
  stroke crosses UV seams and never leaks into unrelated parts of the sheet. Surfaces facing away from the one
  under the cursor are skipped. Colour doesn't build up within one stroke.
- **Colour swap:** every texel near the "From" hue takes the "To" colour, keeping its shading (hue range,
  minimum saturation). **Adjust:** hue shift, saturation, brightness, for the whole texture or only the From hue.
- Import a PNG/JPG into a texture (scaled to fit), export PNG, revert a texture, undo/redo (Ctrl+Z / Ctrl+Y).
- **Save** (Ctrl+S) re-encodes only the 4×4 DXT blocks that changed; everything else stays byte-identical, and the
  file keeps its size and layout. DXT1 cut-outs (3-colour blocks) and DXT5 alpha are kept. The first save keeps
  `<file>.studio.bak`. **Download** gives the edited `.GHG` instead.
- Identical texture copies in one file (the hi-res set stores some twice) are linked and saved together.
- A transforming model (`TRANSFORMER_PC.GHG`) borrows its textures from the robot and car models by hash. Its
  borrowed parts are read-only here: paint the robot or car file and the transformer follows.
- Texture size and format stay as they are. Use the hi-res set for bigger textures.

## What was verified (2026-11-08)
- **Mesh round trip (2026-11-09):**
  - Exporting and importing an object with no edits gives back identical triangles, UVs, normals and colours.
  - In Blender, a tower made 1.5x taller plus a new cube comes back right, with the cube using the tower's
    texture.
  - **In game:** lab test 6 (pending).
- **Blender export:**
  - Bumblebee's walk imports into Blender textured and posed as in the model tab.
  - Frame 225 of A1_CH1_INTRO rendered in Blender through `CutsceneCamera` matches the player's frame.
- **Props:** all 19 `NEWPHYSOBJ` files read and write back byte for byte, and every prop re-encodes exactly.
  **In game:** lab test 7 (pending).
- **Spawns:** Tranquility 2 has 17 creature spawns, 10 placed on splines. Edits rewrite only their line.
- **Models:** all 175 `.GHG` files parse.
- **Clips:** 2,022 of 2,029 `.AN3` clips decode with no warnings. The 7 that don't are Jazz `*_ARM.AN3` files,
  which use a different, unknown layout.
- **Levels:** all 11 `.GSC` scenes load.
- **Spline files:** `SPLINE.DAT` rebuilds byte-for-byte on all 17 levels.
- **INI files:** every PLACEMENTS/TRIGGERS INI round-trips.
- **Moving geometry:** moving an object changes only that object's matrix bytes, and Reset restores the file
  exactly.
- **Rebuilding writer** (`js/gsc_writer.js`): all 13 `.GSC` files rebuild byte for byte. With every chunk and
  a vertex buffer grown, every pointer still lands on the same data and the scene reads back the same.
- **Texture replace:** tested on Tranquility (256×512 DXT5 → 512×128 DXT1): the file rebuilds, and
  vertices and matrices are unchanged.
- **In game (Tranquility 2, lab):** a fully rebuilt file (every pointer moved) loads and plays, and a lifted house shows floating. Texture replace isn't tested in game yet.
- **Collision** (`js/dno2.js`): the world collision of all 8 stock levels with collision rebuilds with a new tree
  that passes the tree checks. Everything else reads back unchanged. On Tranquility, lifting one house moved
  73 polygons and hiding another removed 37. The old Python checker (`pc_dno2_check.py`) reads the result
  with no errors. **In game:** the lifted house is solid at its new height and walkable underneath (lab test 3).
- **New objects** (`js/scene_edit.js`): copies were added to all 9 stock levels with collision. Every old object
  keeps its draws, instances still point at the right objects, and the files rebuild stably. That includes
  CITY and AIRBASE, where objects past the culled count shift up one. On Tranquility, a 4-part house copy
  (10 draws, 157 collision polygons) passes both Python checkers. **In game:** the level with the copies loads and plays. The copied house is in place and solid (lab test 4). Copies must share their source's draw records: the loader only prepares records it already knows about.

- **Textures tab (2026-11-10):** painting on hi-res Optimus and saving gives a file of the same size whose model
  data and other textures are unchanged; only the painted texture's blocks differ, cut-outs intact, and it parses
  with `ghg_lib`. Reopening shows the paint. **In game:** not tested yet (the Fire Blast textures are the first test).
- **Hi-res:** hi-res Optimus (robot, car, transformer with borrowed textures) and `HOOVERINT_VEHICLES_PC.GSC` render
  with correct textures. All shipped and hi-res `.GSC` slot tables line up with their texture lists (except the
  ported HOOVEREXT scene, handled by the fallback).

- **Level-folder cutscenes:** all 125 load with no errors.
- **Cutscenes** (`js/cu2.js`): all 64 `.CU2` files load and play with no errors. 61 cutscenes find their level, and 367
  of 405 character entries have a model, of which 345 animate fully. Camera, root and object tracks were checked
  against the matrices stored in the files (see `CU2_FORMAT.md`). Not compared with the game's own playback yet.

## Files
| File | What |
|---|---|
| `serve.py` | Local server: static files plus `/api/list`, `/api/find`, `/api/file`, `/api/info` and `/api/save` (with backup). Serves the hi-res set as `HIRES/`. Bound to 127.0.0.1, refuses paths outside the game and hi-res folders |
| `js/formats.js` | GHG model and GSC scene readers (container, NU20, skeleton, layers, draws, materials) |
| `js/gsc_writer.js` | Rebuilds a `.GSC` from its parts (chunks, pointers, textures, buffers), so edits can change sizes |
| `js/scene_edit.js` | Adds copies of scene objects to a `.GSC` (commands, draw records, every per-object table, counts) |
| `js/dno2.js` | Collision (DNO2) reader, KD-tree builder and checker, geom writer |
| `js/collision_view.js` | Collision overlay; finds each object's collision; makes it follow edits on save |
| `js/region_cut.js` | Cuts a circle out of a level scene as its own map (hides the rest, trims edge pieces, crops collision). Not in the UI; run from the browser console. Built the TestTranquility crater arena |
| `js/an3.js` | AN3 animation decoder |
| `js/mesh_io.js` | Scene objects to and from Blender (.glb): export, import, writing new vertices and strips |
| `js/blender_export.js` | Characters with animations, and whole cutscenes, to Blender (.glb) |
| `js/props.js`, `js/prop_layer.js` | NEWPHYSOBJ.DAT reader/writer and the Props layer |
| `js/spawn_layer.js` | Character spawns from the mission scripts (the Spawns layer) |
| `js/shot_layer.js` | Script cutscenes: `#SplineCamera` shots and their actors, previewed and edited |
| `js/rec_layer.js` | Game recordings (DebugTrainer cutscene recorder): alignment, camera comparison, actor fits |
| `js/cu2.js` | Cutscene (.CU2) reader: cameras, cuts, characters, level pieces |
| `js/cutscene_view.js` | The Cutscenes tab (player) |
| `tools/extract_cutscene_audio.py`, `Extract cutscene audio.bat` | Pull cutscene soundtracks out of the game's `.bik` videos (run with Blender) |
| `cutscene_audio/` | The extracted soundtracks (`.ogg`) and `index.json` with each one's length and source video |
| `js/rig.js` | Character models shared by the model tab and the player: meshes, skinning, poses |
| `js/text_formats.js` | Creature CFG, block INI and SPLINE.DAT readers/writers |
| `js/model_view.js`, `js/level_view.js` | The model and level tabs |
| `js/texture_view.js` | The Textures tab (3D/2D painting, colour swap, undo, saving into the `.GHG`) |
| `js/dxt_encode.js` | DXT1/DXT5 encoder that re-encodes only changed blocks (keeps 3-colour cut-outs and DXT5 alpha) |
| `js/hires.js` | The hi-res set (`HIRES/`): which files have a hi-res copy, Normal/High detail path mapping |
| `js/level_scenes.js` | LEVEL.CFG reader: which scenes a level loads per platform (NEXTGEN split scenes, DEFAULTSCENE fallback) |

Format notes: `GHG_FORMAT.md` (AN3 section) and `PC_GSC_FORMAT.md` in the game folder.
The AN3 curve decoding follows the MIT-licensed reader in
[Snufflebox/TTGames-Workshop](https://github.com/Snufflebox/TTGames-Workshop) (`formats/classic-pc/tools/cu2.py`).

## PS3 scenes (view-only)
TF Studio also opens PS3 level scenes (`*_PS3.GSC`, e.g. the Hoover Dam Edition's HOOVEREXT MAIN / BUILDINGS / POS /
VEHICLES): geometry, textures, scene objects and collision (DNO2). They're big-endian with their own vertex layout
(`js/ps3_scene.js`, format notes in `PS3_HOOVEREXT_NOTES.md`). Edits are only on screen: Save and texture
Replace refuse PS3 scenes. Export still gives a PC .dds.

**Where they come from:** every folder in `Fresh Build\PS3 assets\LEVELS` shows up in the level list as `PS3_<name>`
(`PS3_HOOVEREXT` is included). To add another PS3 level, copy its folder from the PS3 `USRDIR\LEVELS` there. The game
never reads that folder. `HOOVEREXT_PS3.GSC` is the whole level in one scene; MAIN / BUILDINGS / POS / VEHICLES are the
split High Detail scenes, each loaded on its own.
Known look differences: blend/detail passes on the rocks draw as plain white speckle.
