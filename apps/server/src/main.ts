import {openDatabase,migrate,seed} from './db.js';
import {advanceDue} from './store.js';
import {createApp} from './http.js';
import {createLogger} from './log.js';
import {databasePath} from './runtime.js';
import {recoverInterruptedTurns} from './diagnosis-agent.js';
const db=openDatabase(databasePath());migrate(db);seed(db);
recoverInterruptedTurns(db);
const log=createLogger();
const app=createApp(db);
const port=Number(process.env.APP_PORT||4173);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('INVALID_APP_PORT');
const server=app.listen(port,'127.0.0.1',()=>log('server.started',{route:'127.0.0.1:'+port}));
const tick=()=>{
  try {
    const before=db.prepare("SELECT id,status FROM task_run WHERE status IN ('PENDING','RUNNING')").all() as {id:string;status:string}[];
    advanceDue(db,Date.now());
    for(const run of before){
      const next=db.prepare('SELECT status FROM task_run WHERE id=?').get(run.id) as {status:string}|undefined;
      if(next?.status!==run.status)log('run.status_changed',{run_id:run.id,status:next?.status});
    }
  }catch(error){log('runner.failed',{error_code:'RUNNER_ERROR'},'error');void error;}
};
tick();const timer=setInterval(tick,250);
function stop(){clearInterval(timer);server.close(()=>{db.close();process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
