"""Estimate how much creature-cache memory each CREATURES.CFG entry needs, from the files its CFG chain loads.

Used by make_all_characters.py. Run on its own to print per-level numbers:
    python creature_cost.py "<game folder>"
"""
import os
import re
import sys

ASSET_EXT = ('.ghg', '.an3', '.cu2', '.ats', '.ptl')


class Game:
    def __init__(self, root):
        self.root = root
        self._index = {}
        for dp, _, fns in os.walk(root):
            for fn in fns:
                rel = os.path.relpath(os.path.join(dp, fn), root).replace('\\', '/').lower()
                self._index[rel] = os.path.join(dp, fn)
        self._cost_cache = {}

    def find(self, rel):
        return self._index.get(rel.replace('\\', '/').lower().lstrip('./'))

    def read_lines(self, rel):
        p = self.find(rel)
        if not p:
            return None
        with open(p, 'r', encoding='latin-1') as f:
            return [ln.split(';', 1)[0].strip() for ln in f]

    def assets(self, rel, seen=None, path=''):
        """Set of asset files a CFG (and everything it includes) references."""
        seen = set() if seen is None else seen
        key = rel.replace('\\', '/').lower()
        if key in seen:
            return set()
        seen.add(key)
        lines = self.read_lines(rel)
        out = set()
        if lines is None:
            return out
        for ln in lines:
            if not ln:
                continue
            toks = ln.split()
            kw = toks[0].upper()
            if kw == 'PATH' and len(toks) > 1:
                path = toks[1]
            elif kw == 'INCLUDE' and len(toks) > 1:
                out |= self.assets(toks[1], seen, path)
            elif kw == 'TRANSFORMINGBODYPART':
                for t in toks[1:]:  # the CFG isn't always last (e.g. "... chars/X.cfg Ranged")
                    if t.lower().endswith('.cfg'):
                        out |= self.assets(t, seen, '')
            for t in toks[1:]:
                if t.lower().endswith(ASSET_EXT):
                    p = self.find(path + '/' + t) or self.find(t)
                    if p:
                        out.add(p)
        return out

    def cost_kb(self, cfg_rel):
        k = cfg_rel.lower()
        if k not in self._cost_cache:
            self._cost_cache[k] = sum(os.path.getsize(p) for p in self.assets(cfg_rel)) / 1024.0
        return self._cost_cache[k]


def active_includes(lines, platform='CURRGEN'):
    """INCLUDE targets a PC (CURRGEN) build reads, honouring PLATFORM blocks and comments."""
    out, block = [], None
    for raw in lines:
        ln = raw.split(';', 1)[0].strip()
        if not ln:
            continue
        toks = ln.split()
        kw = toks[0].upper()
        if kw == 'PLATFORM':
            block = toks[1].upper() if len(toks) > 1 else None
        elif kw == 'ENDPLATFORM':
            block = None
        elif kw == 'INCLUDE' and len(toks) > 1 and block in (None, platform):
            out.append(toks[1])
    return out


def level_cache_kb(level_cfg_lines):
    for ln in level_cfg_lines:
        m = re.match(r'\s*CREATURECACHESIZE_KB\s+(\d+)', ln, re.I)
        if m:
            return int(m.group(1))
    return None


def main(root):
    g = Game(root)
    lv = os.path.join(root, 'LEVELS')
    for name in sorted(os.listdir(lv)):
        cre = os.path.join(lv, name, 'CREATURES.CFG')
        lvl = os.path.join(lv, name, 'LEVEL.CFG')
        if not (os.path.isfile(cre) and os.path.isfile(lvl)):
            continue
        with open(cre, encoding='latin-1') as f:
            inc = active_includes(f.readlines())
        with open(lvl, encoding='latin-1') as f:
            cache = level_cache_kb(f.readlines())
        disk = sum(g.cost_kb(i) for i in inc)
        print('%-22s includes=%3d  disk=%8.0f KB  cache=%6s KB  ratio=%s' % (
            name, len(inc), disk, cache, ('%.2f' % (cache / disk)) if cache and disk else '-'))


if __name__ == '__main__':
    main(sys.argv[1])
