import struct, zlib, sys

p = r"D:\CHINESE\CHAT-TRANSLATOR\_card_mock\shot.png"
d = open(p, "rb").read()
assert d[:8] == b"\x89PNG\r\n\x1a\n", "not png"
# IHDR
w, h = struct.unpack(">II", d[16:24])
bit_depth = d[24]
color_type = d[25]
print("size", w, h, "bit_depth", bit_depth, "color_type", color_type)

# gather IDAT
idat = b""
i = 8
while i < len(d):
    ln = struct.unpack(">I", d[i:i+4])[0]
    typ = d[i+4:i+8]
    data = d[i+8:i+8+ln]
    if typ == b"IDAT":
        idat += data
    i += 12 + ln

raw = zlib.decompress(idat)
channels = {0:1, 2:3, 3:1, 4:2, 6:4}[color_type]
bpp = channels  # 8-bit
stride = w * bpp

def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
    if pa <= pb and pa <= pc: return a
    if pb <= pc: return b
    return c

out = bytearray()
prev = bytearray(stride)
pos = 0
for y in range(h):
    f = raw[pos]; pos += 1
    line = bytearray(raw[pos:pos+stride]); pos += stride
    for x in range(stride):
        a = line[x-bpp] if x >= bpp else 0
        b = prev[x]
        c = prev[x-bpp] if x >= bpp else 0
        if f == 1: line[x] = (line[x] + a) & 255
        elif f == 2: line[x] = (line[x] + b) & 255
        elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
        elif f == 4: line[x] = (line[x] + paeth(a, b, c)) & 255
    out += line
    prev = line

def px(x, y):
    o = y * stride + x * bpp
    if channels == 4:
        return (out[o], out[o+1], out[o+2], out[o+3])
    return (out[o], out[o+1], out[o+2])

# Sample points
samples = {
    "bg_top_left (expect dark teal)": (70, 400),
    "card_paper_center (expect light)": (435, 520),
    "card_header (expect paper)": (400, 280),
    "eva_avatar_center (expect photo)": (291, 447),
    "eva_avatar_left (expect photo)": (283, 447),
    "eva_avatar_right (expect photo)": (299, 447),
    "card_bottom_eva_log (expect paper)": (435, 1150),
}
for name, (x, y) in samples.items():
    print(name, px(x, y))
