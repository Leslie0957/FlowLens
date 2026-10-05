import {writeFileSync} from 'node:fs';
writeFileSync('child.pid',String(process.pid));
console.log('TEST_CHILD_STARTED secrets_present='+Boolean(process.env.MODEL_API_KEY||process.env.NODE_OPTIONS));
process.stdin.resume();
process.stdin.on('end',()=>process.exit(125));
setInterval(()=>{},1000);
setTimeout(()=>process.exit(124),30000).unref();
