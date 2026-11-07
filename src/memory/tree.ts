import { MemoryReport, MemorySymbol } from './types';
export interface AllocationNode {
  id: string; name: string; label: string; value: number; region: string;
  kind: 'region' | 'library' | 'object' | 'symbol' | 'unattributed' | 'more';
  address?: number; endAddress?: number; symbolId?: string; runtimeAddress?: number; loadAddress?: number;
  children?: AllocationNode[];
}
const shortName = (name: string) => (name.match(/\.a\((.+)\)$/)?.[1] ?? name).replace(/\\/g,'/').split('/').pop()!.replace(/\.(?:obj|o)$/,'');
/** Address-union attribution. Totals reconcile; symbol IDs retain a verified route to ELF bytes. */
export function allocationTree(report: MemoryReport): AllocationNode[] {
  return report.regions.map(region => {
    const rootId = JSON.stringify(['region',region.name]);
    const intervals: {start:number;end:number;symbol:MemorySymbol;object:string;loadAddress?:number}[]=[];
    for (const symbol of report.symbols) {
      if(symbol.alias)continue;
      for(const span of region.spans) {
        if(span.section!==symbol.section)continue;
        const section=report.sections.find(s=>s.name===span.section);
        const loadAddress=section?.load?symbol.address+section.lma-section.vma:undefined;
        const address=span.kind==='load'&&loadAddress!==undefined?loadAddress:symbol.address;
        const start=Math.max(span.start,address),end=Math.min(span.end,address+symbol.size);
        if(end>start)intervals.push({start,end,symbol,loadAddress,object:symbol.object??symbol.source??'Unattributed symbols'});
      }
    }
    intervals.sort((a,b)=>a.start-b.start||a.end-b.end||a.symbol.name.localeCompare(b.symbol.name));
    const objects=new Map<string,Map<string,AllocationNode>>();let covered=-1,total=0;
    for(const interval of intervals){const start=Math.max(covered,interval.start),size=Math.max(0,interval.end-start);covered=Math.max(covered,interval.end);if(!size)continue;
      total+=size;const names=objects.get(interval.object)??new Map<string,AllocationNode>();const old=names.get(interval.symbol.id);
      if(old){old.value+=size;old.endAddress=Math.max(old.endAddress!,interval.end);}else names.set(interval.symbol.id,{id:JSON.stringify([rootId,interval.object,interval.symbol.id]),name:interval.symbol.name,label:interval.symbol.name,value:size,region:region.name,kind:'symbol',symbolId:interval.symbol.id,address:start,endAddress:interval.end,runtimeAddress:interval.symbol.address,loadAddress:interval.loadAddress});objects.set(interval.object,names);
    }
    const limited=(children:AllocationNode[],limit:number,id:string):AllocationNode[]=>{children.sort((a,b)=>b.value-a.value);if(children.length<=limit)return children;const rest=children.slice(limit).reduce((sum,n)=>sum+n.value,0);return [...children.slice(0,limit),{id:id+':more',name:'Additional entries (use symbol search)',label:'Additional entries (use symbol search)',kind:'more',value:rest,region:region.name}];};
    const extent=(nodes:AllocationNode[])=>{const known=nodes.filter(n=>n.address!==undefined&&n.endAddress!==undefined);return known.length?{address:Math.min(...known.map(n=>n.address!)),endAddress:Math.max(...known.map(n=>n.endAddress!))}:{};};
    const libraries=new Map<string,AllocationNode[]>();
    for(const [object,names] of objects){const nodes=[...names.values()],value=nodes.reduce((a,b)=>a+b.value,0),id=JSON.stringify([rootId,object]);const library=object.match(/^(.*\.a)\(/)?.[1]??'Project objects';const group=libraries.get(library)??[];
      group.push({id,name:object,label:shortName(object),kind:'object',value,region:region.name,...extent(nodes),children:limited(nodes,100,id)});libraries.set(library,group);
    }
    const children:AllocationNode[]=[...libraries].map(([name,nodes])=>{const id=JSON.stringify([rootId,'library',name]);return {id,name,label:name==='Project objects'?name:shortName(name),kind:'library',value:nodes.reduce((sum,n)=>sum+n.value,0),region:region.name,...extent(nodes),children:limited(nodes,150,id)};});
    if(region.used>total)children.push({id:rootId+':unattributed',name:'Unattributed / padding',label:'Unattributed / padding',kind:'unattributed',value:region.used-total,region:region.name});
    return {id:rootId,name:region.name,label:region.name,kind:'region' as const,value:region.used,region:region.name,address:region.origin,endAddress:region.origin+(region.capacity??region.extent),children};
  });
}
