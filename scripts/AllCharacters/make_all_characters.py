"""AllCharacters: make every Transformer playable in every level.

A level only loads models for the creatures its own LEVELS\\<level>\\CREATURES.CFG includes, and the trainer's
character select can only swap to those. This adds each missing robot family (robot + vehicle + transform
files, as listed in the master CHARS\\CREATURES.CFG) to every level's CREATURES.CFG, and raises the level's
CREATURECACHESIZE_KB in LEVEL.CFG to fit the extra models.

    python make_all_characters.py "<game folder>"            dry run: prints the plan, changes nothing
    python make_all_characters.py "<game folder>" --apply    edits, keeping *.allchars.bak backups
    python make_all_characters.py "<game folder>" --restore  puts the *.allchars.bak files back
Builds on the files as they are now, so edits by other mods (e.g. Playable Ratchet in CITY) are kept.

The type records for every creature already exist in every level (from the master list), so this doesn't touch
the game's 150-type limit; it only decides which models get loaded.
"""
import math
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from creature_cost import Game, active_includes  # noqa: E402

MARK_BEGIN = '; ---- AllCharacters: added robot families (mods\\AllCharacters) ----'
MARK_END = '; ---- end AllCharacters ----'
BACKUP = '.allchars.bak'  # own suffix: never touches other mods' .vanilla backups
CACHE_FACTOR = 2.0  # KB of cache per KB of added model/anim data (shipped levels: 0.7 to 2.6)

# Playable robot families, in master-list order. Each is the exact set of files the master
# CHARS\CREATURES.CFG lists for that robot.
FAMILIES = [
    ('BumbleBee',      ['bumblebee', 'bumblebeecar', 'bumblebeetran']),
    ('BumbleBee07',    ['bumblebee07', 'bumblebee07car', 'bumblebee07tran']),
    ('OptimusPrime',   ['optimusprime', 'optimusprimecar', 'optimusprimetran']),
    ('OptimusPrime01', ['optimusprime01', 'optimusprime01car', 'optimusprime01tran']),
    ('G1OptimusPrime', ['g1optimusprime', 'g1optimusprimecar', 'g1optimusprimetran']),
    ('Barricade',      ['barricade', 'barricadecar', 'barricadetran']),
    ('Scorponok',      ['scorponok']),
    ('Ironhide',       ['Ironhide', 'IronhideVeh', 'IronhideTran']),
    ('TripleC',        ['TripleCTurret', 'TripleC', 'TripleCHeli', 'TripleCTran']),
    ('Jazz',           ['Jazz', 'JazzCar', 'JazzTran']),
    ('Jazz01',         ['Jazz01', 'Jazz01Car', 'Jazz01Tran']),
    ('Brawl',          ['Brawl', 'BrawlCar', 'BrawlTran']),
    ('Blackout',       ['Blackout', 'BlackoutHeli', 'BlackoutTran']),
    ('Starscream',     ['Starscream', 'StarscreamCar', 'StarscreamTran']),
    ('Starscream01',   ['Starscream01', 'Starscream01Car', 'Starscream01Tran']),
    ('BoneCrusher',    ['BoneCrusher', 'BoneCrusherCar', 'BoneCrusherTran']),
    ('Megatron',       ['Megatron', 'MegatronCar', 'MegatronTran']),
    ('G1Megatron',     ['G1Megatron', 'G1MegatronCar', 'G1MegatronTran']),
    ('Ratchet',        ['Ratchet', 'RatchetCar', 'RatchetTran']),  # Playable Ratchet mod: only with --with-ratchet
]

# Ratchet is opt-in. The first time his type existed (2026-11-07), loading a level from the front end hung
# in the creature-load wait (Sleep(10) loop at 0x473050), so his rebuilt model isn't proven yet.
WITH_RATCHET = '--with-ratchet' in sys.argv
OPT_IN_FAMILIES = {'Ratchet'}

# Types missing from the master CHARS\CREATURES.CFG (the file the game's type table is built from) that a
# family above needs. The type table has 150 slots and no bounds check, so the script counts first.
MASTER_ADDITIONS = ['Ratchet', 'RatchetCar', 'RatchetTran']
MAX_TYPES = 150
EXPECTED_VANILLA_TYPES = 147  # measured in game (creature dump)


def count_types(g, includes):
    """Types the game makes from a list of includes: one per file, plus one per TransformingBodyPart CFG."""
    parts = set()

    def walk(rel, seen):
        k = rel.replace('\\', '/').lower()
        if k in seen:
            return
        seen.add(k)
        for ln in g.read_lines(rel) or []:
            toks = ln.split()
            if not toks:
                continue
            if toks[0].upper() == 'INCLUDE' and len(toks) > 1:
                walk(toks[1], seen)
            elif toks[0].upper() == 'TRANSFORMINGBODYPART':
                for t in toks[1:]:  # the CFG isn't always last (e.g. "... chars/X.cfg Ranged")
                    if t.lower().endswith('.cfg'):
                        parts.add(t.replace('\\', '/').lower())

    for inc in includes:
        walk(inc, set())
    return len(includes) + len(parts)


def plan_master(g, root):
    path = os.path.join(root, 'CHARS', 'CREATURES.CFG')
    raw = read(path)
    text = strip_ours(raw)
    inc = active_includes(text.splitlines())
    have = {base_name(i) for i in inc}
    wanted = MASTER_ADDITIONS if WITH_RATCHET else []
    missing = [m for m in wanted if m.lower() not in have and g.find('chars/%s.cfg' % m)]
    before = count_types(g, inc)
    after = count_types(g, inc + ['chars/%s.cfg' % m for m in missing])
    return dict(path=path, raw=raw, text=text, missing=missing, before=before, after=after)


def apply_master(p):
    nl = '\r\n'
    if not p['missing']:  # nothing to add: just take out a block an earlier run added
        if p['raw'] != p['text']:
            write(p['path'], p['text'])
        return
    block = [MARK_BEGIN, '; Ratchet (Playable Ratchet mod). The type table now has %d of %d slots.' % (p['after'], MAX_TYPES)]
    block += ['INCLUDE chars/%s.cfg' % m for m in p['missing']]
    block.append(MARK_END)
    if not os.path.isfile(p['path'] + BACKUP):
        shutil.copy2(p['path'], p['path'] + BACKUP)
    write(p['path'], p['text'].rstrip('\r\n') + nl + nl + nl.join(block) + nl)

CACHE_RE = re.compile(r'^(\s*CREATURECACHESIZE_KB\s+)(\d+)(.*)$', re.I)


def base_name(inc):
    return os.path.splitext(inc.replace('\\', '/').split('/')[-1])[0].lower()


def read(path):
    with open(path, 'r', encoding='latin-1', newline='') as f:
        return f.read()


def write(path, text):
    with open(path, 'w', encoding='latin-1', newline='') as f:
        f.write(text)


def strip_ours(text):
    """Removes a block a previous run added, so the script can be re-run."""
    i = text.find(MARK_BEGIN)
    if i < 0:
        return text
    j = text.find(MARK_END, i)
    j = len(text) if j < 0 else j + len(MARK_END)
    return text[:i].rstrip('\r\n') + '\r\n' + text[j:].lstrip('\r\n')


def plan_level(g, folder):
    cre_p = os.path.join(folder, 'CREATURES.CFG')
    lvl_p = os.path.join(folder, 'LEVEL.CFG')
    # Build on the current files (other mods may have edited them), minus anything a previous run added.
    cre = strip_ours(read(cre_p))
    lvl = read(lvl_p)
    have = {base_name(i) for i in active_includes(cre.splitlines())}
    added, added_kb = [], 0.0
    for fam, files in FAMILIES:
        if fam in OPT_IN_FAMILIES and not WITH_RATCHET:
            continue
        missing = [f for f in files if f.lower() not in have]
        if missing:
            added.append((fam, missing))
            added_kb += sum(g.cost_kb('chars/%s.cfg' % f) for f in missing)
    cache_line = None
    for ln in lvl.splitlines():
        m = CACHE_RE.match(ln)
        if m:
            cache_line = m
            break
    old_cache = None
    if cache_line:
        prev = re.search(r'AllCharacters \(was (\d+)\)', cache_line.group(3))
        old_cache = int(prev.group(1)) if prev else int(cache_line.group(2))
    new_cache = None
    if old_cache is not None and added:
        new_cache = int(math.ceil((old_cache + CACHE_FACTOR * added_kb) / 100.0) * 100)
    return dict(cre_p=cre_p, lvl_p=lvl_p, cre=cre, lvl=lvl, added=added, added_kb=added_kb,
                old_cache=old_cache, new_cache=new_cache)


def apply_level(p):
    nl = '\r\n'
    block = [MARK_BEGIN]
    for fam, files in p['added']:
        block.append('; %s' % fam)
        block += ['INCLUDE chars/%s.cfg' % f for f in files]
    block.append(MARK_END)
    cre = p['cre'].rstrip('\r\n') + nl + nl + nl.join(block) + nl
    lvl_lines = p['lvl'].split('\n')
    for i, ln in enumerate(lvl_lines):
        m = CACHE_RE.match(ln.rstrip('\r'))
        if m:
            cr = '\r' if ln.endswith('\r') else ''
            rest = re.sub(r'\s*; AllCharacters \(was \d+\)', '', m.group(3))  # drop notes from earlier runs
            lvl_lines[i] = '%s%d\t; AllCharacters (was %d)%s%s' % (m.group(1), p['new_cache'], p['old_cache'],
                                                                 rest, cr)
            break
    for path in (p['cre_p'], p['lvl_p']):
        if not os.path.isfile(path + BACKUP):
            shutil.copy2(path, path + BACKUP)
    write(p['cre_p'], cre)
    write(p['lvl_p'], '\n'.join(lvl_lines))


def restore(root):
    n = 0
    for dp, _, fns in list(os.walk(os.path.join(root, 'LEVELS'))) + [(os.path.join(root, 'CHARS'), [], os.listdir(os.path.join(root, 'CHARS')))]:
        for fn in fns:
            if fn.lower() in ('creatures.cfg' + BACKUP, 'level.cfg' + BACKUP):
                src = os.path.join(dp, fn)
                shutil.copy2(src, src[:-len(BACKUP)])
                os.remove(src)
                n += 1
    print('restored %d files' % n)


def main():
    root = sys.argv[1]
    mode = sys.argv[2] if len(sys.argv) > 2 else ''
    if mode == '--restore':
        restore(root)
        return
    g = Game(root)
    mp = plan_master(g, root)
    print('master CHARS\\CREATURES.CFG: %d types now, %d with %s (limit %d)' % (
        mp['before'], mp['after'], ', '.join(mp['missing']) or 'nothing to add', MAX_TYPES))
    if mp['missing']:
        if mp['before'] != EXPECTED_VANILLA_TYPES and not os.path.isfile(mp['path'] + BACKUP):
            print('  STOP: expected %d types before adding (measured in game); counted %d. Not editing.' % (
                EXPECTED_VANILLA_TYPES, mp['before']))
            return
        if mp['after'] > MAX_TYPES:
            print('  STOP: that would overflow the %d-slot type table. Not editing.' % MAX_TYPES)
            return
        if mode == '--apply':
            apply_master(mp)
    elif mode == '--apply':
        apply_master(mp)  # removes Ratchet if an earlier --with-ratchet run added him
    lv = os.path.join(root, 'LEVELS')
    total = 0
    for name in sorted(os.listdir(lv)):
        folder = os.path.join(lv, name)
        if not (os.path.isfile(os.path.join(folder, 'CREATURES.CFG')) and os.path.isfile(os.path.join(folder, 'LEVEL.CFG'))):
            continue
        p = plan_level(g, folder)
        if not p['added']:
            print('%-22s already has every robot' % name)
            continue
        if p['old_cache'] is None:
            print('%-22s SKIPPED: no CREATURECACHESIZE_KB line in LEVEL.CFG' % name)
            continue
        fams = ', '.join(f for f, _ in p['added'])
        n_files = sum(len(fl) for _, fl in p['added'])
        print('%-22s +%2d files (%5.0f KB)  cache %5d -> %5d KB  | %s' % (
            name, n_files, p['added_kb'], p['old_cache'], p['new_cache'], fams))
        total += 1
        if mode == '--apply':
            apply_level(p)
    print('%d levels %s' % (total, 'edited' if mode == '--apply' else 'would change (dry run; add --apply)'))


if __name__ == '__main__':
    main()
