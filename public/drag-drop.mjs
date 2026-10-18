const inside=(r,p,padding=0)=>p.x>=r.left-padding&&p.x<=r.right+padding&&p.y>=r.top-padding&&p.y<=r.bottom+padding;
const center=r=>({x:(r.left+r.right)/2,y:(r.top+r.bottom)/2});

export function dragFootprint(point,offset,size){
  const left=point.x-offset.x,top=point.y-offset.y;
  return {left,top,right:left+size.width,bottom:top+size.height};
}

// Accept the card when more than half of its visible body is inside a panel.
// The original grab position never changes which panel receives the card.
export function dropZone(footprint,editor,palette){
  if(!footprint)return null;
  const area=(footprint.right-footprint.left)*(footprint.bottom-footprint.top);
  if(!Number.isFinite(area)||area<=0)return null;
  const zones=[['editor',editor],['palette',palette]].filter(([,rect])=>rect);
  // Pointer coordinates can be rounded to float32 by the browser. Ignore that
  // subpixel noise so an exactly half-covered card does not flicker into a zone.
  let result=null,largest=area*(.5+1e-6);
  for(const [name,r] of zones){
    const overlap=Math.max(0,Math.min(r.right,footprint.right)-Math.max(r.left,footprint.left))*Math.max(0,Math.min(r.bottom,footprint.bottom)-Math.max(r.top,footprint.top));
    if(overlap>largest){largest=overlap;result=name;}
  }
  return result;
}

// Return an insertion boundary in the original array. This avoids direction-
// dependent splice behavior when moving a node toward the start or the end.
export function insertionAt(point,footprint,nodes,{layout='vertical',sourceId=null,previous=null,hysteresis=10}={}){
  if(!nodes.length)return null;
  const probe=footprint?center(footprint):point;
  const hit=nodes.find(node=>inside(node.rect,probe));
  let target=hit;
  if(!target)target=nodes.reduce((best,node)=>{
    const p=center(node.rect),b=center(best.rect);
    return Math.hypot(probe.x-p.x,probe.y-p.y)<Math.hypot(probe.x-b.x,probe.y-b.y)?node:best;
  });
  const index=nodes.indexOf(target),mid=center(target.rect),sourceIndex=nodes.findIndex(node=>node.id===sourceId);
  let axis='y',direction=1;
  if(layout==='snake'){
    const neighbor=nodes[index+1]&&Math.abs(center(nodes[index+1].rect).y-mid.y)<2?nodes[index+1]:nodes[index-1]&&Math.abs(center(nodes[index-1].rect).y-mid.y)<2?nodes[index-1]:null;
    if(neighbor){axis='x';direction=Math.sign((center(neighbor.rect).x-mid.x)*(nodes.indexOf(neighbor)>index?1:-1))||1;}
  }
  const delta=(probe[axis]-mid[axis])*direction;
  let after=Math.abs(delta)<1&&sourceIndex>=0?sourceIndex<index:delta>=0;
  // Keep the chosen half until the body center clearly crosses the midline.
  // A new target starts fresh, so a distant previous snap cannot hold it back.
  const margin=Number.isFinite(hysteresis)?Math.max(0,hysteresis):10;
  if(previous?.targetId===target.id&&previous.axis===axis&&previous.direction===direction&&
    (previous.side==='before'||previous.side==='after')&&Math.abs(delta)<=margin)after=previous.side==='after';
  // Returning over the original block always means leaving it in place.
  if(target.id===sourceId)after=true;
  // Start and end are fixed terminals; their available sides face the program.
  const boundary=Math.max(1,Math.min(index+(after?1:0),nodes.length-1));
  return {index:boundary,targetId:target.id,side:boundary>index?'after':'before',axis,direction};
}

export function movedInsertionIndex(from,boundary,length){
  return Math.max(1,Math.min(boundary-(from<boundary?1:0),length-2));
}
