import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

// This process executes one deliberately tiny SQL language. The parent also
// checks the policy; keeping the guard here protects the child entry point.
const grammar=/^\s*SELECT\s+COUNT\s*\(\s*\*\s*\)\s+AS\s+order_count\s*,\s*SUM\s*\(\s*([A-Za-z_][A-Za-z_0-9]*)\s*\)\s+AS\s+total_amount\s+FROM\s+orders\s*;?\s*$/i;
const deadline=setTimeout(()=>process.exit(124),30000);
deadline.unref();
process.stdin.resume();
process.stdin.on('end',()=>process.exit(125));
const dir=process.argv[2];
try{
  if(!dir)throw new Error('RUNNER_ARGUMENT_MISSING');
  const sql=readFileSync(join(dir,'task.sql'),'utf8');
  if(!grammar.test(sql))throw new Error('SQL_POLICY_REJECTED');
  const input=JSON.parse(readFileSync(join(dir,'input.json'),'utf8'));
  if(!Array.isArray(input)||input.length!==3||input.some(x=>!Number.isInteger(x.order_id)||!Number.isInteger(x.amount)))throw new Error('INVALID_SYNTHETIC_INPUT');
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE orders(order_id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)');
    const insert=db.prepare('INSERT INTO orders(order_id,amount) VALUES (?,?)');
    for(const row of input)insert.run(row.order_id,row.amount);
    console.log('SQLite 查询开始');
    const rows=db.prepare(sql).all();
    writeFileSync(join(dir,'result.json'),JSON.stringify({rows}),'utf8');
    console.log(`SQLite 返回 ${rows.length} 行`);
  }finally{db.close();}
}catch(error){
  const message=error instanceof Error?error.message:String(error);
  console.error(message);
  process.exitCode=message==='SQL_POLICY_REJECTED'?3:message.includes('no such column')?2:4;
}
process.stdin.removeAllListeners('end');
process.stdin.destroy();
