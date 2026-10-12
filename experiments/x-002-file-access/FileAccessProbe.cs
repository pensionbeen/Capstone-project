// X-002: controlled Win32 file access observations. Not a general sandbox.
// Build with the installed .NET Framework compiler; no package restore needed.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

internal static class FileAccessProbe
{
    const uint GR = 0x80000000, GW = 0x40000000, DELETE = 0x10000;
    const uint WRITE_DAC = 0x40000, WRITE_OWNER = 0x80000;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    const uint CREATE_SUSPENDED = 4, CREATE_NO_WINDOW = 0x08000000;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint ERROR_ACCESS_DENIED = 5;
    static readonly IntPtr Invalid = new IntPtr(-1);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string[] RestrictSids = new[] { "S-1-1-0", "S-1-5-11", "S-1-5-32-545" }.Concat(ReadCurrentTokenSids(28)).ToArray();
    static string RunRoot, DataRoot;
    static string WorkerDesktop;
    static readonly List<object> Events = new List<object>();
    static readonly Dictionary<string, string> SavedAcl = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length < 2) throw new ArgumentException("Use run|run-keep|worker|child|held RUN_ROOT [handle].");
            RunRoot = ValidateRunRoot(args[1]);
            DataRoot = Path.Combine(RunRoot, "fixtures");
            if (args[0] == "recover") return Recover();
            if (args[0] == "worker" || args[0] == "child") return Worker(args[0]);
            if (args[0] == "held") return Held(new IntPtr(long.Parse(args[2])));
            if (args[0] != "run" && args[0] != "run-keep" && args[0] != "run-fail-policy") throw new ArgumentException("Unknown mode.");
            return Run(args[0] == "run-keep", args[0] == "run-fail-policy");
        }
        catch (Exception e) { Console.Error.WriteLine(e.GetType().Name + ": " + e.Message); return 2; }
    }

    static int Recover()
    {
        Guard(DataRoot);
        if (!File.Exists(Path.Combine(DataRoot, ".x002-owned")) || File.ReadAllText(Path.Combine(DataRoot, ".x002-owned")).Trim() != Path.GetFileName(RunRoot))
            throw new InvalidOperationException("Recovery marker mismatch.");
        var saved = Json.Deserialize<Dictionary<string, string>>(File.ReadAllText(Path.Combine(RunRoot, "acl-before.json"), Encoding.UTF8));
        foreach (var pair in saved) { Guard(pair.Key); SavedAcl.Add(pair.Key, pair.Value); }
        bool restored = RestoreAcls();
        if (restored) CleanFixtures();
        bool removed = !Directory.Exists(DataRoot);
        WriteJson(Path.Combine(RunRoot, "recovery.json"), new { utc = DateTime.UtcNow.ToString("o"), aclRestored = restored, fixtureRemoved = removed, events = Events });
        Console.WriteLine("Recovery: ACL restored=" + restored + "; fixture removed=" + removed);
        return restored && removed ? 0 : 2;
    }

    static int Run(bool keep, bool failPolicy)
    {
        var started = DateTime.UtcNow;
        var before = OtherProcesses();
        var report = new Dictionary<string, object>();
        bool completed = false, restored = false, cleaned = false;
        string error = null;
        IntPtr token = IntPtr.Zero, desktop = IntPtr.Zero;
        bool desktopClosed = true;
        try
        {
            var identity = TokenIdentity();
            report["controller"] = identity;
            if ((bool)identity["elevated"] || (bool)identity["restricted"])
                throw new InvalidOperationException("Run under the ordinary, unelevated user token. No privilege fallback is performed.");
            if (Directory.Exists(DataRoot)) throw new InvalidOperationException("Fixture directory already exists.");
            CreateFixtures();
            // Persist rollback data before the first ACL mutation.
            WriteJson(Path.Combine(RunRoot, "acl-before.json"), SavedAcl);
            report["beforePolicyHashes"] = ProtectedHashes();
            ApplyPolicies();
            if (failPolicy)
            {
                report["injectedPolicyFailure"] = "Set DACL on a missing dummy target, before token or process creation";
                SetDacl(Protected("missing-policy-target.txt"), "D:P(A;;FA;;;SY)");
                throw new InvalidOperationException("Missing-target DACL update unexpectedly succeeded.");
            }
            WriteJson(Path.Combine(RunRoot, "acl-applied.json"), SnapshotAcls());
            report["ordinaryUser"] = NormalUserChecks();
            report["protectedBeforeRestricted"] = ProtectedHashes();
            token = MakeRestrictedToken();
            desktop = NewPrivateDesktop();
            desktopClosed = false;
            report["requestedRestriction"] = new { flags = "DISABLE_MAX_PRIVILEGE (1)", restrictingSids = RestrictSids, disabledSids = new string[0], inheritHandles = false, desktop = WorkerDesktop, desktopIsolation = "One new non-visible desktop; existing desktop/window-station ACLs unchanged; hostile escape unverified" };
            var launched = Launch(token, "worker", IntPtr.Zero);
            report["restrictedLaunch"] = launched;
            if (!launched.Success) throw new InvalidOperationException("Restricted worker did not complete: " + launched.Error + "; exit=" + launched.ExitCode);
            report["restrictedDirect"] = ReadJson(Allowed("worker.json"));
            report["restrictedChild"] = ReadJson(Allowed("child.json"));
            report["protectedAfterRestricted"] = ProtectedHashes();
            report["hardenedFilesUnchanged"] = StableProtectedHashes(
                (Dictionary<string, string>)report["protectedBeforeRestricted"],
                (Dictionary<string, string>)report["protectedAfterRestricted"]);
            // Deliberately demonstrate why a broker must never pass a protected
            // handle. Only this dummy file handle is in the inheritance list.
            IntPtr held = Open(Protected("preopened.txt"), GR, false);
            if (held == Invalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "Open controlled preopened fixture");
            try
            {
                if (!SetHandleInformation(held, 1, 1)) throw Last("SetHandleInformation");
                var heldLaunch = Launch(token, "held", held);
                report["preopenedLaunch"] = heldLaunch;
                if (!heldLaunch.Success) throw new InvalidOperationException("Preopened-handle worker failed.");
                report["preopenedHandle"] = ReadJson(Allowed("held.json"));
            }
            finally { CloseHandle(held); }
            report["ordinaryUserAfter"] = NormalUserChecks();
            completed = true;
        }
        catch (Exception e) { error = e.GetType().Name + ": " + e.Message; }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            if (desktop != IntPtr.Zero)
            {
                desktopClosed = CloseDesktop(desktop);
                Events.Add(new { phase = "close-private-desktop", success = desktopClosed, error = desktopClosed ? 0 : Marshal.GetLastWin32Error() });
                // All helper jobs have been closed before reaching here.
                // A successful open means some reference is still alive.
                IntPtr remaining = OpenDesktop(WorkerDesktop, 0, false, 1);
                int reopenError = remaining == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
                bool absent = remaining == IntPtr.Zero && reopenError == 2;
                if (remaining != IntPtr.Zero) CloseDesktop(remaining);
                report["privateDesktopAbsentAfterClose"] = absent;
                report["privateDesktopReopenError"] = reopenError;
            }
            try { restored = RestoreAcls(); }
            catch (Exception e) { Events.Add(new { phase = "restore-error", error = e.Message }); }
            if (restored && !keep)
            {
                try { CleanFixtures(); cleaned = !Directory.Exists(DataRoot); }
                catch (Exception e) { Events.Add(new { phase = "cleanup-error", error = e.Message }); }
            }
            report["schemaVersion"] = 1;
            report["startedUtc"] = started.ToString("o");
            report["finishedUtc"] = DateTime.UtcNow.ToString("o");
            report["osVersionCompatibilityValue"] = Environment.OSVersion.VersionString;
            report["is64BitProcess"] = Environment.Is64BitProcess;
            report["helperSha256"] = Hash(Assembly.GetExecutingAssembly().Location);
            report["events"] = Events;
            report["observationsComplete"] = completed;
            report["error"] = error;
            report["aclRestored"] = restored;
            report["fixtureRemoved"] = cleaned;
            report["keptFixtures"] = keep;
            report["privateDesktopHandleClosed"] = desktopClosed;
            report["otherProcessesBefore"] = before;
            report["otherProcessesAfter"] = OtherProcesses();
            report["productProtectionApproved"] = false;
            report["unverified"] = new[] { "Actual Codex and PTY compatibility", "Privileged service/proxy bypass", "Hostile escape from separate desktop", "Race-free hostile replacement of paths", "Junction/symlink and short-name aliases", "OS audit event collection", "Existing application interaction and long-term stability", "Application restart and integration" };
            WriteJson(Path.Combine(RunRoot, "report.json"), report);
        }
        Console.WriteLine("Observations complete=" + completed + "; ACL restored=" + restored + "; fixture removed=" + cleaned + "; product protection approved=false");
        if (error != null) Console.Error.WriteLine(error);
        return completed && restored && (keep || cleaned) && desktopClosed ? 0 : 2;
    }

    static void CreateFixtures()
    {
        foreach (string dir in new[] { DataRoot, Protected(""), Allowed(""), Path.Combine(DataRoot, "tools"), Path.Combine(DataRoot, "empty-protected") })
        { Guard(dir); Directory.CreateDirectory(dir); }
        foreach (string actor in new[] { "worker", "child", "normal" })
            foreach (string operation in new[] { "read", "write", "delete" })
                foreach (string directory in new[] { Protected(""), Allowed("") })
                    File.WriteAllText(Path.Combine(directory, actor + "-" + operation + ".txt"), "X002 DUMMY ONLY " + actor + " " + operation + "\n", Encoding.UTF8);
        foreach (string name in new[] { "owner-unsafe.txt", "owner-hardened.txt", "preopened.txt", "alias.txt", "rename.txt" })
            File.WriteAllText(Protected(name), "X002 DUMMY ONLY " + name + "\n", Encoding.UTF8);
        File.Copy(Assembly.GetExecutingAssembly().Location, Path.Combine(DataRoot, "tools", "probe.exe"));
        // A hard link is another name for the SAME new fixture. It cannot point
        // outside this experiment and cleanup never follows reparse points.
        if (!CreateHardLink(Allowed("hardlink.txt"), Protected("alias.txt"), IntPtr.Zero)) throw Last("CreateHardLink fixture");
        File.WriteAllText(Path.Combine(DataRoot, ".x002-owned"), Path.GetFileName(RunRoot), Encoding.UTF8);
        foreach (string path in EnumeratePlain(DataRoot)) SavedAcl[path] = GetSddl(path);
        SavedAcl[DataRoot] = GetSddl(DataRoot);
    }

    static void ApplyPolicies()
    {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        foreach (string path in SavedAcl.Keys.OrderBy(p => p.Length))
        {
            string baseAcl = "D:P(A;;FA;;;" + sid + ")(A;;FA;;;SY)";
            bool isProtected = path.Equals(Protected(""), StringComparison.OrdinalIgnoreCase) || path.StartsWith(Protected("") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || path.EndsWith("empty-protected", StringComparison.OrdinalIgnoreCase);
            bool isAllowed = path.Equals(Allowed(""), StringComparison.OrdinalIgnoreCase) || path.StartsWith(Allowed("") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            // Hardlink shares its target ACL; process it only as the protected
            // file so an allow rule through the alias cannot weaken the target.
            if (path == Allowed("hardlink.txt")) continue;
            if (!path.EndsWith("owner-unsafe.txt", StringComparison.OrdinalIgnoreCase)) baseAcl += "(A;;RC;;;OW)";
            if (!isProtected) baseAcl += isAllowed ? "(A;OICI;0x1301bf;;;BU)" : "(A;;0x1200a9;;;BU)";
            SetDacl(path, baseAcl);
        }
    }

    static object NormalUserChecks()
    {
        var rows = new List<Row>();
        foreach (string kind in new[] { "protected", "allowed" })
        {
            string dir = kind == "protected" ? Protected("") : Allowed("");
            // Re-create the user's own delete fixture between the before/after checks.
            File.WriteAllText(Path.Combine(dir, "normal-delete.txt"), "DUMMY NORMAL DELETE\n");
            rows.Add(Read(kind + "/read", Path.Combine(dir, "normal-read.txt")));
            rows.Add(Write(kind + "/write", Path.Combine(dir, "normal-write.txt")));
            rows.Add(Delete(kind + "/delete", Path.Combine(dir, "normal-delete.txt")));
        }
        return rows;
    }

    static int Worker(string actor)
    {
        var rows = new List<Row>();
        var identity = TokenIdentity();
        if (!(bool)identity["restricted"]) throw new InvalidOperationException("Worker must have a restricting-SID token; no ordinary fallback.");
        foreach (string kind in new[] { "protected", "allowed" })
        {
            string dir = kind == "protected" ? Protected("") : Allowed("");
            rows.Add(Read(kind + "/read", Path.Combine(dir, actor + "-read.txt")));
            rows.Add(Write(kind + "/write", Path.Combine(dir, actor + "-write.txt")));
            rows.Add(Delete(kind + "/delete", Path.Combine(dir, actor + "-delete.txt")));
        }
        if (actor == "worker")
        {
            rows.Add(Access("owner-hardened/WRITE_DAC", Protected("owner-hardened.txt"), WRITE_DAC, false));
            rows.Add(ChangeDacl("owner-hardened/change-DACL", Protected("owner-hardened.txt")));
            rows.Add(Access("owner-hardened/WRITE_OWNER", Protected("owner-hardened.txt"), WRITE_OWNER, false));
            rows.Add(Access("owner-unsafe/WRITE_DAC", Protected("owner-unsafe.txt"), WRITE_DAC, false));
            rows.Add(ChangeDacl("owner-unsafe/change-DACL", Protected("owner-unsafe.txt")));
            rows.Add(Read("owner-unsafe/read-after-DACL", Protected("owner-unsafe.txt")));
            rows.Add(Access("protected-parent/DELETE_CHILD", Protected(""), 0x40, true));
            rows.Add(Access("fixture-parent/DELETE_CHILD", DataRoot, 0x40, true));
            bool removed = RemoveDirectory(Path.Combine(DataRoot, "empty-protected"));
            rows.Add(Result("empty-protected/remove-directory", removed, removed ? 0 : Marshal.GetLastWin32Error()));
            bool moved = MoveFile(Protected("rename.txt"), Allowed("renamed-protected.txt"));
            rows.Add(Result("protected/rename-to-allowed", moved, moved ? 0 : Marshal.GetLastWin32Error()));
            rows.Add(Read("alias/hardlink-read", Allowed("hardlink.txt")));
            rows.Add(Read("alias/extended-path-read", "\\\\?\\" + Protected("alias.txt")));
            rows.Add(Read("alias/dotdot-read", Allowed("..\\protected\\alias.txt")));
            // Child is created by the restricted worker itself. No token is
            // explicitly supplied, testing actual primary-token inheritance.
            var child = Launch(IntPtr.Zero, "child", IntPtr.Zero);
            WriteJson(Allowed("worker.json"), new { identity = identity, rows = rows, childLaunch = child });
            return child.Success ? 0 : 3;
        }
        WriteJson(Allowed("child.json"), new { identity = identity, rows = rows });
        return 0;
    }

    static int Held(IntPtr handle)
    {
        var identity = TokenIdentity();
        if (!(bool)identity["restricted"]) throw new InvalidOperationException("Held-handle worker must be restricted.");
        byte[] data = new byte[128]; uint count;
        bool success = ReadFile(handle, data, (uint)data.Length, out count, IntPtr.Zero);
        int code = success ? 0 : Marshal.GetLastWin32Error();
        WriteJson(Allowed("held.json"), new { identity = identity, inheritedRead = Result("preopened/read-inherited-handle", success, code, count), freshOpen = Read("preopened/fresh-open", Protected("preopened.txt")), note = "Only dummy byte count is recorded, not content." });
        CloseHandle(handle);
        return 0;
    }

    static IntPtr MakeRestrictedToken()
    {
        IntPtr current, result;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0001 | 0x0002 | 0x0008, out current)) throw Last("OpenProcessToken");
        var allocated = new List<IntPtr>();
        try
        {
            var sids = new SID_AND_ATTRIBUTES[RestrictSids.Length];
            for (int i = 0; i < sids.Length; i++)
            {
                IntPtr sid;
                if (!ConvertStringSidToSid(RestrictSids[i], out sid)) throw Last("ConvertStringSidToSid");
                allocated.Add(sid); sids[i].Sid = sid;
            }
            if (!CreateRestrictedToken(current, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)sids.Length, sids, out result)) throw Last("CreateRestrictedToken");
            if (!IsTokenRestricted(result)) { CloseHandle(result); throw new InvalidOperationException("The new token is not restricted."); }
            return result;
        }
        finally { foreach (IntPtr p in allocated) LocalFree(p); CloseHandle(current); }
    }

    static IntPtr NewPrivateDesktop()
    {
        string name = "x002-" + Guid.NewGuid().ToString("N");
        IntPtr existing = OpenDesktop(name, 0, false, 1);
        int openError = existing == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
        if (existing != IntPtr.Zero) CloseDesktop(existing);
        if (existing != IntPtr.Zero || openError != 2)
            throw new InvalidOperationException("Desktop name collision or inconclusive absence; no existing object is modified.");
        IntPtr sd;
        uint size;
        string logon = RestrictSids.Single(s => s.StartsWith("S-1-5-5-", StringComparison.Ordinal));
        // Only the new object receives this ACL. The restricting logon SID gets
        // read/create-window/write-object rights, not SWITCHDESKTOP/WRITE_DAC.
        string sddl = "D:P(A;;GA;;;" + WindowsIdentity.GetCurrent().User.Value + ")(A;;0x00020083;;;" + logon + ")(A;;RC;;;OW)";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out sd, out size)) throw Last("Desktop SDDL");
        try
        {
            var security = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = sd, bInheritHandle = false };
            IntPtr desk = CreateDesktop(name, null, IntPtr.Zero, 0, 0x000F01FF, ref security);
            if (desk == IntPtr.Zero) throw Last("CreateDesktop");
            WorkerDesktop = name;
            Events.Add(new { phase = "create-private-desktop", name = name, restrictedRights = "0x00020083", visibleSwitch = false });
            return desk;
        }
        finally { LocalFree(sd); }
    }

    sealed class LaunchResult { public bool Success; public int Error; public uint ExitCode; public uint Pid; public string StartedUtc; public bool JobEmpty; public bool TimedOut; }
    static LaunchResult Launch(IntPtr token, string mode, IntPtr inherited)
    {
        string exe = Path.Combine(DataRoot, "tools", "probe.exe");
        var args = Quote(exe) + " " + mode + " " + Quote(RunRoot) + (inherited == IntPtr.Zero ? "" : " " + inherited.ToInt64());
        var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.StartupInfo.dwFlags = 1; si.StartupInfo.wShowWindow = 0;
        si.StartupInfo.lpDesktop = WorkerDesktop;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        IntPtr job = IntPtr.Zero, list = IntPtr.Zero, handles = IntPtr.Zero;
        var result = new LaunchResult { StartedUtc = DateTime.UtcNow.ToString("o") };
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw Last("CreateJobObject");
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw Last("SetInformationJobObject");
            uint flags = CREATE_SUSPENDED | CREATE_NO_WINDOW;
            if (inherited != IntPtr.Zero)
            {
                IntPtr size = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                list = Marshal.AllocHGlobal(size);
                if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw Last("InitializeProcThreadAttributeList");
                handles = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handles, inherited);
                if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Last("UpdateProcThreadAttribute HANDLE_LIST");
                si.lpAttributeList = list; si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                flags |= EXTENDED_STARTUPINFO_PRESENT;
            }
            bool ok = token != IntPtr.Zero
                ? CreateProcessAsUser(token, exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, inherited != IntPtr.Zero, flags, IntPtr.Zero, Allowed(""), ref si, out pi)
                : CreateProcess(exe, new StringBuilder(args), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, Allowed(""), ref si, out pi);
            if (!ok) { result.Error = Marshal.GetLastWin32Error(); return result; }
            result.Pid = pi.dwProcessId;
            if (!AssignProcessToJobObject(job, pi.hProcess)) throw Last("AssignProcessToJobObject");
            if (ResumeThread(pi.hThread) == uint.MaxValue) throw Last("ResumeThread");
            uint waited = WaitForSingleObject(pi.hProcess, 20000);
            if (waited == 258) { result.TimedOut = true; result.Error = 1460; return result; }
            if (waited != 0) throw Last("WaitForSingleObject");
            if (!GetExitCodeProcess(pi.hProcess, out result.ExitCode)) throw Last("GetExitCodeProcess");
            var accounting = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
            if (!QueryInformationJobObject(job, 1, ref accounting, (uint)Marshal.SizeOf(accounting), IntPtr.Zero)) throw Last("QueryInformationJobObject");
            result.JobEmpty = accounting.ActiveProcesses == 0;
            result.Success = result.ExitCode == 0 && result.JobEmpty;
            return result;
        }
        catch (Win32Exception e) { result.Error = e.NativeErrorCode; return result; }
        finally
        {
            // Job contains only the new suspended child and its descendants.
            // Never search for or terminate processes by name or unrelated PID.
            if (job != IntPtr.Zero) CloseHandle(job);
            if (pi.hProcess != IntPtr.Zero)
            {
                if (WaitForSingleObject(pi.hProcess, 0) == 258) { TerminateProcess(pi.hProcess, 99); WaitForSingleObject(pi.hProcess, 5000); }
                CloseHandle(pi.hProcess);
            }
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (list != IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
    }

    static Dictionary<string, object> TokenIdentity()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) throw Last("OpenProcessToken identity");
        try
        {
            int length;
            IntPtr elevated = Marshal.AllocHGlobal(4);
            bool isElevated;
            try
            {
                if (!GetTokenInformation(token, 20, elevated, 4, out length)) throw Last("TokenElevation");
                isElevated = Marshal.ReadInt32(elevated) != 0;
            }
            finally { Marshal.FreeHGlobal(elevated); }
            GetTokenInformation(token, 11, IntPtr.Zero, 0, out length);
            IntPtr buffer = Marshal.AllocHGlobal(length);
            var restrictions = new List<string>();
            try
            {
                if (!GetTokenInformation(token, 11, buffer, length, out length)) throw Last("TokenRestrictedSids");
                int count = Marshal.ReadInt32(buffer);
                int offset = IntPtr.Size == 8 ? 8 : 4;
                for (int i = 0; i < count; i++)
                {
                    var entry = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(buffer, offset + i * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES))), typeof(SID_AND_ATTRIBUTES));
                    restrictions.Add(new SecurityIdentifier(entry.Sid).Value);
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
            using (var process = Process.GetCurrentProcess())
                return new Dictionary<string, object> { { "pid", process.Id }, { "startUtc", process.StartTime.ToUniversalTime().ToString("o") }, { "userSid", WindowsIdentity.GetCurrent().User.Value }, { "restricted", IsTokenRestricted(token) }, { "restrictingSids", restrictions }, { "elevated", isElevated } };
        }
        finally { CloseHandle(token); }
    }

    static string[] ReadCurrentTokenSids(int infoClass)
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) throw Last("OpenProcessToken SID list");
        try
        {
            int length;
            GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out length);
            if (length <= 0) throw Last("GetTokenInformation size");
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(token, infoClass, buffer, length, out length)) throw Last("GetTokenInformation SID list");
                int count = Marshal.ReadInt32(buffer);
                var sids = new List<string>();
                int offset = IntPtr.Size == 8 ? 8 : 4;
                for (int i = 0; i < count; i++)
                {
                    var entry = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(buffer, offset + i * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES))), typeof(SID_AND_ATTRIBUTES));
                    sids.Add(new SecurityIdentifier(entry.Sid).Value);
                }
                if (infoClass == 28 && (sids.Count != 1 || !sids[0].StartsWith("S-1-5-5-", StringComparison.Ordinal)))
                    throw new InvalidOperationException("Expected exactly one current logon SID.");
                return sids.ToArray();
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(token); }
    }

    sealed class Row { public string Operation; public bool Success; public int Win32Error; public string ErrorName; public uint Bytes; }
    static Row Result(string name, bool ok, int code, uint bytes = 0)
    { return new Row { Operation = name, Success = ok, Win32Error = code, ErrorName = code == 0 ? "SUCCESS" : code == ERROR_ACCESS_DENIED ? "ERROR_ACCESS_DENIED" : new Win32Exception(code).Message, Bytes = bytes }; }
    static IntPtr Open(string path, uint access, bool dir)
    { return CreateFile(path, access, 1 | 2 | 4, IntPtr.Zero, 3, dir ? FILE_FLAG_BACKUP_SEMANTICS : 0, IntPtr.Zero); }
    static Row Access(string name, string path, uint access, bool dir)
    {
        IntPtr h = Open(path, access, dir);
        if (h == Invalid) return Result(name, false, Marshal.GetLastWin32Error());
        CloseHandle(h); return Result(name, true, 0);
    }
    static Row Read(string name, string path)
    {
        IntPtr h = Open(path, GR, false);
        if (h == Invalid) return Result(name, false, Marshal.GetLastWin32Error());
        try { byte[] data = new byte[128]; uint count; bool ok = ReadFile(h, data, 128, out count, IntPtr.Zero); return Result(name, ok, ok ? 0 : Marshal.GetLastWin32Error(), count); }
        finally { CloseHandle(h); }
    }
    static Row Write(string name, string path)
    {
        IntPtr h = Open(path, GW, false);
        if (h == Invalid) return Result(name, false, Marshal.GetLastWin32Error());
        try { byte[] data = Encoding.ASCII.GetBytes("EDIT"); uint count; bool ok = WriteFile(h, data, (uint)data.Length, out count, IntPtr.Zero); return Result(name, ok, ok ? 0 : Marshal.GetLastWin32Error(), count); }
        finally { CloseHandle(h); }
    }
    static Row Delete(string name, string path)
    { bool ok = DeleteFile(path); return Result(name, ok, ok ? 0 : Marshal.GetLastWin32Error()); }
    static Row ChangeDacl(string name, string path)
    {
        try { SetDacl(path, "D:P(A;;FA;;;" + WindowsIdentity.GetCurrent().User.Value + ")(A;;FA;;;BU)(A;;RC;;;OW)"); return Result(name, true, 0); }
        catch (UnauthorizedAccessException) { return Result(name, false, 5); }
        catch (Win32Exception e) { return Result(name, false, e.NativeErrorCode); }
    }

    static string Protected(string name) { return Path.Combine(DataRoot, "protected", name); }
    static string Allowed(string name) { return Path.Combine(DataRoot, "allowed", name); }
    static string Quote(string s)
    { if (s.IndexOf('"') >= 0 || s.EndsWith("\\")) throw new ArgumentException("Unsupported quote/trailing slash in argument."); return "\"" + s + "\""; }
    static Win32Exception Last(string name) { return new Win32Exception(Marshal.GetLastWin32Error(), name); }
    static void WriteJson(string path, object value) { File.WriteAllText(path, Json.Serialize(value), new UTF8Encoding(false)); }
    static object ReadJson(string path) { return Json.DeserializeObject(File.ReadAllText(path, Encoding.UTF8)); }
    static string Hash(string path)
    { using (var sha = SHA256.Create()) using (var stream = File.OpenRead(path)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    static Dictionary<string, string> ProtectedHashes()
    {
        var hashes = new Dictionary<string, string>();
        foreach (string path in Directory.GetFiles(Protected(""))) hashes[Path.GetFileName(path)] = Hash(path);
        return hashes;
    }
    static bool StableProtectedHashes(Dictionary<string, string> before, Dictionary<string, string> after)
    { return before.Count == after.Count && before.All(p => after.ContainsKey(p.Key) && after[p.Key] == p.Value); }
    static string GetSddl(string path)
    {
        Guard(path);
        FileSystemSecurity acl = Directory.Exists(path) ? (FileSystemSecurity)Directory.GetAccessControl(path, AccessControlSections.Access) : File.GetAccessControl(path, AccessControlSections.Access);
        return acl.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
    }
    static void SetDacl(string path, string sddl)
    {
        Guard(path);
        if (Directory.Exists(path)) { var acl = new DirectorySecurity(); acl.SetSecurityDescriptorSddlForm(sddl, AccessControlSections.Access); Directory.SetAccessControl(path, acl); }
        else { var acl = new FileSecurity(); acl.SetSecurityDescriptorSddlForm(sddl, AccessControlSections.Access); File.SetAccessControl(path, acl); }
    }
    static object SnapshotAcls()
    { return SavedAcl.Keys.ToDictionary(path => path.Substring(DataRoot.Length).TrimStart('\\'), path => GetSddl(path)); }
    static bool RestoreAcls()
    {
        if (SavedAcl.Count == 0) return true;
        bool ok = true;
        // Restore parent inheritance first, then compare only after every
        // write. Comparing a child while its parent still has the test policy
        // can report a transient mismatch although final restoration succeeds.
        foreach (var pair in SavedAcl.OrderBy(p => p.Key.Length))
        {
            if (!File.Exists(pair.Key) && !Directory.Exists(pair.Key)) continue;
            SetDacl(pair.Key, pair.Value);
        }
        foreach (var pair in SavedAcl)
        {
            if (!File.Exists(pair.Key) && !Directory.Exists(pair.Key)) continue;
            if (GetSddl(pair.Key) != pair.Value) { ok = false; Events.Add(new { phase = "restore-mismatch", path = pair.Key }); }
        }
        Events.Add(new { phase = "restore", restored = ok });
        return ok;
    }
    static void CleanFixtures()
    {
        Guard(DataRoot);
        string marker = Path.Combine(DataRoot, ".x002-owned");
        if (!File.Exists(marker) || File.ReadAllText(marker).Trim() != Path.GetFileName(RunRoot)) throw new InvalidOperationException("Ownership marker mismatch; preserve fixtures.");
        var all = EnumeratePlain(DataRoot).OrderByDescending(p => p.Length).ToArray();
        // Preflight the whole set before deletion. No recursive delete API or
        // shell string exists here. Links/reparse points are never followed.
        foreach (string path in all) Guard(path);
        foreach (string path in all)
        {
            Guard(path);
            if (Directory.Exists(path)) Directory.Delete(path, false); else File.Delete(path);
        }
        Directory.Delete(DataRoot, false);
    }
    static List<string> EnumeratePlain(string path)
    {
        Guard(path);
        var result = new List<string>();
        foreach (string child in Directory.GetFileSystemEntries(path))
        { Guard(child); result.Add(child); if (Directory.Exists(child)) result.AddRange(EnumeratePlain(child)); }
        return result;
    }
    static string ValidateRunRoot(string value)
    {
        string path = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
        string parent = Path.GetDirectoryName(path);
        if (Path.GetFileName(parent) != "x-002-file-access" || Path.GetFileName(Path.GetDirectoryName(parent)) != ".runtime" || !Path.GetFileName(path).StartsWith("run-", StringComparison.Ordinal))
            throw new InvalidOperationException("Destination must be a new .runtime/x-002-file-access/run-* directory.");
        PlainAncestors(path);
        return path;
    }
    static void Guard(string path)
    {
        string full = Path.GetFullPath(path);
        if (!full.Equals(DataRoot, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(DataRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Path is outside this fixture: " + path);
        PlainAncestors(full);
    }
    static void PlainAncestors(string path)
    {
        for (string part = path; !string.IsNullOrEmpty(part); part = Path.GetDirectoryName(part))
        {
            uint attrs = GetFileAttributes(part);
            if (attrs == uint.MaxValue)
            {
                int code = Marshal.GetLastWin32Error();
                if (code != 2 && code != 3 && code != 5) throw new Win32Exception(code, "GetFileAttributes");
                // Restricted worker cannot query protected ancestors. It does
                // not create/delete trees; controller always has full access.
                if (code == 5 && !IsCurrentRestricted()) throw new Win32Exception(code, "Guard access denied");
            }
            else if ((attrs & 0x400) != 0) throw new InvalidOperationException("Reparse point is unsupported: " + part);
        }
    }
    static bool IsCurrentRestricted()
    { IntPtr t; if (!OpenProcessToken(GetCurrentProcess(), 8, out t)) throw Last("OpenProcessToken guard"); try { return IsTokenRestricted(t); } finally { CloseHandle(t); } }
    static object OtherProcesses()
    {
        var rows = new List<object>();
        foreach (string name in new[] { "explorer", "msedge", "blender", "electron" })
            foreach (Process process in Process.GetProcessesByName(name))
                using (process)
                {
                    try { rows.Add(new { name = name, pid = process.Id, startUtc = process.StartTime.ToUniversalTime().ToString("o"), cpuMs = process.TotalProcessorTime.TotalMilliseconds, workingSet = process.WorkingSet64, responding = process.Responding }); }
                    catch (Exception e) { rows.Add(new { name = name, pid = process.Id, observationError = e.GetType().Name }); }
                }
        return rows;
    }

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool IsTokenRestricted(IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int info, IntPtr buffer, int length, out int required);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string sid, out IntPtr result);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateDesktop(string name, string device, IntPtr mode, uint flags, uint access, ref SECURITY_ATTRIBUTES sa);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr old, uint flags, uint disabledCount, IntPtr disabled, uint deleteCount, IntPtr deleted, uint restrictedCount, SID_AND_ATTRIBUTES[] restricted, out IntPtr result);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION data, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int info, ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION data, uint length, IntPtr required);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(IntPtr file, byte[] data, uint size, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr file, byte[] data, uint size, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool DeleteFile(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool RemoveDirectory(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool MoveFile(string from, string to);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateHardLink(string link, string target, IntPtr sa);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFileAttributes(string path);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr old, IntPtr required);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
}
