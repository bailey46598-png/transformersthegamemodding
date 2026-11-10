#!/usr/bin/env python3
"""Show or compare F8 camera dumps from CharacterCams.asi / TripleCFlightCam.asi.

Usage:
  python dumpdiff.py A.bin                    show every field of one dump
  python dumpdiff.py A.bin B.bin              show only the fields that differ
  python dumpdiff.py A.bin B.bin --all        show every field, differences marked with *
  python dumpdiff.py A.bin B.bin -s preset    only one section (header, profile, aircraft, preset, car, cam, render)

Each 4-byte field is printed as hex, as a float (when it looks like one) and as a game address (when it looks
like one). Offsets are from the start of that section, so "preset +0x48" is the camera preset's +0x48 field.

File formats (written by DumpNow in the plugins' source):
  TCF2 (CharacterCams, TripleCFlightCam 0.6+): 16 u32 header, then profile 0x80, aircraft 0xA90,
       active camera preset 0x160, car 0x7F0, player camera [0x770610] 0x400, render camera [0x77060C] 0x100.
  TCFD (TripleCFlightCam 0.3-0.5): 8 u32 header, then profile 0x80, aircraft 0xA90, preset 0x160.
Sections are zero-filled when the thing didn't exist (e.g. no aircraft while driving a car).
"""
import argparse
import math
import struct
import sys

HEADER_NAMES_TCF2 = ["magic", "identity", "profile ptr", "aircraft ptr", "preset ptr", "char+0x52C", "char+0x530",
                     "char+0x5C0", "car ptr", "player cam ptr", "render cam ptr", "R held", "spare", "spare",
                     "spare", "spare"]
HEADER_NAMES_TCFD = ["magic", "identity", "profile ptr", "aircraft ptr", "preset ptr", "char+0x52C", "char+0x530",
                     "char+0x5C0"]

LAYOUTS = {
    b"TCF2": (64, HEADER_NAMES_TCF2, [("profile", 0x80), ("aircraft", 0xA90), ("preset", 0x160), ("car", 0x7F0),
                                      ("cam", 0x400), ("render", 0x100)]),
    b"TCFD": (32, HEADER_NAMES_TCFD, [("profile", 0x80), ("aircraft", 0xA90), ("preset", 0x160)]),
}

# A few preset fields we know (see notes/CAMERA_FIX_GUIDE.md).
PRESET_NAMES = {
    0x40: "live distance", 0x44: "live distance", 0x48: "base distance", 0x4C: "camera height",
    0x50: "camera height", 0x54: "camera height / aim y", 0x68: "sin(pitch)", 0x7C: "live pitch (steering reads)",
    0x80: "pitch", 0x84: "pitch", 0xBC: "default pitch", 0xC0: "pitch min", 0xC4: "pitch max",
    0x128: "live distance (ray-clamped)", 0x12C: "live distance", 0x130: "near distance (slow)",
    0x134: "far distance (fast)", 0x158: "base distance",
}
CAM_NAMES = {0x2AC: "flags (0x200 = R view)", 0x2E0: "R view swap"}


def load(path):
    data = open(path, "rb").read()
    magic = data[:4]
    if magic not in LAYOUTS:
        sys.exit(f"{path}: not a camera dump (magic {magic!r})")
    hsize, hnames, secs = LAYOUTS[magic]
    out = {"header": (data[:hsize], hnames)}
    pos = hsize
    for name, size in secs:
        out[name] = (data[pos:pos + size], None)
        pos += size
    return out


def as_float(u):
    f = struct.unpack("<f", struct.pack("<I", u))[0]
    if u == 0 or math.isnan(f) or math.isinf(f):
        return None
    if 1e-6 <= abs(f) <= 1e7:
        return f
    return None


def describe(u):
    parts = [f"0x{u:08X}"]
    f = as_float(u)
    if f is not None:
        parts.append(f"{f:.6g}")
    elif 0x00400000 <= u < 0x00800000:
        parts.append("exe addr")
    elif u < 0x10000 and u:
        parts.append(str(u))
    return " ".join(parts).ljust(26)


def label(section, off, hnames):
    if section == "header" and hnames and off // 4 < len(hnames):
        return hnames[off // 4]
    if section == "preset":
        return PRESET_NAMES.get(off, "")
    if section == "cam":
        return CAM_NAMES.get(off, "")
    return ""


def words(blob):
    n = len(blob) // 4
    return struct.unpack(f"<{n}I", blob[:n * 4])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("a")
    ap.add_argument("b", nargs="?")
    ap.add_argument("-s", "--section", help="only this section")
    ap.add_argument("--all", action="store_true", help="with two files: show equal fields too")
    args = ap.parse_args()

    A = load(args.a)
    B = load(args.b) if args.b else None
    sections = [s for s in A if not args.section or s == args.section]
    if not sections:
        sys.exit(f"no section {args.section!r}; have: {', '.join(A)}")

    for sec in sections:
        blob_a, hnames = A[sec]
        blob_b = B[sec][0] if B and sec in B else None
        wa = words(blob_a)
        wb = words(blob_b) if blob_b is not None else None
        rows = []
        for i, ua in enumerate(wa):
            off = i * 4
            lab = label(sec, off, hnames)
            if wb is None:
                if ua or sec == "header":
                    rows.append(f"  +0x{off:03X}  {describe(ua)} {lab}")
                continue
            ub = wb[i] if i < len(wb) else 0
            diff = ua != ub
            if diff or args.all:
                mark = "*" if diff else " "
                rows.append(f"{mark} +0x{off:03X}  {describe(ua)} {describe(ub)} {lab}")
        if rows:
            print(f"== {sec} ({len(blob_a):#x} bytes)")
            if wb is not None:
                print(f"  {'offset':6}  {'A':26} {'B':26}")
            print("\n".join(rows))
            print()


if __name__ == "__main__":
    main()
