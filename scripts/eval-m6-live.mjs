import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase,migrate,seed} from '../apps/server/src/db.ts';
import {LocalExecutionService} from '../apps/server/src/local-execution.ts';
import {LocalRepairService} from '../apps/server/src/local-repair.ts';

if(!process.argv.includes('--execute-live')||!process.argv.includes('--approve-test-candidate'))throw new Error('EXPLICIT_LIVE_TEST_FLAGS_REQUIRED');
const folder=mkdtempSync(join(tmpdir(),'flowlens-m6-live-'));
const report={at:new Date().toISOString(),mode:'LIVE',isolated_synthetic_db:true,automatic_test_approval:true,checks:{}};
let db,local;
try{
  if(!process.env.MODEL_API_KEY||process.env.FLOWLENS_LIVE_APPROVED!=='1')throw new Error('LIVE_NOT_CONFIGURED');
  db=openDatabase(join(folder,'test.sqlite'));migrate(db);seed(db);
  local=new LocalExecutionService(db,join(folder,'projects'));
  const project=local.createProject('sql-column-error','live-project');
  const broken=await local.waitFor(local.startExecution(project.id,'live-broken').id);
  report.checks.initial={status:broken.status,error_code:broken.error_code,revision_hash:broken.revision_hash};
  const repair=new LocalRepairService(db,local);
  const session=repair.create(broken.id,'live-diagnose','LIVE',process.env.MODEL_NAME??'deepseek-flash');
  await repair.waitFor(session.id);
  const candidate=repair.get(session.id);
  report.checks.model={status:candidate.status,error_code:candidate.error_code,provider_mode:candidate.provider_mode,model:candidate.model,model_requests:candidate.model_requests,usage:candidate.usage,tool_names:candidate.tools.map(item=>item.name),evidence_types:candidate.evidence.map(item=>item.source_type),candidate_file:candidate.candidate?.file_path??null,candidate_hash:candidate.candidate?.sha256??null,diagnosis:candidate.diagnosis};
  if(candidate.status==='PENDING_APPROVAL'){
    const applied=repair.approve(candidate.id,'isolated-test-approval');
    report.checks.approval={status:applied.status,revision_id:applied.approved_revision_id,execution_id:applied.verification_execution_id};
    if(applied.verification_execution_id){const result=await local.waitFor(applied.verification_execution_id);report.checks.verification={status:result.status,error_code:result.error_code,exit_code:result.exit_code,validation:result.validation,revision_hash:result.revision_hash};}
  }
  report.checks.original_after=local.getExecution(broken.id).status;
}catch(error){report.error_code=error&&typeof error==='object'&&'code' in error?String(error.code):error instanceof Error?error.message:'UNKNOWN';}
finally{
  await local?.stopAll();db?.close();rmSync(folder,{recursive:true,force:true});
  const directory=resolve(fileURLToPath(new URL('../logs/m6/',import.meta.url)));mkdirSync(directory,{recursive:true});
  const path=join(directory,'live-repair-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
  writeFileSync(path,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:path,initial:report.checks.initial,model:report.checks.model,approval:report.checks.approval,verification:report.checks.verification,error_code:report.error_code}));
}
if(report.error_code||report.checks.model?.status!=='PENDING_APPROVAL'||report.checks.verification?.status!=='SUCCEEDED')process.exitCode=1;
