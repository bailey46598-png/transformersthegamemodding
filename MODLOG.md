# MODLOG: Transformers: The Game (PC, 2007)

Our shared lab notebook. **Newest entries go at the top of the "Entries" section.**
Log everything you try, including things that failed. A failed test with good notes saves the other person hours.

## How to add an entry
1. Copy the template below.
2. Paste it at the top of **Entries**, under the heading.
3. Fill it in. Leave a field as `-` if it doesn't apply.
4. Commit with a message like `Log: vehicle jump height test`.

## Entry template

```markdown
### YYYY-MM-DD - Short title - (your name)

**Goal:** What you wanted to find out or make work.

**Setup:**
- Game copy: (lab folder name)
- Mods / tools loaded:
- Files changed: (our files only; for game files, say which one and what you changed)

**What I did:**
1.
2.

**Result:** ✅ worked / ⚠ partly / ❌ failed
- What happened in game:

**Evidence:** (screenshot in notes/images/, address, log output)

**Next:** What to try next, or questions for the other person.
```

---

## Entries

<!-- New entries go here, newest first. -->

---

# Earlier sessions (solo work before the shared repo)

# MODLOG: Transformers: The Game (PC, 2007)

## Session 1: 2026-11-06

### Goal
- Recon the game for modding.
- Reverse-engineer enough to add a **jump in vehicle mode**.
- Map how the game's data works, and learn from the 2.0 mod.

### Environment
- **Host:** Windows 11 x64.
- **Python:** none installed. `um` was run with Blender 3.6's bundled Python plus placeholder Pillow/PyYAML
  modules in the session scratchpad.
- **Disassembler:** Capstone, installed to the scratchpad.
- **IDA:** IDA Free 9.5 is installed (not Pro), so it can't be scripted. Addresses in the notes are for
  manual `G` jumps.
- **Compiler:** Visual Studio 2022 Community; the user added the **Desktop development with C++** workload
  during this session.

### Game facts
- **Engine:** Traveller's Tales **NU2**, native **32-bit x86**, D3D9, no ASLR, image base 0x400000.
  Version **1.0.254.2**.
- **Content:** all data, mostly plain text: CFG, SCP scripts, INI, GUIC UI.
- **Retail layout:** the retail game ships `Transformers_Lo/Hi.dat` archives (Low/High detail); the copies
  here are extracted to loose files.
- **No anti-cheat, offline only.** No existing loader for this game.

### Executables and lab
| Location | Exe | Use |
|---|---|---|
| Fresh Build, Build For Testing, parent folder, `Transformers.The.Game` (steamunlocked download) | RELOADED crack, SHA-256 `5aa3bd49…` | **Not used for running or testing** |
| **`Lab - VehicleJump`** | **Retail SecuROM 7 exe**, `193933d4…`, v1.0.254.2, no crack tag | **The only test target** |

- Fresh Build briefly held the retail exe, then the crack again. The lab copy was made while the retail exe
  was there.
- **Lab contents:** a full copy of Fresh Build (6,012 files) plus:
  - Ultimate ASI Loader **v10.0.2** x86 as `dinput8.dll` (ThirteenAG GitHub release; 32-bit, exports
    `DirectInput8Create`, signed with ThirteenAG's own FusionFix certificate)
  - `VehicleJump.asi` and `VehicleJump.ini`
- Hashes and the test checklist are in `Lab - VehicleJump\LAB_NOTES.md`.
- **Not launched yet.**

### Reverse engineering (static only; details in RE_NOTES.md)
**Player and input:**
- Player pointer is `[0x770614]`, the pad is `[0x770620]`, frame time is `[0x7183bc]`.
- The per-frame order is: character list update `0x4727e0` → pad read `0x446da0` → `Char::Update`
  `0x472560` (`ret 8`).
- **The jump action (bit 0x8000 in `+0x684`) is set every frame Space is pressed, even while driving.
  Vehicle states just ignore it.**

**Flags:**
- **Vehicle form** = bit 18 of `+0x628`, airborne = bit 21, grounded = bit 24.
- Correction: `+0x5C0` is "transform model active", not "in vehicle".

**State machine:**
- `ChangeState` is `0x405090`, with the current ID at `+0x5C8`.
- Known states: 7 = Transform, 0x13 = Jump.

**Jump, launch and velocity:**
- `Char::Jump` `0x405250`
- `AddVelocity` `0x404c80`. Body velocity is at `body→+0x34→+0x20`.
- `SetLaunch` `0x4075e0` and `UpdateLaunch` `0x4387a0`.
- The devs' disabled car hop adds velocity every frame with no frame-time scaling. That explains their
  "car can't be controlled whilst in the air" comment.

**Config and landing:**
- The config keyword table is at `0x6b4920`.
- Abilities are a bitfield at type record `+0x1B4` (Jump 0x4000, Transform 0x40, Fall ≈ 0x80000).
- The landing check `0x4481b0` needs the `Fall` ability.

### Built: `mods\VehicleJump` (draft 0.1)
- **Hook:** on `Char::Update`. A byte check guards it, the patch is one atomic 8-byte write, and there is
  no hook library.
- **Behaviour:** player only. In vehicle form, when jump is pressed, with the cooldown done and no hop
  running, it adds `JumpVelocity` to the active body's vertical velocity once. `Method=1` uses the devs'
  `SetLaunch` path instead, for comparison.
- **Waiting for the code:** it waits up to 5 minutes for SecuROM to decrypt the code before hooking.
- **Diagnostics:** it logs state and flag changes to `VehicleJump.log`.
- **Build:** MSVC, clean, 141 KB. It imports only KERNEL32 and USER32. The disassembly was checked for
  `__thiscall` / `ret 8` correctness.
- **Not yet run in game.**

### Data map and 2.0 mod study (GAME_DATA_MAP.md, MOD_2.0_DIFF.md)
**Data map:**
- A character is robot + car + transform-sequence configs, plus shared anims and attributes.
- Levels are `LEVEL.CFG`, `CREATURES.CFG`, `PLACEMENTS.INI`, `PHYSOBJTYPES.INI` and `AI\*.SCP`.
- The scripting language is state machines plus about 40 built-in module types.
- The UI language (GUIC) calls functions built into the exe.

**Comparisons:**
- **Build For Testing ≠ full 2.0 mod.** It has 40 new and 21 changed files: Demo Tranquility plus a few
  extras.
- The full mod is `TF_2.0 Mod\TF_2.0 Main Files`: 1,941 files, 946 new and 817 changed, with no code. It
  isn't merged anywhere yet.

**Lessons:**
- New characters reuse fixed creature slots (the Ratchet trick).
- `CREATURECACHESIZE_KB` is the main crash lever.
- Removing `Fall` gives air transforms but breaks animations.
- **The debug menu (Level Select, God Mode, Fly Camera) is a single `GUI\FRONTEND.GUIC` edit.**

### Files created this session
- **Fresh Build:**
  - Notes: `MODDING_PLAN.md`, `RE_NOTES.md`, `GAME_DATA_MAP.md`, `MOD_2.0_DIFF.md`, `MODLOG.md`
  - Mod: `mods\VehicleJump\` (source, INI, build scripts, README, `build\VehicleJump.asi`)
- **`Lab - VehicleJump\`:** a copy of the game with the loader, plugin and `LAB_NOTES.md`.
- **No original game files were modified.**

### Open questions (in order)
1. Does the hook install on the retail exe, i.e. do the code bytes match after SecuROM decrypts?
2. Does the car actually lift and land with `Method=0`? How does `Method=1` compare?
3. Which state ID is driving, and does bit 24 (grounded) change when a car lands?
4. Air steering, which needs the vehicle driving state's update.

### Ground rules
- Test only on the retail exe in the lab.
- Don't build, tailor, or run anything against the cracked build.

### Next step
**Run `Lab - VehicleJump\Transformers.exe` with the disc inserted and a 60 FPS cap. Drive, press Space,
then send back `VehicleJump.log`.**

## Session 1, continued: GHG models and Armada Megatron (2026-11-06)
**The GHG format is decoded far enough to mesh-swap rigid characters** (details in GHG_FORMAT.md):
- **Pointers:** all of them are self-relative and listed in `PNTR`.
- **Scene chain:** bone list → instance → object (material + commands) → draw record.
- **Padding rule:** the model block starts at an offset ending in `0xC4`.

**Tools** in `mods\ghg_tools`:
- `ghg_lib.py` reads and rebuilds files, byte-identical on 112 models.
- `ghg_verify.py` checks a file.
- `ghg_preview.py` renders a preview.
- Also: a DXT1 codec, a PNG reader and a GLB reader.

**Mod `mods\ArmadaMegatron`:** Armada (PS2) Megatron, ripped by the user from their own copy, on the G1
Megatron bonus skin.
- **Size:** 5,491 triangles, a 512² atlas, and a 46-bone G1 skeleton with joints moved to Armada's pivots.
- **Verified offline:** every index is in range, the skeleton is consistent, `PNTR` is untouched, and the
  preview matches the source model.
- **Installed in the lab only.** The original is kept as `.vanilla`. **Not tested in game.**
- **Left out:** the tank hull, cannon and missile pods.

**Next step:** in the lab, switch on G1 Megatron in the G1 Characters menu, play a Decepticon mission, and
report whether he loads, stands and animates.

## Session 2: Armada Cyclonus replaces Blackout (2026-11-07)
**Mod `mods\ArmadaCyclonus`** swaps all four of Blackout's models for Armada Cyclonus. Details are in its
README.
- **Sources:** `CYCLONUS.glb` (robot) and `CYCLONUS_HELI.glb` (heli pose), ripped by the user.
- **Robot:** 8,946 triangles. The torso keeps Cyclonus' shape, the limbs are fitted to Blackout's bones,
  and rest-pose gaps are ≤ 0.2.
- **Gun arm:** the left forearm, hand and missile pod. The gun's root bone is the robot's left forearm.
- **Heli:** 10,442 triangles. The rotor is on Blackout's tilted spin axis.
- **Transform sequence:** Cyclonus' robot parts on its robot bones; the heli panels are emptied.

**`ghg_lib` fixes:**
- It reads empty texture entries (size 0), used by gun, weapon and transformer models.
- It allows any bone count from 1 to 255.
- **Round-trips:** 168 of the 174 game GHGs now round-trip byte for byte (was 112).

**Status:** verified offline (`ghg_verify` on all four, pointers untouched). Installed in the lab only, with
`*.GHG.vanilla` backups. **Not tested in game.**

**Next step:** in the lab, play the first Decepticon mission as Blackout. Check that he loads, the gun arm is
textured, the transform and the rotor spin, and the fit while moving.

### Cyclonus left arm fix (v3, 2026-11-07)
**In game:** the left forearm showed only while aiming, both with it on the gun model's root bone (v1) and
on its `pod` bone (v2).

**Cause:** the game draws `GUN_PC.GHG` only in ranged mode. Blackout's robot model has no left forearm
mesh, so the vanilla arm is absent outside aiming too.

**Fix:**
- Two unused robot mesh instances (`rotor3`, `rotor4`) were moved to `left_forearm` and `left_wrist`. Every
  bone-list slot, empty ones included, is in `PNTR`, so this only changes the two slot values.
- The Cyclonus left arm now lives in the robot model, and the gun model is emptied.
- This is a new technique for giving a bone without a mesh one: borrow an unused instance.

**Status:** verified offline and installed in the lab. Not tested in game.

### Cyclonus shard fix (v4, 2026-11-07)
**In game (v3):** the left arm showed all the time, but dark, stretched shards followed him near that arm.

**Cause:** the rip's `crumplezone` node, a 658-triangle mesh on the left forearm. It's very likely an Armada
damage-effect mesh, not armour. It only became visible once the left arm moved into the robot model.

**Fix:** `crumplezone` is now skipped in every model (robot, transformer). The heli rip doesn't have it.

**Status:** verified offline and installed in the lab. Not tested in game.

## Armada Starscream replaces Starscream (2026-11-07)
**Mod `mods\ArmadaStarscream`** (converter `ghg_tools\armada_starscream.py`, which reuses the Cyclonus
helpers) replaces Starscream's default skin. Details are in its README.
- **Robot:** 9,324 triangles at ×1.243. Four donor instances are moved to the forearms and hands, so both
  arms are always drawn. Chest and wings are widened ×1.25 sideways.
- **Legs:** the Armada shin rides TF:TG's long lower-leg bone (`Foot_Top`).
- **Jet:** the jet rip on the single body bone.
- **Gun and melee arm models:** emptied.
- **Transformer:** robot bones only.

**Status:** verified offline (`ghg_verify` on all five) and installed in the lab with `.vanilla` backups.
**Not tested in game.**

### Starscream v2 (2026-11-07)
**Seen in game (v1):** he rendered **all black**, and the sword stuck far out in front.

**Black:** Starscream's slot 0 is DXT5. The DXT1 atlas kept the DXT5 label, so the game decoded garbage.
The atlas is now relabelled DXT1 (FourCC and entry format 12), which works on Cyclonus.

**Sword:** the blade (`Sword_geo`) is dropped. The left fist mesh is trimmed to within 1.5 of the hand
pivot, which removes the hilt; there's a clean gap from 1.5 to 2.

**Originals:**
- `Fresh Build\CHARS\STARSCREAM` had been overwritten with the v1 build at 10:36, while testing there.
- Originals were copied from the lab's `.vanilla` files to `mods\ArmadaStarscream\vanilla\`. The converter
  now reads from there.
- v2 is installed in both the lab and Fresh Build, each with `.vanilla` backups.

**Status:** verified offline. Not tested in game.

### Starscream v3: split shins (2026-11-07)
**Seen in game (v2):** textured and working, but the legs came apart a little when he ran.

**Cause:** TF:TG's lower leg is two animated bones in a zigzag (knee → rear heel joint → foot). The whole
Armada shin rode the lower one, so its top swung off the knee.

**Fix:**
- The shin is split at the heel joint's height (y 2.66). The top half rides `Shin_Joint` (the knee) and
  the bottom half rides `Foot_Top_Joint`.
- Triangles across the cut go in both halves, so they overlap.
- This applies to both the robot and the transformer.

**Status:** installed in the lab and Fresh Build. Not tested in game.

## Frozen Megatron replaces Megatron (2026-11-07)
**Mod `mods\FrozenMegatron`** (converter `ghg_tools\frozen_megatron.py`) swaps regular Megatron's robot model
for the frozen statue from `HOOVERINT_PC.GSC` (objects `Smegatron` #1773 and `Smegatron_ARM` #1774), with the
statue's own textures. Details are in its README.
- **Fit:** the statue is nearly in Megatron's bind pose. It is turned 270°, the median gap is 0.08, and the
  skeleton is unchanged.
- **Bones:** 257 shells go onto the nearest vanilla bone, and 56 shells that span joints are cut per triangle.
- **Layers:** all 45 records in all three layers are rewritten (`ghg_lib.scene()` reads only the default layer).
- **Size:** 7,142 triangles. Slot 0 is an atlas of level textures #204 and #206.

**Status:** installed in `Lab - VehicleJump` only, with a `ROBOT_PC.GHG.vanilla` backup.
**In game:** loads and animates (screenshot of the combat stance in the city), with the frozen texture showing.

## Concept Megatron: retail Megatron with the statue's head (2026-11-07)
**Mod `mods\ConceptMegatron`** (converter `ghg_tools\concept_megatron.py`) puts the frozen statue's head on the
retail Megatron and paints it with the retail atlas. Details are in its README.
- **Head:** 382 triangles. UVs come from the closest point on the retail head, and 116 seam triangles are
  mapped whole.
- **Eyes:** the retail eye glow is slid 0.11 back onto the statue's face.

**Status:** verified offline. Installed in `Lab - VehicleJump`, replacing FrozenMegatron there (backup stays
retail). **Not tested in game.**

## Session 3: boss special moves (2026-11-07)
- **Static reading only; nothing changed in the game.** Details are in `SPECIAL_MOVES.md`.
- Sonic Boom, Flail, Megatron Flame, Shoot Like a Madman and Charge are normal states. They start from action
  bits in `+0x684` (0x400000, 0x200000, 0x800000, 0x80000, 0x100000) that only AI scripts set. The player pad
  never sets them, and the gate (0x45002d) has no player check.
- The playable Bumblebee, Ironhide and Megatron already have the abilities and animations. The MiG flame needs
  data added to a playable character.
- **Next step:** a `SpecialMoves.asi` that ORs those bits for the player while a key is held, built on the
  VehicleJump hook.

## DebugTrainer: ImGui debug menu on F1 (2026-11-07)
**Mod `mods\DebugTrainer`** (v0.1): an ASI with a Dear ImGui menu that calls the game's own hidden debug-menu
functions. Details are in its README; addresses are in RE_NOTES.md ("Debug trainer").
- **Features:** God mode, Fly camera, HUD, vibration, SFX, music, camera sensitivity, aspect ratio, the 8 engine
  debug options (Draw FPS, coords, Unlock all, Unlimited ammo, No police, Disable AI, Show shields, Slow
  motion), Complete level (experimental), a player readout and a raw flag editor.
- **Hooks:** the game's own D3D9 device vtable (Present, Reset) found through `[0x2BD90EC]`, the window
  procedure, and the DirectInput device vtables for input blocking. Byte checks gate every game call.
- **Build:** MSVC, clean, 523 KB. Dear ImGui v1.91.9 is in `third_party\imgui`.
- **Installed** in `Lab - VehicleJump` next to VehicleJump. **Not run in game yet**: the game was already running
  from the lab when the files were copied, so it loads on the next start.

**Next step:** restart the lab game, press F1 in a level, try each toggle, and send `DebugTrainer.log`.
- **Built `mods\SpecialMoves` 0.1** and installed it in `Lab - VehicleJump`. Hold K in robot form: K = 1st move,
  Shift+K = 2nd, Ctrl+K = 3rd. It patches the pad-read call at 0x4728DA (no clash with VehicleJump or
  DebugTrainer). **Not tested in game.**
- **SpecialMoves 0.1 in game:** the hook works and Bumblebee enters state 0x1F (Sonic Boom). He then stays in
  the charge walk forever. Cause: phase 2 of the Sonic Boom update (0x453010) waits for `+0x7CC` bit 0, which
  0x446370 sets only when the AI's target (`+0xCB0`) is in reach. The state has no exit of its own; neither
  does Flail (0x4529C0). Madman (0x452CC0) and Megatron Flame (0x453360) end when their bits drop.
- **SpecialMoves 0.2:** releasing K sets `+0x7CC` bit 0 (fires the boom). After the boom loops back to phase
  1–2, or after `ExitDelay` for other moves still running, it calls `ChangeState(0)`. Installed in the lab.
  **Not tested in game.**
- **SpecialMoves 0.2 in game:** Madman crashed twice at 0x43BCEF (dumps `Transformers.exe.7388/32564.dmp`).
  Holding fire actions 0x8 and 0x10 together makes the Madman fire phase (0x452E1B) fire weapon slot 2
  (`char+0x1C14`). The player has no slot 2 (type 0x46 = none), so the weapon table lookup 0x50B3E0 returns
  null. The Sonic Boom fired but hurt no enemies.
- **Why the boom hurt no one:** the ring update (0x429660) builds its explosion with side 2 (FRIEND) at
  0x429791. Sides: AUTOBOT 0, DECEPTICON 1, FRIEND 2, ENEMY 3. The physics push 0x506180 skips a body unless
  its flags (`+0xAA`) allow the explosion's side: 0x4 Autobot, 0x8 Decepticon, 0x10 FRIEND. Only the player
  takes FRIEND explosions. Hits go to `Char` 0x465070 with IMPACT_SHOCKWAVE (100 damage, fly-back).
- **SpecialMoves 0.3:** Madman alternates 0x8 / 0x10 each frame and ends when its phase (`state+0x74`) returns
  to 0. Boom: 0x4532B1 `call 0x429800` now goes through a stub that records the shooter (esi), and 0x429791
  goes through a stub that stores the shooter's side when the shooter is the player (otherwise 2, as vanilla).
  Built and stubs checked in the disassembly. Installed in the lab. **Not tested in game.**

### DebugTrainer: character select (2026-11-07)
- **Added:** a character select that lists every creature the level loaded from `CREATURES.CFG` (filter:
  Transformers only, i.e. ability 0x40), shows the current one, and swaps through the game's own swap request
  `0x6FE50C` (details in RE_NOTES.md, "Player swap"). Requests the game doesn't pick up within 5 s are cancelled.
- **Also in this round:** keyboard navigation via DirectInput (confirmed working in game), a drawn menu cursor
  moved by a low-level mouse hook, and a per-session input log.
- **Verified:** by reading the running game's memory (read-only): 147 types, names and the transform filter are
  correct. **The swap itself isn't tested yet.** The new build couldn't be copied in while the game was running.
- **SpecialMoves 0.3 in game:** Madman no longer crashes, but its shots circled the player and hurt nothing.
  Cause: the fire phase sets each shot's explosion to EFX_IRONHIDEBOSS and homes it on the player
  (0x452ED7 `mov ecx,[0x770614]` → 0x437B30 → 0x4F6FA0, strength 2.0). Projectile explosions take their side
  from the projectile (`+0xA8` bits 2–3, set by the shooter), so they will hurt enemies once they reach them.
- **SpecialMoves 0.4:** redirects the call at 0x473505 (CharList::UpdateAll 0x4727E0, `ecx` = &head, next =
  `char+0`) to capture the list head. While the player is in Madman, it picks the nearest living
  (`+0x49C` health > 0) character that isn't on the player's side or FRIEND, within MadmanRange. A stub at
  0x452ED7 homes the player's shots on it, or takes the game's no-homing path (0x452F4B) when there is none.
  Boss shots are unchanged. Built and stubs checked; installed in the lab. **Not tested in game.**
- **Crash fix (same day):** a swap to Ironhide crashed (0x44653A, no model). The list now shows only creatures
  whose model this level loaded ("Loaded in this level", on by default), and their `…Tran` model if they have
  one. The swap re-checks this first. Installed; not tested yet.
- **SpecialMoves 0.3 in game, Flail:** after the move ended, Barricade's flail arms stayed out for a while.
  The flail animations set both arms to Melee (POI "General Transform <arm> Melee" → `Char::SetArmForm`
  0x407AC0, stored at `char+0x5B8 + arm*4`; arm 0 left, 1 right; form 0 Normal, 4 Melee). The boss's flail
  only ends by being hit, and every recoil animation in `BARRICADEMELEELEFTARM/RIGHTARM.CFG` sets the arm back
  to Normal. The plugin's switch to idle had nothing to do that.
- **SpecialMoves 0.5** (0.4 was never installed): when the player leaves state 0x1B it calls
  `SetArmForm(0,0)` and `SetArmForm(1,0)` (setting `FlailArmsBack`). Includes the 0.4 Madman aiming.
  Installed in the lab. **Not tested in game.**
- **Level and chapter select (same day):** the menu lists every level the game knows, plus the chapters of the
  14 main levels with their in-game titles. It loads levels through the game's own `RequestLevel` and jumps to
  chapters the way the debug menu's MissionSelect does (applied 3 s after the level has loaded). Built and
  installed; **not tested in game**.

## Playable Ratchet on Optimus' animations (2026-11-07)
**Mod `mods\PlayableRatchet`** (converter `ghg_tools\ratchet_optimus_rig.py`). Details are in its README.
- **Why a rebuild:** `.AN3` clips are matched to bones by index and carry bone offsets. Ratchet's own skeleton
  (37 bones) has only idle, heal and transform clips. Optimus' (46 bones) has the full move set.
- **Robot:** Ratchet's mesh is refitted onto Optimus' `ROBOT_PC.GHG`. The skeleton and `PNTR` are unchanged.
  - 7,046 triangles. Feet are on y = 0, no UVs wrap, and 99.9% of faces agree with their normals.
  - Ratchet's 4 skinned pieces are placed by their weights.
  - 4 body textures share one 256² DXT1 sheet (1-bit alpha kept). Masks are in the 128² slot; the eye glow is
    on Optimus' eye material.
  - Saved as `CHARS\OPTIMUSPRIME\RATCHET_ROBOT_PC.GHG`, so Optimus' clip names resolve.
  - Fitted height 10.1, so `SCALE 0.72` brings him back to 7.3.
- **Configs:**
  - `RATCHET.CFG` is rewritten.
  - New `RATCHETSHAREDANIMS.CFG` (Optimus' table with the 6 left-arm sword transforms off) and
    `RATCHETSHAREDATTRIBS.CFG` (Optimus' full ability set).
  - `RATCHETTRAN.CFG`: named `RatchetTran`; fixed the misspelled DEPENDS; dropped the missing
    `transform_car_land.an3`; uses the self-textured `Ratchet_transform.ghg`.
  - `RATCHETCAR.CFG` gets the attribute block other playable cars have.
- **Sounds:** `tra_Ratchet_Ambulance` / `tra_Ambulance_Ratchet` enabled in `AUDIO(_NG).CFG`. WAVs from the 2.0
  mod, resampled to 22.05 kHz.
- **City:** loads Ratchet's 3 creatures. `Ped_S7Barry`, `Ped_S7Wayne` and `Ped_JumpsuitJon` are commented
  out in NEXTGEN to stay under the 150-type limit. `CREATURECACHESIZE_KB` 6005 → 8005 (the 2.0 mod's value).
- **Exe facts:**
  - The name "Ratchet" gets identity `+0x5E4 = 6` (0x470ca5) and the shared `+0x628 |= 0x1000` (also set for
    Bumblebee and others). Nothing compares identity 6 directly.
  - Optimus' `.AN3` names and Ratchet's transform clips all resolve; `transform_car_land.an3` is missing.
- **Installed** in Fresh Build and `Lab - VehicleJump` via `install.py`, with `.vanilla` backups.
  `--uninstall` reverts.
- **Not tested in game.**

**Next step:** in the lab, load City, press F1 and pick Ratchet. Check the textures, the move set, the fit while
moving, the transform size match and the car height.

## AllCharacters: every robot loaded in every level (2026-11-07)
**Mod `mods\AllCharacters`** (`make_all_characters.py`, `creature_cost.py`). Details are in its README.
- **Finding:** the creature type table comes from the master `CHARS\CREATURES.CFG` (112 includes plus body
  parts = 147 types; it matches the live read). A level's own `CREATURES.CFG` only decides which models load.
  So adding families doesn't touch the 150-type limit.
- **Edit:** adds the missing families out of the 18 robot families to each of the 17 levels. Each level's
  `CREATURECACHESIZE_KB` becomes `old + 2×` the added model and animation KB (15–22 MB).
- **Applied** to `Lab - VehicleJump` only, with `.allchars.bak` backups. It keeps CITY's Playable Ratchet edits.
  Re-running gives the same files.
- **Not tested in game.** With it, the trainer's character select should list every robot in every level.
- **SpecialMoves 0.5 in game, Megatron:** Charge works. Flail entered state 0x1B and dropped to 0 every frame.
  Flame (Shift+K, 0x800000) did nothing. Causes:
  - Megatron's boss phase is at `char+0x7C0` (set by his per-character update 0x405110 from `+0x7E8` flags).
    The Flail state check 0x40EF80 cancels unless the phase is 1 (for identity 8). The Flame state check
    0x40F8A0 cancels unless the phase is 2.
  - The Flail update 0x4528D0 also cancels after the wind-up animation unless 0x40000 is held.
- Ability bit names (`type+0x1B8`): 1 BlockWithoutCounter, 2 CanBeDronePickedUp, 4 CanFlyBackCounter,
  8 HasFlyBackIntoRecover, 0x10 CanBeElectrocuted, 0x20 CanBeReeledIn, 0x40 CanElectrocute, 0x80 CanReelIn,
  then the specials as in SPECIAL_MOVES.md.
- **SpecialMoves 0.6:** stubs at 0x40EF80 and 0x40F8A0 return early for the player (the boss keeps its
  phases; setting `MegatronAnyPhase`). Flail also holds 0x40000 when the type lacks 0x40/0x400/0x1000.
  Installed in the lab. **Not tested in game.**
- Seen in the log: while the player is in Charge (state 0x1D), the pad reader isn't called, so the plugin's
  per-frame logic pauses until the charge ends. Charge ends by itself.
- **In-game result (AllCharacters):** in AutoCityBoss, only Megatron and OptimusPrime01 had models. The added
  robots didn't load, and Ratchet isn't in the trainer list.
  - Found: pass 2's `INCLUDE` (0x40AF90) remaps `chars/X.cfg` through the skin table (`0x714378` →
    `0x4797B0`). That's why OptimusPrime loads as OptimusPrime01.
  - Found: `CREATUREPOOLALLOC` (`+0xBF4`, default 10) is the spawned-character pool, not models. Nothing was
    found reading `CREATURECACHESIZE_KB` (`+0xBF0`) after it's stored.
  - Unresolved: what keeps the added models unloaded, and which file the type table comes from (Ratchet is only
    in CITY's list).
  - **The trainer now logs a creature dump** (raw model fields, the level's `+0xC14` name list, cache/pool) 3 s
    after each level loads, to settle this from one play session.
- **Fix (same day), from the creature dumps:** added robots were registered but never resident; the cache only
  keeps LEVEL.CFG `CREATURE` types and spawned ones.
  - The trainer now loads a registered character's robot, vehicle and transform through the game's own
    **LoadCreature 0x43A170**, waits until they're resident (up to 15 s), then swaps.
  - Ratchet is added to the master `CHARS\CREATURES.CFG` (type table now 150 of 150, counted and checked
    against the in-game 147 before writing) and to every level.
  - Installed in the lab. **Not tested in game.**
- **In game (same day): picking Ratchet froze the game.** The log ends at "loading Ratchet into the creature
  cache"; no frames after it. The main thread was stuck inside `LoadCreature(Ratchet)`, in the creature-load
  wait (Sleep(10) loop, 0x473050). The background load of his rebuilt model never finished.
  - Level loads themselves were fine: City loaded in about 3 s with the 150-type master list.
  - **Ratchet is now opt-in** (`make_all_characters.py ... --apply --with-ratchet`). The lab's master list and
    levels are back to no Ratchet type. CITY keeps the Playable Ratchet mod's own include, which the game skips
    without a type.
  - **Trainer:** logs how long each LoadCreature call takes. A watchdog thread logs "STUCK ... inside
    LoadCreature(X)" when frames stop for 20 s.
  - **Open:** does LoadCreature work mid-level for a vanilla robot? Next test: Jazz in City.

### RatchetTest: Ratchet is Tranquility 2's player (2026-11-07, lab only)
- **Purpose:** load Ratchet at level start, like any shipped player character. This tells whether his rebuilt
  model loads at all, or whether only the trainer's mid-level LoadCreature hangs.
- **Steps:**
  - `AllCharacters --apply --with-ratchet`: master list 150/150, Ratchet included in every level.
  - `mods\RatchetTest\ratchet_test.py --apply` edits Tranquility 2's LEVEL.CFG:
    `CREATURE Ratchet +car +tran`, and `STARTCHAR` / `DEFAULTCHAR Ratchet RatchetCar RatchetTran` (the drone
    lines are commented, not deleted).
  - It also edits the `#PlayerType=` lists in AUTO2HUB and AUTO2CHAP1–4 to Ratchet ×4. The hub line had
    already been changed to `Jazz,Ironhide,Ratchet,Ratchet` at 19:32 by someone else; that version is the
    backup.
- **Undo:** `ratchet_test.py --restore` (`.ratchettest.bak`), and `make_all_characters.py --apply` without
  `--with-ratchet`.

### Playable Ratchet: transform crash fix (2026-11-07)
**In game** (lab, the user's Tranquility 2 test setup with Ratchet as the start character): he spawned in car
form, which was the "regular ambulance". Transforming crashed (`Transformers.exe.30360.dmp`).
- **Crash:** an access violation at 0x466F4D in the transform state update, reading `[Char+0x48]+0x98`. `+0x48`
  is the character's current animation, and it was null.
- **Cause:** `CHARS\RATCHET\TRANSFORM.AN3` (car → robot) has **89 bones**. Both Ratchet transform models have 87.
  - Clips are matched to bones by index; `.AN3` stores no bone names (header `4INA`, then u16 bone count).
  - The same 89-bone file is in vanilla, the 2.0 mod and Build For Testing.
  - The robot → car clip `TRANSFORM_REVERSE.AN3` has 87 bones and is fine.
- **Fix:** car → robot plays `transform_reverse.an3` at `RATE -30`. The engine supports negative rates (Optimus'
  vehicle-weapon config uses `Rate -8`).
- **New tool:** `ghg_tools\an3_check.py` checks each clip's bone count against its model. All 86 of Ratchet's
  clips now match.
- Reinstalled in the lab and Fresh Build. **Not tested in game yet.**

### Playable Ratchet: vehicle profile fix, RatchetFix.asi (2026-11-07)
**In game (second test):** the same crash at 0x466F4D, after the clip fix. You noticed the car was the traffic
ambulance, not Ratchet's search-and-rescue vehicle (`CAR_PC.GHG` is his own, used nowhere else).
- **Cause:** spawn setup 0x470A00.. assigns a vehicle profile per creature name (`push N; call 0x4702B0` →
  `Char+0x52C`).

  | Profile | Characters |
  |---|---|
  | 0 | Optimus, all drones |
  | 1 | Bumblebee |
  | 2 | BB07 |
  | 3 | Jazz |
  | 4 | Ratchet |
  | 5 | Ironhide |
  | 6 | Megatron |
  | 7 | Starscream |
  | 8 | Blackout |
  | 9 | Barricade |
  | 10 | Scorponok |
  | 11 | Frenzy |
  | 12 | Bonecrusher |
  | 13 | Brawl |
  | 14 | TripleC |

  - Profile setup 0x469DD0 (jump table 0x46A02C) maps each profile to a vehicle-manager type (`[0x6FB02C]`,
    0x4600B0): Optimus 29, Bumblebee 26, Ironhide 39, and so on.
  - Profiles 4, 10, 11 and 16 fall into the default case, which uses vehicle type 4, the traffic ambulance.
    Ratchet never got a vehicle profile.
- **Renaming the creature isn't an option:** unknown names take the generic path (0x4713E0), which sets the type's
  Side to FRIEND.
- **Fix:** `mods\PlayableRatchet\RatchetFix\RatchetFix.asi` patches `push 4` → `push 0` at 0x470CB5 at start-up.
  - The profile is set in the INI. The plugin first checks the bytes at 0x470CAF and 0x470C88.
  - Built with MSVC and installed in `Lab - VehicleJump`. **Not run yet.**

### Playable Ratchet: car and transform linking, RatchetFix 0.2 (2026-11-07)
**In game (third test):** with the vehicle profile patched (log: 4 → 0), the traffic ambulance was gone, but the
vehicle form was invisible and transforming still crashed at 0x466F4D (`Transformers.exe.3340.dmp`). The dump
holds globals but not the heap, so this was found statically.
- **Cause:** at spawn, 0x471D80 picks per identity (byte table 0x47253C, jump table 0x472518) which car and
  transform creatures to attach:

  | Branch | Builds | Used by |
  |---|---|---|
  | 0x471D97 | `%sCar` + `%sTran` | Bumblebee, BB07, Brawl, Barricade, Bonecrusher, drones |
  | 0x471DCD | lower-case name variant | Jazz, Megatron, Starscream |
  | 0x471E51 | `%sVeh` | Ironhide, MiG |
  | 0x471F1C | `%sHeli` | Blackout |
  | 0x471E64 | TripleC's | TripleC |
  | **0x471F55** | **nothing** | **Ratchet**, Frenzy, EnergonDrone |

  The developers left Ratchet as a non-transformer. With no car or transform model attached, his vehicle was
  invisible and the transform state had no animation.
- **Every identity table, checked:** of the 12 per-identity tables (reads of `+0x5E4`), only one other puts
  Ratchet with the non-transformers: 0x46D79B (table 0x46E480). There, transformers register the 0x407290
  animation callback on their model (via 0x538070).
- **RatchetFix 0.2:**
  - copies Bumblebee's byte into Ratchet's slot in both tables;
  - only does so if Ratchet's byte still equals Frenzy's, and the reading code at 0x471D89 / 0x46D7A7 matches.
  - Dry run on the exe's bytes: car/transform 8 (skip) → 1 (`%sCar`/`%sTran`); callback 1 → 0.
- Installed in the lab. **Not run yet.**
- **RatchetTest result (in game):** Tranquility 2 loaded in about 3 s with Ratchet as a level-load creature, and
  the Drone ↔ Ratchet swap worked. **Ratchet's model is fine.** The earlier freeze was the trainer's direct
  LoadCreature call.
- **Black loading screen when picking an unloaded character (e.g. Starscream):** calling LoadCreature 0x43A170
  directly mid-level leaves the game on its loading screen forever.
  - The game's mid-level path, used by the script `#LoadCreature=X` (0x50D7D0, deferred):
    1. QueueLoad 0x40BB00 on the swapper 0x6FE480. It copies the name into the pool at 0x6F9B60 and appends it
       at +0xC; the count is at +4.
    2. 0x473010 shows the loading screen and runs the job 0x43A3B0 → 0x43A310 (LoadCreature per name).
    3. 0x40BC00 clears the busy bytes.
  - **The trainer now queues through QueueLoad** (only when the queue is idle). The short loading screen is the
    game's own. Timeout 30 s.
- **In game (same day): loading works** (Megatron in DemoTranquility: queued load took 2.4 s, then swapped).
  Problems: the camera doesn't reset after a swap, and some swaps crash.
  - The crashes were at 0x65D204 (×6, 20:04–20:35) and 0x534F9A (×1). 0x65D200 is the pointer fix-up a fresh
    model file goes through, so it was handed a null buffer: the creature cache had no room. 0x534F9A is a bad
    cache entry.
  - Cause: nothing ever unloaded the characters the trainer loaded, so every swap added a family to the cache.
  - **Fix:** the trainer remembers the parts it queued and, after each finished swap, queues unloads for
    characters you're no longer playing, through QueueFree 0x40BB50 (the scripts' deferred unload).
    - Never the current one, never one in the level's own CREATURE list, and only once the queue is idle.
    - The list is forgotten on a level change.
    - It also refuses to "swap" to the character you're already playing.
  - The log now keeps the last run as `DebugTrainer.prev.log`.
  - **Camera:** it reads `[0x770614]` fresh every frame (0x436532 / 0x43691E: active body `+0x52C` or `+0x530`),
    so it does follow the new character. The leftover state is in the active camera mode (`[cam+0xE4]`, mode at
    `+0x11C`; system object `[0x6FB02C]`, vtable 0x682DA0). Waiting on a description of the symptom.
- **Camera "stays where I was" after a swap.** SwapPlayer (0x472F20) reuses the same Char slot but doesn't
  redo the level-load `"Player"` binding:
  - Level load calls `0x4AE370([0x71836C], "Player", char)`. That fills each named slot "Player" with the
    character and data resolved from its model (`model+0x7C`).
  - **The trainer now repeats that call after each swap** and logs "player rebind: bound / no slot matched".
  - Untested. If the camera is still stuck, the next lead is the camera mode state (`[[0x6FB02C]+0xE4]`).
- **In game:** unloading works: each load takes about 80 ms, and the previous character is released right
  after the swap. The `"Player"` rebind matched nothing (those slots are for something else), so it's
  removed. The camera still stayed behind (screenshot: Optimus filling the screen).
- **Camera fix:** when the game teleports the player (0x4E90C1 → 0x46B900), it then resets the player camera:
  - `[0x770610]->vtable[0x3C]()` = slot 15 = PlayerCamera::Reset 0x4A1B60 (default distances, default camera
    table 0x721DE0 → 0x71A830, clears the follow state).
  - Then 0x4A1C30, which turns the camera controller `[0x71848C]` to the player's heading.
  - SwapPlayer skips both. The trainer now does both after each swap, only when `[0x770610]` has the player
    camera vtable 0x68AE78 with 0x4A1B60 in slot 15. Untested.

## PS3Bumblebee: PS3 next-gen Bumblebee robot on PC (2026-11-07)
- **Source:** `C:\Users\skeet\Downloads\BUMBLEBEE_BCK.rar` (PS3 `ROBOT/CAR/TRANSFORMER/EVIL_*_PS3.GHG`, PS3
  `.CA3/.CAN` anims). Unpacked to `mods\PS3Bumblebee\source\`.
- **PS3 GHG format decoded** (`mods\ghg_tools\ps3_ghg.py`, `GHG_FORMAT.md` "PS3 GHG"): big-endian NU20 v0, same
  structures as PC. 8-byte commands, RSX attribute-list draw records, half-float positions, triangle lists,
  buffer offsets relative to 0x58. DXT blocks as on PC.
- **Same skeleton:** the PS3 and PC Bumblebee robots have the same 48 bones and bind pose. So it's a straight
  part-to-bone transfer and the PC animations are kept.
- **Converter** `mods\ghg_tools\ps3_bumblebee.py`:
  - 26,091 triangles, 3 PS3 diffuse maps in a 2048² DXT1 atlas in robot slot 9. Slots 0/1/11 are left alone
    because the gun, blade and transform models borrow them by hash.
  - Materials 0 and 3 point at the atlas, with no reflection mask.
  - The pelvis goes in the skinned waist record.
- **Verified offline** (read back with `ghg_scene`, textured renders in `mods\PS3Bumblebee\preview\`).
  **Installed** in Fresh Build and `Lab - VehicleJump`, with `ROBOT_PC.GHG.vanilla` backups (original
  `aeb26c80…` also in `mods\PS3Bumblebee\vanilla\`). **Not tested in game.**
- **Next step:** play any Autobot level as Bumblebee in the lab. Check the model, the gun and blade arm swaps
  (the forearms should hide) and transforming. The car and transform sequence are still the PC models.

### DebugTrainer: chapter select from the level scripts (2026-11-08)
- **In game:** character select and the camera reset work.
- **Chapter select:** the exe's table is a stub (1 chapter, "WorkInProgress"; see RE_NOTES). The trainer now
  reads each level's chapter count from its hub's `state SkipLevel` (via `LEVEL1.SCP`'s include) and drops the
  "WorkInProgress" refusal. The jump itself is unchanged: `MissionMessage = N`, then the `SkipLevel` event on
  `Level1`. The log says "chapters for X: N (hub Y)". **Not tested in game.**
- **In game:** the chapter list was greyed out; the log showed "hub none" for every level. Cause: the two path
  strings lost their `\` separators when the code was written through the shell, so the files never opened.
  - Fixed with forward slashes.
  - The trainer's own chapter code, compiled into a test program, now reports 4 chapters for the 10 hub levels
    and 0 for AutoCityBoss, DconCityBoss and Cybertron.
  - Installed. The jump itself is still untested.
- **In game:** the chapter jump faded to black, with the level still running behind it.
  - Cause: `MissionMessage` was sent before the `SkipLevel` event (the unfinished debug menu's order). The hub's
    SkipLevel state fades down on entry and then waits for the message, which had already been lost.
  - **Fix:** fire SkipLevel first, then send `MissionMessage = N` once, 0.5 s later. Only once, because chapter
    scripts also read MissionMessage (1 = complete, 2 = fail). Untested.
- **In game:** still black. SkipLevel's actions ran (Bumblebee reset to #Start, the level title "The Suburbs"
  shown again), but the hub never took the chapter.
  - Found: no script ever sends MissionMessage. Only the exe's mission-end code does (0x4BF536, on
    `[[0x6F5700]+0x1A0]`).
  - 0x54C3A0 is really SetScriptVar: FindScriptVar 0x547330, then the value at entry+0x28. So MissionMessage
    is a named value, and `[[0x6F5700]+0x1A0]` is probably the running mission's object, not the Level1 script
    that holds the hub's SkipLevel state.
  - **Next build:** sets MissionMessage on both the mission target and the Level1 script object, and logs every
    change of the value on both for 4 s, to see which one the hub reads. Built; waiting for the game to close
    before it can be installed.
- **In game:** still black. The 4-second watch showed MissionMessage set on the mission object and never read
  or cleared. The Level1 script object isn't a variable store (writing to it faulted, and the fault was
  caught). So the message route is dropped.
- **ChapterSelect (`mods\ChapterSelect\add_chapter_states.py`):**
  - FindEvent 0x53B4D0 is really "find state by name" (it walks the script's states, names at state+0x18,
    and returns 0 if none matches).
  - The script adds `state TrainerChapterN` (N = 1–4) to each of the 10 hubs. Each runs that hub's own
    SkipLevel actions plus ResetTimer, then `if timer > 1.0 goto ChapterN_InitGoto`.
  - Applied to the lab with `.chapters.bak` backups; re-running changes nothing.
  - The trainer now fires `TrainerChapterN` directly, and refuses with a hint when the state is missing.
    Installed; **not tested in game**.
- **In game:** TrainerChapterN switched (log) but went straight to black.
  - Cause: the states jumped to SkipLevel's targets (ChapterN_InitGoto). At level start the hub's
    `PrePickGoto` sends chapters 2–4 to **ChapterN_PreInitGoto** instead. That state sends `#StartMission`
    (checkpoint `#COMPPOINTx`, fade-in) and waits for `GetFinishedMissionStart` before InitGoto. Chapter 1's
    InitGoto does `#StartMission` itself.
  - **Fix:** the generator now takes each chapter's target from the hub's own `PrePickGoto` (ChapterProgress
    k → chapter k+1), falling back to SkipLevel's. Re-applied to all 10 hubs; re-running changes nothing.
    Not tested.
- **In game:** with the PrePickGoto targets the screen came back and Chapter 3 put the player at #COMPPOINT2
  (the checkpoint after Chapter 2), but no chapter started.
  - Why: that path is the hub's "go to the chapter" phase. ChapterN_Goto turns on reminders and hands over to
    GlobalActionRing. The chapter only starts when you drive into its action ring: `GlobalStartChapter`
    (#StartChapter, clear modules, rings/side missions off, counters reset), then `ChapterN_Enter`. Enter
    plays the intro text, loads the chapter's creatures, and Main places the player at `#ChapterNStart` and
    fades up.
  - **Fix:** `TrainerChapterN` now runs the hub's own GlobalStartChapter actions (copied per hub; Qatar's
    differ) and goes to ChapterN_Enter after 0.1 s, the same as entering the ring.
  - All 10 hubs have it; the SkipLevel/PrePickGoto design stays only as a fallback. Re-applied; re-running
    changes nothing. Not tested.

### DebugTrainer: noclip (2026-11-08)
- **In game:** chapter select works (TrainerChapterN → ChapterN_Enter).
- **Noclip:**
  - Toggle key `[Noclip] Key` (default N), rebindable in the menu ("Change key": the next key pressed, Esc
    cancels). Hidden from the game.
  - While on: movement keys (W/A/S/D, arrows, Space) and the left/right mouse buttons are read in the
    DirectInput hook and hidden from the game. Mouse motion still turns the camera.
  - Every frame, from a BeginScene hook (vtable 41, once per frame, not the trainer's own scene) with a
    Present fallback, the player moves by camera-relative input: forward is the flat direction camera →
    player, from the render camera `[0x77060C]+0xC` (position at +0x30). LMB raises, RMB lowers, Shift ×3.
  - The player is placed with SetTransform 0x445520 (current matrix, new position). Velocity is zeroed (body
    `[[GetActiveBody 0x437AA0]+0x34]+0x20` and `char+0x810`).
  - Off: you stay where you are, and gravity applies again.
- **Reset to nearest safe spot:** SafeRespawn 0x448AB0 (`__thiscall(char, pos[4], dir[4])`, `ret 8`), nearest
  pair on the level's "SafeRespawn" spline, +0.5 up. Levels without one (HooverDam, HooverExt, Cybertron,
  BlackoutTranquility, TestTranquility, AutoBonus1) fall back to the last spot the player stood on the ground
  (flag 0x1000000, not airborne), recorded while noclip is off.
- Built and installed. **Not tested in game.** Open questions:
  - Does SetTransform every frame cause animation jitter?
  - Are the A/D directions right? Strafe uses "right = (fz, −fx)".
  - Is the grounded flag correct?

### TF Studio: level writer works in game (2026-11-08)
- **In game (lab, Tranquility 2):** the file rebuilt by `mods\tf_studio\js\gsc_writer.js` (every chunk +16 B,
  VB 0 +64 B, so every pointer moved; 16,596,564 bytes) loaded and played. The house lifted 15 units shows
  floating above the start area (screenshot: Bumblebee under its underside).
- So: re-laid-out GSCs load, and per-draw matrix edits show in game. Size-changing edits (texture replace, new
  geometry) can build on this.
- Not yet checked: the hidden house, and whether the old collision stays (expected: yes, DNO2 unchanged).

### TF Studio: collision follows edits (2026-11-08)
- **DNO2 decoded for editing** (details in PC_GSC_FORMAT.md):
  - Bodies link to scene instances (`link >> 16`).
  - Scene instances have their own matrix, separate from the draw matrices.
  - The tree rules hold on every stock node; leaves are depth-first and contiguous.
- **Level tab:**
  - A Collision overlay.
  - Per-object collision (shape match), shown in orange.
  - "Collision follows edits": on save, the world collision is rebuilt from the load-time copy with each
    object's polygons moved or removed, a new KD tree is built, and instance matrices are updated.
- **Lab test 3 (Tranquility 2):** the lifted house's collision is lifted (73 polygons) and the hidden house's
  is removed (37). The tree checks pass and pc_dno2_check.py reports no errors. **Not tested in game.**
- **In game (lab test 3):** Tranquility 2 with TF Studio's rebuilt world collision loads. The lifted house is
  solid at its new height (landed on its roof with noclip; screenshot) and passable at its old spot. So the
  engine accepts a new KD tree from `dno2.js` and moved collision works.

### TF Studio: add objects (2026-11-08)
- **Duplicate** in the level tab: a movable preview. On save, the copy is written in as a new scene object
  (`js/scene_edit.js`) with a copy of the source's collision; the level then reloads. Layout notes are in
  PC_GSC_FORMAT.md ("Adding objects").
- Verified offline on all 9 stock levels, plus pcgsc_check / pc_dno2_check on the saved file (same warnings as
  the original).
- **Lab test 4:** a copy of the floating house stands where the hidden house was (4 objects, 10 draws,
  157 collision polygons). **Not tested in game.**

### TestTranquility crater arena from the hi-res scene (2026-11-08)
- **Source:** hi-res `DEMOTRANQUILITY\TRANQUILITY_MAIN_PC.GSC` (the only hi-res Tranquility file with collision:
  geom 40 town 75,848 polys, geom 41 outer terrain 14,361). The low-res Tranquility has **no collision** past
  z ≈ 732, so the crater is visual-only there.
- **The crater is a lake bed.** Bowl centre ≈ (870, 990), floor −38, rim crest 370–450 units out at +40…+77.
  Both versions have a flat water sheet over it (hi-res y 34: draws 6273/6373/6470/6856; low-res y 38). Water is a
  shader effect only (no swim/drown code strings) and has no collision.
- **New tool:** `mods\tf_studio\js\region_cut.js` `cutRegion(buf, {cx, cz, r, hide})`:
  - Outside draws: matrix collapsed (every draw has its own matrix; 959 records are shared by 7,118 draws, so
    records are never edited for hiding).
  - Edge draws: triangles kept by centre, re-written as a degenerate-joined strip (each triangle at an even
    position, so winding is unchanged) appended to the shared IB; the record's start/count repointed. Shared
    records are kept or hidden whole.
  - Backdrop (sky dome, clouds, far cards; object 689) kept.
  - World collision cropped by polygon centre, vertices compacted, new tree (checks pass). Bodies of hidden
    objects dropped 1000.
  - `verifyCut` re-reads the file: strips inside the IB, trees valid.
- **Result:** 343 draws kept (35 trimmed), 6,740 hidden, collision 1,808 polys, 172 bodies dropped. Installed in
  the lab's TESTTRANQUILITY as scene `Crater` (dry) plus `Crater_Lake`; spawn placement, splines (incl.
  SafeRespawn) and script changes in LAB_NOTES.md. **Not tested in game.**
- Viewer note: the hi-res terrain's first texture is often a magenta/yellow blend mask, so TF Studio draws it
  pink. That is a viewer limitation, not the file.
- **Lab test 4, in game:** crashed after load in `SetStreamSource(0, record+0x24, 0, stride)` (0x5EFCCC via
  0x556A4C, esi = draw record).
  - Draw record +24 holds the VB index in the file; the loader replaces it with the D3D vertex buffer pointer,
    but only for records it finds itself.
  - Stock files share records between draws (Cybertron: 561 draws, 253 records).
  - **Fix:** a copy's 0x82 points at the source's record, and its matrix goes right after the last stock
    matrix (the end of DISP). Re-verified on all levels and rebuilt in the lab from `.test3`. Not tested in
    game yet.
- **Lab test 4 (shared-record fix), in game:** loads and plays. The copy itself isn't confirmed yet (the
  screenshot doesn't show that spot).
- **Lab test 4 passes:** the copied house is in place and solid (landed on it with noclip). Added objects and
  their copied collision work in game.
- **In game (test 1):** TestTranquility loads and the hi-res collision is solid, but the terrain draws black.
  - Cause: the game is in Low Detail (`pcconfig.txt` `TransformersUseHires 0`, keyword table at 0x6EBE80, value
    at 0x6EC2DF, copied into flags 0x6FB1D0 bit 0x200; the `HIRES` command-line word sets the same bit).
  - Low Detail renders only CURRGEN-style vertex formats (0x901/0x909/0x80909…). Every hi-res terrain format
    (0x929, 0x1129, 0x1d29, 0xb29, 0x1309, with 0x20/0x1000 elements) drew black. Low Detail reads `PLATFORM CURRGEN`
    and High Detail reads `NEXTGEN` (0x404688).
- **Fix:**
  - **CURRGEN `Crater`:** the same circle cut from the low-res Tranquility. Its collision is built from the
    visible ground draws (textures 18 and 19), using `collisionFromGround` in region_cut.js: 526 polygons,
    surface entry 2, G 63,63, q4 493 (stock data never uses q4 0).
    - The hi-res collision was tried first (`graftCollision`; every surface matched). It was rejected because
      the low-res bowl is one 103-vertex mesh, and it sat up to ±10 units off the hi-res ground.
  - **NEXTGEN `Crater_HiRes`:** the hi-res cut. Not tested in game.

### TF Studio: named copies (2026-11-08)
- Copies can get their own scene instance (a copy of the source's, moved), so scripts and props can find them
  by name. The panel shows a Name field with a unique default (`<source>_copy1`), plus the existing object's
  name.
- Verified on all levels: old instances unchanged, new ones point at the new objects, the +88 bit is set, and
  the file rebuilds stably. `extra_props.extract` finds a copy by its name.
- Also fixed: moving an object now updates instance +40 as well as +00 (they match in stock files).
- **Lab test 5:** test 4's house with 3 named parts. **Not tested in game.**
- **In game (test 2):** the Low Detail crater draws, but you fall through it.
  - Cause: DNO2 collision is one-sided. Stock polygons have (b−a)×(c−a).y < 0 (checked on the hi-res crater:
    1,718 of 1,765 non-flat polygons; the rest are walls). 135 of 518 strip-derived triangles were the other way.
  - Fixed in `collisionFromGround` (flip to y < 0); rebuilt. **Rule for any generated collision: wind like stock.**
- **Lab test 5, in game:** a level with 3 new named instances loads and plays. The copy's windows and LOD aren't
  checked yet.
- **In game (test 3):** the Low Detail build still has no collision even with the winding fixed (cause unknown;
  maybe the strip-derived polygons, q4/G values or the low-res DNO2 itself). Dropped at the user's request.
  - LEVEL.CFG now loads `Crater_HiRes` in CURRGEN and NEXTGEN.
  - pcconfig `TransformersUseHires`/`Pending` set to 1 (backup `pcconfig.txt.lowdetail.bak`).
  - The user reports that low-res assets work in High Detail maps with this switch.

### HooverExt quick wins: building collision + PS3 props (2026-11-08)
- **Collision:** `wii2pc.py` now bakes the Wii DNO2 body shapes of instances `BuildTer_*` and `jetty*` into world space
  (vertex × shape transform × instance matrix) as extra static KD terrain, one geom each, with a new tree
  (`kdtree.py`, a port of TF Studio's `buildTree`, which is proven in game). 107 pieces, 832 polys. Polygons, per-poly bytes,
  2-byte data and surface tables are copied. Each group lines up with its visible `Build_Skin_*` / `LOD_damTowers*` within
  ~1 unit. The PS3 BUILDINGS/MAIN scenes hold the same pieces (Build1–5 = 70 bodies; Build6–10 in MAIN). The ground geom is
  unchanged; `BAKE_BODY_COLLISION = False` reproduces the previous build byte for byte. Jetty platform boxes (type 3) and
  dynamic prop bodies are not converted.
- **Props:** `ps3_props.py` extracts instanced props from the PS3 `HOOVEREXT_POS_PS3.GSC` in `extra_props` form
  (byte-swapped instance/FDNS/BNDS, RSX streams → stride-28 0x0909 vertices, triangle lists → strips, PS3 DXT → DDS, lit
  template material). `PO_bigHandRail`, `PO_bigPillarTop`, `PO_stoneBench` added via `wii2pc.PS3_PROPS`. Rendered in
  Blender: correct shapes and textures; winding agrees with normals like stock PC props.
- Lab PHYSOBJTYPES: `PObigHandRail` → `PO_bigHandRail`.
- Installed in `Lab - HooverExt` (backups listed in its LAB_NOTES.md). **Not tested in game.**

### HooverExt Phase 1: merged HDE scripts (2026-11-08)
- `mods\hde_port\merge_hoover_scripts.py --install` puts one script set into `TF Hoover Dam Edition PC`: Low Detail chapter 2
  (original SAM-debris objective) and hub debris, High Detail chapter 1 plus the debris lines, Low HOOVERDAM ch1 turret doors.
  The port also got the quick-win map, the handrail fix and the radar map. Details and test list: HOOVEREXT_RESTORATION.md Phase 1.
  **Not tested in game.**

### DebugTrainer in the Hoover Dam Edition PC port (2026-11-08)
- Installed in `TF Hoover Dam Edition PC`: `dinput8.dll` (ASI loader), `DebugTrainer.asi` + `.ini` (same build as the lab).
  Same exe (md5 6cd7b766…), so every feature's byte check passes as in the lab.
- Chapter select: `add_chapter_states.py` got `--only=LEVEL,...`; applied to the same 10 hubs as the lab. On HDE the
  HooverExt/HooverDam states copy the HDE hubs' own chapter-start actions. The HDE story slots (AutoPrologue etc.) have
  no normal chapter hubs and are left alone. The trainer reads chapters from `LEVELS\<level name>`, so use the
  `hooverExt` / `HooverDam` entries, not the reused slots. `merge_hoover_scripts.py --install` now reminds you to
  re-add the states afterwards.

### HooverExt chapter 2 crash → HooverFixes.asi (2026-11-08)
- **In game (HDE PC port, trainer jump to hooverExt chapter 2):** crash, dump `Transformers.exe.4880.dmp`:
  c0000005 at 0x502D88 reading address 4.
- **Chain:** #ClearIt module (update 0x4E4DE0; uses the strings "LO_", GreenRing/YellowRing/Beacon) → 0x502950 finds
  no `LO_<site>` debris props in its 3-unit spheres → fallback 0x502CA0 queries the physics scene ([0x724294])
  for bodies and treats each as a prop: id at +0x84 → pool `id>>8` / slot `id&0xFF` in the prop manager [0x724280]
  (+0x23B0 type→pool, +0x15210 pool index table, 8 B pool entries, 16 B slots). The lookup returned null.
  The sphere was 1 unit from `LO_A4C2A_HVE_GENERIC15_1` (SAM site A).
- **How debris becomes props:** 0x503010 (called by #SpecialObj 0x4DCAAB and by #ClearIt 0x4E4F0A) takes the
  instance name `LO_<tag>_<TYPE>_<n>`, forms `PHYSOBJTYPE_<TYPE>`, and spawns from that type's pool via
  0x4FBF30 (returns 0xFFFF when the type has no pool or no free slot). All 6 debris/hatch types' models exist in the
  PC map.
- **Fix:** `mods\HooverFixes` (new ASI, installed in the HDE port). The fallback skips non-prop bodies (0x502D83 04 → 1C),
  like the sibling loop at 0x5034C4.
- **Still unknown:** which body was hit (heap not in the dump), and whether the debris props spawn on PC (pool sizes
  are set at level load, not traced). **Not tested in game.**

### HooverExt Phase 2: jetty platform collision (2026-11-08)
- `wii2pc.py` now bakes box bodies too (`BOX_COLLISION_PREFIXES = ("jettyPlatform",)`). Wii shape type 3: the 3 floats are half
  extents (2.89 × 0.60 × 8.53), centred on the shape transform × instance matrix; they match the instance bounds exactly.
  Each box → 8 verts / 6 quads, stock winding (computed normal points into the solid). The unknown per-poly u16, surface byte
  and 2-byte data are copied from the `jettyGangway` polygon facing the same way. 5 platforms, 30 polys, at y 128.7–130.
- Rebuilt with boxes off = byte-identical to the installed quick-win map. Readback (pc_dno2_check, kdtree check): no errors.
- Installed in `Lab - HooverExt` and `TF Hoover Dam Edition PC` (backups `.pre_jetty`, `_hde_port_backup\phase2_map`). **Not tested in game.**
- Rest of Phase 2 dropped: `PO_palmTree3` isn't in HooverExt's PHYSOBJTYPES; no placement (min z −824) or spline (min z −880)
  reaches Low Detail's extra south strip (z < −1300; the ground ends at −1288).

### TF Studio: cutscene player (2026-11-08)
- New **Cutscenes** tab plays `CUT\*.CU2` in its level (from the cutscene's `.CFG`), with its characters, cameras,
  cuts and the level pieces it moves. Format notes: `CU2_FORMAT.md`.
- **Findings:**
  - Root blocks keep extra values in front of their constant pool.
  - Skeleton tracks rotate bones relative to the bind pose (normal `.AN3` clips are absolute).
  - Object tracks have absolute rotations and offset translations.
  - There is no field of view in the file.
- All 64 load. Level scene builder: cloud layers (alpha meshes above the level) are now blended instead of cut out,
  which also fixes the floating "camouflage" patches in the level tab.
- Shared character code moved to `js/rig.js` (model tab checked after the move).
- **Not compared with in-game playback.**

### HooverExt visitor centre drew in pieces → fixed (2026-11-08)
- **In game (HDE port):** the visitor centre showed orange window bands and marble ledges floating apart, no dark window
  walls, no green roof (user screenshot).
- **Cause:** the PC engine draws every piece of an instanced object with the **instance** matrix. In all stock PC levels
  (Tranquility 2, HooverInt, Qatar, Airbase, City: ~14,000 instanced draws) the 0x83 matrix before each piece equals the
  instance matrix. The Wii places some pieces with their own 0x83 matrix: 34 draws in 11 objects, all visitor centre
  (`Build_Skin_50…52`, their `BUILDTYPE`/`BUILDINTTYPE` templates, `LOD_visitorCentre`). A render with instance matrices
  reproduces the screenshot exactly. Geometry, textures (DXT alpha checked) and materials were fine.
- **Fix:** `wii2pc.py instance_offsets()` bakes R = inverse(instance) × draw matrix into those geometries' vertices
  (every user of a geometry has the same R) and points their 0x83 commands at the instance matrix. Result: only the 4
  extra prop templates (parked, identity matrix) still differ. Render of the rebuilt file = the PS3 High Detail building
  (`mods\wii_tools\out\visitor_centre_before.png` / `_after.png`). Checks: pcgsc_check / pc_dno2_check as before.
- Installed in the HDE port and `Lab - HooverExt` (backups `_hde_port_backup\vcfix_map`, `.pre_vcfix`). **Not tested in game.**
- **Cutscene sound (same day):**
  - The cutscene sound lives only in the game's Bink videos (`fmv\MultiLang\*.bik`).
  - `mods\tf_studio\Extract cutscene audio.bat` (Blender's FFmpeg) writes each soundtrack to `cutscene_audio\*.ogg`:
    52 tracks, 22 MB.
  - The player plays them in sync with the timeline (within about 0.05 s; the sound is the clock while it plays).
  - 60 of 64 cutscenes have sound.
  - The local server has no range requests, so each track is loaded whole (otherwise the browser misreads the
    length and can't seek).

### HooverExt: well beside the visitor centre capped and textured (2026-11-08)
- **In game (HDE port, user screenshot at 471.6, 168.8, 497.3):** untextured tan walls; players could drop in and walk into the tower.
- **Cause:** Wii material 141 has no texture and its mesh no UVs (walls of a small well, x 467.85–477.98, z 491.2–504.6).
  The ground collision dips from the walkway (y 175) to ~157 there. PS3 High draws nothing at that spot.
- **Fix (`wii2pc.py`):** `MAT_TEX_OVERRIDE = {141: 243}` (tan concrete) with box-projected UVs (`UV_PLANAR_SIZE` 6).
  `CAPS`: a walkway quad at y 175.02 added to the neighbouring pavement geometry (material 230, UVs fitted to its own
  planar mapping) and a static collision quad with the surface data of the nearest walkway polygon (9 units away).
  Checks: pcgsc_check / pc_dno2_check as before; collision quad faces up.
- Installed in the HDE port and the lab (backups `_hde_port_backup\well_map`, `.pre_well`). **Not tested in game.**
- **Level-folder cutscenes (same day):** the Cutscenes tab also lists the 125 `.CU2` files in
  `LEVELS\*\CUTSCENES` and `FRONTEND\CUTSCENE`. They play in the scene that the level's `LEVEL.CFG` names.
  - All 125 load with no errors.
  - The front-end menu animations move their pieces (376 of 388 found).
  - Hoover Dam's door and generator animations move pieces that don't exist in the PC scenes; their `LEVEL.CFG`
    lines are commented out.

### PS3 HooverExt converter, step 1: vehicles scene (2026-11-09)
- **`mods\wii_tools\ps32pc.py`** (new): PS3 scene → PC GSC as a subclass of `wii2pc.Conv`. It reuses the DISP / INID /
  BNDS / FDNS / NTBL / DNO2 / GSNH writers and overrides only the container reader (`PS3NU20`), textures (DXT data
  copied; alpha read from the blocks), materials, geometry (RSX streams, triangle lists → one strip) and two hooks.
- **`wii2pc.py`** got hooks `draw_matrix_col` (Wii 3×4 / PS3 4×4 row-vector) and `jump_index` (Wii: from the command
  start / PS3: from the pointer field, `(v + 4) // 8`). The Wii map rebuilds byte-identical (md5 6abbd482…).
- PS3 material facts found: records are 1168 B – 16 KB; index = order of the 0x80 targets; +0x25C diffuse; byte
  +0x424 = 0x04 only on opaque DXT1 materials (0x14 / 0x18 on the alpha ones). Instanced objects take their material
  from the per-object tables, as on the Wii.
- `HOOVEREXT_VEHICLES_PS3.GSC` → `HOOVEREXT_VEHICLES_PC.GSC` (1.2 MB): 28 objects, 73 materials, 49 textures (5 without
  data → grey 4×4), 83 draws. pcgsc_check / pc_dno2_check: same result as the working maps. Read back and rendered from the
  PC file: every vehicle has the right shape and texture.
- Installed in `Lab - HooverExt` as an extra NEXTGEN scene (`LEVEL.CFG.pre_ps3` backup). **In game ✅ (2026-11-09, High Detail): loads, vehicles appear.** Needs
  High Detail (pcconfig is currently `TransformersUseHires 0`).
- **2026-11-09:** crater arena shelved (files in `mods\CraterArena`). Lab TestTranquility is restored, plus the vanilla
  Tranquility map. Open finding: the game rewrites `TransformersUseHires` to 0 at start-up in this lab (cause not found).

### Combat hub: TestTranquility + DebugTrainer 0.2 Opponents panel (2026-11-09)
- **Goal (user):** TestTranquility as a long-term testing hub for combat and special abilities, with any character
  available as an opponent.
- **Spawn recipe** (from the shipped boss fights):
  - Brawl in CITY AUTO5CHAP3 uses `#Script=Combat #Boss #SpawnAsCreature`.
  - Megatron in AUTOCITYBOSS uses `#ForcePlayerAsOpp`.
  - Scripts load first (`#LoadCreature`) and spawn in a later state.
- **States:** script states are a linked list (FindEvent 0x53B4D0 walks `script+0x10`), so there's no fixed state
  table at lookup. Shipped scripts have at most 65 states and 42 KB; the hub has 138 states and 41 KB.
- **`mods\CombatHub\make_hub.py`:**
  - Generates `Hub<Mode>_<Type>` states for 33 types (from CREATURES.CFG `CHARACTER`s, skipping parts and peds),
    in four modes: Fight, Boss, Dummy (`StandAndWait`) and Wave (×3).
  - Adds `HubArena` (baseball field, collision ≈13.5) and the `HubSpawn` spline.
  - `Main` follows the shipped order: DestroyAllModules first, then `#General`.
- **DebugTrainer 0.2:**
  - `FireHubState` tries every script slot.
  - Opponent loads reuse the character-select loader and `g_loads`, so the trainer frees what it loaded.
  - `ReleaseUnusedLoads` never frees the live opponent, and waits 2.5 s after a clear or replace.
  - Replacing an opponent fires `HubClear`, then the new state 0.4 s later.
- Built (MSVC, no new warnings) and installed in the lab. **Not tested in game.**
- **Props scene (step 2):** `HOOVEREXT_POS_PS3.GSC` → `HOOVEREXT_POS_PC.GSC` (12 MB): 76 objects, 66 materials, 141 textures (15
  without data → grey), 102 draws. New `ps32pc.HIDE_INSTANCES` + optional `wii2pc` hook `hide_cmds` (draw commands pointed at an
  empty draw record): hides the 15 renamed debris pieces (`HooverExt_EW_POS_156_LO_…`), which share their geometry with the
  `LO_girder*` templates, so only the commands are hidden. Wii map still rebuilds byte-identical. Installed in the lab; **not tested in game.**

## Session 4: special-move sounds (2026-11-09)
- **Cause:** sounds stay loaded only while marked "needed" each frame (0x5D4570(handle, 0x5BD670), a
  per-frame bitmask at 0x2B84030). Each boss does that in its per-character update 0x448C60 (called from
  0x46BA8C). The game skips that update for player-controlled characters (`+0x62C` bit 14, check at 0x46BA70).
  - **Bumblebee (0x446370):** the same update also fills the Sonic Boom sound handles: `+0x7D0` =
    `bb_shockwave_charge`, `+0x7D4` = `bb_shockwave_blast`, flag `+0x7CC` bit 2. For the player these stay 0,
    so Sonic Boom phases 3 and 5 (0x4530D1 and 0x45320C → 0x5D45D0) played sound #0.
  - **Megatron (0x405110):** keeps `veh_megatron_jet_afterburn_lp` loaded. His flail update (0x4528D0) plays it
    and `fire_md` by name (0x5D4600).
  - **Ironhide (0x438180):** boss phase timers only, no sounds.
- **Notes:** 0x518B20 on `[0x6FB218]` plays a VFX by ID, not a sound (the shockwave's 0xAA). 0x5BD810 = find
  sound by name.
- **SpecialMoves 0.7:** each frame, for the player only, it marks those sounds needed and fills Bumblebee's
  handles if they are empty (setting `FixSounds`). AI parts of the update are not run. Built; **not installed
  yet (game was running)**, not tested in game.
- 0.7 installed in the lab (SHA-256 `8A1A4B858B99273E…`).

### TF Studio: Blender round trips, props and spawns (2026-11-09)
- **Meshes:**
  - Scene objects export to `.glb` (one Blender object per draw, textured) and edited `.glb` files import back.
    The import appends vertices and strips and points the draw records at them.
  - Lab test 6 = test 5 plus house `Build_Skin_459` made 1.5x taller in Blender, with a new cube.
    Checkers = stock. **Not tested in game.**
- **Blender export:** characters with all their clips (model tab), and whole cutscenes with characters, cut camera,
  set pieces and nearby level (cutscene tab). Both check out in Blender renders.
- **Props:**
  - `NEWPHYSOBJ.DAT` decoded: cells plus 12-byte props, positions in 1/100 units, a Y-quaternion turn, and the type
    index. The level tab draws, edits, adds and deletes props.
  - Lab test 7: four lamp posts and a phone booth in front of the test 6 house, in both the normal and `_NG` files.
    **Not tested in game.**
- **Body copies:** named copies of scene objects with a DNO2 body now get a copy of the body, its shapes and their
  transforms. Checked on a lamp-post template copy (structure and checkers); the stock bodies are only on templates
  and world-space building pieces, so the prop editor is the useful route.
- **Spawns:** the level tab lists the mission scripts' creature spawns, shows them at their splines, and edits
  type, count, max alive, spline and on/off, rewriting only those lines.
- **In game:** the combat hub works (user, 2026-11-09). The user enabled High Detail; the lab had no hi-res scene files
  in any level. The 4 hi-res DemoTranquility scenes were copied into lab TESTTRANQUILITY; the arena heights match
  (hi 12.6/13.5 vs low 12.8/13.6). Not yet checked in game.

### LevelSelect7: HooverExt back in the front-end level select (2026-11-09)
- **Goal (user):** show HooverExt in the main-menu level select (Story > Replay Level) next to Cybertron.
- **Cause (static reading):** each side's list is a chain from DemoTranquility / Qatar (0x6BB3B0) through each
  level's `UnlockedBy` (record +0x288). HooverExt's line was commented out, and the exe caps a side at 6
  (LevelAt 0x474FD0, Progress 0x475090, limits at 0x4755F7 / 0x475FB1, 12 picture slots at frontend+0x2882C).
  The Autobot chain already had 6 with Cybertron last.
- **Fix:** `mods\LevelSelect7` (ASI): LevelAt/Progress replaced with versions that stop at the chain's real end,
  limits 6→7, picture slots moved to a 14-slot DLL array (all 17 accesses found by byte search). Data: HooverExt
  `UnlockedBy Level HooverInt` on, City → `UnlockedBy Level HooverExt`, `HooverExtImage` in FRONTEND.GUIC.
  Details in the mod's README.
- Built (MSVC) and installed in `Lab - HooverExt`; data edits also in Fresh Build (backups `.pre_lvlsel7`).
  Replacement encodings checked with Capstone. **Not tested in game.**
- **HooverDam too (user):** HooverDam `UnlockedBy Level Airbase` re-enabled, InTheCity → `UnlockedBy Level HooverDam`,
  `HooverDamImage` (SCREEN_HOOVER_DAM) added. Both sides now have 7. Same folders and backups. **Not tested in game.**

### TripleCFlightCam: Blackout's flight camera for TripleC (2026-11-09)
- **Cause:** the camera preset switch in 0x49FF10 (at 0x4A0D46) covers identities 1–14. TripleC is identity 15, so
  both its forms get the generic default preset (0x721B10 / 0x721DE0): half Blackout's distance (12.5 vs 25), with
  lower height and lag values. Blackout (identity 10) gets its own heli preset 0x71A9A0.
- **Correction:** identities are not the vehicle profile numbers. Blackout = identity 10 (profile 8), Starscream = 9
  (profile 7), TripleC = 15 (profile 14). The car/transform table at 0x47253C and the camera table both index by
  identity − 1.
- **Fix:** `mods\TripleCFlightCam` ASI. It moves the jump table to a 15-entry copy (0x4A0D53) and raises the limit
  0xD → 0xE (0x4A0D49). Identity 15's entry sets Blackout's heli preset for vehicle form; robot form is unchanged
  (INI `RobotCamera=Blackout` to change it).
- Also found, not changed: TripleC's heli uses the AI attack-helicopter flight model (0x41C2C0, aircraft `+0x368` = 7)
  where Blackout has 0x41CD20 and `+0x368` = 8.
- Built (MSVC, 32-bit) and installed in `Lab - VehicleJump`. Patch bytes checked with Capstone. **Not tested in game.**
- **0.2 (same day):** in game, 0.1 loaded and patched (log), and the swap's camera reset applied it. The user said the
  heli camera still needed work. Added Blackout's flight model: hook on `call 0x41C2C0` at 0x43FA18 runs TripleC's
  own setup (keeps its gun positions), then writes the 13 fields where 0x41CD20 differs and `+0x368 = 8`. INI
  `FlightModel=Blackout|Default`. Hook disassembly checked (saves esi, ebx untouched). Installed in
  `Lab - VehicleJump`. **Not tested in game.** The heli is only set up when it loads, so test after a fresh swap or
  level load.
- **In game after 0.2 (user):** steering still wrong and camera still bad, "always this bad". Ruled out statically:
  model facing (both heli models point the same way), steering routine (both clear `+0xA2D` bit 0x20 → 0x4400C0),
  the flyer list at 0x43BB59 (identities 8/9/10) and the vehicle profile `+0x68` controller (0x45D8A0, ID 0x10 = four
  attached parts shown/hidden, visual only), `BLACKOUT_HELI`/`TC_HELI` (weapon sound names), the identity tables at
  0x43AE00 (paint) and 0x44F060 (+0x5D4 level cap).
- **0.3:** F8 dumps the active vehicle profile, aircraft (0xA90 bytes) and camera preset to
  `TripleCFlightCam_dump_id<identity>_<n>.bin` next to the exe, for a Blackout-vs-TripleC diff in flight (diff script in
  the session scratchpad: `dumpdiff.py`). Installed in `Lab - VehicleJump`.
- **Dumps (user, 2026-11-10):** Blackout in flight → active preset 0x71AF50; TripleC → 0x721DE0. So flight uses
  **slot B** (`[0x7184C0]`), not slot A: 0.1–0.3 had changed TripleC's on-foot camera. TripleC's flight camera sat at
  distance 7.5 (Blackout 25). The heli steering reads the active preset (`+0x7C`), and TripleC's steer target
  (aircraft `+0x1C0`) stayed at his own position, so the same bug broke steering. Handling fields +0x100..+0x2A0 now
  match Blackout's (0.2 worked). Other aircraft differences are live state, locators, and health (`+0x9E4`
  1500 vs 4000).
- **0.4:** stub now sets slot B = 0x71AF50 (Blackout's flight preset), slot A = 0x721B10 (default, or 0x71A9A0 with
  `RobotCamera=Blackout`). Stub bytes checked in the built DLL. INI installed in the lab; the `.asi` copy failed
  because the game was running. **Not tested in game.**
- 0.4 `.asi` installed in `Lab - VehicleJump` after the game closed (copies verified identical). **Not tested in game.**
- **0.5:** user preferred Blackout's on-foot camera for TripleC (what 0.1–0.3 gave by accident). `RobotCamera` now defaults to `Blackout`. Lab INI set to `RobotCamera=Blackout` (works with the installed 0.4 too); the 0.5 `.asi` is built but not copied, because the game was running.

### Bonecrusher: wheels, car camera, R view (2026-11-10, in progress)
- **Wheels:** Bonecrusher's `CAR_PC.GHG` has no wheel parts (Bumblebee's has `L_front_wheel`…, Barricade's
  `fl_wheel`…). The game draws the shared part `BONECRUSHER_WHEEL` (name table 0x6B55F8, entry 0x6B5710), which
  `LEVELS\<lvl>\VEHICLESKINS.CFG` maps to a scene model: `OBJECTSKIN bonecrusher_wheel / MODEL bonecrusher_wheel1`.
  Only Airbase has both the mapping and the model (`AIRBASE_PC.GSC`); HooverExt has the mapping only.
  Sizes (w × d): bonecrusher_wheel1 0.71 × 2.0; OPTIMUS_wheel1 0.91 × 2.0 (City, Tranquility2);
  ConvoyTruckWHEEL 0.36 × 1.3 (Airbase, Qatar); HumveeWheel 0.39 × 1.0. HooverExt has nothing over 0.76.
- **Camera:** identity 14 → slot A 0x71AC80, slot B 0x7219B0 (also Brawl id 2, Ironhide id 7). Bumblebee id 3 → slot A
  0x721B10, slot B 0x721DE0 (0x71AF50 in Qatar).
- **0.6 dump (TripleCFlightCam):** F8 now also saves the car body (profile+0xC → +4, 0x7F0), the player camera
  `[0x770610]` (0x400) and the render camera `[0x77060C]` (0x100), and whether R is held (`_R` in the file name).
  Installed in the lab.
- **Wheel route (user chose the real wheel):** other cars carry wheels inside `CAR_PC.GHG` under free-form names
  (`rightFtonrWheel`, `l_wheel_9`…), so the engine doesn't look them up by name; Bonecrusher's model has none.
  - **A (preferred):** a one-object scene `BCWHEEL_PC.GSC` (bonecrusher_wheel1 + its material/texture) added as an
    extra `SCENE` to every level, plus the `VEHICLESKINS.CFG` line. Same system as Airbase, so the wheels should
    spin/steer. The SCENE handler 0x4A3470 fills up to 8 slots (`[0x7184B8]+0x10`) with no platform check.
  - **B:** bake the wheel into `CAR_PC.GHG` (likely static wheels; Airbase would double up).
  - Not reusable as-is: region_cut keeps the whole file; wii2pc.Conv converts whole scenes. A needs a small
    PC → PC subset writer.
- **Test set up:** `Lab - HooverExt` `LEVEL.CFG` CURRGEN now also lists `HooverExt_Vehicles` (known-good PS3 vehicles
  scene; backup `LEVEL.CFG.pre_currgen_test`). If the PS3 vehicles show without High Detail, route A works.
- **Dumps (user, 2026-11-10):** Bumblebee (id 3) drives on 0x721DE0, Bonecrusher (id 14) on 0x7219B0; R doesn't change
  the preset. R sets camera `+0x2AC` bit 0x200 (0x40D → 0x60D) and swaps `+0x2E0`. Live distance: Bumblebee ~13,
  Bonecrusher ~6, with the same base 7.5 (+0x48/+0x158). Bonecrusher's car model is Optimus-sized (9.5 long, 4 tall).
- **R view found (0x4B8B3F):** camera in front of the vehicle looking back; height/forward from byte table 0x4B8F38 by
  vehicle profile → jump table 0x4B8F20. Profile 12 (Bonecrusher) has no case and gets the fallback 0 / −2.5 (inside
  the Buffalo). Optimus 1.5 / 9, Bumblebee 1 / 5, Ironhide 1 / 6.5, Jazz 0.5 / 4, Barricade 0.4 / 5.
- **New `mods\CharacterCams` 0.1** (replaces TripleCFlightCam; both patch the camera table, so only one may be installed):
  TripleC unchanged; Bonecrusher slot B = a copy of Bumblebee's preset made at each reset, distance 13, height +0;
  R view case for profile 12 (height 2, forward 10). All in `CharacterCams.ini`. Preset builder disassembly checked.
  Installed in `Lab - VehicleJump` (`TripleCFlightCam.asi` → `.disabled`). **Not tested in game.**
- **Extra scenes on current-gen: confirmed statically.** Scene loader 0x4A3BE0 loops over all 8 name slots
  (`[edi-0x20]`) and loads `%s\%s.gsc` for each; the platform filter is only in the config parse. User's HooverExt
  check was inconclusive (PS3 vehicles overlap the normal ones), so the lab LEVEL.CFG was restored. Next: build the
  one-object `BCWHEEL_PC.GSC` (PC → PC subset writer) for route A.
- **In game (user video, 2026-11-10):** R view good. Driving: the camera kept snapping onto his back door ("jumps
  forward") and was otherwise just above the rear of the roof. F8: base distance 13 but live distance 5.56.
- **Cause:** the chase camera (0x4AEF10) casts a collision ray from its aim point toward the camera
  (0x4B1040, `call [eax+0x20]`, out = hit distance → clamp `[esp+0x60]` → preset +0x128 at 0x4B1209). The aim point is
  low inside the Buffalo, so the ray hits his own rear (tail at 4.8 from centre). Bumblebee is small and low, so his
  ray leaves cleanly.
- **CharacterCams 0.2:** call site 0x4B103E (`8B CB FF 50 20`) → E8 thunk → HookCameraRay: runs the original and
  ignores hits under `[Bonecrusher] IgnoreRayHitsUnder` (6) when the player is identity 14 with `+0x628` bit 18 (vehicle
  form). F8 logs how many hits were ignored. Hook disassembly checked (thiscall-compatible, ret 0xC). Installed in
  `Lab - VehicleJump`. **Not tested in game.**
- **In game 0.2 (user):** only 6 own-body hits ignored in ~1 min. F8: live distance 5.56, 14.86, 5.56. So the ray was
  rarely the limit. The real one: the max chase distance is `lerp(preset+0x130 near, +0x134 far, t)` (0x4B07C9..
  0x4B0881, t ≤ 1, grows with speed) → clamp `[esp+0x60]`. Bumblebee's near is 0.75, so a slow or stopped Buffalo
  got ~5.6. The second ray (0x4B09D5) only lowers `+0x158`, which stayed 13 in all dumps.
- **CharacterCams 0.3:** Bonecrusher's preset gets near 9 / far 22 (`CarNearDistance` / `CarFarDistance`). Ray hook
  kept. Installed in `Lab - VehicleJump`. **Not tested in game.**
- **In game 0.3 (user video):** camera now behind him but at bumper height (his back door fills the screen), sometimes
  swinging to his side. F8: live pitch +0x7C = −4000 = default +0xBC (22° down; +0x68 = sin = −0.37); Bumblebee's
  dump had −8353. The aim point sits low on the vehicle, so 10 units back at 22° the camera is ~3.5 up, below the
  Buffalo's 4.35 roof.
- **CharacterCams 0.4:** `CarHeight` default 3 (added to +0x4C/+0x50/+0x54; +0x54 is added to the aim point's y at
  0x4B1088). New `CarPitchDegrees` (default 27, clamped to the preset's 16.5–49° limits) → +0xBC/+0xC0/+0xC4 and live
  +0x7C. Installed in `Lab - VehicleJump`. **Not tested in game.**
- **In game 0.4 (user: "awful"):** the camera went almost top-down right above the Buffalo and didn't turn with him.
  So `CarHeight` (+0x4C/+0x50/+0x54) moves the **camera** up, not the aim point; +3 with 27° made it top-down.
  Hand-tuning Bumblebee's preset wasn't converging.
- **Optimus's car preset 0x721C80 = a copy of the truck preset 0x7219B0** (rep movsd at 0x4A02F5), heights −0.4/−0.5,
  far 5. Truck preset: start 12, near 12 / far −2 (so it zooms *in* with speed), pitch −6000 (33°).
- **CharacterCams 0.5:** `CarCamera=Truck` (default) bases Bonecrusher on 0x7219B0 with near 12 → far 14 (pulls out
  slightly instead of in), distance 12, height 0, pitch 33° (its own), plus the own-body ray fix. `Bumblebee` keeps the
  old route. INI notes corrected. Installed in `Lab - VehicleJump`. **Not tested in game.**
- **In game 0.5 (user):** camera close to right; "he still hops when he drives". Video at 20 fps: the horizon holds
  still while the Buffalo's top edge travels ~100 px (of 360) and back, about once a second, so the **truck** bounces.
- **Cause (likely):** car setup 0x442880, type switch 0x442B20 (table 0x4445B8, index type−1). Bonecrusher (type 0x25,
  case 0x443F4F, flag `+0x7E1 |= 8`, shared only with Brawl) uses params 0x432F90; Optimus 0x4344A0. Six wheels via
  0x6531B0 (record +0xA0/+0xA8/+0xAC/+0xD0/+0xDC/+0xE0/+0xE4/+0xEC). +0xA8/+0xAC are tyre grip (load × grip at
  0x65829A/0x6582FA): Bonecrusher 5/3 (mid 4.5/3) vs Optimus 3/2 (mid 3.5/2.5). Mass +0x70 600 vs 750, +0x54 −0.85
  vs −0.1, wheel y −0.9 vs −0.3.
- **CharacterCams 0.6:** hook at 0x443F6B runs his setup (wheel positions kept), then copies Optimus's body block
  +0x40..+0xA8 and the per-wheel tuning fields. `[Bonecrusher] Handling=Optimus|Default`. Disassembly checked
  (ret 4, registers kept). Installed in `Lab - VehicleJump`. **Not tested in game.**

### Bonecrusher wheels: route found (2026-11-10)
- **THINGS is searched for vehicle skins.** Skin models such as `BB_brakeLights`, `BB07_reverseLights` and
  `OBJ_CAR_genWheel2/3` exist only in `STUFF\THINGS_PC.GSC` (0.9 MB, loaded in every level), yet the skins use them
  everywhere. So one `bonecrusher_wheel1` added to THINGS covers every map. No LEVEL.CFG or scene edits per level;
  each level's `VEHICLESKINS.CFG` only needs the `OBJECTSKIN bonecrusher_wheel / MODEL bonecrusher_wheel1` line.
  (No HooverExt or PS3 scene has his wheel.)
- **Why new draw records crashed (lab test 4), solved:** GSNH holds the loader's draw-record list:
  `{count, X, 0, then count pointers → every draw record}`. Airbase GSNH+0x193C = 2133 (= its 2,133 records), City
  +0x1A78 = 2144, THINGS +0x560 = 123. The fields before it: TST0 / VBIB pointers, counts (13 / 1 / 0x10). Only
  listed records get their +0x24 VB index replaced by the D3D buffer. A new record must be appended to this list and
  the count raised.
- **DISP geometry region (+0x7C):** a 20-byte zero header, all draw records back to back (Airbase 2,133 × 100 B),
  then the matrices to the end of DISP.
- **Airbase scene make-up (14.3 MB):** VBs ~7.5 MB, IB 0.77 MB, 365 textures ~3.5 MB, NU20 ~2.6 MB. A whole or trimmed
  copy per level is too heavy, and wii2pc.Conv only reads Wii-style sources, so a from-scratch PC writer is big.
- **Plan:** in THINGS, via TF Studio's tested JS (GSCFile, addObjectCopies, applyMeshEdits) driven in the browser:
  (1) a named copy `bonecrusher_wheel1` of an existing THINGS wheel; (2) give it its own draw record, appended to
  the DISP record region and to the GSNH record list (new); (3) import the Airbase wheel's mesh into it
  (mesh_io); (4) add its texture (container + TST0/GSNH texture tables) and a copy of its material (MS00 + DISP
  68 B material record + GSNH material table) (new); (5) skin lines in every VEHICLESKINS.CFG.
- **Built (`mods\BonecrusherWheel\make_wheel.py`):** repurposes THINGS's `BUTTON_WII_Z` (no references to any
  BUTTON_WII_*/BUTTON_PS2_* in the exe or data; material 66 / texture 25 used only by the four BUTTON_WII_*). The Airbase
  wheel (200 verts, stride 36, fmt 0x4000909 → first 28 bytes = 0x909) goes into THINGS VB 2 (base 4084) and the IB
  (start 12122, 334 indices). The four BUTTON_WII_* records point at it; texture 25 = Airbase texture 296
  (byte-identical); material 66 gets genWheel1's +0x40/+0xB4/+0x120/+0x1F0. Bounds recomputed. Draw matrix ==
  instance matrix for all of these, so the mesh is copied in its own space. No index table changes; the file grew
  907,972 → 912,068 bytes.
- **Checks:** pcgsc_check unchanged by the object table (7 stock CUBEICON mismatches); read back, the wheel is
  0.71 × 2.0 × 2.0 with 192 triangles and the identical texture.
- **Lab install (`Lab - VehicleJump`):** `STUFF\THINGS_PC.GSC` (backup `.pre_bcwheel`); `VEHICLESKINS.CFG` in every
  level except Airbase → `OBJECTSKIN bonecrusher_wheel / MODEL BUTTON_WII_Z` (HooverExt's existing line changed from
  `jeeepWheel`; backups `.pre_bcwheel`). **Not tested in game.**
- **In game (user): "he has no wheels."** Cause: the skin `MODEL` lookup (0x436F80 → 0x5867C0 → 0x584DF0, `name_NG`
  then `name`) searches only the 8-slot scene list 0x2B7BF14, which only the level scene loader fills (0x4A3D0A,
  `call 0x584DD0` per `SCENE`). THINGS isn't in it, so the earlier THINGS evidence (BB_brakeLights etc.) was wrong:
  those skins just fail.
- **Fix: `make_scene.py` → `BCWHEEL_PC.GSC`,** the wheel THINGS with every other instance renamed `~…` (same length),
  every other draw matrix collapsed below the world, and the wheel moved to (0, −3000, 0) with its bounds. Same
  layout; pcgsc_check same as before.
- **Lab:** THINGS restored to stock. `BCWHEEL_PC.GSC` in 9 PATH folders. `SCENE BCWheel` added to every LEVEL.CFG
  except Airbase and the menus (CURRGEN and NEXTGEN blocks; Cybertron's loose list). Backups `LEVEL.CFG.pre_bcwheel`.
  The skin lines from before stay. **Not tested in game.**
- **In game (user video, BCWheel scene):** the wheels now load (correct tread and texture), but only 1–2 show per
  side; the rear axle is bare. The truck tips, bounces and the underside parts poke out.
  - Car physics object = car +0x150 (built by 0x655EB0 from the handling block): wheel count u16 at +0x1A0 (car
    +0x2F0), live wheel records (0x100 each) via pointers at +0x1AC (car +0x2FC), allocated right after the car
    block. Bonecrusher has 6.
  - 0x42E2D0 caps the per-wheel **tyre-track** buffers at 4 (car +0x140..+0x14C), not the wheel models. The
    skin-wheel drawing limit is not found yet. Value 70 (BONECRUSHER_WHEEL's part index) at 0x425061 / 0x43BCDB is
    unrelated (weapons).
- **CharacterCams 0.7:** F9 = 4 s physics trace (car block + 8 × 0x100 wheel records + profile every ~10 ms) →
  `CharacterCams_trace_id<identity>_<n>.bin`. Installed in the lab.
- **Airbase video (user):** all six wheels show there (middle pair rides visibly higher). So the "missing" wheels
  elsewhere were buried, not undrawn.
- **F9 trace (Airbase, driving, 400 samples / 4.3 s):** ride height (body − wheel centres) swings 0.98–1.32. Suspension
  travel is 0.5 (live wheel +0xD4 = compression, 1.00 = no contact). The middle pair (wheels 2/3) repeatedly loses
  contact and the right side bottoms out past full compression (extension −0.07), with wheel force (+0xB4) spikes to
  12,662 against a rest value of −735.75 (= −mass × 0.981). That's the hop.
- **Suspension formula (0x657F3E..0x658032):** force = curve(compression) × wheel +0xDC; minus wheel speed ×
  (+0xE0 compressing / +0xE4 extending); capped at mass × 50. The live wheel record is a 1:1 copy of the handling
  block's wheel record (0x6536B0). Live values: +0xDC 1.0, +0xE0/+0xE4 0.5, +0xA0 (wheel radius) 0.566 (Optimus's);
  his drawn tyre radius is 1.0, so it sank 0.43 into the ground.
- **CharacterCams 0.8:** the handling hook also sets per-wheel damping `WheelDamping` (default 2, was 0.5), spring ×
  `WheelSpring` (1) and radius `WheelRadius` (1.0). Hook disassembly checked. Installed in `Lab - VehicleJump`.
  **Not tested in game.**

### VehicleJump 0.2 + DebugTrainer 0.3: no more hopping on W; vehicle jump is a trainer toggle (2026-11-10)
- **User:** "why is Bumblebee bouncing when I press W?" VehicleJump.log: `vehicle jump (Direct)` at 17:05:17.5 / 18.6 /
  23.0, about one Cooldown (1 s) apart while driving. So the trigger bit was held, not pressed.
- **Cause:** VehicleJump treated `Char+0x684 & 0x8000` as "jump pressed". The game sets that bit when the movement
  stick is past 0.1 (0x40D9DE: `fcomp 0.1` → `or [esi+0x684], 0x8000`), so holding W re-triggered a jump every
  cooldown, on every vehicle.
- **Fix:** `VehicleJump.ini` `UseGameJumpButton=0`, `Hotkey=0x20` (Space, edge-triggered, game window in front only).
  Backups `.pre_spacekey`.
- **User request: vehicle jump only via the trainer.** VehicleJump 0.2 always installs its hook, starts from `Enabled`
  (default now 0) and exports `VehicleJump_Enabled(int set)` (0/1 switch, −1 read). DebugTrainer 0.3 adds a "Vehicle
  jump [Space]" checkbox under Noclip (GetModuleHandle("VehicleJump.asi") + GetProcAddress). It isn't saved, so it's off
  on every start. Both installed in `Lab - VehicleJump` (backups `DebugTrainer.asi.v0.2.bak`, `VehicleJump.asi.v0.1.bak`).
  **Not tested in game.**

### Bonecrusher wheels: culling bounds fixed, skin gaps filled (2026-11-10)
- **Cause of "only 1–2 wheels per side":** instance bounds (+0x80 min, +0x90 max, +0xA0 sphere) are **local** to the
  instance in stock files (Airbase `bonecrusher_wheel1` at (−170, 0, 1067): min (−0.355, −0.999, −0.999), sphere
  (0, 0, 0) r 1.457; every THINGS instance likewise). `make_wheel.py` wrote them in world space and `make_scene.py`
  moved them to y −3000, so each drawn wheel was culled by a sphere 3000 units below it. Only BNDS is world space.
- **Fix:** `make_wheel.py` writes local bounds and copies genWheel1's instance flags (+0xB8: 4; the button had 6);
  `make_scene.py` moves only BNDS. The new `BCWHEEL_PC.GSC` differs from the old one in 18 bytes; its instance bounds
  now equal Airbase's exactly.
- **Skin gaps:** skins load from the `LEVELLOCAL.CFG` include. AutoBonus1 includes
  `Levels/barricadeTranquility/VehicleSkins.cfg`, which doesn't exist; CybertronDcon's include is commented out. Both
  get a wheel-only `VEHICLESKINS.CFG` (CybertronDcon also a new include line). HooverExt's wheel block lost its stock
  `SCALE 4.0` (covers HooverDam too).
- **Lab (`Lab - VehicleJump`):** new scene in the 9 PATH folders (old one kept as `CITY\BCWHEEL_PC.GSC.pre_boundsfix`);
  config backups `.pre_boundsfix`. **Not tested in game.** Built with Blender 3.6's Python (no system Python found).

- **In game (user video 17.17, Suburbs):** all six wheels now draw, so the bounds fix works. But they were tan with
  red swirls; Airbase's (video 16.43) are near-black.
- **Cause:** the wheel material has two texture layers: +0xB8 = 296 (64×32 white sign with a red ring) and +0xFC =
  297 (128×128 dark rubber, rusty edges). `make_wheel.py` copied 296. The earlier "byte-identical tyre texture" note
  was wrong about which texture is the tyre. The wheel's UVs span the whole texture (u 0..1, v −0.99..−0.02).
- **Fix:** texture 25 = Airbase 297. `BCWHEEL_PC.GSC` is now 918,212 bytes; reinstalled in the 9 lab PATH folders
  (previous build kept as `CITY/BCWHEEL_PC.GSC.pre_tyretex`). The material is still genWheel1's lit single-layer
  one, so shading may differ a little from Airbase's two-layer material. **Not tested in game.**
- ffmpeg for reading user videos: `C:/Users/skeet/Desktop/ffmpeg-8.1.1-essentials_build/bin/ffmpeg.exe`.

### Bonecrusher: 0.8 wheel radius / damping switched off (2026-11-10)
- **In game (user video 17.24, Suburbs, CharacterCams 0.8):** tyres are dark now (texture 297 fix works), but the
  wheels are far too big and the steering is off. User asked to restore it.
- **Cause:** 0.8's `WheelRadius=1`. The drawn wheel follows the physics radius (wheel +0xA0), so 1.0 instead of the
  copied 0.566 drew them ~1.77× bigger. The 0.8 note "his drawn tyre radius is 1.0, so it sank" was wrong. The
  Airbase video (16.43) the user calls correct was recorded before 0.8 was installed (16:47).
- **Restore (INI only, no rebuild):** `WheelRadius=0`, `WheelDamping=0` (0 = leave Optimus's copied values) in the lab
  INI (backup `CharacterCams.ini.pre_restore`) and in `mods\CharacterCams\CharacterCams.ini`. `Handling=Optimus` stays
  (the pre-0.8 state). The .asi's built-in defaults are still 2 / 1, so the INI lines must stay. **Not tested in game.**

### Bonecrusher can't be damaged in robot mode: investigation (2026-11-10, static only, no fix yet)
- **Ruled out:** config (same `ENERGY 1500`, `DamageLocator ALL`, Size Large; the missing IMPACTVELOCITY/
  RECOILRUNOVERVELOCITIES/FLYBACKFORCE block is also missing on Brawl, who takes damage). His `DEFINEPOI` numbers
  match his own model's locator slots. Only two identity-14 checks in the exe: 0x467B9A (death anim 0x24) and
  0x41061E (skips `+0x630 |= 0x100`, an aim/anim flag). Setup case 0x4710FC matches Optimus's (plus `type+0x28 = 1`).
- **Health:** robot form = char physobj at `+0x930`, energy float `+0x954` (physobj `+0x24`), max short `+0x9B8`.
  Vehicle form uses the vehicle object's own (`veh+0x9E4` or `+0x5A4`), see GetEnergy 0x437C60. Separate pools.
- **Damage multipliers:** 4-bit slots at physobj `+0xA2..+0xA7` (char `+0x9D2..`), index into 0x6BCE28
  {0, .1, .25, .5, .75, 1, 1.25, 1.5, 1.75, 2, 3, 4, 5, 10, 25, -1}. Reset 0x4F3DD0 = all 1.0.
  0x4FAE80(bool) = invulnerable on (all 0) / off; many state-enter functions call it with 1 and restore
  saved values (`char+0x4C0/4C4/4C8`) on exit (e.g. 0x454680 / 0x410650). SetEnergy 0x4F3010 (god mode check).
- **Hit pipeline:** impacts act like small explosions. 0x507460 queries bodies whose origin is within
  max(impact radius, 15) (0x620110), then per body: skip if physobj `+0xAA` bit 7; distance from impact to the
  shape's closest point (shape vtable +0x18); **skip if that distance ≤ 0.01 (impact inside the shape)** or
  > physobj `+0x20` + radius; category mask physobj `+0x44` vs impact `+0x4C`; then TakeHit 0x506180 (more exits:
  `+0xAA`/`+0xA8` bit 7, multiplier 0 → reaction 0x465070 only, no health loss).
- **Model oddities:** 82 bones (most of any; next Barricade 76); bounds x ±7.95, z −9.76..1.5 (claw arm);
  no shoulder locators, chest locator named `chest1`.
- **Next:** read in game his `+0x9D2..+0x9DB`, `+0x954`, `+0x974`, `+0x950`, and the shape his robot body
  registers. Not found statically where the robot collision shape is built.

### Bonecrusher: real tread texture, pre-lit wheel material, stock handling (2026-11-10)
- **User:** make him handle like the normal Bonecrusher and make the wheels match Airbase.
- **Airbase frame (16.43 video, full res):** tyres are black with a knobby tread *texture* and dark hubs. Neither
  texture used so far has a tread.
- **Texture ids are slot numbers.** Airbase has 370 slots (GHG header `texSlots`, TST0 = 8 + 370 × 44) but 365
  textures in the file; 5 slots have no data (ids 252–258 are unused by any material). Past them list index =
  id − 5: `sky` id 305 = list[300]; TurretBase 298 = list[293]. The wheel's ids 296 / 297 = list[291] (32×32 DXT1,
  tread + tan hub parts) and list[292] (16×16 DXT5). THINGS has 70 slots and 70 textures, so ids are direct there.
  **Any tool that maps Airbase material texture ids straight onto the texture list is off by up to 5.**
- **Shading:** the wheel's vertex colours are dark (0x14–0x5D), and its material 0x3E1E2010 lacks the 0x00400000
  bit that the game-lit vehicle materials have (genWheel1 0x3E502011, ConvoyTruckWHEEL / HumveeBody 0x32502011).
  World geometry (0x3E100011, 0x3E102010) lacks it too. Reading: that bit = lit by the game, vertex colours
  ignored (not confirmed in the exe).
- **`make_wheel.py`:** texture 25 = list[291]; material 66 = +0x40 0x3E102010, +0x44 0x10 (copied from a stock
  THINGS material with the same format), +0x128 0xFF000000. `BCWHEEL_PC.GSC` = 910,532 bytes, in the 9 lab PATH
  folders (previous build `CITY\BCWHEEL_PC.GSC.pre_tread`).
- **Handling:** `[Bonecrusher] Handling=Default` in the lab INI (backup `.pre_default_handling`) and the mod INI, so
  the handling hook isn't installed and he drives on the game's own Bonecrusher values. Camera and R view fixes
  stay. **Not tested in game.**
- **New `mods\DamageProbe` 0.1** (read-only ASI): logs every character body each impact considers (routines
  0x507460 / 0x507750) with the check that keeps or drops it, every TakeHit (0x506180) with health before/after,
  and changes to known characters' health, multipliers and flags. Prologue bytes are checked before hooking.
  No other mod hooks these. Installed in `Lab - VehicleJump`. **Not run in game yet.** Test steps in its README:
  Barricade vs Bonecrusher in the TestTranquility hub, F7 marks between them.
- **DamageProbe run 1 (user, TestTranquility hub, drone vs Bonecrusher, neither transformed):** hits do reach
  Bonecrusher. His damage object (1500 HP, a8=68 aa=0C, same flag bytes as the drone's) got TakeHit with
  multipliers `0/0 0/0 0/0 0/0 0/0 1/1` (all ten attack slots 0, health stays 1500). The drone's (600 HP) were all 1
  and its health dropped 20 per hit. That exact pattern = 0x4FB010(1) ("invulnerable to everything", also done by
  0x4CF690(1) through the four group setters 0x4FAFA0/0x4FAEF0/0x4FAE80/0x4FAF60). 0x4CF690 targets the body
  model's damage object (`model+0xC → +8 → +0x9C0`, or `+4 → +0x580`, same as 0x42ACF0), not `char+0x930`.
  The 0.1 "is a character" check was wrong (type records are heap pointers listed in 0x6FDE90), so no character
  names or STATE lines appeared. Log kept as `Lab - VehicleJump\DamageProbe_run1.log`.
- **DamageProbe 0.2:** character check fixed (pointer table 0x6FDE90, count 0x6FE0E8); walks the live list
  `[[0x6F997C]+0x54]` (next = +0); each TAKEHIT/IMPACT line names the character and which damage object was hit
  (`ROBOT-phys(+930)`, `MODEL-phys(52C)`, `TRAN-phys(530)`); STATE lines show both objects' health and
  multipliers. Installed in the lab. **Not run yet.**
- **DamageProbe run 2 (user):** Bonecrusher's hits land on his ROBOT damage object (`char+0x930`), same as the
  drone's. The vehicle-object theory is wrong. His robot multipliers are all 0 from the first frame after spawn
  (the drone, spawned earlier into the same char memory, started at all 1). `type+0x28` set in his setup case is
  just Side (1 = Decepticon). Not the hub script: it spawns him like every opponent (`#Script=Combat` etc.).
  Script command `SetPhysicsState` (0x43B5B0, `immunetoshots=` / `immunetothrown=` / `immunetomelee=`) can set
  these, but no script in the lab uses the immune options. Log kept as `DamageProbe_run2.log`.
- **DamageProbe 0.3:** also hooks the 12 single-slot setters (0x4FACB0…0x4FAE60), the 4 group setters
  (0x4FAE80/AEF0/AF60/AFA0), the all-setter 0x4FB010 and the reset 0x4F3DD0. Logs every write of 0 (and every
  write on a character) with the caller's return address. Stub code checked with Capstone. Installed. **Not run.**
- **DamageProbe run 3 (user): cause found.** Right after Bonecrusher spawns, 0x43A7A0 resets his robot damage
  object, then (AI only, `+0x62C` bit 14 clear) calls 0x4FAE80(1) and zeroes every other slot one by one.
  0x43A7A0 is reached from `Char::SetupDamageProfile` 0x43AE00: `jmp [ (identity+1)*4 + 0x43AE78 ]`. The table gives
  each identity a profile: 1 Optimus 0x40E090, 2 Brawl 0x43A840, 3/4/5 0x40E050, 7 Ironhide 0x40E100, 8 Megatron
  0x40DFB0, 9/10 0x40DF30, 11 0x40E000, **14 Bonecrusher 0x43A7A0 (all categories 0)**, 15 TripleC 0x43AB40,
  16 0x40E150, 17 0x40DE10, 18–21 0x40E1E0, 22–23 0x40E2A0, 24–25 0x43AC20, 26–27/30–31 0x40E210, 28–29 0x40E250;
  6/12/13 none. His profile is Brawl's (same 0x4378B0(3) call) with everything zeroed. Log kept as
  `DamageProbe_run3.log`.
- **New `mods\BonecrusherDamage` 0.1 (fix):** writes table entry 0x43AEB4 = 0x43AE31 (Brawl's profile) after
  checking it holds 0x43AE4A. INI `DamageProfile=` Brawl/Megatron/Blackout/Optimus/Bumblebee/Drone/None/Off.
  Installed in `Lab - VehicleJump` (DamageProbe 0.3 still installed to confirm). **Not tested in game.**
- **Run 4 (user, BonecrusherDamage 0.1 on):** patch applied (log `Patched ... Brawl`). His slots are now Brawl-like
  (`1/1 0/1 1/1 1/0 0/0 1/1`); he gets knocked back but health stays 1500. His hits were types 21 and 24, which map
  (0x4F3F20 idx table 0x4F4044) to slot 1hi and slot 2lo, both 1.0. So a later gate stops the damage.
  For characters TakeHit 0x506180 doesn't subtract itself: it queues (`phys+0x30`) and calls 0x505F60 ->
  **Char::TakeDamage 0x464E90** -> 0x464960 (size table 0x6B6F90 by `+0x5DC` row / `+0x5CC` column via 0x407870,
  0x40E2E0, **health floor 0x43AF00**: damage capped to health − `char+0x4A0`). `char+0x498` = post-hit timer
  (0.5 s after a hit, counted down in 0x47282F for every transformer; while > 0 damage is skipped).
  `+0x4A0` is written by group join 0x43A3D0 (group +8), 0x43A5D0, 0x4C4339 (0), 0x4C4C3A / 0x4C4C6C (32000).
  Log kept as `DamageProbe_run4.log`.
- **DamageProbe 0.4:** adds Char::TakeDamage (before/after: health, `+0x498`, `+0x4A0`, `+0x490`, `+0x49C`,
  `+0x5CC`), 0x464960 entry (APPLY, timer check) and the health floor 0x43AF00 (FLOOR, damage before/after).
  Installed. **Not run.**
- **Run 5 (user, DamageProbe 0.4): second block found.** Char::TakeDamage got dmg 20 / 80, no hit timer
  (`+0x498` = 0), floor `+0x4A0` = 0, but the floor 0x43AF00 already received 0. Between them, `Char::ModifyDamage`
  0x44F060 (`call` through table 0x44F200, entry identity + 1) gives Bonecrusher 0x40DDF0, which sets the damage to 0
  unconditionally (player and AI). Brawl 0x40DEE0 only zeroes it as an AI in vehicle form; Jazz/5/6/12/13 have none
  (0x44F164). A scan of all nine per-identity switches (0x4059D3, 0x43AE00, 0x445CB2, 0x448C60, 0x44F060, 0x44F293,
  0x45A21E, 0x46D79B, 0x471D52) found no other table where he has his own entry. Log kept as `DamageProbe_run5.log`.
- **BonecrusherDamage 0.2:** also writes 0x44F23C = 0x44F164 (no adjustment) after checking 0x44F087.
  INI `DamageModifier=None|Brawl|Off`. Installed in the lab. **Not tested in game.**

## VoiceMenu: play your character's voice lines from a menu (2026-11-10)
**Mod `mods\VoiceMenu`** (v0.1): V opens a list of the current character's lines; 1-9 play, [ ] page, Tab browses
other speakers, B plays a random own line. Details in its README.
- **Fresh Build has no dialogue WAVs** (no `AUDIO\_Dialogue`). The retail extract in
  `Transformers.The.Game\...\Decompiled Shit game\AUDIO\_Dialogue\USA` has all 293 (16-bit PCM, 148 MB).
- **Speakers** come from `LEVELS\*\SPEECH.INI` `Head=`. The retail SPEECH.INI files cover 271 of the 293 WAVs;
  Fresh Build's cover fewer. The rest are MUSIC.CFG overlays only, assigned by mission chapter (21, all Optimus).
- **No input hooks:** GetAsyncKeyState on keys NUCONFIG.TXT doesn't bind; Present/Reset vtable patch only, 1.5 s
  after the device appears so it chains after DebugTrainer. Sound via PlaySound (not the game's mixer).
- **Built and installed** in `Lab - VehicleJump` (ASI, INI, `VoiceMenu\Lines\*.wav`, `VoiceMenu\VoiceLines.txt`).
  **Not run in game yet.**
- **SpecialMoves 0.10 in game:** "movement still does not work" (no details yet). The stick vector
  `+0x650/654/658` (scale `+0x660`) is written by the pad reader 0x446DA0 every frame, so the input is fresh.
- **SpecialMoves 0.11:** no behaviour change. While flailing it logs 4×/s: stick, requested and playing
  animation, move vector `+0x690..`, speed `+0x6B0`, facing `+0x600`, position, and state +4 / +0x70 / +0x78.
  Installed in the lab; waiting for a test run plus a description.
- **User report (0.10): Megatron doesn't move at all while flailing.** The log from that run is from 0.10, so it
  has no movement data. Megatron's normal idle/walk animations have no NEXTANIM either and switch fine, so the
  missing NEXTANIM lines on his spin_hook_* animations are not the blocker.
- **Lead:** the Flail update 0x466150 calls the move helper only once `state+0x78` bit 2 is set. That happens
  when the wind-up spin_hook_start (0x85) is the playing animation and reaches progress `anim+0x98` ≥ 1.0, or
  when it is missing. If the wind-up never reports done, no movement code runs at all. 0.11 logs exactly this.
  Waiting on a 0.11 run.
- **0.11 run (measured):** the wind-up finishes (`st+0x78` 0x8 → 0xA), but with the stick fully pushed the
  helper requests idle (0x86) and the speed stays 0. Bit 8 (0x8) is set from the first frame. The move helper
  (0x40EFDA) then replaces the stick with zero.
- **Root cause:** the Flail update's last call, 0x452BA0, measures the distance from the character to the
  PLAYER (`[0x770614]`, minus both radii via 0x437BC0). When close it sets bit 8 ("arrived, stop walking";
  thresholds 0x682D44 / 0x682960, timer branch when bit 4 is set, which is set for identity 11 = Barricade).
  For the player the distance is 0, so the bit was always set. Barricade escaped through the timer branch.
- **SpecialMoves 0.12:** a stub at 0x452BA0 clears bit 8 and returns for the player; everyone else runs the
  original. Installed in the lab. **Not tested in game.**
- **VoiceMenu 0.1 in game:** works (user-tested): menu, character match, playback.

### VoiceMenu 0.2: dramatic lines, speech bubble, cooldown (2026-11-10)
- **Speech system (static reading):** the SPEECH.INI parser 0x4AAC00 builds records `+0 tag, +4 sound handle
  (0x550E80 on the sound manager 0x76D410, group 8: only finds already-registered samples), +0xA head (word),
  +0xC Localize(Text), +0x10 ActiveTime`. Head names in the parser: Optimus 0, BumbleBee 1, Starscream 3,
  Frenzy 4, Jazz 5, Blackout 6, Ironhide 7, MEGATRON 10, Barricade 11 (no Brawl/Bonecrusher name).
  Speech::Play 0x4AAD90 starts the sound, then calls `HUD(0x713630)->ShowSpeech(head, text, secs, 0)` 0x492EB0
  (thiscall, ret 0x10) → 0x48FFB0, which picks the portrait from a 12-entry table (8 BoneCrusherHead,
  9 BrawlHead, 2 = bumblebee again) and keeps the text pointer.
- **Subtitles** are in `GUI\STRINGS_BIO.CSV` (UTF-16, LABEL + language columns); 247 of 293 lines have text.
- **0.2:** calls ShowSpeech itself after PlaySound (byte-checked, HUD widgets checked). `DramaticOnly=1` uses a
  text-based filter in the generator: 134 lines. Cooldown 3 s after a line ends (`Cooldown=`,
  `AllowInterrupt=`). Brawl's six lines (d3_ch4_obj2..7, filed under Bumblebee) moved to Brawl, head 9.
  Compiled call checked in the disassembly. Installed in `Lab - VehicleJump`. **Not run in game yet.**
- **VoiceMenu 0.2 in game:** bubble and head work; the bubble always closes after 3 s.
- **VoiceMenu 0.3:** bubble widget = `[[0x713630+0x18]+0x10]`: +0x10 seconds (only used when it re-shows,
  0x490170), +0x14 time left (0x48FFB0 always sets 3.0; 0x4901B0 subtracts the frame time `[0x7183BC]` and
  hides the bubble at <= 0), +0x20 text. The mod sets +0x14 to the line's time left each frame, 0 at the end.
  Installed in `Lab - VehicleJump`. **Not run in game yet.**
- **0.12 (rebuilt):** FlailSpeedScale default 2.0 → 1.0 (game speed, matches the flail-walk animation), at the user's request. Installed in the lab (SHA-256 `48662DFDBE03C5AB…`).
- **Released** as VoiceMenu v1.0.0 (tag `VoiceMenu-v1.0.0`): source in `trainer/VoiceMenu`. The zip has no game audio; the mod reads the game's own `AUDIO\_Dialogue\USA`, or the installer copies the WAVs into `VoiceMenu\Lines` from another folder.
