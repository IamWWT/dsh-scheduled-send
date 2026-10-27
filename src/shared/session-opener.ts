/** Navigation uses the current public UI Workspace service; Session catalog
 * ownership and conversation selection are separate upstream contracts. */
export interface SessionsOpenService {openSession?: (id:string)=>void}
export function sessionOpenerOf(svc:SessionsOpenService|undefined):((id:string)=>void)|undefined {
  if(typeof svc?.openSession!=='function')return undefined;
  return id=>svc.openSession!.call(svc,id);
}
