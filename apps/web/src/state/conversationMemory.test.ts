// @vitest-environment jsdom
import {beforeEach,expect,it,vi} from 'vitest';
import {readConversationMemory,saveConversationMemory,forgetConversationMemory,memoryContext} from './conversationMemory.js';
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
