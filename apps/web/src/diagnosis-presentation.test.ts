import {expect,it} from 'vitest';
import {assistantPreview} from './diagnosis-presentation.js';
it('shows streamed summary without process text, JSON keys or evidence identifiers',()=>{
 expect(assistantPreview('Reading logs.{"summary":"读取超时\\n请检查上游","findings":[{"evidence_ids":["private-id"]}]}')).toBe('读取超时\n请检查上游');
 expect(assistantPreview('Reading logs.{"summary":"读取超')).toBe('读取超');
 expect(assistantPreview('Reading logs.')).toBe('');
 expect(assistantPreview('{"summary":"尚未完成\\')).toBe('');
});
