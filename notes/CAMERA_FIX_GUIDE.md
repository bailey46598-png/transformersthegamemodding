# Camera fix guide (for fixing the drones and other characters)

How we fixed TripleC's and Bonecrusher's cameras, what the debugging tools do, and how to use them to fix the
drones (or anyone else with a broken camera). Everything here is for **Transformers: The Game PC, retail
`Transformers.exe` v1.0.254.2**. Addresses won't match any other build.

Full history of every test (including the failed ones) is in [`MODLOG.md`](../MODLOG.md): search for
"TripleCFlightCam" and "Bonecrusher: wheels, car camera, R view".

---

## 1. Setup

You need:

1. A **lab copy** of the game (a copy of the game folder you don't mind breaking).
2. [Ultimate ASI Loader](https://github.com/ThirteenAG/Ultimate-ASI-Loader/releases) (x86), renamed to `dinput8.dll`,
   next to `Transformers.exe`.
3. Visual Studio 2022 Community with the **Desktop development with C++** workload (to build the `.asi` files).
4. Python 3 (for `dumpdiff.py`). Blender's bundled Python works too:
   `"C:\Program Files\Blender Foundation\Blender 3.6\3.6\python\bin\python.exe"`.

Build each tool by double-clicking its `build_msvc.bat`. The result is in that tool's `build\` folder (not uploaded
to GitHub). Copy the `.asi` and its `.ini` next to `Transformers.exe`. Each tool writes a `.log` file there.

## 2. The tools

| Tool | Folder | What it's for |
|---|---|---|
| **CharacterCams** | [`trainer/CharacterCams`](../trainer/CharacterCams) | The camera fixes (TripleC, Bonecrusher) **and** the camera debugging keys: **F8** dump, **F9** physics trace. This is where new camera fixes go. |
| **dumpdiff.py** | [`scripts/CameraDumps`](../scripts/CameraDumps) | Reads F8 dumps. Compares two dumps field by field. |
| **DebugTrainer** | [`trainer/DebugTrainer`](../trainer/DebugTrainer) | F1 menu: **Character select** (play as any creature in the level, drones included), fly camera, player coords, god mode, noclip, combat-hub opponents. |
| **DamageProbe** | [`trainer/DamageProbe`](../trainer/DamageProbe) | Read-only damage logger (F7 marks the log, F6 pauses). Not for cameras; use it when a character can't be hurt. |
| TripleCFlightCam | [`trainer/TripleCFlightCam`](../trainer/TripleCFlightCam) | The older TripleC-only camera fix. **Replaced by CharacterCams.** Its README has the full TripleC write-up. |

> **Only install one of CharacterCams / TripleCFlightCam.** Both patch the same camera table. Rename the other to
> `.disabled`.

### CharacterCams debug keys

| Key | Writes | Contents |
|---|---|---|
| **F8** | `CharacterCams_dump_id<identity>_<n>.bin` (`_R` added if R is held) | The player's vehicle profile, aircraft, **active camera preset**, car body, player camera object, render camera. One snapshot. |
| **F9** | `CharacterCams_trace_id<identity>_<n>.bin` | 4 seconds of car physics (car block + wheel records, every ~10 ms). Only in vehicle form. For handling/suspension bugs. |

The `<identity>` in the file name tells you the character's identity number without any other tool. The log file
(`CharacterCams.log`) also lists each dump with the preset address it found.

### dumpdiff.py

```bash
python dumpdiff.py CharacterCams_dump_id3_1.bin                     # show every field of one dump
python dumpdiff.py A.bin B.bin                                       # only the fields that differ
python dumpdiff.py A.bin B.bin -s preset                             # only the camera preset
python dumpdiff.py A.bin B.bin -s header                             # identity, profile, which preset is active
python dumpdiff.py A.bin B.bin --all                                 # everything, differences marked *
```

Sections: `header`, `profile`, `aircraft`, `preset`, `car`, `cam`, `render`. Known preset fields are labelled.

---

## 3. How the game picks a camera

### Identity and vehicle profile are different numbers

Every character has an **identity** (`Char+0x5E4`) and a **vehicle profile** (`Char+0x52C`). The camera picker
uses the identity. The R (front) view uses the vehicle profile.

| Character | Identity | Vehicle profile |
|---|---|---|
| Optimus | 1 | 0 |
| Brawl | 2 | 13 |
| Bumblebee | 3 | 1 |
| Ironhide | 7 | 5 |
| Starscream | 9 | 7 |
| Blackout | 10 | 8 |
| Bonecrusher | 14 | 12 |
| TripleC ("Shockwave") | 15 | 14 |
| **Drones** | **16 or higher (not measured yet)** | **0 (the same as Optimus)** |

The player character pointer is `[0x770614]`.

### Camera presets (slot A = on foot, slot B = vehicle)

On every camera reset (`PlayerCamera::Reset` 0x4A1B60), 0x49FF10 runs a switch on the identity at **0x4A0D46**:

```
dec eax            ; identity - 1
cmp eax, 0x0D      ; only identities 1..14 have a case
ja  default        ; 0x4A0E02
jmp [eax*4 + 0x4A0E88]
```

Each case sets two presets:

- **Slot A** `[0x7179E0]`: the **on-foot** camera.
- **Slot B** (`eax`, stored to `[0x7184C0]` at 0x4A0E0D): the **vehicle** camera (car or flight).

The game swaps between them when you transform. **The active one is `[0x71848C]`** (that's what F8 dumps).

Anything not in identities 1–14 gets the **default** case: slot A **0x721B10**, slot B **0x721DE0** (Bumblebee's
small-car camera, base distance 7.5). That's what broke TripleC (identity 15), and it's what any identity above 14
gets, **which should include the drones**.

Presets the game uses (each is 0x170 bytes):

| Preset | Used by |
|---|---|
| 0x721B10 / 0x721DE0 | Default on foot / default car (Bumblebee's). Also every identity above 14. |
| 0x71A9A0 / 0x71AF50 | Blackout on foot / Blackout heli flight |
| 0x71AC80 / 0x7219B0 | Big-vehicle on foot / big-vehicle car (Brawl, Ironhide, Bonecrusher) |
| 0x721C80 | Optimus's car: a copy of 0x7219B0 made at 0x4A02F5, heights −0.4 / −0.5 |

Presets are re-initialised at the start of every reset, so a fix must write its values **every reset** (CharacterCams
copies a preset into its own memory each time; see `BuildBonecrusherPreset`).

### Preset fields we know

| Offset | Meaning |
|---|---|
| +0x40, +0x44, +0x128, +0x12C | Live distance (starts at the base value; +0x128 is after the collision ray) |
| +0x48, +0x158 | Base distance |
| +0x4C, +0x50, +0x54 | Height offsets. **These move the camera itself up/down**, not the aim point. +0.5 is noticeable, +3 went top-down. |
| +0x68 | sin(live pitch) |
| +0x7C | **Live pitch.** The heli steering reads this too (0x440A3E, 0x441A41, 0x42CA3A), so a wrong preset breaks flying, not just the view. |
| +0x80 / +0x84 | Pitch limits (cars: −9000 / −3000) |
| +0xBC, +0xC0, +0xC4 | Default pitch (cars: −4000 = 22° down) |
| +0x130 / +0x134 | Near / far max distance. Max chase distance = lerp(near, far, speed) (0x4B07C9..0x4B0881). A small near value makes the camera hug a big vehicle when it's slow. |

Angles are in game units: 65536 = 360°, negative = looking down.

### Collision ray

The chase camera (0x4AEF10) casts a ray from its aim point back toward the camera (0x4B1040, `call [eax+0x20]`). A
hit pulls the camera in. On a big vehicle the aim point is inside the body, so the ray can hit the character's own
back. CharacterCams hooks the call at **0x4B103E** and ignores hits closer than `IgnoreRayHitsUnder` for Bonecrusher.

### R (front) view

R runs 0x4B8B3F: sets camera `+0x2AC` bit 0x200 and puts the camera in front of the vehicle, looking back. Height
(`[esp+0x34]`) and forward distance (`[esp+0x38]`) come from **byte table 0x4B8F38** (index = vehicle profile) into
jump table 0x4B8F20:

| Profile | Vehicle | Height / forward |
|---|---|---|
| 0, 26 | Optimus and the drones (0), unknown (26) | 1.5 / 9 |
| 1, 2 | Bumblebee, BB07 | 1 / 5 |
| 3 | Jazz | 0.5 / 4 |
| 5 | Ironhide | 1 / 6.5 |
| 9 | Barricade | 0.4 / 5 |
| everything else | | **0 / −2.5** (the camera ends up inside the vehicle) |

Since the drones use profile 0, their R view uses Optimus's values. That may be too far out for a small drone car.

---

## 4. Method: how to fix a character's camera

This is the method that worked for TripleC and Bonecrusher. **Measure first, then patch.** Guessing from the code
alone wasted three versions of the TripleC fix (we patched the on-foot slot when flight used the vehicle slot).

1. **Play as the broken character.** DebugTrainer → F1 → Character select → pick it → Play as.
2. **Dump.** Press F8 in robot form, in vehicle form while moving, and in vehicle form while holding R. Note which
   dump is which.
3. **Pick a reference character** whose camera feels right and is a similar size/vehicle type (Blackout for a heli,
   Bumblebee for a small car, Optimus or Ironhide for a big one). Do the same dumps as them.
4. **Compare:** `python dumpdiff.py ref.bin broken.bin -s header` shows the identity, profile and **which preset
   address is active**. Then `-s preset` shows how the presets differ. Look first at distance (+0x48), heights
   (+0x4C..+0x54), near/far (+0x130/+0x134) and live distance (+0x40) vs base (+0x48): if live is much lower than base,
   the near/far clamp or the collision ray is pulling it in.
5. **Patch** in CharacterCams (next section), rebuild, test, dump again, compare again.
6. **Write it down** in `MODLOG.md` (newest at the top), including what didn't work.

### Adding a case to CharacterCams

All in [`trainer/CharacterCams/src/CharacterCams.cpp`](../trainer/CharacterCams/src/CharacterCams.cpp):

- `g_table` is the plugin's copy of the camera jump table. It currently has **15** entries: the game's 14
  (identities 1–14) plus entry 14 for TripleC (identity 15). The patch writes the new table address at
  `0x4A0D46 + 13` and the new limit (`0x0E`) at `0x4A0D46 + 3`.
- **To give identity N its own camera** (for N above 15, e.g. a drone):
  1. Make `g_table` big enough (N entries) and fill every new entry you don't care about with the default case
     **0x4A0E02**, so those identities keep their current camera.
  2. Put a stub address at index `N − 1`. A stub ends with `eax` = slot B preset and `[0x7179E0]` = slot A preset,
     then `jmp 0x4A0E0D`. Copy `BuildStub` (fixed presets) or `BuildBcStub` + `BuildBonecrusherPreset` (a preset copied
     and edited at every reset).
  3. Set the limit byte to `N − 1` (it's a signed byte compare, so anything up to 0x7F is fine).
  4. Keep the rule: write the table address **before** the limit.
- **For an R-view fix**, the drones share profile 0 with Optimus, so changing profile 0's byte would change Optimus too.
  You'd need to check the player's identity inside the R stub instead. Bonecrusher's R fix (`BuildRStub`, profile 12)
  is the example of adding a case.
- Every patch checks the original bytes first (`Matches`) and logs and skips if they differ. Keep doing that.

---

## 5. Drones: what we already know (not tested yet)

Nobody has dumped a drone yet, so treat this as the starting point, not the answer.

- **Vehicle profile 0**, the same as Optimus (spawn setup 0x470A00, see `MODLOG.md` "Playable Ratchet"). So their R view
  uses Optimus's 1.5 / 9.
- **Car/transform models** come from `%sCar` + `%sTran` (0x471D97, the same branch as Bumblebee). `EnergonDrone` is
  different: it has no vehicle (0x471F55), like Frenzy.
- **Identity:** the damage-profile table (0x43AE78) has entries up to identity 31; which of 16–31 are drones isn't
  mapped yet. The camera switch stops at 14 (15 with CharacterCams), so **a drone almost certainly gets the
  default cameras 0x721B10 / 0x721DE0**. The F8 dump file name will give the exact identity.
- Profile 0 also picks the vehicle-manager type (0x469DD0). If a drone's handling is odd, F9 traces compared against
  Optimus will show it.

Suggested first test: play as a drone, F8 in robot form, vehicle form and vehicle + R. Do the same as Bumblebee and
Optimus. Run `dumpdiff.py` with `-s header` to confirm the identity and the active preset, then `-s preset`.

---

## 6. Gotchas we hit

- **On foot is slot A, vehicle/flight is slot B.** Measured with F8 dumps. Don't trust a guess.
- **The heli steering reads the camera preset** (+0x7C). A broken flight camera can also be broken steering.
- **Height offsets move the camera, not the aim point.** Raising them on a big vehicle made the view top-down.
- **Near distance (+0x130) caps the camera when slow.** Bumblebee's is 0.75. On Bonecrusher it left the camera on his
  back door.
- **The heli/vehicle is set up when it loads.** After changing handling, test after a fresh character swap or level load.
- **Rebuilding while the game is running** fails to copy the `.asi`. Close the game first.
- **`CharacterCams.ini` comments are the up-to-date description of each setting.** The README's INI table can lag
  behind.
