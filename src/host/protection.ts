/** Configuration recovery only. Official Schedule remains the task authority. */
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {TaskView} from '../shared/types.ts';
interface PresetBaseline {key: string; taskId: string; task: TaskView; pausedTask?: TaskView}
interface ProtectionData {version: 1; recurring: Record<string, TaskView>; defaults: PresetBaseline[]; moves:Record<string,string>}
export class ProtectionStore {
  readonly data: ProtectionData;
  constructor(private readonly dir: string) {
    const file=join(dir,'task-protection.json');
    this.data=existsSync(file)?JSON.parse(readFileSync(file,'utf8')) as ProtectionData:{version:1,recurring:{},defaults:[],moves:{}};
    if(this.data.version!==1 || !this.data.recurring || !Array.isArray(this.data.defaults)) throw new Error('周期任务保护配置损坏，请保留文件并从备份恢复');
    this.data.moves??={};
  }
  save(): void {
    mkdirSync(this.dir,{recursive:true});
    const file=join(this.dir,'task-protection.json'),tmp=file+'.tmp';
    writeFileSync(tmp,JSON.stringify(this.data,null,2),{mode:0o600});renameSync(tmp,file);
  }
  capture(tasks: TaskView[]): void {
    const before=JSON.stringify(this.data);
    for(const task of tasks){
      if(task.status==='active' && recurring(task))this.data.recurring[task.id]=task;
      else delete this.data.recurring[task.id];
      if(task.builtin===true && !this.data.defaults.some(x=>x.taskId===task.id))this.data.defaults.push({key:task.id,taskId:task.id,task});
    }
    if(before!==JSON.stringify(this.data))this.save();
  }
  forget(id: string): void {if(this.data.recurring[id]){delete this.data.recurring[id];this.save()}}
  rebind(oldId: string, newId: string): void {
    for(const item of this.data.defaults)if(item.taskId===oldId)item.taskId=newId;
    delete this.data.recurring[oldId];delete this.data.moves[oldId];this.save();
  }
  backup(tasks: TaskView[]): void {
    const dir=join(this.dir,'reset-backups');mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,Date.now()+'-'+Math.random().toString(36).slice(2)+'.json'),JSON.stringify({at:new Date().toISOString(),tasks,protection:this.data},null,2),{mode:0o600,flag:'wx'});
  }
}
export const recurring=(task: TaskView): boolean=>['every','daily','weekly','cron'].includes(task.frequency.kind);
