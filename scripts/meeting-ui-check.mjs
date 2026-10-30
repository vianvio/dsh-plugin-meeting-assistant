/** Browser regression checks against real meeting components and simulated audio/service boundaries. */
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const fixture=fileURLToPath(new URL('../test/browser/meeting.fixture.tsx',import.meta.url));
const checks=fileURLToPath(new URL('../test/browser/meeting.checks.py',import.meta.url));
const html=readFileSync(new URL('../test/browser/meeting.fixture.html',import.meta.url));
const result=await build({entryPoints:[fixture],write:false,bundle:true,format:'esm',platform:'browser',target:'es2022',define:{__MEETING_WORKLET__:JSON.stringify('preview worklet'),'process.env.NODE_ENV':JSON.stringify('development')}});
const server=createServer((request,response)=>{
  if(request.url==='/app.js'){response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});response.end(result.outputFiles[0].contents);}
  else if(new URL(request.url??'/', 'http://localhost').pathname==='/'){response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);}
  else{response.writeHead(404);response.end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const address=server.address();
const url=`http://127.0.0.1:${address.port}`;
try{
  const code=await new Promise((resolve,reject)=>{
    const child=spawn('browser-harness',[],{cwd:root,env:{...process.env,MEETING_UI_URL:url},stdio:['pipe','inherit','inherit']});
    child.once('error',reject);child.once('close',resolve);
    child.stdin.end(`exec(open(${JSON.stringify(checks)}, encoding='utf-8').read())\n`);
  });
  if(code!==0)process.exitCode=code??1;
}catch(error){console.error('Browser UI checks require browser-harness and a connected debugging browser.',error.message);process.exitCode=1;}
finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});}
