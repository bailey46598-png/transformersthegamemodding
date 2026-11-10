// CharacterCams.asi: per-character camera fixes (Transformers: The Game v1.0.254.2). Replaces TripleCFlightCam.asi.
//   - TripleC (Shockwave): Blackout's flight camera, on-foot camera and heli handling.
//   - Bonecrusher: a Bumblebee-style car camera sized for the Buffalo, and a working R (front) view.
//
// How the exe picks cameras (static reading):
//   - PlayerCamera::Reset 0x4A1B60 calls 0x49FF10, which switches on the player's identity (Char+0x5E4, minus 1)
//     at 0x4A0D46: `cmp eax,0xD / ja default / jmp [eax*4+0x4A0E88]`.
//   - Each case sets two presets: slot A [0x7179E0] and slot B (eax, stored to [0x7184C0] at 0x4A0E0D). The
//     transform code (0x4B86xx) swaps between them.
//   - Measured in game (F8 dumps, 2026-11-10): in heli flight the active preset is slot B. Blackout flies with
//     0x71AF50, TripleC with 0x721DE0 (the generic default). Slot A is the on-foot camera.
//   - Blackout is identity 10: slot A 0x71A9A0, slot B 0x71AF50 (flight).
//   - TripleC is identity 15, past the end of the 14-entry table, so it gets the generic default:
//     slot A 0x721B10, slot B 0x721DE0. In flight that camera is at distance 7.5 (Blackout 25).
//   - The heli steering reads the active preset too (aircraft code at 0x440A3E / 0x441A41 / 0x42CA3A read
//     preset +0x7C), so the wrong preset also breaks steering: TripleC's steer target stayed at his own position.
//
// What this changes (same-length patches):
//   1. 0x4A0D49: table limit 0xD -> 0xE, so identity 15 gets a table entry.
//   2. 0x4A0D53: the jump table address -> a 15-entry copy in this DLL. Entries 0..13 are the originals.
//      Entry 14 jumps to a small stub: slot A = on-foot choice (INI), slot B = Blackout's flight preset, then it
//      continues at 0x4A0E0D like every other case.
#include <windows.h>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static char  g_dir[MAX_PATH];
static FILE* g_log;

static void Log(const char* fmt, ...) {
    if (!g_log) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(g_log, "[%02d:%02d:%02d.%03d] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list a; va_start(a, fmt); vfprintf(g_log, fmt, a); va_end(a);
    fputc('\n', g_log); fflush(g_log);
}

namespace game {
constexpr uintptr_t kSwitch        = 0x4A0D46;  // dec eax / cmp eax,0xD / ja / jmp [eax*4+table]
constexpr uintptr_t kTable         = 0x4A0E88;  // 14 case addresses
constexpr int       kTableCount    = 14;
constexpr uintptr_t kDefaultCase   = 0x4A0E02;  // mov [0x7179E0],ecx / mov eax,0x721DE0 / mov [0x7184C0],eax
constexpr uintptr_t kBlackoutCase  = 0x4A0D57;  // mov [0x7179E0],0x71A9A0 / mov eax,0x71AF50 / jmp 0x4A0E0D
constexpr uintptr_t kContinue      = 0x4A0E0D;  // mov [0x7184C0],eax
constexpr uintptr_t kSlotA         = 0x7179E0;  // on-foot preset
constexpr uint32_t  kBlackoutFoot  = 0x71A9A0;  // Blackout slot A
constexpr uint32_t  kBlackoutFly   = 0x71AF50;  // Blackout slot B: active in heli flight (measured)
constexpr uint32_t  kDefaultFoot   = 0x721B10;  // TripleC's slot A without the patch (ecx in the default case)
}

// ---------------------------------------------------------------- flight model
// Aircraft setup 0x43F650 switches on vehicle type: TripleC (0x20) calls 0x41C2C0, the AI gunship handling also
// used by type 0x13; Blackout (0x21) calls 0x41CD20 and then sets aircraft +0x368 = 8 (default 7, set at 0x43F604).
// The hook replaces `call 0x41C2C0` at 0x43FA18 (TripleC's case only): it runs the original, so TripleC keeps its
// own gun positions, then writes Blackout's handling values over it.
namespace flight {
constexpr uintptr_t kCallSite = 0x43FA18;  // E8 rel32 -> 0x41C2C0
constexpr uintptr_t kTcParams = 0x41C2C0;
constexpr int       kMode     = 0x368;
struct Field { int off; uint32_t bits; };  // float bit patterns, exactly as 0x41CD20 writes them
// From 0x41CD20 vs 0x41C2C0: every field the two set differently.
constexpr Field kFields[] = {
    {0x114, 0x40600000},  // 3.5
    {0x230, 0x42C80000},  // 100
    {0x234, 0x42480000},  // 50
    {0x238, 0x41A00000},  // 20
    {0x248, 0x3951B717},  // 0.0002
    {0x24C, 0x3BA3D70A},  // 0.005
    {0x254, 0x40000000},  // 2
    {0x258, 0x40000000},  // 2
    {0x260, 0x43061555},  // 134.083
    {0x264, 0x428F05B0},  // 71.511
    {0x268, 0x4220E666},  // 40.225
    {0x26C, 0x3FA00000},  // 1.25
    {0x284, 0x3DCCCCCD},  // 0.1
};
}

typedef void(__fastcall* ParamsFn)(void* aircraft, void* unused);

static void __fastcall HookTripleCParams(uint8_t* aircraft, void*) {
    reinterpret_cast<ParamsFn>(flight::kTcParams)(aircraft, nullptr);
    for (const auto& f : flight::kFields) memcpy(aircraft + f.off, &f.bits, 4);
    *reinterpret_cast<int*>(aircraft + flight::kMode) = 8;
}

static const uint8_t kCallOrig[] = {0xE8, 0xA3, 0xC8, 0xFD, 0xFF};

static uint32_t g_table[game::kTableCount + 1];
static uint8_t* g_stub;

static const uint8_t kSwitchOrig[] = {0x48, 0x83, 0xF8, 0x0D, 0x0F, 0x87, 0xB2, 0x00, 0x00, 0x00,
                                      0xFF, 0x24, 0x85, 0x88, 0x0E, 0x4A, 0x00};
static const uint8_t kDefaultOrig[] = {0x89, 0x0D, 0xE0, 0x79, 0x71, 0x00, 0xB8, 0xE0, 0x1D, 0x72, 0x00,
                                       0xA3, 0xC0, 0x84, 0x71, 0x00};
static const uint8_t kBlackoutOrig[] = {0xC7, 0x05, 0xE0, 0x79, 0x71, 0x00, 0xA0, 0xA9, 0x71, 0x00,
                                        0xB8, 0x50, 0xAF, 0x71, 0x00};

static void Put32(uint8_t* p, uint32_t v) { memcpy(p, &v, 4); }

static bool Matches(uintptr_t at, const void* sig, size_t n) {
    MEMORY_BASIC_INFORMATION mbi;
    if (!VirtualQuery(reinterpret_cast<void*>(at), &mbi, sizeof mbi) || mbi.State != MEM_COMMIT) return false;
    __try { return memcmp(reinterpret_cast<void*>(at), sig, n) == 0; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

// The original table must still point at the 14 known cases (all inside 0x4A0D57..0x4A0E02).
static bool TableLooksRight() {
    __try {
        const uint32_t* t = reinterpret_cast<const uint32_t*>(game::kTable);
        for (int i = 0; i < game::kTableCount; ++i)
            if (t[i] < game::kBlackoutCase || t[i] > game::kDefaultCase) return false;
        return t[9] == game::kBlackoutCase;  // identity 10 = Blackout
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static bool AllMatch() {
    return Matches(game::kSwitch, kSwitchOrig, sizeof kSwitchOrig) &&
           Matches(game::kDefaultCase, kDefaultOrig, sizeof kDefaultOrig) &&
           Matches(game::kBlackoutCase, kBlackoutOrig, sizeof kBlackoutOrig) && TableLooksRight() &&
           Matches(flight::kCallSite, kCallOrig, sizeof kCallOrig);
}

static bool WriteCode(uintptr_t at, const void* bytes, size_t n) {
    DWORD old;
    if (!VirtualProtect(reinterpret_cast<void*>(at), n, PAGE_EXECUTE_READWRITE, &old)) {
        Log("VirtualProtect failed at 0x%08X (%lu)", static_cast<unsigned>(at), GetLastError());
        return false;
    }
    memcpy(reinterpret_cast<void*>(at), bytes, n);
    VirtualProtect(reinterpret_cast<void*>(at), n, old, &old);
    FlushInstructionCache(GetCurrentProcess(), reinterpret_cast<void*>(at), n);
    return true;
}

// ---------------------------------------------------------------- INI (CharacterCams.ini)
static void IniPath(char* out, size_t n) { snprintf(out, n, "%s\\CharacterCams.ini", g_dir); }

static bool IniIs(const char* sec, const char* key, const char* def, const char* value) {
    char ini[MAX_PATH], v[32];
    IniPath(ini, sizeof ini);
    GetPrivateProfileStringA(sec, key, def, v, sizeof v, ini);
    return _stricmp(v, value) == 0;
}

static float IniFloat(const char* sec, const char* key, float def) {
    char ini[MAX_PATH], v[32], d[32];
    IniPath(ini, sizeof ini);
    snprintf(d, sizeof d, "%g", def);
    GetPrivateProfileStringA(sec, key, d, v, sizeof v, ini);
    return static_cast<float>(atof(v));
}

// [TripleC] RobotCamera=Blackout (default, Blackout's on-foot preset) or Default (the game's own).
static uint32_t FootPreset() {
    return IniIs("TripleC", "RobotCamera", "Blackout", "Blackout") ? game::kBlackoutFoot : game::kDefaultFoot;
}

// [TripleC] FlightModel=Blackout (default) or Default (the game's own TripleC handling).
static bool UseBlackoutFlight() { return !IniIs("TripleC", "FlightModel", "Blackout", "Default"); }

// ---------------------------------------------------------------- Bonecrusher
// Identity 14 (vehicle profile 12). Measured (F8 dumps, 2026-11-10):
//   - Car camera: slot B 0x7219B0, the big-vehicle preset shared with Brawl (id 2) and Ironhide (id 7). Same base
//     distance as Bumblebee's 0x721DE0 (+0x48 / +0x158 = 7.5), but a vehicle twice as long (9.5 vs 4.9) and 3.5x
//     as tall, so the camera sits close behind the cab.
//   - R view (0x4B8B3F): the camera goes in front of the vehicle, looking back. Height/forward come from a byte
//     table by vehicle profile (0x4B8F38) into 6 cases (jump table 0x4B8F20). Profile 12 has no case and gets the
//     fallback (height 0, forward -2.5): inside the Buffalo.
namespace bc {
constexpr int       kTableIndex   = 13;        // identity 14 - 1
constexpr uintptr_t kBigCase      = 0x4A0DB1;  // its original case (also ids 2 and 7)
constexpr uint32_t  kFootPreset   = 0x71AC80;  // its slot A, kept
constexpr uint32_t  kBumblebeeCar = 0x721DE0;  // Bumblebee's car preset (re-initialised at 0x49FF26 every reset)
constexpr uint32_t  kTruckCar     = 0x7219B0;  // the game's big-vehicle preset (Bonecrusher/Brawl/Ironhide); Optimus's
                                               // 0x721C80 is a copy of it (0x4A02F5) with heights -0.4/-0.5, far 5
constexpr size_t    kPresetSize   = 0x170;     // preset stride (0x721B10 -> 0x721C80)
// Preset fields
constexpr int kDistLive[] = {0x40, 0x44, 0x128, 0x12C};  // current distance (starts at the base value)
constexpr int kDistBase[] = {0x48, 0x158};               // base distance
constexpr int kHeight[]   = {0x4C, 0x50, 0x54};          // height offsets (Blackout's heli: 6; cars: about -0.5)
// Max chase distance = lerp(+0x130 near, +0x134 far, t) at 0x4B07C9..0x4B0881 (t <= 1, grows with speed); that
// becomes the clamp [esp+0x60]. Bumblebee: 0.75 / 20, so a stopped Buffalo had ~5.6 (camera on his back door).
constexpr int kNear = 0x130, kFar = 0x134;
// Pitch, in the game's angle units (65536 = 360 degrees, negative = looking down). +0xBC/+0xC0/+0xC4 hold the
// default (-4000 = 22 degrees for every car); +0x7C is the live pitch, which settles on it (F8 dumps). +0x80/+0x84
// are the limits (-9000 / -3000). +0x68 is the sine of the live pitch.
constexpr int kPitchDefault[] = {0xBC, 0xC0, 0xC4};
constexpr int kPitchLive = 0x7C;
// R view
constexpr uintptr_t kRProfileByte = 0x4B8F38 + 12;       // byte table entry for profile 12
constexpr uintptr_t kRJump        = 0x4B8C1F;            // FF 24 95 <table>
constexpr uintptr_t kRTable       = 0x4B8F20;            // 6 cases
constexpr int       kRCases       = 6;
constexpr uintptr_t kRContinue    = 0x4B8C90;
}

static uint8_t   g_bcPreset[bc::kPresetSize];
static float     g_bcDistance = 12.0f, g_bcHeight = 0.0f, g_bcNear = 12.0f, g_bcFar = 14.0f;
static float     g_bcPitch = -6000.0f;   // 33 degrees down (the truck preset's own); set from CarPitchDegrees
static uint32_t  g_bcBase = bc::kTruckCar;
static uint32_t  g_rTable[bc::kRCases + 1];
static uint8_t*  g_bcStub;   // camera case for identity 14
static uint8_t*  g_rStub;    // R-view case for profile 12

static const uint8_t kRCodeOrig[] = {0x83, 0xF8, 0x1A, 0x77, 0x68, 0x0F, 0xB6, 0x90, 0x38, 0x8F, 0x4B, 0x00,
                                     0xFF, 0x24, 0x95, 0x20, 0x8F, 0x4B, 0x00};
static const uint8_t kRByteTable[] = {0x00, 0x01, 0x01, 0x02, 0x05, 0x03, 0x05, 0x05, 0x05, 0x04, 0x05, 0x05, 0x05,
                                      0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x00};
static const uint8_t kRJumpTable[] = {0x6E, 0x8C, 0x4B, 0x00, 0x26, 0x8C, 0x4B, 0x00, 0x4A, 0x8C, 0x4B, 0x00,
                                      0x38, 0x8C, 0x4B, 0x00, 0x5C, 0x8C, 0x4B, 0x00, 0x80, 0x8C, 0x4B, 0x00};
static const uint8_t kBigCaseOrig[] = {0xC7, 0x05, 0xE0, 0x79, 0x71, 0x00, 0x80, 0xAC, 0x71, 0x00,
                                       0xB8, 0xB0, 0x19, 0x72, 0x00};

// Called from the identity-14 stub during the camera reset: a fresh copy of Bumblebee's car preset, resized for the
// Buffalo. Returns the preset for slot B. cdecl; keeps ebx/esi/edi/ebp as the reset code expects.
static uint32_t __cdecl BuildBonecrusherPreset() {
    memcpy(g_bcPreset, reinterpret_cast<const void*>(g_bcBase), sizeof g_bcPreset);
    for (int o : bc::kDistLive) memcpy(g_bcPreset + o, &g_bcDistance, 4);
    for (int o : bc::kDistBase) memcpy(g_bcPreset + o, &g_bcDistance, 4);
    for (int o : bc::kHeight) { float h; memcpy(&h, g_bcPreset + o, 4); h += g_bcHeight; memcpy(g_bcPreset + o, &h, 4); }
    memcpy(g_bcPreset + bc::kNear, &g_bcNear, 4);
    memcpy(g_bcPreset + bc::kFar, &g_bcFar, 4);
    for (int o : bc::kPitchDefault) memcpy(g_bcPreset + o, &g_bcPitch, 4);
    memcpy(g_bcPreset + bc::kPitchLive, &g_bcPitch, 4);
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_bcPreset));
}

static uint8_t* AllocStub() {
    return static_cast<uint8_t*>(VirtualAlloc(nullptr, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE));
}
static void PutJmp(uint8_t*& p, uintptr_t to) {
    *p++ = 0xE9; Put32(p, static_cast<uint32_t>(to - (reinterpret_cast<uintptr_t>(p) + 4))); p += 4;
}

// call BuildBonecrusherPreset / mov dword [0x7179E0], 0x71AC80 / jmp 0x4A0E0D (eax = slot B)
static bool BuildBcStub() {
    if (!(g_bcStub = AllocStub())) return false;
    uint8_t* p = g_bcStub;
    *p++ = 0xE8; Put32(p, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&BuildBonecrusherPreset) -
                                                (reinterpret_cast<uintptr_t>(p) + 4))); p += 4;
    *p++ = 0xC7; *p++ = 0x05; Put32(p, game::kSlotA); p += 4; Put32(p, bc::kFootPreset); p += 4;
    PutJmp(p, game::kContinue);
    FlushInstructionCache(GetCurrentProcess(), g_bcStub, 64);
    return true;
}

// mov dword [esp+0x34], height / mov dword [esp+0x38], forward / jmp 0x4B8C90 (same as the game's own cases)
static bool BuildRStub(float h, float f) {
    if (!(g_rStub = AllocStub())) return false;
    uint8_t* p = g_rStub;
    uint32_t hb, fb; memcpy(&hb, &h, 4); memcpy(&fb, &f, 4);
    *p++ = 0xC7; *p++ = 0x44; *p++ = 0x24; *p++ = 0x34; Put32(p, hb); p += 4;
    *p++ = 0xC7; *p++ = 0x44; *p++ = 0x24; *p++ = 0x38; Put32(p, fb); p += 4;
    PutJmp(p, bc::kRContinue);
    FlushInstructionCache(GetCurrentProcess(), g_rStub, 64);
    return true;
}

static bool RMatches() {
    return Matches(bc::kRJump - 12, kRCodeOrig, sizeof kRCodeOrig) &&
           Matches(0x4B8F38, kRByteTable, sizeof kRByteTable) &&
           Matches(bc::kRTable, kRJumpTable, sizeof kRJumpTable);
}

static bool BuildStub(uint32_t foot) {
    g_stub = static_cast<uint8_t*>(VirtualAlloc(nullptr, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE));
    if (!g_stub) { Log("VirtualAlloc failed (%lu)", GetLastError()); return false; }
    uint8_t* p = g_stub;
    // mov dword ptr [0x7179E0], foot      (slot A, on foot)
    *p++ = 0xC7; *p++ = 0x05; Put32(p, game::kSlotA); p += 4; Put32(p, foot); p += 4;
    // mov eax, 0x71AF50                   (slot B, flight: Blackout's)
    *p++ = 0xB8; Put32(p, game::kBlackoutFly); p += 4;
    // jmp 0x4A0E0D
    *p++ = 0xE9; Put32(p, static_cast<uint32_t>(game::kContinue - (reinterpret_cast<uintptr_t>(p) + 4))); p += 4;
    FlushInstructionCache(GetCurrentProcess(), g_stub, 64);
    return true;
}

// ---------------------------------------------------------------- Bonecrusher: camera ray vs his own body
// The chase camera (0x4AEF10) casts a collision ray from its aim point back toward where it wants to sit
// (0x4B1040: `call [eax+0x20]` on the collision object, args: ray, out float distance, 2). A hit caps the live
// distance ([esp+0x60] -> preset +0x128 at 0x4B1209). The Buffalo's aim point is low inside his body, so the ray hits
// his own rear (~5.5 from his centre; his tail is at 4.8): measured live distance 5.56 with base 13. The camera then
// sits on his back door and jumps whenever the ray starts to miss or hit.
// The hook ignores hits closer than [Bonecrusher] IgnoreRayHitsUnder (default 6) while the player is Bonecrusher in
// vehicle form. Anything further away (walls) still pulls the camera in.
namespace ray {
constexpr uintptr_t kSite      = 0x4B103E;   // 8B CB (mov ecx,ebx) FF 50 20 (call [eax+0x20]) -> E8 thunk
constexpr uintptr_t kPlayer    = 0x770614;
constexpr int       kIdentity  = 0x5E4;
constexpr int       kFlags     = 0x628;      // bit 18: vehicle form (0x4A0E39 picks slot B on it)
constexpr int       kBonecrusher = 14;
}
static const uint8_t kRaySiteOrig[] = {0x8B, 0xCB, 0xFF, 0x50, 0x20, 0x84, 0xC0};
static float g_ignoreUnder = 6.0f;
static volatile LONG g_rayIgnored = 0;
static uint8_t* g_rayThunk;

typedef char(__fastcall* RayFn)(void* self, void* edx, void* ray, float* out, int mode);

static bool PlayerIsBonecrusherCar() {
    __try {
        const uint8_t* ch = *reinterpret_cast<uint8_t* const*>(ray::kPlayer);
        if (!ch) return false;
        return *reinterpret_cast<const int*>(ch + ray::kIdentity) == ray::kBonecrusher &&
               (*reinterpret_cast<const uint32_t*>(ch + ray::kFlags) & (1u << 18)) != 0;
    }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

// thiscall target with 3 stack args; __fastcall with a dummy edx has the same convention (callee pops 12).
static char __fastcall HookCameraRay(void* self, void*, void* rayArg, float* out, int mode) {
    RayFn orig = reinterpret_cast<RayFn>((*reinterpret_cast<void***>(self))[0x20 / 4]);
    const char hit = orig(self, nullptr, rayArg, out, mode);
    if (hit && out && *out < g_ignoreUnder && PlayerIsBonecrusherCar()) {
        InterlockedIncrement(&g_rayIgnored);
        return 0;
    }
    return hit;
}

// Thunk at the call site: mov ecx,ebx / jmp HookCameraRay (the E8 at the site pushed the return to 0x4B1043).
static bool BuildRayThunk() {
    if (!(g_rayThunk = AllocStub())) return false;
    uint8_t* p = g_rayThunk;
    *p++ = 0x8B; *p++ = 0xCB;
    PutJmp(p, reinterpret_cast<uintptr_t>(&HookCameraRay));
    FlushInstructionCache(GetCurrentProcess(), g_rayThunk, 64);
    return true;
}

// ---------------------------------------------------------------- Bonecrusher: car handling (the hop)
// Car setup 0x442880 switches on vehicle type (0x442B20, table 0x4445B8, index = type - 1). Bonecrusher's car (type
// 0x25, case 0x443F4F) fills its handling block with 0x432F90; Optimus (same size, 6 wheels, drives smoothly) uses
// 0x4344A0. Both take the block as one stack argument (ret 4); 0x422630 resets it first (wheel count +0xAC = 0).
// Differences: mass +0x70 600 vs 750, body +0x40/+0x48, centre +0x54 -0.85 vs -0.1, and per-wheel tyre grip (wheel
// record +0xA8: 5 vs 3, +0xAC: 3 vs 2; used as load x grip at 0x65829A / 0x6582FA). In game the Buffalo pitches and
// hops about once a second while driving.
// The hook (call at 0x443F6B, Bonecrusher's case only) runs his own setup, so his 6 wheels stay where his model has
// them, then copies Optimus's body block (+0x40..+0xA8) and the per-wheel tuning fields (not positions or flags).
namespace handling {
constexpr uintptr_t kSite      = 0x443F6B;   // E8 -> 0x432F90
constexpr uintptr_t kBcParams  = 0x432F90;
constexpr uintptr_t kOptParams = 0x4344A0;
constexpr int kBodyFrom = 0x40, kBodyTo = 0xA8;   // inclusive; +0xAC is the wheel count
constexpr int kWheelCount = 0xAC, kWheelBase = 0xB0, kWheelStride = 0x100;
constexpr int kWheelFields[] = {0xA0, 0xA8, 0xAC, 0xD0, 0xDC, 0xE0, 0xE4, 0xEC};  // written by 0x6531B0
}
static const uint8_t kHandlingSiteOrig[] = {0xE8, 0x20, 0xF0, 0xFE, 0xFF};
alignas(16) static uint8_t g_optBlock[0x1400];
// Suspension (F9 trace, 2026-11-10): the live wheel record (0x6536B0 copies the block's wheel record 1:1) gives
// spring force = curve(compression) x +0xDC, damping = speed x (+0xE0 compressing / +0xE4 extending), capped at
// mass x 50 (0x657F3E..0x658032). Travel is 0.5. With damping 0.5 the Buffalo slammed between full droop (middle
// wheels lost contact) and past full compression (forces to 12,662): the hop. +0xA0 is the physics wheel radius
// (0.566 copied from Optimus; his drawn wheel is 1.0, so it sank 0.43 into the ground).
static float g_wheelDamping = 2.0f, g_wheelSpring = 1.0f, g_wheelRadius = 1.0f;
static volatile LONG g_handlingApplied = 0;

typedef void(__stdcall* CarParamsFn)(void* block);

static void __fastcall HookBonecrusherHandling(void* /*car*/, void*, uint8_t* block) {
    reinterpret_cast<CarParamsFn>(handling::kBcParams)(block);
    memset(g_optBlock, 0, sizeof g_optBlock);
    reinterpret_cast<CarParamsFn>(handling::kOptParams)(g_optBlock);
    memcpy(block + handling::kBodyFrom, g_optBlock + handling::kBodyFrom,
           handling::kBodyTo + 4 - handling::kBodyFrom);
    const int n = *reinterpret_cast<int*>(block + handling::kWheelCount);
    const int m = *reinterpret_cast<int*>(g_optBlock + handling::kWheelCount);
    for (int i = 0; i < n && i < m && i < 16; ++i) {
        uint8_t* w = block + handling::kWheelBase + i * handling::kWheelStride;
        const uint8_t* o = g_optBlock + handling::kWheelBase + i * handling::kWheelStride;
        for (int f : handling::kWheelFields) memcpy(w + f, o + f, 4);
        if (g_wheelDamping > 0) { memcpy(w + 0xE0, &g_wheelDamping, 4); memcpy(w + 0xE4, &g_wheelDamping, 4); }
        if (g_wheelSpring > 0) { float k; memcpy(&k, w + 0xDC, 4); k *= g_wheelSpring; memcpy(w + 0xDC, &k, 4); }
        if (g_wheelRadius > 0) memcpy(w + 0xA0, &g_wheelRadius, 4);
    }
    InterlockedIncrement(&g_handlingApplied);
}

static DWORD WINAPI InitThread(LPVOID) {
    // The retail exe decrypts its code after start-up, so wait until the original bytes are there. The camera is
    // only set up once a level loads, long after this.
    const DWORD timeoutMs = 300000, start = GetTickCount();
    while (!AllMatch()) {
        if (GetTickCount() - start > timeoutMs) {
            Log("bytes differ at 0x%08X / 0x%08X / 0x%08X / table. Not v1.0.254.2, or another mod patched them. "
                "Nothing installed.", static_cast<unsigned>(game::kSwitch),
                static_cast<unsigned>(game::kDefaultCase), static_cast<unsigned>(game::kBlackoutCase));
            return 0;
        }
        Sleep(1);
    }
    Log("code bytes match v1.0.254.2 (after %lums)", GetTickCount() - start);

    const uint32_t foot = FootPreset();
    if (!BuildStub(foot)) return 0;
    memcpy(g_table, reinterpret_cast<const void*>(game::kTable), sizeof(uint32_t) * game::kTableCount);
    g_table[game::kTableCount] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_stub));

    // Bonecrusher car camera: [Bonecrusher] CarCamera=Truck (default: the game's big-vehicle camera, fixed up),
    // Bumblebee (Bumblebee's car camera, resized) or Default (untouched).
    const bool bcCam = !IniIs("Bonecrusher", "CarCamera", "Truck", "Default");
    const bool bcBumblebee = IniIs("Bonecrusher", "CarCamera", "Truck", "Bumblebee");
    g_bcBase = bcBumblebee ? bc::kBumblebeeCar : bc::kTruckCar;
    if (bcCam) {
        g_bcDistance = IniFloat("Bonecrusher", "CarDistance", 12.0f);
        g_bcHeight = IniFloat("Bonecrusher", "CarHeight", 0.0f);
        {
            float deg = IniFloat("Bonecrusher", "CarPitchDegrees", 33.0f);
            if (deg < 0) deg = -deg;
            if (deg > 49) deg = 49;   // the preset limit is -9000 (49 degrees)
            if (deg < 17) deg = 17;   // and -3000 (16.5 degrees)
            g_bcPitch = -deg * 65536.0f / 360.0f;
        }
        g_bcNear = IniFloat("Bonecrusher", "CarNearDistance", 12.0f);
        g_bcFar = IniFloat("Bonecrusher", "CarFarDistance", 14.0f);
        if (g_table[bc::kTableIndex] == bc::kBigCase && Matches(bc::kBigCase, kBigCaseOrig, sizeof kBigCaseOrig) &&
            BuildBcStub()) {
            g_table[bc::kTableIndex] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_bcStub));
            Log("Bonecrusher (identity 14): car camera = %s preset copied at each reset, distance %.2f "
                "(Bumblebee 7.5), height %+.2f, near %.2f / far %.2f (Bumblebee 0.75 / 20), pitch %.0f units = %.1f deg down "
                "(Bumblebee 22); on-foot camera unchanged (0x%08X)",
                bcBumblebee ? "Bumblebee's" : "the truck (0x7219B0)", g_bcDistance, g_bcHeight, g_bcNear, g_bcFar, g_bcPitch, -g_bcPitch * 360.0f / 65536.0f, bc::kFootPreset);
        } else {
            Log("Bonecrusher camera: case bytes differ, left unchanged");
        }
    } else {
        Log("Bonecrusher CarCamera=Default: car camera unchanged (0x7219B0)");
    }

    // Patch the jump table address first, then the limit, so the new entry is never reached through the old table.
    uint8_t addr[4];
    Put32(addr, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_table)));
    const uint8_t limit = 0x0E;
    if (WriteCode(game::kSwitch + 13, addr, 4) && WriteCode(game::kSwitch + 3, &limit, 1)) {
        Log("patched: camera table -> 0x%08X (15 entries), limit 0xD -> 0xE",
            static_cast<unsigned>(reinterpret_cast<uintptr_t>(g_table)));
        Log("TripleC (identity 15): flight camera 0x%08X (Blackout's), on-foot camera 0x%08X (%s)",
            game::kBlackoutFly, foot, foot == game::kBlackoutFoot ? "Blackout" : "default, unchanged");
    }

    if (UseBlackoutFlight()) {
        uint8_t call[5] = {0xE8};
        Put32(call + 1, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&HookTripleCParams) -
                                              (flight::kCallSite + 5)));
        if (WriteCode(flight::kCallSite, call, 5))
            Log("patched: TripleC heli handling -> Blackout's (%u fields, mode 8) at 0x%08X",
                static_cast<unsigned>(sizeof flight::kFields / sizeof flight::kFields[0]),
                static_cast<unsigned>(flight::kCallSite));
    } else {
        Log("FlightModel=Default: TripleC heli handling unchanged");
    }

    // Bonecrusher R view: [Bonecrusher] RView=On (default) or Off, RViewHeight, RViewForward.
    if (!IniIs("Bonecrusher", "RView", "On", "Off")) {
        const float h = IniFloat("Bonecrusher", "RViewHeight", 2.0f);
        const float f = IniFloat("Bonecrusher", "RViewForward", 10.0f);
        if (RMatches() && BuildRStub(h, f)) {
            memcpy(g_rTable, reinterpret_cast<const void*>(bc::kRTable), sizeof(uint32_t) * bc::kRCases);
            g_rTable[bc::kRCases] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_rStub));
            // Table address first, then the profile byte, so the new case is never read through the old table.
            uint8_t addr[4];
            Put32(addr, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_rTable)));
            const uint8_t idx = static_cast<uint8_t>(bc::kRCases);
            if (WriteCode(bc::kRJump + 3, addr, 4) && WriteCode(bc::kRProfileByte, &idx, 1))
                Log("patched: R view for profile 12 (Bonecrusher): height %.2f, forward %.2f "
                    "(was the fallback 0 / -2.5; Optimus 1.5 / 9, Bumblebee 1 / 5)", h, f);
        } else {
            Log("R view: bytes differ at 0x%08X, left unchanged", static_cast<unsigned>(bc::kRJump));
        }
    } else {
        Log("Bonecrusher RView=Off: R view unchanged");
    }

    // Bonecrusher camera ray: [Bonecrusher] IgnoreRayHitsUnder=6 (0 = off).
    g_ignoreUnder = IniFloat("Bonecrusher", "IgnoreRayHitsUnder", 6.0f);
    if (g_ignoreUnder > 0.0f) {
        if (Matches(ray::kSite, kRaySiteOrig, sizeof kRaySiteOrig) && BuildRayThunk()) {
            uint8_t call[5] = {0xE8};
            Put32(call + 1, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(g_rayThunk) - (ray::kSite + 5)));
            if (WriteCode(ray::kSite, call, 5))
                Log("patched: chase-camera ray at 0x%08X ignores hits under %.2f for Bonecrusher in vehicle form "
                    "(his own body; tail at 4.8 from centre)", static_cast<unsigned>(ray::kSite), g_ignoreUnder);
        } else {
            Log("camera ray: bytes differ at 0x%08X, left unchanged", static_cast<unsigned>(ray::kSite));
        }
    } else {
        Log("Bonecrusher IgnoreRayHitsUnder=0: camera ray unchanged");
    }

    // Bonecrusher handling: [Bonecrusher] Handling=Optimus (default) or Default.
    if (!IniIs("Bonecrusher", "Handling", "Optimus", "Default")) {
        if (Matches(handling::kSite, kHandlingSiteOrig, sizeof kHandlingSiteOrig)) {
            uint8_t call[5] = {0xE8};
            Put32(call + 1, static_cast<uint32_t>(reinterpret_cast<uintptr_t>(&HookBonecrusherHandling) -
                                                  (handling::kSite + 5)));
            g_wheelDamping = IniFloat("Bonecrusher", "WheelDamping", 2.0f);
            g_wheelSpring = IniFloat("Bonecrusher", "WheelSpring", 1.0f);
            g_wheelRadius = IniFloat("Bonecrusher", "WheelRadius", 1.0f);
            if (WriteCode(handling::kSite, call, 5))
                Log("patched: Bonecrusher car handling -> Optimus's (body +0x40..+0xA8, tyre grip per wheel), "
                    "his own 6 wheel positions kept; suspension damping %.2f (was 0.5), spring x%.2f, wheel radius "
                    "%.2f (was 0.566; his tyre is 1.0) (0x%08X)", g_wheelDamping, g_wheelSpring, g_wheelRadius,
                    static_cast<unsigned>(handling::kSite));
        } else {
            Log("handling: bytes differ at 0x%08X, left unchanged", static_cast<unsigned>(handling::kSite));
        }
    } else {
        Log("Bonecrusher Handling=Default: car handling unchanged");
    }
    return 0;
}

// ---------------------------------------------------------------- F8 dump (diagnostics)
// Writes the player's active vehicle profile (Char+0x52C/+0x530), its aircraft (profile+0xC -> +8, 0xA90 bytes)
// and the active camera preset ([0x71848C], 0x160 bytes) to CharacterCams_dump_id<identity>_<n>.bin, so a
// Blackout flight and a TripleC flight can be compared field by field.
namespace dump {
constexpr uintptr_t kPlayer     = 0x770614;  // Char*
constexpr uintptr_t kPreset     = 0x71848C;  // active camera preset
constexpr int       kIdentity   = 0x5E4;
constexpr int       kBodyFlag   = 0x5C0;     // == 1 -> use +0x530 when set (same test as 0x43BB8F)
constexpr int       kBodyA      = 0x52C;
constexpr int       kBodyB      = 0x530;
constexpr size_t    kProfile    = 0x80;
constexpr size_t    kAircraft   = 0xA90;
constexpr size_t    kPresetSize = 0x160;
}

static bool SafeCopy(void* dst, uintptr_t src, size_t n) {
    if (!src) return false;
    __try { memcpy(dst, reinterpret_cast<const void*>(src), n); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { return false; }
}

// v2 (0.6) adds the car body (profile+0xC -> +4, 0x7F0 bytes), the player camera object [0x770610] and the render
// camera [0x77060C], so car cameras (and the R view) can be compared too.
namespace dump2 {
constexpr uintptr_t kPlayerCam = 0x770610;
constexpr uintptr_t kRenderCam = 0x77060C;
constexpr size_t    kCar       = 0x7F0;
constexpr size_t    kCamObj    = 0x400;
constexpr size_t    kRender    = 0x100;
}

static void DumpNow(int n) {
    // Header (16 u32): "TCF2", identity, profile, aircraft, preset, +0x52C, +0x530, +0x5C0, car, player cam, render
    // cam, R key down, 4 spare. Then profile, aircraft, preset, car, player cam, render cam (zeros if missing).
    static uint8_t prof[dump::kProfile], air[dump::kAircraft], pre[dump::kPresetSize];
    static uint8_t car[dump2::kCar], cam[dump2::kCamObj], rcam[dump2::kRender];
    memset(prof, 0, sizeof prof); memset(air, 0, sizeof air); memset(pre, 0, sizeof pre);
    memset(car, 0, sizeof car); memset(cam, 0, sizeof cam); memset(rcam, 0, sizeof rcam);
    uint32_t ch = 0, id = 0, flag = 0, bodyA = 0, bodyB = 0, typeEntry = 0, aircraft = 0, preset = 0;
    uint32_t carPtr = 0, camPtr = 0, rcamPtr = 0;
    SafeCopy(&ch, dump::kPlayer, 4);
    if (!ch) { Log("F8: no player"); return; }
    SafeCopy(&id, ch + dump::kIdentity, 4);
    SafeCopy(&flag, ch + dump::kBodyFlag, 4);
    SafeCopy(&bodyA, ch + dump::kBodyA, 4);
    SafeCopy(&bodyB, ch + dump::kBodyB, 4);
    const uint32_t body = (flag == 1 && bodyB) ? bodyB : bodyA;
    SafeCopy(prof, body, sizeof prof);
    SafeCopy(&typeEntry, body + 0xC, 4);
    SafeCopy(&aircraft, typeEntry + 8, 4);
    const bool gotAir = SafeCopy(air, aircraft, sizeof air);
    SafeCopy(&preset, dump::kPreset, 4);
    SafeCopy(pre, preset, sizeof pre);
    SafeCopy(&carPtr, typeEntry + 4, 4);
    if (!aircraft) SafeCopy(car, carPtr, sizeof car);
    SafeCopy(&camPtr, dump2::kPlayerCam, 4);
    SafeCopy(cam, camPtr, sizeof cam);
    SafeCopy(&rcamPtr, dump2::kRenderCam, 4);
    SafeCopy(rcam, rcamPtr, sizeof rcam);
    const uint32_t rDown = (GetAsyncKeyState('R') & 0x8000) ? 1u : 0u;

    char path[MAX_PATH];
    snprintf(path, sizeof path, "%s\\CharacterCams_dump_id%u_%d%s.bin", g_dir, id, n, rDown ? "_R" : "");
    FILE* f = fopen(path, "wb");
    if (!f) { Log("F8: can't write %s", path); return; }
    const uint32_t hdr[16] = {0x32464354u, id, body, aircraft, preset, bodyA, bodyB, flag,
                              aircraft ? 0u : carPtr, camPtr, rcamPtr, rDown, 0, 0, 0, 0};
    fwrite(hdr, sizeof hdr, 1, f);
    fwrite(prof, sizeof prof, 1, f);
    fwrite(air, sizeof air, 1, f);
    fwrite(pre, sizeof pre, 1, f);
    fwrite(car, sizeof car, 1, f);
    fwrite(cam, sizeof cam, 1, f);
    fwrite(rcam, sizeof rcam, 1, f);
    fclose(f);
    Log("F8: dump %d, identity %u, profile 0x%08X, %s 0x%08X, camera preset 0x%08X, R %s -> %s", n, id, body,
        aircraft ? "aircraft" : "car", aircraft ? aircraft : carPtr, preset, rDown ? "held" : "up", path);
    Log("F8: Bonecrusher own-body camera-ray hits ignored so far: %ld; Optimus handling applied %ld time(s)",
        g_rayIgnored, g_handlingApplied);
    (void)gotAir;
}

// ---------------------------------------------------------------- F9 physics trace (diagnostics)
// Samples the player's vehicle every ~10 ms for 4 s: the car block (profile+0xC -> +4, 0x7F0 bytes; its physics
// object is at +0x150 with the wheel count at +0x2F0 (u16) and wheel pointers at +0x2FC) followed by the live wheel
// records (0x100 each, allocated right after the car block, up to 8), plus the profile (0x80).
// File CharacterCams_trace_id<identity>_<n>.bin: header {"TCTR", identity, samples, car bytes, 0x80, car ptr,
// wheel count, 0}, then per sample {u32 ms, profile, car, 8 x 0x100 wheels (zeros past the count)}.
static void TraceNow(int n) {
    uint32_t ch = 0, id = 0, flag = 0, bodyA = 0, bodyB = 0, typeEntry = 0, carPtr = 0;
    SafeCopy(&ch, dump::kPlayer, 4);
    if (!ch) { Log("F9: no player"); return; }
    SafeCopy(&id, ch + dump::kIdentity, 4);
    SafeCopy(&flag, ch + dump::kBodyFlag, 4);
    SafeCopy(&bodyA, ch + dump::kBodyA, 4);
    SafeCopy(&bodyB, ch + dump::kBodyB, 4);
    const uint32_t body = (flag == 1 && bodyB) ? bodyB : bodyA;
    SafeCopy(&typeEntry, body + 0xC, 4);
    SafeCopy(&carPtr, typeEntry + 4, 4);
    if (!carPtr) { Log("F9: player has no car body (not in vehicle form?)"); return; }
    constexpr int kSamples = 400;
    constexpr size_t kWheels = 8, kWheel = 0x100;
    constexpr size_t kRec = 4 + dump::kProfile + dump2::kCar + kWheels * kWheel;
    uint16_t nw = 0;
    SafeCopy(&nw, carPtr + 0x2F0, 2);
    if (nw > kWheels) nw = kWheels;
    static uint8_t buf[kSamples * kRec];
    const DWORD t0 = GetTickCount();
    int got = 0;
    for (; got < kSamples; ++got) {
        uint8_t* r = buf + got * kRec;
        const uint32_t ms = GetTickCount() - t0;
        memcpy(r, &ms, 4);
        if (!SafeCopy(r + 4, body, dump::kProfile) || !SafeCopy(r + 4 + dump::kProfile, carPtr, dump2::kCar)) break;
        uint8_t* w = r + 4 + dump::kProfile + dump2::kCar;
        memset(w, 0, kWheels * kWheel);
        for (uint16_t i = 0; i < nw; ++i) {
            uint32_t wp = 0;
            if (SafeCopy(&wp, carPtr + 0x2FC + 4 * i, 4)) SafeCopy(w + i * kWheel, wp, kWheel);
        }
        Sleep(10);
    }
    char path[MAX_PATH];
    snprintf(path, sizeof path, "%s\\CharacterCams_trace_id%u_%d.bin", g_dir, id, n);
    FILE* f = fopen(path, "wb");
    if (!f) { Log("F9: can't write %s", path); return; }
    const uint32_t hdr[8] = {0x52544354u, id, static_cast<uint32_t>(got), static_cast<uint32_t>(dump2::kCar),
                             static_cast<uint32_t>(dump::kProfile), carPtr, nw, 0};
    fwrite(hdr, sizeof hdr, 1, f);
    fwrite(buf, kRec, got, f);
    fclose(f);
    Log("F9: trace %d, identity %u, car 0x%08X, %u wheels, %d samples over %lu ms -> %s", n, id, carPtr, nw, got,
        GetTickCount() - t0, path);
}

static DWORD WINAPI DumpThread(LPVOID) {
    int n = 0, nt = 0;
    bool was = false, wasT = false;
    for (;;) {
        const bool down = (GetAsyncKeyState(VK_F8) & 0x8000) != 0;
        if (down && !was) DumpNow(++n);
        was = down;
        const bool downT = (GetAsyncKeyState(VK_F9) & 0x8000) != 0;
        if (downT && !wasT) TraceNow(++nt);
        wasT = downT;
        Sleep(20);
    }
}

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(module);
        GetModuleFileNameA(module, g_dir, MAX_PATH);
        if (char* slash = strrchr(g_dir, '\\')) *slash = 0;
        char logPath[MAX_PATH];
        snprintf(logPath, sizeof logPath, "%s\\CharacterCams.log", g_dir);
        g_log = fopen(logPath, "w");
        Log("CharacterCams 0.8 loaded (TripleC + Bonecrusher; F8 = dump vehicle + camera data, hold R for the R view; F9 = 4 s physics trace)");
        HANDLE t = CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
        if (t) CloseHandle(t);
        HANDLE d = CreateThread(nullptr, 0, DumpThread, nullptr, 0, nullptr);
        if (d) CloseHandle(d);
    }
    return TRUE;
}
