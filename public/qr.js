// Offline QR Code Model 2 encoder, byte mode, error correction L, versions 1–10.
// ISO/IEC 18004 algorithms; no external library, asset or network dependency.
const BLOCKS=[null,[[1,26,19]],[[1,44,34]],[[1,70,55]],[[1,100,80]],[[1,134,108]],[[2,86,68]],[[2,98,78]],[[2,121,97]],[[2,146,116]],[[2,86,68],[2,87,69]]];
const ALIGN=[[],[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
const EXP=new Uint8Array(512),LOG=new Uint8Array(256);
for(let i=0,x=1;i<255;i++) {EXP[i]=x;LOG[x]=i;x<<=1;if(x&256)x^=0x11d;}
for(let i=255;i<512;i++)EXP[i]=EXP[i-255];
const multiply=(a,b)=>a&&b?EXP[LOG[a]+LOG[b]]:0;
function parity(data,length) {
  let generator=[1];
  for(let i=0;i<length;i++) {
    const next=Array(generator.length+1).fill(0);
    generator.forEach((value,j)=>{next[j]^=value;next[j+1]^=multiply(value,EXP[i]);});
    generator=next;
  }
  const remainder=[...data,...Array(length).fill(0)];
  for(let i=0;i<data.length;i++) {
    const coefficient=remainder[i];
    if(coefficient) for(let j=0;j<generator.length;j++)remainder[i+j]^=multiply(generator[j],coefficient);
  }
  return remainder.slice(data.length);
}
function codewords(bytes,version) {
  const blocks=BLOCKS[version].flatMap(([count,total,data])=>Array.from({length:count},()=>({total,data})));
  const capacity=blocks.reduce((sum,b)=>sum+b.data,0),bits=[];
  const append=(value,length)=>{for(let i=length-1;i>=0;i--)bits.push((value>>>i)&1);};
  append(4,4);append(bytes.length,version<10?8:16);
  for(const byte of bytes)append(byte,8);
  append(0,Math.min(4,capacity*8-bits.length));
  while(bits.length%8)bits.push(0);
  const data=[];
  for(let i=0;i<bits.length;i+=8)data.push(bits.slice(i,i+8).reduce((v,b)=>(v<<1)|b,0));
  for(let pad=0;data.length<capacity;pad++)data.push(pad%2?0x11:0xec);
  let offset=0;
  const chunks=blocks.map(block=>{const d=data.slice(offset,offset+=block.data);return {data:d,ecc:parity(d,block.total-block.data)};});
  const result=[];
  for(const field of ['data','ecc']) for(let i=0;i<Math.max(...chunks.map(c=>c[field].length));i++)for(const chunk of chunks)if(i<chunk[field].length)result.push(chunk[field][i]);
  return result;
}
function matrix(version,words,mask) {
  const size=version*4+17,modules=Array.from({length:size},()=>Array(size).fill(false)),reserved=Array.from({length:size},()=>Array(size).fill(false));
  const set=(x,y,value)=>{if(x>=0&&x<size&&y>=0&&y<size){modules[y][x]=!!value;reserved[y][x]=true;}};
  for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0);}
  for(const [cx,cy] of [[3,3],[size-4,3],[3,size-4]])for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++) {
    const distance=Math.max(Math.abs(dx),Math.abs(dy));set(cx+dx,cy+dy,distance!==2&&distance!==4);
  }
  for(const y of ALIGN[version])for(const x of ALIGN[version]) {
    if((x===6&&y===6)||(x===6&&y===size-7)||(x===size-7&&y===6))continue;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(x+dx,y+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);
  }
  const data=(1<<3)|mask;let remainder=data;
  for(let i=0;i<10;i++)remainder=(remainder<<1)^((remainder>>>9)*0x537);
  const format=((data<<10)|remainder)^0x5412;
  const bit=(value,index)=>((value>>>index)&1)!==0;
  for(let i=0;i<=5;i++)set(8,i,bit(format,i));
  set(8,7,bit(format,6));set(8,8,bit(format,7));set(7,8,bit(format,8));
  for(let i=9;i<15;i++)set(14-i,8,bit(format,i));
  for(let i=0;i<8;i++)set(size-1-i,8,bit(format,i));
  for(let i=8;i<15;i++)set(8,size-15+i,bit(format,i));
  set(8,size-8,true);
  if(version>=7) {
    let rem=version;
    for(let i=0;i<12;i++)rem=(rem<<1)^((rem>>>11)*0x1f25);
    const bits=(version<<12)|rem;
    for(let i=0;i<18;i++){const a=size-11+i%3,b=Math.floor(i/3);set(a,b,bit(bits,i));set(b,a,bit(bits,i));}
  }
  const masked=(x,y)=>[
    (x+y)%2===0,y%2===0,x%3===0,(x+y)%3===0,
    (Math.floor(y/2)+Math.floor(x/3))%2===0,
    x*y%2+x*y%3===0,(x*y%2+x*y%3)%2===0,((x+y)%2+x*y%3)%2===0
  ][mask];
  let index=0;
  for(let right=size-1;right>=1;right-=2) {
    if(right===6)right=5;
    for(let vertical=0;vertical<size;vertical++) {
      const up=((right+1)&2)===0,y=up?size-1-vertical:vertical;
      for(let j=0;j<2;j++) {
        const x=right-j;if(reserved[y][x])continue;
        const value=index<words.length*8?bit(words[index>>>3],7-(index&7)):false;
        modules[y][x]=value!==masked(x,y);index++;
      }
    }
  }
  return modules;
}
function penalty(m) {
  const size=m.length;let score=0,dark=0;
  const linePenalty=line=>{
    let value=line[0],run=1;
    for(let i=1;i<=line.length;i++) {
      if(i<line.length&&line[i]===value)run++;
      else {if(run>=5)score+=run-2;value=line[i];run=1;}
    }
    const text=line.map(b=>b?'1':'0').join('');
    for(let i=0;i<=text.length-11;i++)if(['00001011101','10111010000'].includes(text.slice(i,i+11)))score+=40;
  };
  for(let y=0;y<size;y++) {
    linePenalty(m[y]);linePenalty(m.map(row=>row[y]));
    for(let x=0;x<size;x++) {
      if(m[y][x])dark++;
      if(x+1<size&&y+1<size&&m[y][x]===m[y][x+1]&&m[y][x]===m[y+1][x]&&m[y][x]===m[y+1][x+1])score+=3;
    }
  }
  return score+Math.floor(Math.abs(dark*20-size*size*10)/(size*size))*10;
}
export function qrSvg(text) {
  if(typeof text!=='string')throw new TypeError('二维码内容必须是文字。');
  const bytes=new TextEncoder().encode(text);
  let version;
  for(let v=1;v<=10;v++) {
    const capacity=BLOCKS[v].reduce((sum,[count,,data])=>sum+count*data,0)*8;
    if(4+(v<10?8:16)+bytes.length*8<=capacity){version=v;break;}
  }
  if(!version)throw new RangeError('二维码内容过长，请使用不超过271字节的课堂加入链接。');
  const words=codewords(bytes,version);let best,bestScore=Infinity;
  for(let mask=0;mask<8;mask++) {
    const candidate=matrix(version,words,mask),score=penalty(candidate);
    if(score<bestScore){best=candidate;bestScore=score;}
  }
  const size=best.length+8,path=[];
  for(let y=0;y<best.length;y++)for(let x=0;x<best.length;x++)if(best[y][x])path.push(`M${x+4},${y+4}h1v1h-1z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="扫码加入课堂" viewBox="0 0 ${size} ${size}" width="256" height="256" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="white"/><path d="${path.join('')}" fill="black"/></svg>`;
}
