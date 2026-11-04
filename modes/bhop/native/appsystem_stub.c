/*
 * appsystem_stub: a stand-in for a tools-only engine module that Deadlock does not ship.
 *
 * Deadlock's resource compiler starts a list of app systems, two of which come only with
 * Valve's Workshop Tools: modeldoc_utils (ModelDocUtils001) and exportsystem
 * (EXPORTSYSTEM_INTERFACE_VERSION_001). Without them it stops at startup with "a game file
 * appears to be missing or corrupted". Map builds made of world meshes and point entities
 * don't call either module, so a stub that implements only the generic IAppSystem lifecycle
 * (Connect, Init, ...) gets the compiler running.
 *
 * Build one DLL per module, naming the interface it provides:
 *   cl /LD /DSTUB_INTERFACE=\"ModelDocUtils001\" appsystem_stub.c /Fe:modeldoc_utils.dll
 *
 * Every slot past the lifecycle is a trap: if the compiler ever calls one, the stub prints the
 * interface and slot and exits, so a build that really needs the module fails loudly instead
 * of misbehaving. Install the real DLL from Valve's Workshop Tools for such builds.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

#ifndef STUB_INTERFACE
#error define STUB_INTERFACE as the interface name this stub provides
#endif

typedef void *(*CreateInterfaceFn)(const char *name, int *returnCode);

typedef struct { const char *module; const char *iface; } AppSystemInfo;
static const AppSystemInfo kNoDependencies[] = {{NULL, NULL}};

/* The IAppSystem lifecycle, in vtable order. Return values match Deadlock's own modules. */
static int __cdecl Connect(void *self, CreateInterfaceFn factory) { (void)self; (void)factory; return 1; }
static void __cdecl Disconnect(void *self) { (void)self; }
static void *__cdecl QueryInterface(void *self, const char *name) { (void)self; (void)name; return NULL; }
static int __cdecl Init(void *self) { (void)self; return 1; /* INIT_OK */ }
static void __cdecl Shutdown(void *self) { (void)self; }
static void __cdecl PreShutdown(void *self) { (void)self; }
static const AppSystemInfo *__cdecl GetDependencies(void *self) { (void)self; return kNoDependencies; }
static int __cdecl GetTier(void *self) { (void)self; return 3; }
static void __cdecl Reconnect(void *self, CreateInterfaceFn factory, const char *name) { (void)self; (void)factory; (void)name; }
static int __cdecl IsSingleton(void *self) { (void)self; return 1; }
static int __cdecl GetBuildType(void *self) { (void)self; return 2; /* release */ }

static void Trap(int slot)
{
    fprintf(stderr, "appsystem stub: the compiler called %s slot %d, which the stub does not implement. "
                    "Install the real module from Valve's Workshop Tools.\n", STUB_INTERFACE, slot);
    fflush(stderr);
    ExitProcess(3);
}

#define TRAP(n) static void __cdecl Trap##n(void) { Trap(n); }
TRAP(11) TRAP(12) TRAP(13) TRAP(14) TRAP(15) TRAP(16) TRAP(17) TRAP(18) TRAP(19) TRAP(20)
TRAP(21) TRAP(22) TRAP(23) TRAP(24) TRAP(25) TRAP(26) TRAP(27) TRAP(28) TRAP(29) TRAP(30)
TRAP(31) TRAP(32) TRAP(33) TRAP(34) TRAP(35) TRAP(36) TRAP(37) TRAP(38) TRAP(39) TRAP(40)
TRAP(41) TRAP(42) TRAP(43) TRAP(44) TRAP(45) TRAP(46) TRAP(47) TRAP(48) TRAP(49) TRAP(50)

static void *kVtable[] = {
    (void *)Connect, (void *)Disconnect, (void *)QueryInterface, (void *)Init, (void *)Shutdown,
    (void *)PreShutdown, (void *)GetDependencies, (void *)GetTier, (void *)Reconnect,
    (void *)IsSingleton, (void *)GetBuildType,
    (void *)Trap11, (void *)Trap12, (void *)Trap13, (void *)Trap14, (void *)Trap15, (void *)Trap16,
    (void *)Trap17, (void *)Trap18, (void *)Trap19, (void *)Trap20, (void *)Trap21, (void *)Trap22,
    (void *)Trap23, (void *)Trap24, (void *)Trap25, (void *)Trap26, (void *)Trap27, (void *)Trap28,
    (void *)Trap29, (void *)Trap30, (void *)Trap31, (void *)Trap32, (void *)Trap33, (void *)Trap34,
    (void *)Trap35, (void *)Trap36, (void *)Trap37, (void *)Trap38, (void *)Trap39, (void *)Trap40,
    (void *)Trap41, (void *)Trap42, (void *)Trap43, (void *)Trap44, (void *)Trap45, (void *)Trap46,
    (void *)Trap47, (void *)Trap48, (void *)Trap49, (void *)Trap50,
};

static struct { void **vtable; char padding[256]; } g_instance = {kVtable, {0}};

__declspec(dllexport) void *CreateInterface(const char *name, int *returnCode)
{
    if (name != NULL && strcmp(name, STUB_INTERFACE) == 0) {
        if (returnCode) *returnCode = 0; /* IFACE_OK */
        return &g_instance;
    }
    if (returnCode) *returnCode = 1; /* IFACE_FAILED */
    return NULL;
}
