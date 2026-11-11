#!/usr/bin/env python3
"""Sklada ikony aplikacji ze zrodlowych SVG. Wymaga: python3, rsvg-convert, iconutil (macOS).

Uzycie z katalogu glownego repozytorium:  python3 resources/icons/src/build.py

Wybrany wariant to v1 (okragle S, ciezkie). Od 32 px w dol uzywana jest wersja mala
(grubsza kreska, wiekszy znak), bo normalna zlewa sie w 16 px.
"""
import os, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.dirname(HERE)
VARIANT = "v1"
SMALL_UP_TO = 32  # rozmiary w pikselach, dla ktorych uzywamy wersji malej


def svg(shape, px):
    name = f"{VARIANT}-{shape}" + ("-small" if px <= SMALL_UP_TO else "") + ".svg"
    return os.path.join(HERE, name)


def render(shape, px, out):
    subprocess.run(["rsvg-convert", "-w", str(px), "-h", str(px), svg(shape, px), "-o", out], check=True)


def main():
    subprocess.run([sys.executable, os.path.join(HERE, "make.py"), HERE], check=True)

    # macOS: .icns z .iconset (ksztalt zaokraglony, margines wg siatki Big Sur).
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for base in (16, 32, 128, 256, 512):
            render("macos", base, os.path.join(iconset, f"icon_{base}x{base}.png"))
            render("macos", base * 2, os.path.join(iconset, f"icon_{base}x{base}@2x.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(ICONS, "icon.icns")], check=True)

        # Windows: .ico z PNG (ksztalt plaski, pelny kwadrat).
        sizes = [16, 24, 32, 48, 64, 128, 256]
        blobs = []
        for px in sizes:
            p = os.path.join(tmp, f"w{px}.png")
            render("flat", px, p)
            blobs.append(open(p, "rb").read())
        header = struct.pack("<HHH", 0, 1, len(sizes))
        offset = 6 + 16 * len(sizes)
        entries = b""
        for px, data in zip(sizes, blobs):
            dim = 0 if px >= 256 else px
            entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
            offset += len(data)
        with open(os.path.join(ICONS, "icon.ico"), "wb") as fh:
            fh.write(header + entries + b"".join(blobs))

    # Linux: zestaw rozmiarow (plaski) i icon.png 512 dla okna aplikacji.
    linux = os.path.join(ICONS, "linux")
    os.makedirs(linux, exist_ok=True)
    for px in (16, 24, 32, 48, 64, 128, 256, 512):
        render("flat", px, os.path.join(linux, f"{px}x{px}.png"))
    render("flat", 512, os.path.join(ICONS, "icon.png"))
    # Kopia dla okna aplikacji: renderer trafia do asara, a resources/ nie.
    window_dir = os.path.join(ICONS, "..", "..", "src", "renderer", "assets", "icons")
    os.makedirs(window_dir, exist_ok=True)
    render("flat", 512, os.path.join(window_dir, "app-icon.png"))


if __name__ == "__main__":
    main()
