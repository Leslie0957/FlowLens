import {it,expect} from 'vitest';
import {toLocalInput,toUtc} from './time-range.js';
it('round trips UTC bounds through local inputs including seconds, and rejects bad values',()=>{
 const original='2026-09-25T09:00:06.000Z';expect(toUtc(toLocalInput(original))).toBe(original);
 expect(toLocalInput('bad')).toBe('');expect(toUtc('')).toBeUndefined();expect(()=>toUtc('bad')).toThrow('有效的时间');
});
