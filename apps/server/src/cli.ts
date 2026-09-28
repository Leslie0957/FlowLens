import {openDatabase,migrate,seed} from './db.js';
import {databasePath} from './runtime.js';
const mode=process.argv[2];
if(mode!=='migrate'&&mode!=='seed'){process.stderr.write('Usage: migrate|seed\n');process.exitCode=2;}
else {const db=openDatabase(databasePath());try{migrate(db);if(mode==='seed')seed(db);process.stdout.write(JSON.stringify({action:mode,status:'ok'})+'\n');}finally{db.close();}}
