# Boss special moves (Sonic Boom, Shoot Like a Madman, Flail, Flame)

Static reading of `Transformers.exe` v1.0.254.2 plus the data files, 2026-11-07. **Not tested in game.**
Status labels: ✅ = read directly from code or data. ❓ = inferred.

## Summary
- Every special move is a normal character state. It is started by an **action bit** in the per-frame action
  word `+0x684`, the same word the player's controller fills in.
- The AI sets those bits from scripts (`SpecialMove "HoldBoom"` and similar). **The player's pad translator
  (0x446da0) never sets them.** That is the only thing stopping the player.
- The code that starts the moves (0x45002d, in the shared on-foot action handler 0x44fc10) has **no player
  check**. It runs right after the jump check, for every character.
- The playable Bumblebee, Ironhide and Megatron **already have** the ability flags (`EnableAbility Special…`
  in their `*SHAREDATTRIBS.CFG`) and the animations. Those come from their boss fights.
- **So enabling them needs a small ASI plugin:** while a key is held, OR the move's action bit into
  `player+0x684` before `Char::Update` runs. No data edits are needed for the three playable characters.

## How a move starts (gate at 0x45002d) ✅
`type` = the creature type record (`char+0x518`). Abilities live in the **second** bitfield, `type+0x1B8`.

| Move | Who has it (vanilla) | `EnableAbility` | Ability bit (`+0x1B8`) | Action bit (`+0x684`) | Extra gate | New state |
|---|---|---|---|---|---|---|
| **Sonic Boom** | Bumblebee | `SpecialSonicBoom` | 0x20000 | **0x400000** | — | 0x1F |
| **Flail** | Megatron, Barricade, tow-truck drone | `SpecialFlail` | 0x100 | **0x200000** (or 0x40000) | — | 0x1B |
| **Megatron Flame** | Megatron | `SpecialMegatronFlame` | 0x4000 | **0x800000** | `char+0x5E4 == 8` (the character is Megatron) | 0x20 |
| **Shoot Like a Madman** | Ironhide | `SpecialShootLikeAMadMan` | 0x10000 | **0x80000** | — | 0x1E |
| **Charge** | Ironhide, Megatron | `SpecialCharge` | 0x8000 | **0x100000** | — | 0x1D |
| **MiG flame** | MiG drone | `SpecialFlameAttack` | 0x2000 | **0x40000** | — | 0x1C |
| Block (special) | — | `SpecialBlock` | 0x400 | 0x40000 | — | 0x19 |
| Pickup (special) | — | `SpecialPickup` | 0x1000 | 0x40000 | — | 0x1A |
| ? | — | ? | 0x40 | 0x40000 | — | 0x15 |

- Each branch also skips the change if the character is already in that state (`+0x5C8`).
- `+0x5E4` is a **character identity** enum set at 0x470a1f–0x4716b3 by creature name ✅. 7 = Ironhide,
  8 = Megatron ("Ratchet", "Ironhide", "IronhideAAGun", "Megatron" strings sit next to those writes).

## Ability name → bit table (parser 0x408ae0, field `type+0x1B8`) ✅
`0x80` (name before SpecialFlail, not read), `SpecialFlail` 0x100, `SpecialThrow` 0x200, `SpecialBlock` 0x400,
`SpecialSapEnergy` 0x800, `SpecialPickup` 0x1000, `SpecialFlameAttack` 0x2000, `SpecialMegatronFlame` 0x4000,
`SpecialCharge` 0x8000, `SpecialShootLikeAMadMan` 0x10000, `SpecialSonicBoom` 0x20000,
`TransformVehicleLand` 0x40000.

## How the AI drives them ✅
Script commands are in the {name, handler} table around 0x6b4f70.

- **`SpecialMove` (0x413cc0).** Options: `HoldDownTime=<s|max>`, `faceopp`, `HoldCharge`, `HoldFlail`,
  `HoldMegatronFlame`, `HoldBoom`. Each frame while the hold timer runs it ORs one bit into `+0x684`:
  HoldCharge 0x100000, HoldFlail 0x200000, HoldMegatronFlame 0x800000, HoldBoom 0x400000, otherwise 0x40000.
  It also writes `char+0x758 = [0x6fb5b8]` (probably a timestamp ❓).
- **`EngageOpponent … "holdspecialflail" "holdspecialboom"`** (0x4577b6) sets 0x200000 / 0x400000 while
  walking at the target. That's how the Bumblebee and Megatron bosses walk at you while charging.
- **`IronHideShoot Range= Tolerance=` (0x45cec0).** Only runs when `+0x5E4 == 7` (Ironhide). It turns
  Ironhide to face the target and holds the fire bits `0x8 | 0x10`. When those are set it ORs **0x80000**,
  which starts the Madman state. A player version only needs the 0x80000 bit; aiming is the player's job.
- **`SpecialCharge`** is its own command (pathing, delay, overshoot).

The shared AI logic is `CarryOutSpecialMove` in `SCRIPTS\COMBAT.SCP` (and the boss copy in
`LEVELS\AUTOCITYBOSS\AI\COMBAT.SCP`).

## Data already in place for the player ✅
| Character | Ability line | Animations | Tuning |
|---|---|---|---|
| Bumblebee | `BUMBLEBEESHAREDATTRIBS.CFG:90` | `sonic_charge`, `sonic_release`, `sonic_recover` | — |
| Ironhide | `IRONHIDESHAREDATTRIBS.CFG:86-87` | `weapons_up`, `weapons_fire`, `weapons_down`, `charge_*` | `SpecialChargeSpeed 200` |
| Megatron | `MEGATRONSHAREDATTRIBS.CFG:87-89` | `spin_hook_start/idle/walk`, `special_flame`, `charge_*` | `SpecialFlailSpeed 108`, `SpecialChargeSpeed 280`; weapon `MegatronFlame` |
| MiG drone | `DRONEMIGSHAREDATTRIBS.CFG:58` | `special_flame` | weapon `DroneMigFlame` |

The MiG flame is the only one a playable character lacks. Giving it to someone means adding
`EnableAbility SpecialFlameAttack`, a `special_flame` animation group and the `DroneMigFlame` weapon to that
character's files, or playing as the MiG drone through the 2.0-style `#PlayerType` swap.

## Plugin design: `SpecialMoves.asi`
- Reuse the `mods\VehicleJump` hook on `Char::Update` (0x472560, `__thiscall`, `ret 8`). The pad read
  (0x446da0) has already filled `+0x684` when it runs.
- **Before** calling the original, for the player (`[0x770614]`) only: if the bound key is held, OR the
  action bit into `+0x684`. Holding the key = the AI's "hold" (charge-up while held for Sonic Boom and Flail).
- **INI:** one key per move, e.g. `SonicBoom=F`, `Flail=F`, `MegatronFlame=G`, `Madman=G`, `Charge=C`.
  Moves a character lacks the ability for are ignored by the game anyway, so one key can serve several
  characters.

## Risks to check in game
1. The boss states may read AI-only data: the target opponent (`faceopp`), the `+0x758` timestamp, or the
   boss "special energy" HUD (`SpecialNrgy`, `SpecialName` strings). If a state does nothing or ends at once,
   read that state's Update next.
2. Damage and hit-detection for Sonic Boom (`EFX_SonicBoom` in `EXPLOSION.CFG`) may target only the player.
   That would make it hit nothing when the player uses it.
3. Madman may need the fire bits 0x8 | 0x10 held too, like the AI does.
4. Camera and controls during the move (the player may lose control until the state ends).
5. Megatron's identity check: confirm the playable Megatron gets `+0x5E4 == 8`.

## Found in game testing (SpecialMoves 0.1–0.3)
- **Sonic Boom state (0x1F, update 0x453010):** phases at `state+0x78`. Phase 2 (charge/walk) waits for
  `char+0x7CC` bit 0. 0x446370 sets that bit for Bumblebee (identity 3/4) when the AI's target (`+0xCB0`) is in
  reach. Phase 6 spawns the shockwave (0x43E550 → 0x429800). The state never exits by itself.
- **Shockwave damage:** the ring (0x429660) stores explosion side 2 (FRIEND) at 0x429791. The physics push
  0x506180 checks the body's flags at `+0xAA`: 0x4 = hurt by Autobot, 0x8 = by Decepticon, 0x10 = by FRIEND.
  Hits then go to 0x465070 with IMPACT_SHOCKWAVE (`IMPACTTYPES.CFG`: 100 damage, fly-back).
- **Side values** (`type+0x28`, keyword `Side`): AUTOBOT 0, DECEPTICON 1, FRIEND 2, ENEMY 3.
- **Madman state (0x1E, update 0x452CC0):** phases at `state+0x74`: 0 stance, 1 weapons_up, 2 fire,
  3 weapons_down. In phase 2, action 0x8 fires weapon slot 0, 0x10 fires slot 1, and both fire slot 2.
  Weapon slots are at `char+0x1B34 + slot*0x70`.
- **Flail (0x4529C0):** no exit of its own.
- **Exit on release:** Madman exits when fire stops. Megatron Flame (0x453360) exits when 0x800000 drops.
- **Per-character update** (0x448C60) dispatches on identity: 3/4 Bumblebee → 0x446370, 7 Ironhide → 0x438180,
  8 Megatron → 0x405110.
