// DamageProbe.asi - logs why characters do or don't take damage (Transformers: The Game PC 1.0.254.2).
// Read-only diagnostics: it changes nothing in the game, it only watches.
//
// Hooks (each checks the original bytes first and is skipped if they don't match):
//   0x507460  impact routine A (closest point on each body's shape)  -> logs every character body it considers
//   0x507750  impact routine B (distance to each body's centre)      -> same
//   0x506180  Energy::TakeHit(impact, scale)                         -> logs health before / after
// A background thread logs any change in a known character's health, damage multipliers or flags.
// F7 writes a MARK line, F6 pauses / resumes logging. Output: DamageProbe.log next to the exe.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <math.h>

static FILE* g_log = nullptr;
static CRITICAL_SECTION g_cs;
static volatile bool g_on = true;
static char g_dir[MAX_PATH];

static void Log(const char* fmt, ...) {
    if (!g_log) return;
    EnterCriticalSection(&g_cs);
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(g_log, "%02d:%02d:%02d.%03d ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list a; va_start(a, fmt); vfprintf(g_log, fmt, a); va_end(a);
    fputc('\n', g_log); fflush(g_log);
    LeaveCriticalSection(&g_cs);
}

static bool SafeRead(uintptr_t addr, void* out, size_t n) {
    __try { memcpy(out, (const void*)addr, n); return true; }
    __except (EXCEPTION_EXECUTE_HANDLER) { memset(out, 0, n); return false; }
}
template <typename T> static T R(uintptr_t a) { T v{}; SafeRead(a, &v, sizeof(T)); return v; }

// ---- game addresses
static const uintptr_t kPlayerPtr = 0x770614;
static const uintptr_t kPhysWorld = 0x724294;   // [[0x724294]+0xC] = world for the impact query
static const uintptr_t kQuery     = 0x620110;   // int __thiscall(world, float* pos, float r2, int max, void** out)
static const uintptr_t kGetPos    = 0x445460;   // const float* __thiscall(char)
static const uintptr_t kImpactA   = 0x507460;
static const uintptr_t kImpactB   = 0x507750;
static const uintptr_t kTakeHit   = 0x506180;
static const uint8_t kProA[] = {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF0, 0xB8, 0x84, 0x10, 0x00, 0x00};
static const uint8_t kProB[] = {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF0, 0xB8, 0x64, 0x10, 0x00, 0x00};
static const uint8_t kProT[] = {0x55, 0x8B, 0xEC, 0x83, 0xE4, 0xF0, 0x83, 0xEC, 0x14};
static const float kMult[16] = {0, .1f, .25f, .5f, .75f, 1, 1.25f, 1.5f, 1.75f, 2, 3, 4, 5, 10, 25, -1};

// ---- character info
static void CharName(uintptr_t ch, char* out, size_t n) {
    out[0] = 0;
    uintptr_t rec = R<uintptr_t>(ch + 0x518), s = rec ? R<uintptr_t>(rec) : 0;
    if (!s) { snprintf(out, n, "?"); return; }
    char tmp[48] = {0}; SafeRead(s, tmp, sizeof(tmp) - 1); tmp[sizeof(tmp) - 1] = 0;
    for (char* p = tmp; *p; ++p) if ((unsigned char)*p < 32 || (unsigned char)*p > 126) { *p = 0; break; }
    snprintf(out, n, "%s", tmp);
}
static bool IsChar(uintptr_t ch) {
    if (ch < 0x10000 || ch >= 0x80000000) return false;
    uintptr_t rec = R<uintptr_t>(ch + 0x518);
    if (!rec) return false;
    int n = R<int>(0x6FE0E8);                       // type-record pointer table 0x6FDE90, count at +0x258
    if (n <= 0 || n > 150) n = 150;
    for (int i = 0; i < n; ++i) if (R<uintptr_t>(0x6FDE90 + 4 * i) == rec) return true;
    return false;
}
// The damage object of a body model (robot model [ch+0x52C], transform model [ch+0x530]); same as 0x42ACF0.
static uintptr_t ModelPhys(uintptr_t model) {
    if (!model) return 0;
    uintptr_t m = R<uintptr_t>(model + 0xC);
    if (!m) return 0;
    uintptr_t v = R<uintptr_t>(m + 8);
    if (v) return v + 0x9C0;
    uintptr_t c = R<uintptr_t>(m + 4);
    return c ? c + 0x580 : 0;
}
static uintptr_t CharListHead() {
    uintptr_t g = R<uintptr_t>(0x6F997C);
    return g ? R<uintptr_t>(g + 0x54) : 0;
}
// Which character a damage object belongs to, and which of its objects it is.
static uintptr_t OwnerOf(uintptr_t phys, const char** which) {
    *which = "?";
    uintptr_t o = R<uintptr_t>(phys + 0x6C);
    int guard = 0;
    for (uintptr_t c = CharListHead(); c && guard < 256; c = R<uintptr_t>(c), ++guard) {
        if (!IsChar(c)) continue;
        if (phys == c + 0x930) { *which = "ROBOT-phys(+930)"; return c; }
        if (phys == ModelPhys(R<uintptr_t>(c + 0x52C))) { *which = "MODEL-phys(52C)"; return c; }
        if (phys == ModelPhys(R<uintptr_t>(c + 0x530))) { *which = "TRAN-phys(530)"; return c; }
        if (o == c) { *which = "other-phys(owner)"; return c; }
    }
    uintptr_t extra[2] = {R<uintptr_t>(0x770614), o};   // the player, and the object's own owner field
    for (uintptr_t c : extra) {
        if (!IsChar(c)) continue;
        if (phys == c + 0x930) { *which = "ROBOT-phys(+930)"; return c; }
        if (phys == ModelPhys(R<uintptr_t>(c + 0x52C))) { *which = "MODEL-phys(52C)"; return c; }
        if (phys == ModelPhys(R<uintptr_t>(c + 0x530))) { *which = "TRAN-phys(530)"; return c; }
        if (o == c) { *which = "other-phys(owner)"; return c; }
    }
    return 0;
}
static void CharPos(uintptr_t ch, float* p) {
    p[0] = p[1] = p[2] = 0;
    __try {
        typedef const float*(__thiscall * Fn)(uintptr_t);
        const float* v = ((Fn)kGetPos)(ch);
        if (v) { p[0] = v[0]; p[1] = v[1]; p[2] = v[2]; }
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
}
static void MultStr(uintptr_t slots, char* out, size_t n) {   // slots = physobj+0xA2 (6 bytes = 12 nibbles)
    uint8_t b[6]; SafeRead(slots, b, 6);
    int o = 0;
    for (int i = 0; i < 6 && o < (int)n - 16; ++i)
        o += snprintf(out + o, n - o, "%s%g/%g", i ? " " : "", kMult[b[i] & 0xF], kMult[b[i] >> 4]);
}

// ---- known characters (for the change log)
struct Known { uintptr_t ch; uint8_t raw[0x10]; float hp; uint32_t f628, f62c, cat, state; bool valid; };
static Known g_known[32];
static int g_knownN = 0;
static SRWLOCK g_kl = SRWLOCK_INIT;
static void Remember(uintptr_t ch) {
    if (!IsChar(ch)) return;
    AcquireSRWLockExclusive(&g_kl);
    bool have = false;
    for (int i = 0; i < g_knownN; ++i) if (g_known[i].ch == ch) { have = true; break; }
    if (!have && g_knownN < 32) { g_known[g_knownN] = {}; g_known[g_knownN++].ch = ch; }
    ReleaseSRWLockExclusive(&g_kl);
}

static void DescribeChar(uintptr_t ch, char* out, size_t n) {
    char nm[48]; CharName(ch, nm, sizeof(nm));
    uintptr_t pl = R<uintptr_t>(kPlayerPtr);
    uint32_t f628 = R<uint32_t>(ch + 0x628);
    snprintf(out, n, "%s%s id=%d %s ch=%08X", nm, ch == pl ? "(PLAYER)" : "", R<int>(ch + 0x5E4),
             (f628 >> 18) & 1 ? "VEHICLE" : "robot", (unsigned)ch);
}

// ---- impact analysis (runs on the game thread, before the game's own loop)
static void* g_bodies[0x400];
static void __cdecl AnalyzeImpact(uint8_t* imp, int variant) {
    if (!g_on) return;
    __try {
        float pos[4]; memcpy(pos, imp, 16);
        float rad = *(float*)(imp + 0x24);
        float r = rad > 15.f ? rad : 15.f;
        uintptr_t world = R<uintptr_t>(R<uintptr_t>(kPhysWorld) + 0xC);
        if (!world) return;
        typedef int(__thiscall * QFn)(uintptr_t, void*, float, int, void**);
        int n = ((QFn)kQuery)(world, imp, r * r, 0x400, g_bodies);
        uintptr_t off = *(uintptr_t*)(imp + 0x3C);
        float p2[4] = {pos[0], pos[1], pos[2], pos[3]};
        if (off) { p2[0] -= R<float>(off); p2[1] -= R<float>(off + 4); p2[2] -= R<float>(off + 8); }
        bool header = false;
        for (int i = 0; i < n && i < 0x400; ++i) {
            uintptr_t b = (uintptr_t)g_bodies[i];
            uintptr_t phys = R<uintptr_t>(b + 0x10);
            const char* which = "?";
            uintptr_t ch = phys ? OwnerOf(phys, &which) : 0;
            if (!ch) continue;
            Remember(ch);
            if (!header) {
                header = true;
                Log("IMPACT%c type=%d kind=%d pos=(%.2f %.2f %.2f) radius=%.2f mask4C=%08X mask50=%08X flags5C=%08X excl30=%08X excl34=%08X bodies=%d",
                    variant ? 'B' : 'A', *(int*)(imp + 0x44), *(int*)(imp + 0x48), pos[0], pos[1], pos[2], rad,
                    *(uint32_t*)(imp + 0x4C), *(uint32_t*)(imp + 0x50), *(uint32_t*)(imp + 0x5C),
                    *(uint32_t*)(imp + 0x30), *(uint32_t*)(imp + 0x34), n);
            }
            char who[128]; DescribeChar(ch, who, sizeof(who));
            uintptr_t body34 = R<uintptr_t>(b + 0x34), shape = R<uintptr_t>(b + 0xC);
            uintptr_t shapeVt = shape ? R<uintptr_t>(shape) : 0;
            float org[3] = {R<float>(b + 0x70), R<float>(b + 0x74), R<float>(b + 0x78)};
            float cp[3]; CharPos(ch, cp);
            uint8_t a9 = R<uint8_t>(phys + 0xA9), aa = R<uint8_t>(phys + 0xAA);
            float pr = R<float>(phys + 0x20), range = pr + rad;
            uint32_t cat = R<uint32_t>(phys + 0x44);
            float od = sqrtf((org[0] - pos[0]) * (org[0] - pos[0]) + (org[1] - pos[1]) * (org[1] - pos[1]) +
                             (org[2] - pos[2]) * (org[2] - pos[2]));
            float sd = -1;
            if (variant == 0 && shapeVt) {
                __declspec(align(16)) float in[16] = {p2[0], p2[1], p2[2], p2[3]};
                __declspec(align(16)) float out[16] = {0};
                typedef float(__thiscall * CFn)(uintptr_t, float*, float*, float);
                uintptr_t fn = R<uintptr_t>(shapeVt + 0x18);
                __try { ((CFn)fn)(shape, in, out, 3.4028235e38f); } __except (EXCEPTION_EXECUTE_HANDLER) { out[0] = NAN; }
                sd = sqrtf((out[0] - p2[0]) * (out[0] - p2[0]) + (out[1] - p2[1]) * (out[1] - p2[1]) +
                           (out[2] - p2[2]) * (out[2] - p2[2]));
            }
            const char* v = "PASSES -> TakeHit";
            uint32_t m4c = *(uint32_t*)(imp + 0x4C);
            if (!body34) v = "skip: no body";
            else if (aa & 0x80) v = "skip: flag AA bit7 (no hits)";
            else if (variant == 0 && (*(uint8_t*)(imp + 0x5C) & 1) && (a9 & 8)) v = "skip: flag A9 bit3";
            else if (variant == 0 && !(sd > 0.01f)) v = "skip: IMPACT INSIDE SHAPE (dist<=0.01)";
            else if (variant == 0 && !(sd < range)) v = "skip: too far from shape";
            else if (variant == 1 && !(od < range)) v = "skip: too far from centre";
            else if (b == *(uintptr_t*)(imp + 0x34)) v = "skip: excluded body (attacker)";
            else if (!(m4c & cat)) v = "skip: category not in impact mask";
            Log("   %s [%s phys=%08X] body=%08X shapeVt=%08X org=(%.2f %.2f %.2f) charPos=(%.2f %.2f %.2f) shapeDist=%.3f centreDist=%.2f physR=%.2f range=%.2f cat=%08X a9=%02X aa=%02X -> %s",
                who, which, (unsigned)phys, (unsigned)b, (unsigned)shapeVt, org[0], org[1], org[2], cp[0], cp[1], cp[2], sd, od, pr, range,
                cat, a9, aa, v);
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) { Log("AnalyzeImpact exception %08X", GetExceptionCode()); }
}

// ---- TakeHit wrapper
typedef void(__thiscall* TakeHitFn)(void*, void*, float);
static TakeHitFn g_origTakeHit = nullptr;
static void __fastcall HkTakeHit(void* phys, void*, void* imp, float scale) {
    uintptr_t p = (uintptr_t)phys;
    float before = R<float>(p + 0x24);
    g_origTakeHit(phys, imp, scale);
    if (!g_on) return;
    float after = R<float>(p + 0x24);
    const char* which = "";
    uintptr_t ch = OwnerOf(p, &which);
    char who[160] = "(not a character)";
    if (ch) { Remember(ch); char d[128]; DescribeChar(ch, d, sizeof(d)); snprintf(who, sizeof(who), "%s [%s]", d, which); }
    char m[160]; MultStr(p + 0xA2, m, sizeof(m));
    Log("TAKEHIT %s phys=%08X type=%d kind=%d scale=%.3f health %.1f -> %.1f  mult[%s] a8=%02X aa=%02X", who, (unsigned)p,
        R<int>((uintptr_t)imp + 0x44), R<int>((uintptr_t)imp + 0x48), scale, before, after, m,
        R<uint8_t>(p + 0xA8), R<uint8_t>(p + 0xAA));
}

// ---- hooks
static uintptr_t g_trA = 0, g_trB = 0;
__declspec(naked) static void HkImpactA() {
    __asm {
        pushad
        pushfd
        mov eax, [esp + 0x28]
        push 0
        push eax
        call AnalyzeImpact
        add esp, 8
        popfd
        popad
        jmp [g_trA]
    }
}
__declspec(naked) static void HkImpactB() {
    __asm {
        pushad
        pushfd
        mov eax, [esp + 0x28]
        push 1
        push eax
        call AnalyzeImpact
        add esp, 8
        popfd
        popad
        jmp [g_trB]
    }
}

// Copies the first `steal` bytes (plain instructions, no relative jumps) to a trampoline and jumps to `hook`.
static uintptr_t Hook(uintptr_t at, const uint8_t* expect, size_t n, size_t steal, void* hook, const char* name) {
    uint8_t cur[16]; SafeRead(at, cur, n);
    if (memcmp(cur, expect, n) != 0) { Log("hook %s at %08X SKIPPED: bytes don't match", name, (unsigned)at); return 0; }
    uint8_t* tr = (uint8_t*)VirtualAlloc(nullptr, 32, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!tr) return 0;
    memcpy(tr, (void*)at, steal);
    tr[steal] = 0xE9; *(int32_t*)(tr + steal + 1) = (int32_t)((at + steal) - ((uintptr_t)tr + steal + 5));
    DWORD old;
    VirtualProtect((void*)at, steal, PAGE_EXECUTE_READWRITE, &old);
    uint8_t* p = (uint8_t*)at;
    p[0] = 0xE9; *(int32_t*)(p + 1) = (int32_t)((uintptr_t)hook - (at + 5));
    for (size_t i = 5; i < steal; ++i) p[i] = 0x90;
    VirtualProtect((void*)at, steal, old, &old);
    FlushInstructionCache(GetCurrentProcess(), (void*)at, steal);
    Log("hook %s at %08X installed", name, (unsigned)at);
    return (uintptr_t)tr;
}

// ---- multiplier-setter trap: who writes 0 (no damage) into a damage object's slots
struct Setter { uintptr_t at; const char* name; int kind; size_t steal; uint8_t pro[8]; };  // kind 0 float, 1 bool(1=immune), 2 reset
static Setter kSetters[] = {
    {0x4FACB0, "slot0lo", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}}, {0x4FACD0, "slot0hi", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}},
    {0x4FACF0, "slot1lo", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}}, {0x4FAD20, "slot1hi", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}},
    {0x4FAD40, "slot2lo", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}}, {0x4FAD70, "slot2hi", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}},
    {0x4FAD90, "slot3lo", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}}, {0x4FADC0, "slot3hi", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}},
    {0x4FADE0, "slot4lo", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}}, {0x4FAE10, "slot4hi", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}},
    {0x4FAE30, "slot5lo", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}}, {0x4FAE60, "slot5hi", 0, 5, {0x8B, 0x44, 0x24, 0x04, 0x56}},
    {0x4FAE80, "GROUP_AE80", 1, 5, {0x80, 0x7C, 0x24, 0x04, 0x01}}, {0x4FAEF0, "GROUP_AEF0", 1, 5, {0x80, 0x7C, 0x24, 0x04, 0x01}},
    {0x4FAF60, "GROUP_AF60", 1, 5, {0x80, 0x7C, 0x24, 0x04, 0x01}}, {0x4FAFA0, "GROUP_AFA0", 1, 5, {0x80, 0x7C, 0x24, 0x04, 0x01}},
    {0x4FB010, "ALL_B010", 1, 5, {0x53, 0x8B, 0x5C, 0x24, 0x08}},
    {0x4F3DD0, "RESET_ALL_1.0", 2, 7, {0xB0, 0x55, 0x88, 0x01, 0x88, 0x41, 0x01}},
};
static const int kNumSetters = sizeof(kSetters) / sizeof(kSetters[0]);
static uintptr_t g_setTr[kNumSetters];
static volatile LONG g_setLines = 0;

// regs: [0]=eflags, [1]=edi [2]=esi [3]=ebp [4]=esp [5]=ebx [6]=edx [7]=ecx [8]=eax, [9]=return address, [10]=first arg
static void __cdecl OnSetter(int id, uint32_t* regs) {
    if (!g_on) return;
    __try {
        const Setter& s = kSetters[id];
        uintptr_t slots = regs[7], phys = slots - 0xA2, caller = regs[9];
        bool zero = false; char val[32];
        if (s.kind == 0) { float f = *(float*)&regs[10]; zero = (f == 0.0f); snprintf(val, sizeof(val), "%g", f); }
        else if (s.kind == 1) { int b = regs[10] & 0xFF; zero = (b == 1); snprintf(val, sizeof(val), b == 1 ? "IMMUNE" : "normal"); }
        else snprintf(val, sizeof(val), "-");
        const char* which = "?";
        uintptr_t ch = OwnerOf(phys, &which);
        uintptr_t rawOwner = R<uintptr_t>(phys + 0x6C);
        if (!ch && IsChar(rawOwner)) { ch = rawOwner; which = "owner field"; }
        if (!ch && IsChar(phys - 0x930)) { ch = phys - 0x930; which = "ROBOT-phys(+930) by offset"; }
        if (!zero && s.kind != 2 && !ch) return;        // only non-character noise is skipped
        if (InterlockedIncrement(&g_setLines) > 4000) return;
        char who[160] = "(not a character)";
        if (ch) { char d[128]; DescribeChar(ch, d, sizeof(d)); snprintf(who, sizeof(who), "%s [%s]", d, which); }
        char m[160]; MultStr(slots, m, sizeof(m));
        Log("SETTER %s(%s) caller=%08X phys=%08X %s  slots before: [%s]", s.name, val, (unsigned)caller, (unsigned)phys, who, m);
    } __except (EXCEPTION_EXECUTE_HANDLER) {}
}
#define SETTER_STUB(N)                                                                     \
    __declspec(naked) static void SetStub##N() {                                          \
        __asm pushad __asm pushfd __asm push esp __asm push N __asm call OnSetter          \
        __asm add esp, 8 __asm popfd __asm popad __asm jmp dword ptr [g_setTr + N * 4]     \
    }
SETTER_STUB(0) SETTER_STUB(1) SETTER_STUB(2) SETTER_STUB(3) SETTER_STUB(4) SETTER_STUB(5)
SETTER_STUB(6) SETTER_STUB(7) SETTER_STUB(8) SETTER_STUB(9) SETTER_STUB(10) SETTER_STUB(11)
SETTER_STUB(12) SETTER_STUB(13) SETTER_STUB(14) SETTER_STUB(15) SETTER_STUB(16) SETTER_STUB(17)
static void (*const kSetStubs[])() = {SetStub0, SetStub1, SetStub2, SetStub3, SetStub4, SetStub5,
                                      SetStub6, SetStub7, SetStub8, SetStub9, SetStub10, SetStub11,
                                      SetStub12, SetStub13, SetStub14, SetStub15, SetStub16, SetStub17};

// ---- character damage chain: Char::TakeDamage 0x464E90 -> 0x464960 -> health floor 0x43AF00
static float Health(uintptr_t ch) { return R<float>(ch + 0x954); }
static void CharVals(uintptr_t ch, char* out, size_t n) {
    snprintf(out, n, "robotHealth=%.1f hitTimer498=%g floor4A0=%g last490=%g max49C=%g 5CC=%d",
             Health(ch), R<float>(ch + 0x498), R<float>(ch + 0x4A0), R<float>(ch + 0x490), R<float>(ch + 0x49C),
             R<int>(ch + 0x5CC));
}
typedef void(__thiscall* TakeDmgFn)(void*, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);
static TakeDmgFn g_origTakeDmg = nullptr;
static void __fastcall HkTakeDamage(void* self, void*, uint32_t a1, uint32_t a2, uint32_t a3, uint32_t a4,
                                    uint32_t a5, uint32_t a6, uint32_t a7) {
    uintptr_t ch = (uintptr_t)self;
    char b[200] = "", a[200] = "";
    bool c = g_on && IsChar(ch);
    uint32_t m = a1 & 0x7FFFFFFF; float dmg = *(float*)&m;
    if (c) CharVals(ch, b, sizeof(b));
    g_origTakeDmg(self, a1, a2, a3, a4, a5, a6, a7);
    if (!c) return;
    CharVals(ch, a, sizeof(a));
    char who[128]; DescribeChar(ch, who, sizeof(who));
    Log("TAKEDAMAGE %s dmg=%.2f args=%08X %08X %08X %08X %08X %08X\n      before: %s\n      after:  %s", who, dmg,
        a2, a3, a4, a5, a6, a7, b, a);
}
typedef void(__thiscall* FloorFn)(void*, float*);
static FloorFn g_origFloor = nullptr;
static void __fastcall HkFloor(void* self, void*, float* dmg) {
    float before = dmg ? *dmg : -1;
    g_origFloor(self, dmg);
    uintptr_t ch = (uintptr_t)self;
    if (!g_on || !IsChar(ch)) return;
    char who[128]; DescribeChar(ch, who, sizeof(who));
    Log("FLOOR %s damage %.2f -> %.2f (floor4A0=%g robotHealth=%.1f)", who, before, dmg ? *dmg : -1,
        R<float>(ch + 0x4A0), Health(ch));
}
static uintptr_t g_trApply = 0;
static void __cdecl OnApply(uint32_t* regs) {   // 0x464960 entry: ecx = char, [esp+4] = damage
    uintptr_t ch = regs[7];
    if (!g_on || !IsChar(ch)) return;
    char who[128]; DescribeChar(ch, who, sizeof(who));
    float t = R<float>(ch + 0x498);
    Log("APPLY %s dmg=%.2f kind=%d hitTimer498=%g -> %s", who, *(float*)&regs[10], (int)regs[11], t,
        t > 0 ? "BLOCKED by hit timer (>0)" : "goes on");
}
__declspec(naked) static void HkApply() {
    __asm pushad __asm pushfd __asm push esp __asm call OnApply __asm add esp, 4 __asm popfd __asm popad
    __asm jmp dword ptr [g_trApply]
}

// ---- change logger
static DWORD WINAPI Watch(LPVOID) {
    bool f6 = false, f7 = false;
    for (;;) {
        Sleep(100);
        bool k6 = (GetAsyncKeyState(VK_F6) & 0x8000) != 0, k7 = (GetAsyncKeyState(VK_F7) & 0x8000) != 0;
        if (k6 && !f6) { g_on = !g_on; Log("==== logging %s (F6) ====", g_on ? "ON" : "PAUSED"); }
        if (k7 && !f7) Log("==================== MARK (F7) ====================");
        f6 = k6; f7 = k7;
        uintptr_t pl = R<uintptr_t>(kPlayerPtr);
        if (pl) Remember(pl);
        { int guard = 0; for (uintptr_t c = CharListHead(); c && guard < 256; c = R<uintptr_t>(c), ++guard) Remember(c); }
        if (!g_on) continue;
        AcquireSRWLockExclusive(&g_kl);
        for (int i = 0; i < g_knownN; ++i) {
            Known& k = g_known[i];
            if (!IsChar(k.ch)) { k.valid = false; continue; }
            uint8_t raw[0x10]; SafeRead(k.ch + 0x9D2, raw, 10);
            uintptr_t mp = ModelPhys(R<uintptr_t>(k.ch + 0x52C));
            if (mp) SafeRead(mp + 0xA2, raw + 10, 6); else memset(raw + 10, 0, 6);
            float hp = R<float>(k.ch + 0x954);
            uint32_t f628 = R<uint32_t>(k.ch + 0x628), f62c = R<uint32_t>(k.ch + 0x62C), cat = R<uint32_t>(k.ch + 0x974);
            uintptr_t st = R<uintptr_t>(k.ch + 0x53C); uint32_t state = st ? R<uint32_t>(st) : 0;
            bool changed = !k.valid || memcmp(raw, k.raw, 16) || hp != k.hp || f628 != k.f628 || f62c != k.f62c ||
                           cat != k.cat || state != k.state;
            if (changed) {
                char who[128]; DescribeChar(k.ch, who, sizeof(who));
                char m[160]; MultStr(k.ch + 0x9D2, m, sizeof(m));
                char mm[160] = "-"; if (mp) MultStr(mp + 0xA2, mm, sizeof(mm));
                Log("STATE %s hp49C=%.1f | ROBOT-phys %08X health=%.1f mult[%s] a8..ab=%02X %02X %02X %02X cat=%08X | MODEL-phys %08X health=%.1f mult[%s] a8=%02X aa=%02X | f628=%08X f62C=%08X stateVt=%08X",
                    who, R<float>(k.ch + 0x49C), (unsigned)(k.ch + 0x930), hp, m, raw[6], raw[7], raw[8], raw[9], cat,
                    (unsigned)mp, mp ? R<float>(mp + 0x24) : 0.f, mm, mp ? R<uint8_t>(mp + 0xA8) : 0, mp ? R<uint8_t>(mp + 0xAA) : 0,
                    f628, f62c, state);
                memcpy(k.raw, raw, sizeof(raw)); k.hp = hp; k.f628 = f628; k.f62c = f62c; k.cat = cat; k.state = state;
                k.valid = true;
            }
        }
        ReleaseSRWLockExclusive(&g_kl);
    }
}

BOOL WINAPI DllMain(HINSTANCE h, DWORD why, LPVOID) {
    if (why != DLL_PROCESS_ATTACH) return TRUE;
    DisableThreadLibraryCalls(h);
    InitializeCriticalSection(&g_cs);
    GetModuleFileNameA(nullptr, g_dir, MAX_PATH);
    char* s = strrchr(g_dir, '\\'); if (s) s[1] = 0;
    char path[MAX_PATH]; snprintf(path, MAX_PATH, "%sDamageProbe.log", g_dir);
    g_log = fopen(path, "w");
    Log("DamageProbe 0.4 started. F7 = mark, F6 = pause/resume.");
    g_trA = Hook(kImpactA, kProA, sizeof(kProA), 6, (void*)HkImpactA, "ImpactA");
    g_trB = Hook(kImpactB, kProB, sizeof(kProB), 6, (void*)HkImpactB, "ImpactB");
    uintptr_t t = Hook(kTakeHit, kProT, sizeof(kProT), 6, (void*)HkTakeHit, "TakeHit");
    g_origTakeHit = (TakeHitFn)t;
    if (!t) Log("TakeHit hook missing: health-before/after lines won't appear");
    static const uint8_t kProTD[] = {0x51, 0x8B, 0x44, 0x24, 0x08};
    static const uint8_t kProAp[] = {0x8B, 0x44, 0x24, 0x04, 0x56};
    static const uint8_t kProFl[] = {0xD9, 0x05, 0x28, 0xC2, 0x6A, 0x00};
    g_origTakeDmg = (TakeDmgFn)Hook(0x464E90, kProTD, 5, 5, (void*)HkTakeDamage, "Char::TakeDamage");
    g_trApply = Hook(0x464960, kProAp, 5, 5, (void*)HkApply, "DamageApply");
    g_origFloor = (FloorFn)Hook(0x43AF00, kProFl, 6, 6, (void*)HkFloor, "HealthFloor");
    static_assert(sizeof(kSetStubs) / sizeof(kSetStubs[0]) == sizeof(kSetters) / sizeof(kSetters[0]), "stub count");
    for (int i = 0; i < kNumSetters; ++i)
        g_setTr[i] = Hook(kSetters[i].at, kSetters[i].pro, kSetters[i].steal, kSetters[i].steal, (void*)kSetStubs[i], kSetters[i].name);
    CreateThread(nullptr, 0, Watch, nullptr, 0, nullptr);
    return TRUE;
}
