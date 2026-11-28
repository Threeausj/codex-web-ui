/** macOS counterpart to Linux's /proc writer inspection. Runs only inside
 * the fixed Python helper on the configured workstation. */
export const DARWIN_WRITER_PROBE = String.raw`
if sys.platform == 'darwin':
    import ctypes
    import struct

    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    libproc.proc_pidinfo.argtypes = (ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int)
    PROC_UID_ONLY = 4
    PROC_PIDLISTFDS = 1
    PROC_PIDTBSDINFO = 3
    PROC_PIDFDVNODEINFO = 1
    PROX_FDTYPE_VNODE = 1
    PROC_FP_SHARED = 1
    FWASLOCKED = 0x4000
    FREAD_FWRITE = 0x3
    MNT_LOCAL = 0x1000
    flock_format = struct.Struct('=qqihh')
    fd_format = struct.Struct('=iI')

def darwin_process(pid):
    # proc_bsdinfo and vnode_fdinfo from XNU <sys/proc_info.h> (64-bit ABI).
    data = ctypes.create_string_buffer(136)
    if libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, data, len(data)) != len(data): return None
    return data.raw

def darwin_identity(pid):
    data = darwin_process(pid)
    if data is None: refuse('writer_changed')
    _, status, _, actual, _, uid, _, ruid, _, saved_uid = struct.unpack_from('=10I', data)
    start_sec, start_usec = struct.unpack_from('=QQ', data, 120)
    if actual != pid or status == 5: refuse('writer_changed')  # SZOMB
    if {uid, ruid, saved_uid} != {os.geteuid()}: refuse('writer_permissions')
    executable = ctypes.create_string_buffer(4096)
    if libproc.proc_pidpath(pid, executable, len(executable)) <= 0: refuse('writer_changed')
    exe = os.fsdecode(executable.value)
    if data[48:64].split(b'\0', 1)[0] != b'codex' or os.path.basename(exe) != 'codex':
        refuse('writer_not_codex')
    return {'pid': pid, 'startTime': str(start_sec * 1000000 + start_usec), 'uid': uid, 'executable': exe}

def darwin_parent(pid):
    data = darwin_process(pid)
    if data is None: raise FileNotFoundError()
    return struct.unpack_from('=I', data, 16)[0]

def darwin_check_local(directory):
    libc = ctypes.CDLL(None, use_errno=True)
    fstatfs = getattr(libc, 'fstatfs$INODE64', None) or libc.fstatfs
    data = ctypes.create_string_buffer(4096)
    # f_flags in the 64-bit statfs layout from <sys/mount.h>.
    if fstatfs(directory, data) != 0 or not struct.unpack_from('=I', data, 64)[0] & MNT_LOCAL:
        refuse('writer_unidentified')

def darwin_pids():
    uid = os.geteuid()
    needed = libproc.proc_listpids(PROC_UID_ONLY, uid, None, 0)
    if needed <= 0: refuse('writer_unidentified')
    data = ctypes.create_string_buffer(needed + 1024)
    size = libproc.proc_listpids(PROC_UID_ONLY, uid, data, len(data))
    if size <= 0 or size >= len(data) or size % 4: refuse('writer_unidentified')
    return (pid for (pid,) in struct.iter_unpack('=i', data.raw[:size]) if pid > 1 and pid != os.getpid())

def darwin_marked_descriptors(pid, targets):
    needed = libproc.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, None, 0)
    if needed <= 0: return
    # macOS can give GUI processes descriptor tables much larger than 10,000
    # slots. Only bound the single proc_info allocation, not open files systemwide.
    if needed > 2 * 1024 * 1024: refuse('writer_unidentified')
    data = ctypes.create_string_buffer(needed)
    size = libproc.proc_pidinfo(pid, PROC_PIDLISTFDS, 0, data, len(data))
    if size >= len(data) or size % fd_format.size: refuse('writer_changed')
    info = ctypes.create_string_buffer(176)
    for descriptor, kind in fd_format.iter_unpack(data.raw[:size]):
        if kind != PROX_FDTYPE_VNODE: continue
        count = libproc.proc_pidfdinfo(pid, descriptor, PROC_PIDFDVNODEINFO, info, len(info))
        if count != len(info): continue
        flags, status = struct.unpack_from('=II', info)
        if not flags & FWASLOCKED: continue
        device, mode, _, inode = struct.unpack_from('=IHHQ', info, 24)
        key = (os.major(device), os.minor(device), inode)
        if key in targets and stat.S_ISREG(mode):
            unshared_writer = not (status & PROC_FP_SHARED) and (flags & FREAD_FWRITE) == FREAD_FWRITE
            yield key, unshared_writer

def darwin_has_exclusive_flock(fd):
    # Darwin reports the conflict for flock via F_GETLK, with -1 for the
    # open file description rather than a process ID. Read locks and partial
    # record locks cannot be native Codex thread writers.
    requested = flock_format.pack(0, 0, 0, fcntl.F_WRLCK, os.SEEK_SET)
    start, length, owner, kind, whence = flock_format.unpack(fcntl.fcntl(fd, fcntl.F_GETLK, requested))
    return (start, length, owner, kind, whence) == (0, 0, -1, fcntl.F_WRLCK, os.SEEK_SET)

def darwin_flock_owners(target, directory=None):
    info = os.fstat(target)
    if info.st_uid != os.geteuid() or info.st_nlink != 1: refuse('writer_permissions')
    if not darwin_has_exclusive_flock(target): return {}
    targets = {file_key(info): None}
    if directory is not None:
        names = os.listdir(directory)
        if len(names) > 10000: refuse('writer_too_many_locks')
        for name in names:
            if name != '.coordination.lock' and not (name.endswith('.lock') and UUID.fullmatch(name[:-5])): continue
            entry = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if stat.S_ISREG(entry.st_mode): targets.setdefault(file_key(entry), name)
    candidates = {}
    for pid in darwin_pids():
        for key, unshared_writer in darwin_marked_descriptors(pid, targets):
            candidates.setdefault(key, []).append((pid, unshared_writer))
    owners = {}
    for key, descriptors in candidates.items():
        name = targets[key]
        fd = target if name is None else open_lock(directory, name)
        try:
            if file_key(os.fstat(fd)) != key: refuse('writer_changed')
            if not darwin_has_exclusive_flock(fd): continue
            # FWASLOCKED is historical. Require a live exclusive conflict,
            # one matching description, and no shared references to that FD.
            pids = {pid for pid, _ in descriptors}
            if len(descriptors) != 1 or not descriptors[0][1]: pids.add(-1)
            owners[key] = pids
        finally:
            if name is not None: os.close(fd)
    return owners
`
