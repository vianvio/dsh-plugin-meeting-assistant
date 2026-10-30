/** Stop waiting even when the operation ignores cancellation, while observing its late result. */
export function abortable<T>(operation:PromiseLike<T>|T,signal:AbortSignal):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
    let settled=false;
    const settle=(finish:()=>void)=>{
      if(settled)return;
      settled=true;signal.removeEventListener('abort',onAbort);finish();
    };
    const onAbort=()=>settle(()=>reject(signal.reason));
    // Attach both handlers even for an already-aborted signal: the operation may
    // have started before its caller noticed cancellation and can still reject.
    void Promise.resolve(operation).then(
      value=>{if(signal.aborted)onAbort();else settle(()=>resolve(value));},
      error=>{if(signal.aborted)onAbort();else settle(()=>reject(error));},
    );
    if(signal.aborted)onAbort();
    else signal.addEventListener('abort',onAbort,{once:true});
  });
}
