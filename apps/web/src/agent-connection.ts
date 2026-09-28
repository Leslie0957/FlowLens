type ConnectionState='connecting'|'connected'|'reconnecting'|'synchronized';
type Options={signal:AbortSignal;cursor:()=>number;terminal:()=>boolean;connect:(after:number)=>Promise<void>;state:(value:ConnectionState)=>void;delay?:(ms:number,signal:AbortSignal)=>Promise<void>};
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>(resolve=>{if(signal.aborted)return resolve();const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,ms);signal.addEventListener('abort',finish,{once:true});});
export async function runEventConnection(options:Options){
 let failures=0;options.state('connecting');
 while(!options.signal.aborted){
  try{await options.connect(options.cursor());if(options.signal.aborted)return;if(options.terminal()){options.state('synchronized');return;}}
  catch{if(options.signal.aborted)return;}
  failures++;options.state('reconnecting');
  await (options.delay??wait)(Math.min(5000,250*2**Math.min(5,failures-1)),options.signal);
 }
}
