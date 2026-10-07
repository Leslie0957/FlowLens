import {DatabaseSync} from 'node:sqlite';
import {checkSql} from './pipeline-sql.mjs';
let buffer='';
const deadline=setTimeout(()=>process.exit(124),10000);deadline.unref();
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>256*1024)process.exit(125);});
process.stdin.on('end',()=>{
 const started=performance.now();let db;
 try{
  const request=JSON.parse(buffer),sql=checkSql(request.sql,request.table,request.task);
  if(request.source_path){db=new DatabaseSync(request.source_path,{readOnly:true,timeout:1000});}
  else{
   db=new DatabaseSync(':memory:');
   db.exec('CREATE TABLE mining_results(task_id TEXT NOT NULL, dat TEXT NOT NULL, st INTEGER NOT NULL, et INTEGER NOT NULL, car_series TEXT NOT NULL, execution_id TEXT NOT NULL, UNIQUE(task_id,dat,st,et))');
   const insert=db.prepare('INSERT INTO mining_results VALUES (?,?,?,?,?,?)');
   for(const r of request.rows)insert.run(r.task_id,r.dat,r.st,r.et,r.car_series,r.execution_id);
  }
  db.exec('PRAGMA query_only=ON');db.exec('BEGIN');
  const schema=db.prepare('PRAGMA table_info('+request.table+')').all().map(x=>({name:x.name,type:x.type}));
  const stmt=db.prepare('SELECT * FROM ('+sql+') LIMIT '+(request.limit+1));
  const columns=stmt.columns().map(c=>c.name),rows=stmt.all(),truncated=rows.length>request.limit;
  db.exec('COMMIT');
  console.log(JSON.stringify({columns,rows:rows.slice(0,request.limit),truncated,schema,elapsed_ms:performance.now()-started}));
 }catch(error){console.log(JSON.stringify({error_code:'SQL_QUERY_FAILED',error_message:error.message,elapsed_ms:performance.now()-started}));process.exitCode=2;}
 finally{db?.close();clearTimeout(deadline);}
});
