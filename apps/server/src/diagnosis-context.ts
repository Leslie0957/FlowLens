import type {DatabaseSync} from 'node:sqlite';

// Only previously registered evidence from the bound session/run. This does
// not preload task logs or bypass the model's read-only tool calls.
export function registeredLogEvidence(db:DatabaseSync,sessionId:string,runId:string){
 const rows=db.prepare("SELECT id,source_id,source_version,locator_json,excerpt FROM evidence WHERE session_id=? AND type='LOG' ORDER BY created_at DESC,rowid DESC LIMIT 200").all(sessionId);
 const seen=new Set<string>();const refs:{id:string;source_id:string;source_version:string;excerpt:string}[]=[];
 for(const row of rows){
  const locator=JSON.parse(String(row.locator_json)) as {run_id?:string};
  if(locator.run_id!==runId||seen.has(String(row.source_id)))continue;
  seen.add(String(row.source_id));refs.push({id:String(row.id),source_id:String(row.source_id),source_version:String(row.source_version),excerpt:String(row.excerpt).slice(0,500)});
  if(refs.length===12)break;
 }
 return refs;
}

// PRD §7.5: only completed turns in the current run-bound session.
// This query never reads filesystem documents, environment variables or other sessions.
export function buildContext(db:DatabaseSync,sessionId:string,currentTurnId:string):Record<string,unknown>[] {
 const turns=db.prepare("SELECT id FROM diagnosis_turn WHERE session_id=? AND id<>? AND status='COMPLETED' ORDER BY created_at DESC,rowid DESC").all(sessionId,currentTurnId) as {id:string}[];
 const recent=turns.slice(0,6).reverse(),older=turns.slice(6,26).reverse();
 const messages:Record<string,unknown>[]=[];
 const summaries=older.map(t=>db.prepare('SELECT summary FROM diagnosis_result WHERE turn_id=?').get(t.id) as {summary:string}|undefined).filter(Boolean).map(r=>r!.summary.slice(0,400));
 if(summaries.length)messages.push({role:'user',content:JSON.stringify({older_verified_diagnoses:summaries})});
 for(const turn of recent){
  const question=db.prepare("SELECT content FROM message WHERE turn_id=? AND role='user'").get(turn.id) as {content:string}|undefined;
  const result=db.prepare('SELECT summary,findings_json,missing_information_json,next_steps_json,proposed_action_json FROM diagnosis_result WHERE turn_id=?').get(turn.id) as Record<string,string>|undefined;
  if(!question||!result)continue;
  const evidence=db.prepare('SELECT id,type,source_id,source_version,excerpt FROM evidence WHERE session_id=? AND turn_id=? LIMIT 12').all(sessionId,turn.id) as Record<string,unknown>[];
  messages.push({role:'user',content:question.content.slice(0,2000)});
  messages.push({role:'assistant',content:JSON.stringify({summary:result.summary,findings:JSON.parse(result.findings_json!),missing_information:JSON.parse(result.missing_information_json!),next_steps:JSON.parse(result.next_steps_json!),proposed_action:JSON.parse(result.proposed_action_json??'null'),evidence:evidence.map(e=>({...e,excerpt:String(e.excerpt).slice(0,500)}))})});
 }
 return messages;
}
