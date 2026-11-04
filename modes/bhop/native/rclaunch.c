/*
 * rclaunch: runs Deadlock's resource compiler (resourcecompiler.dll) from the command line.
 *
 * Deadlock ships the compiler as a DLL but no executable to start it. Valve's tool launchers
 * load the DLL, ask it for its "launchable_dll_1" interface and call that interface's first
 * method with the process arguments. This program does the same.
 *
 * Put it in a bin/win64 directory that holds the engine's DLLs; it loads them from beside
 * itself, never from the current directory. Arguments are passed through unchanged, e.g.
 *   rclaunch.exe -game C:\sdk\game\citadel -i C:\sdk\content\citadel_addons\x\maps\m.vmap -nop4
 *
 * Set RCLAUNCH_TRACE=1 to print every DLL the compiler asks Windows to load, and whether it
 * loaded. The compiler reports a missing module only as "a game file appears to be missing
 * or corrupted", so this is how to find which one.
 *
 * The compiler opens a window (it needs a graphics device) and reports fatal errors in modal
 * dialogs. So that neither lands on the user's screen, rclaunch starts itself again on a
 * private desktop that is never shown, forwards its output, and kills it after
 * RCLAUNCH_TIMEOUT seconds (default 1800), which also ends a run stuck behind a dialog.
 * Set RCLAUNCH_VISIBLE=1 to run on the normal desktop instead.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void *(*CreateInterfaceFn)(const char *name, int *returnCode);
typedef int (*LaunchFn)(void *self, int argc, char **argv, int waitForKey);

static void PatchImports(HMODULE module);

static HMODULE WINAPI TraceLoadLibraryExW(LPCWSTR name, HANDLE file, DWORD flags)
{
    HMODULE result = LoadLibraryExW(name, file, flags);
    fprintf(stderr, "rclaunch: LoadLibraryExW %ls -> %s (%lu)\n", name, result ? "ok" : "FAILED",
            result ? 0 : GetLastError());
    if (result) PatchImports(result);
    return result;
}

static HMODULE WINAPI TraceLoadLibraryExA(LPCSTR name, HANDLE file, DWORD flags)
{
    HMODULE result = LoadLibraryExA(name, file, flags);
    fprintf(stderr, "rclaunch: LoadLibraryExA %s -> %s (%lu)\n", name, result ? "ok" : "FAILED",
            result ? 0 : GetLastError());
    if (result) PatchImports(result);
    return result;
}

static HMODULE WINAPI TraceLoadLibraryW(LPCWSTR name)
{
    return TraceLoadLibraryExW(name, NULL, 0);
}

static HMODULE WINAPI TraceLoadLibraryA(LPCSTR name)
{
    return TraceLoadLibraryExA(name, NULL, 0);
}

/* Points a module's imports of the LoadLibrary family at the tracing versions above. */
static void PatchImports(HMODULE module)
{
    BYTE *base = (BYTE *)module;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    IMAGE_DATA_DIRECTORY dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (dir.VirtualAddress == 0) return;
    for (IMAGE_IMPORT_DESCRIPTOR *imp = (IMAGE_IMPORT_DESCRIPTOR *)(base + dir.VirtualAddress); imp->Name; imp++) {
        if (_stricmp((char *)(base + imp->Name), "kernel32.dll") != 0) continue;
        if (imp->OriginalFirstThunk == 0) continue;
        IMAGE_THUNK_DATA *names = (IMAGE_THUNK_DATA *)(base + imp->OriginalFirstThunk);
        IMAGE_THUNK_DATA *slots = (IMAGE_THUNK_DATA *)(base + imp->FirstThunk);
        for (; names->u1.AddressOfData; names++, slots++) {
            if (IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal)) continue;
            const char *fn = ((IMAGE_IMPORT_BY_NAME *)(base + names->u1.AddressOfData))->Name;
            ULONG_PTR target = 0;
            if (strcmp(fn, "LoadLibraryExW") == 0) target = (ULONG_PTR)TraceLoadLibraryExW;
            else if (strcmp(fn, "LoadLibraryExA") == 0) target = (ULONG_PTR)TraceLoadLibraryExA;
            else if (strcmp(fn, "LoadLibraryW") == 0) target = (ULONG_PTR)TraceLoadLibraryW;
            else if (strcmp(fn, "LoadLibraryA") == 0) target = (ULONG_PTR)TraceLoadLibraryA;
            if (target == 0 || slots->u1.Function == target) continue;
            DWORD old;
            if (VirtualProtect(&slots->u1.Function, sizeof(ULONG_PTR), PAGE_READWRITE, &old)) {
                slots->u1.Function = target;
                VirtualProtect(&slots->u1.Function, sizeof(ULONG_PTR), old, &old);
            }
        }
    }
}

static int EnvIs(const char *name, const char *value)
{
    char buffer[32];
    DWORD n = GetEnvironmentVariableA(name, buffer, sizeof(buffer));
    return n > 0 && n < sizeof(buffer) && strcmp(buffer, value) == 0;
}

typedef struct {
    int dialogs;
    /* A warning answered on an earlier scan that is still there: OK didn't close it. */
    HWND answered[8];
    int answeredCount;
    int stuck;
} DialogScan;

static HWND g_answered[8];
static int g_answeredCount;

/* Dialogs that only warn: rclaunch answers them with OK and the compile goes on. "Low Available
 * Memory" appears when the machine is busy (for example with the game running) and is harmless
 * for a map build; a real shortage still fails the compile on its own. */
static const char *const DismissableDialogs[] = { "Low Available Memory" };

static BOOL CALLBACK PrintChildText(HWND child, LPARAM unused)
{
    (void)unused;
    char text[2048];
    if (GetWindowTextA(child, text, sizeof(text)) > 0) fprintf(stderr, "rclaunch:   | %s\n", text);
    return TRUE;
}

/* Prints the text of every dialog box (window class #32770) on the hidden desktop. */
static BOOL CALLBACK ReportDialog(HWND window, LPARAM param)
{
    DialogScan *scan = (DialogScan *)param;
    char cls[64];
    if (GetClassNameA(window, cls, sizeof(cls)) == 0 || strcmp(cls, "#32770") != 0) return TRUE;
    char title[512];
    GetWindowTextA(window, title, sizeof(title));
    for (size_t i = 0; i < sizeof(DismissableDialogs) / sizeof(DismissableDialogs[0]); i++) {
        if (strcmp(title, DismissableDialogs[i]) == 0) {
            for (int k = 0; k < g_answeredCount; k++) {
                if (g_answered[k] == window) scan->stuck++;
            }
            if (scan->answeredCount < 8) scan->answered[scan->answeredCount++] = window;
            PostMessageA(window, WM_COMMAND, MAKEWPARAM(IDOK, BN_CLICKED), 0);
            return TRUE;
        }
    }
    fprintf(stderr, "rclaunch: the compiler is showing a dialog: \"%s\"\n", title);
    EnumChildWindows(window, PrintChildText, 0);
    scan->dialogs++;
    return TRUE;
}

/* Runs this executable again, with the same arguments, on a private hidden desktop. */
static int RunOnHiddenDesktop(void)
{
    HDESK desktop = CreateDesktopA("OpenCitadelCompile", NULL, NULL, 0, GENERIC_ALL, NULL);
    if (desktop == NULL) {
        fprintf(stderr, "rclaunch: cannot create a hidden desktop (%lu); set RCLAUNCH_VISIBLE=1\n", GetLastError());
        return 1;
    }
    char timeoutText[16];
    DWORD timeoutSeconds = 1800;
    if (GetEnvironmentVariableA("RCLAUNCH_TIMEOUT", timeoutText, sizeof(timeoutText)) > 0) {
        timeoutSeconds = (DWORD)strtoul(timeoutText, NULL, 10);
    }
    SetEnvironmentVariableA("RCLAUNCH_CHILD", "1");

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.lpDesktop = "OpenCitadelCompile";
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!CreateProcessA(NULL, GetCommandLineA(), NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        fprintf(stderr, "rclaunch: cannot start the compiler (%lu)\n", GetLastError());
        CloseDesktop(desktop);
        return 1;
    }
    /* Nobody can click a dialog on the hidden desktop, so poll for one: a dialog means the
     * compiler has stopped to report an error. Print what it says and end the run. Known
     * warnings are answered instead, unless they keep coming back. */
    DWORD exitCode = 1;
    DWORD waited = 0;
    int answered = 0;
    int stuckScans = 0;
    for (;;) {
        if (WaitForSingleObject(pi.hProcess, 2000) != WAIT_TIMEOUT) {
            GetExitCodeProcess(pi.hProcess, &exitCode);
            break;
        }
        waited += 2;
        DialogScan scan = {0};
        EnumDesktopWindows(desktop, ReportDialog, (LPARAM)&scan);
        /* The compiler may warn many times (once per texture); only a warning that stays open
         * after being answered for several scans means rclaunch can't get past it. */
        for (int k = 0; k < scan.answeredCount; k++) {
            int seen = 0;
            for (int j = 0; j < g_answeredCount; j++) seen |= g_answered[j] == scan.answered[k];
            if (!seen) answered++;
        }
        memcpy(g_answered, scan.answered, sizeof(g_answered));
        g_answeredCount = scan.answeredCount;
        stuckScans = scan.stuck > 0 ? stuckScans + 1 : 0;
        if (stuckScans >= 3) {
            fprintf(stderr, "rclaunch: a warning dialog doesn't close when answered.\n");
            scan.dialogs++;
        }
        if (scan.dialogs > 0) {
            fprintf(stderr, "rclaunch: stopping the compiler.\n");
            TerminateProcess(pi.hProcess, 125);
            WaitForSingleObject(pi.hProcess, 5000);
            exitCode = 125;
            break;
        }
        if (waited >= timeoutSeconds) {
            fprintf(stderr, "rclaunch: the compiler did not finish within %lu s; stopping it.\n", timeoutSeconds);
            TerminateProcess(pi.hProcess, 124);
            WaitForSingleObject(pi.hProcess, 5000);
            exitCode = 124;
            break;
        }
    }
    if (answered > 0) fprintf(stderr, "rclaunch: answered %d warning dialog(s) (low memory) with OK.\n", answered);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    CloseDesktop(desktop);
    return (int)exitCode;
}

int main(int argc, char **argv)
{
    if (!EnvIs("RCLAUNCH_CHILD", "1") && !EnvIs("RCLAUNCH_VISIBLE", "1")) {
        return RunOnHiddenDesktop();
    }

    char directory[MAX_PATH * 4];
    DWORD length = GetModuleFileNameA(NULL, directory, sizeof(directory));
    if (length == 0 || length >= sizeof(directory)) {
        fprintf(stderr, "rclaunch: cannot resolve executable directory\n");
        return 1;
    }
    char *separator = strrchr(directory, '\\');
    if (separator == NULL) {
        fprintf(stderr, "rclaunch: executable has no parent directory\n");
        return 1;
    }
    *separator = '\0';
    if (!SetDllDirectoryA(directory)) {
        fprintf(stderr, "rclaunch: SetDllDirectory failed (%lu)\n", GetLastError());
        return 1;
    }
    char trace[8];
    int tracing = GetEnvironmentVariableA("RCLAUNCH_TRACE", trace, sizeof(trace)) > 0 && trace[0] == '1';

    char dll[MAX_PATH * 4];
    snprintf(dll, sizeof(dll), "%s\\resourcecompiler.dll", directory);
    HMODULE module = LoadLibraryExA(dll, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (module == NULL) {
        fprintf(stderr, "rclaunch: cannot load %s (%lu)\n", dll, GetLastError());
        return 1;
    }
    if (tracing) {
        const char *already[] = {"resourcecompiler.dll", "tier0.dll", "engine2.dll", "filesystem_stdio.dll"};
        for (size_t i = 0; i < sizeof(already) / sizeof(already[0]); i++) {
            HMODULE loaded = GetModuleHandleA(already[i]);
            if (loaded) PatchImports(loaded);
        }
    }
    CreateInterfaceFn createInterface = (CreateInterfaceFn)GetProcAddress(module, "CreateInterface");
    if (createInterface == NULL) {
        fprintf(stderr, "rclaunch: resourcecompiler.dll has no CreateInterface export\n");
        return 1;
    }
    void *launchable = createInterface("launchable_dll_1", NULL);
    if (launchable == NULL) {
        fprintf(stderr, "rclaunch: resourcecompiler.dll does not provide launchable_dll_1\n");
        return 1;
    }
    LaunchFn launch = (*(LaunchFn **)launchable)[0];
    return launch(launchable, argc, argv, 0);
}
