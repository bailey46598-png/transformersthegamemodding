# Transformers: The Game: reverse-engineering notes

- **Exe:** `Transformers.exe`, v1.0.254.2, SHA-256 `5AA3BD49…EEFD0` (the RELOADED build).
- **Addresses:** image base 0x400000, no ASLR. Every address below is a virtual address; in IDA press `G` and
  paste it.
- **Method:** static reading only, using a Capstone linear sweep of `.text`. The game was **not run**.
- **Status labels:** ✅ = read directly from code. ❓ = inferred and not yet confirmed in game.
- **Calling convention:** every `Char::` method is MSVC `__thiscall` (`this` in ECX, callee pops its stack
  arguments).

## Character type record (one per type, e.g. "BumbleBee")
- Each record is 0x6E0 bytes (allocated at 0x425354). **Correction (2026-11-07): +0 is the name `const char*`** (initialised to the string "default" at 0x6809E0, not a vtable). Confirmed by reading the live game.
- Records are stored in the table at **0x6FDE90** (`[0x6f5708]` points to it; count at `+0x258` = 0x6FE0E8, max 150).
- `[0x6faf98]` points to the record currently being parsed.
- Top-level `.CFG` keywords use a {name, handler} table at **0x6b4920**. `AnimControl` sub-keys use string
  compares (0x409xxx).

| Offset | Field |
|---|---|
| +0x1B4 | **Ability bitfield** from `EnableAbility` ✅. 0x40 = Transform, 0x4000 = Jump (checked at 0x44ff64), 0x80000 = needed by the landing check (probably `Fall`) ❓ |
| +0x1E8 / +0x1EC | TransformToRobotTime ❓ / TransformToVehicleTime ✅ |
| +0x218 | JUMPPOWER ✅ (17.0 for Bumblebee) |
| +0x224 | JUMPMOVEMENTSCALE ✅ |
| +0x248 / +0x24C | RobotToVehicleJumpTime / Velocity ✅ |
| +0x250 / +0x254 | VehicleToRobotJumptime / Velocity ✅ |
| +0x69C | Table of transform sound IDs (+4 = to robot, +8 = to vehicle ❓) |

## Character instance (`this`)
| Offset | Meaning |
|---|---|
| +0x230..+0x23C | Launch vector (x, y, z, w) ✅ |
| +0x350 | The current movement-state object, built in place ✅ |
| +0x41C | Landing-check cooldown in seconds ✅ |
| +0x428 | Launch timer in seconds ✅ |
| +0x518 | → type record ✅ |
| +0x52C / +0x530 | Body objects: normal model, and the transform-sequence model (`*Tran`) ✅ / ❓ |
| +0x538 / +0x53C / +0x544 | State callback / **current state object** / state factory function (0x4263D0) ✅ |
| +0x590 | Non-zero = holding or carrying something (blocks jump and transform) ❓ |
| +0x59C | Action-permission mask. Bit 8 (0x100) must be set to start a jump ❓ |
| +0x5C0 | **Transform model active** (1 during state 7), **not** "in vehicle". Corrected from the first pass. ✅ |
| +0x5C8 | **Current state ID** ✅ (written by ChangeState at 0x4050fc) |
| +0x628 | Flag word. **Bit 18 (0x40000) = vehicle form** ✅/❓, bit 21 (0x200000) = airborne/jumping ✅, bit 24 (0x1000000) = landed/grounded ✅/❓, bit 12 = "has velocity override" ❓ |
| +0x62C | Second flag word. Bit 14 = player-controlled ❓ |
| +0x684 | **Action requests for this frame**, cleared and refilled every frame by AI or by the pad ✅ |
| +0x810..+0x81C | Velocity copy ✅ |
| +0xA3C | Robot physics body. Its `→+0x34 →+0x20` is the **velocity** vec4 ✅ (falling speed is clamped to -7.0 at 0x46e65f) |

**Why I trust bit 18 = vehicle form:**
- The pad code reads different button masks for movement when it's set (accelerate and brake).
- The transform dispatcher branches on it.
- The launch update takes the "no air control" path when it's set, which matches the devs' comment.

### Action bits in `+0x684` (player pad translator 0x446da0)
| Bit | Button mask global | Action |
|---|---|---|
| 0x2 | `[0x6b5228]`, pressed | ? |
| 0x8 / 0x10 | `[0x6b5220]` / `[0x6b5224]` held (robot); `[0x6b51b0]`/`[0x6b51d4]` and `[0x6b51b4]`/`[0x6b51d8]` (vehicle) | Move-style actions, remapped in vehicle form |
| 0x40 / 0x80 | — | Transform request (checked at 0x44feda) |
| 0x800 | `[0x6b5244]` | ? |
| 0x1000 **and** 0x8000 | `[0x6b5230]`, pressed | **Jump.** Set in every mode, including vehicle form ✅ |
| 0x10000 / 0x20000 | `[0x6b5238]` while in state 0x13 or 0x21 | Jump follow-ups (slam?) |
| 0x1, 0x200, 0x400, 0x100 | `[0x6b5254]`, `[0x6b524c]`, `[0x6b5250]`, stick | ? |

- **Player pad object:** `[0x770620]`. `+0x70` = buttons held, `+0x78` = buttons pressed this frame ✅.
- **The game already raises "jump pressed" while you drive. Vehicle states just ignore it.**

## State machine
- **`Char::ChangeState(int id, cb)`** at **0x405090** (`ret 8`):
  1. Calls the old state's `OnExit` (vtable +0xC).
  2. Builds the new state with factory `[this+0x544]`.
  3. Calls the new state's `OnEnter` (vtable +0x8).
  4. Stores the id in `+0x5C8`.
- **State vtable layout:** +0x4 = Update ❓, +0x8 = OnEnter ✅, +0xC = OnExit ✅, +0x20 = GetStateID ✅.

| ID | Vtable | Meaning |
|---|---|---|
| 6 | 0x680E28 | Unknown. The vehicle→robot hop is allowed from 6 or 7. Possibly "vehicle driving" ❓ |
| 7 | 0x680FE0 | **Transform** ✅. OnEnter 0x4673a0: direction from bit 18, plays the transform sound, transform counter `[0x714488]` up to 500 |
| 0x13 (19) | 0x6822D0 | **Jump** ✅. Update 0x467490, sub-phase at `[state+0x54]` |
| 1, 2, 3, 0x21, … | 0x680E78 / 0x680EA0 / 0x680FB8 / … | Not mapped yet |

- The on-foot action handler **0x44fc10** is shared by six states and requests 6, 7 and 0x13.
- **The jump request is at 0x44ff3b.** All four conditions must hold:
  - `+0x59C & 0x100`
  - `+0x684 & 0x8000`
  - `+0x590 == 0`
  - `type+0x1B4 & 0x4000`

## Functions
| Address | Name (mine) | Notes |
|---|---|---|
| 0x4727e0 | `CharList::UpdateAll()` | Walks the character list every frame. For player-controlled characters (`[+0xB94]` sign bit) it calls the pad translator (0x4728da), **then** `Char::Update` (0x472a33). So `+0x684` is already filled in when Update runs. |
| 0x472560 | `Char::Update(int, int)` | `ret 8`. Per character, per frame. Runs the transform dispatcher (0x4725d3) and the physics/landing step (0x472673). |
| 0x446da0 | `Player::ReadPad()` | Builds `+0x684` from the pad masks |
| 0x405090 | `Char::ChangeState(id, cb)` | See above |
| 0x405250 | `Char::Jump(const vec4* dir, float power, bool force)` | `ret 0xC`. Gated on bits 21 and 24 and `+0xA88`. Calls 0x404c80, then sets bit 21 |
| 0x404c80 | `Char::AddVelocity(const vec4* v, bool, float)` | `ret 0xC`. Adds `v` to the robot body velocity (`+0xA3C→+0x34→+0x20`) and to `+0x810`. Writes `+0x434` and `+0x438 = 0.5` |
| 0x4075e0 | `Char::SetLaunch(const vec4* v, float seconds)` | `ret 8`. Writes `+0x230` and `+0x428` |
| 0x4387a0 | `Char::UpdateLaunch()` | While the timer is above 0, subtracts dt. **Vehicle form:** adds `v` to the vehicle body's velocity **every frame** (no dt scaling, so frame-rate dependent; no steering). **Robot form:** calls 0x405350 with a 5.0 factor |
| 0x437aa0 | `Char::GetActiveBody()` ❓ | Returns body `+0x52C`/`+0x530`, depending on `+0x5C0` and a body flag |
| 0x46e4a0 / 0x46e710 | Transform-complete hops | Apply the RobotToVehicle and VehicleToRobot launches |
| 0x4481b0 | `Char::CheckLanding()` | Needs ability 0x80000. Probes down with 0x4478c0. On a hit: clears bit 21, sets bit 24 |
| 0x4082e0 | `CreatureType::GetJumpPower()` | +0x218, with an NPC multiplier in game mode 8 |

## Globals
| Address | Meaning |
|---|---|
| `[0x770614]` | Player character ✅ |
| `[0x770620]` | Player pad ✅ |
| `[0x7183bc]` | Frame dt ✅ |
| `[0x6b5230]` | Jump button mask ✅ |

## Vehicle-jump plugin: design v2
- **Hook `Char::Update` (0x472560)** with MinHook.
  - It is `__thiscall` with **2 stack arguments** (`ret 8`).
  - The caller at 0x472a2f pushes `edi`, then `ebp`. Their meaning is unknown; likely dt and a flag.
  - In C++: `void __fastcall Hook(Char* self, void* edx, int a1, int a2)`.
- After the original returns, for `this == *(Char**)0x770614` only:
  ```
  if (flags628 & 0x40000)            // vehicle form
   && (actions684 & 0x8000)          // jump pressed this frame (game already sets it)
   && cooldown <= 0 && launchTimer428 <= 0
     SetLaunch(this, &(0, Dv, 0, 1), 1.5 * dt)   // 0x4075e0
     cooldown = Cfg.Cooldown
  ```
  - `1.5 × dt` makes UpdateLaunch apply the vector **exactly once**: it subtracts dt first, then applies
    while the timer is still above 0.
  - That turns the frame-rate-dependent thrust into a single kick of `Dv`, the same at any FPS.
  - This reuses the code path the devs already wrote for the vehicle hop.
- **Ground check v1:** a cooldown, plus "vehicle body vertical velocity ≈ 0". Upgrade to a real ground
  flag once found; candidates are bit 24 and the body flag read at 0x437acc / 0x437adb.
- **INI settings:** `JumpVelocity` (Dv), `Cooldown`, `RequireGround`, `Characters=*`.

## Unknowns, in order
1. **In game:** does adding velocity through SetLaunch in vehicle form actually lift the car, and does
   gravity bring it back? (Expected yes, since the devs' hop used it.)
2. **In game:** does `CheckLanding` run for cars and set bit 24 on landing? That decides the ground check.
3. State 6's meaning, and the vehicle driving state(s). Map the IDs from the factory 0x4263d0 by reading each
   vtable's GetStateID.
4. Air steering. The devs called it out. Probably needs a hook in the vehicle state's Update, which is
   not found yet.

## Debug trainer (2026-11-07, static, read from the retail lab exe)
The retail `Lab - VehicleJump\Transformers.exe` has plain code on disk at these addresses, so it was read directly.

**GUI action registration:** `push handler / push "Name" / mov ecx,esi / call 0x6056D0` (actions) or
`call 0x60573F` (text getters), at 0x48E3xx–0x48EDxx and 0x49BExx–0x49CCxx.

| Action / getter | Handler | What it does |
|---|---|---|
| ToggleGodMode | 0x47A350 | flags `^= 0x2` |
| ToggleVibration | 0x47A9A0 | flags `^= 0x4` |
| ToggleSFX | 0x47A400 | flags `^= 0x800` (set = off) |
| ToggleMusic | 0x47A4B0 | flags `^= 0x1000`, then music volume 0 or 1 via 0x5BED30 |
| ToggleHUD | 0x47A2B0 | byte `[0x713658]` = !byte |
| ToggleFlyCamera | 0x47A6D0 | dword `[0x77079C]` = !dword |
| ToggleCameraSensitivity | 0x48C440 | cycles `[0x7707A4]` 0→1→2→0 via 0x50D330 |
| ToggleAspectRatio | 0x47A580 | `[0x77074C] & 0x18` decides, sets via 0x50C7C0 |
| ToggleCameraInverted | 0x43BDD0 | **empty `ret`** on PC (shared with FEToggleSixaxis) |
| SetLevelComplete | 0x499F80 | 0x493010(1) on 0x713630, ChangePage("DebugOptionsMenu") (returns 0 if the page is missing), 0x498B00(0,0) |
| GetNumDebugOptions | 0x47A1C0 | returns 8 |
| ToggleDebugOption | 0x47A290 → **0x50D370** | `__thiscall(0x7705D0, i)`: `[+0x60] ^= 1<<i`, then flags ^= bit from table below |
| (IsOn) | 0x50D490 | `__thiscall(0x7705D0, i)`: `[+0x60] >> i & 1` |
| LevelSelect / MissionSelect | 0x499F40 / 0x499FB0 | not studied yet |

**Debug option list** (names at `0x6B93E0`): 0 Draw FPS `0x8`, 1 Draw Player Coords `0x10`, 2 Unlock All
`0x20`, 3 Unlimited Ammo `0x40`, 4 No Police Response `0x80`, 5 Disable AI Control `0x100`, 6 Show Shields
`0x200`, 7 Slow Motion `0x8000` (jump table 0x50D464).

**Cheat flag word `0x6FB268`**, other bits: `0x2000` ASYNC, `0x80000` cfgc, `0x800000` ENABLESELECTBUTTON (all
command-line), `0x200000` and `0x400000` unknown (level flow).

**Command-line switch parser** at 0x50E460 (`GODMODE`, `NOAI`, `UNLOCKALL`, `UNLOCKMISSIONS`, `DEBUG`, `CONSOLE`,
`consolelog`, `DBGLINES`, `NOFMV`, `INVERTCAM`, `g1megatron`, ...). Not tried yet.

**Render:** renderer object `0x2BD90E8` (`IDirect3D9*` at +0, set at 0x5E446F; device at +4). Init 0x5E4460 is
called once from 0x5EC180. EndScene wrappers 0x5E3D60 / 0x659960 use `[renderer+4]`.

## Player swap (2026-11-07, static + verified by reading live memory)
- **Swapper object `0x6FE480`.** Each frame `0x4730A0` (`mov ecx,0x6FE480; jmp 0x473010`) runs. When nothing is
  loading it calls **SwapPlayer `0x472F20`**.
- **Request `[0x6FE480+0x8C]` = `0x6FE50C`**: a `const char*` creature name, 0 when idle. SwapPlayer:
  1. Looks up the type with `FindCreatureType 0x40AE90` (`__thiscall` on 0x6FDE90, `ret 4`; case-insensitive name
     compare; returns index or -1).
  2. Copies the old player's 4x4 transform (0x4453D0).
  3. Stores the name in the level's player-type slot `[[0x7183A8]+0xC4]`, so respawns keep it.
  4. Removes the old player (0x46EAC0 on the char list `[0x6F997C]`) and spawns the new type (0x472CB0).
  5. Sets `[0x770614]`, places it (0x445520), then clears the request.
- The script message `#PlayerType=X` (General module) reaches the same path. Module option names are hashed;
  they aren't plain strings in the exe.
- **Live check (city level):** 147 records; robots have ability `0x40` (Transform), and their
  GunArm/LeftArm/Car/Tran/VehicleWeapons parts and the `Ped_*` records don't.
- **Crash (2026-11-07, in game):** swapping to Ironhide in a level that hadn't loaded his model crashed at
  **0x44653A** (`mov eax,[ecx+0x80]` with `ecx = Char+0x51C = 0`).
  - `Char+0x51C` is the model instance built by 0x437EF0 → `0x5364A0(type+0x690)`. 0x5364A0 returns 0 when
    `type+0x690` is 0 or its word `+0xC` is 0, or when its pool (`[0x772A14]`) is empty.
  - **`type+0x690` = the loaded model.** `0x40B1A0` clears it on every type at level load. `0x40AF30` (by file)
    and `0x40B8DA` (parts) set it only for creatures the level loads. The type table itself lists everything in
    `CREATURES.CFG`.
  - So a type is safe to swap to only when `type+0x690` is set (and its `…Tran` type's, if one exists).

## Levels and chapters (2026-11-07, static only)
- **Level list:** `[0x71872C]` level manager: `+4` count, `+0x10+4i` names. Lookup is `0x4A3EB0(name)` → index or -1.
- **RequestLevel `0x4B8F60(name)`** (cdecl): sets the pending level `[0x6FB284]` = index and a 0.7 s fade
  `[0x6FB27C]`. Returns 1, or 0 if the name is unknown. It ORs `0x4000` into `[0x6FB1D0]` for "FrontEnd". The
  debug action **LevelSelect** (`0x499F40`) calls it with `[0x713730 + i*0x1C]`, then closes the GUI
  (`0x5FBAA0`) and resumes (`0x498B00` on 0x713630).
- **Chapter table `0x713730`** (runtime data, 14 × 0x1C): `+0` level name, `+4` chapter count, `+8` text-id
  array, `+0xC` title text id. `Localize 0x65EBA0(id)` returns display text.
- **MissionSelect `0x499FB0`:** for the current level (`[[0x7183A8]]`), skips if id[0] is `"WorkInProgress"`.
  Then:
  1. `0x54C3A0([[0x6F5700]+0x1A0], "MissionMessage", (float)(i+1), 0)`.
  2. Finds the script slot (8 slots × 0xC4 at `[0x6F5700]+0xC`; script at `+4`, name at script `+8`) named
     `"Level1"`, and fires `0x53C850(slot, 0x53B4D0("SkipLevel", script))`.
- **Creature loading per level:** pass 1 parses each `CREATURES.CFG` `INCLUDE` into type records (0x408390,
  keyword table 0x6B4920). Pass 2, `0x40B0F0`, re-reads `<level>\creatures.cfg` with table 0x6B4AE0/0x6B4AEC
  (`INCLUDE` → 0x40AF90, `CHARACTER` → 0x40AF30). 0x40AF30 loads the character block (model and anims,
  `0x53ADB0`) and sets the type's `+0x690`.

## Creature cache and on-demand loading (2026-11-07, measured with the trainer's creature dump)
- **Registered vs resident:** every type a level's `CREATURES.CFG` includes gets a model entry (`type+0x690`).
  Its part count (word `+0xC`) stays 0 until the creature cache loads it.
- **What stays loaded:** the `LEVEL.CFG` `CREATURE <name> [+car] [+heli] [+tran] [nolowmem] [noload]` lines
  (handler 0x4A2730) plus whatever is spawned.
  - The names go to levelinfo `+0xC10` / `+0xC14`. Each name and each `+suffix` (found as name+suffix with
    `"%s%s"`) goes into a fixed array at `+0xDC`, count `+0x168`: about 35 slots, **no bounds check**.
  - So LEVEL.CFG can't make every robot resident.
- **LoadCreature `0x43A170`** (`__thiscall` on 0x6FDE90, arg = name, `ret 4`): what level load calls for each
  of those names (from 0x44DB70).
  - Already resident: adds a reference (0x40B4A0).
  - Otherwise: cache priority 0x40000, 0x300000, or 0x100000 for "DRONE" names; `0x40B460(table+0x264, type,
    prio)`; then walks dependent types.
- `CREATURECACHESIZE_KB` → levelinfo `+0xBF0` (handler 0x4A30C0). `CREATUREPOOLALLOC` → `+0xBF4`: the count
  of 0x2020-byte spawned-character slots (default 10).
- **Type table source:** the master `CHARS\CREATURES.CFG`. The dump order matches it.
  - 147 types = 112 includes + 35 `TransformingBodyPart` CFGs. That CFG token isn't always last:
    `... chars/BumbleBeeGunArm.cfg Ranged`.
  - Ratchet (3 types) fills it to exactly 150.
- **Correction (2026-11-08): the chapter table is an unfinished stub.** Its static initializer is at 0x6797A0.
  - Each 0x1C entry: `+0` name, `+4` count = **1**, `+8` → one dword in 0x6B93A8..0x6B93DC, `+0xC` the name again
    (not a title id), `+0x18` a GUI image name `screen_N`.
  - All 14 entries point at `"WorkInProgress"`. MissionSelect sees that and does nothing, so the retail debug
    chapter select never worked.
  - **The scripts do support it:** `LEVELS\<level>\AI\LEVEL1.SCP` includes the hub (`include "Auto1Hub.scp"`)
    and the chapter scripts as the one script "Level1". The hub's `state SkipLevel` does
    `DestroyAllModules`, `#ResetAll #SetPlayer=#Start`, `#FadeDown`, then goes to `ChapterN_InitGoto` on
    `message "MissionMessage" == N`.
  - 10 levels have 4 chapters: DemoTranquility, Tranquility2, HooverInt, HooverExt, City, Qatar,
    BarricadeTranquility, Airbase, HooverDam, InTheCity. AutoCityBoss, Cybertron and CybertronDcon have hubs
    without SkipLevel.
