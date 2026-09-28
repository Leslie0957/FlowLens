// Preview only; never grants evidence/action authority. Final cards use validated results.
export function assistantPreview(content:string){
 const match=/"summary"\s*:\s*"((?:\\.|[^"\\])*)("|$)/.exec(content);
 if(!match)return '';
 try{return JSON.parse('"'+match[1]+'"') as string;}catch{return '';}
}
