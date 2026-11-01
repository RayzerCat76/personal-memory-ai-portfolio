import sys,unittest
from types import SimpleNamespace
from unittest.mock import patch
from app.llm import MLXProvider,final_answer,IncompleteModelAnswer,MemoryExtractionError,without_internal_citations

class FinalAnswerTests(unittest.TestCase):
    def provider(self):
        p=MLXProvider('unused');p._model=object()
        p._tokenizer=SimpleNamespace(apply_chat_template=lambda *a,**kw:'assistant\n<think>\n')
        return p
    def test_explicit_and_implicit_reasoning(self):
        self.assertEqual(final_answer('<think>private</think>Final.'),'Final.')
        self.assertEqual(final_answer('private</think>Final.',reasoning_expected=True),'Final.')
        self.assertEqual(final_answer('Plain final.'),'Plain final.')
    def test_incomplete_empty_and_ambiguous_rejected(self):
        for raw in ('private unfinished','<think>unfinished','private</think>','<think>x</think>y</think>z','</think>answer<think>'):
            with self.assertRaises(IncompleteModelAnswer):final_answer(raw,reasoning_expected=True)
    def test_generation_boundary_not_prompt_setting_change(self):
        p=self.provider()
        def template(messages, **kwargs):
            self.assertIs(kwargs['tokenize'], False)
            self.assertIs(kwargs['add_generation_prompt'], True)
            self.assertIs(kwargs['return_dict'], False)
            return 'assistant\n<think>\n'
        p._tokenizer.apply_chat_template = template
        with patch.dict(sys.modules,{'mlx_lm':SimpleNamespace(generate=lambda *a,**kw:'private</think>cello')}):
            self.assertEqual(p._generate([]),'cello')
    def test_incomplete_generation_returns_safe_answer(self):
        p=self.provider();m=SimpleNamespace(id='test',content='cello',source_type='user_statement',confidence_label='confirmed')
        with patch.dict(sys.modules,{'mlx_lm':SimpleNamespace(generate=None,stream_generate=lambda *a,**kw:iter([SimpleNamespace(text='unfinished private text',finish_reason='stop')]))}):
            answer=p.answer('instrument?',[m])
            self.assertEqual(answer,"I couldn't finish a reliable answer. Please try again.")
    def test_chat_rejects_length_even_after_reasoning_closes(self):
        p=self.provider()
        memory=SimpleNamespace(id='test',content='cello',source_type='user_statement',confidence_label='confirmed')
        for ending in ('length', None):
            chunks=[SimpleNamespace(text='private</think>A partial ',finish_reason=None),
                    SimpleNamespace(text='answer.',finish_reason=ending)]
            with patch.dict(sys.modules,{'mlx_lm':SimpleNamespace(generate=None,stream_generate=lambda *a,**kw:iter(chunks))}):
                self.assertEqual(p.answer('instrument?',[memory]),"I couldn't finish a reliable answer. Please try again.")

    def test_chat_accepts_complete_segmented_answer(self):
        p=self.provider()
        memory=SimpleNamespace(id='test',content='cello',source_type='user_statement',confidence_label='confirmed')
        def stream(*args, **kwargs):
            self.assertEqual(kwargs['max_tokens'],700)
            return iter([SimpleNamespace(text='private</think>You play ',finish_reason=None),
                         SimpleNamespace(text='cello.',finish_reason='stop')])
        with patch.dict(sys.modules,{'mlx_lm':SimpleNamespace(generate=None,stream_generate=stream)}):
            self.assertEqual(p.answer('instrument?',[memory]),'You play cello.')

    def test_extraction_never_reads_reasoning_candidates(self):
        p=self.provider()
        raw='[{"type":"fact","content":"invented"}]</think>[]'
        with patch.dict(sys.modules,{'mlx_lm':SimpleNamespace(generate=lambda *a,**kw:raw)}):
            self.assertEqual(p.extract_memories('test'),[])
        with patch.dict(sys.modules,{'mlx_lm':SimpleNamespace(generate=lambda *a,**kw:'unfinished ["fake"]')}):
            with self.assertRaises(MemoryExtractionError):
                p.extract_memories('test')
    def test_internal_citations_removed_without_removing_facts(self):
        ids=['mem_abc', 'mem_def']
        self.assertEqual(without_internal_citations(
            'You prefer software (from mem_abc). You rebuilt the arena [mem_def].', ids),
            'You prefer software. You rebuilt the arena.')
        self.assertEqual(without_internal_citations('You play cello (since 2020).', ids),
                         'You play cello (since 2020).')
        self.assertEqual(without_internal_citations('See mem_abc.', ids), 'See the original evidence.')
        self.assertEqual(without_internal_citations('mem_abcdef is a quoted value.', ids),
                         'mem_abcdef is a quoted value.')

    def test_empty_evidence_avoids_generation(self):
        p=self.provider()
        with patch.object(p,'_generate',side_effect=AssertionError('No inference expected')):
            self.assertEqual(p.answer('question',[]),"I don't know that from the memories I currently have.")

if __name__=='__main__':unittest.main()
