import struct, zlib
p = r"D:\CHINESE\CHAT-TRANSLATOR\_card_mock\shot.png"
d=open(p,"rb").read(); w,h=struct.unpack(">II",d[16:24]); ct=d[25]
idat=b""; i=8
while i<len(d):
    ln=struct.unpack(">I",d[i:i+4])[0]; t=d[i+4:i+8]; dt=d[i+8:i+8+ln]
    if t==b"IDAT": idat+=dt
    i+=12+ln
raw=zlib.decompress(idat); ch={0:1,2:3,3:1,4:2,6:4}[ct]; st=w*ch
def pae(a,b,c):
    p=a+b-c; pa,pb,pc=abs(p-a),abs(p-b),abs(p-c)
    return a if(pa<=pb and pa<=pc) else (b if pb<=pc else c)
o=bytearray(); pr=bytearray(st); pos=0
for y in range(h):
    f=raw[pos]; pos+=1; ln=bytearray(raw[pos:pos+st]); pos+=st
    for x in range(st):
        a=ln[x-ch] if x>=ch else 0; b=pr[x]; c=pr[x-ch] if x>=ch else 0
        if f==1: ln[x]=(ln[x]+a)&255
        elif f==2: ln[x]=(ln[x]+b)&255
        elif f==3: ln[x]=(ln[x]+((a+b)>>1))&255
        elif f==4: ln[x]=(ln[x]+pae(a,b,c))&255
    o+=ln; pr=ln
def px(x,y):
    q=y*st+x*ch; return (o[q],o[q+1],o[q+2])
for y in range(500,770,12):
    cols=[px(x,y) for x in (280,291,310,360,435)]
    print(f"y={y:4d}  x280={cols[0]}  x291={cols[1]}  x310={cols[2]}  x360={cols[3]}  x435={cols[4]}")
