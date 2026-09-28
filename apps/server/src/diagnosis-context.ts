import type {DatabaseSync} from 'node:sqlite';

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
