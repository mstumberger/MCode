#!/usr/bin/env python3
"""Regenerate MCode icon assets (requires python3 + Pillow).

Keeps the original icon artwork backgrounds (dark gradient rounded square,
borders, margins) and replaces only the Z glyph with the M glyph at the same
bounding box, then rebuilds the ICO/ICNS containers mirroring the original
chunk structure (ic04/ic05 re-encoded as valid PackBits ARGB, info chunk kept
verbatim). The dmg_background wordmark ("ZCode" -> "MCode") is redrawn the same
way: erase the old band on the flat background and composite the vector
wordmark (M path from packages/ui/src/components/ui/ZCodeAboutLogo.tsx plus the
unchanged C/o/d/e letter paths) rendered at high resolution.

Run from the repository root. Idempotent in effect: re-running on already
converted assets re-detects the (now M) glyph bbox and redraws the same M.
"""
import struct
import io
from PIL import Image, ImageDraw

BUILD = "packages/desktop/build/"

# M glyph polygon in 256x218 space (same geometry as packages/ui ZCodeAboutLogo)
M_POINTS = [(0,0),(84,0),(128,96),(172,0),(256,0),(256,218),(204,218),(204,106),(128,218),(52,106),(52,218),(0,218)]

def bbox_of(im, pred, step=2):
    px = im.load(); w,h = im.size
    xs, ys = [], []
    for y in range(0,h,step):
        for x in range(0,w,step):
            if pred(px[x,y]):
                xs.append(x); ys.append(y)
    if not xs: return None
    return (min(xs), min(ys), max(xs), max(ys))

def inpaint_glyph(im):
    """Erase the white glyph: replace the dilated glyph bbox with a per-row
    vertical-gradient reconstruction of the background."""
    px = im.load(); w,h = im.size
    sq = bbox_of(im, lambda p: p[3] > 40)
    glyph = bbox_of(im, lambda p: p[3] > 100 and p[0] > 190 and p[1] > 190 and p[2] > 190)
    assert sq and glyph, "missing square/glyph"
    D = 26
    gx0 = max(sq[0], glyph[0]-D); gy0 = max(sq[1], glyph[1]-D)
    gx1 = min(sq[2], glyph[2]+D); gy1 = min(sq[3], glyph[3]+D)
    sx0,sy0,sx1,sy1 = sq

    def row_color(y):
        vals = [[],[],[]]
        for x in list(range(sx0+56, gx0-30)) + list(range(gx1+30, sx1-56)):
            if 0 <= x < w:
                p = px[x,y]
                if p[3] > 200 and max(p[0],p[1],p[2]) < 150:
                    for c in range(3): vals[c].append(p[c])
        if not vals[0]: return None
        return tuple(sorted(vals[c])[len(vals[c])//2] for c in range(3))

    rows = {y: c for y in range(sy0, sy1+1) if (c := row_color(y))}
    ys_sorted = sorted(rows)
    model = {y: rows.get(y) or rows[min(ys_sorted, key=lambda yy: abs(yy-y))]
             for y in range(sy0, sy1+1)}
    smoothed = {}
    for y in model:
        win = [model[yy] for yy in range(max(sy0, y-9), min(sy1, y+9)+1)]
        smoothed[y] = tuple(sum(c[i] for c in win)//len(win) for i in range(3))

    for y in range(gy0, gy1+1):
        base = smoothed.get(y, (10,10,10))
        for x in range(gx0, gx1+1):
            if px[x,y][3] > 0:
                px[x,y] = (base[0], base[1], base[2], 255)
    return glyph

def m_mask(size_wh):
    bw, bh = size_wh
    S = 4
    big = Image.new("L", (bw*S, bh*S), 0)
    dr = ImageDraw.Draw(big)
    dr.polygon([(x/256.0*bw*S, y/218.0*bh*S) for x,y in M_POINTS], fill=255)
    return big.resize((bw,bh), Image.LANCZOS)

def draw_m(im, glyph):
    gx0,gy0,gx1,gy1 = glyph
    bw, bh = gx1-gx0+1, gy1-gy0+1
    mask = m_mask((bw,bh))
    out = im.copy(); po = out.load(); ma = mask.load()
    for yy in range(bh):
        for xx in range(bw):
            a = ma[xx,yy]
            if a == 0: continue
            t = a/255.0
            x,y = gx0+xx, gy0+yy
            r,g,b,al = po[x,y]
            po[x,y] = (int(r*(1-t)+255*t), int(g*(1-t)+255*t), int(b*(1-t)+255*t), 255)
    return out

def png_bytes(img):
    b = io.BytesIO(); img.save(b, "PNG", optimize=True); return b.getvalue()

def build_ico(entries):
    n = len(entries)
    head = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16*n
    direntries = b""
    body = b""
    for s, data in entries:
        w = 0 if s >= 256 else s
        direntries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data); body += data
    return head + direntries + body

def packbits_literal(data):
    """Valid all-literal PackBits encoding (uncompressed packets of <=128)."""
    out = bytearray()
    for i in range(0, len(data), 128):
        chunk = data[i:i+128]
        out.append(len(chunk)-1); out.extend(chunk)
    return bytes(out)

def icns_argb_chunk(img):
    px = img.load(); w,h = img.size
    payload = bytearray(b"ARGB") + struct.pack(">II", w, h)
    for y in range(h):
        row = bytearray()
        for x in range(w):
            r,g,b,a = px[x,y]
            row += bytes((a,r,g,b))
        payload += packbits_literal(bytes(row))
    return bytes(payload)

def rebuild_icns(path, pngs):
    with open(path,"rb") as f: d = f.read()
    total = struct.unpack(">I", d[4:8])[0]
    mapping = {"ic04":16, "ic05":32, "ic11":32, "ic12":64, "ic07":128,
               "ic13":256, "ic08":256, "ic14":512, "ic09":512, "ic10":1024}
    out = bytearray(b"icns\x00\x00\x00\x00")
    off = 8
    while off < total:
        typ = d[off:off+4]; ln = struct.unpack(">I", d[off+4:off+8])[0]
        payload = d[off+8:off+ln]
        if typ == b"info":
            out += typ + struct.pack(">I", len(payload)+8) + payload
        else:
            size = mapping[typ.decode()]
            new_payload = (icns_argb_chunk(pngs[size]) if typ.decode() in ("ic04","ic05")
                           else png_bytes(pngs[size]))
            out += typ + struct.pack(">I", len(new_payload)+8) + new_payload
        off += ln
    out[4:8] = struct.pack(">I", len(out))
    with open(path,"wb") as f: f.write(bytes(out))

def main():
    masters = {}
    for name in ["icon.png", "icon_windows.png", "icon_installer.png"]:
        im = Image.open(BUILD+name).convert("RGBA")
        glyph = inpaint_glyph(im)
        new = draw_m(im, glyph)
        new.save(BUILD+name, "PNG", optimize=True)
        masters[name] = new
        print(f"rebuilt {name} (old glyph bbox {glyph})")

    win = masters["icon_windows.png"]
    for s in [16,24,32,48,64,128,256,512,1024]:
        img = win if s == 1024 else win.resize((s,s), Image.LANCZOS)
        img.save(f"{BUILD}icons/{s}x{s}.png", "PNG", optimize=True)
    print("rebuilt hicolor set")

    ico_sizes = [16,24,32,48,64,128,256]
    pngs = {s: (win if s == 1024 else win.resize((s,s), Image.LANCZOS)) for s in set(ico_sizes)}
    with open(BUILD+"icon.ico","wb") as f:
        f.write(build_ico([(s, png_bytes(pngs[s])) for s in ico_sizes]))
    with open(BUILD+"icon_installer.ico","wb") as f:
        inst = masters["icon_installer.png"]
        f.write(build_ico([(256, png_bytes(inst.resize((256,256), Image.LANCZOS)))]))
    print("rebuilt ICOs")

    icns_sizes = [16,32,64,128,256,512,1024]
    rebuild_icns(BUILD+"icon.icns", {s: (win if s==1024 else win.resize((s,s), Image.LANCZOS)) for s in icns_sizes})
    inst_m = masters["icon_installer.png"]
    rebuild_icns(BUILD+"icon_installer.icns", {s: (inst_m if s==1024 else inst_m.resize((s,s), Image.LANCZOS)) for s in icns_sizes})
    print("rebuilt ICNSs")

if __name__ == "__main__":
    main()
