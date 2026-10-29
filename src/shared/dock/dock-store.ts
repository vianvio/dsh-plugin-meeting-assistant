/**
 * The shared dock's roster: who wants the column, and which of them is in front.
 *
 * Kept apart from the React host that renders it so the rules can be tested
 * directly — they are the difference between a usable panel and a flickering one,
 * and they are all about who *doesn't* get to steal the tab.
 */
import type {ReactNode} from 'react';
export interface DockPanel {
  id: string;
  /** Tab order; lower comes first. */
  order: number;
  /** Tab label. */
  title: string;
  /** Panel body. Called on every dock render, so it may read live state. */
  render: () => ReactNode;
  /**
   * Called when the dock closes this panel for a reason the panel did not ask
   * for (the operator opened tool details, which takes the same visual place).
   * The owner uses it to put its own toggle back to "closed".
   */
  onClose?: () => void;
}
interface DockSnapshot { panels: readonly DockPanel[]; active: string | null }
export class DockStore {
  private panels=new Map<string,DockPanel>();
  private activeId:string|null=null;
  private listeners=new Set<()=>void>();
  private snapshot:DockSnapshot={panels:[],active:null};
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  getSnapshot=()=>this.snapshot;
  private publish(){
    const panels=[...this.panels.values()].sort((left,right)=>left.order-right.order||left.id.localeCompare(right.id));
    const active=this.activeId&&this.panels.has(this.activeId)?this.activeId:panels[0]?.id??null;
    this.activeId=active;
    this.snapshot={panels,active};
    for(const listener of this.listeners)listener();
  }
  /**
   * Adds or updates a panel.
   *
   * Owners re-register on every render to keep their body closure fresh, which
   * must not steal the active tab from the operator — so a refresh never
   * activates. Opening a panel *is* a user action and passes `activate`, which
   * also covers the case where the other panel is currently in front.
   */
  set(panel:DockPanel,activate=false){
    const known=this.panels.has(panel.id);
    this.panels.set(panel.id,panel);
    if(activate||(!known&&!this.activeId))this.activeId=panel.id;
    this.publish();
  }
  has(id:string):boolean{return this.panels.has(id);}
  close(id:string){
    const panel=this.panels.get(id);
    if(!panel)return;
    // The owner is told before the panel disappears, so its toggle and the dock
    // never disagree about whether the panel is open.
    this.panels.delete(id);
    if(this.activeId===id)this.activeId=null;
    panel.onClose?.();
    this.publish();
  }
  activate(id:string){if(this.panels.has(id)){this.activeId=id;this.publish();}}
  closeAll(){
    if(!this.panels.size)return;
    const closing=[...this.panels.values()];
    this.panels.clear();this.activeId=null;
    for(const panel of closing)panel.onClose?.();
    this.publish();
  }
}
/**
 * 这份名单挂在 `globalThis` 上，而不是留在这个模块里。
 *
 * 插件拆开之后（`dsh-plugin-agent-mesh` 与 `dsh-plugin-meeting-assistant`），两个包各有自己的模块图
 * ——同一个文件被打了**两遍**，于是各自 `new` 一个 store 就成了两条互不可见的名单：供给面板注册进
 * A，会议面板注册进 B，同一根栏里永远只显示其中一半，而且看不出为什么。全局键只有一个，两个包拿
 * 到的是同一个实例（谁先加载谁建）。
 *
 * 栏本身仍然只有一个宿主（`DockHost` 里那道 `[data-mesh-dock]` 存在性检查），而"要不要占着栏"是从
 * **这份共享名单**推出来的，所以只要还有任何一个面板开着，先占住的那份宿主就不会拆掉——先打开的
 * 供给面板关掉、会议面板还开着时，栏不会消失，也不需要交接。
 */
const DOCK_KEY='__dshMeshDock';
const registry=globalThis as unknown as Record<string,unknown>;
export const dockStore:DockStore=(registry[DOCK_KEY] as DockStore|undefined)??((registry[DOCK_KEY]=new DockStore()) as DockStore);
