# CameraDumps

`dumpdiff.py` reads the F8 camera dumps written by `CharacterCams.asi` (or the older `TripleCFlightCam.asi`) and
compares two of them field by field. See `notes/CAMERA_FIX_GUIDE.md` for the method and what the fields mean.

```bash
python dumpdiff.py CharacterCams_dump_id3_1.bin CharacterCams_dump_id14_2.bin -s preset
```

Python 3, no extra packages. Blender's bundled Python works if you don't have Python installed.
