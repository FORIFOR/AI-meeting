import { describe, expect, it, vi } from 'vitest';
import { GoogleCalendarAdapter } from './googleCalendar.js';
import type { CalendarAction } from '../state/calendarActions.js';
const x:CalendarAction={id:'a'.repeat(32),state:'executing',revision:3,createdAt:1,updatedAt:1,account:{subject:'a',email:'a@example.com'},payload:{title:'資料確認',start:'2026-09-21T01:00:00Z',end:'2026-09-21T01:30:00Z',timeZone:'Asia/Tokyo',projectId:'a',taskId:'task-1'}};
const credential={token:'ephemeral',expiresAt:Date.now()+3600000,account:x.account};
const remote={id:x.id,status:'confirmed',summary:x.payload.title,start:{dateTime:x.payload.start},end:{dateTime:x.payload.end},extendedProperties:{private:{rcaiAction:x.id}}};
describe('Google Calendar REST adapter (HTTP fixtures, not a live Google test)',()=>{
 it('uses a stable UUID-derived event id, no guests, and primary calendar only',async()=>{
  const request=vi.fn(async()=>new Response('{}'));
  await new GoogleCalendarAdapter(credential,()=>true,request).insert(x);
  const [url,options]=request.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  const body=JSON.parse(options.body as string);expect(body.id).toBe(x.id);expect(body.attendees).toBeUndefined();expect(body.description).toBeUndefined();expect(body.extendedProperties.private.rcaiAction).toBe(x.id);
 });
 it('treats a duplicate id response as requiring readback, not success by itself',async()=>{
  const request=vi.fn(async()=>new Response('{}',{status:409}));await expect(new GoogleCalendarAdapter(credential,()=>true,request).insert(x)).resolves.toBeUndefined();expect(request).toHaveBeenCalledOnce();
 });
 it('requires exact id, summary, times, metadata and no guests in readback',async()=>{
  const request=vi.fn(async()=>new Response(JSON.stringify(remote))),a=new GoogleCalendarAdapter(credential,()=>true,request);
  expect(await a.matches(x)).toBe('verified');
  for(const event of [{...remote,status:'cancelled'},{...remote,id:'b'.repeat(32)},{...remote,summary:'other'},{...remote,end:{dateTime:x.payload.start}},{...remote,extendedProperties:{}},{...remote,attendees:[{email:'other@example.com'}]}]){
   request.mockResolvedValueOnce(new Response(JSON.stringify(event)));expect(await a.matches(x)).toBe('mismatch');
  }
 });
 it('distinguishes missing, unauthorized and failed readbacks',async()=>{
  const request=vi.fn(async()=>new Response('{}',{status:404})),a=new GoogleCalendarAdapter(credential,()=>true,request);
  expect(await a.matches(x)).toBe('missing');request.mockResolvedValueOnce(new Response('{}',{status:401}));await expect(a.matches(x)).rejects.toThrow();
 });
 it('never contacts the network in strict local mode or with expired credentials',async()=>{
  const request=vi.fn(async()=>new Response('{}'));await expect(new GoogleCalendarAdapter(credential,()=>false,request).insert(x)).rejects.toThrow();await expect(new GoogleCalendarAdapter({...credential,expiresAt:0},()=>true,request).insert(x)).rejects.toThrow();expect(request).not.toHaveBeenCalled();
 });
});
