// TripleCFlightCam.asi: gives TripleC's helicopter form Blackout's flight camera and handling (Transformers: The Game v1.0.254.2).
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

// Reads TripleCFlightCam.ini: RobotCamera=Blackout (default, Blackout's on-foot preset) or Default (the game's own).
static uint32_t FootPreset() {
    char ini[MAX_PATH], v[32];
    snprintf(ini, sizeof ini, "%s\\TripleCFlightCam.ini", g_dir);
    GetPrivateProfileStringA("TripleCFlightCam", "RobotCamera", "Blackout", v, sizeof v, ini);
    return _stricmp(v, "Blackout") == 0 ? game::kBlackoutFoot : game::kDefaultFoot;
}

// FlightModel=Blackout (default) or Default (the game's own TripleC handling).
static bool UseBlackoutFlight() {
    char ini[MAX_PATH], v[32];
    snprintf(ini, sizeof ini, "%s\\TripleCFlightCam.ini", g_dir);
    GetPrivateProfileStringA("TripleCFlightCam", "FlightModel", "Blackout", v, sizeof v, ini);
    return _stricmp(v, "Default") != 0;
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
    return 0;
}

// ---------------------------------------------------------------- F8 dump (diagnostics)
// Writes the player's active vehicle profile (Char+0x52C/+0x530), its aircraft (profile+0xC -> +8, 0xA90 bytes)
// and the active camera preset ([0x71848C], 0x160 bytes) to TripleCFlightCam_dump_id<identity>_<n>.bin, so a
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
    snprintf(path, sizeof path, "%s\\TripleCFlightCam_dump_id%u_%d%s.bin", g_dir, id, n, rDown ? "_R" : "");
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
    (void)gotAir;
}

static DWORD WINAPI DumpThread(LPVOID) {
    int n = 0;
    bool was = false;
    for (;;) {
        const bool down = (GetAsyncKeyState(VK_F8) & 0x8000) != 0;
        if (down && !was) DumpNow(++n);
        was = down;
        Sleep(20);
    }
}

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(module);
        GetModuleFileNameA(module, g_dir, MAX_PATH);
        if (char* slash = strrchr(g_dir, '\\')) *slash = 0;
        char logPath[MAX_PATH];
        snprintf(logPath, sizeof logPath, "%s\\TripleCFlightCam.log", g_dir);
        g_log = fopen(logPath, "w");
        Log("TripleCFlightCam 0.6 loaded (F8 = dump vehicle + camera data; hold R too for the R view)");
        HANDLE t = CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
        if (t) CloseHandle(t);
        HANDLE d = CreateThread(nullptr, 0, DumpThread, nullptr, 0, nullptr);
        if (d) CloseHandle(d);
    }
    return TRUE;
}
