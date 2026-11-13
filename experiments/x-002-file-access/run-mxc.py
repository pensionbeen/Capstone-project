"""Compare MXC path denial and a Windows file label on fresh local fixtures.

Run from a non-elevated interactive account after building ORBIT's Electron code.
Only Windows certutil and cmd execute as test payloads. No model request is made.
"""

import ctypes as ct
from ctypes import wintypes as wt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile


def api(dll, name, args, result):
    func = getattr(dll, name)
    func.argtypes = args
    func.restype = result
    return func


LABEL = 0x10  # LABEL_SECURITY_INFORMATION, only the mandatory integrity label
advapi = ct.WinDLL("advapi32", use_last_error=True)
kernel = ct.WinDLL("kernel32", use_last_error=True)
ptr = ct.c_void_p
get_sd = api(advapi, "GetFileSecurityW", [wt.LPCWSTR, wt.DWORD, ptr, wt.DWORD, ct.POINTER(wt.DWORD)], wt.BOOL)
set_sd = api(advapi, "SetFileSecurityW", [wt.LPCWSTR, wt.DWORD, ptr], wt.BOOL)
from_string = api(advapi, "ConvertStringSecurityDescriptorToSecurityDescriptorW", [wt.LPCWSTR, wt.DWORD, ct.POINTER(ptr), ct.POINTER(wt.DWORD)], wt.BOOL)
to_string = api(advapi, "ConvertSecurityDescriptorToStringSecurityDescriptorW", [ptr, wt.DWORD, wt.DWORD, ct.POINTER(ptr), ct.POINTER(wt.DWORD)], wt.BOOL)
free_local = api(kernel, "LocalFree", [ptr], ptr)


def checked(ok):
    if not ok:
        raise ct.WinError(ct.get_last_error())


def snapshot(path, fields=LABEL):
    size = wt.DWORD()
    if get_sd(str(path), fields, None, 0, ct.byref(size)) or ct.get_last_error() != 122:
        raise RuntimeError("Cannot size the file security descriptor")
    buffer = ct.create_string_buffer(size.value)
    checked(get_sd(str(path), fields, buffer, size, ct.byref(size)))
    return buffer


def sddl(descriptor, fields=LABEL):
    string = ptr()
    checked(to_string(descriptor, 1, fields, ct.byref(string), None))
    try:
        return ct.wstring_at(string)
    finally:
        free_local(string)


def apply_medium_label(path):
    sd = ptr()
    checked(from_string("S:(ML;;NWNR;;;ME)", 1, ct.byref(sd), None))
    try:
        checked(set_sd(str(path), LABEL, sd))
        return sddl(sd)
    finally:
        free_local(sd)


def run(args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True, timeout=25, creationflags=subprocess.CREATE_NO_WINDOW)


def probe(cli, directory, actor, name, expected, mode):
    system = Path(os.environ["SystemRoot"], "System32")
    command = [str(system / "certutil.exe"), "-hashfile", name, "SHA256"]
    if actor == "child":
        command = [str(system / "cmd.exe"), "/d", "/c", *command]
    if actor in ("direct", "child"):
        config = ["-c", "windows.sandbox=mxc"]
        profile = ":workspace"
        if mode == "deny":
            profile = "orbit_x002"
            config += ["-c", 'permissions.orbit_x002.filesystem={":root"="read",":workspace_roots"={"."="write","protected.txt"="deny"}}']
        command = [cli, *config, "sandbox", "--include-managed-config",
                   "--permission-profile", profile, "--", *command]
    proc = run(command, directory)
    output = proc.stdout.replace(b"\x00", b"")
    digest = re.search(rb"^([0-9a-f]{64})\s*$", output, re.I | re.M)
    error = re.search(rb"^CertUtil[^\r\n]*-hashfile[^\r\n]*?0x(8007[0-9a-f]{4})\b", output, re.I | re.M)
    code = int(error[1], 16) if error else None
    return {"exit": proc.returncode, "digestReturned": bool(digest),
            "matches": bool(digest and digest[1].lower() == expected),
            "win32": (code & 0xffff) if code is not None and code == proc.returncode else None}


def installed_cli_for_user():
    checkout = Path(__file__).resolve().parents[2]
    resolve = run(["node", "--input-type=module", "-e",
                   "import {installedCodex} from './dist/desktop/electron/ai/codex.js'; console.log(await installedCodex());"], checkout)
    resolve.check_returncode()
    cli = resolve.stdout.decode("utf-8").strip()
    ps = Path(os.environ["SystemRoot"], "System32/WindowsPowerShell/v1.0/powershell.exe")
    check = run([str(ps), "-NoProfile", "-NonInteractive", "-Command",
                 "$i=[Security.Principal.WindowsIdentity]::GetCurrent(); $p=[Security.Principal.WindowsPrincipal]$i; "
                 "if ($i.Name -eq (Get-CimInstance Win32_ComputerSystem).UserName -and "
                 "-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'USER_OK' }"], checkout)
    if check.returncode or check.stdout.strip() != b"USER_OK":
        raise RuntimeError("Use the interactive, non-elevated Windows account")
    return cli


def passes(actor, row):
    restricted = actor in ("direct", "child")
    target = row["protected"]
    return (row["allowed"]["exit"] == 0 and row["allowed"]["matches"]
            and row["missing"]["win32"] == 2 and not row["missing"]["digestReturned"]
            and ((target["win32"] == 5 and not target["digestReturned"]) if restricted
                 else (target["exit"] == 0 and target["matches"])))


def experiment(cli, mode):
    results = {"mode": mode, "readPassed": False, "cleanup": False, "operations": {}}
    directory = Path(tempfile.mkdtemp(prefix="orbit-x002-mxc-"))
    files = []
    protected = directory / "protected.txt"
    original_label = None
    discretionary = 1 | 2 | 4  # owner, group, DACL
    try:
        hashes = {}
        for name in ("allowed", "protected"):
            path = directory / (name + ".txt")
            marker = secrets.token_hex(32).encode("ascii")
            with path.open("xb") as f:
                files.append(path)
                f.write(marker)
            hashes[name] = hashlib.sha256(marker).hexdigest().encode("ascii")
        if hashes["allowed"] == hashes["protected"]:
            raise RuntimeError("Identical markers")
        if mode == "label":
            original = sddl(snapshot(protected, discretionary), discretionary)
            original_label = snapshot(protected)
            intended = apply_medium_label(protected)
            results["labelApplied"] = sddl(snapshot(protected)) == intended
            if not results["labelApplied"]:
                raise RuntimeError("File label did not match after application")
        for actor in ("userBefore", "direct", "child", "userAfter"):
            rows = {}
            results["operations"][actor] = rows
            for name in ("allowed", "protected", "missing"):
                rows[name] = probe(cli, directory, actor, name + ".txt", hashes.get(name), mode)
            if actor.startswith("user") and not all(rows[n]["exit"] == 0 and rows[n]["matches"] for n in hashes):
                raise RuntimeError("User marker comparison failed")
        results["readPassed"] = all(passes(actor, row) for actor, row in results["operations"].items())
    except Exception as exc:
        results["error"] = str(exc)
    finally:
        try:
            if original_label is not None:
                checked(set_sd(str(protected), LABEL, original_label))
                before = sddl(original_label)
                after = sddl(snapshot(protected))
                rights_match = sddl(snapshot(protected, discretionary), discretionary) == original
                results["ownerGroupDaclRestored"] = rights_match
                results["labelDescriptorRestored"] = after == before
                results["labelRulesRestored"] = after == before or {before, after} <= {"", "S:", "S:NO_ACCESS_CONTROL"}
                if not rights_match or not results["labelRulesRestored"]:
                    raise RuntimeError("Cleanup retained the fixture because its access rules differ")
            for path in files:
                path.unlink()
            directory.rmdir()
            results["cleanup"] = not directory.exists()
        except Exception as exc:
            results["cleanupError"] = str(exc)
            results["retainedFixture"] = str(directory)
    return results


if __name__ == "__main__":
    codex = installed_cli_for_user()
    reports = [experiment(codex, mode) for mode in ("deny", "label")]
    print(json.dumps({"backend": "mxc", "runs": reports}, indent=2))
    raise SystemExit(0 if all(r["readPassed"] and r["cleanup"] and r.get("labelDescriptorRestored", True)
                              for r in reports) else 1)
