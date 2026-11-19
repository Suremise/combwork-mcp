// Native helpers for setup's trusted storage (acl.ps1 loads this with Add-Type; it compiles with the in-box compiler):
//   CreateSecure  CreateDirectoryW with a SECURITY_ATTRIBUTES: the folder exists with its final security descriptor from
//                 the first instant, or the call fails. Returns false when the path already exists (never reuses it).
//   CreateSecureFile  the same for a new file (CreateFileW, CREATE_NEW, write-through), opened for writing only, shared
//                 with no one (MC-1575: .NET's FileStream constructor that took a FileSecurity is .NET Framework only).
//   Open          opens a folder (or file) for reading its attributes and security only, without following a reparse
//                 point, sharing read and write but NOT delete: while the handle is open nobody can rename, delete or
//                 replace it. Setup holds these handles ("pins") for as long as it runs, and checks through them.
//   Attributes, Identity (volume serial + 128-bit file id, FILE_ID_INFO), SecurityBytes (owner + DACL), all read through
//   a handle, so the object checked is the object pinned.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class HvMcpStorage {
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential)]
  struct FILE_ID_INFO { public ulong VolumeSerialNumber; [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] FileId; }
  [StructLayout(LayoutKind.Sequential)]
  struct FILE_BASIC_INFO { public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime; public uint FileAttributes; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateDirectoryW(string path, ref SECURITY_ATTRIBUTES sa);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int cls, out FILE_ID_INFO info, int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int cls, out FILE_BASIC_INFO info, int size);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(SafeFileHandle h, int objectType, int info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityDescriptorLength(IntPtr sd);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool MoveFileExW(string from, string to, uint flags);

  /// <summary>Renames from over to (same volume), replacing it. The renamed file keeps its own security descriptor (unlike
  /// ReplaceFile, which copies the replaced file's).</summary>
  public static void RenameOver(string from, string to) {
    if (!MoveFileExW(from, to, 0x1 /* MOVEFILE_REPLACE_EXISTING */)) throw new Win32Exception(Marshal.GetLastWin32Error(), "rename " + from);
  }

  const uint READ_CONTROL = 0x00020000, FILE_READ_ATTRIBUTES = 0x80, FILE_LIST_DIRECTORY = 0x1;
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3, CREATE_NEW = 1, GENERIC_WRITE = 0x40000000;
  const uint FILE_ATTRIBUTE_NORMAL = 0x80, FILE_FLAG_WRITE_THROUGH = 0x80000000;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const int ERROR_ALREADY_EXISTS = 183;
  const int FileBasicInfo = 0, FileIdInfo = 0x12, SE_FILE_OBJECT = 1, OWNER_SECURITY_INFORMATION = 1, DACL_SECURITY_INFORMATION = 4;
  public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

  /// <summary>Creates path with exactly this security descriptor (self-relative bytes). False if it already exists.</summary>
  public static bool CreateSecure(string path, byte[] sd) {
    GCHandle pin = GCHandle.Alloc(sd, GCHandleType.Pinned);
    try {
      var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = pin.AddrOfPinnedObject(), bInheritHandle = false };
      if (CreateDirectoryW(path, ref sa)) return true;
      int err = Marshal.GetLastWin32Error();
      if (err == ERROR_ALREADY_EXISTS) return false;
      throw new Win32Exception(err, "CreateDirectoryW " + path);
    } finally { pin.Free(); }
  }

  /// <summary>Creates a new file with exactly this security descriptor (self-relative bytes) from its first instant,
  /// open for writing only and shared with no one, written through. Throws if it already exists or can't be made.</summary>
  public static FileStream CreateSecureFile(string path, byte[] sd) {
    GCHandle pin = GCHandle.Alloc(sd, GCHandleType.Pinned);
    IntPtr sa = IntPtr.Zero;
    try {
      var attrs = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), lpSecurityDescriptor = pin.AddrOfPinnedObject(), bInheritHandle = false };
      sa = Marshal.AllocHGlobal(attrs.nLength);
      Marshal.StructureToPtr(attrs, sa, false);
      var h = CreateFileW(path, GENERIC_WRITE, 0, sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, IntPtr.Zero);
      if (h.IsInvalid) { int err = Marshal.GetLastWin32Error(); h.Dispose(); throw new Win32Exception(err, "create " + path); }
      return new FileStream(h, FileAccess.Write, 4096);
    } finally {
      if (sa != IntPtr.Zero) Marshal.FreeHGlobal(sa);
      pin.Free();
    }
  }

  /// <summary>Opens without following reparse points, sharing read/write but not delete (pins it). Throws on failure.
  /// It asks for FILE_LIST_DIRECTORY (FILE_READ_DATA) too: a handle with only metadata access (attributes, READ_CONTROL)
  /// takes no part in sharing checks, so it wouldn't stop a rename.</summary>
  public static SafeFileHandle Open(string path) {
    var h = CreateFileW(path, FILE_LIST_DIRECTORY | READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (h.IsInvalid) { int err = Marshal.GetLastWin32Error(); h.Dispose(); throw new Win32Exception(err, "open " + path); }
    return h;
  }

  public static uint Attributes(SafeFileHandle h) {
    FILE_BASIC_INFO info;
    if (!GetFileInformationByHandleEx(h, FileBasicInfo, out info, Marshal.SizeOf(typeof(FILE_BASIC_INFO)))) throw new Win32Exception(Marshal.GetLastWin32Error(), "basic info");
    return info.FileAttributes;
  }

  /// <summary>"volumeSerial:fileId" (hex): the object's identity on its volume.</summary>
  public static string Identity(SafeFileHandle h) {
    FILE_ID_INFO info;
    if (!GetFileInformationByHandleEx(h, FileIdInfo, out info, 24)) throw new Win32Exception(Marshal.GetLastWin32Error(), "file id");
    return info.VolumeSerialNumber.ToString("x16") + ":" + BitConverter.ToString(info.FileId).Replace("-", "").ToLowerInvariant();
  }

  /// <summary>The owner and DACL, as a self-relative security descriptor.</summary>
  public static byte[] SecurityBytes(SafeFileHandle h) {
    IntPtr sd;
    uint rc = GetSecurityInfo(h, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
    if (rc != 0) throw new Win32Exception((int)rc, "GetSecurityInfo");
    try {
      var bytes = new byte[GetSecurityDescriptorLength(sd)];
      Marshal.Copy(sd, bytes, 0, bytes.Length);
      return bytes;
    } finally { LocalFree(sd); }
  }
}
