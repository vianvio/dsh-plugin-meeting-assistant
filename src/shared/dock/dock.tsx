/**
 * One plugin-owned column in DSH's grid, shared by every panel that needs it.
 *
 * DSH declares exactly three columns (navigation, conversation, details) and the
 * details column already has an occupant — the tool-details panel. Replacing it
 * would take tool details down with it, which is why this is a fourth track
 * injected beside the native layout instead: the native slots, stores and
 * detail renderers all stay registered and untouched.
 *
 * The column is shared rather than owned because two features now want it (the
 * meeting transcript and the node picker). Whoever asks first opens it; a second
 * requester becomes a tab rather than a second column, so the conversation never
 * loses two widths at once.
 */
import React,{useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {dockStore} from './dock-store.js';
import {sharedLog} from '../diag.js';
import {DOCK_COLORS, dockRowFor} from './dock-layout.js';

/** Width preference bounds, mirroring the native details column's range. */
const MIN_WIDTH=280,MAX_WIDTH=520,DEFAULT_WIDTH=360;
const STORAGE_KEY='mesh.dock.width';
/**
 * 这一份产物（一个 bundle 实例）的身份，以及"现在还活着的宿主"名单。
 *
 * 为什么需要：栏是**外挂在 DSH 布局里的一块 DOM**，而插件会被 HMR 换掉一整份产物。换的一瞬间
 * 有两份宿主同时存在（旧的还没卸干净、新的已经挂上），它们的 effect 谁先谁后不由我们决定：
 *
 *  * 旧的先卸 → 它把自己的栏从 DOM 里拆掉，而新的已经因为"栏已存在"直接返回了，于是**栏没了**，
 *    新宿主的 effect 依赖 `[open]`、`open` 没变过，不会再跑——面板从此打不开，只有刷新页面能救。
 *     （用户报的"你改完我现在打不开面板了"就是这个：`npm run dev` 重建触发了客户端 HMR。）
 *  * 新的先挂 → 之后旧的卸载又把**新**挂的那根当自己的拆掉，更糟。
 *
 * 所以：栏上记着挂它的那份宿主，全局记着哪些宿主还活着。判断"已有栏"时看的是**它的主人还活着吗**，
 * 而不是"DOM 里有没有这个元素"；而只要这个面板还开着，就有一个 1 秒的心跳把丢掉的栏挂回来。
 */
const OWNER=`dock-${Math.random().toString(36).slice(2,8)}`;
const liveHosts=((globalThis as unknown as {__dshMeshDockLive?:Set<string>}).__dshMeshDockLive??=new Set<string>());
/**
 * 栏的关键事件都留痕：它是外挂在 DSH 布局里的一块 DOM，"面板打不开"这类故障的现场全在这条路径上
 * （挂载、接管上一份产物留下的孤儿栏、心跳把丢掉的栏挂回来、卸载）。带 `dock` scope 进诊断报告。
 */
const diag=sharedLog('dock');
const ownedDock=():HTMLElement|null=>{
  const existing=document.querySelector('[data-mesh-dock]');
  if(!(existing instanceof HTMLElement))return null;
  return liveHosts.has(existing.dataset.meshDockOwner??'')?existing:null;
};

/**
 * Mounts the shared column. Rendered once, by the plugin's always-present
 * sidebar entry: the column must exist independently of any one panel, because a
 * panel can be opened from the composer while the other panel is already open.
 */
export function DockHost(){
  const state=useSyncExternalStore(dockStore.subscribe,dockStore.getSnapshot);
  const anchor=useRef<HTMLSpanElement>(null),[mount,setMount]=useState<HTMLElement|null>(null);
  const open=state.panels.length>0;
  useLayoutEffect(()=>{
    if(!open)return;
    /**
     * 找 DSH 的三列布局容器（栏要挂在它里面）。
     *
     * 三种找法，**找不到也不抛异常**——这是别人机器上"面板打不开"的真实成因之一：他们的 DSH 版本里
     * 布局标记与我们的开发版不同（设置页能用、输入框旁的齿轮也在，说明 slot 是有的，只有这个 DOM 查询
     * 落了空），而原来这里直接 `throw`：React 把整棵子树卸掉，界面上什么都不发生，日志里也什么都没有。
     * 现在退到**浮动面板**：宁可画得不像原生的那一列，也不能打不开。
     */
    /**
     * 一个容器像不像 DSH 的那个三列网格。
     *
     * 必须查这个，不能"找到个祖先就用"：`[data-shell-overlay]` 的父级在别人的版本里可能是 `<body>`，
     * 把栏 append 到 body 上、再往 body 写 `--mesh-dock-width`，结果是**什么都看不见**——比浮动面板
     * 糟得多，而且看起来像"面板还是打不开"。判据只看显式写过的 `grid-template-columns`（原生布局就是
     * 三列），以及我们自己打的 `data-mesh-dock-frame`。
     */
    const looksLikeFrame=(element:HTMLElement|null|undefined):element is HTMLElement=>{
      if(!(element instanceof HTMLElement))return false;
      if(element.dataset.meshDockFrame!==undefined)return true;
      return element.style.gridTemplateColumns.trim().split(/\s+/).length>=3;
    };
    const findFrame=():HTMLElement|null=>{
      const asElement=(value:Element|null|undefined):HTMLElement|null=>value instanceof HTMLElement?value:null;
      const named=[asElement(anchor.current?.closest('[data-mesh-dock-frame]')),asElement(anchor.current?.parentElement?.closest('[data-mesh-dock-frame]')),asElement(document.querySelector('[data-mesh-dock-frame]'))];
      for(const candidate of named)if(looksLikeFrame(candidate))return candidate;
      const overlay=document.querySelector('[data-shell-overlay]');
      for(const candidate of [asElement(overlay?.parentElement),asElement(overlay?.parentElement?.parentElement)])if(looksLikeFrame(candidate))return candidate;
      for(const element of Array.from(document.querySelectorAll<HTMLElement>('div')))if(looksLikeFrame(element))return element;
      return null;
    };
    const frame=findFrame();
    if(!frame)diag.error('panel','找不到 DSH 的三列布局，改用浮动面板',{tried:['[data-mesh-dock-frame]','[data-shell-overlay] 的父级','三列网格元素']});
    /** 挂一根栏。返回它的拆卸函数。 */
    const mountColumn=()=>{
    // 两个插件各有一份宿主，同一份产物里也可能挂两次（侧栏入口 + 输入框旁的回退）：**谁先谁挂**，
    // 栏只有一根。判据是"那根栏的主人还活着"——上一份产物留下的孤儿栏直接接管，否则它会变成一块
    // 永远打不开的空壳（它的 React 根随旧 bundle 一起没了）。
    const holder=document.querySelector('[data-mesh-dock]');
    if(holder instanceof HTMLElement){
      const owner=holder.dataset.meshDockOwner??'';
      if(liveHosts.has(owner)){diag.info('panel','栏已由另一份宿主占着，共用它',{owner});return ()=>{};}
      diag.warn('panel','接管上一份产物留下的孤儿栏',{orphanOwner:owner||'（没有主人标记）'});
      holder.remove();
    }
    const dock=document.createElement('aside');dock.dataset.meshDock='';dock.dataset.meshDockOwner=OWNER;dock.setAttribute('aria-label','Agent Mesh 侧栏');
    /**
     * 没有可挂的布局时：**浮动在右侧**。
     *
     * 不做布局改写（不碰 grid-template-columns），只是一个固定定位的容器——所以它不会像原生那一列
     * 那样把对话挤窄，而是盖在右边。能用、看得见、不报错，这就够了；真到了这一步，日志里已经记下
     * "布局标记和我们的开发版不一样"。
     */
    const style=document.createElement('style');style.textContent=`
      [data-mesh-dock-frame]{grid-template-columns:var(--mesh-left-width,280px) minmax(0,1fr) var(--mesh-dock-width,360px)!important}
      /* 行号走变量：DSH 0.1.2 是一行三列，0.1.5 起变成"表头 + 内容"两行；写死 grid-row:1 会把面板
         塞进 32px 的表头行（配上 height:100% 与 overflow:hidden，就是把内容全裁掉）。 */
      [data-mesh-dock]{grid-column:3;grid-row:var(--mesh-dock-row,1);min-width:0;min-height:0;height:100%;position:relative;z-index:3;background:${DOCK_COLORS.background};color:${DOCK_COLORS.color};border-left:${DOCK_COLORS.border};overflow:hidden;box-sizing:border-box}
      [data-mesh-dock] .mesh-dock-resize{position:absolute;inset:0 auto 0 0;width:6px;cursor:col-resize;touch-action:none;z-index:2}
      [data-mesh-dock] .mesh-dock-resize:hover{background:#8883}
    `;document.head.appendChild(style);
    let width=DEFAULT_WIDTH;try{width=Number(localStorage.getItem(STORAGE_KEY))||DEFAULT_WIDTH;}catch{}
    /**
     * 找不到原生布局时：**浮动在右侧**，照样能把面板画出来。
     *
     * 不做布局改写（不碰 grid-template-columns），所以它不会像原生那一列把对话挤窄，而是盖在右边。
     * 能打开、能操作、不报错就够了——真到这一步，日志里已经写明"布局标记和我们的开发版不一样"。
     */
    if(!frame){
      document.head.appendChild(style);
      dock.style.cssText=`position:fixed;top:0;right:0;bottom:0;width:360px;max-width:92vw;z-index:40;box-shadow:-8px 0 24px #0003;background:${DOCK_COLORS.background};color:${DOCK_COLORS.color}`;
      dock.dataset.meshDockFloating='';
      document.body.appendChild(dock);
      liveHosts.add(OWNER);
      diag.warn('panel','已挂载（浮动面板：找不到原生三列布局）',{owner:OWNER,panels:state.panels.map(panel=>panel.id)});
      setMount(dock);
      return ()=>{dock.remove();style.remove();setMount(null);liveHosts.delete(OWNER);diag.info('panel','浮动面板已卸载',{owner:OWNER});};
    }
    let sawNativeClosed=false;
    const update=()=>{
      // 行号：DSH 0.1.5 起壳是两行。读不到 inline 就退回计算样式（它可能由 class 定义）。
      const rows=frame.style.gridTemplateRows.trim()||getComputedStyle(frame).gridTemplateRows.trim();
      frame.style.setProperty('--mesh-dock-row',String(dockRowFor(rows)));
      // 列宽：DSH 自己写 inline 时以它为准（原生详情栏开合就是靠这个判的），否则退回计算样式。
      const tracks=frame.style.gridTemplateColumns.trim()||getComputedStyle(frame).gridTemplateColumns.trim();const left=Number(tracks.match(/^([\d.]+)px/)?.[1]??280);
      const right=Number(tracks.match(/([\d.]+)px\s*$/)?.[1]??0);
      // 注意：`right` 用的是**计算后的**轨道。原生详情栏开合时 DSH 会写 inline 样式，所以两种读法
      // 都要走一遍；否则在"网格由 class 定义"的版本上会永远认为详情栏是开着的。
      // Tool details opening means the operator asked for something else in the
      // same visual place; the native column wins and this one yields.
      if(right===0)sawNativeClosed=true;else if(sawNativeClosed){dockStore.closeAll();return;}
      const available=frame.clientWidth-left;
      frame.style.setProperty('--mesh-left-width',`${left}px`);
      frame.style.setProperty('--mesh-dock-width',`${Math.min(Math.max(MIN_WIDTH,width),MAX_WIDTH,Math.max(260,available-340))}px`);
    };
    // Only the native grid geometry is observed; our own CSS variables must not
    // recurse back through the observer.
    let previousTracks=frame.style.gridTemplateColumns;
    const observer=new MutationObserver(()=>{if(frame.style.gridTemplateColumns!==previousTracks){previousTracks=frame.style.gridTemplateColumns;update();}});
    observer.observe(frame,{attributes:true,attributeFilter:['style']});
    const resize=new ResizeObserver(update);resize.observe(frame);
    liveHosts.add(OWNER);
    diag.info('panel','栏已挂载',{owner:OWNER,panels:state.panels.map(panel=>panel.id)});
    frame.dataset.meshDockFrame='';frame.dataset.meshDockOwner=OWNER;frame.appendChild(dock);update();setMount(dock);
    const handle=document.createElement('div');handle.className='mesh-dock-resize';handle.setAttribute('role','separator');handle.setAttribute('aria-label','调整侧栏宽度');handle.setAttribute('aria-orientation','vertical');handle.tabIndex=0;
    let start=0,base=0;
    handle.onpointerdown=event=>{start=event.clientX;base=dock.getBoundingClientRect().width;handle.setPointerCapture(event.pointerId);event.preventDefault();};
    handle.onpointermove=event=>{if(!handle.hasPointerCapture(event.pointerId))return;width=Math.max(MIN_WIDTH,Math.min(MAX_WIDTH,base+start-event.clientX));update();};
    const save=()=>{try{localStorage.setItem(STORAGE_KEY,String(width));}catch{}};
    handle.onpointerup=event=>{if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);save();};
    handle.onkeydown=event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();width=Math.max(MIN_WIDTH,Math.min(MAX_WIDTH,width+(event.key==='ArrowLeft'?20:-20)));update();save();}};
    dock.appendChild(handle);
    return ()=>{observer.disconnect();resize.disconnect();dock.remove();style.remove();setMount(null);liveHosts.delete(OWNER);diag.info('panel','栏已卸载',{owner:OWNER});
      // 只在"这块布局现在归我"时才清掉属性：旧产物卸载得比新产物挂载晚的话，它不该把新挂的那根
      // 栏的布局变量一起抹掉（那会让栏当场塌成 0 宽，症状同样是"面板打不开"）。
      if(frame.dataset.meshDockOwner===OWNER){delete frame.dataset.meshDockFrame;delete frame.dataset.meshDockOwner;frame.style.removeProperty('--mesh-left-width');frame.style.removeProperty('--mesh-dock-width');}};
    };
    let dispose=mountColumn();
    /**
     * 心跳：只要还有面板开着，栏不在了就挂回来。
     *
     * 这不是"防御性编程"，是这条路径**必然会发生**：HMR 换产物时旧宿主的卸载不认识新宿主，
     * 而栏是它拆的。1 秒一次的条件判断（`querySelector`）在没有面板时根本不存在，代价可以忽略。
     */
    const watchdog=setInterval(()=>{if(!ownedDock()&&state.panels.length>0){diag.warn('panel','栏不见了，心跳把它挂回来',{owner:OWNER});dispose=mountColumn();}},1000);
    return ()=>{clearInterval(watchdog);dispose();};
  },[open]);
  const active=state.panels.find(panel=>panel.id===state.active);
  return <><span ref={anchor} style={{display:'none'}}/>{mount&&active&&createPortal(
    <div style={{height:'100%',minHeight:0,display:'flex',flexDirection:'column'}}>
      {state.panels.length>1&&<div role="tablist" aria-label="侧栏面板" style={{display:'flex',gap:2,borderBottom:'1px solid #8883',flexShrink:0}}>
        {state.panels.map(panel=><button type="button" role="tab" aria-selected={panel.id===active.id} key={panel.id} onClick={()=>dockStore.activate(panel.id)} style={{flex:1,border:0,background:'transparent',color:panel.id===active.id?'#2769e7':'inherit',borderBottom:panel.id===active.id?'2px solid #2769e7':'2px solid transparent',padding:'10px 6px',fontSize:12,cursor:'pointer'}}>{panel.title}</button>)}
      </div>}
      <div style={{flex:1,minHeight:0,display:'flex',flexDirection:'column'}}>{active.render()}</div>
    </div>,mount)}</>;
}
