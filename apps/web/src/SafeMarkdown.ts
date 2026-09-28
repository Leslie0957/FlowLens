import {defineComponent,h,type VNodeChild} from 'vue';

// Small presentation-only Markdown subset. All source is text/VNodes: no raw HTML.
function inline(text:string):VNodeChild[]{
 const pattern=/\[([^\]]+)\]\(([^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;const nodes:VNodeChild[]=[];let end=0;
 for(const match of text.matchAll(pattern)){
  nodes.push(text.slice(end,match.index));
  if(match[1]){let safe=false;try{safe=['https:','http:','mailto:'].includes(new URL(match[2]!).protocol);}catch{/* relative/invalid links stay text */}
   nodes.push(safe?h('a',{href:match[2],target:'_blank',rel:'noopener noreferrer'},match[1]):match[1]);
  }else if(match[3])nodes.push(h('code',match[3]));else nodes.push(h('strong',match[4]));
  end=match.index!+match[0].length;
 }
 nodes.push(text.slice(end));return nodes;
}
function blocks(source:string):VNodeChild[]{
 const lines=source.split(/\r?\n/),nodes:VNodeChild[]=[];let i=0;
 while(i<lines.length){
  const line=lines[i]!;
  if(!line.trim()){i++;continue;}
  if(line.startsWith('```')){const code:string[]=[];i++;while(i<lines.length&&!lines[i]!.startsWith('```'))code.push(lines[i++]!);if(i<lines.length)i++;nodes.push(h('pre',[h('code',code.join('\n'))]));continue;}
  if(i+1<lines.length&&line.includes('|')&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1]!)){
   const cells=(value:string)=>value.replace(/^\s*\||\|\s*$/g,'').split('|').map(s=>s.trim());
   const head=cells(line);i+=2;const rows:string[][]=[];while(i<lines.length&&lines[i]!.includes('|'))rows.push(cells(lines[i++]!));
   nodes.push(h('div',{class:'markdown-table'},[h('table',[h('thead',[h('tr',head.map(c=>h('th',inline(c))))]),h('tbody',rows.map(row=>h('tr',row.map(c=>h('td',inline(c))))))])]));continue;
  }
  if(/^\s*(?:[-*]|\d+\.)\s+/.test(line)){const ordered=/^\s*\d+\./.test(line),items:VNodeChild[]=[];const re=ordered?/^\s*\d+\.\s+/:/^\s*[-*]\s+/;while(i<lines.length&&re.test(lines[i]!))items.push(h('li',inline(lines[i++]!.replace(re,''))));nodes.push(h(ordered?'ol':'ul',items));continue;}
  const heading=/^(#{1,6})\s+(.*)$/.exec(line);if(heading){nodes.push(h('h'+heading[1]!.length,inline(heading[2]!)));i++;continue;}
  nodes.push(h('p',inline(line)));i++;
 }
 return nodes;
}
export default defineComponent({name:'SafeMarkdown',props:{text:{type:String,required:true}},setup:props=>()=>h('div',{class:'safe-markdown'},blocks(props.text))});
