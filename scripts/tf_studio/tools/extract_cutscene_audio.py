"""Pull the soundtrack out of the game's cutscene videos (fmv\\MultiLang\\*.bik) for TF Studio's cutscene player.

The game plays its story cutscenes as Bink videos rendered from the CUT\\*.CU2 scenes, so the sound (voices, music,
effects) only exists inside those videos. Browsers can't decode Bink, so this writes each video's audio to
mods\\tf_studio\\cutscene_audio\\<NAME>.ogg once, plus index.json with every length.

Run it with Blender (its built-in FFmpeg reads Bink audio); "Extract cutscene audio.bat" does this:
    blender -b --factory-startup --python extract_cutscene_audio.py -- <fmv folder> [--all]
Without --all only videos named like a .CU2 cutscene are converted. Existing .ogg files are kept.
"""
import json
import os
import sys

import aud

HERE = os.path.dirname(os.path.abspath(__file__))
STUDIO = os.path.dirname(HERE)
GAME = os.path.dirname(os.path.dirname(STUDIO))
OUT = os.path.join(STUDIO, 'cutscene_audio')


def video_name(cut):
    """The video a cutscene was rendered to: A5_CH3_OUTRO -> auto5_ch3_outro, D5_.. / DECEPT6_.. -> dcpt5_.. / dcpt6_..
    (the short names are copies of the long ones: same length, characters and objects).
    The same rule is in js/cutscene_view.js."""
    import re
    n = cut.lower()
    n = re.sub(r'^a(\d)_', r'auto\1_', n)
    n = re.sub(r'^d(\d)_', r'dcpt\1_', n)
    n = re.sub(r'^decept', 'dcpt', n)
    n = re.sub(r'_2$', '', n)  # AUTO3_CH1_MIDTRO1_2: an alternate take of the same scene (same length)
    return 'tt_logo' if n == 'ttident' else n


def cutscene_names():
    names = set()
    for root, dirs, files in os.walk(GAME):
        if root == GAME:
            dirs[:] = [d for d in dirs if d.lower() not in ('mods', 'ps3 assets')]
        for f in files:
            if f.lower().endswith('.cu2'):
                names.add(video_name(f[:-4]))
    return names


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if not args:
        print(__doc__)
        sys.exit(1)
    src, every = args[0], '--all' in args
    if not os.path.isdir(src):
        sys.exit('not a folder: %s' % src)
    os.makedirs(OUT, exist_ok=True)
    wanted = None if every else cutscene_names()
    index_path = os.path.join(OUT, 'index.json')
    try:
        index = json.load(open(index_path))
    except (OSError, ValueError):
        index = {}
    done = skipped = failed = 0
    for f in sorted(os.listdir(src)):
        if not f.lower().endswith('.bik'):
            continue
        name = f[:-4].lower()
        if wanted is not None and name not in wanted:
            continue
        out = os.path.join(OUT, name.upper() + '.ogg')
        try:
            snd = aud.Sound(os.path.join(src, f))
            rate, ch = snd.specs
            secs = snd.length / rate
            if not os.path.exists(out):
                snd.write(out, rate=int(rate), channels=aud.CHANNELS_STEREO if ch >= 2 else aud.CHANNELS_MONO,
                          format=aud.FORMAT_S16, container=aud.CONTAINER_OGG, codec=aud.CODEC_VORBIS, bitrate=128000)
                done += 1
            else:
                skipped += 1
            index[name.upper()] = {'file': name.upper() + '.ogg', 'seconds': round(secs, 4), 'rate': rate,
                                   'channels': ch, 'source': f}
            print('%-28s %7.2f s' % (f, secs))
        except Exception as e:  # one bad video must not stop the rest
            failed += 1
            print('%-28s FAILED: %s' % (f, e))
    with open(index_path, 'w') as fh:
        json.dump(index, fh, indent=1, sort_keys=True)
    print('converted %d, already there %d, failed %d -> %s' % (done, skipped, failed, OUT))


main()
