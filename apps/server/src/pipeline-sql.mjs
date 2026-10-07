// A complete small SELECT grammar. No comments, joins, subqueries, functions
// other than COUNT, qualification, parameters or multiple statements exist.
export function checkSql(sql,table,task=false){
  if(typeof sql!=='string'||Buffer.byteLength(sql)>8192)throw new Error('SQL_POLICY_REJECTED');
  const tokens=[];const re=/\s+|(?:'(?:[^']|'')*')|(?:[A-Za-z_][A-Za-z_0-9]*)|(?:\d+(?:\.\d+)?)|(?:<=|>=|!=|<>|[<>=(),*;+\-])/gy;
  let pos=0;
  while(pos<sql.length){re.lastIndex=pos;const m=re.exec(sql);if(!m)throw new Error('SQL_POLICY_REJECTED');pos=re.lastIndex;if(!/^\s/.test(m[0]))tokens.push(m[0]);if(tokens.length>512)throw new Error('SQL_POLICY_REJECTED');}
  let i=0;const peek=()=>tokens[i]?.toUpperCase(),take=x=>{if(peek()!==x)throw new Error('SQL_POLICY_REJECTED');i++;},accept=x=>peek()===x?(i++,true):false;
  const reserved=new Set(['SELECT','FROM','WHERE','AND','OR','AS','ORDER','BY','LIMIT','ASC','DESC','COUNT','NULL']);
  const ident=()=>{const x=tokens[i];if(!x||!/^[A-Za-z_][A-Za-z_0-9]*$/.test(x)||reserved.has(x.toUpperCase()))throw new Error('SQL_POLICY_REJECTED');i++;return x;};
  const atom=()=>{const x=tokens[i];if(accept('(')){expr();take(')');}else if(x&&/^(?:\d|')/.test(x)){i++;}else if(accept('-')){if(!/^\d/.test(tokens[i]??''))throw new Error('SQL_POLICY_REJECTED');i++;}else ident();};
  const expr=()=>{atom();while(peek()==='+'||peek()==='-'){i++;atom();}};
  const compare=()=>{expr();if(!['<','>','=','<=','>=','!=','<>'].includes(peek()))throw new Error('SQL_POLICY_REJECTED');i++;expr();};
  const condition=()=>{compare();while(accept('AND')||accept('OR'))compare();};
  take('SELECT');
  if(accept('*')){if(task)throw new Error('SQL_POLICY_REJECTED');}
  else {do{if(accept('COUNT')){if(task)throw new Error('SQL_POLICY_REJECTED');take('(');if(!accept('*'))ident();take(')');}else expr();if(accept('AS'))ident();}while(accept(','));}
  take('FROM');if(ident().toLowerCase()!==table)throw new Error('SQL_TABLE_NOT_ALLOWED');
  if(accept('WHERE'))condition();
  if(accept('ORDER')){take('BY');do{ident();if(!accept('ASC'))accept('DESC');}while(accept(','));}
  if(accept('LIMIT')){const x=tokens[i++];if(!x||!/^\d+$/.test(x)||Number(x)>500)throw new Error('SQL_POLICY_REJECTED');}
  accept(';');if(i!==tokens.length)throw new Error('SQL_POLICY_REJECTED');
  return sql.trim().replace(/;$/,'');
}
