import math, os, sys
OUT = sys.argv[1]
COBALT = "#7F9FFF"   # cobalt-300, docs/DESIGN.md
BG = "#000000"

def f(v): return ("%.2f" % v).rstrip("0").rstrip(".")

def glyph_A(x0, x1, yt, yb, w):
    xc = (x0 + x1) / 2
    half = (x1 - x0) / 2
    # horizontal width of a leg of perpendicular thickness w
    H = yb - yt
    theta = math.atan2(half - w * 0.0, H)  # centreline slope approx
    wh = w / math.cos(math.atan2(half - w / 2, H))
    L = [(x0, yb), (x0 + wh, yb), (xc + wh / 2, yt), (xc - wh / 2, yt)]
    R = [(x1, yb), (x1 - wh, yb), (xc - wh / 2, yt), (xc + wh / 2, yt)]
    # same winding for both: reorder R to match L (clockwise on screen)
    R = [(x1 - wh, yb), (x1, yb), (xc + wh / 2, yt), (xc - wh / 2, yt)]
    # crossbar between leg centrelines
    yc = yb - 0.30 * H
    t = (yb - yc) / H
    xl = (x0 + wh / 2) + t * (xc - (x0 + wh / 2))
    xr = (x1 - wh / 2) - t * ((x1 - wh / 2) - xc)
    bar = [(xl - 2, yc - w / 2), (xr + 2, yc - w / 2), (xr + 2, yc + w / 2), (xl - 2, yc + w / 2)]
    # order everything the same way (clockwise on screen) so nonzero fill = union
    def cw(p):
        a = sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))
        return p if a > 0 else p[::-1]
    d = ""
    for poly in (L, R, bar):
        poly = cw(poly)
        d += "M" + " L".join(f(x) + " " + f(y) for x, y in poly) + "Z "
    return d.strip()

def glyph_S_round(x0, x1, yt, yb, w, term=25):
    cx = (x0 + x1) / 2
    rx = (x1 - x0) / 2
    H = yb - yt
    ry = (H + w) / 4
    def pt(cxx, cyy, rxx, ryy, deg):
        a = math.radians(deg)
        return cxx + rxx * math.cos(a), cyy - ryy * math.sin(a)
    # top bowl: centre y, outer 30deg..270deg ccw
    cyt = yt + ry
    ox1 = pt(cx, cyt, rx, ry, term); ox2 = pt(cx, cyt, rx, ry, 270)
    ix2 = pt(cx, cyt, rx - w, ry - w, 270); ix1 = pt(cx, cyt, rx - w, ry - w, term)
    top = ("M%s %s A%s %s 0 1 0 %s %s L%s %s A%s %s 0 1 1 %s %s Z" % (
        f(ox1[0]), f(ox1[1]), f(rx), f(ry), f(ox2[0]), f(ox2[1]),
        f(ix2[0]), f(ix2[1]), f(rx - w), f(ry - w), f(ix1[0]), f(ix1[1])))
    cyb = yb - ry
    ang1, ang2 = 90, -180 + term
    ox1 = pt(cx, cyb, rx, ry, ang1); ox2 = pt(cx, cyb, rx, ry, ang2)
    ix2 = pt(cx, cyb, rx - w, ry - w, ang2); ix1 = pt(cx, cyb, rx - w, ry - w, ang1)
    bot = ("M%s %s A%s %s 0 1 1 %s %s L%s %s A%s %s 0 1 0 %s %s Z" % (
        f(ox1[0]), f(ox1[1]), f(rx), f(ry), f(ox2[0]), f(ox2[1]),
        f(ix2[0]), f(ix2[1]), f(rx - w), f(ry - w), f(ix1[0]), f(ix1[1])))
    return top + " " + bot

def glyph_S_square(x0, x1, yt, yb, w, ch=None):
    ch = ch if ch is not None else w * 0.9
    ym = (yt + yb) / 2
    P = [(x0 + ch, yt), (x1, yt), (x1, yt + w), (x0 + w, yt + w), (x0 + w, ym - w / 2),
         (x1, ym - w / 2), (x1, yb - ch), (x1 - ch, yb), (x0, yb), (x0, yb - w),
         (x1 - w, yb - w), (x1 - w, ym + w / 2), (x0, ym + w / 2), (x0, yt + ch)]
    return "M" + " L".join(f(x) + " " + f(y) for x, y in P) + "Z"

# name: (H, w, A width, S width, gap, S builder)
CUTS = {
 "v1": dict(H=390, w=66, aw=320, sw=270, gap=34, s=glyph_S_round),
 "v2": dict(H=390, w=66, aw=320, sw=270, gap=34, s=glyph_S_square),
 "v3": dict(H=420, w=44, aw=340, sw=280, gap=52, s=glyph_S_round),
}
SMALL = {
 "v1": dict(H=450, w=92, aw=350, sw=300, gap=24, s=glyph_S_round),
 "v2": dict(H=450, w=92, aw=350, sw=300, gap=24, s=glyph_S_square),
 "v3": dict(H=450, w=84, aw=350, sw=300, gap=28, s=glyph_S_round),
}

def squircle(n=5.0, half=412.0, cx=512.0, cy=512.0, steps=360):
    """Cialo ikony macOS 824x824: superelipsa |x|^n + |y|^n = r^n, n = 5.
    Przyblizenie ciaglego naroza Apple (zwykly zaokraglony prostokat ma ostrzejsze przejscie)."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, sn = math.cos(t), math.sin(t)
        x = cx + half * math.copysign(abs(c) ** (2 / n), c)
        y = cy + half * math.copysign(abs(sn) ** (2 / n), sn)
        pts.append((x, y))
    return "M" + " L".join(f(x) + " " + f(y) for x, y in pts) + "Z"

def build(name, cut, shape, scale=1.0):
    c = cut
    total = c["aw"] + c["gap"] + c["sw"]
    xs = 512 - total / 2
    yt = 512 - c["H"] / 2; yb = 512 + c["H"] / 2
    A = glyph_A(xs, xs + c["aw"], yt, yb, c["w"])
    S = c["s"](xs + c["aw"] + c["gap"], xs + total, yt, yb, c["w"])
    if shape == "macos":
        bg = '<path fill="%s" d="%s"/>' % (BG, squircle())
        g = ""
        tr = ""
    else:
        bg = '<rect width="1024" height="1024" fill="%s"/>' % BG
        tr = ' transform="translate(512 512) scale(1.12) translate(-512 -512)"'
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n'
           '  <title>Universal AI Skills Manager, monogram AS, %s, %s</title>\n'
           '  %s\n  <path fill="%s" fill-rule="nonzero"%s d="%s %s"/>\n</svg>\n') % (
           name, shape, bg, COBALT, tr, A, S)
    return svg

# Do repozytorium trafia wariant v1 (decyzja wlasciciela). v2 i v3 to odrzucone warianty
# z projektu; ich parametry zostaja w CUTS i SMALL, zeby dalo sie je odtworzyc argumentem.
names = sys.argv[2:] or ["v1"]
for n in names:
    for shape in ("macos", "flat"):
        open(os.path.join(OUT, "%s-%s.svg" % (n, shape)), "w").write(build(n, CUTS[n], shape))
        open(os.path.join(OUT, "%s-%s-small.svg" % (n, shape)), "w").write(build(n, SMALL[n], shape))
print("ok")
