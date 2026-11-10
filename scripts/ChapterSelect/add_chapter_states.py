"""ChapterSelect: give each level hub script states the DebugTrainer can jump to, one per chapter.

Why: every hub has "state SkipLevel", which fades out and then waits for message "MissionMessage" == N to go
to ChapterN_InitGoto. The trainer can enter states by name (FindEvent 0x53B4D0 returns the state, FireEvent
0x53C850 switches to it), but no way to set the message the hub reads was found. So this adds, per chapter N:

    state TrainerChapterN
    {
        conditions { if timer > 1.0 goto ChapterN_InitGoto }
        actions    { <the hub's own SkipLevel actions, copied>  ResetTimer }
    }

and the trainer fires "TrainerChapterN".

    python add_chapter_states.py "<game folder>"            dry run
    python add_chapter_states.py "<game folder>" --apply    edits, keeping *.chapters.bak backups
    python add_chapter_states.py "<game folder>" --restore  puts the backups back
"""
import os
import re
import shutil
import sys

BACKUP = '.chapters.bak'
MARK_BEGIN = '; ---- ChapterSelect: TrainerChapterN states for the DebugTrainer (mods\\ChapterSelect) ----'
MARK_END = '; ---- end ChapterSelect ----'
WAIT = '1.0'  # seconds in the new state before jumping, so the fade-out shows like SkipLevel's


def read(p):
    with open(p, 'r', encoding='latin-1', newline='') as f:
        return f.read()


def write(p, t):
    with open(p, 'w', encoding='latin-1', newline='') as f:
        f.write(t)


def strip_ours(text):
    i = text.find(MARK_BEGIN)
    if i < 0:
        return text
    j = text.find(MARK_END, i)
    j = len(text) if j < 0 else j + len(MARK_END)
    return text[:i].rstrip('\r\n') + text[j:]


def code(line):
    return line.split(';', 1)[0].strip()


def find_hub(ai_dir):
    """The hub file LEVEL1.SCP includes, or None."""
    p = os.path.join(ai_dir, 'LEVEL1.SCP')
    if not os.path.isfile(p):
        return None
    for ln in read(p).splitlines():
        m = re.match(r'include\s+"([^"]*hub[^"]*)"', code(ln), re.I)
        if m:
            for fn in os.listdir(ai_dir):  # case-insensitive match on disk
                if fn.lower() == m.group(1).lower():
                    return os.path.join(ai_dir, fn)
    return None


def parse_start_chapter(text):
    """(actions, {chapter: target}) of the hub's "state GlobalStartChapter", or None.

    This is what the hub runs when you drive into a chapter's action ring: its actions (#StartChapter, clear
    modules, rings and side missions off, counters reset; they differ per hub) and then, for the ring that was
    entered (module "ActionRing ChapterN" == 1), ChapterN_Enter, which plays the intro, loads the chapter's
    creatures and starts it. Doing exactly that is a real chapter start."""
    lines = text.splitlines()
    i = next((k for k, ln in enumerate(lines) if re.match(r'state\s+GlobalStartChapter\s*$', code(ln), re.I)), None)
    if i is None:
        return None
    depth, section, actions, targets = 0, None, [], {}
    for ln in lines[i + 1:]:
        c = code(ln)
        if c == '{':
            depth += 1
            continue
        if c == '}':
            depth -= 1
            if depth == 1:
                section = None
            if depth == 0:
                break
            continue
        if depth == 1 and c.lower() in ('conditions', 'actions'):
            section = c.lower()
            continue
        if depth == 2 and section == 'conditions':
            m = re.match(r'if\s+module\s+"ActionRing Chapter([0-9]+)"\s*==\s*1(?:\.0)?\s+goto\s+(\S+)', c, re.I)
            if m:
                targets[int(m.group(1))] = m.group(2)
        elif depth == 2 and section == 'actions' and c:
            actions.append(c)
    return (actions, targets) if targets else None


def parse_skiplevel(text):
    """(actions lines, {chapter: target state}) of the hub's "state SkipLevel", or None."""
    lines = text.splitlines()
    i = next((k for k, ln in enumerate(lines) if re.match(r'state\s+SkipLevel\s*$', code(ln), re.I)), None)
    if i is None:
        return None
    depth, block, section, actions, targets = 0, [], None, [], {}
    for ln in lines[i + 1:]:
        c = code(ln)
        if c == '{':
            depth += 1
            continue
        if c == '}':
            depth -= 1
            if depth == 1:
                section = None
            if depth == 0:
                break
            continue
        if depth == 1 and c.lower() in ('conditions', 'actions'):
            section = c.lower()
            continue
        if depth == 2 and section == 'conditions':
            m = re.match(r'if\s+message\s+"MissionMessage"\s*==\s*([0-9.]+)\s+goto\s+(\S+)', c, re.I)
            if m:
                targets[int(float(m.group(1)))] = m.group(2)
        elif depth == 2 and section == 'actions' and c:
            actions.append(c)
    return (actions, targets) if targets else None


def parse_prepick(text):
    """{chapter: target} from the hub's "state PrePickGoto", the routing the hub uses at level start:
    ChapterProgress k -> chapter k+1. Chapters 2-4 go to ChapterN_PreInitGoto, which sends "#StartMission"
    (checkpoint placement and screen fade-in) before ChapterN_InitGoto. SkipLevel's targets skip that step,
    which leaves the screen black."""
    lines = text.splitlines()
    i = next((k for k, ln in enumerate(lines) if re.match(r'state\s+PrePickGoto\s*$', code(ln), re.I)), None)
    if i is None:
        return {}
    depth, targets = 0, {}
    for ln in lines[i + 1:]:
        c = code(ln)
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                break
        else:
            m = re.match(r'if\s+module\s+"General ChapterProgress"\s*==\s*([0-9.]+)\s+goto\s+(\S+)', c, re.I)
            if m:
                k = int(float(m.group(1)))
                if k + 1 not in targets and 0 <= k <= 7:
                    targets[k + 1] = m.group(2)
    return targets


def build_block(actions, targets, nl, wait=WAIT):
    out = [MARK_BEGIN]
    for n in sorted(targets):
        out += ['state TrainerChapter%d' % n, '{',
                '\tconditions', '\t{', '\t\tif timer > %s goto %s' % (wait, targets[n]), '\t}',
                '\tactions', '\t{'] + ['\t\t' + a for a in actions] + ['\t\tResetTimer', '\t}', '}']
    out.append(MARK_END)
    return nl.join(out) + nl


def main():
    # --only=LEVEL,LEVEL limits the edit to those level folders (e.g. the Hoover Dam Edition's story slots
    # AutoPrologue/DconPrologue/... aren't normal chapter hubs and are left alone)
    only = None
    for a in sys.argv[2:]:
        if a.startswith('--only='):
            only = {x.strip().lower() for x in a.split('=', 1)[1].split(',') if x.strip()}
    root = sys.argv[1]
    mode = next((a for a in sys.argv[2:] if a in ('--apply', '--restore')), '')
    levels = os.path.join(root, 'LEVELS')
    if mode == '--restore':
        n = 0
        for dp, _, fns in os.walk(levels):
            for fn in fns:
                if fn.endswith(BACKUP):
                    src = os.path.join(dp, fn)
                    shutil.copy2(src, src[:-len(BACKUP)])
                    os.remove(src)
                    n += 1
        print('restored %d files' % n)
        return
    total = 0
    for name in sorted(os.listdir(levels)):
        if only is not None and name.lower() not in only:
            continue
        ai = os.path.join(levels, name, 'AI')
        hub = find_hub(ai) if os.path.isdir(ai) else None
        if not hub:
            continue
        text = strip_ours(read(hub))
        nl = '\r\n' if '\r\n' in text else '\n'
        started = parse_start_chapter(text)
        if started:
            # Preferred: do what the hub does when you enter a chapter's ring.
            actions, targets = started
            block = build_block(actions, targets, nl, wait='0.1')
        else:
            parsed = parse_skiplevel(text)
            if not parsed:
                print('%-22s %-14s no GlobalStartChapter or SkipLevel state: skipped' % (name, os.path.basename(hub)))
                continue
            # Fallback: SkipLevel's actions, then where the hub goes for each chapter at level start.
            actions, skip_targets = parsed
            start_targets = parse_prepick(text)
            targets = {n: start_targets.get(n, skip_targets[n]) for n in skip_targets}
            block = build_block(actions, targets, nl)
        new = text.rstrip('\r\n') + nl + nl + block
        old = read(hub)
        state = 'unchanged' if old == new else ('changed' if mode == '--apply' else 'will change')
        print('%-22s %-14s chapters %s -> %s  %s' % (name, os.path.basename(hub), sorted(targets),
                                                     ', '.join(targets[k] for k in sorted(targets)), state))
        total += 1
        if mode == '--apply' and old != new:
            if not os.path.isfile(hub + BACKUP):
                shutil.copy2(hub, hub + BACKUP)
            write(hub, new)
    print('%d hubs %s' % (total, 'processed' if mode == '--apply' else 'found (dry run; add --apply)'))


if __name__ == '__main__':
    main()
