import struct, zlib

p = r"D:\CHINESE\CHAT-TRANSLATOR\_card_mock\shot.png"
d = open(p, "rb").read()
w, h = struct.unpack(">II", d[16:24])
color_type = d[25]
idat = b""
i = 8
while i < len(d):
    ln = struct.unpack(">I", d[i:i+4])[0]; typ = d[i+4:i+8]; data = d[i+8:i+8+ln]
    if typ == b"IDAT": idat += data
    i += 12 + ln
raw = zlib.decompress(idat)
channels = {0:1,2:3,3:1,4:2,6:4}[color_type]; stride = w*channels
def paeth(a,b,c):
    p=a+b-c; pa,pb,pc=abs(p-a),abs(p-b),abs(p-c)
    return a if (pa<=pb and pa<=pc) else (b if pb<=pc else c)
out=bytearray(); prev=bytearray(stride); pos=0
for y in range(h):
    f=raw[pos]; pos+=1; line=bytearray(raw[pos:pos+stride]); pos+=stride
    for x in range(stride):
        a=line[x-channels] if x>=channels else 0; b=prev[x]; c=prev[x-channels] if x>=channels else 0
        if f==1: line[x]=(line[x]+a)&255
        elif f==2: line[x]=(line[x]+b)&255
        elif f==3: line[x]=(line[x]+((a+b)>>1))&255
        elif f==4: line[x]=(line[x]+paeth(a,b,c))&255
    out+=line; prev=line
def px(x,y):
    o=y*stride+x*channels
    return (out[o],out[o+1],out[o+2])

# locate paper-hi (card body) horizontal span at y=560
y=560
run=[]
for x in range(w):
    r,g,b=px(x,y)
    if abs(r-244)<6 and abs(g-244)<6 and abs(b-248)<6: run.append(x)
print("paper-hi span at y=560:", (run[0],run[-1]) if run else "none", "count", len(run))

# scan for avatar photo (skin-ish) in x[270..315] y[520..760]
def skin(r,g,b):
    return 140<r<245 and 90<g<205 and 60<b<185 and (r-g)>25 and (r-b)>35
found=[]
for y in range(520,760):
    for x in range(270,316):
        r,g,b=px(x,y)
        if skin(r,g,b):
            found.append((x,y))
if found:
    xs=[p[0] for p in found]; ys=[p[1] for p in found]
    print("AVATAR photo pixels:", len(found), "x",(min(xs),max(xs)),"y",(min(ys),max(ys)))
    print("sample avatar px:", px((min(xs)+max(xs))//2,(min(ys)+max(ys))//2))
else:
    print("NO avatar photo pixels found in window")
