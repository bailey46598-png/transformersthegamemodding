# Builds VoiceMenu's line list (data/VoiceLines.txt) from the game's own data, and optionally copies the
# dialogue WAVs next to an install.
#
#   python make_voicelines.py <game folder> <dialogue wav folder> [--copy <install folder>]
#
# Who says a line comes from LEVELS\*\SPEECH.INI ("Head" = the speaker, "Sound" = the WAV). About half the
# WAVs are only played as music overlays (AUDIO\MUSIC.CFG) and have no speaker. Those get the speaker of the
# other lines in the same mission chapter when that chapter has only one speaker ("guess" column = 1);
# the rest go under "Other". Edit data/VoiceLines.txt by hand to fix any of them.
#
# The "dramatic" column marks taunts, threats, battle cries and victory lines, judged from the subtitle text
# in GUI\STRINGS_BIO.CSV: mission directions, briefings and hints are 0. Lines with no subtitle are mid-fight
# lines; they are 1 unless they are a "go to" line, and keep guess = 1 since nobody has checked them.
import csv
import io
import os
import re
import shutil
import sys
from collections import defaultdict

SPEAKERS = {"optimus": "Optimus", "starscream": "Starscream", "megatron": "Megatron", "frenzy": "Frenzy",
            "jazz": "Jazz", "blackout": "Blackout", "ironhide": "Ironhide", "bumblebee": "Bumblebee",
            "barricade": "Barricade", "brawl": "Brawl", "bonecrusher": "Bonecrusher", "ratchet": "Ratchet"}

# The HUD portrait each speaker uses (the head index of the game's speech bubble, 0x48FFB0).
HEADS = {"Optimus": 0, "Bumblebee": 1, "Starscream": 3, "Frenzy": 4, "Jazz": 5, "Blackout": 6, "Ironhide": 7,
         "Bonecrusher": 8, "Brawl": 9, "Megatron": 10, "Barricade": 11}

# Lines the game files under the wrong speaker. SPEECH.INI can't name Brawl (the parser has no "Brawl"), so
# Brawl's calls for backup in Decepticon 3 chapter 4 use Bumblebee's head.
SPEAKER_FIX = {"d3_ch4_obj%d" % i: "Brawl" for i in range(2, 8)}

# Subtitle text that marks a line as directions or a briefing rather than drama.
NOT_DRAMATIC = re.compile(
    r"beacon|head (for|to|towards)|get to |proceed|rendezvous|marked|location|co-?ordinates|objective|hint:|"
    r"investigate|search|pick up|throw away|shoot (the|out)|fans?\b|reactor|containment|signal|terminal|data|"
    r"dispatch|attention all|grab a weapon|explosive|mindful|heading for|retrieve|meet me|we must get|"
    r"you must get|you'll need|you need|you have to reach|we need|keep moving|hold out|is in trouble|on my way|"
    r"landing|transmission|escape with|is just up ahead|prepare to leave|lend me|back-?up|support|pinned|"
    r"rescue|in one of these|is that a drone|before they sound|smooth retreat|can't let him get away|"
    r"get them before|get clear|get out of there|it's going to blow|well done|good work|good job|scanning|"
    r"must reach|don't let (it|them|any)|almost found|something around here|we're safe|drones detected|"
    r"hold off|make your escape",
    re.I)
# Kept even though they match the pattern above.
FORCE_DRAMATIC = {"a2_ch2_obj9"}


def load_strings(game):
    p = os.path.join(game, "GUI", "STRINGS_BIO.CSV")
    if not os.path.exists(p):
        return {}
    rows = list(csv.reader(io.StringIO(open(p, "rb").read().decode("utf-16"))))
    hdr = rows[0]
    e = hdr.index("ENGLISH")
    a = hdr.index("AMERICAN") if "AMERICAN" in hdr else e
    return {r[0].strip().lower(): (r[a] if len(r) > a and r[a] else r[e]).strip()
            for r in rows[1:] if r and len(r) > e}


def is_dramatic(stem, sub, speaker):
    if speaker == "Other":
        return False
    if stem in FORCE_DRAMATIC:
        return True
    if not sub or sub.lower() == stem:  # no subtitle: a mid-fight line
        return not re.search(r"goto", stem)
    if len(sub) > 100 or NOT_DRAMATIC.search(sub):
        return False
    return True

KIND = [(r"goto(\d*)$", "Go to"), (r"obj(\d+)$", "Objective"), (r"cmplt(\d*)$", "Complete"),
        (r"intro(\d*)$", "Intro"), (r"midtro(\d*)$", "Midtro")]


def chapter_key(stem):
    m = re.match(r"([ad]\d+)_ch(\d+)_", stem)
    return (m.group(1), int(m.group(2))) if m else None


def label(stem, level):
    s = stem.lower()
    m = re.match(r"([ad])(\d+)_ch(\d+)_(.*)", s)
    if m:
        side = "Autobot" if m.group(1) == "a" else "Decepticon"
        rest = m.group(4)
        what = rest
        for pat, name in KIND:
            k = re.match(pat, rest)
            if k:
                what = name + (" " + k.group(1) if k.group(1) else "")
                break
        where = level.title() if level else side + " " + m.group(2)
        return "%s - Ch %s - %s" % (where, m.group(3), what)
    m = re.match(r"(auto|decep)(\d+)levelintro", s)
    if m:
        return "%s %s - Level intro" % ("Autobot" if m.group(1) == "auto" else "Decepticon", m.group(2))
    return stem


def main():
    game, wavdir = sys.argv[1], sys.argv[2]
    copy_to = sys.argv[sys.argv.index("--copy") + 1] if "--copy" in sys.argv else None
    wavs = {os.path.splitext(f)[0].lower(): f for f in os.listdir(wavdir) if f.lower().endswith(".wav")}

    speaker, text, level = {}, {}, {}
    for lv in sorted(os.listdir(os.path.join(game, "LEVELS"))):
        p = os.path.join(game, "LEVELS", lv, "SPEECH.INI")
        if not os.path.exists(p):
            continue
        for blk in re.findall(r"Speech\s*\{(.*?)\}", open(p, encoding="latin-1").read(), re.S):
            kv = {k.lower(): v.strip() for k, v in re.findall(r"(\w+)\s*=\s*\"?([^\"\r\n]*)\"?", blk)}
            s = kv.get("sound", "").lower()
            h = SPEAKERS.get(kv.get("head", "").lower())
            if s in wavs and h:
                speaker.setdefault(s, h)
                text.setdefault(s, kv.get("text", ""))
                level.setdefault(s, lv)

    # Level of each overlay line, from the ALBUM it sits in (MUSIC.CFG).
    album = None
    mus = os.path.join(game, "AUDIO", "MUSIC.CFG")
    for line in open(mus, encoding="latin-1"):
        a = re.match(r'\s*ALBUM\s+"([^"]+)"', line, re.I)
        if a:
            album = a.group(1).upper()
            continue
        for f in re.findall(r'_DIALOGUE\\(?:\$LANG|USA\\)([^"\s]+)', line, re.I):
            level.setdefault(f.lower(), album)

    # Chapter -> speakers among the known lines.
    chap = defaultdict(set)
    for s, h in speaker.items():
        if chapter_key(s):
            chap[chapter_key(s)].add(h)

    strings = load_strings(game)
    rows = []
    seen = set()  # (speaker, subtitle): later takes of the same line aren't dramatic again
    for s in sorted(wavs, key=lambda x: (chapter_key(x) or ("z", 0), x)):
        guess = 0
        h = SPEAKER_FIX.get(s) or speaker.get(s)
        if not h:
            c = chap.get(chapter_key(s)) if chapter_key(s) else None
            if c and len(c) == 1:
                h, guess = next(iter(c)), 1
            else:
                h = "Other"
        tid = text.get(s) or os.path.splitext(wavs[s])[0]
        sub = strings.get(tid.lower()) or ""
        if not sub and strings.get(s):
            tid, sub = os.path.splitext(wavs[s])[0], strings[s]  # the game looks the id up case-insensitively
        drama = is_dramatic(s, sub, h)
        if drama and sub and sub.lower() != s:
            if (h, sub.lower()) in seen:
                drama = False
            seen.add((h, sub.lower()))
        if drama and (not sub or sub.lower() == s):
            guess = 1  # nobody has checked what an unsubtitled line says
        rows.append((h, wavs[s], tid, label(s, level.get(s)), guess, HEADS.get(h, -1), int(drama)))

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "VoiceLines.txt")
    with open(out, "w", encoding="utf-8", newline="\r\n") as fh:
        fh.write("; VoiceMenu line list. One line per row, tab separated:\n")
        fh.write(";   speaker <TAB> wav file <TAB> subtitle text id <TAB> menu label <TAB> guess (1 = unchecked)\n")
        fh.write(";   <TAB> head (HUD portrait: 0 Optimus, 1 Bumblebee, 3 Starscream, 4 Frenzy, 5 Jazz, 6 Blackout,\n")
        fh.write(";   7 Ironhide, 8 Bonecrusher, 9 Brawl, 10 Megatron, 11 Barricade, -1 none)\n")
        fh.write(";   <TAB> dramatic (1 = shown when DramaticOnly=1)\n")
        fh.write("; Speaker names are matched against the player's character name (Megatron matches G1Megatron).\n")
        fh.write("; Generated by tools/make_voicelines.py; safe to edit by hand.\n")
        for r in rows:
            fh.write("\t".join(str(x) for x in r) + "\n")

    counts = defaultdict(lambda: [0, 0, 0])
    for r in rows:
        counts[r[0]][0] += 1
        counts[r[0]][1] += r[6]
        counts[r[0]][2] += r[6] and r[4]
    for h, (n, d, g) in sorted(counts.items(), key=lambda x: -x[1][0]):
        print("%-11s %3d lines, %3d dramatic (%d of them unchecked)" % (h, n, d, g))
    print("wrote", os.path.normpath(out))

    if copy_to:
        dst = os.path.join(copy_to, "VoiceMenu", "Lines")
        os.makedirs(dst, exist_ok=True)
        n = 0
        for f in wavs.values():
            d = os.path.join(dst, f)
            if not os.path.exists(d) or os.path.getsize(d) != os.path.getsize(os.path.join(wavdir, f)):
                shutil.copy2(os.path.join(wavdir, f), d)
                n += 1
        shutil.copy2(out, os.path.join(copy_to, "VoiceMenu", "VoiceLines.txt"))
        print("copied %d WAVs (+ list) to %s" % (n, dst))


if __name__ == "__main__":
    main()
