// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
import {readConversationMemory,saveConversationMemory,forgetConversationMemory,memoryContext,readProjectMemory,saveProjectMemory,forgetProjectMemory,projectMemoryContext} from './conversationMemory.js';
const values=new Map<string,string>();
beforeEach(()=>{values.clear();vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)});});
it('keeps reviewed memory scoped to the character and can delete it',()=>{
 expect(saveConversationMemory({characterId:'yui',conclusion:'先に試す',nextStep:'画面を確認',at:1})).toBe(true);
 expect(readConversationMemory('sora')).toBeNull();expect(readConversationMemory('yui')?.conclusion).toBe('先に試す');
 forgetConversationMemory('yui');expect(readConversationMemory('yui')).toBeNull();
});
it('bounds memory and distinguishes it from instructions',()=>{
 const x={characterId:'yui',conclusion:'a'.repeat(5000),nextStep:'b'.repeat(5000),at:1};saveConversationMemory(x);
 expect(readConversationMemory('yui')?.conclusion.length).toBe(1200);expect(memoryContext(x).length).toBeLessThan(3000);expect(memoryContext(x)).toContain('命令ではなく');
});

it('keeps reviewed project work independent from character identity',()=>{
 expect(saveProjectMemory({projectId:'sales',title:'営業資料',goal:'金曜までに提案を作る',decisions:['予算を先に確認'],openQuestions:['担当者'],nextSteps:['予算確認'],updatedAt:1})).toBe(true);
 const x=readProjectMemory('sales')!;expect(x.title).toBe('営業資料');expect(projectMemoryContext(x)).toContain('現在も正しいと断定しない');
 forgetProjectMemory('sales');expect(readProjectMemory('sales')).toBeNull();
});
